import { describe, expect, it } from "vitest";
import type { InventoryItem } from "./domain";
import { inventory as fixtureInventory } from "./mock-data";
import { ariaSortFor, inventoryEmptyKind, nextSort, readInventoryItemRoute, readInventorySort, refetchLimit, sortInventoryItems, writeInventorySort } from "./inventory-list";

const item = (overrides: Partial<InventoryItem>): InventoryItem => ({ ...structuredClone(fixtureInventory[0]!), ...overrides });

describe("inventory sorting", () => {
  const rows = [
    item({ id: "b", name: "Bolt", quantity: 5, location: "Drawer B", updatedAt: "2026-01-02T00:00:00.000Z" }),
    item({ id: "a", name: "anchor", quantity: 50, location: "Drawer A", updatedAt: "2026-03-01T00:00:00.000Z" }),
    item({ id: "c", name: "Clip", quantity: 1, location: "Unassigned" })
  ];

  it("sorts by name case-insensitively, both directions", () => {
    expect(sortInventoryItems(rows, { key: "name", direction: "asc" }).map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(sortInventoryItems(rows, { key: "name", direction: "desc" }).map((row) => row.id)).toEqual(["c", "b", "a"]);
  });

  it("sorts by quantity numerically and keeps missing locations and dates last", () => {
    expect(sortInventoryItems(rows, { key: "quantity", direction: "asc" }).map((row) => row.id)).toEqual(["c", "b", "a"]);
    expect(sortInventoryItems(rows, { key: "location", direction: "asc" }).map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(sortInventoryItems(rows, { key: "location", direction: "desc" }).map((row) => row.id)).toEqual(["b", "a", "c"]);
    expect(sortInventoryItems(rows, { key: "updated", direction: "desc" }).map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("uses a provided category label", () => {
    const labels: Record<string, string> = { a: "Zeta", b: "Alpha", c: "Mid" };
    expect(sortInventoryItems(rows, { key: "category", direction: "asc" }, (row) => labels[row.id]!).map((row) => row.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps server order when no sort is chosen", () => {
    expect(sortInventoryItems(rows, undefined).map((row) => row.id)).toEqual(["b", "a", "c"]);
  });

  it("round-trips sort state through the URL search", () => {
    expect(readInventorySort("?sort=quantity&dir=desc")).toEqual({ key: "quantity", direction: "desc" });
    expect(readInventorySort("?sort=bogus")).toBeUndefined();
    const params = new URLSearchParams("q=bolt");
    writeInventorySort(params, { key: "name", direction: "asc" });
    expect(params.toString()).toBe("q=bolt&sort=name&dir=asc");
    writeInventorySort(params, undefined);
    expect(params.toString()).toBe("q=bolt");
  });

  it("cycles asc → desc → off and exposes aria-sort", () => {
    expect(nextSort(undefined, "name")).toEqual({ key: "name", direction: "asc" });
    expect(nextSort({ key: "name", direction: "asc" }, "name")).toEqual({ key: "name", direction: "desc" });
    expect(nextSort({ key: "name", direction: "desc" }, "name")).toBeUndefined();
    expect(nextSort({ key: "name", direction: "desc" }, "location")).toEqual({ key: "location", direction: "asc" });
    expect(ariaSortFor({ key: "name", direction: "desc" }, "name")).toBe("descending");
    expect(ariaSortFor({ key: "name", direction: "desc" }, "location")).toBe("none");
  });
});

describe("inventory empty states", () => {
  it("explains how to add the first item only when nothing is filtered and nothing exists", () => {
    expect(inventoryEmptyKind({ filtered: false, total: 0 })).toBe("first-item");
    expect(inventoryEmptyKind({ filtered: true, total: 0 })).toBe("no-matches");
    expect(inventoryEmptyKind({ filtered: false, total: undefined })).toBe("no-matches");
  });
});

describe("inventory refresh range", () => {
  it("refetches every loaded row after a mutation, within the server limit", () => {
    expect(refetchLimit(0, 25)).toBe(25);
    expect(refetchLimit(60, 25)).toBe(60);
    expect(refetchLimit(900, 25)).toBe(200);
  });
});

describe("inventory deep link", () => {
  it("reads #/inventory/<id>", () => {
    expect(readInventoryItemRoute("#/inventory/item%2F1")).toBe("item/1");
    expect(readInventoryItemRoute("#/inventory")).toBeUndefined();
    expect(readInventoryItemRoute("#/projects/x")).toBeUndefined();
  });
});
