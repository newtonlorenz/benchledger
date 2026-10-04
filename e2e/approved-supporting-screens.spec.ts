import { expect, test as base, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/dist/app.js";
import { clickProjectAction, navigateWorkspace, openBuildTool, openProject, openProjectDetails, openProjectSection } from "./workspace-controls";

const projectName = "Synthetic enclosure workshop";
const assemblyFile = "synthetic-assembly.step";
const boardFile = "synthetic-board.kicad_pcb";

// Follow the isolated durable fixture used by the part-stock journeys. These
// records and artifact bytes never touch the shared demo or a user workspace.
const test = base.extend<{ supportingWorkspace: string }>({
  supportingWorkspace: async ({ page }, use) => {
    const directory = await mkdtemp(join(tmpdir(), "benchledger-supporting-screens-"));
    const app = await createApp({ demo: false, dataDir: directory, publicBaseUrl: "http://127.0.0.1", logger: false, auth: { sessionSecret: randomUUID().repeat(2) } });
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      await page.goto(origin);
      await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
      const headers = async () => ({ "x-csrf-token": (await page.context().cookies()).find(cookie => cookie.name === "forge_csrf")!.value, "idempotency-key": randomUUID() });
      const write = async (path: string, data: object, method: "POST" | "PUT" = "POST") => {
        const response = await page.request.fetch(`${origin}/api/v1${path}`, { method, headers: await headers(), data });
        expect(response.ok(), await response.text()).toBe(true);
        return response.json();
      };
      const id = `supporting-${randomUUID()}`, revision = `${id}-r1`, itemId = `${id}-fasteners`;
      await write("/projects/with-initial-revision", { project: { id, name: projectName, status: "building", description: "Synthetic visual evidence fixture." }, revision: { id: revision, name: "Initial enclosure", status: "concept", fabricationRoute: "printed" } });
      await write("/inventory", { id: itemId, name: "Synthetic M3 mounting fasteners", kind: "fastener", quantity: 10, unit: "each", location: "Synthetic drawer A", tags: [], links: [], evidence: { state: "physically_counted", source: "Synthetic fixture only" } });
      const { data: line } = await write(`/project-revisions/${revision}/bom`, { name: "Enclosure mounting fasteners", itemId, requiredQuantity: 4, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [] });
      await write(`/project-revisions/${revision}/reservations`, { lineId: line.id, itemId, quantity: 4 });
      const { data: work } = await write(`/projects/${id}/workstreams`, { name: "Enclosure fit and wiring", kind: "assembly" });
      await write(`/projects/${id}/workstreams/${work.item.id}/assignment`, { expectedVersion: 0, status: "in_progress", notes: "Review connector clearance and fastening order before physical assembly." }, "PUT");

      const upload = async (filename: string, role: string, mediaType: string) => {
        const bytes = await readFile(`packages/artifacts/testfiles/${filename}`);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const { data: session } = await write("/artifacts/uploads", { projectId: id, projectRevisionId: revision, filename, role, mediaType, byteSize: bytes.length, sha256 });
        const response = await page.request.put(`${origin}/api/v1/artifacts/uploads/${session.id}`, { headers: { ...await headers(), "content-type": "application/octet-stream" }, data: bytes });
        expect(response.ok(), await response.text()).toBe(true);
        return (await write(`/artifacts/uploads/${session.id}/finalize`, {})).data;
      };
      const cad = await upload(assemblyFile, "step", "model/step");
      await upload(boardFile, "cad_source", "application/x-kicad-pcb");
      await write(`/projects/${id}/revisions/${revision}/build-plan`, {
        expectedVersion: 0, name: "Enclosure plate plan", parts: [{ id: "enclosure-base", name: "Enclosure base", quantity: 2, artifactId: cad.id }],
        plates: [{ id: "enclosure-plate", name: "Base plate", copies: 1, parts: [{ partId: "enclosure-base", quantity: 2 }], materials: [], minutes: 80 }],
        notes: "Check printer, material and supports in the slicer before printing.",
      }, "PUT");
      await page.reload();
      await use(id);
    } finally {
      const closing = app.close();
      app.server.closeAllConnections();
      await closing;
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test.describe.configure({ timeout: 120_000 });

async function capture(page: Page, info: TestInfo, name: string, focus?: Locator) {
  if (focus) { await expect(focus).toBeVisible(); await focus.scrollIntoViewIfNeeded(); }
  await expect(page.getByText("Searching owned inventory…", { exact: true })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const viewport = page.viewportSize()!;
  for (const modal of await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').all()) {
    const bounds = (await modal.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false, animations: "disabled" });
}

for (const width of [1536, 390]) {
  test(`approved supporting screens load and fit at ${width}px`, async ({ page, supportingWorkspace }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openProject(page, projectName);
    expect(page.url()).toContain(supportingWorkspace);

    await clickProjectAction(page, "Edit project");
    const edit = page.getByRole("dialog", { name: "Edit project", exact: true });
    await expect(edit.getByLabel("Project name", { exact: true })).toHaveValue(projectName);
    await capture(page, info, "edit-project");
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    await clickProjectAction(page, "New revision");
    const revision = page.getByRole("dialog", { name: `New revision for ${projectName}`, exact: true });
    await expect(revision.getByLabel("Revision name", { exact: true })).toBeEditable();
    await capture(page, info, "new-revision");
    await revision.getByRole("button", { name: "Cancel", exact: true }).click();
    await clickProjectAction(page, "Revision history");
    const history = page.getByRole("dialog", { name: "Revision history", exact: true });
    await history.getByRole("button", { name: "Read revision 1: Initial enclosure", exact: true }).click();
    await expect(history.getByRole("region", { name: "Read-only revision snapshot" })).toContainText("Enclosure mounting fasteners");
    await capture(page, info, "revision-history");
    await history.getByRole("button", { name: "Close dialog", exact: true }).click();

    await openProjectDetails(page);
    await page.locator(".build-approach-card").getByRole("button", { name: "Change build approach", exact: true }).click();
    const approach = page.getByRole("dialog", { name: "Edit build approach", exact: true });
    await expect(approach.getByRole("radio", { name: /^3D-print parts/u })).toBeChecked();
    await capture(page, info, "edit-build-approach");
    await approach.getByRole("button", { name: "Cancel", exact: true }).click();
    await openBuildTool(page, "print");
    await expect(page.locator(".build-planning")).toContainText("80 recorded minutes");
    await capture(page, info, "build-plate-plan", page.getByRole("heading", { name: "Enclosure plate plan", exact: true }));
    await openBuildTool(page, "tasks");
    await page.getByRole("button", { name: "Enclosure fit and wiring · In progress", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Task group notes", exact: true })).toHaveValue("Review connector clearance and fastening order before physical assembly.");
    await capture(page, info, "build-task-group", page.getByRole("heading", { name: "Task groups", exact: true }));

    await openProjectSection(page, "Record used stock");
    await expect(page.locator(".reconciliation-shell")).toContainText("Enclosure mounting fasteners");
    await page.locator(".content").evaluate(element => element.scrollTo(0, 0));
    await expect.poll(() => page.locator(".content").evaluate(element => element.scrollTop)).toBe(0);
    await expect(page.getByRole("list", { name: "Build sequence" }).getByRole("heading", { name: "Record actual use", exact: true })).toBeInViewport();
    await capture(page, info, "build-review-journey");
    await page.getByRole("button", { name: "Add result", exact: true }).click();
    await page.getByLabel("What happened", { exact: true }).selectOption("consumed");
    await page.getByLabel("Quantity for result 1", { exact: true }).fill("4");
    await page.getByLabel("How did you check for result 1", { exact: true }).selectOption("physically_counted");
    await capture(page, info, "record-used-stock", page.getByLabel("What happened", { exact: true }));
    await page.getByRole("button", { name: "Review changes", exact: true }).click();
    await expect(page.locator(".reconciliation-preview-details")).toContainText("stock record");
    await capture(page, info, "stock-change-review", page.getByRole("heading", { name: "Review stock changes", exact: true }));
    if (width === 1536) {
      await page.locator(".content").evaluate(element => element.scrollTo(0, 0));
      await expect.poll(() => page.locator(".content").evaluate(element => element.scrollTop)).toBe(0);
      const journey = page.getByRole("list", { name: "Build sequence" });
      const names = ["Check parts", "Prepare files", "Assemble", "Verify the build", "Record actual use"];
      for (const name of names) {
        const heading = journey.getByRole("heading", { name, exact: true });
        await expect(heading).toBeInViewport();
      }
      await expect(journey.locator('[aria-current="step"]')).toContainText("Review stock changes");
      await expect(journey.getByText("Review stock changes", { exact: true })).toBeInViewport({ ratio: 1 });
      const journeyBox = (await journey.boundingBox())!;
      const reviewBox = (await page.locator(".reconciliation-shell").boundingBox())!;
      expect(journeyBox.x + journeyBox.width).toBeLessThan(reviewBox.x);
      await capture(page, info, "stock-change-review-document-top");
    }
    await page.getByRole("button", { name: "Apply stock changes", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Apply these changes?", exact: true });
    await expect(confirmation.getByRole("button", { name: "Apply stock changes", exact: true })).toBeEnabled();
    const finalEffect = confirmation.getByRole("region", { name: "Final stock effect" });
    await expect(finalEffect).toContainText("Used 4 each");
    await expect(finalEffect).toContainText("On hand6 eachAvailable6 each");
    await expect(confirmation.getByRole("button", { name: "Review 2 separate stock entries" })).toHaveAttribute("aria-expanded", "false");
    for (const fact of [finalEffect.getByText("Used 4 each", { exact: true }), ...await finalEffect.getByText("6 each", { exact: true }).all(), confirmation.getByRole("button", { name: "Apply stock changes", exact: true })]) {
      await expect(fact).toBeInViewport({ ratio: 1 });
    }
    await capture(page, info, "stock-change-confirmation");
    // Capture the final review without consuming the fixture stock.
    await confirmation.getByRole("button", { name: "Go back", exact: true }).click();

    await openProjectSection(page, "PCB");
    await page.getByRole("combobox", { name: "Board source", exact: true }).selectOption({ label: `${boardFile} · r01` });
    await page.getByRole("button", { name: "Open PCB", exact: true }).click();
    await expect(page.locator(".pcb-workspace canvas")).toBeVisible();
    await expect(page.locator(".assembly-dimensions")).toContainText("36.0 × 24.0");
    await capture(page, info, "pcb-top", page.locator(".pcb-workspace canvas"));
    await page.getByRole("button", { name: "3D", exact: true }).click();
    await page.getByLabel("Find a component or part").fill("R1");
    await page.getByRole("button", { name: "R1 · footprint outline", exact: true }).click();
    await expect(page.getByRole("heading", { name: "R1", exact: true })).toBeVisible();
    await capture(page, info, "pcb-component", page.getByRole("heading", { name: "R1", exact: true }));

    await openProjectSection(page, "Assembly");
    await page.getByLabel(assemblyFile, { exact: true }).check();
    await page.getByRole("button", { name: "Open assembly", exact: true }).click();
    await expect(page.locator(".assembly-canvas canvas")).toBeVisible();
    await expect(page.locator(".assembly-dimensions")).toContainText("40.0 × 30.0 × 17.0 mm");
    await page.getByRole("button", { name: "Exploded", exact: true }).click();
    await capture(page, info, "assembly-exploded", page.locator(".assembly-canvas canvas"));
    await page.getByRole("button", { name: "Lid", exact: true }).click();
    await page.getByRole("button", { name: "Edit assembly", exact: true }).click();
    await expect(page.getByLabel("Fixing notes")).toBeEditable();
    await capture(page, info, "assembly-part-details", page.getByLabel("Material", { exact: true }));
    await navigateWorkspace(page, "Settings");
    await page.getByRole("alertdialog", { name: "Leave without saving?", exact: true }).getByRole("button", { name: "Discard changes and leave", exact: true }).click();

    await page.getByRole("button", { name: /^Categories · /u }).click();
    await expect(page.locator(".category-tree-group").first()).toBeVisible();
    await capture(page, info, "settings-categories", page.getByRole("heading", { name: "Manage inventory categories", exact: true }));
    await page.getByRole("button", { name: /^Categories · /u }).click();
    await expect(page.getByRole("form", { name: "Enable workspace password", exact: true })).toBeVisible();
    await capture(page, info, "settings-access", page.getByRole("heading", { name: "Workspace access", exact: true }));
    await page.getByRole("button", { name: "Connection and agent access", exact: true }).click();
    await expect(page.locator(".settings-system-content .connection-badge")).toContainText("Connected");
    await capture(page, info, "settings-connection", page.getByRole("heading", { name: "Workspace connection", exact: true }));
    await page.getByRole("switch", { name: "Technical details", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Private API", exact: true })).toBeVisible();
    await capture(page, info, "settings-system-details", page.getByRole("heading", { name: "Private API", exact: true }));
    await page.getByRole("button", { name: "For agents", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agent workspace context", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "How agents should work", exact: true })).toBeVisible();
    await capture(page, info, "agent-capabilities", page.getByRole("heading", { name: "Agent workspace context", exact: true }));
  });
}
