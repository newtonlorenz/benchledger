import { expect, type Page } from "@playwright/test";

/** Discover a secondary project action through the visible tools control. */
export async function showProjectAction(page: Page, name: string) {
  const action = page.getByRole("button", { name, exact: true });
  const tools = page.getByRole("button", { name: "Project tools", exact: true });
  await expect.poll(async () => await action.isVisible() || await tools.isVisible()).toBe(true);
  if (!await action.isVisible()) {
    await expect(tools).toBeVisible();
    if (await tools.getAttribute("aria-expanded") !== "true") await tools.click();
  }
  await expect(action).toBeVisible();
  return action;
}

export async function clickProjectAction(page: Page, name: string) {
  await (await showProjectAction(page, name)).click();
}

export async function openProjectDetails(page: Page) {
  const control = page.getByRole("button", { name: "Project details", exact: true });
  await expect(control).toBeVisible();
  if (await control.getAttribute("aria-expanded") !== "true") await control.click();
  await expect(page.getByRole("complementary", { name: "Project details", exact: true })).toBeVisible();
}

export async function openInventorySearch(page: Page) {
  await page.getByRole("button", { name: "Open workspace commands", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Workspace commands", exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth; })).toBe(true);
  await dialog.getByRole("option", { name: /^Inventory Open inventory/u }).click();
  await expect(page.getByRole("textbox", { name: "Search inventory", exact: true })).toBeFocused();
}
