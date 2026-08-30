import type { BenchDatabase, SqliteParameter, SqliteRow } from "@benchledger/database";

export const RUNTIME_SCHEMA_VERSION = 1;

/**
 * The domain/database packages deliberately keep their records small and
 * portable. These tables retain API-only projections, optimistic versions,
 * and command replay data without changing those packages' schemas.
 */
export function migrateRuntimeSchema(database: BenchDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS forge_runtime_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forge_runtime_versions (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      PRIMARY KEY (entity_type, entity_id)
    );
    CREATE TABLE IF NOT EXISTS forge_runtime_metadata (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    );
    CREATE TABLE IF NOT EXISTS forge_runtime_idempotency (
      actor TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (actor, idempotency_key)
    );
  `);
  const current = database.get<SqliteRow>("SELECT MAX(version) AS version FROM forge_runtime_migrations");
  const currentVersion = typeof current?.version === "number" ? current.version : 0;
  if (currentVersion > RUNTIME_SCHEMA_VERSION) {
    throw new Error(`BenchLedger runtime schema ${currentVersion} is newer than supported version ${RUNTIME_SCHEMA_VERSION}`);
  }
  if (currentVersion < RUNTIME_SCHEMA_VERSION) {
    database.run("INSERT INTO forge_runtime_migrations (version, applied_at) VALUES (?, ?)", [RUNTIME_SCHEMA_VERSION, new Date().toISOString()]);
  }
  database.run(
    "INSERT INTO forge_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ["runtime_schema_version", String(RUNTIME_SCHEMA_VERSION)]
  );
}

function jsonParse(value: unknown): unknown | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function jsonObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const parsed = jsonParse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Readonly<Record<string, unknown>>;
}

export class RuntimeState {
  constructor(private readonly database: BenchDatabase) {}

  getVersion(entityType: string, entityId: string): number {
    const row = this.database.get<SqliteRow>("SELECT version FROM forge_runtime_versions WHERE entity_type = ? AND entity_id = ?", [entityType, entityId]);
    return typeof row?.version === "number" && Number.isInteger(row.version) && row.version > 0 ? row.version : 1;
  }

  ensureVersion(entityType: string, entityId: string, expected: number | undefined): void {
    if (expected !== undefined && this.getVersion(entityType, entityId) !== expected) {
      throw new RuntimeConflict(`${entityType} '${entityId}' changed since it was read`, { expectedVersion: expected, actualVersion: this.getVersion(entityType, entityId) });
    }
  }

  setInitialVersion(entityType: string, entityId: string): void {
    this.database.run("INSERT OR IGNORE INTO forge_runtime_versions (entity_type, entity_id, version) VALUES (?, ?, 1)", [entityType, entityId]);
  }

  setVersion(entityType: string, entityId: string, version: number): void {
    this.database.run(
      "INSERT INTO forge_runtime_versions (entity_type, entity_id, version) VALUES (?, ?, ?) ON CONFLICT(entity_type, entity_id) DO UPDATE SET version = excluded.version",
      [entityType, entityId, version]
    );
  }

  deleteVersion(entityType: string, entityId: string): void {
    this.database.run("DELETE FROM forge_runtime_versions WHERE entity_type = ? AND entity_id = ?", [entityType, entityId]);
  }

  bumpVersion(entityType: string, entityId: string): number {
    const next = this.getVersion(entityType, entityId) + 1;
    this.setVersion(entityType, entityId, next);
    return next;
  }

  getMetadata(entityType: string, entityId: string): Readonly<Record<string, unknown>> {
    const row = this.database.get<SqliteRow>("SELECT payload_json FROM forge_runtime_metadata WHERE entity_type = ? AND entity_id = ?", [entityType, entityId]);
    return jsonObject(row?.payload_json) ?? {};
  }

  setMetadata(entityType: string, entityId: string, payload: Readonly<Record<string, unknown>>): void {
    this.database.run(
      "INSERT INTO forge_runtime_metadata (entity_type, entity_id, payload_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(entity_type, entity_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at",
      [entityType, entityId, JSON.stringify(payload), new Date().toISOString()]
    );
  }

  deleteMetadata(entityType: string, entityId: string): void {
    this.database.run("DELETE FROM forge_runtime_metadata WHERE entity_type = ? AND entity_id = ?", [entityType, entityId]);
  }

  getIdempotency(actor: string, key: string): unknown | null {
    const row = this.database.get<SqliteRow>("SELECT payload_json FROM forge_runtime_idempotency WHERE actor = ? AND idempotency_key = ?", [actor, key]);
    if (row === undefined) return null;
    return jsonParse(row.payload_json) ?? null;
  }

  setIdempotency(actor: string, key: string, value: unknown): void {
    this.database.run(
      "INSERT INTO forge_runtime_idempotency (actor, idempotency_key, payload_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(actor, idempotency_key) DO UPDATE SET payload_json = excluded.payload_json",
      [actor, key, JSON.stringify(value), new Date().toISOString()]
    );
  }
}

export class RuntimeConflict extends Error {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "RuntimeConflict";
    this.details = details;
  }
}

export function sqlParams(values: readonly (string | number | null | Uint8Array | bigint)[]): readonly SqliteParameter[] {
  return values;
}
