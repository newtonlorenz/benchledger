import type { InventoryItem } from "./domain";

/**
 * Inventory list helpers. The server list API has no sort parameter, so
 * sorting applies to the rows already loaded (the UI says so).
 */

export type InventorySortKey = "name" | "quantity" | "category" | "location" | "updated";
export type InventorySortDirection = "asc" | "desc";
export interface InventorySort { readonly key: InventorySortKey; readonly direction: InventorySortDirection }

const sortKeys: readonly InventorySortKey[] = ["name", "quantity", "category", "location", "updated"];
/** Server maximum for a single inventory page. */
export const INVENTORY_PAGE_MAX = 200;

export function readInventorySort(search: string): InventorySort | undefined {
  const params = new URLSearchParams(search);
  const key = params.get("sort");
  if (!sortKeys.includes(key as InventorySortKey)) return undefined;
  return { key: key as InventorySortKey, direction: params.get("dir") === "desc" ? "desc" : "asc" };
}

export function writeInventorySort(params: URLSearchParams, sort: InventorySort | undefined): void {
  params.delete("sort");
  params.delete("dir");
  if (!sort) return;
  params.set("sort", sort.key);
  params.set("dir", sort.direction);
}

/** Header clicks cycle ascending → descending → server order. */
export function nextSort(current: InventorySort | undefined, key: InventorySortKey): InventorySort | undefined {
  if (current?.key !== key) return { key, direction: "asc" };
  return current.direction === "asc" ? { key, direction: "desc" } : undefined;
}

export function ariaSortFor(sort: InventorySort | undefined, key: InventorySortKey): "ascending" | "descending" | "none" {
  if (sort?.key !== key) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function locationValue(item: InventoryItem): string | undefined {
  const value = item.location?.trim();
  return !value || value === "Unassigned" ? undefined : value;
}

/** Stable sort; rows missing the sorted value always go last. */
export function sortInventoryItems(items: readonly InventoryItem[], sort: InventorySort | undefined, categoryLabel: (item: InventoryItem) => string = (item) => item.category): InventoryItem[] {
  if (!sort) return [...items];
  const value = (item: InventoryItem): string | number | undefined => {
    switch (sort.key) {
      case "name": return item.name;
      case "quantity": return item.quantity;
      case "category": return categoryLabel(item);
      case "location": return locationValue(item);
      case "updated": { const time = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN; return Number.isNaN(time) ? undefined : time; }
    }
  };
  const factor = sort.direction === "asc" ? 1 : -1;
  return items.map((item, index) => ({ item, index, value: value(item) })).sort((left, right) => {
    if (left.value === undefined || right.value === undefined) {
      if (left.value === right.value) return left.index - right.index;
      return left.value === undefined ? 1 : -1;
    }
    const compared = typeof left.value === "number" && typeof right.value === "number" ? left.value - right.value : collator.compare(String(left.value), String(right.value));
    return compared === 0 ? left.index - right.index : compared * factor;
  }).map(({ item }) => item);
}

/** A truly empty workspace needs onboarding, not "clear filters". */
export function inventoryEmptyKind({ filtered, total }: { filtered: boolean; total: number | undefined }): "first-item" | "no-matches" {
  return !filtered && total === 0 ? "first-item" : "no-matches";
}

/** After a mutation, reload every row the maker had loaded (bounded by the server page limit). */
export function refetchLimit(loaded: number, pageSize: number): number {
  return Math.min(Math.max(loaded, pageSize), INVENTORY_PAGE_MAX);
}

/** `#/inventory/<id>` opens that item's drawer. */
export function readInventoryItemRoute(hash: string): string | undefined {
  const parts = hash.replace(/^#\/?/u, "").split("/").filter(Boolean);
  if (parts[0] !== "inventory" || !parts[1]) return undefined;
  try { return decodeURIComponent(parts[1]); } catch { return undefined; }
}

export function inventoryItemHash(itemId: string | undefined): string {
  return itemId ? `#/inventory/${encodeURIComponent(itemId)}` : "#/inventory";
}
