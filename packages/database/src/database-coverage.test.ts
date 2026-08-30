import { afterEach, describe, expect, it } from "vitest";
import {
  createAuditRecord,
  createBomLine,
  createOfferSnapshot,
  createProject,
  createProjectRevision,
  createStockEvent,
  createSupplier,
  createWorkItem,
  createWorkItemRevision
} from "@benchledger/domain";
import type { AuditRecord, InventoryItem } from "@benchledger/domain";
import {
  AuditRepository,
  BomRepository,
  BenchDatabase,
  InventoryRepository,
  ProcurementRepository,
  ProjectRepository,
  ReservationRepository
} from "./index.js";
import { jsonValue, parseJson } from "./serializers.js";

const databases: BenchDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function makeDatabase(): BenchDatabase {
  const database = new BenchDatabase(":memory:");
  databases.push(database);
  return database;
}

const fullItem: InventoryItem = {
  id: "item-full",
  name: "100% bracket_board",
  category: "electronics",
  variant: "Rev A",
  purchasedQuantity: 3,
  unit: "board",
  sourceStatus: "physically_confirmed",
  reusePolicy: "available",
  confidence: "confirmed",
  reportedQuantity: 3,
  manufacturer: "Maker Labs",
  model: "ESP32 Rev A",
  dimensions: { width: 10, height: 20, depth: 30, diameter: 4, unit: "mm", kind: "measured", uncertainty: 0.1, source: "caliper" },
  source: { vendor: "Parts Shop", order: "order-1", unitPriceMinor: 1200, currency: "EUR", forge: "kept" },
  notes: "bench board",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("SQLite repository edge behavior", () => {
  it("upserts, filters, searches safely, and keeps retired records out of default lists", () => {
    const database = makeDatabase();
    const inventory = new InventoryRepository(database);
    inventory.create(fullItem);
    const updated = { ...fullItem, name: "Updated board", confidence: "inspect_first" as const, updatedAt: "2026-01-02T00:00:00.000Z" };
    inventory.upsert(updated);

    expect(inventory.get(fullItem.id)).toMatchObject({ name: "Updated board", confidence: "inspect_first" });
    expect(inventory.list({ category: "electronics", confidence: "inspect_first" })).toHaveLength(1);
    expect(inventory.list({ query: "100%" })).toHaveLength(0);
    expect(inventory.list({ query: "updated" })).toHaveLength(1);
    expect(inventory.list({ query: "   " })).toHaveLength(1);
    expect(inventory.list({ category: "fastener" })).toHaveLength(0);

    const retired = inventory.retire(fullItem.id, "2026-01-03T00:00:00.000Z");
    expect(retired).toMatchObject({ retiredAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" });
    expect(inventory.list()).toHaveLength(0);
    expect(inventory.list({ includeRetired: true })).toMatchObject([{ id: fullItem.id, retiredAt: "2026-01-03T00:00:00.000Z" }]);
    expect(inventory.get("missing-item")).toBeUndefined();
    expect(inventory.listStockEvents(fullItem.id)).toEqual([]);
    expect(inventory.balance(fullItem.id)).toMatchObject({ onHand: 0, allocated: 0, available: 0 });
  });

  it("round-trips optional inventory and stock-event provenance fields", () => {
    const database = makeDatabase();
    const inventory = new InventoryRepository(database);
    inventory.create(fullItem);
    const event = createStockEvent({
      id: "evidence-event",
      itemId: fullItem.id,
      kind: "evidence",
      semantics: "informational",
      quantity: 0,
      unit: fullItem.unit,
      reason: "order evidence",
      actor: { type: "agent", id: "agent-1", label: "Import agent" },
      source: "order-email",
      evidence: { sourceId: "email-1", confidence: "high" },
      correlationId: "correlation-1",
      idempotencyKey: "evidence-key",
      occurredAt: "2026-01-02T00:00:00.000Z",
      createdAt: "2026-01-02T00:00:01.000Z"
    });
    expect(inventory.appendStockEvent(event)).toMatchObject({ inserted: true, balance: { onHand: 0 } });
    expect(inventory.listStockEvents(fullItem.id)).toEqual([event]);
    expect(inventory.get(fullItem.id)).toEqual(fullItem);
    expect(parseJson<{ ok: boolean }>(jsonValue({ ok: true }))).toEqual({ ok: true });
    expect(parseJson("not-json")).toBeUndefined();
    expect(parseJson("")).toBeUndefined();
    expect(jsonValue(undefined)).toBeNull();
  });

  it("rejects missing inventory references and preserves event idempotency", () => {
    const database = makeDatabase();
    const inventory = new InventoryRepository(database);
    const event = createStockEvent({ id: "missing-event", itemId: "missing-item", kind: "receipt", quantity: 1, unit: "piece", reason: "test" });
    expect(() => inventory.appendStockEvent(event)).toThrow(/does not exist/);
    expect(() => inventory.balance("missing-item")).toThrow(/does not exist/);

    inventory.create(fullItem);
    const receipt = createStockEvent({ id: "receipt-1", itemId: fullItem.id, kind: "receipt", quantity: 3, unit: fullItem.unit, reason: "received", idempotencyKey: "same-receipt" });
    expect(inventory.appendStockEvent(receipt).inserted).toBe(true);
    expect(inventory.appendStockEvent({ ...receipt, id: "receipt-retry" }).inserted).toBe(false);
    expect(inventory.balance(fullItem.id)).toMatchObject({ onHand: 3, available: 3 });
  });

  it("lists suppliers and all offers while enforcing supplier references", () => {
    const database = makeDatabase();
    const procurement = new ProcurementRepository(database);
    const inventory = new InventoryRepository(database);
    inventory.create(fullItem);
    const supplier = createSupplier({ id: "supplier-full", name: "Parts Shop", website: "https://parts.example", createdAt: "2026-01-01T00:00:00.000Z" });
    procurement.createSupplier(supplier);
    const offer = createOfferSnapshot({
      id: "offer-full",
      itemId: fullItem.id,
      supplierId: supplier.id,
      url: "https://parts.example/board",
      title: "ESP32 board",
      packageQuantity: 2,
      packageUnit: "board",
      priceMinor: 1800,
      currency: "EUR",
      observedAt: "2026-01-02T00:00:00.000Z",
      availability: "in_stock",
      notes: "ships tomorrow"
    });
    procurement.createOffer(offer);
    expect(procurement.getSupplier(supplier.id)).toEqual(supplier);
    expect(procurement.getSupplier("missing-supplier")).toBeUndefined();
    expect(procurement.listSuppliers()).toEqual([supplier]);
    expect(procurement.listOffers()).toEqual([offer]);
    expect(procurement.listOffers(fullItem.id)).toEqual([offer]);
    expect(() => procurement.createOffer({ ...offer, id: "offer-bad", supplierId: "missing-supplier" })).toThrow(/supplier/);
  });

  it("round-trips project, work-item, revision, BOM, alternative, and retirement data", () => {
    const database = makeDatabase();
    const projects = new ProjectRepository(database);
    const boms = new BomRepository(database);
    const inventory = new InventoryRepository(database);
    const project = createProject({ id: "project-full", name: "Full project", description: "A complete record", status: "complete", visibility: "public_candidate", slug: "full-project", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });
    projects.create(project);
    inventory.create(fullItem);
    inventory.create({ ...fullItem, id: "item-alt", name: "Compatible board", model: "ESP32 Rev B" });
    const work = createWorkItem({ id: "work-full", projectId: project.id, name: "Enclosure", kind: "assembly", description: "Outer shell", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });
    projects.createWorkItem(work);
    const revision = createProjectRevision({ id: "revision-full", projectId: project.id, number: 1, label: "r01", status: "DFAM reviewed", machineId: "H2D", material: "PETG", notes: "validated", createdAt: "2026-01-02T00:00:00.000Z" });
    projects.createRevision(revision);
    const workRevision = createWorkItemRevision({ id: "work-revision-full", workItemId: work.id, number: 1, label: "r01", status: "CAD complete", sourcePath: "cad/enclosure.step", createdAt: "2026-01-02T00:00:00.000Z" });
    projects.createWorkItemRevision(workRevision);
    const line = createBomLine({ id: "bom-full", revisionId: revision.id, name: "ESP32 board", quantity: 1, unit: "board", required: true, optional: false, itemId: fullItem.id, alternativeItemIds: ["item-alt"], constraints: { manufacturer: "Maker", tags: ["electronics"] }, notes: "main board" });
    boms.createLine(line);
    const alternative = { id: "alternative-full", bomLineId: line.id, itemId: "item-alt", label: "Compatible board", constraints: { model: "Rev B" as const } };
    boms.createAlternative(alternative);

    expect(projects.get(project.id)).toEqual(project);
    expect(projects.get("missing-project")).toBeUndefined();
    expect(projects.list()).toEqual([project]);
    expect(projects.listRevisions(project.id)).toEqual([revision]);
    expect(projects.getRevision(revision.id)).toEqual(revision);
    expect(projects.getRevision("missing-revision")).toBeUndefined();
    expect(projects.listWorkItems(project.id)).toEqual([work]);
    expect(projects.getWorkItem(work.id)).toEqual(work);
    expect(projects.getWorkItem("missing-work")).toBeUndefined();
    expect(projects.listWorkItemRevisions(work.id)).toEqual([workRevision]);
    expect(projects.getWorkItemRevision(workRevision.id)).toEqual({ revision: workRevision, projectId: project.id });
    expect(projects.getWorkItemRevision("missing-work-revision")).toBeUndefined();
    expect(boms.getLine(line.id)).toEqual(line);
    expect(boms.getLine("missing-bom")).toBeUndefined();
    expect(boms.listLines(revision.id)).toEqual([line]);
    expect(boms.listAlternatives(line.id)).toEqual([alternative]);
    expect(() => boms.createAlternative({ ...alternative, id: "alternative-missing", bomLineId: "missing-bom" })).toThrow(/BOM line/);

    database.run("UPDATE projects SET retired_at = ? WHERE id = ?", ["2026-01-03T00:00:00.000Z", project.id]);
    expect(projects.list()).toEqual([]);
    expect(projects.list(true)).toHaveLength(1);
    expect(() => projects.createWorkItem({ ...work, id: "work-missing-project", projectId: "missing-project" })).toThrow(/project/);
    expect(() => projects.createRevision({ ...revision, id: "revision-missing-project", projectId: "missing-project", number: 2 })).toThrow(/project/);
    expect(() => projects.createWorkItemRevision({ ...workRevision, id: "work-revision-missing", workItemId: "missing-work" })).toThrow(/work item/);
  });

  it("coordinates reservation consume/release events and lists by item", () => {
    const database = makeDatabase();
    const inventory = new InventoryRepository(database);
    const reservations = new ReservationRepository(database, inventory);
    const projects = new ProjectRepository(database);
    const boms = new BomRepository(database);
    inventory.create(fullItem);
    inventory.appendStockEvent(createStockEvent({ id: "reservation-receipt", itemId: fullItem.id, kind: "receipt", quantity: 3, unit: fullItem.unit, reason: "received", occurredAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-02T00:00:00.000Z" }));
    projects.create(createProject({ id: "reservation-project", name: "Reservation project" }));
    projects.createRevision(createProjectRevision({ id: "reservation-revision", projectId: "reservation-project", number: 1 }));
    boms.createLine(createBomLine({ id: "reservation-bom", revisionId: "reservation-revision", name: fullItem.name, quantity: 2, unit: fullItem.unit, itemId: fullItem.id }));

    const reservation = reservations.create({ id: "reservation-consume", projectRevisionId: "reservation-revision", bomLineId: "reservation-bom", itemId: fullItem.id, quantity: 2, createdAt: "2026-01-03T00:00:00.000Z" });
    expect(reservation.status).toBe("active");
    expect(reservations.list()).toEqual([reservation]);
    expect(reservations.list(fullItem.id)).toEqual([reservation]);
    expect(reservations.get(reservation.id)).toEqual(reservation);
    expect(inventory.balance(fullItem.id)).toMatchObject({ onHand: 3, allocated: 2, available: 1 });

    const usageEvent = createStockEvent({
      id: "usage-consume",
      itemId: fullItem.id,
      kind: "consume",
      quantity: 2,
      unit: fullItem.unit,
      reason: "build used",
      actor: { type: "human", id: "alex" },
      source: "api",
      evidence: { projectId: "reservation-project" },
      correlationId: "usage-correlation",
      idempotencyKey: "usage-key",
      occurredAt: "2026-01-04T00:00:00.000Z",
      createdAt: "2026-01-04T00:00:00.000Z"
    });
    const consumed = reservations.consume(reservation.id, 2, usageEvent);
    expect(consumed.reservation).toMatchObject({ id: reservation.id, status: "consumed" });
    expect(consumed.releaseEvent).toMatchObject({ kind: "release", quantity: 2, actor: usageEvent.actor, source: usageEvent.source, correlationId: usageEvent.correlationId, evidence: { reservationId: reservation.id } });
    expect(consumed.usage.event).toEqual(usageEvent);
    expect(inventory.balance(fullItem.id)).toMatchObject({ onHand: 1, allocated: 0, available: 1 });
    expect(reservations.get(reservation.id)).toMatchObject({ status: "consumed" });
    expect(() => reservations.consume(reservation.id, 2, usageEvent)).toThrow(/no longer active/);

    const second = reservations.create({ id: "reservation-release", projectRevisionId: "reservation-revision", bomLineId: "reservation-bom", itemId: fullItem.id, quantity: 1, createdAt: "2026-01-05T00:00:00.000Z" });
    expect(reservations.release(second.id)).toMatchObject({ id: second.id, status: "released" });
    expect(inventory.balance(fullItem.id)).toMatchObject({ available: 1 });
    expect(() => reservations.get("missing-reservation")).not.toThrow();
    expect(reservations.get("missing-reservation")).toBeUndefined();
    expect(() => reservations.release("missing-reservation")).toThrow(/does not exist/);
    expect(() => reservations.consume("missing-reservation", 1, usageEvent)).toThrow(/does not exist/);
  });

  it("retains audit history and rejects malformed persisted actors", () => {
    const database = makeDatabase();
    const audits = new AuditRepository(database);
    const first: AuditRecord = createAuditRecord({ id: "audit-first", action: "item.created", entityType: "inventory_item", entityId: fullItem.id, actor: { type: "human", id: "alex", label: "Alex" }, sourceSurface: "ui", occurredAt: "2026-01-01T00:00:00.000Z", correlationId: "corr-first", beforeVersion: 1, afterVersion: 2, metadata: { reason: "test" } });
    const second = createAuditRecord({ id: "audit-second", action: "item.updated", entityType: "inventory_item", entityId: "other-item", actor: { type: "system", id: "worker" }, sourceSurface: "system", occurredAt: "2026-01-02T00:00:00.000Z", correlationId: "corr-second" });
    audits.append(first);
    audits.append(second);
    expect(audits.list()).toEqual([first, second]);
    expect(audits.list(fullItem.id)).toEqual([first]);
    database.run("INSERT INTO audit_log (id, action, entity_type, entity_id, actor_json, source_surface, occurred_at, correlation_id, before_version, after_version, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["audit-malformed", "bad", "inventory_item", "bad-item", "not-json", "api", "2026-01-03T00:00:00.000Z", "corr-bad", null, null, null]);
    expect(() => audits.list()).toThrow(/actor is malformed/);
  });
});

describe("BenchDatabase lifecycle", () => {
  it("commits async transactions and refuses operations after idempotent close", async () => {
    const database = makeDatabase();
    await expect(database.transactionAsync(async () => {
      database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?)", ["async-commit", "yes"]);
      await Promise.resolve();
    })).resolves.toBeUndefined();
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["async-commit"])).toMatchObject({ value: "yes" });
    database.close();
    database.close();
    expect(() => database.exec("SELECT 1")).toThrow("database is closed");
    expect(() => database.run("SELECT 1")).toThrow("database is closed");
    expect(() => database.all("SELECT 1")).toThrow("database is closed");
    expect(() => database.get("SELECT 1")).toThrow("database is closed");
    expect(() => database.transaction(() => undefined)).toThrow("database is closed");
    await expect(database.transactionAsync(() => undefined)).rejects.toThrow("database is closed");
  });
});
