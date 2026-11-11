import { describe, expect, it } from "vitest";
import { evidenceLabel, formatQuantity, inventoryAccessibilityLabel, stockSummary, syncedLabel } from "./presentation";

const row = { name: "Wire kit", quantity: 1, availableQuantity: 1, unit: "set" as const, location: "Drawer A", evidence: { state: "delivered_uncounted" as const } };

describe("native inventory accessibility", () => {
  it("retains uncounted evidence, formatted quantity and location in the row's spoken label", () => {
    expect(inventoryAccessibilityLabel(row)).toBe("Wire kit, 1 set, Drawer A, Delivered · count needed");
  });
  it("speaks availability when some stock is reserved", () => {
    expect(inventoryAccessibilityLabel({ ...row, quantity: 1000, availableQuantity: 250, unit: "gram", evidence: { state: "physically_counted" } }))
      .toBe("Wire kit, Available 250 of 1,000 g, Drawer A, Physically counted");
  });
  it("prioritises a unit correction over otherwise confirmed evidence", () => {
    expect(evidenceLabel({ unitStatus: "needs_correction", evidence: { state: "commissioned" } })).toBe("Unit needs correction");
  });
});

describe("quantity presentation", () => {
  it.each([
    [1, "each", "1 piece"], [3, "each", "3 pieces"], [0, "each", "0 pieces"], [1000, "gram", "1,000 g"], [1, "gram", "1 g"],
    [2.5, "metre", "2.5 m"], [12, "millimetre", "12 mm"], [500, "millilitre", "500 ml"], [1, "set", "1 set"], [2, "set", "2 sets"],
    [1.23456, "gram", "1.2346 g"]
  ] as const)("formats %s %s as %s", (value, unit, expected) => expect(formatQuantity(value, unit)).toBe(expected));
  it("shows the decision-relevant available quantity when it differs from the record", () => {
    expect(stockSummary({ quantity: 5, availableQuantity: 3, unit: "each" })).toBe("Available 3 of 5 pieces");
    expect(stockSummary({ quantity: 5, availableQuantity: 5, unit: "each" })).toBe("5 pieces");
    expect(stockSummary({ quantity: 1000, availableQuantity: 0, unit: "gram" })).toBe("None available of 1,000 g");
  });
});

describe("last synced label", () => {
  const now = new Date(2026, 10, 11, 15, 30);
  it("shows only the time for today and the date otherwise", () => {
    expect(syncedLabel(new Date(2026, 10, 11, 9, 5), now, "en-GB")).toBe("Last synced 09:05");
    expect(syncedLabel(new Date(2026, 10, 3, 14, 5), now, "en-GB")).toBe("Last synced 3 Nov, 14:05");
  });
  it("says when nothing has been synced on this device", () => {
    expect(syncedLabel(undefined, now)).toBe("Nothing saved on this device yet");
  });
});
