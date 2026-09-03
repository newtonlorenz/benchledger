import { describe, expect, it } from "vitest";
import type { BomGap, BomLine, InventoryItem } from "@benchledger/api-contract";
import { deriveInspectionActions, inspectionActionId, normalizeInspectionPredicate, pageInspectionActions } from "./inspection.js";

const item = (overrides: Partial<InventoryItem> = {}): InventoryItem => ({
  id: "item-1", name: "Power supply", kind: "electronic", quantity: 1, availableQuantity: 1, unit: "each",
  tags: [], links: [], evidence: { state: "delivered_uncounted" },
  createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 3, ...overrides
});
const line = (overrides: Partial<BomLine> = {}): BomLine => ({
  id: "line-1", revisionId: "revision-1", name: "Sensor power", requiredQuantity: 1, unit: "each", optional: false,
  constraints: {}, alternatives: [], createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 2, ...overrides
});
const gap = (overrides: Partial<BomGap> = {}): BomGap => ({
  lineId: "line-1", name: "Sensor power", optional: false, status: "inspect_first", decision: "check",
  requiredQuantity: 1, suppliedQuantity: 0, inspectQuantity: 1, missingQuantity: 0, unit: "each",
  matchedItemIds: ["item-1"], reasons: [], alternatives: [], candidates: [{
    itemId: "item-1", relationship: "exact", compatibility: "confirmed", availableQuantity: 1,
    suppliedQuantity: 0, inspectQuantity: 1, reason: "Needs inspection"
  }], ...overrides
});

describe("inspection queue derivation", () => {
  it("deduplicates shared count actions, aggregates line IDs and versions, and is order independent", () => {
    const lines = [line(), line({ id: "line-2", name: "Backup power", version: 7 })];
    const gaps = [gap(), gap({ lineId: "line-2", name: "Backup power", candidates: [{
      itemId: "item-1", relationship: "exact", compatibility: "conditional", availableQuantity: 1,
      suppliedQuantity: 0, inspectQuantity: 1, reason: "Needs inspection"
    }] })];
    const first = deriveInspectionActions("revision-1", gaps, lines, [item()]);
    const second = deriveInspectionActions("revision-1", gaps.toReversed(), lines.toReversed(), [item()]);
    expect(first).toEqual(second);
    const physical = first.find((action) => action.kind === "physical_quantity");
    expect(physical).toMatchObject({
      kind: "physical_quantity", itemId: "item-1", itemVersion: 3,
      lineIds: ["line-1", "line-2"],
      lineVersions: [{ lineId: "line-1", version: 2 }, { lineId: "line-2", version: 7 }],
      candidate: { id: "item-1", version: 3, name: "Power supply", unit: "each", evidence: { state: "delivered_uncounted" } },
      possibleResults: ["confirmed", "inconclusive"], requiresHumanConfirmation: true,
      basis: { itemVersion: 3 }
    });
  });

  it("does not create actions for Decide, Source, or Ready lines", () => {
    const noAction = ["decide", "source", "ready"].map((decision) => gap({ decision: decision as BomGap["decision"], status: decision === "ready" ? "supplied" : decision === "decide" ? "specify_first" : "missing" }));
    expect(deriveInspectionActions("revision-1", noAction, [line()], [item()])).toEqual([]);
  });

  it("does not reintroduce legacy constraint-only candidates into inspections", () => {
    const legacyConstraintCandidate = {
      itemId: "item-1", relationship: "constraint_match" as const, compatibility: "unknown" as const,
      availableQuantity: 1, suppliedQuantity: 0, inspectQuantity: 1, reason: "Legacy broad constraint match",
    };
    expect(deriveInspectionActions("revision-1", [gap({ candidates: [legacyConstraintCandidate] })], [line()], [item()])).toEqual([]);
  });

  it("skips retired or missing line and inventory candidates", () => {
    const retiredLine = line({ id: "retired-line", retiredAt: "2026-09-01T00:00:00.000Z" });
    const missingLineGap = gap({ lineId: "missing-line" });
    const retiredItem = item({ id: "retired-item", retiredAt: "2026-09-01T00:00:00.000Z" });
    const missingItemGap = gap({ candidates: [{ itemId: "missing-item", relationship: "exact", compatibility: "confirmed", availableQuantity: 1, suppliedQuantity: 0, inspectQuantity: 1, reason: "Needs inspection" }] });
    const retiredItemGap = gap({ candidates: [{ itemId: retiredItem.id, relationship: "exact", compatibility: "confirmed", availableQuantity: 1, suppliedQuantity: 0, inspectQuantity: 1, reason: "Needs inspection" }] });

    expect(deriveInspectionActions("revision-1", [missingLineGap, gap({ lineId: retiredLine.id }), missingItemGap, retiredItemGap], [line(), retiredLine], [item(), retiredItem])).toEqual([]);
  });

  it("handles duplicate actions with changed compatibility and malformed or mismatched conversions", () => {
    const setItem = item({ id: "set-item", unit: "set", evidence: { state: "physically_counted" } });
    const first = line({ id: "set-line-a", unit: "each", constraints: undefined as never, alternatives: [
      { itemId: "other-item", compatible: "unknown" },
      { itemId: setItem.id, compatible: "conditional", quantityConversion: { inventory: { quantity: 1, unit: "set" }, requirement: { quantity: 10, unit: "gram" as never }, evidence: { basis: "package_label", observedAt: "2026-08-30T00:00:00.000Z" } } }
    ] });
    const second = line({ id: "set-line-b", unit: "each", constraints: {}, alternatives: [{ itemId: setItem.id, compatible: "unknown" }] });
    const candidate = { itemId: setItem.id, relationship: "uncertain_alternative" as const, compatibility: "conditional" as const, availableQuantity: 1, suppliedQuantity: 0, inspectQuantity: 1, reason: "Needs inspection" };
    const actions = deriveInspectionActions("revision-1", [gap({ lineId: first.id, candidates: [candidate] }), gap({ lineId: second.id, candidates: [{ ...candidate, compatibility: "unknown" }] })], [first, second], [setItem]);

    expect(actions.filter((action) => action.kind === "unit_conversion")).toHaveLength(1);
    expect(actions.filter((action) => action.kind === "compatibility")).toHaveLength(1);
    expect(actions.find((action) => action.kind === "compatibility")?.compatibility).toBe("unknown");

    const valid = line({ id: "set-line-valid", unit: "each", alternatives: [{
      itemId: setItem.id,
      compatible: "confirmed",
      quantityConversion: { inventory: { quantity: 1, unit: "set" }, requirement: { quantity: 10, unit: "each" }, evidence: { basis: "package_label", observedAt: "2026-08-30T00:00:00.000Z" } }
    }] });
    const validGap = gap({ lineId: valid.id, candidates: [{ ...candidate, compatibility: "confirmed" }] });
    expect(deriveInspectionActions("revision-1", [validGap], [valid], [setItem])).toEqual([]);
  });

  it("keeps compatibility and conversion predicates separate and excludes line IDs from identity", () => {
    const uncertain = item({ unit: "set", evidence: { state: "physically_counted" }});
    const candidate = { itemId: uncertain.id, relationship: "uncertain_alternative" as const, compatibility: "unknown" as const, availableQuantity: 1, suppliedQuantity: 0, inspectQuantity: 1, reason: "Needs inspection" };
    const result = deriveInspectionActions("revision-1", [gap({ candidates: [candidate], unit: "each" })], [line({ unit: "each", alternatives: [{ itemId: uncertain.id, compatible: "unknown" }] })], [uncertain]);
    expect(result.map((action) => action.kind).sort()).toEqual(["compatibility", "unit_conversion"]);
    expect(result.every((action) => !action.normalizedPredicate.includes("line-1"))).toBe(true);
    expect(result.every((action) => action.id === inspectionActionId("revision-1", action.itemId, action.kind, action.normalizedPredicate))).toBe(true);
    expect(normalizeInspectionPredicate({ b: 2, a: 1 })).toBe(normalizeInspectionPredicate({ a: 1, b: 2 }));
  });

  it("deduplicates four physical compatibility questions by predicate, not labels or quantities", () => {
    const board = item({ id: "esp32-shared", name: "ESP32-S3 board", evidence: { state: "physically_counted" } });
    const lines = [1, 2, 3, 4].map((index) => line({
      id: `esp-line-${index}`,
      name: index % 2 === 0 ? "Controller board" : "Backup controller",
      requiredQuantity: index,
      constraints: { kind: "electronic", model: "ESP32-S3", tag: "controller" },
      alternatives: [{ itemId: board.id, compatible: "unknown" }],
    }));
    const gaps = lines.map((candidateLine) => gap({
      lineId: candidateLine.id,
      name: candidateLine.name,
      requiredQuantity: candidateLine.requiredQuantity,
      candidates: [{ itemId: board.id, relationship: "uncertain_alternative", compatibility: "unknown", availableQuantity: 1, suppliedQuantity: 0, inspectQuantity: 1, reason: "Needs compatibility confirmation" }],
      matchedItemIds: [board.id],
    }));
    const actions = deriveInspectionActions("revision-1", gaps, lines, [board]);
    const compatibility = actions.filter((action) => action.kind === "compatibility");
    expect(compatibility).toHaveLength(1);
    expect(compatibility[0]).toMatchObject({
      lineIds: lines.map((candidate) => candidate.id).sort(),
      expected: { quantity: 10, lineIds: lines.map((candidate) => candidate.id).sort(), lineRequirements: expect.arrayContaining([
        { lineId: "esp-line-1", quantity: 1, unit: "each" },
        { lineId: "esp-line-4", quantity: 4, unit: "each" },
      ]) },
    });

    const distinct = deriveInspectionActions("revision-1", [
      ...gaps,
      gap({ lineId: "esp-line-distinct", name: "Other board", candidates: [{ itemId: board.id, relationship: "uncertain_alternative", compatibility: "unknown", availableQuantity: 1, suppliedQuantity: 0, inspectQuantity: 1, reason: "Needs compatibility confirmation" }] }),
    ], [...lines, line({ id: "esp-line-distinct", constraints: { kind: "electronic", model: "ESP32-S3-R2" }, alternatives: [{ itemId: board.id, compatible: "unknown" }] })], [board]);
    expect(distinct.filter((action) => action.kind === "compatibility")).toHaveLength(2);
  });

  it("provides stable cursor pagination over the complete sorted candidate scan", () => {
    const actions = deriveInspectionActions("revision-1", [
      gap({ lineId: "line-z" }), gap({ lineId: "line-a" })
    ], [line({ id: "line-z" }), line({ id: "line-a" })], [item()]);
    expect(actions).toHaveLength(1);
    const first = pageInspectionActions(actions, 1);
    expect(first.nextCursor).toBeUndefined();
    expect(pageInspectionActions(actions, 1, "not-an-action").data).toEqual([]);
  });

  it("reports a continuation cursor when the sorted action list spans pages", () => {
    const boardA = item({ id: "board-a", evidence: { state: "delivered_uncounted" } });
    const boardB = item({ id: "board-b", evidence: { state: "delivered_uncounted" } });
    const lines = [line({ id: "page-a" }), line({ id: "page-b" })];
    const gaps = lines.map((candidateLine, index) => gap({ lineId: candidateLine.id, candidates: [{ itemId: index === 0 ? boardA.id : boardB.id, relationship: "exact", compatibility: "confirmed", availableQuantity: 0, suppliedQuantity: 0, inspectQuantity: 1, reason: "Needs inspection" }] }));
    const actions = deriveInspectionActions("revision-1", gaps, lines, [boardA, boardB]);
    const first = pageInspectionActions(actions, 1);
    expect(first.nextCursor).toBeDefined();
    expect(pageInspectionActions(actions, 1, first.nextCursor).data).toHaveLength(1);
  });
});
