import type { BenchDatabase } from "./sqlite.js";
import { CATALOG_SCHEMA_SQL } from "./schema.js";

/** Additive exact-product migration; safe to run on every startup. */
export const CATALOG_SCHEMA_VERSION = 2;
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
