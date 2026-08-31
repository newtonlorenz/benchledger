import { describe, expect, it } from "vitest";
import { createBomLineSchema, createInventoryItemSchema, updateBomLineSchema, updateInventoryItemSchema } from "./schemas.js";

const constraints = {
  kind: "electronic",
  manufacturer: "Maker Co",
  model: "ESP32-S3",
  sku: "DEV-32",
  tag: "controller",
  nameIncludes: "board",
};

describe("REST BOM constraint schema", () => {
  it("accepts exactly the supported constraint keys for create and update", () => {
    const created = createBomLineSchema.parse({
      name: "Controller",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [],
      constraints,
    });
    const updated = updateBomLineSchema.parse({ constraints });

    expect(created.constraints).toEqual(constraints);
    expect(updated.constraints).toEqual(constraints);
  });

  it("rejects unknown and non-string constraint values at the REST boundary", () => {
    expect(() => createBomLineSchema.parse({ name: "Controller", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: { unsupported: "value" } })).toThrow();
    expect(() => updateBomLineSchema.parse({ constraints: { kind: 42 } })).toThrow();
  });
});

describe("REST inventory quantity invariants", () => {
  it("rejects available confirmed stock above the total quantity", () => {
    expect(() => createInventoryItemSchema.parse({
      name: "ESP32 board",
      kind: "electronic",
      quantity: 2,
      availableQuantity: 3,
      unit: "each",
      tags: [],
      links: [],
      evidence: { state: "physically_counted" }
    })).toThrow(/availableQuantity.*quantity/i);
  });

  it("rejects ledger-controlled fields from generic PATCH updates", () => {
    const forbidden = [
      { quantity: 2 },
      { availableQuantity: 2 },
      { evidence: { state: "physically_counted" } },
      { unit: "each" }
    ];
    for (const field of forbidden) expect(() => updateInventoryItemSchema.parse(field)).toThrow();
    expect(updateInventoryItemSchema.parse({ name: "Renamed", location: "drawer-B", tags: ["board"] })).toMatchObject({
      name: "Renamed", location: "drawer-B", tags: ["board"]
    });
  });
});
