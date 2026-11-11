import { navigateWorkspace, openProject, openProjectSection, workspaceNavigation } from "./workspace-controls";
import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
}

test("desktop navigation stays stable while project sections use the full work area", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 650 });
  await login(page);
  await openProject(page, "Synthetic H2D desk lamp");
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  const workArea = page.locator(".project-workspace");
  const before = await workArea.evaluate(element => element.clientWidth);
  await expect(page.getByRole("complementary", { name: "Project details" })).toHaveCount(0);
  const barTop = await page.locator(".workspace-header").evaluate(element => element.getBoundingClientRect().top);
  await page.locator("main").evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await page.locator("main").evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator(".workspace-header").evaluate(element => element.getBoundingClientRect().top)).toBe(barTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.route(/\/assembly-ui-[^/]+\.js(?:\?.*)?$/, route => route.abort("failed"));
  await page.route(/\/pcb-ui-[^/]+\.js(?:\?.*)?$/, route => route.abort("failed"));
  for (const name of ["Assembly", "PCB"]) {
    await openProjectSection(page, name);
    await expect(page.getByRole("tab", { name: "Build", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("complementary", { name: "Project details" })).toHaveCount(0);
    expect(await workArea.evaluate(element => element.clientWidth)).toBe(before);
  }
  await openProjectSection(page, "Parts");
  await expect(page.locator(".bom-section")).toBeVisible();
  await navigateWorkspace(page, "Inventory");
  await expect(page.getByRole("heading", { name: "Inventory", exact: true })).toBeVisible();
  expect(await page.locator("main").evaluate(element => element.scrollTop)).toBe(0);
});

test("project navigation protects staged files until discard is confirmed", async ({ page }) => {
  await login(page);
  await openProject(page, "Synthetic H2D desk lamp", "Files");
  await page.getByLabel("Choose files to upload").setInputFiles({ name: "desktop-draft.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic draft") });
  await navigateWorkspace(page, "Projects");
  await expect(page.getByRole("alertdialog", { name: "Leave without saving?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add 1 file", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  await navigateWorkspace(page, "Projects");
  await page.getByRole("button", { name: "Discard changes and leave", exact: true }).click();
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(page.getByText("No archived projects", { exact: true })).toBeVisible();
});

test("phone project browsing preserves the working area without a navigation overlay", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(workspaceNavigation(page)).toHaveAttribute("aria-label", "Workspace on phone");
  await openProject(page, "Synthetic H2D desk lamp");
  await expect(page.getByRole("dialog", { name: "Primary navigation" })).toHaveCount(0);
  await expect(page.locator(".app-main")).not.toHaveAttribute("inert", "");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await navigateWorkspace(page, "Projects");
  await openProject(page, "Synthetic H2D desk lamp");
  await expect(page.locator("main")).toBeFocused();
  await navigateWorkspace(page, "Projects");
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(page.getByText("No archived projects", { exact: true })).toBeVisible();
});

for (const width of [1280, 820, 390]) {
  test(`inventory controls preserve a usable work area at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await navigateWorkspace(page, "Inventory");
    await expect(page.locator(".inventory-table .table-item").first()).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Inventory inspector" })).toHaveCount(0);
    const assertFits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await assertFits();
    await expect(workspaceNavigation(page)).toBeVisible();
    await page.getByRole("button", { name: "View options", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Sort inventory", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Saved inventory view", exact: true })).toBeVisible();
    await assertFits();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "View options", exact: true })).toBeFocused();
    await page.locator(".inventory-table .table-item").first().click();
    if (width <= 800) {
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("button", { name: "Close item details", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Close item details", exact: true }).click();
    } else {
      await expect(page.getByRole("complementary", { name: "Inventory inspector" })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await assertFits();
  });
}
