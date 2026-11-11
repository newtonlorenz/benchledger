import { expect, test as base, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/dist/app.js";
import { navigateWorkspace, openProject, openProjectSection } from "./workspace-controls";
import AxeBuilder from "@axe-core/playwright";

const originalName = "Synthetic control board";
const changedName = "Synthetic control board for front panel";
const itemName = "Synthetic bench controller";
const spareName = "Synthetic optional spare board";
const originalNote = "Verify voltage and pinout before using this board.";
const changedNote = "Front panel needs the keyed connector. Verify voltage and pinout before assembly.";
const compatibility = { compatible: "conditional", reason: "Verify voltage and pinout" };
const instructionsFile = "synthetic-control-board-notes.md";
const instructions = "# Synthetic control board notes\n\nCheck the keyed connector and voltage before assembly.\n\nA recorded count does not confirm compatibility.\n";

type BomRecord = { id: string; name: string; requiredQuantity: number; notes?: string; version: number; alternatives: Array<{ itemId: string; compatible: string; reason?: string }> };
type StockRecord = { quantity: number; version: number; evidence: { state: string } };
type GapRecord = { lineId: string; decision: string; status: string; suppliedQuantity: number; candidates: Array<{ itemId: string; compatibility: string }> };
type PartWorkspace = {
  projectName: string;
  itemId: string;
  lineId: string;
  countUrl: string;
  readStock(): Promise<StockRecord>;
  readBom(): Promise<BomRecord[]>;
  readGap(): Promise<GapRecord | undefined>;
};

// A temporary, empty workspace makes these real writes independent of the demo
// server and of any user inventory. Both widths exercise the same actual API.
const test = base.extend<{ partWorkspace: PartWorkspace }>({
  partWorkspace: async ({ page }, use) => {
    const directory = await mkdtemp(join(tmpdir(), "benchledger-part-stock-"));
    const app = await createApp({ demo: false, dataDir: directory, publicBaseUrl: "http://127.0.0.1", logger: false, auth: { sessionSecret: randomUUID().repeat(2) } });
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      await page.goto(origin);
      await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
      const post = async <T,>(path: string, data: object): Promise<T> => {
        const csrf = (await page.context().cookies()).find(cookie => cookie.name === "forge_csrf")?.value;
        expect(csrf).toBeTruthy();
        const response = await page.request.post(`${origin}/api/v1${path}`, { headers: { "x-csrf-token": csrf!, "idempotency-key": randomUUID() }, data });
        expect(response.ok(), await response.text()).toBe(true);
        return response.json();
      };
      const read = async <T,>(path: string): Promise<T> => {
        const response = await page.request.get(`${origin}/api/v1${path}`);
        expect(response.ok(), await response.text()).toBe(true);
        return response.json();
      };
      const id = `part-stock-${randomUUID()}`, revisionId = `${id}-r1`, itemId = `${id}-item`;
      const projectName = "Synthetic panel controller";
      await post("/projects/with-initial-revision", { project: { id, name: projectName, status: "building" }, revision: { id: revisionId, name: "Initial", status: "concept", fabricationRoute: "none" } });
      await post("/inventory", { id: itemId, name: itemName, kind: "electronic", quantity: 8, unit: "each", location: "Synthetic drawer A", tags: [], links: [], evidence: { state: "delivered_uncounted", source: "Synthetic test fixture" } });
      const { data: line } = await post<{ data: BomRecord }>(`/project-revisions/${revisionId}/bom`, { name: originalName, requiredQuantity: 2, unit: "each", role: "consumed", itemId, notes: originalNote, optional: false, constraints: {}, alternatives: [{ itemId, ...compatibility }] });
      // A second linked part proves Needed by opens the requested requirement,
      // rather than whichever line happens to be first in the project.
      await post(`/project-revisions/${revisionId}/bom`, { name: spareName, requiredQuantity: 1, unit: "each", role: "consumed", itemId, optional: true, constraints: {}, alternatives: [{ itemId, ...compatibility }] });
      const bytes = Buffer.from(instructions);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const { data: upload } = await post<{ data: { id: string } }>("/artifacts/uploads", { projectId: id, projectRevisionId: revisionId, filename: instructionsFile, role: "text", mediaType: "text/markdown", byteSize: bytes.length, sha256 });
      const csrf = (await page.context().cookies()).find(cookie => cookie.name === "forge_csrf")!.value;
      const uploaded = await page.request.put(`${origin}/api/v1/artifacts/uploads/${upload.id}`, { headers: { "x-csrf-token": csrf, "content-type": "application/octet-stream" }, data: bytes });
      expect(uploaded.ok(), await uploaded.text()).toBe(true);
      const { data: artifact } = await post<{ data: { sha256: string } }>(`/artifacts/uploads/${upload.id}/finalize`, {});
      expect(artifact.sha256).toBe(sha256);
      await page.reload();
      await use({
        projectName, itemId, lineId: line.id, countUrl: `${origin}/api/v1/inventory/${itemId}/count`,
        readStock: () => read(`/inventory/${itemId}`),
        readBom: () => read(`/project-revisions/${revisionId}/bom`),
        readGap: async () => (await read<{ lines: GapRecord[] }>(`/project-revisions/${revisionId}/gaps`)).lines.find(gap => gap.lineId === line.id),
      });
    } finally {
      const closed = app.close();
      app.server.closeAllConnections();
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function editFromOverview(page: Page, workspace: PartWorkspace, changeDraft = true) {
  await openProject(page, workspace.projectName);
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  const next = page.getByRole("region", { name: "Next project action", exact: true });
  await expect(next.getByRole("heading", { name: `Check ${originalName}`, exact: true })).toBeVisible();
  await next.getByRole("button", { name: "Review this part", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Part details", exact: true });
  await expect(editor.getByLabel("Requirement name", { exact: true })).toHaveValue(originalName);
  await expect(editor.getByRole("textbox", { name: "Specification and notes", exact: true })).toHaveValue(originalNote);
  if (!changeDraft) return editor;
  await editor.getByLabel("Requirement name", { exact: true }).fill(changedName);
  await editor.getByLabel("Required quantity", { exact: true }).fill("3");
  await editor.getByRole("textbox", { name: "Specification and notes", exact: true }).fill(changedNote);
  return editor;
}

async function expectPartDraft(editor: Locator) {
  await expect(editor.getByLabel("Requirement name", { exact: true })).toHaveValue(changedName);
  await expect(editor.getByLabel("Required quantity", { exact: true })).toHaveValue("3");
  await expect(editor.getByRole("textbox", { name: "Specification and notes", exact: true })).toHaveValue(changedNote);
}

async function expectConditionalGap(workspace: PartWorkspace) {
  const gap = await workspace.readGap();
  expect(gap).toMatchObject({ decision: "check", status: "inspect_first", suppliedQuantity: 0 });
  expect(gap?.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: workspace.itemId, compatibility: "conditional" })]));
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const viewport = page.viewportSize()!;
  for (const modal of await page.locator('[role="dialog"][aria-modal="true"]:visible, [role="alertdialog"]:visible').all()) {
    const bounds = (await modal.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  }
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false, animations: "disabled" });
}

test("resizing during a stock detour keeps the active task reachable and retains the part draft", async ({ page, partWorkspace: workspace }, info) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  const beforeStock = await workspace.readStock();
  const beforeBom = await workspace.readBom();
  const editor = await editFromOverview(page, workspace);
  await editor.getByRole("button", { name: "Check this stock", exact: true }).click();
  const stock = page.getByRole("dialog", { name: itemName, exact: true });
  const quantity = stock.getByLabel("Counted quantity", { exact: true });
  await quantity.fill("7");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(stock).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(quantity).toBeFocused();
  await expect(quantity).toHaveValue("7");
  // A real pointer action catches a suspended parent becoming the top modal.
  await stock.getByRole("button", { name: "Review physical count", exact: true }).click();
  const review = page.getByRole("alertdialog", { name: "Review physical count", exact: true });
  await expect(review).toContainText("7 pieces");
  await review.getByRole("button", { name: "Confirm physical count", exact: true }).focus();
  await page.setViewportSize({ width: 1536, height: 1024 });
  await expect(review.getByRole("button", { name: "Confirm physical count", exact: true })).toBeFocused();
  await review.getByRole("button", { name: "Confirm physical count", exact: true }).click();
  await expect(stock.getByRole("status", { name: "Physical count saved", exact: true })).toContainText("7 pieces");
  await page.setViewportSize({ width: 390, height: 844 });
  await stock.getByRole("button", { name: `Return to ${originalName}`, exact: true }).click();
  await expectPartDraft(editor);
  await expect(editor).toHaveAttribute("aria-modal", "true");
  expect(await workspace.readStock()).toMatchObject({ quantity: 7, version: beforeStock.version + 1 });
  expect(await workspace.readBom()).toEqual(beforeBom);
  await expectConditionalGap(workspace);
  await capture(page, info, "part-draft-after-breakpoint-stock-detour");
});

for (const width of [1536, 390]) {
  test.describe(`approved part stock flow at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 1024 } });

    test("count review returns to the exact edited part without confirming compatibility", async ({ page, partWorkspace: workspace }, info) => {
      test.setTimeout(60_000);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const beforeStock = await workspace.readStock();
      const beforeBom = await workspace.readBom();
      await expectConditionalGap(workspace);
      const editor = await editFromOverview(page, workspace);
      if (width === 1536) {
        await page.locator(".bom-row").getByRole("button", { name: spareName, exact: true }).click();
        const leave = page.getByRole("alertdialog", { name: "Leave without saving?", exact: true });
        await expect(leave).toBeVisible();
        await leave.getByRole("button", { name: "Keep editing", exact: true }).click();
        await expectPartDraft(editor);
      }
      const countWrites: string[] = [];
      page.on("request", request => { if (request.url() === workspace.countUrl && request.method() === "POST") countWrites.push(request.postData() ?? ""); });

      await editor.getByRole("button", { name: "Check this stock", exact: true }).click();
      const stock = page.getByRole("dialog", { name: itemName, exact: true });
      await expect(stock.getByLabel("Counted quantity", { exact: true })).toHaveValue("");
      await stock.getByLabel("Counted quantity", { exact: true }).fill("7");
      await stock.getByRole("button", { name: "Review physical count", exact: true }).click();
      const review = page.getByRole("alertdialog", { name: "Review physical count", exact: true });
      await expect(review).toContainText("This count does not confirm that the item fits a project.");
      await expect(review).toContainText(itemName);
      expect(countWrites).toHaveLength(0);
      expect(await workspace.readStock()).toEqual(beforeStock);
      await capture(page, info, "count-review");
      await review.getByRole("button", { name: "Back to item", exact: true }).click();
      await expect(stock.getByLabel("Counted quantity", { exact: true })).toHaveValue("7");
      expect(countWrites).toHaveLength(0);
      await stock.getByRole("button", { name: "Review physical count", exact: true }).click();
      await review.getByRole("button", { name: "Confirm physical count", exact: true }).click();
      await expect(review).toHaveCount(0);
      await expect(stock.getByText("Physical count saved", { exact: true })).toBeVisible();
      await expect(stock).toContainText("Compatibility with a project is checked separately.");
      expect(countWrites).toHaveLength(1);
      expect(JSON.parse(countWrites[0]!)).toEqual({ quantity: 7 });
      expect(await workspace.readStock()).toMatchObject({ quantity: 7, evidence: { state: "physically_counted" }, version: beforeStock.version + 1 });
      expect(await workspace.readBom()).toEqual(beforeBom);
      await expectConditionalGap(workspace);

      const returnToPart = stock.getByRole("button", { name: `Return to ${originalName}`, exact: true });
      await expect(returnToPart).toBeVisible();
      await returnToPart.scrollIntoViewIfNeeded();
      await capture(page, info, "count-receipt-return-to-exact-part");
      await returnToPart.click();
      await expectPartDraft(editor);
      await expect(editor.getByRole("button", { name: "Check this stock", exact: true })).toBeEnabled();
      await editor.getByRole("button", { name: "Save requirement", exact: true }).click();
      await expect(editor).toHaveCount(0);
      const saved = (await workspace.readBom()).find(line => line.id === workspace.lineId);
      expect(saved).toMatchObject({ name: changedName, requiredQuantity: 3, notes: changedNote, alternatives: [{ itemId: workspace.itemId, ...compatibility }] });
      await expectConditionalGap(workspace);
      await openProjectSection(page, "Parts");
      const row = page.locator(".bom-row").filter({ has: page.getByRole("button", { name: changedName, exact: true }) });
      await expect(row.locator(".status-pill")).toHaveText(/Check/u);
      await row.getByRole("button", { name: changedName, exact: true }).click();
      await expectPartDraft(editor);
      await expect(editor.getByRole("button", { name: "Check this stock", exact: true })).toBeVisible();
      await expect(editor).toContainText(itemName);
      await expect(editor.getByText("Searching all inventory…", { exact: true })).toHaveCount(0);
      const savedNotice = page.getByRole("button", { name: "Dismiss notification", exact: true });
      if (await savedNotice.isVisible()) await savedNotice.click();
      if (width === 1536) {
        await page.locator(".content").evaluate(element => element.scrollTo(0, 0));
        await expect(editor).toHaveAttribute("aria-modal", "false");
        await expect(page.locator('[data-slot="dialog-overlay"]:visible')).toHaveCount(0);
        const bounds = (await editor.boundingBox())!;
        const list = (await page.locator(".project-parts-register").boundingBox())!;
        expect(list.x + list.width).toBeLessThanOrEqual(bounds.x);
        for (const cell of [".bom-quantity", ".bom-available", ".bom-status"]) await expect(row.locator(cell)).toBeInViewport({ ratio: 1 });
        await expect(editor.getByLabel("Required quantity", { exact: true })).toBeInViewport({ ratio: 1 });
        await expect(editor.getByRole("region", { name: "Selected stock candidate", exact: true })).toBeInViewport({ ratio: 1 });
        await expect(editor.getByRole("button", { name: "Check this stock", exact: true })).toBeInViewport({ ratio: 1 });
        await expect(editor.getByText("You’ll return to this part with your edits kept. A count alone does not confirm fit.", { exact: true })).toBeInViewport({ ratio: 1 });
        const check = editor.getByRole("button", { name: "Check this stock", exact: true });
        expect(await check.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
        const a11y = await new AxeBuilder({ page }).include(".project-parts-workspace").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
        expect(a11y.violations).toEqual([]);
      }
      await capture(page, info, "parts-selected-detail");
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(editor).toHaveCount(0);

      await navigateWorkspace(page, "Inventory");
      await page.getByRole("textbox", { name: "Search inventory", exact: true }).fill(itemName);
      await page.locator(".inventory-table tbody tr").filter({ hasText: itemName }).locator(".row-open").click();
      const needs = stock.getByRole("region", { name: "Needed by projects", exact: true });
      await expect(needs.getByRole("button", { name: /^Open .* in /u })).toHaveCount(2);
      await needs.getByRole("button", { name: `Open ${spareName} in ${workspace.projectName}`, exact: true }).click();
      await expect(stock).toHaveCount(0);
      await expect(editor.getByLabel("Requirement name", { exact: true })).toHaveValue(spareName);
      await expect(editor.getByLabel("Required quantity", { exact: true })).toHaveValue("1");
      await expect(editor.getByRole("textbox", { name: "Specification and notes", exact: true })).toHaveValue("");
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(editor).toHaveCount(0);

      await openProjectSection(page, "Files");
      for (const name of ["3D print", "Electronics", "CAD & firmware", "Instructions"]) await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
      await page.locator(".content").evaluate(element => element.scrollTo(0, 0));
      await expect(page.getByRole("button", { name: `Details for ${instructionsFile}`, exact: true })).toBeInViewport();
      await page.getByRole("button", { name: `Details for ${instructionsFile}`, exact: true }).click();
      const details = page.getByRole("complementary", { name: `File details: ${instructionsFile}`, exact: true });
      await expect(details).toContainText("Candidate file");
      if (width === 1536) {
        await page.locator(".content").evaluate(element => element.scrollTo(0, 0));
        await expect.poll(() => page.locator(".content").evaluate(element => element.scrollTop)).toBe(0);
        for (const name of ["3D print", "Electronics", "CAD & firmware", "Instructions"]) await expect(page.getByRole("heading", { name, exact: true })).toBeInViewport();
        await expect(details.getByRole("button", { name: "Preview file", exact: true })).toBeInViewport();
        await expect(details.getByRole("button", { name: "Download file", exact: true })).toBeInViewport();
      } else {
        await details.scrollIntoViewIfNeeded();
      }
      await capture(page, info, "files-current-selected-detail");
      await details.getByRole("button", { name: "Preview file", exact: true }).click();
      const preview = page.getByRole("dialog", { name: instructionsFile, exact: true });
      await expect(preview.getByRole("heading", { name: "Synthetic control board notes", exact: true })).toBeVisible();
      await expect(preview).toContainText("A recorded count does not confirm compatibility.");
      await capture(page, info, "files-current-loaded-preview");
      await preview.getByRole("button", { name: "Close preview", exact: true }).click();

      await openProjectSection(page, "Parts");
      await page.getByRole("button", { name: "Add part", exact: true }).click();
      const add = page.getByRole("dialog", { name: "Add a part", exact: true });
      const draftName = "Synthetic panel mounting clips";
      const draftNote = "Check clip width against the panel before sourcing.";
      await add.getByLabel("Part name", { exact: true }).fill(draftName);
      await add.getByLabel("Amount needed", { exact: true }).fill("4");
      await add.getByRole("textbox", { name: "Specification (optional)", exact: true }).fill(draftNote);
      const rejectedCreate = "**/project-revisions/*/bom";
      await page.route(rejectedCreate, route => route.request().method() === "POST"
        ? route.fulfill({ status: 409, contentType: "application/json", json: { error: { code: "version_conflict", message: "The project changed. Your part has not been saved." } } })
        : route.continue());
      await add.getByRole("button", { name: "Add part", exact: true }).click();
      await expect(add.getByRole("alert")).toContainText("Your entries are kept.");
      await expect(add.getByLabel("Part name", { exact: true })).toHaveValue(draftName);
      await expect(add.getByLabel("Amount needed", { exact: true })).toHaveValue("4");
      await expect(add.getByRole("textbox", { name: "Specification (optional)", exact: true })).toHaveValue(draftNote);
      await expect(add.getByRole("button", { name: "Try saving again", exact: true })).toBeInViewport();
      await capture(page, info, "add-part-error-draft-preserved");
      await page.unroute(rejectedCreate);
      await add.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("alertdialog", { name: "Leave without saving?", exact: true }).getByRole("button", { name: "Discard changes and leave", exact: true }).click();
      await expect(add).toHaveCount(0);
    });

    test("discarding a nested stock draft preserves the unsaved part draft", async ({ page, partWorkspace: workspace }) => {
      const beforeStock = await workspace.readStock();
      const beforeBom = await workspace.readBom();
      const editor = await editFromOverview(page, workspace);
      let countWrites = 0;
      page.on("request", request => { if (request.url() === workspace.countUrl && request.method() === "POST") countWrites++; });
      await editor.getByRole("button", { name: "Check this stock", exact: true }).click();
      const stock = page.getByRole("dialog", { name: itemName, exact: true });
      await stock.getByLabel("Counted quantity", { exact: true }).fill("6");
      await stock.getByRole("button", { name: `Return to ${originalName}`, exact: true }).click();
      const discard = page.getByRole("alertdialog", { name: "Discard this item draft?", exact: true });
      await expect(discard).toContainText("Discard only the unsaved item changes to return to your requirement.");
      await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
      await expect(stock.getByLabel("Counted quantity", { exact: true })).toHaveValue("6");
      await stock.getByRole("button", { name: `Return to ${originalName}`, exact: true }).click();
      await discard.getByRole("button", { name: "Discard item changes", exact: true }).click();
      await expect(stock).toHaveCount(0);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expectPartDraft(editor);
      expect(countWrites).toBe(0);
      expect(await workspace.readStock()).toEqual(beforeStock);
      expect(await workspace.readBom()).toEqual(beforeBom);

      await editor.getByRole("button", { name: "Check this stock", exact: true }).click();
      await expect(stock.getByLabel("Counted quantity", { exact: true })).toHaveValue("");
      await stock.getByRole("button", { name: `Return to ${originalName}`, exact: true }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expectPartDraft(editor);
    });

    test("browser Back retains a nested count and cannot leave an unconfirmed save", async ({ page, partWorkspace: workspace }) => {
      const beforeStock = await workspace.readStock();
      const beforeBom = await workspace.readBom();
      // Keep the requirement unchanged: only the supporting stock task is dirty.
      const editor = await editFromOverview(page, workspace, false);
      const originalUrl = page.url();
      await editor.getByRole("button", { name: "Check this stock", exact: true }).click();
      const stock = page.getByRole("dialog", { name: itemName, exact: true });
      await stock.getByLabel("Counted quantity", { exact: true }).fill("7");
      await page.goBack();
      const leave = page.getByRole("alertdialog", { name: "Leave without saving?", exact: true });
      await expect(leave).toContainText("unsaved changes in stock observation.");
      await expect(page).toHaveURL(originalUrl);
      await leave.getByRole("button", { name: "Keep editing", exact: true }).click();
      await expect(stock.getByLabel("Counted quantity", { exact: true })).toHaveValue("7");
      await expect(page).toHaveURL(originalUrl);
      expect(await workspace.readStock()).toEqual(beforeStock);
      expect(await workspace.readBom()).toEqual(beforeBom);

      const countRequests: Array<{ key: string | undefined; body: string | null }> = [];
      await page.route(workspace.countUrl, async route => {
        countRequests.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
        if (countRequests.length === 1) {
          // The service records the observation, but its acknowledgement is lost.
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          await route.abort("failed");
        } else await route.continue();
      });
      await stock.getByRole("button", { name: "Review physical count", exact: true }).click();
      const review = page.getByRole("alertdialog", { name: "Review physical count", exact: true });
      await review.getByRole("button", { name: "Confirm physical count", exact: true }).click();
      await expect(review.getByRole("button", { name: "Retry unchanged observation", exact: true })).toBeVisible();
      await page.goBack();
      const pending = page.getByRole("alertdialog", { name: "Finish the pending save", exact: true });
      await expect(pending).toContainText("has not been confirmed");
      await expect(pending.getByRole("button", { name: /Discard/u })).toHaveCount(0);
      await expect(page).toHaveURL(originalUrl);
      await pending.getByRole("button", { name: "Keep editing", exact: true }).click();
      await expect(review).toContainText("7 pieces");
      await expect(review.getByRole("button", { name: "Back to item", exact: true })).toBeDisabled();
      await review.getByRole("button", { name: "Retry unchanged observation", exact: true }).click();
      await expect(stock.getByText("Physical count saved", { exact: true })).toBeVisible();
      expect(countRequests).toHaveLength(2);
      expect(countRequests[0]!.key).toBeTruthy();
      expect(countRequests[1]).toEqual(countRequests[0]);
      expect(await workspace.readStock()).toMatchObject({ quantity: 7, version: beforeStock.version + 1 });
      expect(await workspace.readBom()).toEqual(beforeBom);
      await expectConditionalGap(workspace);
      await stock.getByRole("button", { name: `Return to ${originalName}`, exact: true }).click();
      await expect(editor.getByLabel("Requirement name", { exact: true })).toHaveValue(originalName);
      await expect(editor.getByLabel("Required quantity", { exact: true })).toHaveValue("2");
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      // The resolved child entry must not leave a stale navigation blocker.
      await page.goBack();
      await expect(page).not.toHaveURL(originalUrl);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
    });
  });
}
