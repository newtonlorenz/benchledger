import { describe, expect, it } from "vitest";
import {
  DomainError,
  assertNonNegativeQuantity,
  assertPositiveQuantity,
  classifyAvailability,
  confidenceFromSourceStatus,
  consumeReservation,
  createAuditRecord,
  createBomLine,
  createId,
  createOfferSnapshot,
  createProject,
  createProjectRevision,
  createReservation,
  createStockEvent,
  createSupplier,
  createWorkItem,
  createWorkItemRevision,
  deriveStockBalance,
  estimatePurchase,
  evaluateBom,
  matchesConstraints,
  releaseReservation,
  slugify,
  StockLedger
} from "./index.js";
import type { InventoryItem, Reservation, StockBalance, StockEvent } from "./types.js";

const baseItem: InventoryItem = {
  id: "edge-item",
  name: "Edge board",
  category: "electronics",
  variant: "Rev A",
  purchasedQuantity: 10,
  unit: "piece",
  sourceStatus: "physically_confirmed",
  reusePolicy: "available",
  confidence: "confirmed",
  manufacturer: "Maker Co",
  model: "M-32",
  notes: "H2D ESP32 blue tag",
  dimensions: { width: 20, height: 30, depth: 5, diameter: 2, unit: "mm", kind: "measured", uncertainty: 0.1, source: "caliper" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

function balance(itemId: string, onHand: number, confidence: InventoryItem["confidence"] = "confirmed"): StockBalance {
  return { itemId, onHand, allocated: 0, available: onHand, confidence };
}

function reservation(status: Reservation["status"] = "active"): Reservation {
  return { id: "res-edge", projectRevisionId: "rev-edge", bomLineId: "bom-edge", itemId: "edge-item", quantity: 1, status, createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("domain validation and optional metadata", () => {
  it("covers explicit audit timestamps, versions and metadata without mutating the input actor", () => {
    const actor = { type: "agent" as const, id: "codex", label: "Codex" };
    const record = createAuditRecord({ id: "audit-edge", action: "item.updated", entityType: "inventory_item", entityId: "edge-item", actor, sourceSurface: "mcp", occurredAt: "2026-01-02T00:00:00.000Z", correlationId: "corr-edge", beforeVersion: 1, afterVersion: 2, metadata: { field: "notes" } });
    expect(record).toMatchObject({ occurredAt: "2026-01-02T00:00:00.000Z", correlationId: "corr-edge", beforeVersion: 1, afterVersion: 2, metadata: { field: "notes" } });
    expect(record.actor).not.toBe(actor);
  });

  it("rejects invalid quantities and preserves the DomainError code", () => {
    expect(() => assertPositiveQuantity(0, "zero")).toThrow(DomainError);
    expect(() => assertPositiveQuantity(Number.NaN, "nan")).toThrow(/nan/);
    expect(() => assertNonNegativeQuantity(-1, "negative")).toThrow(/negative/);
    expect(() => assertNonNegativeQuantity(Number.POSITIVE_INFINITY, "infinite")).toThrow(DomainError);
    const error = new DomainError("example", "example message");
    expect(error.code).toBe("example");
    expect(error.name).toBe("DomainError");
  });

  it("handles explicit and empty slug paths", () => {
    expect(slugify("  Café Lamp / Rev 2  ")).toBe("cafe-lamp-rev-2");
    expect(slugify("---")).toBe("project");
    expect(createId("edge")).toMatch(/^edge_[0-9a-f-]{36}$/);
  });

  it("validates project, work-item, revision and BOM inputs", () => {
    expect(() => createProject({ name: " " })).toThrow(/project name/i);
    expect(() => createWorkItem({ projectId: " ", name: "Part", kind: "part" })).toThrow(/projectId/i);
    expect(() => createWorkItem({ projectId: "p", name: " ", kind: "part" })).toThrow(/work item name/i);
    expect(() => createProjectRevision({ projectId: " ", number: 1 })).toThrow(/projectId/i);
    expect(() => createProjectRevision({ projectId: "p", number: 0 })).toThrow(/revision number/i);
    expect(() => createWorkItemRevision({ workItemId: " ", number: 1 })).toThrow(/workItemId/i);
    expect(() => createWorkItemRevision({ workItemId: "w", number: 0 })).toThrow(/revision number/i);
    expect(() => createBomLine({ revisionId: " ", name: "Part", quantity: 1, unit: "piece" })).toThrow(/revisionId/i);
    expect(() => createBomLine({ revisionId: "r", name: " ", quantity: 1, unit: "piece" })).toThrow(/BOM line name/i);
    expect(() => createBomLine({ revisionId: "r", name: "Part", quantity: 0, unit: "piece" })).toThrow(/quantity/i);
    const project = createProject({ id: "p-edge", name: "Project", slug: "explicit", description: "desc", status: "complete", visibility: "public_candidate", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });
    const work = createWorkItem({ id: "w-edge", projectId: project.id, name: "Part", kind: "part", description: "desc", createdAt: project.createdAt, updatedAt: project.updatedAt });
    const revision = createProjectRevision({ id: "pr-edge", projectId: project.id, number: 2, label: "prototype", status: "mesh validated", machineId: "H2D", material: "PETG", notes: "notes", createdAt: project.createdAt, supersedesRevisionId: "pr-old" });
    const workRevision = createWorkItemRevision({ id: "wr-edge", workItemId: work.id, number: 2, label: "prototype", status: "DFAM reviewed", sourcePath: "parts/example/r02", createdAt: project.createdAt, supersedesRevisionId: "wr-old" });
    const line = createBomLine({ id: "bom-edge", revisionId: revision.id, name: "Part", quantity: 1, unit: "piece", required: false, optional: true, itemId: baseItem.id, alternativeItemIds: ["alt"], constraints: { category: "electronics", manufacturer: "Maker", model: "M-32", variantIncludes: "Rev", machineId: "H2D", tags: ["ESP32"], dimensions: { width: 20 } }, notes: "note" });
    expect(project).toMatchObject({ slug: "explicit", description: "desc", status: "complete", visibility: "public_candidate" });
    expect(work.description).toBe("desc");
    expect(revision).toMatchObject({ label: "prototype", machineId: "H2D", material: "PETG", supersedesRevisionId: "pr-old" });
    expect(workRevision).toMatchObject({ sourcePath: "parts/example/r02", supersedesRevisionId: "wr-old" });
    expect(line).toMatchObject({ required: false, optional: true, alternativeItemIds: ["alt"], notes: "note" });
  });
});

describe("stock edge cases", () => {
  it("applies every ledger event kind while retaining immutable history", () => {
    const events: StockEvent[] = [
      createStockEvent({ id: "receipt", itemId: baseItem.id, kind: "receipt", quantity: 10, unit: "piece", reason: "received", occurredAt: "2026-01-01T00:00:00.000Z" }),
      createStockEvent({ id: "allocate", itemId: baseItem.id, kind: "allocate", quantity: 3, unit: "piece", reason: "reserved", occurredAt: "2026-01-02T00:00:00.000Z" }),
      createStockEvent({ id: "release", itemId: baseItem.id, kind: "release", quantity: 1, unit: "piece", reason: "released", occurredAt: "2026-01-03T00:00:00.000Z" }),
      createStockEvent({ id: "consume", itemId: baseItem.id, kind: "consume", quantity: 2, unit: "piece", reason: "used", occurredAt: "2026-01-04T00:00:00.000Z" }),
      createStockEvent({ id: "loss", itemId: baseItem.id, kind: "loss", quantity: 1, unit: "piece", reason: "damaged", occurredAt: "2026-01-05T00:00:00.000Z" }),
      createStockEvent({ id: "return", itemId: baseItem.id, kind: "return", quantity: 1, unit: "piece", reason: "returned", occurredAt: "2026-01-06T00:00:00.000Z" }),
      createStockEvent({ id: "adjust", itemId: baseItem.id, kind: "adjustment", quantity: -1, unit: "piece", reason: "correction", occurredAt: "2026-01-07T00:00:00.000Z" }),
      createStockEvent({ id: "evidence", itemId: baseItem.id, kind: "evidence", quantity: 0, unit: "piece", reason: "delivery evidence", occurredAt: "2026-01-08T00:00:00.000Z" })
    ];
    const ledger = new StockLedger(events);
    expect(ledger.balance(baseItem)).toMatchObject({ onHand: 7, allocated: 2, available: 5 });
    expect(deriveStockBalance(baseItem, events)).toMatchObject({ onHand: 7, allocated: 2 });
    expect(events).toHaveLength(8);
  });

  it("rejects invalid event references, quantities and ledger histories", () => {
    expect(() => createStockEvent({ itemId: " ", kind: "receipt", quantity: 1, unit: "piece", reason: "r" })).toThrow(/itemId/i);
    expect(() => createStockEvent({ itemId: "x", kind: "receipt", quantity: 1, unit: "piece", reason: " " })).toThrow(/reason/i);
    expect(() => createStockEvent({ itemId: "x", kind: "receipt", quantity: Number.NaN, unit: "piece", reason: "r" })).toThrow(/finite/i);
    expect(() => createStockEvent({ itemId: "x", kind: "receipt", quantity: 0, unit: "piece", reason: "r" })).toThrow(/greater than zero/i);
    const event = createStockEvent({ id: "duplicate", itemId: baseItem.id, kind: "receipt", quantity: 1, unit: "piece", reason: "r" });
    expect(() => new StockLedger([event, { ...event }])).toThrow(/duplicate stock event/i);
    const keyed = createStockEvent({ id: "key-one", itemId: baseItem.id, kind: "receipt", quantity: 1, unit: "piece", reason: "r", idempotencyKey: "same-key" });
    expect(() => new StockLedger([keyed, { ...keyed, id: "key-two" }])).toThrow(/idempotency/i);
    const ledger = new StockLedger([event]);
    expect(() => ledger.append({ ...event })).toThrow(/duplicate stock event/i);
    expect(() => ledger.append({ id: "another", itemId: baseItem.id, kind: "receipt", quantity: 1, unit: "piece", reason: "r", idempotencyKey: "same-event-key" })).not.toThrow();
  });

  it("rejects negative balances and supports count semantics", () => {
    expect(() => deriveStockBalance(baseItem, [createStockEvent({ id: "consume-too-much", itemId: baseItem.id, kind: "consume", quantity: 1, unit: "piece", reason: "used" })])).toThrow(/on-hand|negative/i);
    expect(() => deriveStockBalance(baseItem, [createStockEvent({ id: "release-too-much", itemId: baseItem.id, kind: "release", quantity: 1, unit: "piece", reason: "release" })])).toThrow(/allocation.*negative|negative.*allocation/i);
    expect(() => deriveStockBalance(baseItem, [createStockEvent({ id: "over-allocate", itemId: baseItem.id, kind: "receipt", quantity: 1, unit: "piece", reason: "received" }), createStockEvent({ id: "over-allocate-2", itemId: baseItem.id, kind: "allocate", quantity: 2, unit: "piece", reason: "reserved" })])).toThrow(/over.allocate/i);
    const counted = createStockEvent({ id: "count-edge", itemId: baseItem.id, kind: "count", quantity: 4, unit: "piece", reason: "physical count", occurredAt: "2026-01-03T00:00:00.000Z" });
    expect(counted.semantics).toBe("absolute_count");
    expect(deriveStockBalance(baseItem, [createStockEvent({ id: "receipt-edge", itemId: baseItem.id, kind: "receipt", quantity: 10, unit: "piece", reason: "received", occurredAt: "2026-01-01T00:00:00.000Z" }), counted]).lastCountAt).toBe(counted.occurredAt);
  });

  it("maps source evidence conservatively and classifies all availability states", () => {
    expect(confidenceFromSourceStatus("commissioned_available")).toBe("confirmed");
    expect(confidenceFromSourceStatus("physically_confirmed")).toBe("confirmed");
    expect(confidenceFromSourceStatus("delivered_uncounted")).toBe("inspect_first");
    expect(confidenceFromSourceStatus("shipped_available_baseline")).toBe("inspect_first");
    expect(confidenceFromSourceStatus("ordered_unverified")).toBe("ordered");
    expect(confidenceFromSourceStatus("unknown-status")).toBe("unknown");
    expect(classifyAvailability({ required: 0, available: 0, confidence: "unknown" }).status).toBe("available");
    expect(classifyAvailability({ required: 1, available: 0, confidence: "unknown", candidate: false }).status).toBe("missing");
    expect(classifyAvailability({ required: 2, available: 2, confidence: "confirmed" }).status).toBe("available");
    expect(classifyAvailability({ required: 2, available: 1, confidence: "confirmed" }).status).toBe("partial");
    expect(classifyAvailability({ required: 2, available: 0, confidence: "confirmed" }).status).toBe("missing");
    expect(classifyAvailability({ required: 2, available: 1, confidence: "inspect_first" }).status).toBe("inspect-first");
    expect(classifyAvailability({ required: 2, available: 0, confidence: "ordered", reported: 2 }).needsInspection).toBe(true);
    expect(classifyAvailability({ required: 2, available: 0, confidence: "unknown" }).status).toBe("missing");
    expect(() => classifyAvailability({ required: -1, available: 0, confidence: "unknown" })).toThrow(/required/i);
    expect(() => classifyAvailability({ required: 1, available: -1, confidence: "unknown" })).toThrow(/available/i);
    expect(() => classifyAvailability({ required: 1, available: 0, confidence: "unknown", reported: -1 })).toThrow(/reported/i);
  });
});

describe("BOM matching, reservation and procurement edges", () => {
  it("evaluates unconstrained descriptive and optional lines, including a cost map", () => {
    const descriptive = createBomLine({ id: "bom-descriptive", revisionId: "rev-edge", name: "Edge board", quantity: 2, unit: "piece" });
    const optional = createBomLine({ id: "bom-optional", revisionId: "rev-edge", name: "Optional clamp", quantity: 1, unit: "piece", optional: true, required: false });
    const result = evaluateBom([descriptive, optional], [{ item: baseItem, balance: balance(baseItem.id, 1) }], new Map([[descriptive.id, 1234], [optional.id, 999]]));
    expect(result.revisionId).toBe("rev-edge");
    expect(result.lines[0]?.status).toBe("partial");
    expect(result.lines[1]?.status).toBe("optional");
    expect(result.summary.optionalMissingLines).toBe(1);
    expect(result.summary.estimatedMissingCostMinor).toBe(1234);
    expect(result.shoppingList.map((line) => line.reason)).toEqual(["partial"]);
    expect(evaluateBom([], []).revisionId).toBe("");
  });

  it("checks every declared compatibility constraint and refuses unknown dimensions", () => {
    expect(matchesConstraints(baseItem, undefined)).toBe(true);
    expect(matchesConstraints(baseItem, { category: "electronics", manufacturer: "Maker", model: "M-32", variantIncludes: "Rev", machineId: "H2D", tags: ["ESP32"], dimensions: { width: 20, height: 30, depth: 5, diameter: 2 } })).toBe(true);
    expect(matchesConstraints(baseItem, { category: "filament" })).toBe(false);
    expect(matchesConstraints(baseItem, { manufacturer: "Other" })).toBe(false);
    expect(matchesConstraints(baseItem, { model: "Other" })).toBe(false);
    expect(matchesConstraints(baseItem, { variantIncludes: "Other" })).toBe(false);
    expect(matchesConstraints(baseItem, { machineId: "Ender" })).toBe(false);
    expect(matchesConstraints(baseItem, { tags: ["missing"] })).toBe(false);
    expect(matchesConstraints(baseItem, { dimensions: { width: 21 } })).toBe(false);
    const { dimensions, ...itemWithoutDimensions } = baseItem;
    expect(dimensions).toBeDefined();
    expect(matchesConstraints(itemWithoutDimensions, { dimensions: { width: 20 } })).toBe(false);
    expect(matchesConstraints(baseItem, { unsupported: "must not match" } as never)).toBe(false);
    expect(matchesConstraints(baseItem, { dimensions: { unsupported: 20 } } as never)).toBe(false);
  });

  it("requires active reservations and can consume or release them immutably", () => {
    const active = createReservation({ projectRevisionId: "rev-edge", bomLineId: "bom-edge", itemId: baseItem.id, quantity: 1 }, balance(baseItem.id, 2), [reservation("released")]);
    expect(active.status).toBe("active");
    expect(() => createReservation({ projectRevisionId: " ", bomLineId: "b", itemId: "i", quantity: 1 }, balance("i", 1))).toThrow(/references/i);
    expect(() => createReservation({ projectRevisionId: "r", bomLineId: "b", itemId: "i", quantity: 0 }, balance("i", 1))).toThrow(/quantity/i);
    expect(() => createReservation({ projectRevisionId: "r", bomLineId: "b", itemId: "i", quantity: 2 }, balance("i", 1))).toThrow(/reserve/i);
    expect(consumeReservation(active).status).toBe("consumed");
    expect(releaseReservation(active, "2026-01-02T00:00:00.000Z").status).toBe("released");
    expect(() => releaseReservation(reservation("released"))).toThrow(/active/i);
    expect(() => consumeReservation(reservation("consumed"))).toThrow(/active/i);
  });

  it("validates offer inputs, optional fields, filtering and package estimates", () => {
    expect(() => createSupplier({ name: " " })).toThrow(/supplier name/i);
    const supplier = createSupplier({ name: "  Other Shop  ", website: "https://shop.example", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(supplier).toMatchObject({ name: "Other Shop", website: "https://shop.example" });
    expect(() => createOfferSnapshot({ itemId: " ", supplierId: "s", url: "https://shop.example", packageQuantity: 1, packageUnit: "piece", priceMinor: 1, currency: "EUR" })).toThrow(/required|reference/i);
    expect(() => createOfferSnapshot({ itemId: "i", supplierId: "s", url: "ftp://shop.example", packageQuantity: 1, packageUnit: "piece", priceMinor: 1, currency: "EUR" })).toThrow(/URL/i);
    expect(() => createOfferSnapshot({ itemId: "i", supplierId: "s", url: "https://shop.example", packageQuantity: 0, packageUnit: "piece", priceMinor: 1, currency: "EUR" })).toThrow(/package quantity/i);
    expect(() => createOfferSnapshot({ itemId: "i", supplierId: "s", url: "https://shop.example", packageQuantity: 1, packageUnit: "piece", priceMinor: -1, currency: "EUR" })).toThrow(/price/i);
    expect(() => createOfferSnapshot({ itemId: "i", supplierId: "s", url: "https://shop.example", packageQuantity: 1, packageUnit: "piece", priceMinor: 1, currency: "eur" })).toThrow(/currency/i);
    const offer = createOfferSnapshot({ id: "offer-edge", itemId: baseItem.id, supplierId: supplier.id, url: "https://shop.example/board", title: "Board pack", packageQuantity: 2, packageUnit: "piece", priceMinor: 1234, currency: "EUR", observedAt: "2026-01-03T00:00:00.000Z", availability: "in_stock", notes: "observed" });
    expect(offer).toMatchObject({ title: "Board pack", availability: "in_stock", notes: "observed" });
    expect(() => estimatePurchase(baseItem, 0, offer)).toThrow(/required quantity/i);
    expect(estimatePurchase(baseItem, 3, offer).totalMinor).toBe(2468);
  });
});
