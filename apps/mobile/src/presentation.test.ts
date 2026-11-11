import { describe, expect, it } from "vitest";
import { assumedStockLabel, evidenceLabel, formatQuantity, inventoryAccessibilityLabel, stockActions, stockReceivingPolicyText, stockSummary, syncedLabel } from "./presentation";

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

describe("stock receiving policy presentation", () => {
  const states = ["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"] as const;
  const availabilities = [undefined, "confirmed", "assumed", "inspect_first", "ordered", "unknown"] as const;
  it.each(states.flatMap((state) => availabilities.map((availability) => [state, availability] as const)))(
    "labels %s evidence with %s availability honestly", (state, availability) => {
      const label = assumedStockLabel({ evidence: { state }, ...(availability ? { availability } : {}) });
      if (availability !== "assumed") expect(label).toBeUndefined();
      else expect(label).toBe(state === "ordered_unverified" ? "In stock · ordered, not yet delivered" : "In stock · delivered, not counted");
    });
  it("shows assumed stock in the evidence badge and the spoken row label", () => {
    const delivered = { ...row, availability: "assumed" as const };
    expect(evidenceLabel(delivered)).toBe("In stock · delivered, not counted");
    expect(inventoryAccessibilityLabel(delivered)).toBe("Wire kit, 1 set, Drawer A, In stock · delivered, not counted");
    const ordered = { ...row, availability: "assumed" as const, evidence: { state: "ordered_unverified" as const } };
    expect(inventoryAccessibilityLabel(ordered)).toBe("Wire kit, 1 set, Drawer A, In stock · ordered, not yet delivered");
  });
  it("keeps the stored evidence label when the policy does not trust it or the server is older", () => {
    expect(evidenceLabel({ ...row, availability: "inspect_first" })).toBe("Delivered · count needed");
    expect(evidenceLabel(row)).toBe("Delivered · count needed");
    expect(evidenceLabel({ ...row, availability: "ordered", evidence: { state: "ordered_unverified" } })).toBe("Ordered · unverified");
  });
  it("still prioritises a unit correction over assumed stock", () => {
    expect(evidenceLabel({ unitStatus: "needs_correction", availability: "assumed", evidence: { state: "delivered_uncounted" } })).toBe("Unit needs correction");
  });
  it.each([
    ["on_purchase", "When it's bought", /not arrived yet/u],
    ["on_delivery", "When it's delivered", /Delivered stock counts without a count/u],
    ["on_receipt", "When I've received and checked it", /waits until you count it/u]
  ] as const)("describes the %s policy", (policy, label, explanation) => {
    const text = stockReceivingPolicyText(policy);
    expect(text.label).toBe(label); expect(text.explanation).toMatch(explanation);
  });
  it.each([
    ["physically_counted", undefined, "Count stock", true, false],
    ["commissioned", "confirmed", "Count stock", true, false],
    ["delivered_uncounted", "assumed", "Receive and count", false, true],
    ["ordered_unverified", "assumed", "Receive and count", false, true],
    ["delivered_uncounted", "inspect_first", "Receive and count", false, false],
    ["ordered_unverified", "ordered", "Receive and count", false, false],
    // Older servers (no availability) accepted receipts on delivered stock.
    ["delivered_uncounted", undefined, "Receive and count", true, false],
    ["unknown", "unknown", "Count stock", true, false]
  ] as const)("offers stock actions for %s / %s", (state, availability, primary, allowReceipt, assumed) => {
    expect(stockActions({ evidence: { state }, ...(availability ? { availability } : {}) })).toEqual({ primary, allowReceipt, assumed });
  });
});
