import { describe, expect, it } from "vitest";
import { bomGapCandidateSchema, inventoryItemSchema } from "./schemas.js";
import { stockReceivingPolicyImpactSchema, updateWorkspacePreferencesSchema, workspacePreferencesSchema } from "./workspace-preferences.js";

const deliveredItem = {
  id: "item-1", name: "M3 inserts", kind: "fastener", quantity: 10, availableQuantity: 6, allocatedQuantity: 4, unit: "each",
  tags: [], links: [], evidence: { state: "delivered_uncounted" }, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", version: 1
};

describe("workspace preferences contract", () => {
  it("accepts exactly the three receiving policies", () => {
    for (const stockReceivingPolicy of ["on_purchase", "on_delivery", "on_receipt"]) {
      expect(workspacePreferencesSchema.parse({ stockReceivingPolicy, version: 1, updatedAt: "2026-11-01T00:00:00.000Z" }).stockReceivingPolicy).toBe(stockReceivingPolicy);
      expect(updateWorkspacePreferencesSchema.parse({ stockReceivingPolicy, expectedVersion: 2 })).toEqual({ stockReceivingPolicy, expectedVersion: 2 });
    }
    expect(() => updateWorkspacePreferencesSchema.parse({ stockReceivingPolicy: "on_arrival" })).toThrow();
    expect(() => updateWorkspacePreferencesSchema.parse({ stockReceivingPolicy: "on_receipt", actor: "agent" })).toThrow();
    expect(() => workspacePreferencesSchema.parse({ stockReceivingPolicy: "on_receipt", version: 0, updatedAt: "2026-11-01T00:00:00.000Z" })).toThrow();
  });

  it("enforces the allocation invariant for policy-assumed rows using the server classification", () => {
    expect(inventoryItemSchema.parse({ ...deliveredItem, availability: "assumed" })).toMatchObject({ availability: "assumed", allocatedQuantity: 4 });
    expect(() => inventoryItemSchema.parse({ ...deliveredItem, availability: "assumed", allocatedQuantity: 1 })).toThrow(/quantity minus availableQuantity/i);
    // Uncounted rows that are not in stock carry no allocation invariant.
    expect(inventoryItemSchema.parse({ ...deliveredItem, availableQuantity: 0, allocatedQuantity: 4, availability: "inspect_first" })).toMatchObject({ availability: "inspect_first" });
    expect(() => inventoryItemSchema.parse({ ...deliveredItem, availability: "counted" })).toThrow();
  });

  it("reports candidate evidence alongside policy availability", () => {
    expect(bomGapCandidateSchema.parse({ itemId: "item-1", relationship: "exact", compatibility: "confirmed", availableQuantity: 1, suppliedQuantity: 1, inspectQuantity: 0, reason: "Exact", evidenceState: "delivered_uncounted", availability: "assumed" })).toMatchObject({ availability: "assumed" });
  });

  it("describes an impact preview", () => {
    const row = { itemId: "item-1", name: "M3 inserts", evidenceState: "delivered_uncounted", quantity: 10, unit: "each", from: "inspect_first", to: "assumed", allocatedQuantity: 0 };
    expect(stockReceivingPolicyImpactSchema.parse({ from: "on_receipt", to: "on_delivery", version: 1, gained: [row], lost: [], blockedBy: [], truncated: false }).gained).toHaveLength(1);
  });
});
