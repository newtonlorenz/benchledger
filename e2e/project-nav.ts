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

/** The synthetic demo reference project seeded by the demo runtime. */
export const REFERENCE_PROJECT_NAME = "Synthetic H2D desk lamp";

/**
 * Open one named project from the index. Demo mode lists projects like
 * production (most recently updated first), so specs that need the seeded
 * reference project open it by name instead of relying on list order.
 */
export async function openProjectByName(page: Page, name: string = REFERENCE_PROJECT_NAME): Promise<void> {
  await openProjectIndex(page);
  await page.getByRole("button", { name: `Open project ${name}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}
