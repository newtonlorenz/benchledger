import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOCK_RECEIVING_POLICY, INVENTORY_EVIDENCE_STATES, STOCK_RECEIVING_POLICIES,
  classifyEvidenceAvailability, countsAsInStock, isAssumedByPolicy, isCommissionableEvidence, isConfirmedEvidence, isStockReceivingPolicy
} from "./evidence.js";

describe("evidence availability classification", () => {
  it("classifies every evidence state under every receiving policy", () => {
    const matrix = Object.fromEntries(STOCK_RECEIVING_POLICIES.map((policy) => [
      policy,
      Object.fromEntries(INVENTORY_EVIDENCE_STATES.map((state) => [state, classifyEvidenceAvailability(state, policy)]))
    ]));
    expect(matrix).toEqual({
      on_purchase: {
        physically_counted: "confirmed", commissioned: "confirmed", delivered_uncounted: "assumed", ordered_unverified: "assumed",
        allocated: "inspect_first", consumed: "inspect_first", unknown: "unknown"
      },
      on_delivery: {
        physically_counted: "confirmed", commissioned: "confirmed", delivered_uncounted: "assumed", ordered_unverified: "ordered",
        allocated: "inspect_first", consumed: "inspect_first", unknown: "unknown"
      },
      on_receipt: {
        physically_counted: "confirmed", commissioned: "confirmed", delivered_uncounted: "inspect_first", ordered_unverified: "ordered",
        allocated: "inspect_first", consumed: "inspect_first", unknown: "unknown"
      }
    });
  });

  it("counts stock as in stock exactly when the policy trusts its evidence", () => {
    expect(INVENTORY_EVIDENCE_STATES.filter((state) => countsAsInStock(state, "on_purchase"))).toEqual(["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified"]);
    expect(INVENTORY_EVIDENCE_STATES.filter((state) => countsAsInStock(state, "on_delivery"))).toEqual(["physically_counted", "commissioned", "delivered_uncounted"]);
    expect(INVENTORY_EVIDENCE_STATES.filter((state) => countsAsInStock(state, "on_receipt"))).toEqual(["physically_counted", "commissioned"]);
    expect(INVENTORY_EVIDENCE_STATES.filter((state) => isAssumedByPolicy(state, "on_delivery"))).toEqual(["delivered_uncounted"]);
  });

  it("keeps physical verification independent of the policy", () => {
    expect(INVENTORY_EVIDENCE_STATES.filter(isConfirmedEvidence)).toEqual(["physically_counted", "commissioned"]);
    expect(INVENTORY_EVIDENCE_STATES.filter(isCommissionableEvidence)).toEqual(["delivered_uncounted", "ordered_unverified"]);
  });

  it("defaults to the conservative receiving policy and validates policy values", () => {
    expect(DEFAULT_STOCK_RECEIVING_POLICY).toBe("on_receipt");
    expect(STOCK_RECEIVING_POLICIES.every(isStockReceivingPolicy)).toBe(true);
    expect(isStockReceivingPolicy("on_arrival")).toBe(false);
    expect(isStockReceivingPolicy(undefined)).toBe(false);
  });
});
