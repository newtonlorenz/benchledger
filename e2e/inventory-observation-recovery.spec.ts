import { navigateWorkspace } from "./workspace-controls";
import { expect, test, type Page } from "@playwright/test";

async function openInventory(page: Page, width: number) {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await navigateWorkspace(page, "Inventory");
}

for (const width of [390, 1440]) {
  test(`physical count protects its draft and retries the reviewed observation at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    let item = {
      id: "synthetic-observation-item", name: "Synthetic observation board", kind: "electronic", quantity: 10,
      availableQuantity: 0, allocatedQuantity: 0, unit: "each", location: "Synthetic drawer", tags: [], links: [],
      evidence: { state: "delivered_uncounted", source: "Synthetic delivery", observedAt: "2026-10-03T08:00:00Z" },
      createdAt: "2026-10-03T08:00:00Z", updatedAt: "2026-10-03T08:00:00Z", version: 3
    };
    await page.route("**/api/v1/inventory?**", route => route.fulfill({ json: { data: [item], total: 1, limit: 25 } }));
    await page.route(`**/api/v1/inventory/${item.id}/images`, route => route.fulfill({ json: { itemId: item.id, version: 0, images: [] } }));
    const writes: { key: string | undefined; payload: unknown }[] = [];
    await page.route(`**/api/v1/inventory/${item.id}/count`, async route => {
      writes.push({ key: route.request().headers()["idempotency-key"], payload: route.request().postDataJSON() });
      if (writes.length === 1) return route.fulfill({ status: 409, json: { error: { code: "version_conflict", message: "Synthetic count rejected: check this observation." } } });
      if (writes.length === 2) return route.abort("failed");
      if (writes.length === 3) return route.fulfill({ status: 409, json: { error: { code: "version_conflict", message: "Synthetic retry rejected." } } });
      item = { ...item, quantity: 7, availableQuantity: 7, evidence: { ...item.evidence, state: "physically_counted" }, version: 4 };
      return route.fulfill({ json: { data: { item, event: { id: "synthetic-count-event" } } } });
    });
    await openInventory(page, width);
    const openItem = async () => {
      const row = page.locator(".inventory-table tbody tr").filter({ hasText: item.name });
      await row.focus(); await row.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
    };
    await openItem();
    let drawer = page.getByRole("dialog");
    await drawer.getByLabel("Counted quantity").fill("7");
    await drawer.getByRole("button", { name: "Close item details" }).click();
    const guard = page.getByRole("alertdialog");
    await expect(guard).toContainText("stock observation");
    await guard.getByRole("button", { name: "Keep editing" }).click();
    await expect(drawer.getByLabel("Counted quantity")).toHaveValue("7");
    await drawer.getByRole("button", { name: "Close item details" }).click();
    await guard.getByRole("button", { name: "Discard changes and leave", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openItem(); drawer = page.getByRole("dialog");
    await expect(drawer.getByLabel("Counted quantity")).toHaveValue("");
    await drawer.getByLabel("Counted quantity").fill("7");
    await drawer.getByRole("button", { name: "Review physical count", exact: true }).click();
    const review = page.getByRole("alertdialog", { name: "Review physical count", exact: true });
    await review.getByRole("button", { name: "Confirm physical count", exact: true }).click();
    await expect(review.getByRole("alert")).toContainText("Synthetic count rejected");
    await review.getByRole("button", { name: "Back to item" }).click();
    await expect(drawer.getByLabel("Counted quantity")).toHaveValue("7");
    await drawer.getByRole("button", { name: "Review physical count", exact: true }).click();
    await review.getByRole("button", { name: "Confirm physical count", exact: true }).click();
    await expect(review.getByRole("alert")).toContainText("count save is not confirmed");
    await expect(review.getByRole("button", { name: "Back to item" })).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(review).toBeVisible();
    expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`count-retry-${width}.png`), fullPage: true });
    await review.getByRole("button", { name: "Retry unchanged observation" }).click();
    await expect.poll(() => writes.length).toBe(3);
    await expect(review.getByRole("button", { name: "Retry unchanged observation" })).toBeEnabled();
    await expect(review.getByRole("button", { name: "Back to item" })).toBeDisabled();
    await review.getByRole("button", { name: "Retry unchanged observation" }).click();
    await expect(review).toHaveCount(0);
    await expect(drawer.getByLabel("Counted quantity")).toHaveCount(0);
    await expect(drawer.getByRole("status")).toContainText("Physical count saved");
    await expect(drawer.getByRole("status")).toContainText("Confirmed 7");
    expect(writes).toHaveLength(4);
    expect(writes[1]!.key).toBeTruthy(); expect(writes[1]!.key).not.toBe(writes[0]!.key);
    expect(writes[2]).toEqual(writes[1]); expect(writes[3]).toEqual(writes[1]);
    expect(writes[1]!.payload).toEqual({ quantity: 7 });
    await drawer.getByRole("button", { name: "Close item details" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
}
