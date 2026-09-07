import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { createApp } from "../apps/server/dist/app.js";
let closeFixture: (() => Promise<void>) | undefined;
test.afterEach(async () => { await closeFixture?.(); closeFixture = undefined; });

// Each scenario owns a temporary durable SQLite workspace, never a live service.
async function fixture(page: Page, reserve = true) {
  const directory = await mkdtemp("/tmp/benchledger-acceptance-");
  const app = await createApp({ demo: false, dataDir: directory, publicBaseUrl: "http://127.0.0.1", logger: false, auth: { sessionSecret: randomUUID().repeat(2) } });
  closeFixture = async () => { const closed = app.close(); app.server.closeAllConnections(); await closed; await rm(directory, { recursive: true, force: true }); };
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
  const id = `accept-${randomUUID()}`, revision = `${id}-r1`, itemId = `${id}-stock`;
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "forge_csrf")!.value;
  const post = async (path: string, data: object) => {
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "forge_csrf")!.value;
    const response = await page.request.post(`${base}/api/v1${path}`, { headers: { "x-csrf-token": csrf, "idempotency-key": randomUUID() }, data });
    expect(response.status(), await response.text()).toBeLessThan(300);
    return response.json();
  };
  await post("/projects/with-initial-revision", { project: { id, name: `Acceptance fixture ${id}`, status: "building" }, revision: { id: revision, name: "Initial", status: "concept", fabricationRoute: "none" } });
  await post("/inventory", { id: itemId, name: "Synthetic acceptance fasteners", kind: "fastener", quantity: 10, unit: "each", tags: [], links: [], evidence: { state: "physically_counted", source: "Synthetic fixture only" } });
  const line = (await post(`/project-revisions/${revision}/bom`, { name: "Mounting fasteners", requiredQuantity: 4, unit: "each", role: "consumed", itemId, optional: false, constraints: {}, alternatives: [] })).data;
  if (reserve) await post(`/project-revisions/${revision}/reservations`, { lineId: line.id, itemId, quantity: 4 });
  await page.goto(`${base}/#/projects/${id}/reconciliation`); await page.reload();
  await expect(page.locator(".reconciliation-shell")).toBeVisible();
  return { id, revision, itemId, lineId: line.id, post, base };
}
async function result(page: Page) {
  await page.getByRole("button", { name: "Add result", exact: true }).click();
  await page.getByLabel("What happened", { exact: true }).selectOption("consumed");
  await page.getByLabel("Quantity for result 1", { exact: true }).fill("4");
  await page.getByLabel("How did you check for result 1", { exact: true }).selectOption("physically_counted");
}
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`, "u") }).click();
test("used-stock results survive attempted navigation until a deliberate discard", async ({ page }) => {
  await fixture(page); await result(page); await tab(page, "Plan");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Quantity for result 1")).toHaveValue("4");
});
test("final stock approval traps focus, supports Escape and keeps the page inert", async ({ page }) => {
  await fixture(page); await result(page);
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await page.getByRole("button", { name: "Apply stock changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Apply these changes?", exact: true });
  await expect(dialog.getByRole("button", { name: "Go back", exact: true })).toBeFocused();
  for (let i = 0; i < 5; i++) { await page.keyboard.press("Tab"); expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true); }
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply stock changes", exact: true })).toBeFocused();
});
test("a committed stock update is read-only and the original preview is not editable", async ({ page }) => {
  const { itemId, base } = await fixture(page); await result(page);
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await page.getByRole("button", { name: "Apply stock changes", exact: true }).click();
  await page.getByRole("dialog", { name: "Apply these changes?" }).getByRole("button", { name: "Apply stock changes", exact: true }).click();
  await expect(page.locator(".reconciliation-committed")).toBeVisible();
  await expect(page.getByLabel("Quantity for result 1")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove result 1" })).toHaveCount(0);
  await expect(page.getByLabel("Saved result 1", { exact: true })).toContainText("4 each");
  await expect(page.getByLabel("Saved result 1", { exact: true })).toContainText("Stock item: Synthetic acceptance fasteners");
  await expect(page.getByRole("heading", { name: "Recorded stock changes", exact: true })).toBeVisible();
  const stock = await (await page.request.get(`${base}/api/v1/inventory/${itemId}`)).json(); expect(stock.quantity).toBe(6);
});
test("a lost review response freezes its inputs and resolves by an unchanged retry", async ({ page }) => {
  await fixture(page); await result(page); let first = true; const keys: string[] = [];
  await page.route("**/reconciliation", async (route) => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    keys.push(route.request().headers()["idempotency-key"]!);
    if (first) { first = false; await route.fetch(); await route.abort("failed"); } else await route.continue();
  });
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry unchanged review", exact: true })).toBeVisible();
  await expect(page.getByLabel("Quantity for result 1")).toBeDisabled();
  await tab(page, "Files"); await expect(page.getByRole("alertdialog", { name: "Finish the pending save" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.getByRole("button", { name: "Retry unchanged review", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply stock changes", exact: true })).toBeEnabled();
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
});
test("a lost stock-commit response retries once without consuming stock twice", async ({ page }) => {
  const { base, itemId } = await fixture(page); await result(page);
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  let first = true; const keys: string[] = [];
  await page.route("**/reconciliation/commit", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]!);
    if (first) { first = false; await route.fetch(); await route.abort("failed"); } else await route.continue();
  });
  await page.getByRole("button", { name: "Apply stock changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Apply these changes?" });
  await dialog.getByRole("button", { name: "Apply stock changes", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible(); await expect(dialog.getByRole("button", { name: "Go back" })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Retry unchanged stock update", exact: true }).click();
  await expect(page.locator(".reconciliation-committed")).toBeVisible(); await expect(dialog).toHaveCount(0);
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  const stock = await (await page.request.get(`${base}/api/v1/inventory/${itemId}`)).json(); expect(stock.quantity).toBe(6);
});
test("review-in-flight cannot overwrite edits made during its request", async ({ page }) => {
  await fixture(page); await result(page);
  let release: (() => void) | undefined;
  await page.route("**/reconciliation", async (route) => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    const response = await route.fetch(); await new Promise<void>((resolve) => { release = resolve; }); await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByLabel("Quantity for result 1")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove result 1" })).toBeDisabled();
  await expect.poll(() => Boolean(release)).toBe(true); release!();
  await expect(page.getByRole("button", { name: "Apply stock changes", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Quantity for result 1")).toHaveValue("4");
});
test("an unconfirmed quote selection cannot be removed by a list filter", async ({ page }) => {
  const { id, revision, post } = await fixture(page, false);
  const line = (await post(`/project-revisions/${revision}/bom`, { name: "Source a connector", requiredQuantity: 1, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [] })).data;
  await post(`/projects/${id}/revisions/${revision}/requirement-offers`, { bomLineId: line.id, expectedBomLineVersion: 1, supplier: "Synthetic supplier", title: "Test-only connector", url: "https://supplier.example/fixture", packageQuantity: 1, packageUnit: "each", priceMinor: 200, currency: "EUR", observedAt: new Date().toISOString() });
  await tab(page, "Shopping list"); await page.getByLabel("I checked that this quoted item meets the current requirement").check();
  let first = true; const keys: string[] = [];
  await page.route("**/offer-choice", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]!);
    if (first) { first = false; await route.fetch(); await route.abort("failed"); } else await route.continue();
  });
  await page.getByRole("button", { name: "Use reviewed quote", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry unchanged selection", exact: true })).toBeVisible();
  await expect(page.getByLabel("Search quote requirements")).toBeDisabled();
  await expect(page.getByRole("button", { name: "All requirements", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Refresh supplier quotes", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry unchanged selection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Clear quote selection", exact: true })).toBeVisible();
  expect(keys[0]).toBe(keys[1]); await expect(page.getByLabel("Search quote requirements")).toBeEnabled();
});
test("inspection confirmation isolates focus and preserves the exact reviewed input on retry", async ({ page }) => {
  const { id, revision, post, base } = await fixture(page, false); const itemId = `${id}-led`;
  await post("/inventory", { id: itemId, name: "Synthetic inspected LED", kind: "electronic", quantity: 3, unit: "each", tags: [], links: [], evidence: { state: "delivered_uncounted" } });
  await post(`/project-revisions/${revision}/bom`, { name: "Test illumination", itemId, requiredQuantity: 1, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [] });
  await page.goto(`${base}/#/projects/${id}/plan`); await page.reload();
  await page.getByRole("button", { name: /^Check Synthetic inspected LED/u }).click();
  const dialog = page.getByRole("dialog", { name: "Record the result", exact: true });
  await expect(page.getByRole("combobox", { name: "Inspection result", exact: true })).toBeFocused();
  await page.getByRole("combobox", { name: "Inspection result", exact: true }).selectOption("confirmed");
  await page.getByLabel("Observed quantity (each)").fill("3"); await page.getByRole("combobox", { name: "How did you check?", exact: true }).selectOption("Physical check");
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Confirm result", exact: true })).toBeVisible();
  let first = true; const keys: string[] = [];
  await page.route("**/completion-commit", async (route) => { keys.push(route.request().headers()["idempotency-key"]!); if (first) { first = false; await route.fetch(); await route.abort("failed"); } else await route.continue(); });
  await dialog.getByRole("button", { name: "Confirm result", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Retry unchanged result", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Inspection result", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Retry unchanged result", exact: true }).click();
  await expect(dialog).toHaveCount(0); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
});
test("project refresh reads external updates without losing an in-progress stock draft", async ({ page }) => {
  const { revision, post } = await fixture(page);
  await result(page); await page.getByRole("button", { name: "Refresh project", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible(); await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Quantity for result 1")).toHaveValue("4");
  await tab(page, "Plan"); await page.getByRole("button", { name: "Discard changes and leave", exact: true }).click();
  await post(`/project-revisions/${revision}/bom`, { name: "Requirement added by another client", requiredQuantity: 1, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [] });
  const writes: string[] = []; page.on("request", (request) => { if (request.url().includes("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.url()); });
  await page.getByRole("button", { name: "Refresh project", exact: true }).click();
  await expect(page.locator(".bom-row").filter({ hasText: "Requirement added by another client" })).toBeVisible();
  await expect(page.getByText("Project refreshed from the workspace.", { exact: true })).toBeVisible(); expect(writes).toEqual([]);
});
test("a project refresh failure preserves confirmed records and explains the stale view", async ({ page }) => {
  await fixture(page, false); await tab(page, "Plan");
  await page.route("**/workspace", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Synthetic workspace outage" } }) }));
  await page.getByRole("button", { name: "Refresh project", exact: true }).click();
  await expect(page.locator(".project-management-bar").getByRole("alert")).toContainText("Previous records remain visible");
  await expect(page.locator(".bom-row").filter({ hasText: "Mounting fasteners" })).toBeVisible();
});
test("explicit refresh discard resets the local build editor rather than claiming a stale draft was refreshed", async ({ page }) => {
  await fixture(page, false); await tab(page, "Build planning");
  await page.getByRole("button", { name: "Create build plan", exact: true }).click();
  await page.getByLabel("Build plan name", { exact: true }).fill("Unsaved local name");
  await page.getByRole("button", { name: "Refresh project", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes and leave", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create build plan", exact: true })).toBeVisible();
  await expect(page.getByLabel("Build plan name", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Project refreshed from the workspace.", { exact: true })).toBeVisible();
});
test("workstream pagination cannot drop a dirty assignment", async ({ page }) => {
  const { id, post } = await fixture(page, false);
  for (let i = 0; i < 21; i++) await post(`/projects/${id}/workstreams`, { name: `Workstream ${i.toString().padStart(2, "0")}`, kind: "assembly" });
  await tab(page, "Build planning"); await page.locator(".workstream-row > summary").first().click();
  await page.locator(".workstream-row").first().getByRole("textbox", { name: "Workstream notes", exact: true }).fill("Keep this assignment");
  await page.getByRole("button", { name: "Next workstreams", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible(); await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.locator(".workstream-row").first().getByRole("textbox", { name: "Workstream notes", exact: true })).toHaveValue("Keep this assignment");
});
for (const colour of ["light", "dark"] as const) test(`durable stock review and approval are accessible at phone width in ${colour}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: colour, reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 800 });
  await fixture(page); await result(page);
  await expect(page.locator("h1")).toHaveCount(1);
  const audit = async () => {
    const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(report.violations.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) }))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };
  await audit(); await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await page.getByRole("button", { name: "Apply stock changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Apply these changes?" });
  await expect(dialog.getByRole("button", { name: "Apply stock changes", exact: true })).toBeInViewport();
  await audit(); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
});
