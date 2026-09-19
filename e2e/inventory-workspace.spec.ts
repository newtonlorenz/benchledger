import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
}
const records = Array.from({ length: 32 }, (_, i) => ({ id: `inspector-part-${i}`, name: `Inspector part ${String(i).padStart(2,"0")}`, kind: "electronic", quantity: 10, availableQuantity: i < 28 ? 0 : 8, allocatedQuantity: i < 28 ? 0 : 2, unit: "each", location: i % 2 === 0 ? "Drawer A" : "Drawer B", manufacturer: "Example Components", model: `EX-${i}`, tags: ["test fixture"], links: [], evidence: { state: i < 28 ? "delivered_uncounted" : "physically_counted", source: "synthetic fixture", observedAt: "2026-09-19T08:00:00Z" }, createdAt: "2026-09-19T08:00:00Z", updatedAt: "2026-09-19T08:00:00Z", version: 1 }));
async function fixtureInventory(page: Page) {
  await page.route("**/api/v1/inventory?**", async (route) => {
    const url = new URL(route.request().url());
    const query = url.searchParams;
    let rows = records.filter((row) => (!query.get("q") || row.name.toLowerCase().includes(query.get("q")!.toLowerCase())) && (!query.get("location") || row.location === query.get("location")) && (query.get("stockView") === "available" || query.get("stockView") === "reserved" ? row.availableQuantity > 0 : query.get("stockView") === "check" ? row.availableQuantity === 0 : query.get("stockView") === "depleted" ? false : true));
    rows = rows.sort((a,b) => (query.get("sort") === "name_desc" ? -1 : 1) * a.name.localeCompare(b.name));
    const offset = Number(query.get("cursor") ?? "0"), limit = Number(query.get("limit") ?? "25");
    const data = rows.slice(offset, offset + limit);
    await route.fulfill({ json: { data, limit, total: rows.length, ...(offset + data.length < rows.length ? { nextCursor: String(offset + data.length) } : {}) } });
  });
}

test("inventory inspector supports keyboard review, explicit editing and clipboard fallback", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
  await login(page); await fixtureInventory(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Inventory inspector" });
  await expect(inspector.getByRole("heading", { name: "Inspector part 00", exact: true })).toBeVisible();
  await expect(inspector).toContainText("not been physically confirmed");
  const first = page.locator(".inventory-table tbody tr").first();
  await first.focus(); await page.keyboard.press("ArrowDown");
  await expect(inspector.getByRole("heading", { name: "Inspector part 01", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await inspector.getByRole("button", { name: "Copy for AI", exact: true }).click();
  const brief = JSON.parse(await inspector.getByRole("textbox", { name: "Inventory brief" }).inputValue());
  expect(brief.items).toHaveLength(1); expect(brief.items[0].id).toBe("inspector-part-1");
  expect(brief.items[0].availableQuantity).toBe(0); expect(brief.scope).toContain("not a complete inventory");
  await inspector.getByRole("button", { name: "Hide item inspector" }).click();
  await expect(inspector).toHaveCount(0);
  await page.locator(".inventory-table .table-item").filter({ hasText: "Inspector part 02" }).click();
  await expect(inspector).toHaveCount(0);
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(inspector.getByRole("heading", { name: "Inspector part 02", exact: true })).toBeVisible();
});

test("stock views sort before paging, clear bulk selections, and persist saved filters through reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page); await fixtureInventory(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(page.locator(".inventory-page-status")).toHaveText("Showing 25 of 32 items");
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.locator(".inventory-page-status")).toHaveText("Showing 32 of 32 items");
  await page.getByRole("checkbox", { name: /^Select Inspector part 00/u }).check();
  await page.getByRole("button", { name: "Available stock", exact: true }).click();
  await expect(page.locator(".inventory-page-status")).toHaveText("Showing 4 of 4 items");
  await expect(page.getByRole("button", { name: "Bulk edit", exact: true })).toHaveCount(0);
  await expect(page.getByText("Selection cleared because the search or filters changed.")).toBeVisible();
  await page.getByLabel("Sort inventory", { exact: true }).selectOption("name_desc");
  await expect(page.locator(".inventory-table tbody tr").first()).toContainText("Inspector part 31");
  await page.getByText("More filters", { exact: true }).click();
  await page.getByLabel("Filter inventory by exact location").fill("Drawer B");
  await expect(page.locator(".inventory-page-status")).toHaveText("Showing 2 of 2 items");
  await page.getByRole("button", { name: "Save view…", exact: true }).click();
  await page.getByLabel("Inventory view name").fill("Available boards");
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(page.getByLabel("Saved inventory view")).toHaveValue("Available boards");
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await expect(page.locator(".inventory-page-status")).toHaveText("Showing 25 of 32 items");
  await page.getByLabel("Saved inventory view").selectOption("Available boards");
  await expect(page.locator(".inventory-page-status")).toHaveText("Showing 2 of 2 items");
  await page.reload();
  await expect(page.getByLabel("Saved inventory view")).toHaveValue("Available boards");
  await expect(page.locator(".inventory-table tbody tr").first()).toContainText("Inspector part 31");
  await expect(page.getByLabel("Sort inventory", { exact: true })).toHaveValue("name_desc");
  await page.getByRole("button", { name: "Remove saved view", exact: true }).click();
  await expect(page.getByLabel("Saved inventory view")).toHaveValue("");
});

test("inventory register and inspector remain accessible in light, dark and narrow layouts", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page); await fixtureInventory(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(page.locator(".inventory-page-status")).toHaveText("Showing 25 of 32 items");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    const results = await new AxeBuilder({ page }).include(".inventory-workstation").include(".inventory-navigator").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  }
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const inspect = page.locator(".inventory-table .table-item").filter({ hasText: "Inspector part 01" });
    await inspect.click();
    await expect(page.getByRole("complementary", { name: "Inventory inspector" }).getByRole("heading", { name: "Inspector part 01", exact: true })).toBeVisible();
  }
});

test("inventory uses its own navigator and restores configurable desktop layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page); await fixtureInventory(page);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(page.getByRole("region", { name: "Inventory navigator" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Project navigator" })).toHaveCount(0);
  await page.getByRole("button", { name: "Filter inventory category Electronics", exact: true }).click();
  await expect(page.getByLabel("Filter inventory by category")).toHaveValue("category-electronics");
  await expect(page).toHaveURL(/categoryNodeId=category-electronics/);
  await page.getByRole("button", { name: "All categories", exact: true }).click();
  await expect(page.getByLabel("Filter inventory by category")).toHaveValue("");
  const item = page.locator(".inventory-table .table-item").filter({ hasText: "Inspector part 02" });
  await item.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Inventory inspector" })).toContainText("Inspector part 02");
  await item.dblclick(); await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape");
  await item.focus(); await page.keyboard.press("F2"); await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape");
  await page.getByRole("columnheader", { name: "Item", exact: true }).getByRole("button").click();
  await expect(page.locator(".inventory-table tbody tr").first()).toContainText("Inspector part 31");
  await expect(page.getByLabel("Sort inventory", { exact: true })).toHaveValue("name_desc");
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  const columns = page.getByRole("group", { name: "Additional columns" });
  await columns.getByRole("checkbox", { name: "SKU / part number" }).check();
  await columns.getByRole("checkbox", { name: "Location", exact: true }).uncheck();
  await expect(page.getByRole("columnheader", { name: "SKU / part number" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Location", exact: true })).toHaveCount(0);
  const splitter = page.getByRole("separator", { name: "Resize item inspector" });
  await splitter.focus(); await page.keyboard.press("Shift+ArrowLeft");
  await expect(splitter).toHaveAttribute("aria-valuenow", "340");
  const bounds = await splitter.boundingBox();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 60);
  await page.mouse.down(); await page.mouse.move(bounds!.x + bounds!.width / 2 - 40, bounds!.y + 60); await page.mouse.up();
  await expect(splitter).toHaveAttribute("aria-valuenow", "380");
  await page.reload();
  await expect(splitter).toHaveAttribute("aria-valuenow", "380");
  await expect(page.getByRole("columnheader", { name: "SKU / part number" })).toBeVisible();
  await page.getByRole("button", { name: "Hide item inspector" }).click(); await page.reload();
  await expect(page.getByRole("complementary", { name: "Inventory inspector" })).toHaveCount(0);
  await page.getByRole("button", { name: "Columns", exact: true }).click(); await page.getByRole("button", { name: "Reset layout" }).click();
  await expect(splitter).toHaveAttribute("aria-valuenow", "300");
  await expect(page.getByRole("columnheader", { name: "Location", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Projects/u }).click();
  await expect(page.getByRole("region", { name: "Project navigator" })).toBeVisible();
});
