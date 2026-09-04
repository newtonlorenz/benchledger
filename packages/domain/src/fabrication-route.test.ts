import { describe, expect, it } from "vitest";
import { createProjectRevision } from "./projects.js";

describe("project revision fabrication route", () => {
  it("defaults legacy-shaped revisions to undecided", () => {
    expect(createProjectRevision({ projectId: "project-1", number: 1 }).fabricationRoute).toBe("undecided");
  });

  it("rejects a printer assignment without the printed route", () => {
    expect(() => createProjectRevision({ projectId: "project-1", number: 1, intendedPrinterItemId: "printer-1" })).toThrow(/printed fabrication route/i);
    expect(() => createProjectRevision({ projectId: "project-1", number: 1, fabricationRoute: "ready_made", intendedPrinterItemId: "printer-1" })).toThrow(/printed fabrication route/i);
    expect(createProjectRevision({ projectId: "project-1", number: 1, fabricationRoute: "printed", intendedPrinterItemId: "printer-1" })).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: "printer-1" });
  });

  it("rejects unsupported routes and blank printer identities", () => {
    expect(() => createProjectRevision({ projectId: "project-1", number: 1, fabricationRoute: "laser" as never })).toThrow(/not supported/i);
    expect(() => createProjectRevision({ projectId: "project-1", number: 1, fabricationRoute: "printed", intendedPrinterItemId: " " })).toThrow(/cannot be empty/i);
    expect(createProjectRevision({ projectId: "project-1", number: 1, fabricationRoute: "printed" })).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: null });
  });
});
