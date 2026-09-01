import { describe, expect, it } from "vitest";
import { assertWorkspaceSecurityRecord, workspaceSecurityStatus, type WorkspaceSecurityRecord } from "./workspace-security.js";

const record = (overrides: Partial<WorkspaceSecurityRecord> = {}): WorkspaceSecurityRecord => ({
  mode: "lan_open",
  encodedPasswordHash: null,
  version: 1,
  credentialRevision: 1,
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

describe("workspace security domain", () => {
  it("projects only mode, configuration, and version", () => {
    const safe = workspaceSecurityStatus(record({ mode: "password", encodedPasswordHash: "scrypt$fixture" }));
    expect(safe).toEqual({ mode: "password", passwordConfigured: true, version: 1 });
    expect(safe).not.toHaveProperty("encodedPasswordHash");
    expect(safe).not.toHaveProperty("credentialRevision");
  });

  it("rejects inconsistent credential state", () => {
    expect(() => assertWorkspaceSecurityRecord(record({ mode: "lan_open", encodedPasswordHash: "hash" }))).toThrow(/cannot retain/);
    expect(() => assertWorkspaceSecurityRecord(record({ mode: "password" }))).toThrow(/requires/);
    expect(() => assertWorkspaceSecurityRecord(record({ version: 0 }))).toThrow(/revisions/);
  });
});
