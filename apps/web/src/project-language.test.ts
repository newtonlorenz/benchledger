import { describe, expect, it } from "vitest";
import {
  decisionDisplay,
  formatRequirementCheckMessage,
  formatRequirementDecisionMessage,
  formatRequirementSourcingMessage,
  formatSourceReadyMessage,
  projectLifecycleLabel,
  reconciliationLoadErrorMessage,
} from "./App";

describe("project language", () => {
  it("maps every stored lifecycle state to one readable label", () => {
    expect([
      projectLifecycleLabel("idea"),
      projectLifecycleLabel("planned"),
      projectLifecycleLabel("ready"),
      projectLifecycleLabel("building"),
      projectLifecycleLabel("validating"),
      projectLifecycleLabel("complete"),
      projectLifecycleLabel("archived"),
    ]).toEqual(["Idea", "Planned", "Ready", "Building", "Validating", "Complete", "Archived"]);
  });

  it("uses the same four decision words", () => {
    expect(["ready", "check", "decide", "source"].map((state) => decisionDisplay(state as "ready" | "check" | "decide" | "source").label)).toEqual(["Ready", "Check", "Decide", "Source"]);
  });

  it("keeps requirement counts grammatical at zero, one, and many", () => {
    expect([0, 1, 2].map(formatRequirementSourcingMessage)).toEqual(["No requirements need sourcing", "1 requirement needs sourcing", "2 requirements need sourcing"]);
    expect([0, 1, 2].map(formatRequirementCheckMessage)).toEqual(["No requirements need a physical or compatibility check", "1 requirement needs a physical or compatibility check", "2 requirements need a physical or compatibility check"]);
    expect([0, 1, 2].map(formatRequirementDecisionMessage)).toEqual(["No requirements need a decision", "1 requirement needs a decision", "2 requirements need a decision"]);
    expect([0, 1, 2].map(formatSourceReadyMessage)).toEqual(["No requirements need sourcing", "1 requirement still needs sourcing", "2 requirements still need sourcing"]);
  });

  it("keeps unsupported service language plain for beginners", () => {
    const raw = "This runtime does not support post-project reconciliation";
    expect(reconciliationLoadErrorMessage(raw, false)).toBe("Used-stock updates are not available on this service version. Update the service, then try again.");
    expect(reconciliationLoadErrorMessage(raw, true)).toBe(raw);
    expect(reconciliationLoadErrorMessage("Reconciliation request timed out", false)).toBe("The used-stock update could not be loaded. Try again or return to the plan.");
    expect(reconciliationLoadErrorMessage("Create or reload the project revision before opening close-out", false)).toBe("The used-stock update could not be loaded. Try again or return to the plan.");
  });
});
