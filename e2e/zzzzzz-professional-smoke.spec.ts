import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
async function login(page: Page) {
  await page.goto("/"); await page.getByLabel("Workspace password").fill("demo-password-please-change"); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
}
async function seed(page: Page, name: string, count = 0) {
  const id = `smoke-${randomUUID()}`, revision = `${id}-r1`;
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "forge_csrf")!.value;
  const post = async (path: string, data: object) => { const response = await page.request.post(`/api/v1${path}`, { headers: { "x-csrf-token": csrf, "idempotency-key": randomUUID() }, data }); expect(response.status(), await response.text()).toBeLessThan(300); return response.json(); };
  await post("/projects/with-initial-revision", { project: { id, name, status: "planned", description: "Synthetic smoke fixture." }, revision: { id: revision, name: "Initial", status: "concept", fabricationRoute: "printed" } });
  for (let i = 0; i < count; i++) await post(`/project-revisions/${revision}/bom`, { name: i === count - 1 ? "Café rear-panel connector" : `Ordinary part ${i}`, requiredQuantity: 1, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [] });
  await page.goto(`/#/projects/${id}/plan`); await page.reload(); await expect(page.getByRole("heading", { name, exact: true })).toBeVisible(); return { id, revision };
}
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`, "u") }).click();
test("an unavailable project link never opens an unrelated project", async ({ page }) => {
  await login(page); await page.goto("/#/projects/missing-project/plan"); await expect(page.getByRole("heading", { name: "Project unavailable", exact: true })).toBeVisible(); expect(page.url()).toContain("missing-project");
  await page.getByRole("button", { name: "Retry project lookup", exact: true }).click(); await expect(page.getByRole("heading", { name: "Project unavailable", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open project register", exact: true }).click(); await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
});
test("build draft navigation keeps edits until a deliberate discard", async ({ page }) => {
  await login(page); await seed(page, "Smoke guarded build"); await tab(page, "Build planning"); await page.getByRole("button", { name: "Create build plan", exact: true }).click(); await page.getByLabel("Build plan name").fill("Keep this build draft");
  await expect(page.getByRole("button", { name: "Refresh build plan", exact: true })).toBeDisabled(); await tab(page, "Files"); await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click(); await expect(page.getByLabel("Build plan name")).toHaveValue("Keep this build draft");
  await tab(page, "Files"); await page.getByRole("button", { name: "Discard changes and leave", exact: true }).click(); await expect(page.getByRole("heading", { name: "Build files", exact: true })).toBeVisible();
});
test("browser Back does not silently discard a workstream draft", async ({ page }) => {
  await login(page); await seed(page, "Smoke browser history"); await tab(page, "Build planning"); await page.getByRole("button", { name: "Add workstream", exact: true }).click(); await page.getByLabel("Workstream name").fill("Do not lose this task");
  await page.goBack(); await expect(page.getByRole("alertdialog")).toBeVisible(); await page.getByRole("button", { name: "Keep editing", exact: true }).click(); await expect(page.getByLabel("Workstream name")).toHaveValue("Do not lose this task"); expect(page.url()).toMatch(/\/build$/u);
  await tab(page, "Plan"); await page.getByRole("button", { name: "Discard changes and leave", exact: true }).click(); await expect(page.locator(".bom-section")).toBeVisible();
});
test("supplier search finds requirements beyond the first page and protects quote entry", async ({ page }) => {
  await login(page); await seed(page, "Smoke sourcing search", 25); await tab(page, "Shopping list");
  await page.getByLabel("Search quote requirements").fill("connector cafe"); await expect(page.locator(".sourcing-requirement")).toHaveCount(1); await expect(page.locator(".sourcing-requirement")).toContainText("Café rear-panel connector");
  await expect(page.locator(".sourcing-results-count")).toContainText("1 matching requirement"); await expect(page.locator(".sourcing-results-count")).toContainText("25 in the full revision");
  await page.getByRole("button", { name: "Record quote for Café rear-panel connector", exact: true }).click(); await page.getByLabel("Supplier", { exact: true }).fill("Draft supplier");
  await expect(page.getByRole("button", { name: "Refresh supplier quotes", exact: true })).toBeDisabled(); await tab(page, "Plan"); await page.getByRole("button", { name: "Keep editing", exact: true }).click(); await expect(page.getByLabel("Supplier", { exact: true })).toHaveValue("Draft supplier");
  await page.getByRole("button", { name: "Cancel quote", exact: true }).click(); await tab(page, "Plan"); await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
test("new workstream appears in file scope without a browser reload", async ({ page }) => {
  await login(page); await seed(page, "Smoke workstream context"); await tab(page, "Build planning"); await page.getByRole("button", { name: "Add workstream", exact: true }).click(); await page.getByLabel("Workstream name").fill("Fixture firmware"); await page.getByRole("button", { name: "Create workstream", exact: true }).click();
  await expect(page.getByText("Workstream created.", { exact: true })).toBeVisible(); await expect(page.locator(".workstream-row")).toHaveCount(1);
  await tab(page, "Files"); await expect(page.getByLabel("Choose file scope").locator("option").filter({ hasText: "Fixture firmware" })).toHaveCount(1);
});
test("staged files require a decision before switching revision scope", async ({ page }) => {
  await login(page); await seed(page, "Smoke staged file"); await tab(page, "Files");
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "draft-file.md", mimeType: "text/markdown", buffer: Buffer.from("Synthetic staged file") });
  await page.getByLabel("Choose file scope").selectOption("all"); await expect(page.getByRole("alertdialog")).toBeVisible(); await page.getByRole("button", { name: "Keep editing", exact: true }).click(); await expect(page.getByRole("button", { name: "Add 1 file", exact: true })).toBeEnabled();
  await tab(page, "Plan"); await page.getByRole("button", { name: "Discard changes and leave", exact: true }).click(); await tab(page, "Files"); await expect(page.getByRole("button", { name: "Add files", exact: true })).toBeDisabled();
});
test("mobile task area precedes setup context and remains within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 }); await login(page); await seed(page, "Smoke mobile hierarchy", 3);
  const order = await page.evaluate(() => { const workspace = document.querySelector(".dossier-workspace")!.getBoundingClientRect(), context = document.querySelector(".dossier-column")!.getBoundingClientRect(); return { workspace: workspace.top, context: context.top, width: document.documentElement.scrollWidth }; });
  expect(order.workspace).toBeLessThan(order.context); expect(order.width).toBeLessThanOrEqual(320);
  await tab(page, "Shopping list"); await expect(page.locator(".sourcing-requirement")).toHaveCount(3);
});
test("build loading errors do not claim that no plan exists", async ({ page }) => {
  await login(page); await seed(page, "Smoke failed plan read");
  await page.route("**/build-plan", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Synthetic read failure" } }) }));
  await tab(page, "Build planning"); await expect(page.locator(".build-planning").getByRole("alert")).toBeVisible(); await expect(page.getByText("No multi-plate plan recorded for this revision.", { exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "Create build plan", exact: true })).toBeDisabled();
});
for (const dark of [false, true]) test(`rendered pages and dialogs pass accessibility checks in ${dark ? "dark" : "light"} mode`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" }); await login(page); const { id } = await seed(page, `Smoke accessibility ${dark ? "dark" : "light"}`, 3);
  const audit = async () => { const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze(); expect(result.violations.map((issue) => ({ id: issue.id, nodes: issue.nodes.map((node) => node.target) }))).toEqual([]); };
  for (const hash of ["", "inventory", `projects/${id}/plan`, `projects/${id}/files`, `projects/${id}/offers`, `projects/${id}/build`, "settings", "capabilities"]) { await page.goto(`/#/${hash}`); await expect(page.locator("main")).toBeVisible(); await audit(); }
  await page.goto("/#/inventory"); await page.locator(".table-item").first().click(); await audit(); await page.keyboard.press("Escape");
  await page.getByLabel("Open workspace commands").click(); await audit(); await page.keyboard.press("Escape");
  await page.goto(`/#/projects/${id}/plan`); await page.getByRole("button", { name: "Edit project", exact: true }).click(); await audit(); await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 320, height: 800 }); await audit();
});
test("an unconfirmed plan save stays protected until an unchanged retry resolves it", async ({ page }) => {
  await login(page); await seed(page, "Smoke unresolved plan"); await tab(page, "Build planning"); await page.getByRole("button", { name: "Create build plan", exact: true }).click(); await page.getByRole("button", { name: "Add build part", exact: true }).click(); await page.getByLabel("Build part 1 name", { exact: true }).fill("Bracket"); await page.getByRole("button", { name: "Review build plan", exact: true }).click();
  let first = true; const keys: string[] = [];
  await page.route("**/build-plan", async (route) => { if (route.request().method() !== "PUT") { await route.continue(); return; } keys.push(route.request().headers()["idempotency-key"]!); if (first) { first = false; await route.fetch(); await route.abort("failed"); } else await route.continue(); });
  await page.getByRole("button", { name: "Save planning snapshot", exact: true }).click(); await expect(page.getByRole("button", { name: "Retry unchanged plan", exact: true })).toBeVisible();
  await tab(page, "Files"); await expect(page.getByRole("alertdialog", { name: "Finish the pending save" })).toBeVisible(); await expect(page.getByRole("button", { name: "Discard changes and leave" })).toHaveCount(0); await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.getByRole("button", { name: "Retry unchanged plan", exact: true }).click(); await expect(page.getByRole("button", { name: "Revise build plan", exact: true })).toBeVisible(); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); await tab(page, "Files"); await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
test("a committed workstream remains reported saved when its list refresh fails", async ({ page }) => {
  await login(page); await seed(page, "Smoke saved workstream outage"); await tab(page, "Build planning"); await page.getByRole("button", { name: "Add workstream", exact: true }).click(); await page.getByLabel("Workstream name").fill("Saved task");
  let created = false;
  await page.route("**/workstreams*", async (route) => { if (route.request().method() === "POST") { const response = await route.fetch(); created = true; await route.fulfill({ response }); } else if (created) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Synthetic read outage" } }) }); else await route.continue(); });
  await page.getByRole("button", { name: "Create workstream", exact: true }).click(); await expect(page.getByText("Workstream created.", { exact: true })).toBeVisible(); await expect(page.locator(".workstream-planning").getByRole("alert")).toBeVisible(); await expect(page.getByText("No workstreams recorded. Add a task group, such as firmware or assembly.", { exact: true })).toHaveCount(0);
  await page.unroute("**/workstreams*"); await page.getByRole("button", { name: "Refresh workstreams", exact: true }).click(); await expect(page.locator(".workstream-row")).toHaveCount(1); await expect(page.locator(".workstream-row")).toContainText("Saved task");
});
