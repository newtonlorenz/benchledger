import type { BenchDatabase, SqliteRow } from "./sqlite.js";
import { CATALOG_SCHEMA_SQL, INVENTORY_CATEGORY_SCHEMA_SQL, WORKSPACE_SECURITY_SCHEMA_SQL } from "./schema.js";
import { BUILTIN_INVENTORY_CATEGORIES, normalizeInventoryCategoryKey } from "@benchledger/domain";

export const WORKSPACE_SECURITY_SCHEMA_VERSION = 1;
export const WORKSPACE_SECURITY_SCHEMA_MIGRATION_SQL = WORKSPACE_SECURITY_SCHEMA_SQL;

export const PROJECT_SCHEMA_VERSION = 1;

/** Add durable, reversible BOM retirement without rewriting requirement data. */
export function migrateProjectSchema(database: BenchDatabase): void {
  database.transaction(() => {
    const current = database.get<{ readonly value: unknown }>("SELECT value FROM forge_meta WHERE key = ?", ["project_schema_version"]);
    const currentVersion = current === undefined ? 0 : Number(current.value);
    if (!Number.isInteger(currentVersion) || currentVersion < 0) throw new Error("BenchLedger project schema version is invalid");
    if (currentVersion > PROJECT_SCHEMA_VERSION) throw new Error(`BenchLedger project schema ${currentVersion} is newer than supported version ${PROJECT_SCHEMA_VERSION}`);
    const columns = database.all<SqliteRow>("PRAGMA table_info(bom_lines)");
    if (!columns.some((column) => column.name === "retired_at")) {
      database.exec("ALTER TABLE bom_lines ADD COLUMN retired_at TEXT");
    }
    const runtimeMetadata = database.get<SqliteRow>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'forge_runtime_metadata'");
    if (runtimeMetadata !== undefined) {
      const legacyRows = database.all<SqliteRow>("SELECT entity_id, payload_json, updated_at FROM forge_runtime_metadata WHERE entity_type = ?", ["bom_line"]);
      for (const row of legacyRows) {
        if (typeof row.entity_id !== "string" || typeof row.payload_json !== "string" || typeof row.updated_at !== "string") continue;
        try {
          const payload = JSON.parse(row.payload_json) as unknown;
          if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && (payload as { readonly retired?: unknown }).retired === true) {
            database.run("UPDATE bom_lines SET retired_at = COALESCE(retired_at, ?) WHERE id = ?", [row.updated_at, row.entity_id]);
          }
        } catch {
          // Malformed legacy metadata was never trustworthy retirement evidence.
        }
      }
    }
    database.run(
      "INSERT INTO forge_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ["project_schema_version", String(PROJECT_SCHEMA_VERSION)]
    );
  });
}

/** Additive workspace access migration; safe to run on every startup. */
export function migrateWorkspaceSecuritySchema(database: BenchDatabase): void {
  database.transaction(() => {
    const current = database.get<{ readonly value: unknown }>("SELECT value FROM forge_meta WHERE key = ?", ["workspace_security_schema_version"]);
    const currentVersion = current === undefined ? 0 : Number(current.value);
    if (!Number.isInteger(currentVersion) || currentVersion < 0) {
      throw new Error("BenchLedger workspace security schema version is invalid");
    }
    if (currentVersion > WORKSPACE_SECURITY_SCHEMA_VERSION) {
      throw new Error(`BenchLedger workspace security schema ${currentVersion} is newer than supported version ${WORKSPACE_SECURITY_SCHEMA_VERSION}`);
    }
    database.exec(WORKSPACE_SECURITY_SCHEMA_MIGRATION_SQL);
    database.run(
      "INSERT INTO forge_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ["workspace_security_schema_version", String(WORKSPACE_SECURITY_SCHEMA_VERSION)]
    );
  });
}

/** Additive exact-product migration; safe to run on every startup. */
export const CATALOG_SCHEMA_VERSION = 3;
export const CATALOG_SCHEMA_MIGRATION_SQL = CATALOG_SCHEMA_SQL;

export function migrateCatalogSchema(database: BenchDatabase): void {
  database.transaction(() => {
    const current = database.get<{ readonly value: unknown }>("SELECT value FROM forge_meta WHERE key = ?", ["catalog_schema_version"]);
    const currentVersion = current === undefined ? 0 : Number(current.value);
    if (!Number.isInteger(currentVersion) || currentVersion < 0) {
      throw new Error("BenchLedger catalog schema version is invalid");
    }
    if (currentVersion > CATALOG_SCHEMA_VERSION) {
      throw new Error(`BenchLedger catalog schema ${currentVersion} is newer than supported version ${CATALOG_SCHEMA_VERSION}`);
    }
    database.exec(CATALOG_SCHEMA_MIGRATION_SQL);
    database.run(
      "INSERT INTO forge_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ["catalog_schema_version", String(CATALOG_SCHEMA_VERSION)]
    );
  });
}

export const INVENTORY_CATEGORY_SCHEMA_VERSION = 1;
export const INVENTORY_CATEGORY_SCHEMA_MIGRATION_SQL = INVENTORY_CATEGORY_SCHEMA_SQL;

/** Add the managed taxonomy and additive item assignment table without
 * rewriting existing inventory rows or their evidence/source JSON. */
export function migrateInventoryCategorySchema(database: BenchDatabase): void {
  database.transaction(() => {
    const current = database.get<{ readonly value: unknown }>("SELECT value FROM forge_meta WHERE key = ?", ["inventory_category_schema_version"]);
    const currentVersion = current === undefined ? 0 : Number(current.value);
    if (!Number.isInteger(currentVersion) || currentVersion < 0) throw new Error("BenchLedger inventory category schema version is invalid");
    if (currentVersion > INVENTORY_CATEGORY_SCHEMA_VERSION) throw new Error(`BenchLedger inventory category schema ${currentVersion} is newer than supported version ${INVENTORY_CATEGORY_SCHEMA_VERSION}`);
    const columns = database.all<SqliteRow>("PRAGMA table_info(inventory_categories)");
    if (columns.length === 0) {
      // New databases deliberately reach this branch through the same
      // startup migration as legacy databases. Keeping category DDL out of
      // SCHEMA_SQL means an older table can be altered before indexes are
      // recreated with the current normalized key semantics.
      database.exec(INVENTORY_CATEGORY_SCHEMA_MIGRATION_SQL);
    } else {
      if (!columns.some((column) => column.name === "normalized_name")) {
        database.exec("ALTER TABLE inventory_categories ADD COLUMN normalized_name TEXT NOT NULL DEFAULT ''");
      }
      const existing = database.all<SqliteRow>("SELECT id, name FROM inventory_categories");
      for (const row of existing) {
        if (typeof row.id !== "string" || typeof row.name !== "string") throw new Error("BenchLedger inventory category row is invalid");
        database.run("UPDATE inventory_categories SET normalized_name = ? WHERE id = ?", [normalizeInventoryCategoryKey(row.name), row.id]);
      }
      database.exec("DROP INDEX IF EXISTS inventory_categories_sibling_name_idx; DROP INDEX IF EXISTS inventory_categories_parent_idx; DROP INDEX IF EXISTS inventory_categories_archived_idx;");
      // This creates the assignment table for upgraded databases and
      // recreates all current indexes after normalized_name is populated.
      database.exec(INVENTORY_CATEGORY_SCHEMA_MIGRATION_SQL);
    }
    database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ["inventory_category_schema_version", String(INVENTORY_CATEGORY_SCHEMA_VERSION)]);
    seedBuiltinInventoryCategories(database);
  });
}

function seedBuiltinInventoryCategories(database: BenchDatabase): void {
  for (const category of BUILTIN_INVENTORY_CATEGORIES) {
    database.run(
      "INSERT INTO inventory_categories (id, name, normalized_name, parent_id, sort_order, archived, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      [category.id, category.name, normalizeInventoryCategoryKey(category.name), category.parentId ?? null, category.sortOrder, category.archived ? 1 : 0, category.createdAt, category.updatedAt, category.version]
    );
  }
}
