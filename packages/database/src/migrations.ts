import type { BenchDatabase, SqliteRow } from "./sqlite.js";
import { CATALOG_SCHEMA_SQL, INSPECTION_SCHEMA_SQL, INVENTORY_CATEGORY_SCHEMA_SQL, PROJECT_SETUP_SCHEMA_SQL, WORKSPACE_SECURITY_SCHEMA_SQL } from "./schema.js";
import { BUILTIN_INVENTORY_CATEGORIES, isProjectLifecycle, normalizeInventoryCategoryKey, normalizeProjectLifecycle } from "@benchledger/domain";

export const WORKSPACE_SECURITY_SCHEMA_VERSION = 1;
export const WORKSPACE_SECURITY_SCHEMA_MIGRATION_SQL = WORKSPACE_SECURITY_SCHEMA_SQL;

export const PROJECT_SCHEMA_VERSION = 3;

export const PROJECT_SETUP_SCHEMA_VERSION = 1;
export const PROJECT_SETUP_SCHEMA_MIGRATION_SQL = PROJECT_SETUP_SCHEMA_SQL;

export const INSPECTION_SCHEMA_VERSION = 1;
export const INSPECTION_SCHEMA_MIGRATION_SQL = INSPECTION_SCHEMA_SQL;

export function migrateInspectionSchema(database: BenchDatabase): void {
  database.transaction(() => {
    const current = database.get<{ readonly value: unknown }>("SELECT value FROM forge_meta WHERE key = ?", ["inspection_schema_version"]);
    const currentVersion = current === undefined ? 0 : Number(current.value);
    if (!Number.isInteger(currentVersion) || currentVersion < 0) throw new Error("BenchLedger inspection schema version is invalid");
    if (currentVersion > INSPECTION_SCHEMA_VERSION) throw new Error(`BenchLedger inspection schema ${currentVersion} is newer than supported version ${INSPECTION_SCHEMA_VERSION}`);
    database.exec(INSPECTION_SCHEMA_MIGRATION_SQL);
    database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ["inspection_schema_version", String(INSPECTION_SCHEMA_VERSION)]);
  });
}

/** Additive preview storage. Older binaries can safely ignore this table. */
export function migrateProjectSetupSchema(database: BenchDatabase): void {
  database.transaction(() => {
    const current = database.get<{ readonly value: unknown }>("SELECT value FROM forge_meta WHERE key = ?", ["project_setup_schema_version"]);
    const currentVersion = current === undefined ? 0 : Number(current.value);
    if (!Number.isInteger(currentVersion) || currentVersion < 0) throw new Error("BenchLedger project setup schema version is invalid");
    if (currentVersion > PROJECT_SETUP_SCHEMA_VERSION) throw new Error(`BenchLedger project setup schema ${currentVersion} is newer than supported version ${PROJECT_SETUP_SCHEMA_VERSION}`);
    database.exec(PROJECT_SETUP_SCHEMA_MIGRATION_SQL);
    database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ["project_setup_schema_version", String(PROJECT_SETUP_SCHEMA_VERSION)]);
  });
}

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
    const projectColumns = database.all<SqliteRow>("PRAGMA table_info(projects)");
    if (!projectColumns.some((column) => column.name === "removed_at")) database.exec("ALTER TABLE projects ADD COLUMN removed_at TEXT");
    if (!projectColumns.some((column) => column.name === "removed_by_json")) database.exec("ALTER TABLE projects ADD COLUMN removed_by_json TEXT");
    if (!projectColumns.some((column) => column.name === "last_lifecycle_status")) database.exec("ALTER TABLE projects ADD COLUMN last_lifecycle_status TEXT");
    if (!projectColumns.some((column) => column.name === "removed_reservation_ids_json")) database.exec("ALTER TABLE projects ADD COLUMN removed_reservation_ids_json TEXT");
    if (currentVersion < 2) {
      const runtimeMetadata = database.get<SqliteRow>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'forge_runtime_metadata'");
      const metadataByProject = new Map<string, { readonly payload: Readonly<Record<string, unknown>>; readonly rawStatus?: unknown; readonly hasStatus: boolean; readonly updatedAt: string }>();
      if (runtimeMetadata !== undefined) {
        const projectRows = database.all<SqliteRow>("SELECT entity_id, payload_json, updated_at FROM forge_runtime_metadata WHERE entity_type = ?", ["project"]);
        for (const row of projectRows) {
          if (typeof row.entity_id !== "string" || typeof row.payload_json !== "string" || typeof row.updated_at !== "string") {
            throw new Error("BenchLedger project runtime metadata row is invalid");
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.payload_json) as unknown;
          } catch {
            throw new Error(`BenchLedger project ${row.entity_id} has malformed runtime metadata`);
          }
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(`BenchLedger project ${row.entity_id} has malformed runtime metadata`);
          }
          const payload = parsed as Readonly<Record<string, unknown>>;
          if (Object.hasOwn(payload, "status") && normalizeProjectLifecycle(payload.status) === undefined) {
            throw new Error(`BenchLedger project ${row.entity_id} has an unsupported legacy status`);
          }
          const hasStatus = Object.hasOwn(payload, "status");
          metadataByProject.set(row.entity_id, { payload, ...(hasStatus ? { rawStatus: payload.status } : {}), hasStatus, updatedAt: row.updated_at });
        }
      }

      // Validate every project before writing any of them. The transaction
      // therefore fails closed as one unit when either the native database
      // status or a legacy runtime status is unknown.
      const legacyProjects = database.all<SqliteRow>("SELECT id, status, updated_at, retired_at FROM projects");
      const migrations: Array<{ readonly id: string; readonly storedStatus: string; readonly effectiveStatus: unknown; readonly metadataStatus?: unknown; readonly canonicalStatus: string; readonly updatedAt: string; readonly retiredAt: string | null; readonly metadata?: Readonly<Record<string, unknown>>; }> = [];
      for (const row of legacyProjects) {
        if (typeof row.id !== "string" || typeof row.status !== "string") throw new Error("BenchLedger project row is invalid");
        const metadata = metadataByProject.get(row.id);
        const storedCanonicalStatus = normalizeProjectLifecycle(row.status);
        if (storedCanonicalStatus === undefined) throw new Error(`BenchLedger project ${row.id} has an unsupported legacy status`);
        const effectiveStatus = metadata?.hasStatus === true ? metadata.rawStatus : row.status;
        const canonicalStatus = normalizeProjectLifecycle(effectiveStatus) ?? storedCanonicalStatus;
        const updatedAt = metadata?.hasStatus === true ? metadata.updatedAt : (typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString());
        const retiredAt = canonicalStatus === "archived" ? (typeof row.retired_at === "string" ? row.retired_at : updatedAt) : null;
        if (metadata?.hasStatus === true || canonicalStatus !== row.status || retiredAt !== (typeof row.retired_at === "string" ? row.retired_at : null)) {
          migrations.push({ id: row.id, storedStatus: row.status, effectiveStatus, ...(metadata?.hasStatus === true ? { metadataStatus: metadata.rawStatus, metadata: metadata.payload } : {}), canonicalStatus, updatedAt, retiredAt });
        }
      }
      for (const migration of migrations) {
        database.run("UPDATE projects SET status = ?, retired_at = ? WHERE id = ?", [migration.canonicalStatus, migration.retiredAt, migration.id]);
        const metadata = migration.metadata;
        if (metadata !== undefined) {
          const { status: _status, ...withoutStatus } = metadata;
          database.run("UPDATE forge_runtime_metadata SET payload_json = ?, updated_at = ? WHERE entity_type = ? AND entity_id = ?", [JSON.stringify(withoutStatus), migration.updatedAt, "project", migration.id]);
        }
        database.run(
          "INSERT INTO audit_log (id, action, entity_type, entity_id, actor_json, source_surface, occurred_at, correlation_id, before_version, after_version, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [`project-lifecycle-migration:${migration.id}`, "project.lifecycle.migrated", "project", migration.id, JSON.stringify({ type: "system", id: "project-lifecycle-migration" }), "system", migration.updatedAt, `project-lifecycle-migration:${migration.id}`, null, null, JSON.stringify({ legacyStatus: migration.effectiveStatus, storedStatus: migration.storedStatus, ...(migration.metadataStatus === undefined ? {} : { metadataStatus: migration.metadataStatus }), canonicalStatus: migration.canonicalStatus })]
        );
      }
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
