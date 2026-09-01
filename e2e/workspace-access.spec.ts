import { expect, test, type Page } from "@playwright/test";

const LAN_WARNING = "Anyone who can reach this BenchLedger address can view inventory, change records, and change workspace security settings. Use LAN-open mode only on a trusted network. Enable a password before using guest Wi-Fi, port forwarding, internet exposure, or a public reverse proxy.";

type AccessMode = "lan_open" | "password";

function inventoryItem(id: string, name: string) {
  return {
    id, name, kind: "tool", quantity: 1, availableQuantity: 1, unit: "each", tags: [], links: [],
    evidence: { state: "physically_counted" }, createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z", version: 1
  };
}

async function mockWorkspaceAccess(page: Page) {
  let mode: AccessMode = "lan_open";
  let version = 1;
  let workspaceCredential = "old-password-please";
  let signedIn = false;
  let itemCount = 0;
  let lanSessionCount = 0;
  let loseNextResponse = false;
  const idempotentResponses = new Map<string, { body: string; response: string }>();
  let currentItems = [inventoryItem("tool-1", "Digital caliper")];

  await page.route("**/api/v1/auth/access", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode, passwordConfigured: mode === "password", version }) });
      return;
    }
    const body = route.request().postDataJSON() as { operation?: "enable" | "disable" | "change_password"; expectedVersion?: number; currentPassword?: string; newPassword?: string };
    const idempotencyKey = route.request().headers()["idempotency-key"] ?? "";
    const requestBody = JSON.stringify(body);
    const replay = idempotentResponses.get(idempotencyKey);
    if (replay) {
      if (replay.body !== requestBody) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "idempotency_conflict", message: "The request key was already used for a different change." } }) });
        return;
      }
      signedIn = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: replay.response });
      return;
    }
    const expectedVersion = Number(route.request().headers()["if-match"]);
    if (expectedVersion !== version || body.expectedVersion !== version) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "version_conflict", message: "Workspace settings changed elsewhere." } }) });
      return;
    }
    if (body.operation !== "enable" && body.operation !== "disable" && body.operation !== "change_password") {
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "invalid_operation", message: "A canonical workspace security operation is required." } }) });
      return;
    }
    if ((body.operation === "disable" || body.operation === "change_password") && body.currentPassword !== workspaceCredential) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "invalid_credentials", message: "The current password is not correct." } }) });
      return;
    }
    if ((body.operation === "enable" || body.operation === "change_password") && !body.newPassword) {
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "invalid_password", message: "A new password is required." } }) });
      return;
    }
    if (body.newPassword) workspaceCredential = body.newPassword;
    mode = body.operation === "disable" ? "lan_open" : "password";
    version += 1;
    signedIn = true;
    const responseBody = JSON.stringify({ mode, passwordConfigured: mode === "password", version, authenticated: true, actor: "admin", csrfToken: `csrf-${version}`, expiresAt: "2026-09-01T18:00:00.000Z" });
    idempotentResponses.set(idempotencyKey, { body: requestBody, response: responseBody });
    if (loseNextResponse) {
      loseNextResponse = false;
      signedIn = false;
      await route.abort("failed");
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: responseBody });
  });

  await page.route("**/api/v1/auth/lan-session", async (route) => {
    lanSessionCount += 1;
    signedIn = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, actor: "admin", csrfToken: "csrf-lan", expiresAt: "2026-09-01T18:00:00.000Z" }) });
  });
  await page.route("**/api/v1/auth/login", async (route) => {
    const body = route.request().postDataJSON() as { password?: string };
    if (body.password !== workspaceCredential) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "invalid_credentials", message: "Email or password is invalid" } }) });
      return;
    }
    signedIn = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, actor: "admin", csrfToken: "csrf-login", expiresAt: "2026-09-01T18:00:00.000Z" }) });
  });
  await page.route("**/api/v1/auth/session", async (route) => {
    if (!signedIn) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthenticated", message: "Authentication is required" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }) });
  });
  await page.route("**/api/v1/auth/logout", async (route) => {
    signedIn = false;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: false }) });
  });
  await page.route("**/api/v1/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-09-01T10:00:00.000Z" }) });
  });
  await page.route("**/api/v1/workspace", async (route) => {
    await route.fulfill({ status: signedIn ? 200 : 401, contentType: "application/json", body: JSON.stringify(signedIn ? { source: "api", fetchedAt: "2026-09-01T10:00:00.000Z", inventory: currentItems, projects: [], offers: [] } : { error: { code: "unauthenticated", message: "Authentication is required" } }) });
  });
  await page.route("**/api/v1/inventory?*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: currentItems, limit: 25, total: currentItems.length }) });
  });
  await page.route("**/api/v1/inventory", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (!signedIn) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthenticated", message: "Authentication is required" } }) });
      return;
    }
    const body = route.request().postDataJSON() as { name: string; quantity: number; unit: string };
    itemCount += 1;
    const item = inventoryItem(`new-tool-${itemCount}`, body.name);
    currentItems = [item, ...currentItems];
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: item }) });
  });

  return {
    setPasswordRequired: () => { signedIn = false; },
    loseNextAccessResponse: () => { loseNextResponse = true; },
    state: () => ({ mode, version, signedIn, credential: workspaceCredential, itemCount, lanSessionCount })
  };
}

test("completes the LAN-open to password and back access journey without exposing secrets", async ({ page }) => {
  const harness = await mockWorkspaceAccess(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Review build status." })).toBeVisible();
  await page.getByRole("button", { name: "Open account settings" }).click();
  await expect(page.getByRole("heading", { name: "Workspace access" })).toBeVisible();
  await expect(page.getByText("LAN open", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(LAN_WARNING);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);

  await page.getByLabel("New workspace password", { exact: true }).fill("new-password-please");
  await page.getByLabel("Confirm new workspace password", { exact: true }).fill("new-password-please");
  await page.getByRole("button", { name: "Enable password" }).click();
  await expect(page.getByText("Password protection is enabled.")).toBeVisible();
  expect(harness.state()).toMatchObject({ mode: "password", version: 2, signedIn: true });

  harness.setPasswordRequired();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Workspace password")).toBeVisible();
  await page.getByLabel("Workspace password").fill("new-password-please");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Review build status." })).toBeVisible();
  await page.getByRole("button", { name: "Open account settings" }).click();

  await page.getByLabel("Current workspace password", { exact: true }).fill("new-password-please");
  await page.getByLabel("New workspace password", { exact: true }).fill("replacement-password");
  await page.getByLabel("Confirm new workspace password", { exact: true }).fill("replacement-password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed. Your current session remains active.")).toBeVisible();
  await expect(page.getByLabel("Current workspace password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("New workspace password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Confirm new workspace password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Current workspace password to disable protection", { exact: true })).toHaveValue("");

  await page.getByLabel("Current workspace password to disable protection").fill("replacement-password");
  await page.getByRole("button", { name: "Disable password protection" }).click();
  await expect(page.getByText("Password protection is disabled. BenchLedger is LAN open.")).toBeVisible();
  await expect(page.getByText("LAN open", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);

  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByRole("button", { name: /^Tools\b/u }).click();
  await page.getByLabel("Name", { exact: true }).fill("LAN-open write check");
  await page.getByRole("button", { name: "Add item", exact: true }).last().click();
  await expect(page.getByText("LAN-open write check")).toBeVisible();
  expect(harness.state()).toMatchObject({ mode: "lan_open", itemCount: 1 });
  await expect(page.locator("body")).not.toContainText("replacement-password");
});

test("keeps the access warning and password controls usable on mobile", async ({ page }) => {
  await mockWorkspaceAccess(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account settings" }).click();
  await expect(page.getByRole("heading", { name: "Workspace access" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText(LAN_WARNING);
  await expect(page.getByLabel("New workspace password", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("button", { name: "Enable password" })).toBeVisible();
});

test("replays a lost enable response after reauthentication without retaining the password", async ({ page }) => {
  const harness = await mockWorkspaceAccess(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open account settings" }).click();
  await page.getByLabel("New workspace password", { exact: true }).fill("lost-enable-password");
  await page.getByLabel("Confirm new workspace password", { exact: true }).fill("lost-enable-password");
  harness.loseNextAccessResponse();
  await page.getByRole("button", { name: "Enable password" }).click();
  await expect(page.getByText("We could not confirm the change. It may have been saved; reload settings before trying again.")).toBeVisible();
  await expect(page.getByText("A previous request was not confirmed.")).toBeVisible();
  const storedBeforeReload = await page.evaluate(() => sessionStorage.getItem("benchledger:workspace-access-retry:v1"));
  expect(storedBeforeReload).not.toContain("lost-enable-password");
  expect(harness.state()).toMatchObject({ mode: "password", version: 2, signedIn: false });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Workspace password").fill("lost-enable-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Open account settings" }).click();
  await expect(page.getByRole("form", { name: "Retry enabling workspace password" })).toBeVisible();
  await page.getByLabel("New workspace password", { exact: true }).fill("lost-enable-password");
  await page.getByLabel("Confirm new workspace password", { exact: true }).fill("lost-enable-password");
  await page.getByRole("button", { name: "Retry enable" }).click();
  await expect(page.getByText("Password protection is enabled.")).toBeVisible();
  expect(harness.state()).toMatchObject({ mode: "password", version: 2, signedIn: true });
  await expect(page.locator("body")).not.toContainText("lost-enable-password");
});

test("replays a lost password change after logging in with the replacement", async ({ page }) => {
  const harness = await mockWorkspaceAccess(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open account settings" }).click();
  await page.getByLabel("New workspace password", { exact: true }).fill("first-change-password");
  await page.getByLabel("Confirm new workspace password", { exact: true }).fill("first-change-password");
  await page.getByRole("button", { name: "Enable password" }).click();
  await expect(page.getByText("Password protection is enabled.")).toBeVisible();
  await page.getByLabel("Current workspace password", { exact: true }).fill("first-change-password");
  await page.getByLabel("New workspace password", { exact: true }).fill("second-change-password");
  await page.getByLabel("Confirm new workspace password", { exact: true }).fill("second-change-password");
  harness.loseNextAccessResponse();
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("We could not confirm the change. It may have been saved; reload settings before trying again.")).toBeVisible();
  expect(harness.state()).toMatchObject({ mode: "password", version: 3, signedIn: false });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Workspace password").fill("second-change-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Open account settings" }).click();
  await page.getByLabel("Current workspace password", { exact: true }).fill("first-change-password");
  await page.getByLabel("New workspace password", { exact: true }).fill("second-change-password");
  await page.getByLabel("Confirm new workspace password", { exact: true }).fill("second-change-password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed. Your current session remains active.")).toBeVisible();
  expect(harness.state()).toMatchObject({ mode: "password", version: 3, signedIn: true, credential: "second-change-password" });
  await expect(page.locator("body")).not.toContainText("second-change-password");
});

test("replays a lost disable response after LAN bootstrap", async ({ page }) => {
  const harness = await mockWorkspaceAccess(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open account settings" }).click();
  await page.getByLabel("New workspace password", { exact: true }).fill("disable-password-please");
  await page.getByLabel("Confirm new workspace password", { exact: true }).fill("disable-password-please");
  await page.getByRole("button", { name: "Enable password" }).click();
  await expect(page.getByText("Password protection is enabled.")).toBeVisible();
  await page.getByLabel("Current workspace password to disable protection", { exact: true }).fill("disable-password-please");
  harness.loseNextAccessResponse();
  await page.getByRole("button", { name: "Disable password protection" }).click();
  await expect(page.getByText("We could not confirm the change. It may have been saved; reload settings before trying again.")).toBeVisible();
  expect(harness.state()).toMatchObject({ mode: "lan_open", version: 3, signedIn: false });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Review build status." })).toBeVisible();
  expect(harness.state().lanSessionCount).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Open account settings" }).click();
  await expect(page.getByRole("form", { name: "Enable workspace password" })).toHaveCount(0);
  await expect(page.getByLabel("Current workspace password to retry disabling protection")).toBeVisible();
  await page.getByLabel("Current workspace password to retry disabling protection").fill("disable-password-please");
  await page.getByRole("button", { name: "Retry disable" }).click();
  await expect(page.getByText("Password protection is disabled. BenchLedger is LAN open.")).toBeVisible();
  expect(harness.state()).toMatchObject({ mode: "lan_open", version: 3, signedIn: true });
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("disable-password-please");
});
