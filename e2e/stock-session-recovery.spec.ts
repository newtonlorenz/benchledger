import { navigateWorkspace } from "./workspace-controls";
import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  const login = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/auth/login");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect((await login).ok()).toBe(true);
}

test("a first commissioning auth rejection remains editable after a post-login version conflict", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  let item = {
    id: "synthetic-session-definitive", name: "Synthetic editable recovery board", kind: "electronic",
    quantity: 10, availableQuantity: 0, allocatedQuantity: 0, unit: "each", location: "Synthetic drawer", tags: [], links: [],
    evidence: { state: "delivered_uncounted", source: "Synthetic delivery", observedAt: "2026-10-03T08:00:00Z" },
    createdAt: "2026-10-03T08:00:00Z", updatedAt: "2026-10-03T08:00:00Z", version: 3
  };
  await page.route("**/api/v1/inventory?**", route => route.fulfill({ json: { data: [item], total: 1, limit: 25 } }));
  let exactReads = 0;
  await page.route(`**/api/v1/inventory/${item.id}`, route => { exactReads++; return route.fulfill({ json: item }); });
  await page.route(`**/api/v1/inventory/${item.id}/images`, route => route.fulfill({ json: { itemId: item.id, version: 0, images: [] } }));
  const writes: { key: string | undefined; version: string | undefined; body: string | null }[] = [];
  await page.route(`**/api/v1/inventory/${item.id}/commission`, async route => {
    writes.push({ key: route.request().headers()["idempotency-key"], version: route.request().headers()["if-match"], body: route.request().postData() });
    if (writes.length === 1) {
      // This request was definitively rejected; another observation changed the
      // record before sign-in. There has been no lost acknowledgement.
      item = { ...item, quantity: 11, version: 4 };
      return route.fulfill({ status: 401, json: { error: { code: "unauthenticated", message: "Synthetic sign-in required before commissioning." } } });
    }
    return route.fulfill({ status: 409, json: { error: { code: "version_conflict", message: "Synthetic item changed; review the latest stock." } } });
  });
  await page.goto("/"); await signIn(page);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await navigateWorkspace(page, "Settings");
  await page.getByRole("switch", { name: "Technical details", exact: true }).check();
  await navigateWorkspace(page, "Inventory");
  const row = page.locator(".inventory-table tbody tr").filter({ hasText: item.name });
  await row.focus(); await row.press("Enter");
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel("Observed quantity", { exact: true }).fill("7");
  await drawer.getByLabel("Source", { exact: true }).fill("Synthetic original observation");
  await drawer.getByLabel("Observed", { exact: true }).fill("2026-10-03T09:17");
  await drawer.getByRole("button", { name: "Review commissioning", exact: true }).click();
  const review = page.getByRole("alertdialog", { name: "Review stock commissioning", exact: true });
  const reviewedSummary = await review.locator(".inventory-selection-summary").innerText();
  await review.getByRole("button", { name: "Commission stock", exact: true }).click();
  await expect(page.getByLabel("Workspace password")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(item.name);
  expect(writes).toHaveLength(1);
  const readsBeforeSignIn = exactReads;
  await signIn(page);
  await expect.poll(() => exactReads).toBeGreaterThan(readsBeforeSignIn);
  await expect(review).toBeVisible();
  expect(await review.locator(".inventory-selection-summary").innerText()).toBe(reviewedSummary);
  await expect(review.getByRole("button", { name: "Back to item", exact: true })).toBeEnabled();
  expect(writes).toHaveLength(1);
  await expect(review.getByRole("alert")).toContainText("This observation was not saved. Review it before retrying.");
  await review.getByRole("button", { name: "Retry observation", exact: true }).click();
  await expect(review.getByRole("alert")).toContainText("Synthetic item changed");
  expect(writes).toHaveLength(2);
  expect(writes[1]!.version).toBe("3");
  expect(writes[1]!.body).toBe(writes[0]!.body);
  expect(writes[1]!.key).toBeTruthy();
  await expect(review.getByRole("button", { name: "Back to item", exact: true })).toBeEnabled();
  await expect(review.getByRole("button", { name: "Retry unchanged observation", exact: true })).toHaveCount(0);
  await review.getByRole("button", { name: "Back to item", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(drawer.getByLabel("Observed quantity", { exact: true })).toHaveValue("7");
  await drawer.getByLabel("Observed quantity", { exact: true }).fill("8");
  await drawer.getByLabel("Source", { exact: true }).fill("Synthetic revised observation");
  await drawer.getByRole("button", { name: "Close item details", exact: true }).click();
  const guard = page.getByRole("alertdialog");
  await expect(guard.getByRole("button", { name: "Discard changes and leave", exact: true })).toBeEnabled();
  await guard.getByRole("button", { name: "Discard changes and leave", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await navigateWorkspace(page, "Projects");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(pageErrors).toEqual([]);
});

test("a definitively rejected observation can be discarded when its item is gone after sign-in", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const item = {
    id: "synthetic-session-removed", name: "Synthetic removed recovery board", kind: "electronic",
    quantity: 10, availableQuantity: 0, allocatedQuantity: 0, unit: "each", location: "Synthetic drawer", tags: [], links: [],
    evidence: { state: "delivered_uncounted", source: "Synthetic delivery", observedAt: "2026-10-03T08:00:00Z" },
    createdAt: "2026-10-03T08:00:00Z", updatedAt: "2026-10-03T08:00:00Z", version: 3
  };
  let removed = false, writes = 0, exactReads = 0;
  await page.route("**/api/v1/inventory?**", route => route.fulfill({ json: { data: removed ? [] : [item], total: removed ? 0 : 1, limit: 25 } }));
  await page.route(`**/api/v1/inventory/${item.id}`, route => {
    exactReads++;
    return removed
      ? route.fulfill({ status: 404, json: { error: { code: "not_found", message: "Synthetic inventory item was removed." } } })
      : route.fulfill({ json: item });
  });
  await page.route(`**/api/v1/inventory/${item.id}/images`, route => route.fulfill({ json: { itemId: item.id, version: 0, images: [] } }));
  await page.route(`**/api/v1/inventory/${item.id}/commission`, route => {
    writes++;
    removed = true;
    return route.fulfill({ status: 401, json: { error: { code: "unauthenticated", message: "Synthetic session expired before the observation was saved." } } });
  });
  await page.goto("/"); await signIn(page);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await navigateWorkspace(page, "Settings");
  await page.getByRole("switch", { name: "Technical details", exact: true }).check();
  await navigateWorkspace(page, "Inventory");
  const row = page.locator(".inventory-table tbody tr").filter({ hasText: item.name });
  await row.focus(); await row.press("Enter");
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel("Observed quantity", { exact: true }).fill("7");
  await drawer.getByLabel("Source", { exact: true }).fill("Synthetic physical observation");
  await drawer.getByLabel("Observed", { exact: true }).fill("2026-10-03T09:17");
  await drawer.getByRole("button", { name: "Review commissioning", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Review stock commissioning", exact: true }).getByRole("button", { name: "Commission stock", exact: true }).click();
  await expect(page.getByLabel("Workspace password")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(item.name);
  expect(writes).toBe(1);
  const readsBeforeSignIn = exactReads;
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Cannot open workspace", exact: true })).toBeVisible();
  await expect.poll(() => exactReads).toBeGreaterThan(readsBeforeSignIn);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(writes).toBe(1);
  const readsBeforeDiscard = exactReads;
  await page.getByRole("button", { name: "Discard observation and reload", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cannot open workspace", exact: true })).toHaveCount(0);
  await navigateWorkspace(page, "Projects");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(writes).toBe(1);
  expect(exactReads).toBe(readsBeforeDiscard);
  expect(pageErrors).toEqual([]);
});

for (const scenario of [
  { operation: "count", status: 401, code: "unauthenticated", width: 390 },
  { operation: "commission", status: 403, code: "csrf", width: 1440 }
] as const) {
  test(`${scenario.operation} resumes its exact unresolved observation after ${scenario.code} sign-in`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    let item = {
      id: `synthetic-session-${scenario.operation}`, name: `Synthetic ${scenario.operation} recovery board`, kind: "electronic",
      quantity: 10, availableQuantity: 0, allocatedQuantity: 0, unit: "each", location: "Synthetic drawer", tags: [], links: [],
      evidence: { state: "delivered_uncounted", source: "Synthetic delivery", observedAt: "2026-10-03T08:00:00Z" },
      createdAt: "2026-10-03T08:00:00Z", updatedAt: "2026-10-03T08:00:00Z", version: 3
    };
    await page.route("**/api/v1/inventory?**", route => route.fulfill({ json: { data: [item], total: 1, limit: 25 } }));
    let exactReads = 0;
    await page.route(`**/api/v1/inventory/${item.id}`, route => { exactReads++; return route.fulfill({ json: item }); });
    await page.route(`**/api/v1/inventory/${item.id}/images`, route => route.fulfill({ json: { itemId: item.id, version: 0, images: [] } }));
    const writes: { key: string | undefined; version: string | undefined; body: string | null }[] = [];
    await page.route(`**/api/v1/inventory/${item.id}/${scenario.operation}`, async route => {
      writes.push({ key: route.request().headers()["idempotency-key"], version: route.request().headers()["if-match"], body: route.request().postData() });
      if (writes.length === 1) {
        // Simulate a committed observation whose response was lost. Reauthentication
        // loads this newer state, but must not rewrite the original reviewed command.
        item = { ...item, quantity: 7, availableQuantity: 7, version: 4, evidence: { ...item.evidence, state: scenario.operation === "count" ? "physically_counted" : "commissioned" } };
        return route.abort("failed");
      }
      if (writes.length === 2) return route.fulfill({ status: scenario.status, json: { error: { code: scenario.code, message: "Synthetic session needs sign-in." } } });
      return route.fulfill({ json: { data: { item, event: { id: `synthetic-${scenario.operation}-event` } } } });
    });
    await page.goto("/"); await signIn(page);
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    if (scenario.operation === "commission") {
      await navigateWorkspace(page, "Settings");
      await page.getByRole("switch", { name: "Technical details", exact: true }).check();
    }
    await navigateWorkspace(page, "Inventory");
    const row = page.locator(".inventory-table tbody tr").filter({ hasText: item.name });
    await row.focus(); await row.press("Enter");
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("heading", { name: item.name, exact: true })).toBeVisible();
    let expectedObservedAt: string | undefined;
    if (scenario.operation === "count") {
      await drawer.getByLabel("Counted quantity").fill("7");
      await drawer.getByRole("button", { name: "Review physical count", exact: true }).click();
    } else {
      await drawer.getByLabel("Observed quantity", { exact: true }).fill("7");
      await drawer.getByLabel("Source", { exact: true }).fill("Synthetic physical inspection");
      await drawer.getByLabel("Source ID (optional)", { exact: true }).fill("synthetic-observation-reference");
      await drawer.getByLabel("Observed", { exact: true }).fill("2026-10-03T09:17");
      await drawer.getByLabel("Note (optional)", { exact: true }).fill("Seven intact boards physically observed.");
      expectedObservedAt = await page.evaluate(() => new Date("2026-10-03T09:17").toISOString());
      await drawer.getByRole("button", { name: "Review commissioning", exact: true }).click();
    }
    const review = page.getByRole("alertdialog", { name: scenario.operation === "count" ? "Review physical count" : "Review stock commissioning", exact: true });
    const reviewedSummary = await review.locator(".inventory-selection-summary").innerText();
    await review.getByRole("button", { name: scenario.operation === "count" ? "Confirm physical count" : "Commission stock", exact: true }).click();
    await expect(review.getByRole("button", { name: "Retry unchanged observation", exact: true })).toBeEnabled();
    expect(writes).toHaveLength(1);
    await review.getByRole("button", { name: "Retry unchanged observation", exact: true }).click();

    await expect(page.getByLabel("Workspace password")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.locator(".inventory-table")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(item.name);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);

    const readsBeforeSignIn = exactReads;
    await signIn(page);
    await expect.poll(() => exactReads).toBeGreaterThan(readsBeforeSignIn);
    await expect(review).toBeVisible();
    await expect(review.getByRole("button", { name: "Retry unchanged observation", exact: true })).toBeEnabled();
    await expect(review.getByRole("button", { name: "Back to item", exact: true })).toBeDisabled();
    // Restoration displays the original observation, not a new review based on
    // the version-4 item loaded after sign-in, and never sends it automatically.
    expect(await review.locator(".inventory-selection-summary").innerText()).toBe(reviewedSummary);
    await page.keyboard.press("Escape"); await expect(review).toBeVisible();
    expect(writes).toHaveLength(2);
    await review.getByRole("button", { name: "Retry unchanged observation", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect(drawer.getByRole("heading", { name: item.name, exact: true })).toBeVisible();
    expect(writes).toHaveLength(3);
    expect(writes[0]!.key).toBeTruthy(); expect(writes[2]).toEqual(writes[0]);
    if (scenario.operation === "count") {
      expect(JSON.parse(writes[2]!.body!)).toEqual({ quantity: 7 });
      await expect(drawer.getByLabel("Counted quantity")).toHaveCount(0);
      await expect(drawer.getByRole("status")).toContainText("Confirmed 7");
    } else {
      expect(writes[2]!.version).toBe("3");
      expect(JSON.parse(writes[2]!.body!)).toEqual({ quantity: 7, unit: "each", evidence: {
        state: "commissioned", source: "Synthetic physical inspection", sourceId: "synthetic-observation-reference",
        observedAt: expectedObservedAt, note: "Seven intact boards physically observed."
      } });
    }
    expect(pageErrors).toEqual([]);
  });
}
