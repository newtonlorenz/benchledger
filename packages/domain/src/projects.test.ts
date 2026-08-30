import { describe, expect, it } from "vitest";
import { createBomLine, createProject, createProjectRevision, createReservation, evaluateBom, nextRevisionNumber, releaseReservation } from "./projects.js";
import { planReconciliation } from "./reconciliation.js";
import type { InventoryItem, Reservation, StockBalance } from "./types.js";

function snapshot(id: string, name: string, confidence: InventoryItem["confidence"], available: number, reported?: number) {
  const item: InventoryItem = {
    id,
    name,
    category: "electronics",
    purchasedQuantity: Math.max(available, reported ?? 0),
    unit: "board",
    sourceStatus: confidence === "confirmed" ? "physically_confirmed" : "delivered_uncounted",
    reusePolicy: confidence === "confirmed" ? "available" : "inspect_first",
    confidence,
    ...(reported === undefined ? {} : { reportedQuantity: reported }),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const balance: StockBalance = { itemId: id, onHand: available, allocated: 0, available, confidence, ...(reported === undefined ? {} : { reported }) };
  return { item, balance };
}

describe("project BOM domain", () => {
  it("creates human-readable project/revision defaults", () => {
    const project = createProject({ id: "p1", name: "Lamp Prototype" });
    const revision = createProjectRevision({ id: "pr1", projectId: project.id, number: 1 });
    expect(project.slug).toBe("lamp-prototype");
    expect(revision.label).toBe("r01");
    expect(nextRevisionNumber([revision])).toBe(2);
  });

  it("explains confirmed, partial, inspect-first and missing BOM lines", () => {
    const lines = [
      createBomLine({ id: "b1", revisionId: "r1", name: "ESP32", quantity: 1, unit: "board", itemId: "esp-ok" }),
      createBomLine({ id: "b2", revisionId: "r1", name: "ESP32", quantity: 2, unit: "board", itemId: "esp-partial" }),
      createBomLine({ id: "b3", revisionId: "r1", name: "ESP32", quantity: 1, unit: "board", itemId: "esp-inspect" }),
      createBomLine({ id: "b4", revisionId: "r1", name: "Unknown connector", quantity: 1, unit: "piece" })
    ];
    const result = evaluateBom(lines, [
      snapshot("esp-ok", "ESP32", "confirmed", 1),
      snapshot("esp-partial", "ESP32", "confirmed", 1),
      snapshot("esp-inspect", "ESP32", "inspect_first", 0, 1)
    ]);
    expect(result.lines.map((line) => line.status)).toEqual(["available", "partial", "inspect-first", "missing"]);
    expect(result.summary).toMatchObject({ availableLines: 1, partialLines: 1, inspectFirstLines: 1, missingLines: 1 });
    expect(result.shoppingList.map((line) => line.reason)).toEqual(["partial", "inspect-first", "required"]);
  });

  it("does not pool a different inventory item into an exact BOM line", () => {
    const line = createBomLine({ id: "b-exact", revisionId: "r1", name: "ESP32", quantity: 2, unit: "board", itemId: "esp-requested" });
    const result = evaluateBom([line], [
      snapshot("esp-requested", "ESP32", "confirmed", 1),
      snapshot("esp-unrelated", "ESP32", "confirmed", 99)
    ]);
    expect(result.lines[0]?.status).toBe("partial");
    expect(result.lines[0]?.supplied).toBe(1);
    expect(result.lines[0]?.candidates.map((candidate) => candidate.item.id)).toEqual(["esp-requested"]);
  });

  it("does not over-allocate stock and releases immutably", () => {
    const balance: StockBalance = { itemId: "esp", onHand: 2, allocated: 0, available: 2, confidence: "confirmed" };
    const first = createReservation({ id: "res1", projectRevisionId: "r1", bomLineId: "b1", itemId: "esp", quantity: 2 }, balance);
    expect(() => createReservation({ id: "res2", projectRevisionId: "r2", bomLineId: "b2", itemId: "esp", quantity: 1 }, balance, [first])).toThrow(/reserve/i);
    const released = releaseReservation(first, "2026-01-04T00:00:00.000Z");
    expect(first.status).toBe("active");
    expect(released.status).toBe("released");
  });

  it("combines compatible alternative candidates without treating uncertain stock as confirmed", () => {
    const line = createBomLine({ id: "b5", revisionId: "r1", name: "ESP32", quantity: 2, unit: "board", alternativeItemIds: ["esp-a", "esp-b"] });
    const result = evaluateBom(line ? [line] : [], [snapshot("esp-a", "ESP32", "confirmed", 1), snapshot("esp-b", "ESP32", "confirmed", 1)]);
    expect(result.lines[0]?.status).toBe("available");
    expect(result.lines[0]?.supplied).toBe(2);
  });

  it("allows reviewed_no_change only as the sole outcome on an unreserved line", () => {
    const line = createBomLine({ id: "b-reconcile", revisionId: "r-reconcile", name: "Unused board", quantity: 1, unit: "board" });
    const noChange = { bomLineId: line.id, outcomes: [{ kind: "reviewed_no_change" as const, quantity: 0, unit: "board" as const, evidence: { state: "physically_counted" } }] };
    const source = { revisionId: "r-reconcile", lines: [line], reservations: [], inventory: [] };
    expect(planReconciliation(source, [noChange], { requireComplete: true }).stockEvents).toEqual([]);

    const reservedItem = snapshot("reconcile-item", "Board", "confirmed", 1);
    const active = createReservation({ id: "reconcile-reservation", projectRevisionId: source.revisionId, bomLineId: line.id, itemId: reservedItem.item.id, quantity: 1 }, reservedItem.balance);
    const reservedSource = { ...source, reservations: [active], inventory: [reservedItem] };
    expect(() => planReconciliation(reservedSource, [noChange], { requireComplete: true })).toThrow(/sole outcome.*zero active reserved quantity/i);
    expect(() => planReconciliation(reservedSource, [{ ...noChange, outcomes: [noChange.outcomes[0]!, { kind: "consumed" as const, reservationId: active.id, quantity: 1, unit: "board" as const, evidence: { state: "consumed" } }] }], { requireComplete: true })).toThrow(/sole outcome.*zero active reserved quantity/i);
  });
});
