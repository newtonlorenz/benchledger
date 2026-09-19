// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InventoryNavigator } from "./inventory-navigator";
import { InventorySplitter, parseInventoryLayout, readInventoryLayout, writeInventoryLayout } from "./inventory-layout";
import type { ManagedInventoryCategory } from "./category-ui";
import { InventoryTable } from "./App";
import { inventory } from "./mock-data";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const category = (id: string, name: string, parentId?: string): ManagedInventoryCategory => ({ id, name, ...(parentId ? { parentId } : {}), sortOrder: 0, archived: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: 1 });
it("browses exact categories, shows child context during search and retains collapse state", () => {
  const onSelect = vi.fn(), onManage = vi.fn();
  render(<InventoryNavigator categories={[category("parts", "Electronics"), category("boards", "Café boards", "parts"), { ...category("old", "Retired"), archived: true }]} selectedId="boards" loading={false} error={undefined} onSelect={onSelect} onManage={onManage} />);
  const child = screen.getByRole("button", { name: "Filter inventory category Electronics / Café boards" });
  expect(child.getAttribute("aria-current")).toBe("page");
  fireEvent.click(child); expect(onSelect).toHaveBeenLastCalledWith("boards");
  fireEvent.click(screen.getByRole("button", { name: "Collapse Electronics subcategories" }));
  expect(screen.queryByRole("button", { name: /Café boards/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("Find an inventory category"), { target: { value: "electronics cafe" } });
  expect(screen.getByRole("button", { name: /Café boards/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear category search" }));
  expect(screen.queryByRole("button", { name: /Café boards/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand Electronics subcategories" }));
  expect(screen.getByRole("button", { name: /Café boards/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Retired/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Unassigned items" })); expect(onSelect).toHaveBeenLastCalledWith("__unassigned__");
  fireEvent.click(screen.getByRole("button", { name: "All categories" })); expect(onSelect).toHaveBeenLastCalledWith("");
  fireEvent.click(screen.getByRole("button", { name: "Manage inventory categories" })); expect(onManage).toHaveBeenCalledOnce();
});
it("explains missing category data without hiding all-inventory access", () => {
  const props = { categories: [], selectedId: "", loading: true, error: undefined as string | undefined, onSelect: vi.fn(), onManage: vi.fn() };
  const view = render(<InventoryNavigator {...props} />); expect(screen.getByRole("status").textContent).toContain("Loading");
  view.rerender(<InventoryNavigator {...props} loading={false} error="failed" />); expect(screen.getByRole("status").textContent).toContain("unavailable");
  view.rerender(<InventoryNavigator {...props} loading={false} />); expect(screen.getByText(/Add categories/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Find an inventory category"), { target: { value: "wire" } }); expect(screen.getByText("No matching categories.")).toBeTruthy();
});
it("validates and bounds layout preferences, without mixing sample and workspace settings", () => {
  expect(parseInventoryLayout("broken")).toMatchObject({ inspectorOpen: true, inspectorWidth: 300 });
  expect(parseInventoryLayout("null").columns).toEqual(["location"]);
  const value = parseInventoryLayout(JSON.stringify({ inspectorOpen: false, inspectorWidth: 900, columns: ["sku", "invented", "sku", "category"] }));
  expect(value).toEqual({ inspectorOpen: false, inspectorWidth: 480, columns: ["category", "sku"] });
  expect(parseInventoryLayout('{"inspectorWidth":1,"columns":[]}')).toMatchObject({ inspectorWidth: 260, columns: [] });
  expect(writeInventoryLayout(value, true)).toBe(true); expect(readInventoryLayout(true)).toEqual(value); expect(readInventoryLayout(false).inspectorOpen).toBe(true);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  expect(writeInventoryLayout(value, false)).toBe(false);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  expect(readInventoryLayout(true).inspectorWidth).toBe(300);
});
it("resizes the inspector with accessible keyboard increments and a reset", () => {
  const onChange = vi.fn(); render(<InventorySplitter width={300} onChange={onChange} />);
  const control = screen.getByRole("separator", { name: "Resize item inspector" });
  fireEvent.keyDown(control, { key: "ArrowLeft" }); expect(onChange).toHaveBeenLastCalledWith(310, true);
  fireEvent.keyDown(control, { key: "ArrowRight", shiftKey: true }); expect(onChange).toHaveBeenLastCalledWith(260, true);
  fireEvent.keyDown(control, { key: "Home" }); expect(onChange).toHaveBeenLastCalledWith(260, true);
  fireEvent.keyDown(control, { key: "End" }); expect(onChange).toHaveBeenLastCalledWith(480, true);
  fireEvent.doubleClick(control); expect(onChange).toHaveBeenLastCalledWith(300, true);
});
it("separates row inspection from opening, and sorts from labelled column headers", () => {
  const item = inventory[0]!, onInspectItem = vi.fn(), onSelectItem = vi.fn(), onSortChange = vi.fn();
  const props = { items: [item], categories: [], selectedIds: new Set<string>(), selectAllRef: { current: null }, allLoadedSelected: false, hasUnversionedLoaded: false, onToggleAll: vi.fn(), onToggleSelected: vi.fn(), onInspectItem, onSelectItem, onSortChange, inspectedId: item.id };
  const view = render(<InventoryTable {...props} visibleColumns={["sku", "reserved"]} />);
  const title = document.querySelector<HTMLButtonElement>(".table-item")!;
  fireEvent.click(title); expect(onInspectItem).toHaveBeenCalledWith(item.id); expect(onSelectItem).not.toHaveBeenCalled();
  fireEvent.doubleClick(title); expect(onSelectItem).toHaveBeenCalledWith(item.id);
  fireEvent.keyDown(title, { key: "F2" }); expect(onSelectItem).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("columnheader", { name: "Category" })).toBeNull();
  expect(screen.getByRole("columnheader", { name: "SKU / part number" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Reserved" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Item" })); expect(onSortChange).toHaveBeenLastCalledWith("name_desc");
  view.rerender(<InventoryTable {...props} sort="name_desc" visibleColumns={["location"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Item" })); expect(onSortChange).toHaveBeenLastCalledWith("name");
  fireEvent.click(screen.getByRole("button", { name: "Location" })); expect(onSortChange).toHaveBeenLastCalledWith("location");
});
