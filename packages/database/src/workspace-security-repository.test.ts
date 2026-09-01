import { describe, expect, it } from "vitest";
import { BenchDatabase, WORKSPACE_SECURITY_SCHEMA_VERSION, WorkspaceSecurityConflict, WorkspaceSecurityRepository, migrateWorkspaceSecuritySchema } from "./index.js";

describe("workspace security repository", () => {
  it("initializes open by default and imports a bootstrap hash only once", () => {
    const database = new BenchDatabase(":memory:");
    migrateWorkspaceSecuritySchema(database);
    migrateWorkspaceSecuritySchema(database);
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["workspace_security_schema_version"])).toEqual({ value: String(WORKSPACE_SECURITY_SCHEMA_VERSION) });
    const repository = new WorkspaceSecurityRepository(database);
    expect(repository.ensureInitialized(undefined)).toMatchObject({ mode: "lan_open", encodedPasswordHash: null, version: 1, credentialRevision: 1 });
    expect(repository.ensureInitialized("ignored-later-hash")).toMatchObject({ mode: "lan_open", encodedPasswordHash: null, version: 1, credentialRevision: 1 });
    database.close();
  });

  it("refuses a future migration version", () => {
    const database = new BenchDatabase(":memory:");
    database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?)", ["workspace_security_schema_version", String(WORKSPACE_SECURITY_SCHEMA_VERSION + 1)]);
    expect(() => migrateWorkspaceSecuritySchema(database)).toThrow(/newer than supported/);
    database.close();
  });

  it("imports a configured hash for a fresh database and applies optimistic revisions", () => {
    const database = new BenchDatabase(":memory:");
    const repository = new WorkspaceSecurityRepository(database);
    expect(repository.ensureInitialized("bootstrap-hash")).toMatchObject({ mode: "password", encodedPasswordHash: "bootstrap-hash", version: 1, credentialRevision: 1 });
    expect(repository.update("password", "next-hash", 1)).toMatchObject({ version: 2, credentialRevision: 2, encodedPasswordHash: "next-hash" });
    expect(() => repository.update("lan_open", null, 1)).toThrow(WorkspaceSecurityConflict);
    expect(() => repository.update("lan_open", "bad", 2)).toThrow(/cannot retain/);
    database.close();
  });

});
