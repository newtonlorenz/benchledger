import { expect, test, type Page } from "@playwright/test";

const project = {
  id: "project-removal-e2e",
  name: "Retained Archive E2E",
  description: "A project kept for removal-flow coverage.",
  status: "archived",
  currentRevisionId: "revision-removal-e2e",
  updatedAt: "2026-09-01T10:00:00.000Z",
  createdAt: "2026-09-01T09:00:00.000Z",
  version: 4,
  workItems: [{ id: "work-removal-e2e", projectId: "project-removal-e2e", name: "Removal fixture", kind: "project", description: "Retained history fixture." }],
  currentRevision: { id: "revision-removal-e2e", projectId: "project-removal-e2e", number: 1, name: "Initial", status: "concept", createdAt: "2026-09-01T09:00:00.000Z", version: 1, bom: [], artifacts: [] }
};

async function mockRemovalWorkspace(page: Page): Promise<{ readonly deleteRequest: () => { readonly body: unknown; readonly ifMatch: string | undefined; readonly idempotencyKey: string | undefined } | undefined }> {
  let deleted: { readonly body: unknown; readonly ifMatch: string | undefined; readonly idempotencyKey: string | undefined } | undefined;
  await page.route("**/api/v1/auth/access", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: "lan_open", passwordConfigured: false, version: 1 }) });
  });
  await page.route("**/api/v1/auth/lan-session", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, actor: "e2e", csrfToken: "csrf-removal-e2e", expiresAt: "2026-09-01T18:00:00.000Z" }) });
  });
  await page.route("**/api/v1/auth/session", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, actor: "e2e", source: "ui", scopes: ["read", "write"] }) });
  });
  await page.route("**/api/v1/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", service: "benchledger", version: "e2e", demo: false, now: "2026-09-01T10:00:00.000Z" }) });
  });
  await page.route("**/api/v1/workspace", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source: "api", fetchedAt: "2026-09-01T10:00:00.000Z", inventory: [], projects: [], offers: [] }) });
  });
  await page.route("**/api/v1/projects**", async (route) => {
    if (route.request().method() === "DELETE" && new URL(route.request().url()).pathname.endsWith("/projects/project-removal-e2e")) {
      deleted = { body: route.request().postDataJSON(), ifMatch: route.request().headers()["if-match"], idempotencyKey: route.request().headers()["idempotency-key"] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { id: project.id, name: project.name, removedAt: "2026-09-01T10:01:00.000Z", removedBy: "e2e", lastLifecycleStatus: "archived", releasedReservationIds: ["reservation-e2e"], version: 5, auditId: "audit-removal-e2e" }, audit: { id: "audit-removal-e2e" }, correlationId: "correlation-removal-e2e", replayed: false }) });
      return;
    }
    if (route.request().method() !== "GET") return route.continue();
    const requestUrl = new URL(route.request().url());
    const archived = requestUrl.searchParams.get("status") === "archived" && !deleted;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: archived ? [project] : [], limit: 200, total: archived ? 1 : 0 }) });
  });
  await page.route("**/api/v1/inventory/categories*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], limit: 200, total: 0 }) });
  });
  return { deleteRequest: () => deleted };
}

test("removes an archived project only after exact-name confirmation and hides it from Archived", async ({ page }) => {
  const harness = await mockRemovalWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Projects(?: \d+)?$/u }).click();
  await expect(page.getByRole("heading", { name: "Retained Archive E2E", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Delete from workspace", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove Retained Archive E2E from the workspace?" });
  await expect(dialog).toContainText("This action is irreversible.");
  const removeButton = dialog.getByRole("button", { name: "Remove from workspace", exact: true });
  await expect(removeButton).toBeDisabled();
  await dialog.getByLabel("Type Retained Archive E2E to confirm").fill("retained archive e2e");
  await expect(removeButton).toBeDisabled();
  await dialog.getByLabel("Type Retained Archive E2E to confirm").fill("Retained Archive E2E");
  await expect(removeButton).toBeEnabled();
  await removeButton.click();

  expect(harness.deleteRequest()).toMatchObject({ body: { name: "Retained Archive E2E" }, ifMatch: "4" });
  expect(harness.deleteRequest()?.idempotencyKey).toBeTruthy();
  await expect(page.getByRole("heading", { name: "No projects yet", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Archived (0)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No archived projects", exact: true })).toBeVisible();
});
