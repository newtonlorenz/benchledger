import { describe, expect, it } from "vitest";
import {
  assertBomAlternativeQuantityConversion,
  cloneBomAlternativeQuantityConversion,
  isBomAlternativeQuantityConversion,
  resolveBomAlternativeQuantity,
} from "./quantity-conversion.js";

const conversion = {
  inventory: { quantity: 1 as const, unit: "set" as const },
  requirement: { quantity: 40, unit: "piece" as const },
  evidence: { basis: "package_label" as const, observedAt: "2026-09-02T10:00:00.000Z", source: "package label" },
};

describe("BOM alternative quantity conversion", () => {
  it("accepts and clones an evidence-backed one-set conversion", () => {
    expect(isBomAlternativeQuantityConversion(conversion)).toBe(true);
    expect(cloneBomAlternativeQuantityConversion(conversion)).toEqual(conversion);
    expect(() => assertBomAlternativeQuantityConversion(conversion)).not.toThrow();
  });

  it.each([
    ["reverse", { ...conversion, inventory: { quantity: 2, unit: "set" } }],
    ["fractional", { ...conversion, requirement: { quantity: 1.5, unit: "piece" } }],
    ["missing evidence", { ...conversion, evidence: {} }],
    ["unknown basis", { ...conversion, evidence: { ...conversion.evidence, basis: "inferred" } }],
    ["extra field", { ...conversion, extra: true }],
  ] as const)("rejects %s", (_name, value) => {
    expect(isBomAlternativeQuantityConversion(value)).toBe(false);
    expect(() => assertBomAlternativeQuantityConversion(value)).toThrow(/quantity conversion/i);
  });

  it("converts only matching set inventory into piece requirements", () => {
    expect(resolveBomAlternativeQuantity({ inventoryQuantity: 2, inventoryUnit: "set", requirementUnit: "piece", conversion })).toBe(80);
    expect(resolveBomAlternativeQuantity({ inventoryQuantity: 2, inventoryUnit: "pack", requirementUnit: "piece", conversion })).toBeUndefined();
    expect(resolveBomAlternativeQuantity({ inventoryQuantity: 2, inventoryUnit: "set", requirementUnit: "gram", conversion })).toBeUndefined();
    expect(resolveBomAlternativeQuantity({ inventoryQuantity: 1.5, inventoryUnit: "set", requirementUnit: "piece", conversion })).toBeUndefined();
  });

  it("preserves same-unit quantities without requiring a conversion", () => {
    expect(resolveBomAlternativeQuantity({ inventoryQuantity: 1.5, inventoryUnit: "gram", requirementUnit: "gram" })).toBe(1.5);
    expect(resolveBomAlternativeQuantity({ inventoryQuantity: 2, inventoryUnit: "piece", requirementUnit: "piece" })).toBe(2);
  });
});
