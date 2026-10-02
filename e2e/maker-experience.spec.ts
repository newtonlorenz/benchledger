import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`next action stays visible without the inspector at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByLabel("Workspace password").fill("demo-password-please-change");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Open project Synthetic H2D desk lamp", exact: true }).click();
    const guidance = page.getByRole("region", { name: "Next project action" });
    await expect(guidance).toBeVisible();
    expect((await guidance.boundingBox())!.y).toBeLessThan(400);
    await page.getByRole("button", { name: "Project details", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Project details" })).toBeHidden();
    await expect(guidance.getByRole("button", { name: "Set build approach" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Assembly", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Design tools", exact: true }).click();
    await page.getByRole("tab", { name: "Assembly", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("tab", { name: "Assembly", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Design tools", exact: true }).click();
    await expect(page.getByRole("tab", { name: /^Files/u })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Assembly", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
