import { expect, test, type Page } from "@playwright/test";

const demoPassword = "demo-password-please-change";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill(demoPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "What are you making?" })).toBeVisible();
}

async function openInventory(page: Page): Promise<void> {
  if (await page.getByRole("button", { name: "Open navigation" }).count()) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("dialog", { name: "Primary navigation" }).getByRole("button", { name: "Inventory", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Inventory", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "What do you have?" })).toBeVisible();
}

function inventoryRecord(id: string, name: string) {
  return {
    id,
    name,
    kind: "tool",
    quantity: 1,
    availableQuantity: 1,
    unit: "each",
    tags: [],
    links: [],
    evidence: { state: "physically_counted" },
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    version: 1,
  };
}

test("launches inventory before sequential typing from the topbar", async ({ page }) => {
  await signIn(page);
  const topbarSearch = page.getByRole("button", { name: "Search inventory" });
  await expect(topbarSearch).toBeVisible();
  await topbarSearch.focus();
  await expect(topbarSearch).toBeFocused();
  await topbarSearch.click();
  const inventorySearch = page.getByRole("textbox", { name: "Search inventory" });
  await expect(inventorySearch).toBeFocused();

  await inventorySearch.pressSequentially("ESP32");
  await expect(inventorySearch).toHaveValue("ESP32");
  await expect(inventorySearch).toBeFocused();
  await expect(page).toHaveURL(/q=ESP32/u);
  await expect(page.getByRole("button", { name: "Open ESP32 development board" })).toBeVisible();
});

test("Cmd/Ctrl+K launches inventory and focuses its single search field", async ({ page }) => {
  await signIn(page);
  const topbarSearch = page.getByRole("button", { name: "Search inventory" });
  await expect(topbarSearch).toBeVisible();
  await topbarSearch.evaluate((element) => {
    element.addEventListener("focus", () => { document.body.dataset.topbarSearchFocused = "true"; }, { once: true });
  });
  await page.keyboard.press("Control+K");
  await expect(page.locator("body")).toHaveAttribute("data-topbar-search-focused", "true");
  const inventorySearch = page.getByRole("textbox", { name: "Search inventory" });
  await expect(inventorySearch).toBeFocused();
});

test("keeps one local inventory search and lets the shared shortcut focus it", async ({ page }) => {
  await signIn(page);
  await openInventory(page);

  const search = page.getByRole("textbox", { name: "Search inventory" });
  await expect(search).toBeVisible();
  await expect(page.locator(".global-search")).toHaveCount(0);
  await page.keyboard.press("Control+K");
  await expect(search).toBeFocused();

  await search.fill("ESP32");
  await expect(page).toHaveURL(/q=ESP32/u);
});

test("keeps the newest result and URL after rapid inventory queries", async ({ page }) => {
  await signIn(page);
  const slow = inventoryRecord("slow-result", "Slow result");
  const fast = inventoryRecord("fast-result", "Fast result");
  await page.route("**/api/v1/inventory**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() !== "GET" || requestUrl.pathname !== "/api/v1/inventory") return route.continue();
    const query = requestUrl.searchParams.get("q") ?? "";
    if (query === "slow") await new Promise((resolve) => setTimeout(resolve, 450));
    const data = query === "slow" ? [slow] : query === "fast" ? [fast] : [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data, limit: 25, total: data.length }),
    });
  });

  await openInventory(page);
  const search = page.getByRole("textbox", { name: "Search inventory" });
  await search.fill("slow");
  await page.waitForTimeout(320);
  await search.fill("fast");

  await expect(page.getByRole("button", { name: "Open Fast result" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Slow result" })).toHaveCount(0);
  await expect(page).toHaveURL(/q=fast/u);
});

test("only reports a cleared selection when a selection existed before filtering", async ({ page }) => {
  await signIn(page);
  const rows = [inventoryRecord("tool-00", "Tool 00"), inventoryRecord("tool-01", "Tool 01")];
  await page.route("**/api/v1/inventory**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() !== "GET" || requestUrl.pathname !== "/api/v1/inventory") return route.continue();
    const query = requestUrl.searchParams.get("q")?.toLocaleLowerCase() ?? "";
    const data = query ? rows.filter((row) => row.name.toLocaleLowerCase().includes(query)) : rows;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, limit: 25, total: data.length }) });
  });

  await openInventory(page);
  const notice = page.locator(".inventory-selection-notice");
  const search = page.getByRole("textbox", { name: "Search inventory" });
  await search.fill("Tool 00");
  await expect(page.getByRole("button", { name: "Open Tool 00" })).toBeVisible();
  await expect(notice).toHaveCount(0);

  await page.getByLabel("Select Tool 00").check();
  await search.fill("Tool 01");
  await expect(page.getByRole("button", { name: "Open Tool 01" })).toBeVisible();
  await expect(notice).toContainText("Selection cleared");
});

test("keeps inventory and shopping actions usable at 390px without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const launcher = page.getByRole("button", { name: "Search inventory" });
  await expect(launcher).toBeVisible();
  const restingLauncherBox = await launcher.boundingBox();
  expect(restingLauncherBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(restingLauncherBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await launcher.focus();
  const focusedLauncherBox = await launcher.boundingBox();
  expect(focusedLauncherBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(focusedLauncherBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await openInventory(page);

  await expect(page.locator(".global-search")).toHaveCount(0);
  const inventoryControls = page.locator(".inventory-toolbar .field-search, .inventory-toolbar .category-control");
  for (const control of await inventoryControls.all()) {
    const box = await control.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await page.getByLabel("Select all loaded inventory items").check();
  const selectionButton = page.locator(".inventory-selection-bar .button");
  await expect(selectionButton).toBeVisible();
  const selectionBox = await selectionButton.boundingBox();
  expect(selectionBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(selectionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Primary navigation" }).getByRole("button", { name: /^Projects/ }).click();
  await page.getByRole("tab", { name: /^Shopping list/ }).click();
  await expect(page.locator(".shopping-section")).toBeVisible();
  const shoppingControls = page.locator(".shopping-actions .button, .shopping-section .offer-row, .shopping-section .expert-detail > summary");
  for (const control of await shoppingControls.all()) {
    const box = await control.boundingBox();
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
