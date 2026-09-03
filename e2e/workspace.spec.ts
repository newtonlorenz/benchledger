import { expect, test, type Page } from "@playwright/test";

const demoPassword = "demo-password-please-change";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill(demoPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Review build status." })).toBeVisible();
}

function inventoryRecord(id: string, name: string, kind = "tool") {
  return {
    id, name, kind, quantity: 1, availableQuantity: 1, unit: "each", tags: [], links: [],
    evidence: { state: "physically_counted" }, createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z", version: 1
  };
}

test("filters, edits, and physically counts evidence-aware inventory", async ({ page }) => {
  await signIn(page);
  const inventoryRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/api/v1/inventory")) inventoryRequests.push(url.toString());
  });
  await page.getByRole("button", { name: "Inventory", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Review inventory." })).toBeVisible();
  await expect(page.locator(".inventory-summary")).toHaveCount(0);
  const headers = page.getByRole("table").getByRole("columnheader");
  await expect(headers).toHaveCount(7);
  await expect(headers.nth(1)).toHaveText("Item");
  await expect(headers.nth(2)).toHaveText("Category");
  await expect(headers.nth(3)).toHaveText("Quantity");
  await expect(headers.nth(4)).toHaveText("Status");
  await expect(headers.nth(5)).toHaveText("Location");
  await expect(headers.nth(6)).toHaveText("Open");
  await expect(page.getByRole("columnheader", { name: "Evidence source", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Filter inventory by category")).toBeVisible();
  await page.getByLabel("Filter inventory by category").selectOption("__unassigned__");
  await page.getByLabel("Filter inventory by kind").selectOption("electronic");
  await page.getByLabel("Filter inventory by evidence").selectOption("physically_counted");
  await page.getByLabel("Filter inventory by availability").selectOption("available");
  await page.getByLabel("Search inventory").fill("ESP32");
  await expect(page.locator(".inventory-page-status")).toContainText("Showing 1 of 1 items");
  const espRow = page.getByRole("row").filter({ has: page.getByRole("button", { name: "ESP32 development board electronic" }) });
  await expect(espRow).toBeVisible();
  expect(inventoryRequests.some((value) => {
    const url = new URL(value);
    return url.searchParams.get("q") === "ESP32"
      && url.searchParams.get("kind") === "electronic"
      && url.searchParams.get("evidence") === "physically_counted"
      && url.searchParams.get("available") === "true"
      && url.searchParams.get("unassigned") === "true"
      && url.searchParams.get("limit") === "25";
  })).toBe(true);
  await expect(espRow).toContainText("Ready to use");
  await expect(espRow).not.toContainText("synthetic-demo");
  await expect(page.getByRole("button", { name: "Bambu Lab H2D printer" })).toHaveCount(0);

  await page.getByRole("button", { name: "ESP32 development board electronic" }).click();
  const drawer = page.getByRole("dialog", { name: "ESP32 development board" });
  await expect(drawer.getByText("Provenance", { exact: true })).toHaveCount(0);
  await expect(drawer).toContainText("Ready to use");
  await expect(drawer).not.toContainText("synthetic-demo");

  await drawer.getByRole("button", { name: "Edit item" }).click();
  await drawer.getByLabel("Name").fill("Temporary name");
  await drawer.getByRole("button", { name: "Cancel" }).click();
  await expect(drawer.getByRole("heading", { name: "ESP32 development board" })).toBeVisible();

  await drawer.getByRole("button", { name: "Edit item" }).click();
  await drawer.getByLabel("Description").fill("Controller board for test fixtures.");
  await drawer.getByLabel("Location").fill("Electronics drawer 2");
  await drawer.getByRole("combobox", { name: /Category/u }).selectOption("category-electronics");
  const legacyUpdateResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "PATCH" && response.status() === 200 && /\/api\/v1\/inventory\/board-esp32$/u.test(url.pathname);
  });
  await drawer.getByRole("button", { name: "Save changes" }).click();
  const legacyUpdate = await legacyUpdateResponse;
  expect(legacyUpdate.request().postDataJSON()).toMatchObject({
    description: "Controller board for test fixtures.",
    location: "Electronics drawer 2",
    categoryNodeId: "category-electronics",
  });
  await expect(drawer).toContainText("Controller board for test fixtures.");
  await expect(drawer).toContainText("Electronics drawer 2");
  await expect(drawer.locator(".drawer-header .eyebrow")).toHaveText("Electronics");

  await drawer.getByLabel("Counted quantity").fill("3");
  await drawer.getByRole("button", { name: "Confirm physical count" }).click();
  await expect(drawer.getByRole("status")).toContainText("Confirmed 3 pieces as the on-hand quantity.");

  await page.route("**/api/v1/inventory/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "version_conflict", message: "The item changed on the service. Reload and try again." } }) });
  });
  await drawer.getByRole("button", { name: "Edit item" }).click();
  await drawer.getByLabel("Description").fill("This change must fail.");
  await drawer.getByRole("button", { name: "Save changes" }).click();
  await expect(drawer.getByRole("alert")).toContainText("The item changed on the service. Reload and try again.");
  await expect(drawer.getByRole("button", { name: "Cancel" })).toBeVisible();
});

test("loads server-backed continuation pages, resets filters, and ignores stale search results", async ({ page }) => {
  await signIn(page);
  const rows = Array.from({ length: 30 }, (_, index) => inventoryRecord(`tool-${String(index).padStart(2, "0")}`, `Tool ${String(index).padStart(2, "0")}`));
  const electronic = inventoryRecord("electronic-one", "Fast ESP32", "electronic");
  const slow = inventoryRecord("slow-result", "Slow result");
  const fast = inventoryRecord("fast-result", "Fast result");
  let continuationFailures = 1;
  await page.route("**/api/v1/inventory**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() !== "GET" || requestUrl.pathname !== "/api/v1/inventory") return route.continue();
    const query = requestUrl.searchParams.get("q") ?? "";
    const kind = requestUrl.searchParams.get("kind");
    const cursor = requestUrl.searchParams.get("cursor");
    const filtered = kind === "electronic" ? [electronic] : query === "slow" ? [slow] : query === "fast" ? [fast] : rows;
    if (query === "slow") await new Promise((resolve) => setTimeout(resolve, 450));
    const offset = cursor === "25" ? 25 : 0;
    if (offset === 25 && continuationFailures > 0) {
      continuationFailures -= 1;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "temporary_failure", message: "Continuation temporarily unavailable." } }) });
      return;
    }
    const data = filtered.slice(offset, offset + 25);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, limit: 25, total: filtered.length, ...(offset + data.length < filtered.length ? { nextCursor: String(offset + data.length) } : {}) }) });
  });

  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  const status = page.locator(".inventory-page-status");
  await expect(status).toHaveText("Showing 25 of 30 items");
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(status).toHaveText("Showing the loaded items. More items could not be loaded.");
  await expect(page.getByRole("button", { name: "Open Tool 24" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Tool 29" })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(status).toHaveText("Showing 30 of 30 items");
  await expect(page.getByRole("button", { name: "Open Tool 29" })).toBeVisible();

  await page.getByLabel("Filter inventory by kind").selectOption("electronic");
  await expect(status).toHaveText("Showing 1 of 1 items");
  await expect(page.getByRole("button", { name: "Open Fast ESP32" })).toBeVisible();
  await page.getByLabel("Filter inventory by kind").selectOption("All");
  await expect(status).toHaveText("Showing 25 of 30 items");

  const search = page.locator(".field-search input");
  await search.fill("slow");
  await page.waitForTimeout(320);
  await search.fill("fast");
  await expect(status).toHaveText("Showing 1 of 1 items");
  await expect(page.getByRole("button", { name: "Open Fast result" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Slow result" })).toHaveCount(0);
});

test("selects loaded inventory across pages, caps the selection surface, and clears it when filters change", async ({ page }) => {
  await signIn(page);
  const rows = Array.from({ length: 30 }, (_, index) => inventoryRecord(`tool-${String(index).padStart(2, "0")}`, `Tool ${String(index).padStart(2, "0")}`));
  await page.route("**/api/v1/inventory**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() !== "GET" || requestUrl.pathname !== "/api/v1/inventory") return route.continue();
    const query = requestUrl.searchParams.get("q") ?? "";
    const filtered = query ? rows.filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : rows;
    const offset = requestUrl.searchParams.get("cursor") === "25" ? 25 : 0;
    const data = filtered.slice(offset, offset + 25);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, limit: 25, total: filtered.length, ...(offset + data.length < filtered.length ? { nextCursor: String(offset + data.length) } : {}) }) });
  });

  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(page.locator(".inventory-page-status")).toHaveText("Showing 25 of 30 items");
  await page.getByLabel("Select all loaded inventory items").check();
  await expect(page.locator(".inventory-selection-bar")).toContainText("25 selected of 25 loaded");
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator(".inventory-selection-bar")).toContainText("25 selected of 30 loaded");
  await page.getByLabel("Select Tool 29").check();
  await expect(page.locator(".inventory-selection-bar")).toContainText("26 selected of 30 loaded");

  await page.locator(".field-search input").fill("Tool 00");
  await expect(page.locator(".inventory-page-status")).toHaveText("Showing 1 of 1 items");
  await expect(page.locator(".inventory-selection-bar")).toHaveCount(0);
  await expect(page.locator(".inventory-selection-notice")).toContainText("Selection cleared");
  await expect(page.getByLabel("Select Tool 00")).toBeVisible();
});

test("blocks bulk selection for rows without an observed version", async ({ page }) => {
  await signIn(page);
  const unversioned = { ...inventoryRecord("legacy-item", "Legacy item"), version: undefined };
  const versioned = inventoryRecord("current-item", "Current item");
  let bulkRequests = 0;
  await page.route("**/api/v1/inventory**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() !== "GET" || requestUrl.pathname !== "/api/v1/inventory") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [unversioned, versioned], limit: 25, total: 2 }) });
  });
  await page.route("**/api/v1/inventory/bulk", async (route) => {
    bulkRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "unexpected", message: "Bulk request should not be sent." } }) });
  });

  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(page.getByLabel("Select Legacy item")).toBeDisabled();
  await expect(page.getByLabel("Select all loaded inventory items")).toBeDisabled();
  await expect(page.locator(".inventory-selection-notice")).toContainText("observed version is unavailable");
  await page.getByLabel("Select Current item").check();
  const dialog = page.getByRole("dialog", { name: "Bulk edit inventory" });
  await page.getByRole("button", { name: "Bulk edit" }).click();
  await expect(dialog).toContainText("1 selected item");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(bulkRequests).toBe(0);
});

test("confirms bulk inventory changes and refreshes returned rows", async ({ page }) => {
  await signIn(page);
  const serverRows = Array.from({ length: 30 }, (_, index) => inventoryRecord(`tool-${String(index).padStart(2, "0")}`, `Tool ${String(index).padStart(2, "0")}`));
  let refreshes = 0;
  let requestBody: { targets: Array<{ itemId: string; expectedVersion: number }>; changes: Record<string, unknown> } | undefined;
  await page.route("**/api/v1/inventory**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() !== "GET" || requestUrl.pathname !== "/api/v1/inventory") return route.continue();
    refreshes += 1;
    const offset = requestUrl.searchParams.get("cursor") === "25" ? 25 : 0;
    const data = serverRows.slice(offset, offset + 25);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, limit: 25, total: serverRows.length, ...(offset + data.length < serverRows.length ? { nextCursor: String(offset + data.length) } : {}) }) });
  });
  await page.route("**/api/v1/inventory/bulk", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    requestBody = route.request().postDataJSON() as typeof requestBody;
    const updated = requestBody.targets.map((target) => {
      const index = serverRows.findIndex((item) => item.id === target.itemId);
      const next = { ...serverRows[index]!, location: "Bulk shelf", condition: "good", tags: ["bulk"], version: target.expectedVersion + 1 };
      serverRows[index] = next;
      return next;
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { updated, unchanged: [] }, audits: updated.map((item) => ({ id: `audit-${item.id}` })), correlationId: "e2e-bulk", replayed: false }) });
  });

  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(page.locator(".inventory-page-status")).toHaveText("Showing 25 of 30 items");
  await page.getByLabel("Select Tool 00").check();
  await page.getByLabel("Select Tool 01").check();
  await page.getByRole("button", { name: "Bulk edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Bulk edit inventory" });
  await expect(dialog).toContainText("2 selected");
  await dialog.getByLabel("Location").fill("Bulk shelf");
  await dialog.getByLabel("Condition").selectOption("good");
  await dialog.getByLabel("Tags to add").fill("bulk");
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await expect(dialog).toContainText("Nothing changes until you confirm.");
  await dialog.getByRole("button", { name: "Confirm bulk edit" }).click();
  await expect(dialog.getByRole("status")).toContainText("Saved changes to 2 items");
  expect(requestBody).toEqual({
    targets: [{ itemId: "tool-00", expectedVersion: 1 }, { itemId: "tool-01", expectedVersion: 1 }],
    changes: { location: "Bulk shelf", condition: "good", tags: { add: ["bulk"] } }
  });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: "Open Tool 00" })).toBeVisible();
  await expect(page.locator(".inventory-table tbody tr").filter({ hasText: "Tool 00" })).toContainText("Bulk shelf");
  expect(refreshes).toBeGreaterThan(1);
});

test("reports bulk no-op and conflict states without discarding the edit", async ({ page }) => {
  await signIn(page);
  const item = inventoryRecord("bulk-item", "Bulk item");
  let mode: "noop" | "conflict" = "noop";
  await page.route("**/api/v1/inventory**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() !== "GET" || requestUrl.pathname !== "/api/v1/inventory") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [item], limit: 25, total: 1 }) });
  });
  await page.route("**/api/v1/inventory/bulk", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    if (mode === "conflict") {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "version_conflict", message: "Inventory changed since it was selected; nothing was changed." } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { updated: [], unchanged: [item] }, audits: [], correlationId: "e2e-noop", replayed: false }) });
  });

  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByLabel("Select Bulk item").check();
  await page.getByRole("button", { name: "Bulk edit" }).click();
  let dialog = page.getByRole("dialog", { name: "Bulk edit inventory" });
  await dialog.getByLabel("Location").fill("Same place");
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await dialog.getByRole("button", { name: "Confirm bulk edit" }).click();
  await expect(dialog.getByRole("status")).toContainText("No changes needed");
  await dialog.getByRole("button", { name: "Done" }).click();

  await page.getByLabel("Select Bulk item").check();
  await page.getByRole("button", { name: "Bulk edit" }).click();
  dialog = page.getByRole("dialog", { name: "Bulk edit inventory" });
  await dialog.getByLabel("Location").fill("Changed place");
  await dialog.getByRole("button", { name: "Review changes" }).click();
  mode = "conflict";
  await dialog.getByRole("button", { name: "Confirm bulk edit" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Nothing changed");
  await dialog.getByRole("button", { name: "Back to changes" }).click();
  await expect(dialog.getByLabel("Location")).toHaveValue("Changed place");
});

test("keeps an ambiguous bulk edit unresolved and retries the same command safely", async ({ page }) => {
  await signIn(page);
  const item = inventoryRecord("bulk-ambiguous-item", "Ambiguous bulk item");
  const requestKeys: string[] = [];
  let attempt = 0;
  await page.route("**/api/v1/inventory**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() !== "GET" || requestUrl.pathname !== "/api/v1/inventory") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [item], limit: 25, total: 1 }) });
  });
  await page.route("**/api/v1/inventory/bulk", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    requestKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (attempt++ === 0) {
      // The service may have committed before this response was lost.
      await route.abort("failed");
      return;
    }
    const updated = { ...item, location: "Recovered shelf", condition: "good", tags: ["recovered"], version: 2 };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { updated: [updated], unchanged: [] }, audits: [{ id: "audit-ambiguous" }], correlationId: "e2e-ambiguous", replayed: true }) });
  });

  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByLabel("Select Ambiguous bulk item").check();
  await page.getByRole("button", { name: "Bulk edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Bulk edit inventory" });
  await dialog.getByLabel("Location").fill("Recovered shelf");
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await dialog.getByRole("button", { name: "Confirm bulk edit" }).click();
  const unresolved = dialog.getByRole("alert");
  await expect(unresolved).toContainText("could not confirm whether this bulk edit was applied");
  await expect(unresolved).not.toContainText("Nothing was saved");
  await expect(dialog.getByRole("button", { name: "Retry safely" })).toBeVisible();

  await dialog.getByRole("button", { name: "Retry safely" }).click();
  await expect(dialog.getByRole("status")).toContainText("Saved changes to 1 item");
  expect(requestKeys).toHaveLength(2);
  expect(requestKeys[0]).toBe(requestKeys[1]);
});

test("keeps inventory quantity and status columns usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Inventory", exact: true }).click();

  const table = page.getByRole("table");
  await expect(table.getByLabel("Select all loaded inventory items")).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Quantity", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Status", exact: true })).toBeVisible();
  expect(await table.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
  })).toBe(true);
  const horizontalScroll = await page.evaluate(() => {
    window.scrollTo(500, 0);
    return window.scrollX;
  });
  expect(horizontalScroll).toBe(0);
});

test("keeps project navigation and build progress discoverable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(page.getByRole("button", { name: "Beginner view" })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: /^Projects/ }).click();

  const buildPath = page.getByRole("region", { name: "Build progress" });
  await expect(buildPath).toBeVisible();
  expect(await buildPath.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const tabs = page.getByRole("tablist", { name: "Project workspace" });
  await expect(tabs.getByRole("tab", { name: /^Plan/ })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /^Files/ })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /^Shopping list/ })).toBeVisible();
  expect(await tabs.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
  })).toBe(true);
});

test("requires and persists the managed category and semantic kind for quick inventory add", async ({ page }) => {
  const categoryStatuses: number[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.request().method() === "GET" && url.pathname === "/api/v1/inventory/categories") categoryStatuses.push(response.status());
  });
  await signIn(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();

  const selectionDialog = page.getByRole("dialog", { name: "Add to inventory" });
  await selectionDialog.getByRole("combobox", { name: /Item type/u }).selectOption("tool");
  await expect(selectionDialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await selectionDialog.getByRole("combobox", { name: /Category/u }).selectOption("category-tools");
  expect(categoryStatuses.length).toBeGreaterThan(0);
  expect(categoryStatuses).not.toContain(404);
  await expect(selectionDialog.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  await selectionDialog.getByRole("button", { name: "Continue", exact: true }).click();

  const quickDialog = page.getByRole("dialog", { name: "Add an inventory item" });
  await quickDialog.getByLabel("Name").fill("E2E quick category item");
  const createResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && response.status() === 201 && url.pathname === "/api/v1/inventory";
  });
  await quickDialog.getByRole("button", { name: "Add item", exact: true }).click();
  const response = await createResponse;
  expect(response.request().postDataJSON()).toMatchObject({
    name: "E2E quick category item",
    kind: "tool",
    categoryNodeId: "category-tools",
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".table-item").filter({ hasText: "E2E quick category item" })).toBeVisible();
});

test("shows a truthful non-overlapping close-out capability boundary on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: /^Projects/ }).click();
  await page.getByRole("tab", { name: /^Close out/ }).click();

  const unavailable = page.locator(".reconciliation-load-error");
  await expect(unavailable).toHaveAttribute("role", "alert");
  await expect(unavailable).toContainText("This runtime does not support post-project reconciliation");
  const back = unavailable.getByRole("button", { name: "Back to plan" });
  await expect(back).toBeVisible();
  expect(await unavailable.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const [messageBox, buttonBox] = await Promise.all([
    unavailable.locator("strong").boundingBox(),
    back.boundingBox(),
  ]);
  expect(messageBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.y).toBeGreaterThanOrEqual(messageBox!.y + messageBox!.height);
});

test("guides beginners through one blank physical-count action", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByLabel("Search inventory").fill("Dupont jumper wire assortment");
  await page.getByRole("button", { name: "Dupont jumper wire assortment wire" }).click();

  const drawer = page.getByRole("dialog", { name: "Dupont jumper wire assortment" });
  await expect(drawer.getByLabel("Counted quantity")).toHaveValue("");
  await expect(drawer.getByRole("button", { name: "Confirm physical count" })).toHaveCount(1);
  await expect(drawer.getByLabel("Observed quantity")).toHaveCount(0);
  await expect(drawer.getByText("Provenance", { exact: true })).toHaveCount(0);
});

test("keeps the physical-count field aligned after commissioning delivered stock", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Beginner view" }).click();
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByLabel("Search inventory").fill("Dupont jumper wire assortment");
  await page.getByRole("button", { name: "Dupont jumper wire assortment wire" }).click();

  const drawer = page.getByRole("dialog", { name: "Dupont jumper wire assortment" });
  await drawer.getByLabel("Observed quantity").fill("7");
  await drawer.getByLabel("Source", { exact: true }).fill("E2E bench count");
  await drawer.getByLabel("Observed", { exact: true }).fill("2026-09-01T12:00");
  await drawer.getByRole("button", { name: "Commission stock" }).click();

  await expect(drawer.getByLabel("Counted quantity")).toHaveValue("7");
});

test("creates a project atomically and finalizes a revisioned artifact", async ({ page }) => {
  await signIn(page);
  const uploadBodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/artifacts/uploads") {
      uploadBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  await page.getByRole("button", { name: "New project" }).click();

  const appBackground = page.locator(".app-background");
  await expect(appBackground).toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Close dialog" })).toHaveCount(1);
  await page.getByLabel("Project name").fill("E2E enclosure");
  await page.getByLabel("Project goal").fill("Synthetic end-to-end project used only by the test suite.");
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page.getByRole("heading", { name: "E2E enclosure" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Plan 0" })).toBeVisible();
  await page.getByRole("tab", { name: "Files 0" }).click();
  await page.getByLabel("Choose files to upload").setInputFiles({
    name: "e2e-enclosure.step",
    mimeType: "model/step",
    buffer: Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n")
  });
  await page.getByRole("button", { name: "Add files" }).click();

  await expect(page.getByRole("tab", { name: "Files 1" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /e2e-enclosure\.step/u })).toBeVisible();
  await expect(page.getByRole("cell", { name: "STEP", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "r01", exact: true })).toBeVisible();
  expect(uploadBodies).toHaveLength(1);
  expect(uploadBodies[0]).toHaveProperty("projectRevisionId");
  expect(uploadBodies[0]).not.toHaveProperty("revisionId");
  expect(uploadBodies[0]).not.toHaveProperty("workItemId");
  expect(uploadBodies[0]).not.toHaveProperty("workItemRevisionId");
});

test("offers exact work-item scopes, keeps legacy files in All, and freezes upload targets", async ({ page }) => {
  let projectId = "";
  let projectRevisionId = "";
  const workItemId = "e2e-work-body";
  const workItemRevisionId = "e2e-work-revision-1";
  await page.route("**/api/v1/workspace", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { projects?: Array<Record<string, any>> };
    const project = body.projects?.[0];
    if (!project || !project.currentRevision) {
      await route.fulfill({ response, body: JSON.stringify(body) });
      return;
    }
    projectId = String(project.id);
    projectRevisionId = String(project.currentRevision.id);
    project.workItems = [
      { id: workItemId, projectId, name: "Body", kind: "part", currentRevisionId: workItemRevisionId, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 },
      { id: "e2e-work-unbound", projectId, name: "Unbound notes", kind: "document", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }
    ];
    project.workItemRevisions = [{ id: workItemRevisionId, projectId, workItemId, number: 1, name: "Body baseline", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 }];
    project.artifacts = [
      ...(project.artifacts ?? []),
      { id: "e2e-legacy-artifact", projectId, role: "text", filename: "legacy-scope-note.md", mediaType: "text/markdown", byteSize: 12, sha256: "l".repeat(64), currentCandidate: false, retired: false, createdAt: "2026-08-30T10:00:00.000Z", version: 1 },
      { id: "e2e-work-artifact", projectId, workItemId, workItemRevisionId, role: "step", filename: "body-existing.step", mediaType: "model/step", byteSize: 12, sha256: "w".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-08-30T10:00:00.000Z", version: 1 }
    ];
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await signIn(page);
  await page.getByRole("button", { name: /^Projects/ }).click();
  await page.getByRole("combobox", { name: "Choose project" }).selectOption(projectId);
  await page.getByRole("tab", { name: /Files/ }).click();

  const scope = page.getByLabel("Choose file scope");
  await expect(scope).toHaveValue(`project:${projectRevisionId}`);
  await expect(scope.locator("option")).toContainText(["Project", "Body", "Unbound notes", "All files (read-only)"]);
  await expect(scope.locator("option").filter({ hasText: "Unbound notes" })).toHaveAttribute("disabled", "");
  await expect(page.locator(".file-scope-identity")).toContainText("Project revision");
  await expect(page.locator(".file-scope-identity")).not.toContainText(projectRevisionId);

  await scope.selectOption("all");
  await expect(page.locator(".file-scope-identity")).toContainText("All files · read-only");
  await expect(page.getByRole("cell", { name: /legacy-scope-note\.md/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose a revision to upload" })).toBeDisabled();

  await scope.selectOption(`work-item:${workItemId}:${workItemRevisionId}`);
  await expect(page.locator(".file-scope-identity")).toContainText("Work item revision");
  await expect(page.locator(".file-scope-identity")).not.toContainText(workItemId);
  await expect(page.getByRole("cell", { name: /body-existing\.step/u })).toBeVisible();
  await expect(page.getByRole("cell", { name: /legacy-scope-note\.md/u })).toHaveCount(0);

  await page.getByRole("button", { name: "Beginner view" }).click();
  await expect(page.locator(".file-scope-identity")).toContainText(`Work item · ${workItemId} · ${workItemRevisionId}`);
  await expect(scope.locator("option").filter({ hasText: "Body" })).toContainText(workItemId);

  const beginBodies: Record<string, unknown>[] = [];
  let releaseFirstBegin: (() => void) | undefined;
  await page.route("**/api/v1/artifacts/uploads", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    beginBodies.push(body);
    if (beginBodies.length === 1) await new Promise<void>((resolve) => { releaseFirstBegin = resolve; });
    const sessionId = `e2e-work-upload-${beginBodies.length}`;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: { id: sessionId, artifactId: `${sessionId}-artifact`, expiresAt: "2026-09-02T11:00:00.000Z", maxBytes: 1000, uploadUrl: `/api/v1/artifacts/uploads/${sessionId}`, status: "pending" } }) });
  });
  await page.route("**/api/v1/artifacts/uploads/**", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ receivedBytes: 3 }) });
      return;
    }
    if (route.request().method() === "POST") {
      const sessionId = route.request().url().split("/").at(-2) ?? "e2e-work-upload";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { id: `${sessionId}-artifact`, projectId, workItemId, workItemRevisionId, role: "step", filename: "upload.step", mediaType: "model/step", byteSize: 5, sha256: "b".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-09-02T10:00:00.000Z", version: 1 } }) });
      return;
    }
    await route.continue();
  });

  await page.getByLabel("Choose files to upload").setInputFiles([
    { name: "upload-one.step", mimeType: "model/step", buffer: Buffer.from("one") },
    { name: "upload-two.step", mimeType: "model/step", buffer: Buffer.from("two") }
  ]);
  await expect(scope).toBeDisabled();
  expect(releaseFirstBegin).toBeDefined();
  releaseFirstBegin?.();
  await expect(page.getByText("2 of 2 files uploaded", { exact: true })).toBeVisible();
  expect(beginBodies).toHaveLength(2);
  for (const body of beginBodies) {
    expect(body).toMatchObject({ projectId, workItemId, workItemRevisionId });
    expect(body).not.toHaveProperty("projectRevisionId");
    expect(body).not.toHaveProperty("revisionId");
  }
});

test("archives a project into the explicit Archived view and restores it", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: /^Projects/ }).click();
  await page.getByRole("button", { name: "New project" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create project" });
  await createDialog.getByLabel("Project name").fill("E2E retirement project");
  await createDialog.getByLabel("Project goal").fill("Retained history acceptance flow.");
  await createDialog.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "E2E retirement project" })).toBeVisible();

  const archiveTrigger = page.getByRole("button", { name: "Archive project", exact: true });
  await archiveTrigger.click();
  const confirmation = page.getByRole("alertdialog", { name: "Archive E2E retirement project?" });
  await expect(confirmation).toContainText("hides the project from active lists");
  await expect(confirmation).toContainText("history remain retained");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(archiveTrigger).toBeVisible();

  await archiveTrigger.click();
  await confirmation.getByRole("button", { name: "Archive project", exact: true }).click();
  await expect(page.getByText("Project archived.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Active projects", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Choose project" }).getByRole("option", { name: "E2E retirement project", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /^Archived \(/ }).click();
  await expect(page.getByRole("heading", { name: "E2E retirement project" })).toBeVisible();
  await expect(page.locator(".archive-notice")).toContainText("revisions, files, BOM, stock evidence, and audit history remain retained");

  await page.getByRole("button", { name: "Restore project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E retirement project" })).toBeVisible();
  await expect(page.getByText("Project restored to idea.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Active projects", exact: true })).toHaveClass(/is-active/u);
  await expect(page.getByRole("combobox", { name: "Choose project" }).getByRole("option", { name: "E2E retirement project", exact: true })).toHaveCount(1);
});

test("keeps project creation discoverable from a populated Projects view", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: /^Projects/ }).click();

  const trigger = page.getByRole("button", { name: "New project" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create project" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Project name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("keeps an ambiguous project create truthful and safely retryable", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: /^Projects/ }).click();

  const requestKeys: string[] = [];
  let attempt = 0;
  await page.route("**/api/v1/projects/with-initial-revision", async (route) => {
    requestKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (attempt++ === 0) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create project" });
  await dialog.getByLabel("Project name").fill("Ambiguous project");
  await dialog.getByLabel("Project goal").fill("A project whose response was intentionally lost.");
  await dialog.getByRole("button", { name: "Create project" }).click();

  await expect(dialog.getByRole("alert")).toContainText("BenchLedger could not confirm whether this project was created.");
  await expect(dialog.getByRole("alert")).not.toContainText(/Nothing was saved|was not created/iu);
  await expect(dialog.getByLabel("Project name")).toHaveValue("Ambiguous project");
  await expect(dialog.getByLabel("Project goal")).toHaveValue("A project whose response was intentionally lost.");

  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toHaveCount(0);
  expect(requestKeys).toHaveLength(2);
  expect(requestKeys[0]).toBe(requestKeys[1]);
  await page.unroute("**/api/v1/projects/with-initial-revision");
});

test("keeps modal focus surfaces isolated and restores the workspace on Escape", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "New project" }).click();

  await expect(page.locator(".app-background")).toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Open account settings" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-background")).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Open account settings" })).toBeVisible();
});

test("shows exactly one accessible navigation surface at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);

  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close navigation" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Workbench", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
  await expect(page.locator(".app-main")).toHaveAttribute("inert", "");

  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByRole("button", { name: "Close navigation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: /^Projects/ }).click();
  const projectTrigger = page.getByRole("button", { name: "New project" });
  await expect(projectTrigger).toBeVisible();
  expect(await page.evaluate(() => window.scrollX)).toBe(0);

  await page.getByLabel("Search inventory").fill("ESP32");
  await expect(page.getByRole("heading", { name: "Review inventory." })).toBeVisible();
  const horizontalScroll = await page.evaluate(() => {
    window.scrollTo(500, 0);
    return window.scrollX;
  });
  expect(horizontalScroll).toBe(0);
  await expect(page.getByRole("button", { name: "Open account settings" })).toBeVisible();
});

test("creates, edits, and archives a managed category hierarchy", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("button", { name: "Open account settings" }).click();
  await expect(page.getByRole("heading", { name: "Review workspace settings" })).toBeVisible();

  const manager = page.locator(".category-manager");
  await expect(manager.getByRole("heading", { name: "Manage inventory categories" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await manager.getByRole("button", { name: "New category" }).click();
  const createForm = manager.locator('form[aria-label="Create top-level category"]');
  await expect(createForm.getByLabel("Name")).toBeFocused();
  await createForm.getByLabel("Name").fill("E2E managed category");
  await createForm.getByLabel("Order").fill("100");
  await createForm.getByRole("button", { name: "Add category", exact: true }).click();
  await expect(manager.getByText("E2E managed category", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  let rootGroup = manager.locator(".category-tree-group").filter({ hasText: "E2E managed category" });
  await rootGroup.getByRole("button", { name: "Add subcategory" }).click();
  const childForm = manager.locator('form[aria-label="Create subcategory under E2E managed category"]');
  await childForm.getByLabel("Name").fill("E2E child category");
  await childForm.getByLabel("Order").fill("1");
  await childForm.getByRole("button", { name: "Add subcategory", exact: true }).click();
  await expect(manager.getByText("E2E managed category / E2E child category", { exact: true })).toBeVisible();

  await manager.getByRole("button", { name: "Rename E2E managed category" }).click();
  const editForm = manager.locator('form[aria-label="Edit E2E managed category"]');
  await editForm.getByLabel("Name").fill("E2E renamed category");
  await editForm.getByLabel("Order").fill("101");
  await editForm.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(manager.getByText("E2E renamed category / E2E child category", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  rootGroup = manager.locator(".category-tree-group").filter({ hasText: "E2E renamed category" });
  const archiveParentButton = rootGroup.getByRole("button", { name: "Archive E2E renamed category" });
  await archiveParentButton.click();
  const parentConfirmation = manager.getByRole("alertdialog", { name: "Archive E2E renamed category?" });
  await expect(page.locator(".category-archive-scrim")).toBeVisible();
  expect(await page.locator(".category-archive-scrim").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left === 0 && rect.top === 0 && rect.width >= window.innerWidth && rect.height >= window.innerHeight;
  })).toBe(true);
  await expect(parentConfirmation).toHaveAttribute("aria-modal", "true");
  await expect(parentConfirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  const accountButton = page.getByRole("button", { name: "Open account settings" });
  const accountBox = await accountButton.boundingBox();
  if (accountBox) await page.mouse.click(accountBox.x + accountBox.width / 2, accountBox.y + accountBox.height / 2);
  await expect(parentConfirmation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(parentConfirmation).toHaveCount(0);
  await expect(archiveParentButton).toBeFocused();
  await archiveParentButton.click();
  await parentConfirmation.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(manager.getByRole("alert")).toContainText("Inventory category");
  await parentConfirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(parentConfirmation).toHaveCount(0);

  const childGroup = manager.locator(".category-child-group").filter({ hasText: "E2E renamed category / E2E child category" });
  await childGroup.getByRole("button", { name: "Archive E2E child category" }).click();
  await manager.getByRole("alertdialog", { name: "Archive E2E child category?" }).getByRole("button", { name: "Archive", exact: true }).click();
  await expect(manager.getByText("E2E renamed category / E2E child category", { exact: true })).toHaveCount(0);

  rootGroup = manager.locator(".category-tree-group").filter({ hasText: "E2E renamed category" });
  await rootGroup.getByRole("button", { name: "Archive E2E renamed category" }).click();
  const finalConfirmation = manager.getByRole("alertdialog", { name: "Archive E2E renamed category?" });
  let releaseArchive: (() => void) | undefined;
  await page.route("**/api/v1/inventory/categories/*/archive", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise<void>((resolve) => { releaseArchive = resolve; });
    await route.continue();
  });
  await finalConfirmation.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(finalConfirmation.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await expect(finalConfirmation.getByRole("button", { name: "Archiving…", exact: true })).toBeDisabled();
  releaseArchive?.();
  await expect(manager.getByText("E2E renamed category", { exact: true })).toHaveCount(0);
  await page.unroute("**/api/v1/inventory/categories/*/archive");
});
