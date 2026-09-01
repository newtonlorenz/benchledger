/** The two workspace access modes supported by the local runtime. */
export type WorkspaceSecurityMode = "lan_open" | "password";

/**
 * Durable workspace access state. The encoded credential is deliberately
 * internal: adapters may use it for verification, but it must never cross a
 * public API or be included in an audit/event projection.
 */
export interface WorkspaceSecurityRecord {
  readonly mode: WorkspaceSecurityMode;
  readonly encodedPasswordHash: string | null;
  readonly version: number;
  readonly credentialRevision: number;
  readonly updatedAt: string;
}

/** Safe projection exposed to UI, HTTP, and MCP callers. */
export interface WorkspaceSecurityStatus {
  readonly mode: WorkspaceSecurityMode;
  readonly passwordConfigured: boolean;
  readonly version: number;
}

export function workspaceSecurityStatus(record: WorkspaceSecurityRecord): WorkspaceSecurityStatus {
  return {
    mode: record.mode,
    passwordConfigured: record.encodedPasswordHash !== null,
    version: record.version,
  };
}

export function assertWorkspaceSecurityRecord(record: WorkspaceSecurityRecord): WorkspaceSecurityRecord {
  if (record.mode === "lan_open" && record.encodedPasswordHash !== null) {
    throw new Error("LAN-open workspace security cannot retain a password hash");
  }
  if (record.mode === "password" && record.encodedPasswordHash === null) {
    throw new Error("Password workspace security requires a password hash");
  }
  if (!Number.isSafeInteger(record.version) || record.version < 1 || !Number.isSafeInteger(record.credentialRevision) || record.credentialRevision < 1) {
    throw new Error("Workspace security revisions must be positive safe integers");
  }
  if (record.updatedAt.length === 0) throw new Error("Workspace security updatedAt is required");
  return {
    ...record,
  };
}
