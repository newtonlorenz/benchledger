import { describe, expect, it } from "vitest";
import { bomSpecificationSchema, commissionInventoryItemSchema, createBomLineSchema, createInventoryItemSchema, inventoryBulkUpdateSchema, inventoryItemSchema, inventoryListQuerySchema, updateBomLineSchema, updateInventoryItemSchema } from "./schemas.js";

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

  it("accepts only the closed specification decision vocabulary", () => {
    const incomplete = { status: "insufficient", missingDecisions: ["current_or_load", "connector"] } as const;
    const sufficient = { status: "sufficient", decisions: { voltage: "12 V", current_or_load: "5 A", connector: "5.5 x 2.1 mm barrel, centre-positive" } } as const;
    expect(bomSpecificationSchema.parse(incomplete)).toEqual(incomplete);
    expect(bomSpecificationSchema.parse(sufficient)).toEqual(sufficient);
    expect(createBomLineSchema.parse({
      name: "12 V power supply",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [],
      constraints: { specification: incomplete },
    }).constraints.specification).toEqual(incomplete);
    expect(() => bomSpecificationSchema.parse({ status: "insufficient", missingDecisions: ["unknown_decision"] })).toThrow();
    expect(() => bomSpecificationSchema.parse({ status: "sufficient", missingDecisions: ["connector"] })).toThrow();
    expect(() => bomSpecificationSchema.parse({ status: "sufficient" })).toThrow();
  });
});

describe("REST inventory pagination filters", () => {
  it("accepts one managed assignment filter and rejects ambiguous combinations", () => {
    expect(inventoryListQuerySchema.parse({ categoryNodeId: "category-tools", limit: "25" })).toMatchObject({ categoryNodeId: "category-tools", limit: 25 });
    expect(inventoryListQuerySchema.parse({ unassigned: "true", limit: "25" })).toMatchObject({ unassigned: true, limit: 25 });
    expect(() => inventoryListQuerySchema.parse({ categoryNodeId: "category-tools", unassigned: "true" })).toThrow();
  });
});

describe("REST inventory quantity invariants", () => {
  const persistedItem = {
    id: "item-esp32",
    name: "ESP32 board",
    kind: "electronic" as const,
    quantity: 2,
    availableQuantity: 1,
    allocatedQuantity: 1,
    unit: "each" as const,
    tags: [],
    links: [],
    evidence: { state: "physically_counted" as const },
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
    version: 1,
  };

  it("requires persisted allocated quantity to reconcile on-hand and available stock", () => {
    expect(inventoryItemSchema.parse(persistedItem)).toMatchObject({ quantity: 2, availableQuantity: 1, allocatedQuantity: 1 });
    expect(() => inventoryItemSchema.parse({ ...persistedItem, allocatedQuantity: 0 })).toThrow(/quantity minus availableQuantity/i);
    expect(() => inventoryItemSchema.parse({ ...persistedItem, availableQuantity: 3, allocatedQuantity: 0 })).toThrow(/availableQuantity.*quantity/i);
    expect(inventoryItemSchema.parse({ ...persistedItem, quantity: 2, availableQuantity: 0, allocatedQuantity: 0, evidence: { state: "delivered_uncounted" } })).toMatchObject({ quantity: 2, availableQuantity: 0, allocatedQuantity: 0 });
  });

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

describe("REST inventory commissioning contract", () => {
  it("requires an observed quantity, matching unit, and commissioned evidence", () => {
    expect(commissionInventoryItemSchema.parse({
      quantity: 1,
      unit: "each",
      evidence: { state: "commissioned", source: "bench-test", observedAt: "2026-08-31T10:00:00.000Z" }
    })).toMatchObject({ quantity: 1, unit: "each", evidence: { state: "commissioned" } });
    expect(() => commissionInventoryItemSchema.parse({
      quantity: 1,
      unit: "each",
      evidence: { state: "delivered_uncounted", source: "bench-test" }
    })).toThrow();
  });
});

describe("REST inventory bulk-update schema", () => {
  const valid = {
    targets: [
      { itemId: "item-b", expectedVersion: 2 },
      { itemId: "item-a", expectedVersion: 1 },
    ],
    changes: {
      location: "  Shelf A  ",
      tags: { add: ["  PETG", "petg", "black"], remove: ["old"] },
    },
  };

  it("normalizes and deduplicates metadata changes while preserving explicit target versions", () => {
    expect(inventoryBulkUpdateSchema.parse(valid)).toEqual({
      targets: valid.targets,
      changes: {
        location: "Shelf A",
        tags: { add: ["PETG", "black"], remove: ["old"] },
      },
    });
  });

  it.each([
    ["duplicate target ids", { ...valid, targets: [{ itemId: "item-a", expectedVersion: 1 }, { itemId: "item-a", expectedVersion: 2 }] }],
    ["missing opt-in change", { ...valid, changes: {} }],
    ["empty location", { ...valid, changes: { location: "   " } }],
    ["add/remove overlap", { ...valid, changes: { tags: { add: ["Shelf"], remove: [" shelf "] } } }],
    ["more than one hundred targets", { ...valid, targets: Array.from({ length: 101 }, (_, index) => ({ itemId: `item-${index}`, expectedVersion: 1 })) }],
  ])("rejects %s", (_label, input) => {
    expect(() => inventoryBulkUpdateSchema.parse(input)).toThrow();
  });
});
