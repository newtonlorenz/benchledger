import { expect, test, type Page } from "@playwright/test";

const demoPassword = "demo-password-please-change";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill(demoPassword);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.getByRole("heading", { name: "Make the next build clear." })).toBeVisible();
}

test("filters evidence-aware inventory without exposing hidden category controls", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Know what is on the bench." })).toBeVisible();
  await expect(page.getByLabel("Filter inventory by category")).toHaveCount(1);
  await page.getByLabel("Search inventory").fill("ESP32");
  await expect(page.getByRole("button", { name: "ESP32 development board electronic" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Bambu Lab H2D printer" })).toHaveCount(0);
});

test("creates a project atomically and finalizes a revisioned artifact", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "New project" }).click();

  const appBackground = page.locator(".app-background");
  await expect(appBackground).toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Close dialog" })).toHaveCount(1);
  await page.getByLabel("Project name").fill("E2E enclosure");
  await page.getByLabel("What are you making?").fill("Synthetic end-to-end project used only by the test suite.");
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
});
