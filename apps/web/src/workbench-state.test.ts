import { describe, expect, it, vi } from "vitest";
import { defaultHomePreferences, parseHomePreferences, deriveHomeProjects, filterHomeProjects, homePreferenceKey, readHomePreferences, writeHomePreferences, recordOpenedProject } from "./workbench-state";
import { projects, inventory } from "./mock-data";
const project = (id: string, patch: Partial<typeof projects[number]> = {}) => ({ ...structuredClone(projects[0]!), id, name: id, ...patch });
describe("workbench task model", () => {
  it("keeps incomplete, optional and unavailable results distinct", () => {
    const unknown = project("unavailable", { readinessUnavailable: true });
    const completed = project("finished", { status: "complete" });
    const empty = project("empty", { bom: [], fabricationRoute: "none" });
    const rows = deriveHomeProjects([unknown, completed, empty, project("archived", { status: "archived" })], inventory);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.tasks.some((task) => task.kind === "refresh")).toBe(true);
    expect(rows[0]!.tasks.some((task) => ["check", "source", "decide"].includes(task.kind))).toBe(false);
    expect(rows[1]!.tasks).toEqual([]);
    expect(rows[2]!.tasks.map((task) => task.kind)).toEqual(["requirements"]);
  });
  it("counts required lines rather than implying a validated physical build", () => {
    const source = project("required", { fabricationRoute: "none", bom: [{ id: "missing", version: 1, label: "Spacer", required: 2, unit: "each", role: "consumed", optional: true }], readinessUnavailable: false });
    delete source.gapEvaluation;
    const row = deriveHomeProjects([source], inventory)[0]!;
    expect(row.required).toBe(0); expect(row.tasks).toEqual([]);
  });
  it("recognises current work-item files and legacy recorded printer setups", () => {
    const source = project("legacy", { artifacts: [{ id: "cad", name: "body.step", role: "STEP", revision: "r01", size: "1 KB", hash: "a".repeat(64), updated: "2026-09-07", status: "candidate", workItemId: "body", workItemRevisionId: "body-r1" }], workItems: [{ id: "body", name: "Body", kind: "part", currentRevisionId: "body-r1" }] });
    delete source.fabricationRoute; delete source.intendedPrinterItemId;
    expect(source.buildConfigSnapshot?.printerItemId).toBeTruthy();
    const kinds = deriveHomeProjects([source], inventory)[0]!.tasks.map((task) => task.kind);
    expect(kinds).not.toContain("setup"); expect(kinds).not.toContain("files");
  });
  it("filters and sorts projects without mutating source records", () => {
    const rows = deriveHomeProjects([project("z", { name: "Café fixture", status: "planned" }), project("a", { name: "Sensor box", status: "complete" })], inventory);
    const before = JSON.stringify(rows);
    expect(filterHomeProjects(rows, "cafe", { ...defaultHomePreferences, filter: "all" }).map((row) => row.project.id)).toEqual(["z"]);
    expect(filterHomeProjects(rows, "", { ...defaultHomePreferences, filter: "complete" }).map((row) => row.project.id)).toEqual(["a"]);
    expect(filterHomeProjects(rows, "", { ...defaultHomePreferences, filter: "pinned", pins: ["a", "hidden-id"] }).map((row) => row.project.id)).toEqual(["a"]);
    expect(filterHomeProjects(rows, "", { ...defaultHomePreferences, filter: "all", recent: ["a"] })[0]!.project.id).toBe("a");
    expect(filterHomeProjects(rows, "", { ...defaultHomePreferences, filter: "attention", sort: "attention" }).every((row) => row.tasks.length > 0)).toBe(true);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("validates browser preferences and keeps only bounded record identifiers", () => {
    for (const raw of [null, "wrong", "null", "[]", "5"]) expect(parseHomePreferences(raw)).toEqual(defaultHomePreferences);
    expect(parseHomePreferences('{"pins":["one","one",5,""],"recent":["two"],"sort":"weird","filter":"bad"}')).toEqual({ pins: ["one"], recent: ["two"], filter: "active", sort: "recent" });
    const raw = JSON.stringify({ pins: Array.from({ length: 150 }, (_, i) => String(i)), recent: Array.from({ length: 30 }, (_, i) => String(i)) });
    expect(parseHomePreferences(raw).pins).toHaveLength(100); expect(parseHomePreferences(raw).recent).toHaveLength(12);
    expect(homePreferenceKey(true)).not.toBe(homePreferenceKey(false));
  });
  it("records recent IDs and remains usable without browser storage", () => {
    const data = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
    try { writeHomePreferences({ ...defaultHomePreferences, pins: ["p"] }); recordOpenedProject("a"); recordOpenedProject("b"); recordOpenedProject("a"); expect(readHomePreferences()).toMatchObject({ pins: ["p"], recent: ["a", "b"] }); }
    finally { vi.unstubAllGlobals(); }
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    try { expect(readHomePreferences()).toEqual(defaultHomePreferences); expect(() => writeHomePreferences(defaultHomePreferences)).not.toThrow(); } finally { vi.unstubAllGlobals(); }
  });
});
