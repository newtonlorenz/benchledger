import { describe, expect, it } from "vitest";
import { createBomLine, createProject, createProjectRevision, createReservation, nextRevisionNumber, releaseReservation } from "./projects.js";
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

  it("does not over-allocate stock and releases immutably", () => {
    const balance: StockBalance = { itemId: "esp", onHand: 2, allocated: 0, available: 2, confidence: "confirmed" };
    const first = createReservation({ id: "res1", projectRevisionId: "r1", bomLineId: "b1", itemId: "esp", quantity: 2 }, balance);
    expect(() => createReservation({ id: "res2", projectRevisionId: "r2", bomLineId: "b2", itemId: "esp", quantity: 1 }, balance, [first])).toThrow(/reserve/i);
    const released = releaseReservation(first, "2026-01-04T00:00:00.000Z");
    expect(first.status).toBe("active");
    expect(released.status).toBe("released");
  });

  it("allows reviewed_no_change only as the sole outcome on an unreserved line", () => {
    const line = createBomLine({ id: "b-reconcile", revisionId: "r-reconcile", name: "Unused board", role: "consumed", quantity: 1, unit: "board" });
    const noChange = { bomLineId: line.id, outcomes: [{ kind: "reviewed_no_change" as const, quantity: 0, unit: "board" as const, evidence: { state: "physically_counted" } }] };
    const source = { revisionId: "r-reconcile", lines: [line], reservations: [], inventory: [] };
    expect(planReconciliation(source, [noChange], { requireComplete: true }).stockEvents).toEqual([]);

    const reservedItem = snapshot("reconcile-item", "Board", "confirmed", 1);
    const active = createReservation({ id: "reconcile-reservation", projectRevisionId: source.revisionId, bomLineId: line.id, itemId: reservedItem.item.id, quantity: 1 }, reservedItem.balance);
    const reservedSource = { ...source, reservations: [active], inventory: [reservedItem] };
    expect(() => planReconciliation(reservedSource, [noChange], { requireComplete: true })).toThrow(/sole outcome.*zero active reserved quantity/i);
    expect(() => planReconciliation(reservedSource, [{ ...noChange, outcomes: [noChange.outcomes[0]!, { kind: "consumed" as const, reservationId: active.id, quantity: 1, unit: "board" as const, evidence: { state: "consumed" } }] }], { requireComplete: true })).toThrow(/sole outcome.*zero active reserved quantity/i);
  });

  it.each([
    ["returned", null],
    ["usable_leftover", null],
    ["returned", "reusable"],
    ["usable_leftover", "reusable"]
  ] as const)("rejects %s reconciliation for a %s-role BOM line", (kind, role) => {
    const line = createBomLine({ id: `b-reconcile-${kind}-${role ?? "legacy"}`, revisionId: "r-reconcile-role", name: "Reviewed stock", role, quantity: 1, unit: "board" });
    const reservedItem = snapshot(`reconcile-${kind}-${role ?? "legacy"}`, "Board", "confirmed", 1);
    const active = createReservation({ id: `reservation-${kind}-${role ?? "legacy"}`, projectRevisionId: "r-reconcile-role", bomLineId: line.id, itemId: reservedItem.item.id, quantity: 1 }, { ...reservedItem.balance, allocated: 1, available: 0 });
    const source = { revisionId: "r-reconcile-role", lines: [line], reservations: [active], inventory: [{ ...reservedItem, balance: { ...reservedItem.balance, allocated: 1, available: 0 } }] };
    const outcome = { bomLineId: line.id, outcomes: [{ kind, reservationId: active.id, itemId: active.itemId, quantity: 1, unit: "board" as const, evidence: { state: "physically_counted" as const } }] };

    expect(() => planReconciliation(source, [outcome], { requireComplete: true })).toThrow(/role|only consumed/i);
  });

  it.each([null, "reusable"] as const)("rejects reviewed_no_change for a %s-role BOM line", (role) => {
    const line = createBomLine({ id: `b-reconcile-no-change-${role ?? "legacy"}`, revisionId: "r-reconcile-role", name: "Unreviewed stock", role, quantity: 1, unit: "board" });
    const source = { revisionId: "r-reconcile-role", lines: [line], reservations: [], inventory: [] };
    const outcome = { bomLineId: line.id, outcomes: [{ kind: "reviewed_no_change" as const, quantity: 0, unit: "board" as const, evidence: { state: "physically_counted" as const } }] };

    expect(() => planReconciliation(source, [outcome], { requireComplete: true })).toThrow(/role|only consumed/i);
  });

  it("completes close-out from active reservations without reviewing every zero-reservation BOM line", () => {
    const lines = Array.from({ length: 22 }, (_, index) => createBomLine({
      id: `b-closeout-${index + 1}`,
      revisionId: "r-closeout",
      name: `Fitzroy Cafe part ${index + 1}`,
      role: "consumed",
      quantity: 1,
      unit: "board"
    }));
    const inventory = [1, 2, 3].map((index) => {
      const reserved = snapshot(`closeout-item-${index}`, `Board ${index}`, "confirmed", 1);
      return { ...reserved, balance: { ...reserved.balance, allocated: 1, available: 0 } };
    });
    const reservations = inventory.map((entry, index) => createReservation({
      id: `closeout-reservation-${index + 1}`,
      projectRevisionId: "r-closeout",
      bomLineId: lines[index]!.id,
      itemId: entry.item.id,
      quantity: 1
    }, entry.balance));
    const source = { revisionId: "r-closeout", lines, reservations, inventory };
    const outcomes = reservations.map((reservation) => ({
      bomLineId: reservation.bomLineId,
      outcomes: [{
        kind: "consumed" as const,
        reservationId: reservation.id,
        itemId: reservation.itemId,
        quantity: 1,
        unit: "board" as const,
        evidence: { state: "physically_counted" as const }
      }]
    }));

    const plan = planReconciliation(source, outcomes, { requireComplete: true });
    expect(plan.settlements).toHaveLength(3);
    expect(plan.stockEvents.filter((event) => event.kind === "release")).toHaveLength(3);
    expect(plan.stockEvents.filter((event) => event.kind === "consume")).toHaveLength(3);
    expect(() => planReconciliation(source, outcomes.slice(0, 2), { requireComplete: true })).toThrow(/closeout-reservation-3/);
  });
});
