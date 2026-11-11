import { DEFAULT_STOCK_RECEIVING_POLICY, isStockReceivingPolicy, type StockReceivingPolicy } from "@benchledger/domain";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";

const SINGLETON_ID = 1;

export const WORKSPACE_PREFERENCES_SCHEMA_VERSION = 1;

/** Singleton row of workspace-wide interpretation preferences. */
export const WORKSPACE_PREFERENCES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS forge_workspace_preferences (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  stock_receiving_policy TEXT NOT NULL CHECK (stock_receiving_policy IN ('on_purchase', 'on_delivery', 'on_receipt')),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TEXT NOT NULL
);
`;

/** Additive migration; safe to run on every startup. */
export function migrateWorkspacePreferencesSchema(database: BenchDatabase): void {
  database.transaction(() => {
    const current = database.get<{ readonly value: unknown }>("SELECT value FROM forge_meta WHERE key = ?", ["workspace_preferences_schema_version"]);
    const currentVersion = current === undefined ? 0 : Number(current.value);
    if (!Number.isInteger(currentVersion) || currentVersion < 0) throw new Error("BenchLedger workspace preferences schema version is invalid");
    if (currentVersion > WORKSPACE_PREFERENCES_SCHEMA_VERSION) {
      throw new Error(`BenchLedger workspace preferences schema ${currentVersion} is newer than supported version ${WORKSPACE_PREFERENCES_SCHEMA_VERSION}`);
    }
    database.exec(WORKSPACE_PREFERENCES_SCHEMA_SQL);
    database.run(
      "INSERT INTO forge_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ["workspace_preferences_schema_version", String(WORKSPACE_PREFERENCES_SCHEMA_VERSION)]
    );
  });
}

export interface WorkspacePreferencesRecord {
  readonly stockReceivingPolicy: StockReceivingPolicy;
  readonly version: number;
  readonly updatedAt: string;
}

export class WorkspacePreferencesConflict extends Error {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "WorkspacePreferencesConflict";
    this.details = details;
  }
}

type WorkspacePreferencesRow = SqliteRow & {
  readonly stock_receiving_policy?: unknown;
  readonly version?: unknown;
  readonly updated_at?: unknown;
};

function recordFromRow(row: WorkspacePreferencesRow | undefined): WorkspacePreferencesRecord | null {
  if (row === undefined) return null;
  if (!isStockReceivingPolicy(row.stock_receiving_policy)) throw new Error("Workspace stock receiving policy is invalid");
  if (typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error("Workspace preferences version is invalid");
  if (typeof row.updated_at !== "string" || row.updated_at.length === 0) throw new Error("Workspace preferences updatedAt is invalid");
  return { stockReceivingPolicy: row.stock_receiving_policy, version: row.version, updatedAt: row.updated_at };
}

export class WorkspacePreferencesRepository {
  constructor(private readonly database: BenchDatabase) {}

  get(): WorkspacePreferencesRecord | null {
    return recordFromRow(this.database.get<WorkspacePreferencesRow>(
      "SELECT stock_receiving_policy, version, updated_at FROM forge_workspace_preferences WHERE singleton_id = ?",
      [SINGLETON_ID]
    ));
  }

  /** Create the default row once. Existing durable state always wins. */
  ensureInitialized(): WorkspacePreferencesRecord {
    const existing = this.get();
    if (existing !== null) return existing;
    const updatedAt = new Date().toISOString();
    this.database.run(
      "INSERT INTO forge_workspace_preferences (singleton_id, stock_receiving_policy, version, updated_at) VALUES (?, ?, 1, ?)",
      [SINGLETON_ID, DEFAULT_STOCK_RECEIVING_POLICY, updatedAt]
    );
    return { stockReceivingPolicy: DEFAULT_STOCK_RECEIVING_POLICY, version: 1, updatedAt };
  }

  update(stockReceivingPolicy: StockReceivingPolicy, expectedVersion: number | undefined): WorkspacePreferencesRecord {
    if (!isStockReceivingPolicy(stockReceivingPolicy)) throw new Error("Workspace stock receiving policy is invalid");
    const current = this.get();
    if (current === null) throw new Error("Workspace preferences have not been initialized");
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new WorkspacePreferencesConflict("Workspace preferences changed since they were read", { expectedVersion, actualVersion: current.version });
    }
    const version = current.version + 1;
    const updatedAt = new Date().toISOString();
    this.database.run(
      "UPDATE forge_workspace_preferences SET stock_receiving_policy = ?, version = ?, updated_at = ? WHERE singleton_id = ? AND version = ?",
      [stockReceivingPolicy, version, updatedAt, SINGLETON_ID, current.version]
    );
    return { stockReceivingPolicy, version, updatedAt };
  }
}
