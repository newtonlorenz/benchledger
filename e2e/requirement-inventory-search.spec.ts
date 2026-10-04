import { clickProjectAction, openProjectSection } from "./workspace-controls";
import { expect, test } from "@playwright/test";

test("requirement editing searches beyond the 200-item snapshot and restores that choice after reload", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "forge_csrf")!.value;
  const created = await page.request.post("/api/v1/inventory", { headers: { "X-CSRF-Token": csrf }, data: { name: "Synthetic beyond-page connector", kind: "electronic", quantity: 4, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } } });
  expect(created.status()).toBe(201);
  const result = await created.json();
  const itemId = (result.data ?? result).id as string;
  expect(itemId).toBeTruthy();
  // Model the bounded 200-record workspace page. The target exists in the real
  // API, but cannot be found among these loaded suggestions on either visit.
  await page.route("**/api/v1/workspace", async (route) => {
    const response = await route.fetch(); const body = await response.json();
    const template = body.inventory.find((entry: { id: string; kind: string }) => entry.id !== itemId && entry.kind !== "printer");
    body.inventory = Array.from({ length: 200 }, (_, index) => ({ ...template, id: `synthetic-loaded-${index}`, name: `Synthetic loaded fixture ${index}` }));
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await clickProjectAction(page, "New project");
  await page.getByLabel("Project name", { exact: true }).fill("Synthetic remote stock journey");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await openProjectSection(page, "Parts");
  await page.locator(".bom-section").getByRole("button", { name: "Add first part", exact: true }).click();
  await page.getByLabel("Part name", { exact: true }).fill("Connector for sensor");
  await page.getByRole("button", { name: "Add part", exact: true }).click();
  await page.getByRole("button", { name: "Edit requirement Connector for sensor", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Part details", exact: true });
  await edit.getByRole("button", { name: "Find a different owned item", exact: true }).click();
  const searched = page.waitForRequest((request) => request.url().includes("/api/v1/inventory?") && new URL(request.url()).searchParams.get("q") === "Synthetic beyond-page connector");
  await edit.getByLabel("Search matching inventory").fill("Synthetic beyond-page connector");
  expect(new URL((await searched).url()).searchParams.get("limit")).toBe("25");
  await edit.getByRole("button", { name: "Choose owned item Synthetic beyond-page connector", exact: true }).click();
  await edit.getByRole("button", { name: "Save requirement", exact: true }).click();
  const row = page.locator(".bom-row");
  const openStockDetails = async () => {
    const disclosure = row.getByRole("button", { name: "Stock details", exact: true });
    if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  };
  await openStockDetails();
  await expect(row.getByRole("button", { name: "Synthetic beyond-page connector", exact: true })).toBeVisible();
  let failRead = true;
  await page.route(`**/api/v1/inventory/${itemId}`, async (route) => {
    if (failRead) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Synthetic reference lookup unavailable" } }) });
    else await route.continue();
  });
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "referenced inventory item" })).toBeVisible();
  await openStockDetails();
  await expect(row.getByText("Referenced stock details unavailable", { exact: true })).toBeVisible();
  await expect(row).not.toContainText("No matching stock");
  failRead = false;
  await page.getByRole("button", { name: "Retry project inventory", exact: true }).click();
  await openStockDetails();
  await expect(row.getByRole("button", { name: "Synthetic beyond-page connector", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry project inventory", exact: true })).toHaveCount(0);
});
