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
  await expect(page.getByLabel("Filter inventory by category")).toHaveCount(1);
  await page.getByLabel("Filter inventory by kind").selectOption("electronic");
  await page.getByLabel("Filter inventory by evidence").selectOption("counted");
  await page.getByLabel("Filter inventory by availability").selectOption("available");
  await page.getByLabel("Search inventory").fill("ESP32");
  await expect(page.getByRole("button", { name: "ESP32 development board electronic" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Bambu Lab H2D printer" })).toHaveCount(0);

  await page.getByRole("button", { name: "ESP32 development board electronic" }).click();
  const drawer = page.getByRole("dialog", { name: "ESP32 development board" });
  await expect(drawer.getByText("Provenance", { exact: true })).toBeVisible();
  await expect(drawer).toContainText("synthetic-demo");

  await drawer.getByRole("button", { name: "Edit item" }).click();
  await drawer.getByLabel("Name").fill("Temporary name");
  await drawer.getByRole("button", { name: "Cancel" }).click();
  await expect(drawer.getByRole("heading", { name: "ESP32 development board" })).toBeVisible();

  await drawer.getByRole("button", { name: "Edit item" }).click();
  await drawer.getByLabel("Description").fill("Controller board for test fixtures.");
  await drawer.getByLabel("Location").fill("Electronics drawer 2");
  await drawer.getByRole("button", { name: "Save changes" }).click();
  await expect(drawer).toContainText("Controller board for test fixtures.");
  await expect(drawer).toContainText("Electronics drawer 2");

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

  await page.getByLabel("Search inventory").fill("ESP32");
  await expect(page.getByRole("heading", { name: "Review inventory." })).toBeVisible();
  const horizontalScroll = await page.evaluate(() => {
    window.scrollTo(500, 0);
    return window.scrollX;
  });
  expect(horizontalScroll).toBe(0);
  await expect(page.getByRole("button", { name: "Open account settings" })).toBeVisible();
});
