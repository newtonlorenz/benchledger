import { describe, expect, it } from "vitest";
import { calculateProjectSummary } from "./domain";
import type { Project } from "./domain";
import { projects as fixtureProjects } from "./mock-data";
import { mergeRefreshedProjects } from "./App";

const base = structuredClone(fixtureProjects[0]!) as Project;
const withGaps: Project = { ...base, bom: [], gapEvaluation: { revisionId: "r", lines: [], totals: { requiredLines: 0, optionalLines: 0, readyLines: 0, checkLines: 0, decideLines: 0, sourceLines: 0, partialLines: 0, missingLines: 0 } } as unknown as NonNullable<Project["gapEvaluation"]> };

describe("readiness refresh merge", () => {
  it("never adds archived or unknown projects to the active list", () => {
    const active = { ...base, id: "a" };
    const archived = { ...base, id: "b", status: "archived" as const };
    const merged = mergeRefreshedProjects([active], [{ ...active, name: "Renamed" }, archived, { ...base, id: "c" }]);
    expect(merged.map((project) => project.id)).toEqual(["a"]);
    expect(merged[0]?.name).toBe("Renamed");
  });

  it("keeps projects whose refresh did not return", () => {
    const one = { ...base, id: "a" }; const two = { ...base, id: "b" };
    expect(mergeRefreshedProjects([one, two], [one]).map((project) => project.id)).toEqual(["a", "b"]);
  });

  it("marks a retained canonical evaluation as unavailable instead of trusting it", () => {
    const summary = calculateProjectSummary({ ...withGaps, readinessUnavailable: true }, []);
    expect(summary.readinessUnavailable).toBe(true);
    expect(summary.sourceLines).toBe(0);
  });
});
