import { describe, expect, it } from "vitest";
import { createAuditRecord, createBomLine, createOfferSnapshot, createProject, createProjectRevision, createStockEvent, createSupplier, createWorkItem, createWorkItemRevision } from "@benchledger/domain";
import { AuditRepository, BomRepository, BenchDatabase, InventoryRepository, ProcurementRepository, ProjectRepository, ReservationRepository } from "./index.js";
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
