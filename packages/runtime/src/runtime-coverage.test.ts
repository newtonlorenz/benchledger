import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationError } from "@benchledger/application";
import type { EventBusEvent, RequestContext } from "@benchledger/application";
import { DomainError, normalizeInventoryCategoryKey } from "@benchledger/domain";
import { BenchDatabase } from "@benchledger/database";
import {
  RuntimeConflict,
  RuntimeState,
  backupProductionRuntime,
  createProductionRuntime,
  restoreProductionBackup,
  verifyProductionBackup,
  type ProductionRuntime
} from "./index.js";
import { migrateRuntimeSchema, sqlParams } from "./persistence.js";
import { mapPersistenceError, resultValue, attempt, clone, page } from "./utils.js";
import { ProductionEventBus, ProductionHealth, ProductionIdempotency } from "./runtime-ports.js";
import { ProductionInventoryAdapter } from "./inventory-adapter.js";

const runtimes: ProductionRuntime[] = [];
const directories: string[] = [];
const databases: BenchDatabase[] = [];

const context = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  actor: "coverage-agent",
  source: "api",
  correlationId: "coverage-correlation",
  scopes: new Set(["read", "write"]),
  ...overrides
});

async function makeRuntime(options: Partial<Parameters<typeof createProductionRuntime>[0]> = {}): Promise<ProductionRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), "benchledger-runtime-coverage-"));
  directories.push(dataDir);
  const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024, ...options });
  runtimes.push(runtime);
  return runtime;
}

function makeDatabase(): BenchDatabase {
  const database = new BenchDatabase(":memory:");
  databases.push(database);
  return database;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runtime configuration and persistence", () => {
  it("rejects unsafe paths and invalid quotas, and accepts environment quotas", async () => {
    await expect(createProductionRuntime({ dataDir: "relative-data" })).rejects.toThrow(/dataDir must be an absolute path/);
    const root = await mkdtemp(join(tmpdir(), "benchledger-runtime-config-"));
    directories.push(root);
    await expect(createProductionRuntime({ dataDir: root, databasePath: join(root, "..", "outside.sqlite") })).rejects.toThrow(/databasePath must remain within dataDir/);
    await expect(createProductionRuntime({ dataDir: root, artifactDir: join(root, "..", "outside-artifacts") })).rejects.toThrow(/artifactDir must remain within dataDir/);
    await expect(createProductionRuntime({ dataDir: root, maxUploadBytes: 0, maxStorageBytes: 1 })).rejects.toThrow(/maxUploadBytes must be a positive safe integer/);
    await expect(createProductionRuntime({ dataDir: root, maxUploadBytes: 2, maxStorageBytes: 1 })).rejects.toThrow(/cannot exceed/);

    const priorUpload = process.env.BENCHLEDGER_MAX_UPLOAD_BYTES;
    const priorStorage = process.env.BENCHLEDGER_MAX_STORAGE_BYTES;
    try {
      process.env.BENCHLEDGER_MAX_UPLOAD_BYTES = "2048";
      process.env.BENCHLEDGER_MAX_STORAGE_BYTES = "4096";
      const runtime = await createProductionRuntime({ dataDir: root });
      runtimes.push(runtime);
      expect(runtime.maxUploadBytes).toBe(2048);
      expect(runtime.maxStorageBytes).toBe(4096);
    } finally {
      if (priorUpload === undefined) delete process.env.BENCHLEDGER_MAX_UPLOAD_BYTES;
      else process.env.BENCHLEDGER_MAX_UPLOAD_BYTES = priorUpload;
      if (priorStorage === undefined) delete process.env.BENCHLEDGER_MAX_STORAGE_BYTES;
      else process.env.BENCHLEDGER_MAX_STORAGE_BYTES = priorStorage;
    }

    const invalidEnv = process.env.BENCHLEDGER_MAX_UPLOAD_BYTES;
    try {
      process.env.BENCHLEDGER_MAX_UPLOAD_BYTES = "not-a-number";
      await expect(createProductionRuntime({ dataDir: root, maxStorageBytes: 4096 })).rejects.toThrow(/BENCHLEDGER_MAX_UPLOAD_BYTES must be a positive safe integer/);
    } finally {
      if (invalidEnv === undefined) delete process.env.BENCHLEDGER_MAX_UPLOAD_BYTES;
      else process.env.BENCHLEDGER_MAX_UPLOAD_BYTES = invalidEnv;
    }
  });

  it("migrates idempotently, rejects a future schema, and preserves state semantics", () => {
    const database = makeDatabase();
    migrateRuntimeSchema(database);
    migrateRuntimeSchema(database);
    expect(database.all("SELECT version FROM forge_runtime_migrations")).toEqual([{ version: 1 }]);
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["runtime_schema_version"])).toMatchObject({ value: "1" });

    const future = makeDatabase();
    future.exec("CREATE TABLE forge_runtime_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)");
    future.run("INSERT INTO forge_runtime_migrations (version, applied_at) VALUES (?, ?)", [99, "2026-01-01T00:00:00.000Z"]);
    expect(() => migrateRuntimeSchema(future)).toThrow(/newer than supported/);

    const state = new RuntimeState(database);
    expect(state.getVersion("item", "missing")).toBe(1);
    state.setInitialVersion("item", "one");
    state.setVersion("item", "one", 3);
    state.setInitialVersion("item", "one");
    expect(state.getVersion("item", "one")).toBe(3);
    state.ensureVersion("item", "one", 3);
    expect(() => state.ensureVersion("item", "one", 2)).toThrow(RuntimeConflict);
    try {
      state.ensureVersion("item", "one", 2);
    } catch (error) {
      expect(error).toMatchObject({ details: { expectedVersion: 2, actualVersion: 3 } });
    }
    expect(state.bumpVersion("item", "one")).toBe(4);
    state.deleteVersion("item", "one");
    expect(state.getVersion("item", "one")).toBe(1);

    state.setMetadata("item", "one", { nested: { ok: true }, count: 2 });
    expect(state.getMetadata("item", "one")).toEqual({ nested: { ok: true }, count: 2 });
    database.run("UPDATE forge_runtime_metadata SET payload_json = ? WHERE entity_type = ? AND entity_id = ?", ["[]", "item", "one"]);
    expect(state.getMetadata("item", "one")).toEqual({});
    database.run("UPDATE forge_runtime_metadata SET payload_json = ? WHERE entity_type = ? AND entity_id = ?", ["not-json", "item", "one"]);
    expect(state.getMetadata("item", "one")).toEqual({});
    state.deleteMetadata("item", "one");

    expect(state.getIdempotency("agent", "key")).toBeNull();
    state.setIdempotency("agent", "key", { result: [1, 2] });
    expect(state.getIdempotency("agent", "key")).toEqual({ result: [1, 2] });
    database.run("UPDATE forge_runtime_idempotency SET payload_json = ? WHERE actor = ? AND idempotency_key = ?", ["bad", "agent", "key"]);
    expect(state.getIdempotency("agent", "key")).toBeNull();
    expect(sqlParams(["a", 1, null, new Uint8Array([2]), 3n])).toEqual(["a", 1, null, new Uint8Array([2]), 3n]);
  });

  it("upgrades a legacy category table through the real on-disk startup path", async () => {
    const root = await mkdtemp(join(tmpdir(), "benchledger-category-migration-"));
    directories.push(root);
    const databasePath = join(root, "benchledger.sqlite");
    const legacy = new BenchDatabase(databasePath);
    expect(legacy.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inventory_categories'")).toBeUndefined();
    legacy.exec(`CREATE TABLE inventory_categories (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      parent_id TEXT REFERENCES inventory_categories(id),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0)
    );
    CREATE UNIQUE INDEX inventory_categories_sibling_name_idx ON inventory_categories(COALESCE(parent_id, ''), lower(name));`);
    legacy.run("INSERT INTO inventory_categories (id, name, parent_id, sort_order, archived, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["legacy-startup-electronique", "Électronique", null, 100, 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 1]);
    legacy.close();

    const runtime = await createProductionRuntime({ dataDir: root, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(runtime);
    expect(runtime.database.get("SELECT normalized_name FROM inventory_categories WHERE id = ?", ["legacy-startup-electronique"])).toEqual({ normalized_name: normalizeInventoryCategoryKey("Électronique") });
    expect(runtime.database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inventory_item_category_assignments'")).toMatchObject({ name: "inventory_item_category_assignments" });
  });
});

describe("runtime utility and port behavior", () => {
  it("pages deterministically and clones values without sharing mutable state", () => {
    expect(page(["a", "b", "c"], 2)).toEqual({ data: ["a", "b"], limit: 2, nextCursor: "2", total: 3 });
    expect(page(["a", "b", "c"], 2, "2")).toEqual({ data: ["c"], limit: 2, total: 3 });
    expect(page(["a", "b"], 2, "bad")).toEqual({ data: ["a", "b"], limit: 2, total: 2 });
    expect(page(["a", "b"], 2, "-3")).toEqual({ data: ["a", "b"], limit: 2, total: 2 });
    const original = { nested: { value: 1 } };
    const copy = clone(original);
    copy.nested.value = 2;
    expect(original.nested.value).toBe(1);
  });

  it("maps persistence and artifact failures into stable application errors", async () => {
    const existing = new ApplicationError("forbidden", "keep");
    expect(() => mapPersistenceError(existing)).toThrow(existing);
    expect(() => mapPersistenceError(new RuntimeConflict("changed", { actualVersion: 2 }))).toThrowError(new ApplicationError("conflict", "changed", { actualVersion: 2 }));
    for (const [code, expected] of [
      ["inventory_not_found", "not_found"], ["project_not_found", "not_found"], ["duplicate_event", "conflict"],
      ["insufficient_stock", "conflict"], ["invalid_quantity", "validation"], ["unexpected_domain", "integrity_error"]
    ] as const) {
      expect(() => mapPersistenceError(new DomainError(code, "domain failure"))).toThrowError(new ApplicationError(expected, expected === "integrity_error" ? "The stored record could not be updated safely" : "domain failure"));
    }
    expect(() => mapPersistenceError(new Error("UNIQUE constraint failed"))).toThrow(/conflicts/);
    expect(() => mapPersistenceError(new Error("foreign key violation"))).toThrow(/referenced record/);
    expect(() => mapPersistenceError(new Error("unrelated database failure"))).toThrow(/persistence operation failed/);
    expect(() => mapPersistenceError("bad error")).toThrow(/persistence operation failed/);

    for (const [code, expected] of [
      ["NOT_FOUND", "not_found"], ["CONFLICT", "conflict"], ["MANIFEST_IMMUTABLE", "conflict"], ["BUNDLE_EXISTS", "conflict"],
      ["UPLOAD_QUOTA_EXCEEDED", "quota_exceeded"], ["STORAGE_QUOTA_EXCEEDED", "quota_exceeded"], ["DIGEST_MISMATCH", "validation"],
      ["SIZE_MISMATCH", "validation"], ["UPLOAD_STATE", "upload_expired"], ["INVALID_INPUT", "validation"], ["PATH_UNSAFE", "validation"], ["unknown", "integrity_error"]
    ] as const) {
      expect(() => resultValue({ ok: false, error: { code, message: `${code} failure` } })).toThrowError(new ApplicationError(expected, expected === "integrity_error" ? "The artifact operation failed" : `${code} failure`));
    }
    await expect(attempt(async () => 3)).resolves.toBe(3);
    await expect(attempt(async () => { throw new DomainError("invalid_quantity", "bad quantity"); })).rejects.toMatchObject({ code: "validation" });
  });

  it("publishes cloned events, persists idempotency values, and reports health failures", async () => {
    const bus = new ProductionEventBus();
    const event: EventBusEvent = { id: "event-1", type: "inventory.updated", entityType: "inventory_item", entityId: "item-1", version: 2, correlationId: "corr-1", at: "2026-01-01T00:00:00.000Z" };
    const received: EventBusEvent[] = [];
    const unsubscribe = bus.subscribe((value) => received.push(value));
    bus.publish(event);
    expect(received).toEqual([event]);
    expect(received[0]).not.toBe(event);
    unsubscribe();
    bus.publish(event);
    expect(received).toHaveLength(1);

    const runtime = await makeRuntime();
    const idempotency = new ProductionIdempotency(new RuntimeState(runtime.database));
    await idempotency.set("agent", "key", { answer: { value: 1 } });
    const stored = await idempotency.get("agent", "key") as { answer: { value: number } };
    stored.answer.value = 2;
    await expect(idempotency.get("agent", "key")).resolves.toEqual({ answer: { value: 1 } });
    await expect(idempotency.get("agent", "missing")).resolves.toBeNull();

    await expect(runtime.ports.health?.check()).resolves.toEqual({ database: "ok", artifacts: "ok" });
    runtime.database.run("DELETE FROM forge_meta WHERE key = ?", ["runtime_schema_version"]);
    await expect(runtime.ports.health?.check()).resolves.toEqual({ database: "failed", artifacts: "ok" });

    const failingDatabase = new BenchDatabase(":memory:");
    databases.push(failingDatabase);
    const failingArtifacts = runtime.artifacts as typeof runtime.artifacts & { getUsage: typeof runtime.artifacts.getUsage };
    const originalGetUsage = failingArtifacts.getUsage.bind(runtime.artifacts);
    failingArtifacts.getUsage = async () => ({ ok: false as const, error: { code: "IO_ERROR" as const, message: "unavailable", details: {} } });
    const health = new ProductionHealth(failingDatabase, runtime.artifacts);
    await expect(health.check()).resolves.toEqual({ database: "failed", artifacts: "failed" });
    failingArtifacts.getUsage = originalGetUsage;
    health.markClosed();
    await expect(health.check()).resolves.toEqual({ database: "failed", artifacts: "failed" });
  });
});

describe("production inventory and procurement adapters", () => {
  it("filters inventory, updates versions, records physical counts, and retires items", async () => {
    const runtime = await makeRuntime();
    const confirmed = await runtime.ports.inventory.createItem({
      id: "adapter-board",
      name: "ESP32 controller",
      kind: "electronic",
      description: "Controller board",
      manufacturer: "Maker Labs",
      model: "ESP32-S3",
      sku: "ESP32-S3-DEV",
      quantity: 4,
      unit: "each",
      location: "drawer A",
      condition: "new",
      dimensions: { lengthMm: 50, widthMm: 25, measured: true, uncertaintyMm: 0.1, note: "caliper" },
      tags: ["controller", "wifi"],
      links: [{ supplier: "Parts Shop", url: "https://parts.example/esp32", currentPriceMinor: 1200, currency: "EUR", packageQuantity: 1 }],
      evidence: { state: "physically_counted", observedAt: "2026-01-01T00:00:00.000Z" }
    }, context());
    const uncertain = await runtime.ports.inventory.createItem({
      id: "adapter-filament",
      name: "PETG white spool",
      kind: "filament",
      quantity: 750,
      unit: "gram",
      tags: ["petg"],
      links: [],
      evidence: { state: "delivered_uncounted", source: "order-email" }
    }, context());
    expect(confirmed).toMatchObject({ availableQuantity: 4, evidence: { state: "physically_counted" }, dimensions: { lengthMm: 50 } });
    expect(uncertain).toMatchObject({ availableQuantity: 0, evidence: { state: "delivered_uncounted" } });

    await expect(runtime.ports.inventory.listItems({ limit: 10, q: "  CONTROLLER ", kind: "electronic", evidence: "physically_counted", available: true })).resolves.toMatchObject({ data: [{ id: confirmed.id }], total: 1 });
    await expect(runtime.ports.inventory.listItems({ limit: 10, evidence: "delivered_uncounted", available: false })).resolves.toMatchObject({ data: [{ id: uncertain.id }] });
    await expect(runtime.ports.inventory.listItems({ limit: 1, cursor: "bad" })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(runtime.ports.inventory.listItems({ limit: 10, q: "does-not-exist" })).resolves.toMatchObject({ data: [], total: 0 });

    const updated = await runtime.ports.inventory.updateItem(confirmed.id, {
      name: "ESP32 controller updated",
      description: "Updated description",
      manufacturer: "Maker Labs",
      model: "ESP32-S3-R2",
      sku: "ESP32-S3-R2",
      location: "drawer B",
      condition: "good",
      dimensions: { lengthMm: 52, widthMm: 26, measured: false },
      tags: ["controller", "r2"],
      links: [{ supplier: "New Parts", url: "https://parts.example/new" }]
    }, confirmed.version, context());
    expect(updated).toMatchObject({ name: "ESP32 controller updated", version: 2, availableQuantity: 4, location: "drawer B", condition: "good" });
    await expect(runtime.ports.inventory.updateItem(confirmed.id, { name: "stale" }, confirmed.version, context())).rejects.toMatchObject({ code: "conflict" });
    await expect(runtime.ports.inventory.updateItem(confirmed.id, { quantity: 6 }, updated.version, context())).rejects.toMatchObject({ code: "validation" });

    const inventory = runtime.ports.inventory as ProductionInventoryAdapter;
    const recounted = await inventory.recordPhysicalCount(confirmed.id, 6, context(), "recounted");
    expect(recounted).toMatchObject({ item: { quantity: 6, availableQuantity: 6, version: 3 } });

    const count = await inventory.recordPhysicalCount(confirmed.id, 5, context({ idempotencyKey: "physical-adapter" }), "bench recount");
    const replay = await inventory.recordPhysicalCount(confirmed.id, 5, context({ idempotencyKey: "physical-adapter" }), "ignored retry");
    expect(count.event).toMatchObject({ type: "count", quantity: 5, note: "bench recount", actor: "coverage-agent", source: "api" });
    expect(replay.event.id).toBe(count.event.id);
    expect(replay.item.version).toBe(count.item.version);
    await expect(inventory.recordPhysicalCount(confirmed.id, -1, context())).rejects.toMatchObject({ code: "validation" });
    await expect(inventory.recordPhysicalCount("missing-item", 1, context())).rejects.toMatchObject({ code: "not_found" });

    runtime.database.run("UPDATE inventory_items SET retired_at = ?, updated_at = ? WHERE id = ?", ["2026-01-05T00:00:00.000Z", "2026-01-05T00:00:00.000Z", uncertain.id]);
    await expect(runtime.ports.inventory.getItem(uncertain.id)).resolves.toBeNull();
    await expect(runtime.ports.inventory.listItems({ limit: 10 })).resolves.toMatchObject({ data: [{ id: confirmed.id }], total: 1 });
    await expect(runtime.ports.inventory.listItems({ limit: 10, includeRetired: true })).resolves.toMatchObject({ data: [{ id: confirmed.id }, { id: "adapter-filament" }], total: 2 });
    expect(inventory.native(confirmed.id)).toBeDefined();
    expect(inventory.balance(confirmed.id)).toMatchObject({ onHand: 5, available: 5 });
    expect(inventory.version(confirmed.id)).toBe(count.item.version);
    expect(inventory.metadata(confirmed.id)).toMatchObject({ kind: "electronic", sku: "ESP32-S3-R2", location: "drawer B" });
  });

  it("persists managed category hierarchy and additive item assignments", async () => {
    const runtime = await makeRuntime();
    const categories = runtime.ports.inventoryCategories!;
    const parent = await categories.createCategory({ id: "runtime-category-parent", name: "Runtime parent", sortOrder: 900 }, context());
    const child = await categories.createCategory({ id: "runtime-category-child", name: "Runtime child", parentId: parent.id, sortOrder: 1 }, context());
    expect(child.parentId).toBe(parent.id);
    await expect(categories.archiveCategory(parent.id, 1, context())).rejects.toMatchObject({ code: "conflict" });
    const renamed = await categories.updateCategory(child.id, { name: "Renamed child", sortOrder: 2 }, 1, context());
    expect(renamed).toMatchObject({ parentId: parent.id, name: "Renamed child", version: 2 });
    await expect(categories.archiveCategory(child.id, 1, context())).rejects.toMatchObject({ code: "conflict" });
    expect(await categories.archiveCategory(child.id, 2, context())).toMatchObject({ archived: true, version: 3 });
    expect(await categories.archiveCategory(parent.id, 1, context())).toMatchObject({ archived: true, version: 2 });

    const referenced = await categories.createCategory({ id: "runtime-category-referenced", name: "Runtime referenced", sortOrder: 901 }, context());
    const item = await runtime.ports.inventory.createItem({ id: "runtime-category-item", name: "Assigned tool", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], categoryNodeId: referenced.id, evidence: { state: "unknown" } }, context());
    expect(item).toMatchObject({ categoryNodeId: referenced.id, version: 1 });
    expect(runtime.database.get("SELECT category_node_id FROM inventory_item_category_assignments WHERE item_id = ?", [item.id])).toEqual({ category_node_id: referenced.id });
    await expect(categories.archiveCategory(referenced.id, 1, context())).rejects.toMatchObject({ code: "conflict" });
    await (runtime.ports.inventory as ProductionInventoryAdapter).rollbackCreatedItem(item.id);
    expect(runtime.database.get("SELECT category_node_id FROM inventory_item_category_assignments WHERE item_id = ?", [item.id])).toBeUndefined();
    expect(await categories.archiveCategory(referenced.id, 1, context())).toMatchObject({ archived: true, version: 2 });
  it("uses offset cursors as opaque inventory page tokens and rejects malformed values", async () => {
    const runtime = await makeRuntime();
    for (const id of ["page-c", "page-a", "page-b"]) {
      await runtime.ports.inventory.createItem({ id, name: "Same name", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
    }
    const first = await runtime.ports.inventory.listItems({ limit: 1 });
    expect(first.data[0]?.id).toBe("page-a");
    expect(first.nextCursor).toBe("1");
    const second = await runtime.ports.inventory.listItems({ limit: 1, cursor: first.nextCursor! });
    expect(second.data[0]?.id).toBe("page-b");
    expect(second.nextCursor).toBe("2");
    await expect(runtime.ports.inventory.listItems({ limit: 1, cursor: second.nextCursor! })).resolves.toMatchObject({ data: [{ id: "page-c" }] });
    await expect(runtime.ports.inventory.listItems({ limit: 1, cursor: "-1" })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(runtime.ports.inventory.listItems({ limit: 1, cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("keeps every native accessory category in the canonical accessory filter", async () => {
    const runtime = await makeRuntime();
    const now = "2026-08-30T10:00:00.000Z";
    for (const [id, category, name] of [
      ["native-accessory", "printer_accessory", "Accessory mount"],
      ["native-part", "printer_part", "Replacement nozzle"],
      ["native-workshop", "workshop", "Workshop tray"]
    ] as const) {
      runtime.database.run(
        `INSERT INTO inventory_items
          (id, name, category, variant, purchased_quantity, unit, source_status, reuse_policy, confidence, reported_quantity, source_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, category, null, 1, "each", "delivered_uncounted", "inspect_first", "inspect_first", 1, null, now, now]
      );
    }
    const page = await runtime.ports.inventory.listItems({ kind: "accessory", limit: 10 });
    expect(page.data.map((item) => item.id)).toEqual(["native-accessory", "native-part", "native-workshop"]);
    expect(page.data.every((item) => item.kind === "accessory")).toBe(true);
  });

  it("maps every stock event type and actor source while preserving ledger history", async () => {
    const runtime = await makeRuntime();
    await runtime.ports.inventory.createItem({ id: "ledger-item", name: "Ledger item", kind: "tool", quantity: 10, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
    const operations = [
      { type: "allocate" as const, quantity: 2, source: "mcp" as const },
      { type: "release" as const, quantity: 2, source: "import" as const },
      { type: "consume" as const, quantity: 1, source: "system" as const },
      { type: "return" as const, quantity: 1, source: "api" as const },
      { type: "correction" as const, quantity: 1, source: "ui" as const },
      { type: "loss" as const, quantity: 1, source: "api" as const },
      { type: "dispose" as const, quantity: 1, source: "api" as const },
      { type: "count" as const, quantity: 9, source: "api" as const }
    ];
    const mutations = [];
    for (const [index, operation] of operations.entries()) {
      const requestContext = index === 0
        ? context({ source: operation.source, idempotencyKey: "ledger-operation" })
        : context({ source: operation.source });
      mutations.push(await runtime.ports.inventory.recordStockEvent({ itemId: "ledger-item", type: operation.type, quantity: operation.quantity, unit: "each", ...(index === 0 ? { projectId: "project-ledger", correlationId: "input-correlation" } : {}) }, requestContext));
    }
    expect(mutations.map(({ event }) => event.type)).toEqual(operations.map(({ type }) => type === "dispose" ? "loss" : type));
    expect(mutations[0]).toMatchObject({ event: { actor: "coverage-agent", source: "mcp", projectId: "project-ledger", correlationId: "input-correlation", idempotencyKey: "ledger-operation" } });
    expect(mutations[2]).toMatchObject({ event: { actor: "coverage-agent", source: "api" } });
    expect(mutations.at(-1)).toMatchObject({ item: { quantity: 9, availableQuantity: 9 } });
    const retry = await runtime.ports.inventory.recordStockEvent({ itemId: "ledger-item", type: "allocate", quantity: 2, unit: "each" }, context({ source: "mcp", idempotencyKey: "ledger-operation" }));
    expect(retry.event.id).toBe(mutations[0]?.event.id);
    await expect(runtime.ports.inventory.recordStockEvent({ itemId: "ledger-item", type: "receipt", quantity: 1, unit: "gram" }, context())).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.ports.inventory.listStockEvents("ledger-item", 3, "0")).resolves.toMatchObject({ data: expect.any(Array), nextCursor: "3", total: 9 });
    await expect(runtime.ports.inventory.listStockEvents("missing-item", 3)).resolves.toMatchObject({ data: [], total: 0 });
  });

  it("creates offer snapshots with stable suppliers and unit-aware package units", async () => {
    const runtime = await makeRuntime();
    const units = ["each", "gram", "millimetre", "millilitre", "metre", "set"] as const;
    for (const [index, unit] of units.entries()) {
      await runtime.ports.inventory.createItem({ id: `offer-item-${index}`, name: `Offer item ${index}`, kind: "other", quantity: 1, unit, tags: [], links: [], evidence: { state: "unknown" } }, context());
      const offer = await runtime.ports.offers.createOffer({ id: `offer-${index}`, itemId: `offer-item-${index}`, name: `Offer ${index}`, supplier: "Same Supplier", url: `https://supplier.example/item-${index}`, priceMinor: 100 + index, currency: "EUR", packageQuantity: index + 1, shippingMinor: 20, staleAfterDays: 14, observedAt: "2026-01-02T00:00:00.000Z", notes: "snapshot" }, context());
      expect(offer).toMatchObject({ id: `offer-${index}`, supplier: "Same Supplier", packageQuantity: index + 1, shippingMinor: 20, staleAfterDays: 14, name: `Offer ${index}` });
    }
    const suppliers = runtime.database.all("SELECT id FROM suppliers");
    expect(suppliers).toHaveLength(1);
    const firstOffers = await runtime.ports.offers.listOffers(undefined, 3);
    expect(firstOffers).toMatchObject({ data: expect.any(Array), total: 6, nextCursor: "3" });
    const secondOffers = await runtime.ports.offers.listOffers(undefined, 3, firstOffers.nextCursor);
    expect(secondOffers.data.map((offer) => offer.id)).toEqual(["offer-3", "offer-4", "offer-5"]);
    expect(secondOffers.nextCursor).toBeUndefined();
    await expect(runtime.ports.offers.listOffers("offer-item-2", 10)).resolves.toMatchObject({ data: [{ id: "offer-2" }], total: 1 });
    const minimal = await runtime.ports.offers.createOffer({ itemId: "offer-item-0", name: "Minimal offer", supplier: "Minimal Supplier", url: "https://supplier.example/minimal", priceMinor: 0, currency: "USD", staleAfterDays: 30 }, context());
    expect(minimal).toMatchObject({ itemId: "offer-item-0", packageQuantity: 1, staleAfterDays: 30, priceMinor: 0 });
    await expect(runtime.ports.offers.createOffer({ id: "offer-missing-item", itemId: "missing-item", name: "Missing", supplier: "Supplier", url: "https://supplier.example/missing", priceMinor: 1, currency: "EUR", staleAfterDays: 30 }, context())).rejects.toMatchObject({ code: "not_found" });
    await expect(runtime.ports.offers.createOffer({ id: "offer-no-item", name: "No item", supplier: "Supplier", url: "https://supplier.example/no-item", priceMinor: 1, currency: "EUR", staleAfterDays: 30 }, context())).rejects.toMatchObject({ code: "validation" });
  });
});

describe("production audit adapter", () => {
  it("maps every request source, preserves optional audit metadata, and pages history", async () => {
    const runtime = await makeRuntime();
    const sources = ["ui", "api", "mcp", "import", "system"] as const;
    for (const [index, source] of sources.entries()) {
      const event = await runtime.ports.audit.append({ action: `audit.${source}`, actor: `actor-${source}`, source, correlationId: `audit-correlation-${index}`, entityType: "inventory_item", entityId: `audit-item-${index}`, ...(index === 0 ? { version: 2, idempotencyKey: "audit-key" } : {}) });
      expect(event).toMatchObject({ action: `audit.${source}`, actor: `actor-${source}`, source, entityId: `audit-item-${index}`, ...(index === 0 ? { version: 2, idempotencyKey: "audit-key" } : {}) });
    }
    const firstPage = await runtime.ports.audit.list(2);
    expect(firstPage).toMatchObject({ data: expect.any(Array), limit: 2, total: 5, nextCursor: "2" });
    const secondPage = await runtime.ports.audit.list(2, firstPage.nextCursor);
    expect(secondPage).toMatchObject({ data: expect.any(Array), limit: 2, total: 5, nextCursor: "4" });
    await expect(runtime.ports.audit.list(10, "4")).resolves.toMatchObject({ data: [{ entityId: expect.stringMatching(/^audit-item-/) }], total: 5 });
    const storedActors = runtime.database.all("SELECT action, actor_json FROM audit_log WHERE action LIKE 'audit.%'") as Array<{ action: string; actor_json: string }>;
    const actorTypes = Object.fromEntries(storedActors.map((row) => [row.action, (JSON.parse(row.actor_json) as { type: string }).type]));
    expect(actorTypes).toEqual({
      "audit.ui": "human",
      "audit.api": "human",
      "audit.mcp": "agent",
      "audit.import": "import",
      "audit.system": "system"
    });
  });
});

describe("production project adapter", () => {
  it("supports project/work-item history, BOM revisioning, and status filtering", async () => {
    const runtime = await makeRuntime();
    const allStatuses = ["idea", "planning", "in_progress", "validation", "complete", "retired"] as const;
    for (const status of allStatuses) {
      await runtime.ports.projects.createProject({ id: `status-${status}`, name: `Status ${status}`, status }, context());
    }
    await runtime.ports.inventory.createItem({ id: "board-adapter", name: "ESP32 board", kind: "electronic", quantity: 2, unit: "each", tags: ["board"], links: [], evidence: { state: "physically_counted" } }, context());
    await runtime.ports.inventory.createItem({ id: "alternative-adapter", name: "Compatible board", kind: "electronic", quantity: 2, unit: "each", tags: ["board"], links: [], evidence: { state: "physically_counted" } }, context());
    const project = await runtime.ports.projects.createProject({ id: "project-adapter", name: "Lamp controller", description: "A project description", status: "planning" }, context());
    expect(project).toMatchObject({ id: project.id, status: "planning", version: 1 });
    const freshProject = await runtime.ports.projects.getProject(project.id);
    expect(freshProject).not.toHaveProperty("currentRevisionId");
    await expect(runtime.ports.projects.getProject("missing-project")).resolves.toBeNull();
    await expect(runtime.ports.projects.listProjects({ limit: 100, q: "lamp" })).resolves.toMatchObject({ data: [{ id: project.id }], total: 1 });
    await expect(runtime.ports.projects.listProjects({ limit: 2, status: "idea" })).resolves.toMatchObject({ data: [{ id: "status-idea" }], total: 1 });
    await expect(runtime.ports.projects.listProjects({ limit: 2, cursor: "bad" })).resolves.toMatchObject({ data: expect.any(Array), limit: 2, total: 7, nextCursor: "2" });

    const updatedProject = await runtime.ports.projects.updateProject(project.id, { name: "Lamp controller v2", description: "Updated description", status: "in_progress" }, project.version, context());
    expect(updatedProject).toMatchObject({ name: "Lamp controller v2", description: "Updated description", status: "in_progress", version: 2 });
    await expect(runtime.ports.projects.updateProject(project.id, { name: "stale" }, project.version, context())).rejects.toMatchObject({ code: "conflict" });
    const retired = await runtime.ports.projects.updateProject(project.id, { status: "retired" }, updatedProject.version, context());
    expect(retired).toMatchObject({ status: "retired", version: 3 });

    const work = await runtime.ports.projects.createWorkItem(project.id, { id: "work-adapter", name: "Main enclosure", kind: "assembly", description: "Printed assembly" }, context());
    expect(work).toMatchObject({ projectId: project.id });
    expect(work).not.toHaveProperty("currentRevisionId");
    await expect(runtime.ports.projects.getWorkItem(work.id)).resolves.toMatchObject({ id: work.id, projectId: project.id });
    await expect(runtime.ports.projects.getWorkItem("missing-work")).resolves.toBeNull();
    await expect(runtime.ports.projects.listWorkItems(project.id)).resolves.toHaveLength(1);
    await expect(runtime.ports.projects.createWorkItem("missing-project", { id: "work-missing-project", name: "No project", kind: "part" }, context())).rejects.toMatchObject({ code: "not_found" });

    const firstRevision = await runtime.ports.projects.createProjectRevision(project.id, { id: "revision-adapter-1", name: "Initial", status: "concept", notes: "first" }, context());
    const secondRevision = await runtime.ports.projects.createProjectRevision(project.id, { id: "revision-adapter-2", name: "CAD", status: "CAD complete" }, context());
    expect(secondRevision.number).toBe(2);
    expect((await runtime.ports.projects.getProject(project.id))?.currentRevisionId).toBe(secondRevision.id);
    await expect(runtime.ports.projects.getProjectRevision(firstRevision.id)).resolves.toMatchObject({ id: firstRevision.id, number: 1, notes: "first" });
    await expect(runtime.ports.projects.getProjectRevision("missing-revision")).resolves.toBeNull();
    await expect(runtime.ports.projects.createProjectRevision("missing-project", { name: "No project", status: "concept" }, context())).rejects.toMatchObject({ code: "not_found" });

    const workRevision = await runtime.ports.projects.createWorkItemRevision(work.id, { id: "work-revision-adapter", name: "Enclosure CAD", status: "CAD complete", notes: "cad/enclosure.step" }, context());
    expect(workRevision).toMatchObject({ projectId: project.id, workItemId: work.id, notes: "cad/enclosure.step" });
    await expect(runtime.ports.projects.getWorkItemRevision(workRevision.id)).resolves.toMatchObject({ id: workRevision.id, projectId: project.id });
    await expect(runtime.ports.projects.getWorkItemRevision("missing-work-revision")).resolves.toBeNull();
    await expect(runtime.ports.projects.createWorkItemRevision("missing-work", { name: "No work", status: "concept" }, context())).rejects.toMatchObject({ code: "not_found" });

    const line = await runtime.ports.projects.createBomLine(firstRevision.id, { id: "bom-adapter", name: "ESP32 board", itemId: "board-adapter", requiredQuantity: 2, unit: "each", optional: false, alternatives: [{ itemId: "alternative-adapter", compatible: "confirmed", reason: "same pinout" }], constraints: { kind: "electronic", manufacturer: "Maker", tag: "board" }, notes: "main controller" }, context());
    expect(line).toMatchObject({ id: line.id, requiredQuantity: 2, optional: false, alternatives: [{ compatible: "confirmed" }], constraints: { kind: "electronic", manufacturer: "Maker", tag: "board" }, version: 1 });
    await expect(runtime.ports.projects.listBomLines(firstRevision.id)).resolves.toHaveLength(1);
    await expect(runtime.ports.projects.getBomLine(line.id)).resolves.toMatchObject({ id: line.id });
    await expect(runtime.ports.projects.getBomLine("missing-bom")).resolves.toBeNull();
    await expect(runtime.ports.projects.createBomLine("missing-revision", { name: "No revision", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context())).rejects.toMatchObject({ code: "not_found" });

    const updatedLine = await runtime.ports.projects.updateBomLine(line.id, { name: "Updated ESP32", requiredQuantity: 1, optional: true, alternatives: [], constraints: {}, notes: "optional" }, line.version, context());
    expect(updatedLine).toMatchObject({ name: "Updated ESP32", requiredQuantity: 1, optional: true, version: 2, notes: "optional", alternatives: [] });
    await expect(runtime.ports.projects.updateBomLine(line.id, { name: "stale" }, line.version, context())).rejects.toMatchObject({ code: "conflict" });
    const retiredLine = await runtime.ports.projects.retireBomLine(line.id, updatedLine.version, context());
    expect(retiredLine).toMatchObject({ optional: true, notes: "Retired", version: 3 });

    const unassigned = await runtime.ports.projects.createBomLine(secondRevision.id, { id: "bom-unassigned", name: "Cable", requiredQuantity: 1, unit: "metre", optional: false, alternatives: [], constraints: {} }, context());
    const unassignedUpdated = await runtime.ports.projects.updateBomLine(unassigned.id, { notes: "wire" }, unassigned.version, context());
    expect(unassignedUpdated).toMatchObject({ id: unassigned.id, version: 2, notes: "wire" });

    const initial = await runtime.ports.projects.createProjectWithInitialRevision?.({ project: { id: "atomic-project", name: "Atomic project", status: "idea" }, revision: { id: "atomic-revision", name: "Baseline", status: "concept", notes: "baseline" } }, context());
    expect(initial).toMatchObject({ project: { id: "atomic-project", currentRevisionId: "atomic-revision" }, revision: { id: "atomic-revision", number: 1, notes: "baseline" } });
  });

  it("validates reservations and records unreserved usage through the stock adapter", async () => {
    const runtime = await makeRuntime();
    const item = await runtime.ports.inventory.createItem({ id: "reservation-board", name: "ESP32 board", kind: "electronic", manufacturer: "Maker", model: "ESP32", quantity: 3, unit: "each", tags: ["board"], links: [], evidence: { state: "physically_counted" } }, context());
    const alternative = await runtime.ports.inventory.createItem({ id: "reservation-alt", name: "Compatible board", kind: "electronic", manufacturer: "Maker", model: "ESP32-alt", quantity: 2, unit: "each", tags: ["board"], links: [], evidence: { state: "physically_counted" } }, context());
    const project = await runtime.ports.projects.createProject({ id: "reservation-project-adapter", name: "Reservation project", status: "planning" }, context());
    const revision = await runtime.ports.projects.createProjectRevision(project.id, { id: "reservation-revision-adapter", name: "Initial", status: "concept" }, context());
    const line = await runtime.ports.projects.createBomLine(revision.id, { id: "reservation-line-adapter", name: item.name, itemId: item.id, requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context());
    const reservation = await runtime.ports.projects.createReservation(revision.id, { id: "reservation-adapter", lineId: line.id, itemId: item.id, quantity: 1 }, context());
    expect(reservation).toMatchObject({ status: "active", version: 1 });
    await expect(runtime.ports.projects.getReservationDetails(reservation.id)).resolves.toMatchObject({ projectId: project.id, projectRevisionId: revision.id, bomLine: { id: line.id } });
    await expect(runtime.ports.projects.getReservationDetails("missing-reservation")).resolves.toBeNull();
    await expect(runtime.ports.projects.listReservations(revision.id)).resolves.toMatchObject([{ id: reservation.id }]);
    await expect(runtime.ports.projects.releaseReservation(reservation.id, 99, context())).rejects.toMatchObject({ code: "conflict" });
    const released = await runtime.ports.projects.releaseReservation(reservation.id, reservation.version, context());
    expect(released).toMatchObject({ status: "released", version: 2 });

    const altLine = await runtime.ports.projects.createBomLine(revision.id, { id: "alternative-line-adapter", name: "Board alternative", itemId: item.id, requiredQuantity: 1, unit: "each", optional: false, alternatives: [{ itemId: alternative.id, compatible: "confirmed" }], constraints: {} }, context());
    const altReservation = await runtime.ports.projects.createReservation(revision.id, { id: "alternative-reservation-adapter", lineId: altLine.id, itemId: alternative.id, quantity: 1 }, context());
    expect(altReservation).toMatchObject({ itemId: alternative.id, status: "active" });

    const otherRevision = await runtime.ports.projects.createProjectRevision(project.id, { id: "other-revision-adapter", name: "Other", status: "concept" }, context());
    await expect(runtime.ports.projects.createReservation(otherRevision.id, { id: "wrong-revision-reservation", lineId: line.id, itemId: item.id, quantity: 1 }, context())).rejects.toMatchObject({ code: "not_found" });
    const unitLine = await runtime.ports.projects.createBomLine(revision.id, { id: "wrong-unit-line", name: "Gram board", itemId: alternative.id, requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: {} }, context());
    await expect(runtime.ports.projects.createReservation(revision.id, { id: "wrong-unit-reservation", lineId: unitLine.id, itemId: alternative.id, quantity: 1 }, context())).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.ports.projects.recordUsage({ projectId: project.id, itemId: item.id, quantity: 1, unit: "each", note: "used without reservation" }, context({ source: "import" }))).resolves.toMatchObject({ event: { type: "consume", source: "import", note: "used without reservation" } });
    await expect(runtime.ports.projects.recordUsage({ projectId: "missing-project", itemId: item.id, quantity: 1, unit: "each" }, context())).rejects.toMatchObject({ code: "not_found" });
    await expect(runtime.ports.projects.recordUsage({ projectId: project.id, itemId: "missing-item", quantity: 1, unit: "each" }, context())).rejects.toMatchObject({ code: "not_found" });
    await expect(runtime.ports.projects.recordUsage({ projectId: project.id, itemId: item.id, quantity: 1, unit: "gram" }, context())).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.ports.projects.recordUsage({ projectId: project.id, itemId: item.id, quantity: 0, unit: "each" }, context())).rejects.toMatchObject({ code: "validation" });
  });
});

describe("production artifact adapter", () => {
  it("filters, finalizes, downloads, retires, and compensates versioned artifacts", async () => {
    const runtime = await makeRuntime();
    const body = Buffer.from("artifact adapter coverage\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const begun = await runtime.ports.artifacts.beginUpload({ projectId: "artifact-project", workItemId: "artifact-work", revisionId: "artifact-revision", role: "step", filename: "adapter.step", mediaType: "model/step", byteSize: body.length, sha256, author: "coverage-agent", source: "test" }, context());
    await expect(runtime.ports.artifacts.getUploadSessionDetails(begun.id)).resolves.toMatchObject({ projectId: "artifact-project", workItemId: "artifact-work", revisionId: "artifact-revision", session: { status: "pending", maxBytes: body.length } });
    await expect(runtime.ports.artifacts.listArtifacts("artifact-project")).resolves.toEqual([]);
    await expect(runtime.ports.artifacts.writeUpload("missing-session", body)).rejects.toMatchObject({ code: "not_found" });
    await expect(runtime.ports.artifacts.readArtifact("missing-artifact")).rejects.toMatchObject({ code: "not_found" });
    await expect(runtime.ports.artifacts.writeUpload(begun.id, body)).resolves.toEqual({ receivedBytes: body.length });
    const artifact = await runtime.ports.artifacts.finalizeUpload(begun.id, context());
    expect(artifact).toMatchObject({ projectId: "artifact-project", workItemId: "artifact-work", revisionId: "artifact-revision", author: "coverage-agent", source: "test", role: "step", byteSize: body.length, sha256, version: 1, retired: false, currentCandidate: true });
    new RuntimeState(runtime.database).setMetadata("artifact", artifact.id, { author: "coverage-agent", machineBinding: { printer: "H2D", nozzle: "0.4", invalid: 42 } });
    await expect(runtime.ports.artifacts.getUploadSessionDetails(begun.id)).resolves.toMatchObject({ session: { status: "finalized" } });
    await expect(runtime.ports.artifacts.getArtifact(artifact.id)).resolves.toMatchObject({ id: artifact.id, version: 1, machineBinding: { printer: "H2D", nozzle: "0.4" } });
    await expect(runtime.ports.artifacts.getArtifact("missing-revision")).resolves.toBeNull();
    await expect(runtime.ports.artifacts.getArtifact(artifact.id)).resolves.toMatchObject({ id: artifact.id });
    await expect(runtime.ports.artifacts.listArtifacts("artifact-project", "artifact-work", "artifact-revision")).resolves.toMatchObject([{ id: artifact.id }]);
    await expect(runtime.ports.artifacts.listArtifacts("artifact-project", "wrong-work")).resolves.toEqual([]);
    const downloaded = await runtime.ports.artifacts.readArtifact(artifact.id);
    expect(downloaded).toMatchObject({ artifact: { sha256 } });
    expect(Buffer.from(downloaded.body)).toEqual(body);
    await expect(runtime.ports.artifacts.commitFinalization?.(begun.id, artifact.id)).resolves.toBeUndefined();
    const retired = await runtime.ports.artifacts.retireArtifact(artifact.id, artifact.version, context());
    expect(retired).toMatchObject({ id: artifact.id, version: 2, retired: true, currentCandidate: false });
    await expect(runtime.ports.artifacts.retireArtifact(artifact.id, artifact.version, context())).rejects.toMatchObject({ code: "conflict" });
    await expect(runtime.ports.artifacts.getArtifact(artifact.id)).resolves.toMatchObject({ retired: true, currentCandidate: false, version: 2 });

    const secondBody = Buffer.from("compensatable artifact\n");
    const secondHash = createHash("sha256").update(secondBody).digest("hex");
    const secondUpload = await runtime.ports.artifacts.beginUpload({ projectId: "artifact-project", revisionId: "artifact-revision", role: "stl", filename: "adapter.stl", mediaType: "model/stl", byteSize: secondBody.length, sha256: secondHash }, context());
    await runtime.ports.artifacts.writeUpload(secondUpload.id, secondBody);
    const secondArtifact = await runtime.ports.artifacts.finalizeUpload(secondUpload.id, context());
    await expect(runtime.ports.artifacts.rollbackFinalization?.(secondUpload.id, secondArtifact.id)).resolves.toBeUndefined();
    await expect(runtime.ports.artifacts.getArtifact(secondArtifact.id)).resolves.toBeNull();
    await expect(runtime.ports.artifacts.getUploadSessionDetails(secondUpload.id)).resolves.toMatchObject({ session: { status: "pending" } });
  });

  it("returns null for a missing persisted upload session", async () => {
    const runtime = await makeRuntime();
    await expect(runtime.ports.artifacts.getUploadSessionDetails("does-not-exist")).resolves.toBeNull();
  });
});

describe("portable runtime backup validation", () => {
  it("rejects malformed manifests, digest mismatches, and artifact count drift", async () => {
    const runtime = await makeRuntime();
    const backupParent = await mkdtemp(join(tmpdir(), "benchledger-backup-validation-"));
    directories.push(backupParent);
    const destination = join(backupParent, "snapshot");
    const manifest = await backupProductionRuntime(runtime, destination);
    const manifestPath = join(destination, "benchledger-backup.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    const parsedManifest = JSON.parse(originalManifest) as Record<string, unknown>;
    const invalidManifests: unknown[] = [
      null,
      { ...parsedManifest, format: "not-benchledger" },
      { ...parsedManifest, version: 2 },
      { ...parsedManifest, databaseSha256: "not-a-digest" },
      { ...parsedManifest, createdAt: 123 },
      { ...parsedManifest, artifacts: [{ artifactId: "only-id" }] }
    ];
    for (const invalid of invalidManifests) {
      await writeFile(manifestPath, JSON.stringify(invalid));
      await expect(verifyProductionBackup(destination)).rejects.toThrow();
    }
    await writeFile(manifestPath, originalManifest);

    const databasePath = join(destination, "benchledger.sqlite");
    const originalDatabase = await readFile(databasePath);
    await writeFile(databasePath, Buffer.from("tampered"));
    await expect(verifyProductionBackup(destination)).rejects.toThrow(/digest/);
    await writeFile(databasePath, originalDatabase);
    await rm(databasePath);
    await mkdir(databasePath);
    await expect(verifyProductionBackup(destination)).rejects.toThrow(/SQLite|directory|EISDIR|invalid/i);
    await rm(databasePath, { recursive: true });
    await writeFile(databasePath, originalDatabase);

    const countDrift = { ...parsedManifest, artifacts: [{ artifactId: "phantom", artifactRevisionId: "phantom-revision", bytes: 1, sha256: "a".repeat(64) }] };
    await writeFile(manifestPath, JSON.stringify(countDrift));
    await expect(verifyProductionBackup(destination)).rejects.toThrow(/count/);
    await writeFile(manifestPath, originalManifest);
    await expect(backupProductionRuntime(runtime, destination)).rejects.toThrow(/already exists/);
    expect(manifest.databaseSha256).toHaveLength(64);
  });

  it("enforces absolute, separate, and outside-data backup/restore locations", async () => {
    const runtime = await makeRuntime();
    const backupParent = await mkdtemp(join(tmpdir(), "benchledger-backup-paths-"));
    directories.push(backupParent);
    const destination = join(backupParent, "snapshot");
    await expect(backupProductionRuntime(runtime, "relative-backup")).rejects.toThrow(/absolute path/);
    await expect(backupProductionRuntime(runtime, runtime.dataDir)).rejects.toThrow(/inside the live data directory/);
    const manifest = await backupProductionRuntime(runtime, destination);
    expect(manifest.format).toBe("benchledger-backup");
    await expect(restoreProductionBackup("relative-backup", join(backupParent, "restored"))).rejects.toThrow(/absolute path/);
    await expect(restoreProductionBackup(destination, join(destination, "nested"))).rejects.toThrow(/separate/);
    const restoreTarget = join(backupParent, "restored");
    await mkdir(restoreTarget);
    await expect(restoreProductionBackup(destination, restoreTarget)).rejects.toThrow(/already exists/);
    await rm(restoreTarget, { recursive: true });
    const restored = await restoreProductionBackup(destination, restoreTarget);
    runtimes.push(restored);
    await expect(stat(join(restoreTarget, "benchledger.sqlite"))).resolves.toMatchObject({ isFile: expect.any(Function) });

    const memoryRuntime = await makeRuntime({ databasePath: ":memory:" });
    await expect(backupProductionRuntime(memoryRuntime, join(backupParent, "memory-backup"))).rejects.toThrow(/file-backed/);
  });
});
