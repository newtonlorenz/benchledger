import type { WorkspaceSecurityMode, WorkspaceSecurityRecord } from "@benchledger/domain";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";

const SINGLETON_ID = 1;

export class WorkspaceSecurityConflict extends Error {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "WorkspaceSecurityConflict";
    this.details = details;
  }
}

type WorkspaceSecurityRow = SqliteRow & {
  readonly mode?: unknown;
  readonly password_hash?: unknown;
  readonly version?: unknown;
  readonly credential_revision?: unknown;
  readonly updated_at?: unknown;
};

function validHash(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error("Workspace security password hash is invalid");
  return value;
}

function recordFromRow(row: WorkspaceSecurityRow | undefined): WorkspaceSecurityRecord | null {
  if (row === undefined) return null;
  if (row.mode !== "lan_open" && row.mode !== "password") throw new Error("Workspace security mode is invalid");
  if (typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error("Workspace security version is invalid");
  if (typeof row.credential_revision !== "number" || !Number.isSafeInteger(row.credential_revision) || row.credential_revision < 1) throw new Error("Workspace security credential revision is invalid");
  if (typeof row.updated_at !== "string" || row.updated_at.length === 0) throw new Error("Workspace security updatedAt is invalid");
  const encodedPasswordHash = validHash(row.password_hash === null || row.password_hash === undefined ? null : String(row.password_hash));
  if (row.mode === "lan_open" && encodedPasswordHash !== null) throw new Error("LAN-open workspace security cannot retain a password hash");
  if (row.mode === "password" && encodedPasswordHash === null) throw new Error("Password workspace security requires a password hash");
  return { mode: row.mode, encodedPasswordHash, version: row.version, credentialRevision: row.credential_revision, updatedAt: row.updated_at };
}

export class WorkspaceSecurityRepository {
  constructor(private readonly database: BenchDatabase) {}

  get(): WorkspaceSecurityRecord | null {
    return recordFromRow(this.database.get<WorkspaceSecurityRow>("SELECT mode, password_hash, version, credential_revision, updated_at FROM forge_workspace_security WHERE singleton_id = ?", [SINGLETON_ID]));
  }

  /** Initialize once. Existing durable state always wins over a later env hash. */
  ensureInitialized(bootstrapHash: string | undefined): WorkspaceSecurityRecord {
    const existing = this.get();
    if (existing !== null) return existing;
    const encodedPasswordHash = bootstrapHash === undefined || bootstrapHash.length === 0 ? null : validHash(bootstrapHash);
    const mode: WorkspaceSecurityMode = encodedPasswordHash === null ? "lan_open" : "password";
    const updatedAt = new Date().toISOString();
    this.database.run(
      "INSERT INTO forge_workspace_security (singleton_id, mode, password_hash, version, credential_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [SINGLETON_ID, mode, encodedPasswordHash, 1, 1, updatedAt]
    );
    return { mode, encodedPasswordHash, version: 1, credentialRevision: 1, updatedAt };
  }

  update(mode: WorkspaceSecurityMode, encodedPasswordHash: string | null, expectedVersion: number | undefined): WorkspaceSecurityRecord {
    const current = this.get();
    if (current === null) throw new Error("Workspace security has not been initialized");
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new WorkspaceSecurityConflict("Workspace security changed since it was read", { expectedVersion, actualVersion: current.version });
    }
    const nextVersion = current.version + 1;
    const nextRevision = current.credentialRevision + 1;
    const nextHash = validHash(encodedPasswordHash);
    if (mode === "lan_open" && nextHash !== null) throw new Error("LAN-open workspace security cannot retain a password hash");
    if (mode === "password" && nextHash === null) throw new Error("Password workspace security requires a password hash");
    const updatedAt = new Date().toISOString();
    this.database.run(
      "UPDATE forge_workspace_security SET mode = ?, password_hash = ?, version = ?, credential_revision = ?, updated_at = ? WHERE singleton_id = ?",
      [mode, nextHash, nextVersion, nextRevision, updatedAt, SINGLETON_ID]
    );
    return { mode, encodedPasswordHash: nextHash, version: nextVersion, credentialRevision: nextRevision, updatedAt };
  }
}
