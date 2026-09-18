import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
}

test("desktop keeps navigation stable, opens a document and gives its work area more room", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 650 });
  await login(page);
  const navigator = page.getByRole("region", { name: "Project navigator" });
  await navigator.getByLabel("Filter project navigator").fill("synthetic h2d");
  await navigator.getByRole("button", { name: "Switch to project Synthetic H2D desk lamp", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Synthetic H2D desk lamp", exact: true })).toBeVisible();
  const workArea = page.locator(".dossier-workspace");
  const before = await workArea.evaluate((element) => element.clientWidth);
  const details = page.getByRole("button", { name: "Project details", exact: true });
  await details.click();
  await expect(page.getByRole("complementary", { name: "Project details" })).toBeHidden();
  await expect(details).toHaveAttribute("aria-expanded", "false");
  expect(await workArea.evaluate((element) => element.clientWidth)).toBeGreaterThan(before + 200);
  const barTop = await page.locator(".topbar").evaluate((element) => element.getBoundingClientRect().top);
  await page.locator("main").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await page.locator("main").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator(".topbar").evaluate((element) => element.getBoundingClientRect().top)).toBe(barTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await details.click();
  await expect(page.getByRole("complementary", { name: "Project details" })).toBeVisible();
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inventory", exact: true })).toBeVisible();
  expect(await page.locator("main").evaluate((element) => element.scrollTop)).toBe(0);
});

test("project navigator protects staged files until discard is confirmed", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Switch to project Synthetic H2D desk lamp", exact: true }).click();
  await page.getByRole("tab", { name: /^Files/u }).click();
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "desktop-draft.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic draft") });
  await page.getByRole("button", { name: "Archived (0)", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "Leave without saving?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add 1 file", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Active projects", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Archived (0)", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes and leave", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No archived projects", exact: true })).toBeVisible();
});

test("mobile project browsing closes the drawer and restores the working area", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const navigation = page.getByRole("dialog", { name: "Primary navigation", exact: true });
  await navigation.getByRole("button", { name: "Switch to project Synthetic H2D desk lamp", exact: true }).click();
  await expect(navigation).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Synthetic H2D desk lamp", exact: true })).toBeVisible();
  await expect(page.locator(".app-main")).not.toHaveAttribute("inert", "");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Switch to project Synthetic H2D desk lamp", exact: true }).click();
  await expect(page.locator("main")).toBeFocused();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Archived (0)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No archived projects", exact: true })).toBeVisible();
});
