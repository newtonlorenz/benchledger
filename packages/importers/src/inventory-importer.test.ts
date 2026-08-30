import { describe, expect, it } from "vitest";
import { buildImportPlan, importInventory, parseInventoryDocument, type InventoryImportTarget } from "./inventory-importer.js";
import type { InventoryItem, StockEvent } from "@benchledger/domain";

const source = {
  schema_version: 1,
  as_of: "2026-01-10",
  currency: "EUR",
  items: [
    {
      id: "board-a",
      category: "electronics",
      name: "Synthetic ESP32 board",
      purchased_qty: 2,
      unit: "board",
      status: "physically_confirmed",
      reuse_policy: "available",
      source: { vendor: "Synthetic Parts", order: "redacted-fixture-order", unit_price: 4.5 },
      notes: "Synthetic test data only."
    },
    {
      id: "filament-a",
      category: "filament",
      name: "Synthetic PLA",
      variant: "Black, 1 kg",
      purchased_qty: 1,
      unit: "spool",
      status: "delivered_uncounted",
      reuse_policy: "inspect_first",
      source: { vendor: "Synthetic Parts", orders: ["redacted-fixture-order"] }
    }
  ]
} as const;

class MemoryTarget implements InventoryImportTarget {
  readonly items = new Map<string, InventoryItem>();
  readonly events = new Map<string, StockEvent>();
  upsertCount = 0;

  get(id: string): InventoryItem | undefined { return this.items.get(id); }
  upsert(item: InventoryItem): void { this.items.set(item.id, item); this.upsertCount += 1; }
  appendStockEvent(event: StockEvent): { inserted: boolean; event: StockEvent } {
    const existing = [...this.events.values()].find((candidate) => candidate.idempotencyKey === event.idempotencyKey);
    if (existing !== undefined) return { inserted: false, event: existing };
    this.events.set(event.id, event);
    return { inserted: true, event };
  }
}

describe("private inventory importer", () => {
  it("validates and normalizes the documented source shape", () => {
    const parsed = parseInventoryDocument(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.id).toBe("board-a");
    expect(() => parseInventoryDocument({ schema_version: 1, currency: "EUR", items: [{ id: "duplicate", category: "other", name: "x", purchased_qty: 1, unit: "piece", status: "unknown" }, { id: "duplicate", category: "other", name: "y", purchased_qty: 1, unit: "piece", status: "unknown" }] })).toThrow(/duplicate/i);
  });

  it("builds deterministic, evidence-aware import plans", () => {
    const first = buildImportPlan(source, { sourceKey: "synthetic-v1", importedAt: "2026-01-10T12:00:00.000Z" });
    const second = buildImportPlan(source, { sourceKey: "synthetic-v1", importedAt: "2026-01-10T12:00:00.000Z" });
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.confidence).toBe("confirmed");
    expect(first.items[1]?.confidence).toBe("inspect_first");
    expect(first.events.map((event) => event.kind)).toEqual(["receipt", "evidence"]);
    expect(first.events.map((event) => event.id)).toEqual(second.events.map((event) => event.id));
    expect(first.items[1]?.reportedQuantity).toBe(1);
  });

  it("is safe to run repeatedly without duplicating stock", () => {
    const target = new MemoryTarget();
    const first = importInventory(source, target, { sourceKey: "synthetic-v1", importedAt: "2026-01-10T12:00:00.000Z" });
    const second = importInventory(source, target, { sourceKey: "synthetic-v1", importedAt: "2026-01-10T12:00:00.000Z" });
    expect(first.createdItems).toBe(2);
    expect(first.insertedEvents).toBe(2);
    expect(second.insertedEvents).toBe(0);
    expect(target.items.size).toBe(2);
    expect(target.events.size).toBe(2);
    expect(target.upsertCount).toBe(4);
  });
});
