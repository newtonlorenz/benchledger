// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InventoryPage } from "./App";
import type { WorkspaceAdapter } from "./api";
import { inventory } from "./mock-data";
import { inventoryLayoutKey, readInventoryLayout } from "./inventory-layout";

beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); localStorage.clear(); window.history.replaceState(null, "", "/inventory"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function renderInventory() {
  const item = inventory[0]!;
  const listInventory = vi.fn().mockResolvedValue({ items: [item], total: 1 });
  const onSelectItem = vi.fn();
  render(<InventoryPage categoryNodeId="" setCategoryNodeId={vi.fn()} sampleMode={false} adapter={{ listInventory } as unknown as WorkspaceAdapter} categories={[]} expert={false} search="" searchInputRef={createRef<HTMLInputElement>()} refreshKey={0} bulkSelectionResetKey={0} onSearch={vi.fn()} onSessionExpired={vi.fn()} onPageItems={vi.fn()} onSelectItem={onSelectItem} onNewItem={vi.fn()} onBulkSelectionChange={vi.fn()} />);
  return { item, listInventory, onSelectItem };
}

it("starts with the full register and opens details when a maker selects an item", async () => {
  const { item, onSelectItem } = renderInventory();
  const row = await screen.findByRole("button", { name: new RegExp("^" + item.name) });
  expect(screen.queryByRole("complementary", { name: "Inventory inspector" })).toBeNull();
  expect(screen.getByRole("button", { name: "Inspector" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(row);
  expect(screen.getByRole("complementary", { name: "Inventory inspector" })).toBeTruthy();
  expect(onSelectItem).not.toHaveBeenCalled();
  expect(readInventoryLayout(false).inspectorOpen).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Hide item inspector" }));
  expect(screen.queryByRole("complementary", { name: "Inventory inspector" })).toBeNull();
  expect(readInventoryLayout(false).inspectorOpen).toBe(false);
});

it("preserves an existing preference to show the inspector", async () => {
  localStorage.setItem(inventoryLayoutKey(false), JSON.stringify({ inspectorOpen: true }));
  const { item } = renderInventory();
  await screen.findByRole("button", { name: new RegExp("^" + item.name) });
  expect(screen.getByRole("complementary", { name: "Inventory inspector" })).toBeTruthy();
});

it("keeps filters together and reveals saved views, sorting and columns only on request", async () => {
  const { listInventory } = renderInventory();
  expect(screen.queryByRole("combobox", { name: "Sort inventory" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Saved inventory view" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Filter inventory by item type" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  expect(screen.getByRole("combobox", { name: "Filter inventory by item type" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Filter inventory by exact location" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "More filters" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View options" }));
  const sort = screen.getByRole("combobox", { name: "Sort inventory" });
  fireEvent.change(sort, { target: { value: "name_desc" } });
  await waitFor(() => expect(listInventory).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "name_desc" })));
  expect(screen.getByRole("combobox", { name: "Saved inventory view" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "SKU / part number" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save view…" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Inventory view name" }), { target: { value: "Parts by name" } });
  fireEvent.click(screen.getByRole("button", { name: "Save view" }));
  expect((screen.getByRole("combobox", { name: "Saved inventory view" }) as HTMLSelectElement).value).toBe("Parts by name");
});
