import { expect, type Page } from "@playwright/test";

/**
 * The Projects navigation opens the project index (#/projects). Specs that
 * worked in "the current project" open the index and choose Continue, which
 * returns to the project last open in this session (the first project after
 * sign-in), the destination the navigation used to open directly.
 */
export async function openCurrentProject(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Projects/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Projects", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Continue: /u }).click();
}

/** Open the index from the navigation and create a project from its header. */
export async function openProjectIndex(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Projects/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Projects", exact: true })).toBeVisible();
}
