import { describe, expect, it } from "vitest";
import { compareInventoryRecords, inventoryStockAssessment, matchesInventoryStockView } from "./inventory-workspace.js";

const counted = { quantity: 10, availableQuantity: 6, evidence: { state: "physically_counted" } };
describe("inventory stock views", () => {
  it("keeps partial allocations available and fully reserved stock distinct from depleted stock", () => {
    expect(inventoryStockAssessment(counted)).toMatchObject({ available: true, reserved: true, allocatedQuantity: 4, depleted: false });
    expect(inventoryStockAssessment({ ...counted, availableQuantity: 0 })).toMatchObject({ available: false, reserved: true, depleted: false });
    expect(inventoryStockAssessment({ ...counted, quantity: 0, availableQuantity: 0 })).toMatchObject({ available: false, reserved: false, depleted: true });
  });
  it("never promotes order evidence, invalid units, missing balances, or repair needs into available stock", () => {
    for (const item of [
      { ...counted, evidence: { state: "delivered_uncounted" } },
      { ...counted, evidence: { state: "ordered_unverified" } },
      { ...counted, evidence: { state: "unknown" }, quantity: 0 },
      { ...counted, unitStatus: "needs_correction" },
      { ...counted, condition: "needs_repair" },
      { ...counted, availableQuantity: undefined },
    ]) expect(inventoryStockAssessment(item)).toMatchObject({ available: false, check: true, depleted: false });
    expect(inventoryStockAssessment({ ...counted, availableQuantity: undefined })).toMatchObject({ reserved: false });
    expect(inventoryStockAssessment({ ...counted, evidence: { state: "consumed" }, quantity: 0, availableQuantity: 0 })).toMatchObject({ check: false, depleted: true });
  });
  it("excludes retired records from every queue but retains them for unfiltered history", () => {
    const item = { ...counted, retiredAt: "2026-01-01T00:00:00Z" };
    expect(inventoryStockAssessment(item)).toMatchObject({ available: false, check: false, reserved: false, depleted: false });
    expect(matchesInventoryStockView(item)).toBe(true);
    expect(matchesInventoryStockView(item, "reserved")).toBe(false);
  });
  it("orders deterministically by location, name and ID without comparing incompatible quantities", () => {
    const rows = [{ id: "z", name: "Tool", location: "A" }, { id: "a", name: "Tool", location: "A" }, { id: "c", name: "Capacitor", location: "B" }, { id: "b", name: "Board" }];
    expect([...rows].sort((a,b) => compareInventoryRecords(a,b)).map((r) => r.id)).toEqual(["b", "c", "a", "z"]);
    expect([...rows].sort((a,b) => compareInventoryRecords(a,b,"name_desc")).map((r) => r.id)).toEqual(["z", "a", "c", "b"]);
    expect([...rows].sort((a,b) => compareInventoryRecords(a,b,"location")).map((r) => r.id)).toEqual(["b", "a", "z", "c"]);
  });
});
