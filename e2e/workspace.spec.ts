import { expect, test, type Page } from "@playwright/test";

const demoPassword = "demo-password-please-change";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill(demoPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Review build status." })).toBeVisible();
}

test("filters, edits, and physically counts evidence-aware inventory", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Review inventory." })).toBeVisible();
  await expect(page.locator(".inventory-summary")).toHaveCount(0);
  const headers = page.getByRole("table").getByRole("columnheader");
  await expect(headers).toHaveCount(6);
  await expect(headers.nth(0)).toHaveText("Item");
  await expect(headers.nth(1)).toHaveText("Category");
  await expect(headers.nth(2)).toHaveText("Quantity");
  await expect(headers.nth(3)).toHaveText("Status");
  await expect(headers.nth(4)).toHaveText("Location");
  await expect(headers.nth(5)).toHaveText("Open");
  await expect(page.getByRole("columnheader", { name: "Evidence source", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Filter inventory by category")).toHaveCount(1);
  await page.getByLabel("Filter inventory by kind").selectOption("electronic");
  await page.getByLabel("Filter inventory by evidence").selectOption("counted");
  await page.getByLabel("Filter inventory by availability").selectOption("available");
  await page.getByLabel("Search inventory").fill("ESP32");
  const espRow = page.getByRole("row").filter({ has: page.getByRole("button", { name: "ESP32 development board electronic" }) });
  await expect(espRow).toBeVisible();
  await expect(espRow).toContainText("Ready to use");
  await expect(espRow).not.toContainText("synthetic-demo");
  await expect(page.getByRole("button", { name: "Bambu Lab H2D printer" })).toHaveCount(0);

  await page.getByRole("button", { name: "ESP32 development board electronic" }).click();
  const drawer = page.getByRole("dialog", { name: "ESP32 development board" });
  await expect(drawer.getByText("Provenance", { exact: true })).toBeVisible();
  await expect(drawer).toContainText("Physically counted");
  await expect(drawer).toContainText("Source");
  await expect(drawer).toContainText("synthetic-demo");

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

  await drawer.getByLabel("Physical count").fill("3");
  await drawer.getByRole("button", { name: "Save physical count" }).click();
  await expect(drawer.getByRole("status")).toContainText("Saved 3 pieces as the verified on-hand quantity.");

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

test("keeps inventory quantity and status columns usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Inventory", exact: true }).click();

  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Quantity", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Status", exact: true })).toBeVisible();
  const horizontalScroll = await page.evaluate(() => {
    window.scrollTo(500, 0);
    return window.scrollX;
  });
  expect(horizontalScroll).toBe(0);
});

test("requires and persists the managed category and semantic kind for quick inventory add", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();

  const selectionDialog = page.getByRole("dialog", { name: "Add to inventory" });
  await selectionDialog.getByRole("combobox", { name: /Item type/u }).selectOption("tool");
  await expect(selectionDialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await selectionDialog.getByRole("combobox", { name: /Category/u }).selectOption("category-tools");
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

test("keeps the physical-count field aligned after commissioning delivered stock", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByLabel("Search inventory").fill("Dupont jumper wire assortment");
  await page.getByRole("button", { name: "Dupont jumper wire assortment wire" }).click();

  const drawer = page.getByRole("dialog", { name: "Dupont jumper wire assortment" });
  await drawer.getByLabel("Observed quantity").fill("7");
  await drawer.getByLabel("Source", { exact: true }).fill("E2E bench count");
  await drawer.getByLabel("Observed", { exact: true }).fill("2026-09-01T12:00");
  await drawer.getByRole("button", { name: "Commission stock" }).click();

  await expect(drawer.getByLabel("Physical count")).toHaveValue("7");
});

test("creates a project atomically and finalizes a revisioned artifact", async ({ page }) => {
  await signIn(page);
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
