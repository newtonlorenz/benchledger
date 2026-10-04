import { workspaceNavigation, openProjectSection } from "./workspace-controls";
import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`an empty project register gives a clear first project path at ${width}px`, async ({ page }, info) => {
    const name = `Synthetic first-use bracket ${width}`;
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.route("**/api/v1/workspace", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { inventory: unknown[]; projects: Array<{ name: string }>; offers: unknown[] };
      body.inventory = [];
      body.projects = [];
      body.offers = [];
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/v1/project-library?**", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { data: Array<{ name: string }>; nextCursor?: string };
      body.data = body.data.filter((project) => project.name === name);
      delete body.nextCursor;
      await route.fulfill({ response, json: body });
    });
    await signIn(page);

    const onboarding = page.getByRole("region", { name: "Getting started", exact: true });
    await expect(onboarding.getByRole("button", { name: "Start a project", exact: true })).toBeVisible();
    await expect(onboarding.getByRole("button", { name: "Add inventory", exact: true })).toBeVisible();
    await expect(page.getByLabel("Find a project", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "All next actions", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Workspace tools", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("region", { name: "Project navigator", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await onboarding.getByRole("button", { name: "Start a project", exact: true }).click();
    const create = page.getByRole("dialog", { name: "Create project", exact: true });
    await expect(create.getByLabel("Project name", { exact: true })).toBeFocused();
    await expect(create.getByRole("button", { name: "Start from a template", exact: true })).toBeVisible();
    await expect(create.getByRole("button", { name: "Import a parts list (CSV)", exact: true })).toBeVisible();
    await create.getByLabel("Project name", { exact: true }).fill(name);
    await create.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/overview$/u);
    await expect(page.getByRole("region", { name: "Next project action" }).getByRole("button", { name: "Add first part", exact: true })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Project workspace" }).getByRole("tab")).toHaveText(["Overview", "Parts", "Files", "Build"]);
    await openProjectSection(page, "Parts");
    await expect(page.locator(".bom-section").getByRole("button", { name: "Add first part", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Removed requirements", exact: true })).toHaveCount(0);
    await expect(page.locator(".bom-section").getByRole("button", { name: "Add first part", exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath("empty-parts.png"), fullPage: false, animations: "disabled" });

    const navigation = workspaceNavigation(page);
    await expect(navigation.getByRole("button", { name: /^Projects(?: \d+)?$/u })).toHaveCount(1);
    await expect(navigation.getByRole("button", { name: "Workbench", exact: true })).toHaveCount(0);
    await navigation.getByRole("button", { name: /^Projects(?: \d+)?$/u }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe("#/");
    await expect(page.getByRole("main")).toBeFocused();
    await expect(page.getByRole("tablist", { name: "Project workspace" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Open project ${name}`, exact: true })).toBeVisible();
    await expect(onboarding).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
