import { describe, it, expect } from "vitest";
import { changesReservedRequirement } from "./bom-edit.js";
const current = { itemId: "board", role: "consumed" as const, requiredQuantity: 1, unit: "each" as const, optional: false, constraints: { manufacturer: "Maker", model: "Board" }, alternatives: [] };
describe("reserved requirement edits", () => {
  it("permits descriptive corrections and equivalent unordered specifications", () => {
    expect(changesReservedRequirement(current, { name: "Corrected", notes: "Useful note" })).toBe(false);
    expect(changesReservedRequirement(current, { constraints: { model: "Board", manufacturer: "Maker" } })).toBe(false);
    expect(changesReservedRequirement(current, { itemId: "board", requiredQuantity: 1 })).toBe(false);
  });
  it("blocks changed allocation assumptions", () => {
    for (const update of [{ itemId: null }, { requiredQuantity: 2 }, { unit: "set" as const }, { optional: true }, { role: "reusable" as const }, { alternatives: [{ itemId: "other", compatible: "confirmed" as const }] }]) expect(changesReservedRequirement(current, update)).toBe(true);
  });
  it("preserves safe legacy role repair without allowing reusable reservations", () => {
    expect(changesReservedRequirement({ ...current, role: null }, { role: "consumed" })).toBe(false);
    expect(changesReservedRequirement({ ...current, role: null }, { role: "reusable" })).toBe(true);
  });
});
