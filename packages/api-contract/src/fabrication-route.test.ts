import { describe, expect, it } from "vitest";
import { createProjectRevisionSchema, createProjectWithInitialRevisionSchema, projectRevisionSchema, updateProjectRevisionSchema } from "./schemas.js";

describe("fabrication route contract", () => {
  it("requires canonical routes on revision responses while defaulting create input", () => {
    const input = createProjectRevisionSchema.parse({ name: "Initial", status: "concept" });
    expect(input.fabricationRoute).toBeUndefined();
    expect(() => projectRevisionSchema.parse({
      id: "revision-1",
      projectId: "project-1",
      number: 1,
      name: "Initial",
      status: "concept",
      createdAt: "2026-09-04T00:00:00.000Z",
      version: 1
    })).toThrow();
    expect(projectRevisionSchema.parse({
      id: "revision-1",
      projectId: "project-1",
      number: 1,
      name: "Initial",
      status: "concept",
      fabricationRoute: "undecided",
      createdAt: "2026-09-04T00:00:00.000Z",
      version: 1
    }).fabricationRoute).toBe("undecided");
    expect(projectRevisionSchema.parse({
      id: "revision-2",
      projectId: "project-1",
      number: 2,
      name: "Cleared",
      status: "concept",
      fabricationRoute: "printed",
      intendedPrinterItemId: null,
      createdAt: "2026-09-04T00:00:00.000Z",
      version: 1
    }).intendedPrinterItemId).toBeNull();
  });

  it("only accepts a printer assignment on a printed route", () => {
    expect(createProjectRevisionSchema.parse({ name: "Printed", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: "printer-1" })).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: "printer-1" });
    expect(createProjectRevisionSchema.parse({ name: "Printed later", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: null })).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: null });
    expect(createProjectRevisionSchema.parse({ name: "Inherited printed", status: "concept", intendedPrinterItemId: "printer-1" })).toMatchObject({ intendedPrinterItemId: "printer-1" });
    expect(() => createProjectRevisionSchema.parse({ name: "Ready made", status: "concept", fabricationRoute: "ready_made", intendedPrinterItemId: "printer-1" })).toThrow(/printed fabricationRoute/i);
    expect(() => createProjectWithInitialRevisionSchema.parse({ project: { name: "Initial mismatch", status: "idea" }, revision: { name: "Initial", status: "concept", intendedPrinterItemId: "printer-1" } })).toThrow(/printed fabricationRoute/i);
    expect(() => updateProjectRevisionSchema.parse({ fabricationRoute: "none", intendedPrinterItemId: "printer-1" })).toThrow(/printed fabricationRoute/i);
    expect(updateProjectRevisionSchema.parse({ fabricationRoute: "printed", intendedPrinterItemId: null })).toEqual({ fabricationRoute: "printed", intendedPrinterItemId: null });
  });

  it("requires a real planning change while allowing either field independently", () => {
    expect(() => updateProjectRevisionSchema.parse({})).toThrow(/at least one revision planning field/i);
    expect(updateProjectRevisionSchema.parse({ fabricationRoute: "undecided" })).toEqual({ fabricationRoute: "undecided" });
    expect(updateProjectRevisionSchema.parse({ intendedPrinterItemId: null })).toEqual({ intendedPrinterItemId: null });
    expect(updateProjectRevisionSchema.parse({ fabricationRoute: "printed", intendedPrinterItemId: "printer-1" })).toEqual({ fabricationRoute: "printed", intendedPrinterItemId: "printer-1" });
  });
});
