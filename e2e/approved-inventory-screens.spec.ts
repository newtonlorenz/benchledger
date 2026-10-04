import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { navigateWorkspace } from "./workspace-controls";

async function expectWithinViewport(page: Page, surface: Locator) {
  await expect(surface).toBeVisible();
  await expect(async () => {
    const bounds = await surface.boundingBox();
    const viewport = page.viewportSize()!;
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await surface.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }).toPass({ timeout: 5_000 });
}

async function expectReadableControl(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport({ ratio: 1 });
  const metrics = await control.evaluate(element => ({
    fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
    height: element.getBoundingClientRect().height,
    isField: element.matches("input, select, textarea"),
  }));
  const phone = page.viewportSize()!.width === 390;
  expect(metrics.fontSize).toBeGreaterThanOrEqual(phone && metrics.isField ? 16 : 14);
  expect(metrics.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
}

async function capture(page: Page, info: TestInfo, name: string, surface?: Locator) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (surface) await expectWithinViewport(page, surface);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false, animations: "disabled" });
}

for (const viewport of [{ width: 1536, height: 1024 }, { width: 390, height: 844 }]) {
  test(`approved inventory detail and capture remain usable at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    // Every stock response and count write belongs to this browser-only fixture.
    // No physical-count observation is sent to the shared demo workspace.
    let item = {
      id: "synthetic-approved-inventory-item", name: "Synthetic M3 socket screws", kind: "fastener",
      categoryNodeId: "category-fasteners", quantity: 12, availableQuantity: 10, allocatedQuantity: 2,
      unit: "each", location: "Synthetic drawer A3", manufacturer: "Example Hardware", model: "M3 × 8 mm",
      sku: "SYNTH-M3-8", condition: "good", description: "Check the thread and length against the project part.",
      tags: ["synthetic fixture"], links: [],
      evidence: { state: "physically_counted", source: "Synthetic fixture", observedAt: "2026-10-03T08:00:00Z" },
      createdAt: "2026-10-03T08:00:00Z", updatedAt: "2026-10-03T08:00:00Z", version: 3,
    };
    const countWrites: Array<{ key: string | undefined; payload: unknown }> = [];
    const unexpectedWrites: string[] = [];
    await page.route(/\/api\/v1\/inventory(?:\?.*)?$/u, async route => {
      if (route.request().method() !== "GET") {
        unexpectedWrites.push(route.request().method());
        return route.abort("blockedbyclient");
      }
      return route.fulfill({ json: { data: [item], total: 1, limit: 25 } });
    });
    await page.route(`**/api/v1/inventory/${item.id}`, route => route.fulfill({ json: item }));
    await page.route(`**/api/v1/inventory/${item.id}/images`, route => route.fulfill({ json: { itemId: item.id, version: 0, images: [] } }));
    await page.route(`**/api/v1/inventory/${item.id}/count`, async route => {
      countWrites.push({ key: route.request().headers()["idempotency-key"], payload: route.request().postDataJSON() });
      item = { ...item, quantity: 7, availableQuantity: 5, updatedAt: "2026-10-04T08:00:00Z", version: 4,
        evidence: { ...item.evidence, observedAt: "2026-10-04T08:00:00Z" } };
      return route.fulfill({ json: { data: { item, event: { id: "synthetic-approved-count-event" } } } });
    });

    await page.goto("/");
    await page.getByLabel("Workspace password").fill("demo-password-please-change");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await navigateWorkspace(page, "Inventory");
    const row = page.locator(".inventory-table tbody tr").filter({ hasText: item.name });
    await expect(page.locator(".inventory-page-status")).toHaveText("Showing 1 of 1 items");
    await expect(row).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Search inventory", exact: true })).toHaveCount(1);
    await expect(row.locator(".inventory-available-cell")).toContainText("10 pieces");
    await expect(row.locator(".inventory-available-cell")).toContainText("2 pieces reserved");
    await capture(page, info, "inventory-loaded");
    await row.locator(".table-item").click();

    const stock = page.getByRole("dialog", { name: item.name, exact: true });
    if (viewport.width === 1536) {
      const inspector = page.getByRole("complementary", { name: "Inventory inspector", exact: true });
      await expect(inspector.getByRole("heading", { name: item.name, exact: true })).toBeVisible();
      await expect(inspector).toContainText("10 pieces available");
      await expect(inspector).toContainText("12 pieces confirmed · 2 pieces reserved");
      await expect(inspector).toContainText(item.location);
      await expect(inspector).toContainText("2026-10-03");
      await expect(inspector.getByRole("region", { name: "Needed by projects", exact: true })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expectReadableControl(page, inspector.getByRole("button", { name: "Count stock", exact: true }));
      await capture(page, info, "inventory-selected-detail", inspector);
      await inspector.getByRole("button", { name: "Identity & compatibility", exact: true }).click();
      await expect(inspector).toContainText(item.sku);
      await expect(inspector).toContainText(item.id);
      const openDetails = inspector.getByRole("button", { name: "Open item details", exact: true });
      await expectReadableControl(page, openDetails);
      await expect.poll(() => inspector.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await expect(inspector.getByRole("button", { name: "Hide item inspector", exact: true })).toBeInViewport({ ratio: 1 });
      await capture(page, info, "inventory-detail-scrolled", inspector);
      await inspector.getByRole("button", { name: "Identity & compatibility", exact: true }).click();
      await inspector.getByRole("button", { name: "Count stock", exact: true }).click();
      // Starting a new count must not silently reuse the previous observation.
      await expect(stock.getByLabel("Counted quantity", { exact: true })).toHaveValue("");
    } else {
      await expect(stock).toBeVisible();
      await expect(stock).toContainText(item.location);
      const onHand = stock.getByRole("region", { name: "Stock on hand", exact: true });
      await expect(onHand.getByText("12 pieces on hand.", { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(onHand.getByText("Physically counted", { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(stock).toContainText("2 pieces reserved; 10 pieces currently available for reuse");
      await expect(stock.getByRole("region", { name: "Needed by projects", exact: true })).toBeVisible();
      await expectReadableControl(page, stock.getByRole("button", { name: "Count stock", exact: true }));
      await capture(page, info, "inventory-selected-detail", stock);
      await stock.getByRole("button", { name: "Count stock", exact: true }).click();
    }

    const quantity = stock.getByLabel("Counted quantity", { exact: true });
    await expectReadableControl(page, quantity);
    await quantity.fill("7");
    await expect(stock).toContainText("Recorded condition: good. A count changes quantity only.");
    await expectReadableControl(page, stock.getByRole("button", { name: "Review physical count", exact: true }));
    await capture(page, info, "inventory-count-form", stock);
    await stock.getByRole("button", { name: "Review physical count", exact: true }).click();

    const review = page.getByRole("alertdialog", { name: "Review physical count", exact: true });
    await expect(review).toContainText(item.name);
    await expect(review).toContainText(`${item.manufacturer} · ${item.model} · ${item.sku}`);
    await expect(review).toContainText(item.location);
    await expect(review).toContainText(`Record: ${item.id}`);
    await expect(review.getByText("Before this count", { exact: true }).locator("..")).toContainText("12 pieces");
    await expect(review.getByText("After this count", { exact: true }).locator("..")).toContainText("7 pieces");
    await expect(review).toContainText("Reservations and recorded condition stay unchanged.");
    await expect(review).toContainText("This count does not confirm that the item fits a project.");
    expect(countWrites).toHaveLength(0);
    await expectReadableControl(page, review.getByRole("button", { name: "Confirm physical count", exact: true }));
    await capture(page, info, "inventory-count-review", review);
    await review.getByRole("button", { name: "Back to item", exact: true }).click();
    await expect(quantity).toHaveValue("7");
    expect(countWrites).toHaveLength(0);
    await stock.getByRole("button", { name: "Review physical count", exact: true }).click();
    await review.getByRole("button", { name: "Confirm physical count", exact: true }).click();
    await expect(review).toHaveCount(0);
    const receipt = stock.getByRole("status");
    await expect(receipt).toContainText("Physical count saved");
    await expect(receipt).toContainText("Confirmed 7 pieces as the on-hand quantity.");
    await expect(receipt).toContainText(item.location);
    await expect(receipt).toContainText("Compatibility with a project is checked separately.");
    await expect(quantity).toHaveCount(0);
    await expect(stock.getByRole("button", { name: "Done", exact: true })).toHaveCount(1);
    await expectReadableControl(page, stock.getByRole("button", { name: "Done", exact: true }));
    await capture(page, info, "inventory-count-receipt", stock);
    expect(countWrites).toHaveLength(1);
    expect(countWrites[0]!.key).toBeTruthy();
    expect(countWrites[0]!.payload).toEqual({ quantity: 7 });
    await stock.getByRole("button", { name: "Done", exact: true }).click();
    await expect(stock).toHaveCount(0);
    await expect(row.locator(".inventory-available-cell")).toContainText("5 pieces");
    await expect(row.locator(".inventory-available-cell")).toContainText("2 pieces reserved");

    await page.getByRole("button", { name: "Add item", exact: true }).click();
    const choose = page.getByRole("dialog", { name: "Add to inventory", exact: true });
    await expectReadableControl(page, choose.getByRole("combobox", { name: "What are you adding?", exact: true }));
    await choose.getByRole("combobox", { name: "What are you adding?", exact: true }).selectOption("electronic");
    await expect(choose.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    await capture(page, info, "inventory-create-type", choose);
    await choose.getByRole("button", { name: "Continue", exact: true }).click();
    const create = page.getByRole("dialog", { name: "Add an inventory item", exact: true });
    const name = create.getByLabel("Name", { exact: true });
    const recorded = create.getByLabel("Recorded quantity", { exact: true });
    const location = create.getByLabel("Location (optional)", { exact: true });
    const identity = create.getByRole("button", { name: "Specifications & identity", exact: true });
    await expect(identity).toHaveAttribute("aria-expanded", "false");
    await expect(create.getByLabel("Product code (optional)", { exact: true })).toBeHidden();
    await expect(create.getByRole("checkbox", { name: "I have counted these", exact: true })).not.toBeChecked();
    await expect(create).toContainText("The quantity stays unconfirmed until you count it.");
    for (const control of [name, recorded, create.getByRole("combobox", { name: "Unit", exact: true }), location]) await expectReadableControl(page, control);
    await name.fill("Synthetic spare controller");
    await recorded.fill("3");
    await location.fill("Synthetic drawer B2");
    await expectReadableControl(page, create.getByRole("button", { name: "Add item", exact: true }));
    await name.scrollIntoViewIfNeeded();
    await capture(page, info, "inventory-create-primary", create);

    await identity.click();
    await expect(identity).toHaveAttribute("aria-expanded", "true");
    const maker = create.getByLabel("Brand or manufacturer (if known)", { exact: true });
    const model = create.getByLabel("Model (if known)", { exact: true });
    const code = create.getByLabel("Product code (optional)", { exact: true });
    for (const control of [maker, model, code]) await expectReadableControl(page, control);
    await maker.fill("Example Components");
    await model.fill("SYNTH-3.3V");
    await code.fill("SYNTH-CONTROL-01");
    await capture(page, info, "inventory-create-identity", create);
    await create.getByRole("button", { name: "Cancel", exact: true }).click();
    const discard = page.getByRole("alertdialog", { name: "Discard this item draft?", exact: true });
    await expect(discard).toContainText("Your item has not been added.");
    await capture(page, info, "inventory-create-discard", discard);
    await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(name).toHaveValue("Synthetic spare controller");
    await expect(recorded).toHaveValue("3");
    await expect(location).toHaveValue("Synthetic drawer B2");
    await expect(code).toHaveValue("SYNTH-CONTROL-01");
    await create.getByRole("button", { name: "Cancel", exact: true }).click();
    await discard.getByRole("button", { name: "Discard draft", exact: true }).click();
    await expect(create).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(countWrites).toHaveLength(1);
    expect(unexpectedWrites).toEqual([]);
    expect(pageErrors).toEqual([]);
    await capture(page, info, "inventory-return");
  });
}
