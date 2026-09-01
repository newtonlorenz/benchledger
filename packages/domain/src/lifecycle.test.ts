import { describe, expect, it } from "vitest";
import { canonicalProjectStatus, deriveProjectBlocked, isProjectLifecycle, normalizeProjectLifecycle, projectLifecycleTransition } from "./lifecycle.js";

describe("project lifecycle", () => {
  it("accepts the canonical lifecycle and never treats blocked as a status", () => {
    const values = ["idea", "planned", "ready", "building", "validating", "complete", "archived"] as const;
    expect(values.every(isProjectLifecycle)).toBe(true);
    expect(isProjectLifecycle("blocked")).toBe(false);
    expect(isProjectLifecycle("planning")).toBe(false);
  });

  it("normalizes legacy persisted values without inventing progress", () => {
    expect(valuesForNormalization()).toEqual([
      ["idea", "idea"],
      ["planning", "planned"],
      ["in_progress", "building"],
      ["validation", "validating"],
      ["complete", "complete"],
      ["retired", "archived"],
      ["active", "idea"],
      ["on_hold", "idea"]
    ]);
    expect(normalizeProjectLifecycle("not-a-status")).toBeUndefined();
  });

  it("validates transitions while allowing intentional lifecycle changes", () => {
    expect(projectLifecycleTransition("planned", "building")).toBe("building");
    expect(projectLifecycleTransition("complete", "planned")).toBe("planned");
    expect(() => projectLifecycleTransition("planned", "blocked")).toThrow(/lifecycle/i);
    expect(() => canonicalProjectStatus("retired")).toThrow(/canonical|lifecycle/i);
  });

  it("derives blocked as a reason-bearing condition", () => {
    expect(deriveProjectBlocked(["Missing connector", "Missing connector", " ", "Needs a count"])).toEqual({
      blocked: true,
      reasons: ["Missing connector", "Needs a count"]
    });
    expect(deriveProjectBlocked([])).toEqual({ blocked: false, reasons: [] });
  });
});

function valuesForNormalization(): readonly (readonly [string, string])[] {
  return [
    ["idea", normalizeProjectLifecycle("idea") ?? ""],
    ["planning", normalizeProjectLifecycle("planning") ?? ""],
    ["in_progress", normalizeProjectLifecycle("in_progress") ?? ""],
    ["validation", normalizeProjectLifecycle("validation") ?? ""],
    ["complete", normalizeProjectLifecycle("complete") ?? ""],
    ["retired", normalizeProjectLifecycle("retired") ?? ""],
    ["active", normalizeProjectLifecycle("active") ?? ""],
    ["on_hold", normalizeProjectLifecycle("on_hold") ?? ""]
  ] as readonly (readonly [string, string])[];
}
