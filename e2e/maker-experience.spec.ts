import { clickProjectAction } from "./workspace-controls";
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
    await page.getByRole("button", { name: "Add a requirement", exact: true }).click();
    await page.getByLabel("What do you need?", { exact: true }).fill("Synthetic retained requirement");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(page.getByLabel("What do you need?", { exact: true })).toHaveValue("Synthetic retained requirement");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Discard changes and leave", exact: true }).click();
    await page.getByRole("tab", { name: /^Shopping list/u }).click();
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
    expect((await guidance.boundingBox())!.y).toBeLessThan(400);
    const details = page.getByRole("button", { name: "Project details", exact: true });
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("complementary", { name: "Project details" })).toBeHidden();
    await details.click();
    await expect(page.getByRole("complementary", { name: "Project details" })).toBeVisible();
    await details.click();
    await expect(page.getByRole("complementary", { name: "Project details" })).toBeHidden();
    await expect(guidance.getByRole("button", { name: "Review stock checks" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Assembly", exact: true })).toHaveCount(0);
    await clickProjectAction(page, "Design tools");
    await page.getByRole("tab", { name: "Assembly", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("tab", { name: "Assembly", exact: true })).toHaveAttribute("aria-selected", "true");
    await clickProjectAction(page, "Design tools");
    await expect(page.getByRole("tab", { name: /^Files/u })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Assembly", exact: true })).toHaveCount(0);
    if (width === 390) {
      // The demo does not advertise stock reconciliation. Moving actions into
      // Project tools must preserve that capability boundary.
      await expect(page.getByRole("tab", { name: /^Update used stock/u })).toHaveCount(0);
      await page.getByRole("button", { name: "Project tools", exact: true }).click();
      await expect(page.getByRole("button", { name: "Update used stock", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
