import { clickProjectAction, openProjectSection } from "./workspace-controls";
import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`maker drafts and quote focus recover at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByLabel("Workspace password").fill("demo-password-please-change");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await clickProjectAction(page, "New project");
    await page.getByLabel("Project name", { exact: true }).fill("Synthetic retained draft");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(page.getByLabel("Project name", { exact: true })).toHaveValue("Synthetic retained draft");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Discard changes and leave", exact: true }).click();
    await page.getByRole("button", { name: "Open project Synthetic H2D desk lamp", exact: true }).click();
    await openProjectSection(page, "Parts");
    await page.getByRole("button", { name: "Add part", exact: true }).click();
    await page.getByLabel("Part name", { exact: true }).fill("Synthetic retained requirement");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(page.getByLabel("Part name", { exact: true })).toHaveValue("Synthetic retained requirement");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Discard changes and leave", exact: true }).click();
    await openProjectSection(page, "To source");
    const quote = page.getByRole("button", { name: "Record quote for M3 mounting screws", exact: true });
    await quote.click();
    await expect(page.getByLabel("Supplier", { exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Cancel quote", exact: true }).click();
    await expect(quote).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`next action stays visible without the inspector at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByLabel("Workspace password").fill("demo-password-please-change");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Open project Synthetic H2D desk lamp", exact: true }).click();
    const guidance = page.getByRole("region", { name: "Next project action" });
    await expect(guidance).toBeVisible();
    await expect(guidance).toBeInViewport();
    await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("complementary", { name: "Project details" })).toHaveCount(0);
    await expect(guidance.getByRole("button", { name: "Review this part" })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Project workspace" }).getByRole("tab")).toHaveText(["Overview", "Parts", "Files", "Build"]);
    await openProjectSection(page, "Assembly");
    await page.reload();
    await expect(page.getByRole("tab", { name: "Build", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Build views").getByRole("button", { name: "Assembly", exact: true })).toHaveAttribute("aria-pressed", "true");
    await openProjectSection(page, "Files");
    await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Build views")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Assembly", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
