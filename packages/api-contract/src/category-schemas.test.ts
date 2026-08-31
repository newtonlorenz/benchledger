import { describe, expect, it } from "vitest";
import { createInventoryCategorySchema, inventoryCategoryListQuerySchema, inventoryCategorySchema, updateInventoryCategorySchema } from "./schemas.js";

describe("inventory category contracts", () => {
  it("keeps taxonomy identity separate from the closed inventory kind", () => {
    const category = inventoryCategorySchema.parse({
      id: "category-filament",
      name: "Filament",
      sortOrder: 1,
      archived: false,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      version: 1,
    });
    expect(category).not.toHaveProperty("kind");
    expect(createInventoryCategorySchema.parse({ name: "Printer accessories", parentId: "category-printers", sortOrder: 2 })).toMatchObject({ parentId: "category-printers" });
    expect(updateInventoryCategorySchema.parse({ name: "Printer hardware", sortOrder: 3 })).toEqual({ name: "Printer hardware", sortOrder: 3 });
    expect(() => updateInventoryCategorySchema.parse({})).toThrow(/at least one/i);
  });

  it("allows the larger opaque category cursor without widening inventory cursors", () => {
    expect(inventoryCategoryListQuerySchema.parse({ cursor: "x".repeat(512) }).cursor).toHaveLength(512);
    expect(() => inventoryCategoryListQuerySchema.parse({ cursor: "x".repeat(513) })).toThrow();
  });
});
