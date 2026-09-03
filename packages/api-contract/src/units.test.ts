import { describe, expect, it } from "vitest";
import {
  ITEM_KINDS,
  ITEM_KIND_UNIT_RULES,
  defaultUnitForItemKind,
  isUnitCompatibleWithItemKind,
  unitCorrectionReason,
  validUnitsForItemKind,
} from "./units.js";
import { createInventoryItemSchema, inventoryItemSchema } from "./schemas.js";

const base = {
  name: "Semantic unit test item",
  quantity: 1,
  tags: [],
  links: [],
  evidence: { state: "unknown" as const },
};

describe("semantic inventory units", () => {
  it("defines a default and accepted units for every public item kind", () => {
    for (const kind of ITEM_KINDS) {
      const rule = ITEM_KIND_UNIT_RULES[kind];
      expect(defaultUnitForItemKind(kind)).toBe(rule.defaultUnit);
      expect(validUnitsForItemKind(kind)).toEqual(rule.validUnits);
      expect(isUnitCompatibleWithItemKind(kind, rule.defaultUnit)).toBe(true);
      expect(unitCorrectionReason(kind, rule.defaultUnit)).toBeUndefined();
      for (const unit of rule.validUnits) {
        expect(createInventoryItemSchema.parse({ ...base, kind, unit }).unit).toBe(unit);
      }
    }
  });

  it("rejects invalid create pairs while retaining explicit legacy read diagnostics", () => {
    expect(() => createInventoryItemSchema.parse({ ...base, kind: "tool", unit: "metre" })).toThrow(/tool items use/i);
    expect(() => createInventoryItemSchema.parse({ ...base, kind: "printer", unit: "gram" })).toThrow(/printer items use/i);
    expect(() => createInventoryItemSchema.parse({ ...base, kind: "adhesive", unit: "millilitre" })).not.toThrow();

    const legacy = inventoryItemSchema.parse({
      id: "legacy-tool-metre",
      ...base,
      kind: "tool",
      unit: "metre",
      availableQuantity: 1,
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      version: 1,
    });
    expect(legacy).toMatchObject({ kind: "tool", unit: "metre" });
    expect(unitCorrectionReason(legacy.kind, legacy.unit)).toMatch(/tool items use each/i);
  });
});
