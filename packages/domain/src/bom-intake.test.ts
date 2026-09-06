import { describe, it, expect } from "vitest";
import { parseBomTable, mapBomTable, suggestBomMapping } from "./bom-intake.js";
const defaults = { unit: "each" as const, role: "consumed" as const, decimal: "dot" as const };
describe("reviewed BOM intake", () => {
  it("handles quoted delimiters, escaped quotes, embedded newlines and Unicode", () => {
    const table = parseBomTable('\uFEFFName,Quantity,Note\r\n"Café, bracket",2,"Says ""fit""\nCheck"\r\n');
    const mapped = mapBomTable(table, suggestBomMapping(table.headers), defaults);
    expect(mapped.issues).toEqual([]); expect(mapped.rows[0]).toMatchObject({ name: "Café, bracket", requiredQuantity: 2, notes: 'Says "fit"\nCheck' });
  });
  it("requires explicit decimal convention, unit, identity and duplicate column decisions", () => {
    const table = parseBomTable('Name;Qty;Unit;Selected inventory ID\nCable;1,5;metre;wire-1', ";");
    const mapping = suggestBomMapping(table.headers); expect(mapping.itemId).toBeUndefined();
    expect(mapBomTable(table, mapping, defaults).issues.length).toBeGreaterThan(0);
    expect(mapBomTable(table, { ...mapping, itemId: 3 }, { ...defaults, decimal: "comma" }).rows[0]).toMatchObject({ requiredQuantity: 1.5, itemId: "wire-1" });
    expect(suggestBomMapping(["Name", "name", "quantity"]).name).toBeUndefined();
  });
  it("rejects malformed, oversized, ambiguous and formula quantities without skipping rows", () => {
    for (const text of ['name,qty\na,1,extra', 'name,qty\n"open,1', 'name,qty\n"a"junk,1', 'name,qty\na\0,1', 'name,qty\n'+Array.from({length:25},()=> 'a,1').join('\n')]) expect(() => parseBomTable(text)).toThrow();
    const table = parseBomTable('Name,Quantity,Unit,Role,Optional\nPart,=2+2,bananas,anything,perhaps');
    expect(mapBomTable(table, suggestBomMapping(table.headers), defaults).issues).toHaveLength(4);
    expect(mapBomTable(table, { name: 0, quantity: 0 }, defaults).issues[0]?.field).toBe("mapping");
  });
});
