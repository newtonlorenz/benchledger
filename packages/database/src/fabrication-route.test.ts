import { describe, expect, it } from "vitest";
import { createProject, createProjectRevision } from "@benchledger/domain";
import type { InventoryItem } from "@benchledger/domain";
import { InventoryRepository } from "./inventory-repository.js";
import { BenchDatabase } from "./sqlite.js";
import { migrateProjectSchema } from "./migrations.js";
import { ProjectRepository } from "./project-repository.js";

describe("project revision fabrication route persistence", () => {
  it("defaults a legacy revision to undecided during migration", () => {
    const database = new BenchDatabase(":memory:");
    database.exec("ALTER TABLE project_revisions DROP COLUMN fabrication_route");
    database.exec("ALTER TABLE project_revisions DROP COLUMN intended_printer_item_id");
    database.run("INSERT INTO forge_meta (key, value) VALUES ('project_schema_version', '4') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    database.run("INSERT INTO projects (id, name, slug, status, visibility, created_at, updated_at) VALUES (?, ?, ?, 'planned', 'private', ?, ?)", ["legacy-route-project", "Legacy route", "legacy-route", "2026-09-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z"]);
    database.run("INSERT INTO project_revisions (id, project_id, revision_number, label, status, created_at) VALUES (?, ?, 1, ?, 'concept', ?)", ["legacy-route-revision", "legacy-route-project", "Initial", "2026-09-04T00:00:00.000Z"]);

    migrateProjectSchema(database);

    expect(new ProjectRepository(database).getRevision("legacy-route-revision")).toMatchObject({ fabricationRoute: "undecided" });
    expect(database.get<{ readonly value: string }>("SELECT value FROM forge_meta WHERE key = 'project_schema_version'")).toEqual({ value: "5" });
    database.close();
  });

  it("round-trips explicit routes and clears planning-only printer assignments", () => {
    const database = new BenchDatabase(":memory:");
    const projects = new ProjectRepository(database);
    const project = createProject({ id: "route-project", name: "Route project" });
    projects.create(project);
    const printer: InventoryItem = {
      id: "printer-1", name: "Owned printer", category: "printer", purchasedQuantity: 1, unit: "printer",
      sourceStatus: "physically_confirmed", reusePolicy: "available", confidence: "confirmed",
      createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z"
    };
    new InventoryRepository(database).create(printer);
    const printed = createProjectRevision({ id: "route-revision", projectId: project.id, number: 1, fabricationRoute: "printed", intendedPrinterItemId: "printer-1" });
    projects.createRevision(printed);

    expect(projects.getRevision("route-revision")).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: "printer-1" });
    expect(database.get<{ readonly intended_printer_item_id: string | null }>("SELECT intended_printer_item_id FROM project_revisions WHERE id = ?", ["route-revision"])).toEqual({ intended_printer_item_id: "printer-1" });

    projects.updateRevision(createProjectRevision({ ...printed, fabricationRoute: "printed", intendedPrinterItemId: null }));
    expect(projects.getRevision("route-revision")).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: null });
    expect(database.get<{ readonly intended_printer_item_id: string | null }>("SELECT intended_printer_item_id FROM project_revisions WHERE id = ?", ["route-revision"])).toEqual({ intended_printer_item_id: null });

    const { intendedPrinterItemId: _printerId, ...revisionWithoutPrinter } = printed;
    const readyMade = createProjectRevision({ ...revisionWithoutPrinter, fabricationRoute: "ready_made" });
    projects.updateRevision(readyMade);
    expect(projects.getRevision("route-revision")).toMatchObject({ fabricationRoute: "ready_made" });
    expect(projects.getRevision("route-revision")).toMatchObject({ intendedPrinterItemId: null });
    expect(() => projects.updateRevision(createProjectRevision({
      id: "missing-route-revision", projectId: project.id, number: 2, fabricationRoute: "undecided"
    }))).toThrow(/does not exist/i);

    expect(() => database.run("UPDATE project_revisions SET fabrication_route = 'unsupported' WHERE id = ?", ["route-revision"]))
      .toThrow(/CHECK constraint failed/i);

    const canonicalLegacy = createProjectRevision({ id: "legacy-shaped-revision", projectId: project.id, number: 2 });
    const { fabricationRoute: _route, ...legacyShapedRevision } = canonicalLegacy;
    projects.createRevision(legacyShapedRevision);
    expect(projects.getRevision(legacyShapedRevision.id)).toMatchObject({ fabricationRoute: "undecided" });
    projects.updateRevision(legacyShapedRevision);
    expect(projects.getRevision(legacyShapedRevision.id)).toMatchObject({ fabricationRoute: "undecided" });
    database.close();
  });
});
