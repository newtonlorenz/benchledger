import { describe, expect, it } from "vitest";
import {
  BenchDatabase, WORKSPACE_PREFERENCES_SCHEMA_VERSION, WorkspacePreferencesConflict, WorkspacePreferencesRepository, migrateWorkspacePreferencesSchema
} from "./index.js";

describe("workspace preferences repository", () => {
  it("migrates idempotently and defaults to the conservative receiving policy", () => {
    const database = new BenchDatabase(":memory:");
    migrateWorkspacePreferencesSchema(database);
    migrateWorkspacePreferencesSchema(database);
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["workspace_preferences_schema_version"])).toEqual({ value: String(WORKSPACE_PREFERENCES_SCHEMA_VERSION) });
    const repository = new WorkspacePreferencesRepository(database);
    expect(repository.get()).toBeNull();
    const initial = repository.ensureInitialized();
    expect(initial).toMatchObject({ stockReceivingPolicy: "on_receipt", version: 1 });
    expect(repository.ensureInitialized()).toEqual(initial);
    database.close();
  });

  it("refuses a future migration version", () => {
    const database = new BenchDatabase(":memory:");
    database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?)", ["workspace_preferences_schema_version", String(WORKSPACE_PREFERENCES_SCHEMA_VERSION + 1)]);
    expect(() => migrateWorkspacePreferencesSchema(database)).toThrow(/newer than supported/);
    database.close();
  });

  it("applies optimistic versions and rejects invalid stored policies", () => {
    const database = new BenchDatabase(":memory:");
    migrateWorkspacePreferencesSchema(database);
    const repository = new WorkspacePreferencesRepository(database);
    repository.ensureInitialized();
    expect(repository.update("on_delivery", 1)).toMatchObject({ stockReceivingPolicy: "on_delivery", version: 2 });
    expect(() => repository.update("on_purchase", 1)).toThrow(WorkspacePreferencesConflict);
    expect(repository.update("on_purchase", undefined)).toMatchObject({ stockReceivingPolicy: "on_purchase", version: 3 });
    expect(() => repository.update("sometimes" as never, 3)).toThrow(/policy is invalid/);
    // The CHECK constraint keeps the column closed even for direct writes.
    expect(() => database.run("UPDATE forge_workspace_preferences SET stock_receiving_policy = 'sometimes'")).toThrow();
    database.close();
  });

  it("requires initialization before an update", () => {
    const database = new BenchDatabase(":memory:");
    migrateWorkspacePreferencesSchema(database);
    expect(() => new WorkspacePreferencesRepository(database).update("on_delivery", undefined)).toThrow(/not been initialized/);
    database.close();
  });
});
