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

async function mockRestoreWorkspace(page: Page): Promise<{ readonly restoreRequests: () => number }> {
  let restoreRequests = 0;
  await page.route("**/api/v1/auth/access", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: "lan_open", passwordConfigured: false, version: 1 }) });
  });
  await page.route("**/api/v1/auth/lan-session", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, actor: "e2e", csrfToken: "csrf-restore-e2e", expiresAt: "2026-09-01T18:00:00.000Z" }) });
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
    if (route.request().method() === "POST" && new URL(route.request().url()).pathname.endsWith("/projects/project-removal-e2e/restore")) {
      restoreRequests += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { ...project, status: "idea", version: 5, updatedAt: "2026-09-01T10:01:00.000Z" }, audit: { id: "audit-restore-e2e" }, correlationId: "correlation-restore-e2e", replayed: false }) });
      return;
    }
    if (route.request().method() !== "GET") return route.continue();
    const requestUrl = new URL(route.request().url());
    const archived = requestUrl.searchParams.get("status") === "archived";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: archived ? [project] : [], limit: 200, total: archived ? 1 : 0 }) });
  });
  await page.route("**/api/v1/inventory/categories*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], limit: 200, total: 0 }) });
  });
  return { restoreRequests: () => restoreRequests };
}

test.describe("restore confirmation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("restores an archived project only after confirmation", async ({ page }) => {
    const harness = await mockRestoreWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: /^Projects(?: \d+)?$/u }).click();
    await expect(page.getByRole("heading", { name: "Retained Archive E2E", exact: true })).toBeVisible();

    await page.getByText("Project settings", { exact: true }).click();
    await expect(page.locator("#main-content")).not.toContainText(/reservation|tombstone|audit/iu);
    const restoreButton = page.getByRole("button", { name: "Restore project", exact: true });
    await restoreButton.click();
    expect(harness.restoreRequests()).toBe(0);
    const dialog = page.getByRole("alertdialog", { name: "Restore Retained Archive E2E?" });
    await expect(dialog).toContainText("This moves the project to Idea. Stock released when it was archived will not be set aside again.");
    await expect(dialog).not.toContainText(/reservation|tombstone|audit/iu);
    await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Restore project", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(restoreButton).toBeFocused();
    expect(harness.restoreRequests()).toBe(0);

    await restoreButton.click();
    await page.getByRole("alertdialog", { name: "Restore Retained Archive E2E?" }).getByRole("button", { name: "Restore project", exact: true }).click();
    expect(harness.restoreRequests()).toBe(1);
    await expect(page.getByText("Retained Archive E2E was restored to Idea. Previously released stock was not set aside again.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive project", exact: true })).toBeVisible();
  });
});

test("removes an archived project only after exact-name confirmation and hides it from Archived", async ({ page }) => {
  const harness = await mockRemovalWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Projects(?: \d+)?$/u }).click();
  await expect(page.getByRole("heading", { name: "Retained Archive E2E", exact: true })).toBeVisible();

  await expect(page.locator(".page-header").getByRole("button", { name: "Delete from workspace", exact: true })).toHaveCount(0);
  await page.getByText("Project settings", { exact: true }).click();
  await expect(page.locator("#main-content")).not.toContainText(/reservation|tombstone|audit/iu);
  await page.getByRole("button", { name: "Remove from workspace", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove Retained Archive E2E from the workspace?" });
  await expect(dialog).toContainText("This action is irreversible.");
  await expect(dialog).toContainText("archived project");
  await expect(dialog).not.toContainText(/reservation|tombstone|audit/iu);
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
  await page.goBack();
  await expect(page.getByRole("heading", { name: "No projects yet", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Active projects", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goForward();
  await expect(page.getByRole("heading", { name: "No archived projects", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archived (0)", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("restores the active or archived project named by browser history", async ({ page }) => {
  const activeProject = {
    ...project,
    id: "project-active-e2e",
    name: "Active Project E2E",
    status: "idea",
    currentRevisionId: "revision-active-e2e",
    workItems: [],
    currentRevision: {
      ...project.currentRevision,
      id: "revision-active-e2e",
      projectId: "project-active-e2e",
      bom: [],
      artifacts: [],
    },
  };
  await page.route("**/api/v1/auth/access", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: "lan_open", passwordConfigured: false, version: 1 }) });
  });
  await page.route("**/api/v1/auth/lan-session", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, actor: "e2e", csrfToken: "csrf-history-e2e", expiresAt: "2026-09-01T18:00:00.000Z" }) });
  });
  await page.route("**/api/v1/auth/session", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, actor: "e2e", source: "ui", scopes: ["read", "write"] }) });
  });
  await page.route("**/api/v1/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", service: "benchledger", version: "e2e", demo: false, now: "2026-09-01T10:00:00.000Z" }) });
  });
  await page.route("**/api/v1/workspace", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source: "api", fetchedAt: "2026-09-01T10:00:00.000Z", inventory: [], projects: [activeProject], offers: [] }) });
  });
  await page.route("**/api/v1/projects**", async (route) => {
    const archived = new URL(route.request().url()).searchParams.get("status") === "archived";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: archived ? [project] : [activeProject], limit: 200, total: 1 }) });
  });
  await page.route("**/api/v1/inventory/categories*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], limit: 200, total: 0 }) });
  });

  await page.goto(`/#/projects/${project.id}/files`);
  await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Active projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: activeProject.name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Archived (1)", exact: true }).click();
  await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("heading", { name: activeProject.name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Active projects", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archived (1)", exact: true })).toHaveAttribute("aria-pressed", "true");
});
