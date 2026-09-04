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
    expect(result.shoppingList.map((line) => line.reason)).toEqual(["partial", "required"]);
  });

  it("keeps specification decisions and source readiness separate", () => {
    const lines = [
      createBomLine({
        id: "b-power",
        revisionId: "r1",
        name: "12 V power supply",
        quantity: 1,
        unit: "piece",
        constraints: { specification: { status: "insufficient", decisions: { current_or_load: "5 A" }, missingDecisions: ["voltage"] } }
      }),
      createBomLine({ id: "b-source", revisionId: "r1", name: "Controller", quantity: 1, unit: "piece", constraints: { specification: { status: "sufficient", decisions: { identity: "CTRL-1" } } } }),
      createBomLine({ id: "b-optional", revisionId: "r1", name: "Optional cover", quantity: 1, unit: "piece", optional: true, required: false }),
      createBomLine({ id: "b-check", revisionId: "r1", name: "Inspection board", quantity: 1, unit: "board", itemId: "inspect", constraints: { specification: { status: "sufficient", decisions: { identity: "INSPECT-1" } } } })
    ];
    const result = evaluateBom(lines, [
      snapshot("inspect", "Inspection board", "inspect_first", 0, 1),
      snapshot("other", "Other", "confirmed", 1)
    ]);

    expect(result.lines.map((line) => [line.status, line.decision])).toEqual([
      ["specify-first", "decide"],
      ["missing", "source"],
      ["optional", "source"],
      ["inspect-first", "check"]
    ]);
    expect(result.lines[0]).toMatchObject({ missingDecisions: ["voltage", "connector"] });
    expect(result.summary).toMatchObject({ decideLines: 1, sourceLines: 1, checkLines: 1, optionalLines: 1 });
    expect(result.shoppingList.map((line) => line.bomLineId)).toEqual(["b-source"]);
  });

  it("keeps an exact item with conditional compatibility in Check", () => {
    const line = createBomLine({
      id: "b-conditional",
      revisionId: "r1",
      name: "Controller",
      quantity: 1,
      unit: "board",
      itemId: "conditional",
      alternatives: [{ id: "alt-conditional", bomLineId: "b-conditional", itemId: "conditional", label: "Same item", compatible: "conditional" }]
    });
    const result = evaluateBom([line], [snapshot("conditional", "Controller", "confirmed", 1)]);

    expect(result.lines[0]).toMatchObject({ status: "inspect-first", decision: "check", supplied: 0, shortfall: 1 });
    expect(result.shoppingList).toEqual([]);
  });

  it("uses structured alternatives even when the legacy alternative ID list is absent", () => {
    const line = createBomLine({
      id: "b-structured-alternative",
      revisionId: "r1",
      name: "Controller",
      quantity: 1,
      unit: "board",
      alternatives: [{ id: "alt-structured", bomLineId: "b-structured-alternative", itemId: "structured", label: "Reviewed replacement", compatible: "confirmed" }]
    });
    const result = evaluateBom([line], [snapshot("structured", "Different product name", "confirmed", 1)]);

    expect(result.lines[0]).toMatchObject({ status: "available", decision: "ready", supplied: 1, shortfall: 0 });
    expect(result.lines[0]?.candidates.map((candidate) => candidate.item.id)).toEqual(["structured"]);
    expect(result.lines[0]?.candidates[0]?.reason).toBe("Explicit BOM alternative matches this inventory item.");
  });

  it("allocates confirmed whole-set alternatives in BOM units", () => {
    const line = createBomLine({
      id: "b-set-conversion",
      revisionId: "r1",
      name: "LED",
      quantity: 12,
      unit: "piece",
      alternatives: [{
        id: "alt-set-conversion",
        bomLineId: "b-set-conversion",
        itemId: "led-set",
        label: "Ten LEDs per set",
        compatible: "confirmed",
        quantityConversion: {
          inventory: { quantity: 1, unit: "set" },
          requirement: { quantity: 10, unit: "piece" },
          evidence: { basis: "package_label", source: "package label", observedAt: "2026-09-02T10:00:00.000Z" }
        }
      }]
    });
    const item: InventoryItem = {
      id: "led-set",
      name: "LED set",
      category: "electronics",
      purchasedQuantity: 2,
      unit: "set",
      sourceStatus: "physically_confirmed",
      reusePolicy: "available",
      confidence: "confirmed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const result = evaluateBom([line], [{ item, balance: { itemId: item.id, onHand: 2, allocated: 0, available: 2, confidence: "confirmed" } }]);
    expect(result.lines[0]).toMatchObject({ status: "available", supplied: 12, shortfall: 0 });
  });

  it("keeps a unit mismatch visible for checking and never supplies it implicitly", () => {
    const line = createBomLine({
      id: "b-set-mismatch",
      revisionId: "r1",
      name: "LED",
      quantity: 10,
      unit: "piece",
      alternatives: [{ id: "alt-set-mismatch", bomLineId: "b-set-mismatch", itemId: "led-set-mismatch", label: "Unconverted set", compatible: "confirmed" }]
    });
    const item: InventoryItem = {
      id: "led-set-mismatch",
      name: "LED set",
      category: "electronics",
      purchasedQuantity: 1,
      unit: "set",
      sourceStatus: "physically_confirmed",
      reusePolicy: "available",
      confidence: "confirmed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const result = evaluateBom([line], [{ item, balance: { itemId: item.id, onHand: 1, allocated: 0, available: 1, confidence: "confirmed" } }]);
    expect(result.lines[0]).toMatchObject({ status: "inspect-first", supplied: 0, shortfall: 10 });
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
