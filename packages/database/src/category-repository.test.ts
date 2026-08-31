import { describe, expect, it } from "vitest";
import { BenchDatabase, InventoryCategoryRepository, migrateInventoryCategorySchema } from "./index.js";
import { normalizeInventoryCategoryKey } from "@benchledger/domain";

const at = "2026-08-31T00:00:00.000Z";

describe("inventory category repository", () => {
  it("migrates idempotently, seeds built-ins, and preserves legacy inventory rows", () => {
    const database = new BenchDatabase(":memory:");
    database.run("INSERT INTO inventory_items (id, name, category, purchased_quantity, unit, source_status, reuse_policy, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["legacy-1", "Legacy item", "tool", 1, "piece", "unknown", "inspect_first", "unknown", at, at]);
    migrateInventoryCategorySchema(database);
    migrateInventoryCategorySchema(database);
    expect(database.get("SELECT name FROM inventory_items WHERE id = ?", ["legacy-1"])).toMatchObject({ name: "Legacy item" });
    const categories = new InventoryCategoryRepository(database);
    expect(categories.list({ limit: 200 }).total).toBeGreaterThanOrEqual(6);
    expect(database.all("PRAGMA table_info(inventory_categories)").find((column) => column.name === "normalized_name")).toMatchObject({ notnull: 1 });
    expect(database.get("SELECT normalized_name FROM inventory_categories WHERE id = ?", ["category-filament"])).toEqual({ normalized_name: normalizeInventoryCategoryKey("Filament") });
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["inventory_category_schema_version"])).toEqual({ value: "1" });
    database.close();
  });

  it("adds and backfills the normalized key when upgrading the previous category table", () => {
    const database = new BenchDatabase(":memory:");
    database.exec(`CREATE TABLE inventory_categories (
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
    database.run("INSERT INTO inventory_categories (id, name, parent_id, sort_order, archived, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["legacy-electronique", "Électronique", null, 100, 0, at, at, 1]);
    migrateInventoryCategorySchema(database);
    expect(database.get("SELECT normalized_name FROM inventory_categories WHERE id = ?", ["legacy-electronique"])).toEqual({ normalized_name: normalizeInventoryCategoryKey("Électronique") });
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["inventory_category_schema_version"])).toEqual({ value: "1" });
    database.close();
  });

  it("does not overwrite renamed or archived built-in categories on later migrations", () => {
    const database = new BenchDatabase(":memory:");
    migrateInventoryCategorySchema(database);
    const categories = new InventoryCategoryRepository(database);
    expect(categories.update("category-tools", { name: "Bench tools" }, 1)).toMatchObject({ version: 2, name: "Bench tools" });
    expect(categories.archive("category-tools", 2)).toMatchObject({ version: 3, archived: true });

    migrateInventoryCategorySchema(database);

    expect(categories.get("category-tools")).toMatchObject({ version: 3, name: "Bench tools", archived: true });
    database.close();
  });

  it("rejects duplicate siblings, deep parents, and stale updates", () => {
    const database = new BenchDatabase(":memory:");
    migrateInventoryCategorySchema(database);
    const categories = new InventoryCategoryRepository(database);
    const top = categories.create({ id: "category-test", name: "Test", sortOrder: 100 });
    const child = categories.create({ id: "category-test-child", name: "Child", parentId: top.id, sortOrder: 0 });
    expect(() => categories.create({ id: "category-test-child-2", name: "child", parentId: top.id, sortOrder: 1 })).toThrow(/duplicate/i);
    expect(() => categories.create({ id: "category-too-deep", name: "Too deep", parentId: child.id, sortOrder: 0 })).toThrow(/one level|top-level/i);
    expect(categories.update(child.id, { name: "Renamed child" }, 1)).toMatchObject({ parentId: top.id, name: "Renamed child", version: 2 });
    expect(() => categories.update(top.id, { name: "Renamed" }, 99)).toThrow(/version|changed/i);
    database.close();
  });

  it("rejects Unicode case-folded duplicate sibling names", () => {
    const database = new BenchDatabase(":memory:");
    migrateInventoryCategorySchema(database);
    const categories = new InventoryCategoryRepository(database);
    categories.create({ id: "category-electronique", name: "Électronique", sortOrder: 100 });
    expect(() => categories.create({ id: "category-electronique-lower", name: "électronique", sortOrder: 101 })).toThrow(/duplicate/i);
    database.close();
  });

  it("continues a worst-case category cursor", () => {
    const database = new BenchDatabase(":memory:");
    migrateInventoryCategorySchema(database);
    const categories = new InventoryCategoryRepository(database);
    const firstId = "category-" + "a".repeat(151);
    const secondId = "category-" + "b".repeat(151);
    categories.create({ id: firstId, name: "ﬃ".repeat(120), sortOrder: 0 });
    categories.create({ id: secondId, name: "G".repeat(120), sortOrder: 0 });
    const firstPage = categories.list({ limit: 1 });
    expect(firstPage.data[0]?.id).toBe(firstId);
    expect(firstPage.nextCursor).toBeDefined();
    expect(firstPage.nextCursor?.length).toBeGreaterThan(200);
    expect(firstPage.nextCursor?.length).toBeLessThanOrEqual(512);
    const cursor = firstPage.nextCursor;
    if (cursor === undefined) throw new Error("expected a continuation cursor");
    expect(categories.list({ limit: 1, cursor }).data[0]?.id).toBe(secondId);
    database.close();
  });

  it("rejects oversized cursors before decoding, including legacy JSON cursors", () => {
    const database = new BenchDatabase(":memory:");
    migrateInventoryCategorySchema(database);
    const categories = new InventoryCategoryRepository(database);
    const oversized = "A".repeat(513);
    expect(() => categories.list({ cursor: oversized })).toThrow(/invalid/i);
    const legacyPayload = JSON.stringify({ id: "category-tools", metadata: "x".repeat(500) });
    const oversizedLegacy = Buffer.from(legacyPayload, "utf8").toString("base64url");
    expect(oversizedLegacy.length).toBeGreaterThan(512);
    expect(() => categories.list({ cursor: oversizedLegacy })).toThrow(/invalid/i);
    database.close();
  });

  it("orders accented names with the persisted binary category key", () => {
    const database = new BenchDatabase(":memory:");
    migrateInventoryCategorySchema(database);
    const categories = new InventoryCategoryRepository(database);
    categories.create({ id: "category-zebra", name: "Zebra", sortOrder: 100 });
    categories.create({ id: "category-eclair", name: "Éclair", sortOrder: 100 });
    expect(categories.list({ limit: 200 }).data.filter((value) => value.sortOrder === 100).map((value) => value.id)).toEqual(["category-zebra", "category-eclair"]);
    database.close();
  });

  it("orders emoji and private-use names by the shared UTF-8 key", () => {
    const database = new BenchDatabase(":memory:");
    migrateInventoryCategorySchema(database);
    const categories = new InventoryCategoryRepository(database);
    categories.create({ id: "category-emoji", name: "😀", sortOrder: 100 });
    categories.create({ id: "category-private-use", name: "\uE000", sortOrder: 100 });
    expect(categories.list({ limit: 200 }).data.filter((value) => value.sortOrder === 100).map((value) => value.id)).toEqual(["category-private-use", "category-emoji"]);
    database.close();
  });

  it("rejects active-child and active-inventory archives and supports deterministic pages", () => {
    const database = new BenchDatabase(":memory:");
    migrateInventoryCategorySchema(database);
    const categories = new InventoryCategoryRepository(database);
    const parent = categories.create({ id: "category-active-parent", name: "Active parent", sortOrder: 100 });
    const child = categories.create({ id: "category-active-child", name: "Active child", parentId: parent.id, sortOrder: 0 });
    expect(() => categories.archive(parent.id, 1)).toThrow(/active subcategories/i);
    expect(() => categories.archive(child.id, 1)).not.toThrow();
    expect(() => categories.archive(parent.id, 1)).not.toThrow();
    const referenced = categories.create({ id: "category-referenced", name: "Referenced", sortOrder: 101 });
    database.run("INSERT INTO inventory_items (id, name, category, purchased_quantity, unit, source_status, reuse_policy, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["active-item", "Active item", "other", 1, "piece", "unknown", "inspect_first", "unknown", at, at]);
    categories.setItemCategoryNode("active-item", referenced.id);
    expect(() => categories.archive(referenced.id, 1)).toThrow(/referenced|active/i);
    const page = categories.list({ limit: 2, includeArchived: true });
    expect(page.data.map((value) => value.id)).toEqual([...page.data].sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)).map((value) => value.id));
    expect(() => categories.list({ cursor: "malformed" })).toThrow(/invalid/i);

    const firstPage = categories.list({ limit: 2, includeArchived: true });
    expect(firstPage.nextCursor).toBeDefined();
    const cursor = firstPage.nextCursor;
    if (cursor === undefined) throw new Error("expected a continuation cursor");
    expect(() => categories.list({ cursor: `${cursor}.` })).toThrow(/invalid/i);
    const secondPage = categories.list({ limit: 2, includeArchived: true, cursor });
    expect(secondPage.data).toHaveLength(2);
    expect(new Set([...firstPage.data, ...secondPage.data].map((value) => value.id)).size).toBe(4);
    expect(secondPage.data[0]?.id).not.toBe(firstPage.data[0]?.id);
    database.close();
  });
});
