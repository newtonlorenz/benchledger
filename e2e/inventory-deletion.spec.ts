import { expect, test } from "@playwright/test";

for (const kind of ["printer", "electronic"] as const) test(`delete ${kind} with one confirmation and retain cancellation`, async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
  const name = `Deletion test ${kind}`;
  const result = await page.evaluate(async ({ name, kind }) => {
    const csrf = document.cookie.split("; ").find((entry) => entry.startsWith("forge_csrf="))?.split("=")[1];
    const response = await fetch("/api/v1/inventory", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": decodeURIComponent(csrf ?? "") }, body: JSON.stringify({ name, kind, quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }) });
    return { status: response.status, data: await response.json() };
  }, { name, kind });
  expect(result.status).toBe(201);
  await page.reload();
  await page.getByRole("button", { name: /^Inventory(?: \d+)?$/u }).click();
  await page.getByRole("button", { name: new RegExp(name) }).first().click();
  const label = kind === "printer" ? "Delete printer" : "Delete item";
  await page.getByRole("button", { name: label, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: `Delete ${name}?` });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: label, exact: true }).click();
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(name) })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: new RegExp(name) })).toHaveCount(0);
});
