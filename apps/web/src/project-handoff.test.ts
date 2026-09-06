import { describe, expect, it } from "vitest";
import { projectHandoff, projectBomCsv } from "./project-handoff";
import { projects } from "./mock-data";

describe("read-only maker handoffs", () => {
  it("exports stable IDs and versions while withholding unselected properties", () => {
    const project = { ...structuredClone(projects[0]!), token: "synthetic-never-export", internalUrl: "private-placeholder" };
    const handoff = projectHandoff(project, "2026-09-06T12:00:00.000Z");
    expect(handoff).toMatchObject({ format: "benchledger-project-handoff", schemaVersion: 1, generatedAt: "2026-09-06T12:00:00.000Z", project: { id: project.id, name: project.name } });
    expect(handoff.requirements).toHaveLength(project.bom.length);
    expect(JSON.stringify(handoff)).not.toContain("synthetic-never-export");
    expect(JSON.stringify(handoff)).not.toContain("private-placeholder");
    expect(handoff.notice).toContain("not a backup");
  });
  it("does not invent fresh readiness when the service evaluation is unavailable", () => {
    const handoff = projectHandoff({ ...structuredClone(projects[0]!), readinessUnavailable: true });
    expect(handoff.readiness.source).toContain("unavailable");
    expect(handoff.requirements.every((line) => line.decision === "unknown")).toBe(true);
  });
  it("quotes commas and line breaks while neutralising spreadsheet formula cells", () => {
    const project = structuredClone(projects[0]!);
    project.bom = [{ id: "csv-line", version: 4, label: "=1+1", required: 8, unit: "each", note: 'He said "hello", then left\nNext line', optional: false }];
    const csv = projectBomCsv(project);
    expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('"He said ""hello"", then left\nNext line"');
    expect(csv).toContain('"csv-line","4"');
    expect(csv).toContain('"Requirement","Quantity"');
  });
});
