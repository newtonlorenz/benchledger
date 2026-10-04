import { clickProjectAction } from "./workspace-controls";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

for (const width of [390, 1440]) {
  test(`Plan retains its requirement search and filter on return at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByLabel("Workspace password").fill("demo-password-please-change");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    const id = `plan-return-${randomUUID()}`, revision = `${id}-r1`;
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === "forge_csrf")!.value;
    const post = async (path: string, data: object) => {
      const result = await page.request.post(`/api/v1${path}`, { headers: { "x-csrf-token": csrf, "idempotency-key": randomUUID() }, data });
      expect(result.status(), await result.text()).toBeLessThan(300);
    };
    await post("/projects/with-initial-revision", { project: { id, name: `Synthetic plan return ${width}`, status: "planned", description: "Plan browsing regression." }, revision: { id: revision, name: "Initial", status: "concept", fabricationRoute: "none" } });
    for (let index = 1; index <= 24; index++) await post(`/project-revisions/${revision}/bom`, { name: `Connector ${index}`, requiredQuantity: 1, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [] });
    await page.goto(`/#/projects/${id}/plan`); await page.reload();
    await expect(page.getByRole("region", { name: "Next project action", exact: true })).toBeVisible();
    const query = page.getByLabel("Search project requirements"), filter = page.getByLabel("Filter project requirements");
    await query.fill("Connector 24"); await filter.selectOption("source");
    await page.getByRole("tab", { name: /^Files/u }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Next project action", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Project task shortcuts", { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: /^Requirements/u }).click();
    await expect(query).toHaveValue("Connector 24"); await expect(filter).toHaveValue("source");
    await page.getByRole("button", { name: "Clear requirement filters", exact: true }).click();
    await expect(query).toHaveValue(""); await expect(filter).toHaveValue("all");
    await expect(page.locator(".bom-row")).toHaveCount(24);
    await query.fill("Connector 24"); await filter.selectOption("source");
    await clickProjectAction(page, "New revision");
    const dialog = page.getByRole("dialog", { name: `New revision for Synthetic plan return ${width}`, exact: true });
    await dialog.getByLabel("Revision name", { exact: true }).fill("Next revision");
    await dialog.getByRole("button", { name: "Create revision", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "No requirements are recorded yet.", exact: true })).toBeVisible();
    await expect(query).toHaveCount(0); await expect(filter).toHaveCount(0);
  });
}
