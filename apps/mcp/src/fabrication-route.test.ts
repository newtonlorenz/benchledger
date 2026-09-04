import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "./capabilities.js";
import { projectRevisionCreate, projectRevisionUpdate, projectWithInitialRevisionCreate } from "./validation.js";

describe("MCP fabrication route transport", () => {
  it("accepts route metadata on atomic and later revision inputs", () => {
    expect(projectWithInitialRevisionCreate({
      name: "Lamp",
      fabricationRoute: "printed",
      intendedPrinterItemId: "printer-h2d"
    })).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: "printer-h2d" });
    expect(projectRevisionCreate({
      projectId: "project-1",
      summary: "Ready baseline",
      fabricationRoute: "ready_made"
    })).toMatchObject({ projectId: "project-1", fabricationRoute: "ready_made" });
    expect(projectRevisionCreate({ projectId: "project-1", intendedPrinterItemId: "printer-h2d" })).toMatchObject({ intendedPrinterItemId: "printer-h2d" });
    expect(() => projectWithInitialRevisionCreate({ name: "Invalid initial route", intendedPrinterItemId: "printer-h2d" })).toThrow(/requires.*printed/i);
  });

  it("keeps printer assignment nullable for narrow updates and rejects invalid route pairs", () => {
    expect(projectRevisionUpdate({ revisionId: "revision-1", expectedVersion: 2, intendedPrinterItemId: null })).toEqual({
      revisionId: "revision-1",
      expectedVersion: 2,
      intendedPrinterItemId: null
    });
    expect(projectRevisionCreate({ projectId: "project-1", fabricationRoute: "printed", intendedPrinterItemId: null })).toMatchObject({ intendedPrinterItemId: null });
    expect(() => projectRevisionUpdate({ revisionId: "revision-1", fabricationRoute: "none" })).toThrow(/expectedVersion/i);
    expect(() => projectRevisionCreate({ projectId: "project-1", fabricationRoute: "none", intendedPrinterItemId: "printer-h2d" })).toThrow(/requires.*printed/i);
    expect(() => projectRevisionUpdate({ revisionId: "revision-1", fabricationRoute: "ready_made", intendedPrinterItemId: "printer-h2d" })).toThrow(/requires.*printed/i);
    expect(() => projectRevisionUpdate({ revisionId: "revision-1", expectedVersion: 2 })).toThrow(/must include fabricationRoute or intendedPrinterItemId/i);
    expect(projectRevisionUpdate({ revisionId: "revision-1", expectedVersion: 2, fabricationRoute: "undecided" })).toEqual({
      revisionId: "revision-1",
      expectedVersion: 2,
      fabricationRoute: "undecided"
    });
  });

  it("advertises the planning-only revision update and canonical route fields", () => {
    const definitions = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
    const update = definitions.get("update_project_revision");
    expect(update?.requiredScope).toBe("projects:write");
    expect(update?.inputSchema.required).toEqual(expect.arrayContaining(["revisionId", "expectedVersion"]));
    expect(update?.inputSchema.properties).toMatchObject({
      revisionId: { type: "string" },
      expectedVersion: { type: "integer" },
      fabricationRoute: { type: "string", enum: ["printed", "ready_made", "none", "undecided"] },
      intendedPrinterItemId: { oneOf: expect.arrayContaining([{ type: "null" }]) },
    });
    expect(update?.description).toMatch(/BOM|build configuration/i);
  });
});
