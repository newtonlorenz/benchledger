// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InventoryInspector, InventoryAiCopy } from "./inventory-inspector";
import { inventory } from "./mock-data";
import { inventoryAiBrief, parseInventoryView, parseSavedInventoryViews, readSavedInventoryViews, saveInventoryViews, inventoryViewsKey, inventoryStockLabel, webInventoryEvidence } from "./inventory-workspace-state";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("bounds saved views, validates filters and separates sample from private preferences", () => {
  const filters = parseInventoryView({ search: "x".repeat(220), stockView: "invented", sort: "quantity", kind: "bad", evidence: "bad", location: "A" });
  expect(filters.search).toHaveLength(200); expect(filters.stockView).toBe("all"); expect(filters.sort).toBe("name"); expect(filters.kind).toBe("All");
  expect(parseSavedInventoryViews("not json")).toEqual([]); expect(parseSavedInventoryViews("{}")).toEqual([]);
  const views = parseSavedInventoryViews(JSON.stringify([null, {}, { name: " " }, ...Array.from({ length: 14 }, (_, i) => ({ name: `View ${i}`, filters })), { name: "View 0" }]));
  expect(views).toHaveLength(12);
  expect(saveInventoryViews(views, true)).toBe(true); expect(readSavedInventoryViews(true)).toEqual(views); expect(readSavedInventoryViews(false)).toEqual([]);
  localStorage.setItem(inventoryViewsKey(false), JSON.stringify([{ name: "Parts", filters: { stockView: "reserved", sort: "location", kind: "electronic", evidence: "commissioned", availability: "unavailable" } }]));
  expect(readSavedInventoryViews(false)[0]?.filters).toMatchObject({ stockView: "reserved", sort: "location", kind: "electronic", evidence: "commissioned", availability: "unavailable" });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  expect(saveInventoryViews(views, true)).toBe(false);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  expect(readSavedInventoryViews(true)).toEqual([]);
});
it("makes the AI snapshot explicit about scope, uncertainty, units and compatibility", () => {
  const item = { ...inventory[0]!, availableQuantity: 0, quantity: 10, reserved: 0, serverEvidence: "ordered_unverified" as const };
  const brief = JSON.parse(inventoryAiBrief([item], "2026-09-19T12:00:00Z"));
  expect(brief.scope).toContain("not a complete inventory"); expect(brief.guidance).toContain("compatibility");
  expect(brief.items[0]).toMatchObject({ quantity: 10, availableQuantity: 0, evidence: { state: "ordered_unverified" }, stockStatus: "Needs checking" });
  expect(inventoryStockLabel({ ...item, unitStatus: "needs_correction" })).toBe("Fix unit");
  expect(inventoryStockLabel({ ...item, condition: "needs_repair" })).toBe("Needs repair");
  expect(inventoryStockLabel({ ...item, serverEvidence: "commissioned", quantity: 1, availableQuantity: 1 })).toBe("Available");
  expect(inventoryStockLabel({ ...item, serverEvidence: "commissioned", reserved: 10 })).toBe("Reserved");
  expect(inventoryStockLabel({ ...item, serverEvidence: "consumed", quantity: 0 })).toBe("Out of stock");
  const { serverEvidence: _e, ...legacy } = item;
  for (const [evidence, expected] of [["counted", "physically_counted"], ["commissioned", "commissioned"], ["ordered", "ordered_unverified"], ["delivered", "delivered_uncounted"]] as const) expect(webInventoryEvidence({ ...legacy, evidence })).toBe(expected);
});
it("inspects evidence without editing and opens the existing stock editor deliberately", () => {
  const onOpen = vi.fn(), onClose = vi.fn();
  const item = { ...inventory[0]!, serverEvidence: "delivered_uncounted" as const, availableQuantity: 0, reserved: 0 };
  const result = render(<InventoryInspector item={item} category="Electronics" onOpen={onOpen} onClose={onClose} />);
  expect(screen.getByText(/not been physically confirmed/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit item / record stock" })); expect(onOpen).toHaveBeenCalledWith(item.id);
  fireEvent.click(screen.getByRole("button", { name: "Hide item inspector" })); expect(onClose).toHaveBeenCalledOnce();
  result.rerender(<InventoryInspector onOpen={onOpen} onClose={onClose} />); expect(screen.getByText(/Choose an item/u)).toBeTruthy();
});
it("copies only selected records and offers a selectable fallback when the clipboard is denied", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<InventoryAiCopy items={inventory.slice(0, 2)} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy for AI (2)" }));
  await screen.findByText("Copied 2 records. Nothing was sent.");
  expect(JSON.parse(writeText.mock.calls[0]![0]).items).toHaveLength(2);
  writeText.mockRejectedValue(new Error("denied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy for AI (2)" }));
  const fallback = await screen.findByRole("textbox", { name: "Inventory brief" });
  fireEvent.focus(fallback); await waitFor(() => expect((fallback as HTMLTextAreaElement).selectionEnd).toBe((fallback as HTMLTextAreaElement).value.length));
});
