import { describe, expect, it } from "vitest";
import { sourcingCopyText } from "./requirement-sourcing";

describe("shopping list copy", () => {
  it("produces a plain-text list of what is still to buy", () => {
    expect(sourcingCopyText("Desk lamp", [{ line: { name: "M3 inserts", unit: "each" }, missingQuantity: 8 }, { line: { name: "PETG", unit: "g" }, missingQuantity: 120 }])).toBe("Desk lamp: things to buy\n- M3 inserts: 8 each\n- PETG: 120 g");
  });
});
