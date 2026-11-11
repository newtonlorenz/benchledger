import { describe, expect, it } from "vitest";
import { classifyAvailability, createStockEvent, deriveStockBalance, StockLedger } from "./stock.js";
import { createId } from "./ids.js";
import type { InventoryItem } from "./types.js";

const item: InventoryItem = {
  id: "filament-1",
  name: "Test PLA",
  category: "filament",
  purchasedQuantity: 1,
  unit: "spool",
  sourceStatus: "physically_confirmed",
  reusePolicy: "available",
  confidence: "confirmed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("stock ledger", () => {
  it("keeps append-only events and calculates unallocated stock", () => {
    const first = createStockEvent({ id: "receipt-1", itemId: item.id, kind: "receipt", quantity: 10, unit: "piece", reason: "received", occurredAt: "2026-01-01T00:00:00.000Z" });
    const second = createStockEvent({ id: "allocate-1", itemId: item.id, kind: "allocate", quantity: 3, unit: "piece", reason: "project reservation", occurredAt: "2026-01-02T00:00:00.000Z" });
    const ledger = new StockLedger([first]).append(second);
    expect(ledger.events).toHaveLength(2);
    expect(ledger.balance(item)).toMatchObject({ onHand: 10, allocated: 3, available: 7 });
    expect(first).not.toHaveProperty("allocated");
  });

  it("supports an absolute physical count without destroying history", () => {
    const ledger = new StockLedger([
      createStockEvent({ id: "receipt-2", itemId: item.id, kind: "receipt", quantity: 10, unit: "piece", reason: "received", occurredAt: "2026-01-01T00:00:00.000Z" }),
      createStockEvent({ id: "count-1", itemId: item.id, kind: "count", quantity: 7, unit: "piece", reason: "physical count", occurredAt: "2026-01-03T00:00:00.000Z" })
    ]);
    expect(ledger.balance(item)).toMatchObject({ onHand: 7, available: 7, lastCountAt: "2026-01-03T00:00:00.000Z" });
    expect(ledger.events).toHaveLength(2);
  });

  it("rejects duplicate idempotency keys", () => {
    const event = createStockEvent({ id: "receipt-3", itemId: item.id, kind: "receipt", quantity: 1, unit: "piece", reason: "received", idempotencyKey: "import:one" });
    expect(() => new StockLedger([event, { ...event, id: "receipt-4" }])).toThrow(/idempotency/i);
  });

  it("classifies uncertainty separately from a confirmed shortfall", () => {
    expect(classifyAvailability({ required: 2, available: 2, confidence: "confirmed" }).status).toBe("available");
    expect(classifyAvailability({ required: 2, available: 1, confidence: "confirmed" }).status).toBe("partial");
    expect(classifyAvailability({ required: 2, available: 0, reported: 2, confidence: "inspect_first" }).status).toBe("inspect-first");
    expect(classifyAvailability({ required: 2, available: 0, confidence: "unknown", candidate: false }).status).toBe("missing");
  });

  it("does not mutate input event arrays", () => {
    const event = createStockEvent({ id: createId("receipt"), itemId: item.id, kind: "receipt", quantity: 1, unit: "piece", reason: "received" });
    const events = [event] as const;
    const derived = deriveStockBalance(item, events);
    expect(events).toHaveLength(1);
    expect(derived.available).toBe(1);
  });
});

describe("decimal ledger balances", () => {
  it("allocates a decimal on-hand quantity in full without a false over-allocation", () => {
    const item = { id: "decimal-item", name: "Decimal", category: "filament", purchasedQuantity: 0.3, unit: "gram" as const, sourceStatus: "physically_confirmed" as const, reusePolicy: "available" as const, confidence: "confirmed" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const at = "2026-01-01T00:00:00.000Z";
    const events = [
      createStockEvent({ id: "c", itemId: item.id, kind: "count", quantity: 0.3, unit: "gram", reason: "count", occurredAt: at, createdAt: at }),
      createStockEvent({ id: "a1", itemId: item.id, kind: "allocate", quantity: 0.1, unit: "gram", reason: "a", occurredAt: at, createdAt: at }),
      createStockEvent({ id: "a2", itemId: item.id, kind: "allocate", quantity: 0.2, unit: "gram", reason: "b", occurredAt: at, createdAt: at })
    ];
    expect(deriveStockBalance(item, events)).toMatchObject({ onHand: 0.3, allocated: 0.3, available: 0 });
  });
});

describe("ledger replay order", () => {
  const item = { id: "order-item", name: "Order", category: "parts", purchasedQuantity: 0, unit: "piece" as const, sourceStatus: "physically_confirmed" as const, reusePolicy: "available" as const, confidence: "confirmed" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

  it("orders mixed-precision timestamps chronologically", () => {
    // Lexically ".500Z" sorts before "Z", which would replay the consumption first.
    const events = [
      createStockEvent({ id: "consume", itemId: item.id, kind: "consume", quantity: 1, unit: "piece", reason: "use", occurredAt: "2026-01-01T00:00:00.500Z", createdAt: "2026-01-01T00:00:00.500Z" }),
      createStockEvent({ id: "receipt", itemId: item.id, kind: "receipt", quantity: 2, unit: "piece", reason: "in", occurredAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" })
    ];
    expect(deriveStockBalance(item, events)).toMatchObject({ onHand: 1 });
  });

  it("keeps input order for identical timestamps", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const events = [
      createStockEvent({ id: "z-receipt", itemId: item.id, kind: "receipt", quantity: 1, unit: "piece", reason: "in", occurredAt: at, createdAt: at }),
      createStockEvent({ id: "a-consume", itemId: item.id, kind: "consume", quantity: 1, unit: "piece", reason: "use", occurredAt: at, createdAt: at })
    ];
    expect(deriveStockBalance(item, events)).toMatchObject({ onHand: 0 });
    expect(() => deriveStockBalance(item, [...events].reverse())).toThrow(expect.objectContaining({ code: "negative_stock" }));
  });
});
