import { describe, expect, it } from "vitest";
import { createAuditRecord, createBomLine, createOfferSnapshot, createProject, createProjectRevision, createStockEvent, createSupplier, createWorkItem, createWorkItemRevision } from "@benchledger/domain";
import { AuditRepository, BomRepository, BenchDatabase, InventoryRepository, ProcurementRepository, ProjectRepository, ReservationRepository, migrateProjectSchema } from "./index.js";
import type { InventoryItem } from "@benchledger/domain";

const item: InventoryItem = {
  id: "item-1",
  name: "Test board",
  category: "electronics",
  variant: "rev A",
  purchasedQuantity: 3,
  unit: "board",
  sourceStatus: "physically_confirmed",
  reusePolicy: "available",
  confidence: "confirmed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("SQLite repositories", () => {
  it("creates schema, stores an item and derives an append-only balance", () => {
    const database = new BenchDatabase(":memory:");
    const inventory = new InventoryRepository(database);
    inventory.create(item);
    inventory.appendStockEvent(createStockEvent({ id: "event-receive", itemId: item.id, kind: "receipt", quantity: 3, unit: "board", reason: "received" }));
    inventory.appendStockEvent(createStockEvent({ id: "event-allocate", itemId: item.id, kind: "allocate", quantity: 1, unit: "board", reason: "project" }));
    expect(inventory.get(item.id)).toMatchObject({ id: item.id, name: item.name });
    expect(inventory.balance(item.id)).toMatchObject({ onHand: 3, allocated: 1, available: 2 });
    expect(inventory.listStockEvents(item.id)).toHaveLength(2);
    database.close();
  });

  it("makes event replay safe with an idempotency key", () => {
    const database = new BenchDatabase(":memory:");
    const inventory = new InventoryRepository(database);
    inventory.create(item);
    const event = createStockEvent({ id: "event-idempotent", itemId: item.id, kind: "receipt", quantity: 3, unit: "board", reason: "import", idempotencyKey: "import:item-1" });
    expect(inventory.appendStockEvent(event).inserted).toBe(true);
    expect(inventory.appendStockEvent({ ...event, id: "event-idempotent-retry" }).inserted).toBe(false);
    expect(inventory.balance(item.id).onHand).toBe(3);
    database.close();
  });

  it("persists project, work item, immutable revisions and BOM lines", () => {
    const database = new BenchDatabase(":memory:");
    const projects = new ProjectRepository(database);
    const boms = new BomRepository(database);
    const inventory = new InventoryRepository(database);
    const project = createProject({ id: "project-1", name: "Example Project" });
    const work = createWorkItem({ id: "work-1", projectId: project.id, name: "Enclosure", kind: "part" });
    const projectRevision = createProjectRevision({ id: "project-rev-1", projectId: project.id, number: 1 });
    const workRevision = createWorkItemRevision({ id: "work-rev-1", workItemId: work.id, number: 1 });
    projects.create(project);
    inventory.create(item);
    projects.createWorkItem(work);
    projects.createRevision(projectRevision);
    projects.createWorkItemRevision(workRevision);
    const line = createBomLine({ id: "bom-1", revisionId: projectRevision.id, name: item.name, quantity: 1, unit: item.unit, itemId: item.id });
    boms.createLine(line);
    expect(projects.get(project.id)?.name).toBe(project.name);
    expect(projects.listRevisions(project.id)).toHaveLength(1);
    expect(projects.listWorkItemRevisions(work.id)).toHaveLength(1);
    expect(boms.listLines(projectRevision.id)[0]?.itemId).toBe(item.id);
    database.close();
  });

  it("backfills durable retirement from trustworthy legacy runtime metadata", () => {
    const database = new BenchDatabase(":memory:");
    const projects = new ProjectRepository(database);
    const boms = new BomRepository(database);
    const project = createProject({ id: "legacy-retirement-project", name: "Legacy retirement" });
    const revision = createProjectRevision({ id: "legacy-retirement-revision", projectId: project.id, number: 1 });
    projects.create(project);
    projects.createRevision(revision);
    boms.createLine(createBomLine({ id: "legacy-retirement-line", revisionId: revision.id, name: "Legacy line", quantity: 1, unit: "piece", notes: "Historical note" }));
    database.exec("CREATE TABLE forge_runtime_metadata (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (entity_type, entity_id))");
    database.run("INSERT INTO forge_runtime_metadata (entity_type, entity_id, payload_json, updated_at) VALUES (?, ?, ?, ?)", ["bom_line", "legacy-retirement-line", JSON.stringify({ retired: true }), "2026-01-02T00:00:00.000Z"]);

    migrateProjectSchema(database);
    migrateProjectSchema(database);

    expect(boms.listLines(revision.id)).toEqual([]);
    expect(boms.listLines(revision.id, true)).toEqual([expect.objectContaining({ id: "legacy-retirement-line", notes: "Historical note", retiredAt: "2026-01-02T00:00:00.000Z" })]);
    database.close();
  });

  it("reopens a v2 project schema by adding removal tombstone columns without changing projects", () => {
    const database = new BenchDatabase(":memory:");
    database.exec("ALTER TABLE projects DROP COLUMN removed_at");
    database.exec("ALTER TABLE projects DROP COLUMN removed_by_json");
    database.exec("ALTER TABLE projects DROP COLUMN last_lifecycle_status");
    database.exec("ALTER TABLE projects DROP COLUMN removed_reservation_ids_json");
    database.run("INSERT INTO projects (id, name, slug, status, visibility, created_at, updated_at) VALUES (?, ?, ?, 'planned', 'private', ?, ?)", ["v2-project", "V2 project", "v2-project", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
    database.run("INSERT INTO forge_meta (key, value) VALUES ('project_schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value");

    migrateProjectSchema(database);

    expect(database.all<{ readonly name: string }>("PRAGMA table_info(projects)").map((column) => column.name)).toEqual(expect.arrayContaining(["removed_at", "removed_by_json", "last_lifecycle_status", "removed_reservation_ids_json"]));
    expect(database.get<{ readonly status: string; readonly removed_at: string | null }>("SELECT status, removed_at FROM projects WHERE id = 'v2-project'")).toEqual({ status: "planned", removed_at: null });
    expect(database.get<{ readonly value: string }>("SELECT value FROM forge_meta WHERE key = 'project_schema_version'")).toEqual({ value: "3" });
    database.close();
  });

  it("migrates legacy project statuses to one lifecycle and keeps the source in audit history", () => {
    const database = new BenchDatabase(":memory:");
    for (const [id, status] of [["legacy-active", "active"], ["legacy-hold", "on_hold"], ["legacy-idea", "idea"], ["legacy-plan", "planning"], ["legacy-work", "in_progress"], ["legacy-validation", "validation"], ["legacy-done", "complete"], ["legacy-retired", "retired"]] as const) {
      database.run("INSERT INTO projects (id, name, slug, status, visibility, created_at, updated_at, retired_at) VALUES (?, ?, ?, ?, 'private', ?, ?, ?)", [id, id, id, status, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", status === "retired" ? "2026-01-02T00:00:00.000Z" : null]);
    }
    migrateProjectSchema(database);
    migrateProjectSchema(database);

    expect(database.all<{ readonly status: string }>("SELECT status FROM projects ORDER BY id").map((row) => row.status)).toEqual(["idea", "complete", "idea", "idea", "planned", "archived", "validating", "building"]);
    expect(database.all<{ readonly metadata_json: string }>("SELECT metadata_json FROM audit_log WHERE action = 'project.lifecycle.migrated' ORDER BY entity_id")).toHaveLength(6);
    expect(database.get<{ readonly metadata_json: string }>("SELECT metadata_json FROM audit_log WHERE entity_id = ?", ["legacy-plan"])).toMatchObject({ metadata_json: expect.stringContaining("planning") });
    database.close();
  });

  it("fails closed instead of inventing progress for an unknown legacy project status", () => {
    const database = new BenchDatabase(":memory:");
    database.run("INSERT INTO projects (id, name, slug, status, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, 'private', ?, ?)", ["legacy-unknown", "Unknown", "unknown", "mystery", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);

    expect(() => migrateProjectSchema(database)).toThrow(/unsupported legacy status/);
    expect(database.get<{ readonly status: string }>("SELECT status FROM projects WHERE id = ?", ["legacy-unknown"])).toEqual({ status: "mystery" });
    expect(database.get("SELECT id FROM audit_log WHERE entity_id = ?", ["legacy-unknown"])).toBeUndefined();
    database.close();
  });

  it("uses legacy project metadata as the effective source, preserves unrelated metadata, and audits both sources", () => {
    const database = new BenchDatabase(":memory:");
    database.exec("CREATE TABLE forge_runtime_metadata (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (entity_type, entity_id))");
    database.run("INSERT INTO projects (id, name, slug, status, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, 'private', ?, ?)", ["metadata-project", "Metadata project", "metadata-project", "active", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
    database.run("INSERT INTO projects (id, name, slug, status, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, 'private', ?, ?)", ["metadata-only-revision", "Metadata only revision", "metadata-only-revision", "ready", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
    database.run("INSERT INTO forge_runtime_metadata (entity_type, entity_id, payload_json, updated_at) VALUES (?, ?, ?, ?)", ["project", "metadata-project", JSON.stringify({ status: "validation", currentRevisionId: "revision-1", note: "keep me" }), "2026-01-03T00:00:00.000Z"]);
    database.run("INSERT INTO forge_runtime_metadata (entity_type, entity_id, payload_json, updated_at) VALUES (?, ?, ?, ?)", ["project", "metadata-only-revision", JSON.stringify({ currentRevisionId: "revision-2" }), "2026-01-03T00:00:00.000Z"]);

    migrateProjectSchema(database);
    migrateProjectSchema(database);

    expect(database.get<{ readonly status: string; readonly retired_at: string | null }>("SELECT status, retired_at FROM projects WHERE id = ?", ["metadata-project"])).toEqual({ status: "validating", retired_at: null });
    expect(JSON.parse(database.get<{ readonly payload_json: string }>("SELECT payload_json FROM forge_runtime_metadata WHERE entity_type = ? AND entity_id = ?", ["project", "metadata-project"])!.payload_json)).toEqual({ currentRevisionId: "revision-1", note: "keep me" });
    expect(database.all("SELECT id FROM audit_log WHERE action = 'project.lifecycle.migrated' AND entity_id = ?", ["metadata-project"])).toHaveLength(1);
    const audit = database.get<{ readonly metadata_json: string }>("SELECT metadata_json FROM audit_log WHERE action = 'project.lifecycle.migrated' AND entity_id = ?", ["metadata-project"]);
    expect(JSON.parse(audit!.metadata_json)).toEqual({ legacyStatus: "validation", storedStatus: "active", metadataStatus: "validation", canonicalStatus: "validating" });
    expect(database.all("SELECT id FROM audit_log WHERE action = 'project.lifecycle.migrated' AND entity_id = ?", ["metadata-only-revision"])).toHaveLength(0);
    expect(JSON.parse(database.get<{ readonly payload_json: string }>("SELECT payload_json FROM forge_runtime_metadata WHERE entity_type = ? AND entity_id = ?", ["project", "metadata-only-revision"])!.payload_json)).toEqual({ currentRevisionId: "revision-2" });
    database.close();
  });

  it("rolls back the whole project lifecycle migration when metadata contains an unknown status", () => {
    const database = new BenchDatabase(":memory:");
    database.exec("CREATE TABLE forge_runtime_metadata (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (entity_type, entity_id))");
    for (const [id, status] of [["valid-project", "planning"], ["unknown-metadata-project", "active"]] as const) {
      database.run("INSERT INTO projects (id, name, slug, status, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, 'private', ?, ?)", [id, id, id, status, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
    }
    database.run("INSERT INTO forge_runtime_metadata (entity_type, entity_id, payload_json, updated_at) VALUES (?, ?, ?, ?)", ["project", "unknown-metadata-project", JSON.stringify({ status: "mystery", currentRevisionId: "revision-2" }), "2026-01-03T00:00:00.000Z"]);

    expect(() => migrateProjectSchema(database)).toThrow(/unsupported legacy status/);
    expect(database.all<{ readonly id: string; readonly status: string }>("SELECT id, status FROM projects ORDER BY id")).toEqual([{ id: "unknown-metadata-project", status: "active" }, { id: "valid-project", status: "planning" }]);
    expect(database.get("SELECT id FROM audit_log WHERE action = 'project.lifecycle.migrated'")).toBeUndefined();
    expect(JSON.parse(database.get<{ readonly payload_json: string }>("SELECT payload_json FROM forge_runtime_metadata WHERE entity_id = ?", ["unknown-metadata-project"])!.payload_json)).toEqual({ status: "mystery", currentRevisionId: "revision-2" });
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["project_schema_version"])).toBeUndefined();
    database.close();
  });

  it("coordinates reservation with an allocation event", () => {
    const database = new BenchDatabase(":memory:");
    const inventory = new InventoryRepository(database);
    const reservations = new ReservationRepository(database, inventory);
    const projects = new ProjectRepository(database);
    const boms = new BomRepository(database);
    inventory.create(item);
    projects.create(createProject({ id: "project-1", name: "Reservation Project" }));
    projects.createRevision(createProjectRevision({ id: "project-rev-1", projectId: "project-1", number: 1 }));
    boms.createLine(createBomLine({ id: "bom-1", revisionId: "project-rev-1", name: item.name, quantity: 1, unit: item.unit, itemId: item.id }));
    inventory.appendStockEvent(createStockEvent({ id: "event-reserve-receive", itemId: item.id, kind: "receipt", quantity: 3, unit: "board", reason: "received" }));
    const reservation = reservations.create({ id: "reservation-1", projectRevisionId: "project-rev-1", bomLineId: "bom-1", itemId: item.id, quantity: 2 });
    expect(reservation.status).toBe("active");
    expect(inventory.balance(item.id).available).toBe(1);
    expect(() => reservations.create({ id: "reservation-2", projectRevisionId: "project-rev-1", bomLineId: "bom-2", itemId: item.id, quantity: 2 })).toThrow(/reserve|stock/i);
    const released = reservations.release(reservation.id);
    expect(released.status).toBe("released");
    expect(inventory.balance(item.id).available).toBe(3);
    database.close();
  });

  it("retains supplier offer history and audit records", () => {
    const database = new BenchDatabase(":memory:");
    const procurement = new ProcurementRepository(database);
    const audits = new AuditRepository(database);
    const inventory = new InventoryRepository(database);
    const supplier = createSupplier({ id: "supplier-1", name: "Example Parts" });
    const offer = createOfferSnapshot({ id: "offer-1", itemId: item.id, supplierId: supplier.id, url: "https://example.test/board", packageQuantity: 1, packageUnit: "board", priceMinor: 1200, currency: "EUR" });
    inventory.create(item);
    procurement.createSupplier(supplier);
    procurement.createOffer(offer);
    const audit = createAuditRecord({ id: "audit-1", action: "inventory.created", entityType: "inventory_item", entityId: item.id, actor: { type: "human", id: "test" }, sourceSurface: "ui" });
    audits.append(audit);
    expect(procurement.listOffers(item.id)).toHaveLength(1);
    expect(audits.list(item.id)[0]?.id).toBe(audit.id);
    database.close();
  });

  it("composes nested repository transactions with savepoints", () => {
    const database = new BenchDatabase(":memory:");

    database.transaction(() => {
      database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?)", ["outer-before", "yes"]);
      expect(() => database.transaction(() => {
        database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?)", ["inner-rolled-back", "yes"]);
        throw new Error("reject nested work");
      })).toThrow("reject nested work");
      database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?)", ["outer-after", "yes"]);
    });

    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["outer-before"])).toMatchObject({ value: "yes" });
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["outer-after"])).toMatchObject({ value: "yes" });
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["inner-rolled-back"])).toBeUndefined();
    database.close();
  });

  it("keeps an async outer transaction open across nested synchronous work", async () => {
    const database = new BenchDatabase(":memory:");

    await expect(database.transactionAsync(async () => {
      database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?)", ["async-before", "yes"]);
      await Promise.resolve();
      database.transaction(() => {
        database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?)", ["async-inner", "yes"]);
      });
      throw new Error("reject async work");
    })).rejects.toThrow("reject async work");

    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["async-before"])).toBeUndefined();
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["async-inner"])).toBeUndefined();
    database.close();
  });
});
