import { expect, type Page } from "@playwright/test";

/** Use the one navigation surface visible at the current viewport. */
export function workspaceNavigation(page: Page) {
  return page.locator('nav[aria-label="Workspace"]:visible, nav[aria-label="Workspace on phone"]:visible');
}

export async function navigateWorkspace(page: Page, name: string) {
  if (name === "Settings") return page.getByRole("button", { name: "Open workspace settings", exact: true }).click();
  await workspaceNavigation(page).getByRole("button", { name, exact: true }).click();
}

export async function openProject(page: Page, name: string, section = "Overview") {
  if (!await page.getByRole("heading", { name: "Projects", exact: true }).isVisible()) await navigateWorkspace(page, "Projects");
  await page.getByRole("textbox", { name: "Find a project", exact: true }).fill(name);
  await page.getByRole("button", { name: `Open project ${name}`, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  if (section !== "Overview") await openProjectSection(page, section);
}

/** Detailed work remains inside one of the four primary project sections. */
export async function openProjectSection(page: Page, name: string) {
  const primary = name === "Requirements" ? "Parts" : name === "Build steps" ? "Build" : name;
  if (primary === "Shopping list" || primary === "To source") {
    await page.getByRole("tab", { name: "Parts", exact: true }).click();
    if (await page.getByRole("alertdialog").isVisible()) return;
    await page.getByRole("button", { name: "Shopping list", exact: true }).click();
  } else if (["Assembly", "PCB", "Update used stock", "Record used stock"].includes(primary)) {
    await page.getByRole("tab", { name: "Build", exact: true }).click();
    if (await page.getByRole("alertdialog").isVisible()) return;
    await page.getByLabel("Build views", { exact: true }).getByRole("button", { name: primary === "Update used stock" ? "Record used stock" : primary, exact: true }).click();
  } else {
    await page.getByRole("tab", { name: primary, exact: true }).click();
    const local = primary === "Build" ? page.getByLabel("Build views", { exact: true }).getByRole("button", { name: "Build plan", exact: true }) : undefined;
    if (local && await local.isVisible() && await local.getAttribute("aria-pressed") !== "true") await local.click();
  }
}

/** Discover secondary actions in the project menu or their current section. */
export async function showProjectAction(page: Page, name: string) {
  if (name === "New project" && !await page.getByRole("heading", { name: "Projects", exact: true }).isVisible()) await navigateWorkspace(page, "Projects");
  if (name === "Import requirements from CSV") await openProjectSection(page, "Parts");
  const action = page.getByRole("button", { name: name === "New revision" ? "Create revision" : name === "Import requirements from CSV" ? "Import parts list" : name, exact: true });
  const menu = page.getByRole("button", { name: "Project actions", exact: true });
  await expect.poll(async () => await action.isVisible() || await menu.isVisible()).toBe(true);
  if (!await action.isVisible()) await menu.click();
  await expect(action).toBeVisible();
  return action;
}

export async function clickProjectAction(page: Page, name: string) {
  await (await showProjectAction(page, name)).click();
}

/** Add-part stock matching starts collapsed; edit forms expose it directly. */
export async function openPartStockMatch(page: Page) {
  const disclosure = page.getByRole("dialog").getByRole("button", { name: /^(Match from your stock|Matched stock)$/u });
  if (await disclosure.isVisible() && await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
}

export async function openBuildTool(page: Page, tool: "print" | "tasks" | "stock") {
  const name = tool === "print" ? /^Parts and print plates(?:, optional)?$/u : tool === "tasks" ? "Task groups and progress" : "Set aside stock for this build";
  const trigger = page.getByRole("button", { name, exact: true });
  await expect(trigger).toBeVisible();
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
}

export async function openPartFilters(page: Page) {
  const trigger = page.getByRole("button", { name: "More filters", exact: true });
  await expect(trigger).toBeVisible();
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
}

export async function openFileDetails(page: Page, name: string) {
  await page.getByRole("button", { name: `Details for ${name}`, exact: true }).click();
  const details = page.getByRole("complementary", { name: `File details: ${name}`, exact: true });
  await expect(details).toBeVisible();
  return details;
}

export async function openProjectDetails(page: Page) {
  await openProjectSection(page, "Build");
  const setup = page.getByRole("button", { name: "Build approach and setup", exact: true });
  if (await setup.getAttribute("aria-expanded") !== "true") await setup.click();
  await expect(page.locator(".build-approach-card")).toBeVisible();
}

export async function openInventorySearch(page: Page) {
  await page.getByRole("button", { name: "Open workspace commands", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Workspace commands", exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth; })).toBe(true);
  await dialog.getByRole("option", { name: /^Inventory Open inventory/u }).click();
  await expect(page.getByRole("textbox", { name: "Search inventory", exact: true })).toBeFocused();
}
