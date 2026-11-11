import { describe, expect, it } from "vitest";
import { INVENTORY_EVIDENCE_STATES, classifyEvidenceAvailability, isCommissionableEvidence, isConfirmedEvidence } from "./evidence.js";

describe("evidence availability classification", () => {
  it("classifies every evidence state exactly once", () => {
    expect(Object.fromEntries(INVENTORY_EVIDENCE_STATES.map((state) => [state, classifyEvidenceAvailability(state)]))).toEqual({
      physically_counted: "confirmed",
      commissioned: "confirmed",
      delivered_uncounted: "inspect_first",
      ordered_unverified: "ordered",
      allocated: "inspect_first",
      consumed: "inspect_first",
      unknown: "unknown"
    });
  });

  it("treats only physically verified stock as available", () => {
    expect(INVENTORY_EVIDENCE_STATES.filter(isConfirmedEvidence)).toEqual(["physically_counted", "commissioned"]);
    expect(INVENTORY_EVIDENCE_STATES.filter(isCommissionableEvidence)).toEqual(["delivered_uncounted", "ordered_unverified"]);
  });
});
