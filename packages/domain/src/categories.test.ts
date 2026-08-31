import { describe, expect, it } from "vitest";
import {
  BUILTIN_INVENTORY_CATEGORIES,
  assertInventoryCategoryParent,
  compareInventoryCategoryKeys,
  normalizeInventoryCategoryKey,
  type InventoryCategory,
} from "./categories.js";

const category = (overrides: Partial<InventoryCategory> = {}): InventoryCategory => ({
  id: "category-tools",
  name: "Tools",
  sortOrder: 0,
  archived: false,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  version: 1,
  ...overrides,
});

describe("inventory category domain", () => {
  it("ships a stable taxonomy that is independent from inventory item kinds", () => {
    expect(BUILTIN_INVENTORY_CATEGORIES.map((value) => value.id)).toEqual(expect.arrayContaining([
      "category-printers",
      "category-filament",
      "category-tools",
      "category-electronics",
      "category-fasteners",
      "category-other",
    ]));
    expect(BUILTIN_INVENTORY_CATEGORIES.every((value) => value.version === 1 && value.archived === false)).toBe(true);
  });

  it("allows only a top-level category as a parent", () => {
    const parent = category({ id: "category-printers" });
    expect(() => assertInventoryCategoryParent(category({ parentId: parent.id }), parent, undefined)).not.toThrow();
    expect(() => assertInventoryCategoryParent(category({ id: parent.id, parentId: parent.id }), parent, undefined)).toThrow(/itself|cycle/i);
    expect(() => assertInventoryCategoryParent(category({ parentId: "category-child" }), category({ id: "category-child", parentId: "category-printers" }), undefined)).toThrow(/one level|top-level/i);
  });

  it("uses a deterministic Unicode-aware sibling key", () => {
    expect(normalizeInventoryCategoryKey("  Électronique  ")).toBe(normalizeInventoryCategoryKey("électronique"));
    expect(normalizeInventoryCategoryKey("Cafe\u0301")).toBe(normalizeInventoryCategoryKey("Café"));
    expect(compareInventoryCategoryKeys("Zebra", "Éclair")).toBeLessThan(0);
  });

  it("uses UTF-8 byte ordering even when UTF-16 ordering disagrees", () => {
    expect(normalizeInventoryCategoryKey("😀")).toBe("f09f9880");
    expect(normalizeInventoryCategoryKey("\uE000")).toBe("ee8080");
    expect(compareInventoryCategoryKeys("😀", "\uE000")).toBeGreaterThan(0);
  });
});
