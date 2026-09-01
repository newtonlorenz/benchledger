import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationService, type RequestContext } from "@benchledger/application";
import { BenchDatabase, WorkspaceSecurityRepository, migrateWorkspaceSecuritySchema } from "@benchledger/database";
import { createProductionRuntime, hashWorkspacePassword, MemoryWorkspaceSecurity, ProductionWorkspaceSecurityAdapter, WorkspaceSecurityAuthenticationError } from "./index.js";

const directories: string[] = [];
const runtimes: Awaited<ReturnType<typeof createProductionRuntime>>[] = [];

const context = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  actor: "security-test",
  source: "api",
  correlationId: "security-correlation",
  scopes: new Set(["read", "write", "admin"]),
  ...overrides,
});

async function runtimeWithTestHasher() {
  const dataDir = await mkdtemp(join(tmpdir(), "benchledger-workspace-security-"));
  directories.push(dataDir);
  const hasher = vi.fn((password: string) => hashWorkspacePassword(password));
  const verifier = vi.fn(async (_password: string, _encoded: string) => false);
  const runtime = await createProductionRuntime({
    dataDir,
    workspacePasswordHasher: hasher,
    workspacePasswordVerifier: verifier,
    maxUploadBytes: 1024 * 1024,
    maxStorageBytes: 4 * 1024 * 1024,
  });
  runtimes.push(runtime);
  return { runtime, hasher, verifier };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace security adapters", () => {
  it("defaults to LAN-open and keeps the durable state across reopen", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-workspace-bootstrap-"));
    directories.push(dataDir);
    const firstHash = await hashWorkspacePassword("first-bootstrap-password");
    const first = await createProductionRuntime({ dataDir, workspacePasswordHash: firstHash, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    expect(await first.workspaceSecurity.getStatus()).toEqual({ mode: "password", passwordConfigured: true, version: 1 });
    expect(await first.workspaceSecurity.verifyPassword("first-bootstrap-password")).toBe(true);
    await first.close();
    const second = await createProductionRuntime({ dataDir, workspacePasswordHash: "invalid-later-bootstrap", maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(second);
    expect(await second.workspaceSecurity.getStatus()).toEqual({ mode: "password", passwordConfigured: true, version: 1 });
    expect(await second.workspaceSecurity.verifyPassword("first-bootstrap-password")).toBe(true);

    const openDir = await mkdtemp(join(tmpdir(), "benchledger-workspace-open-"));
    directories.push(openDir);
    const open = await createProductionRuntime({ dataDir: openDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(open);
    expect(await open.workspaceSecurity.getStatus()).toEqual({ mode: "lan_open", passwordConfigured: false, version: 1 });
  });

  it("rejects malformed bootstrap hashes before creating a lockout record", () => {
    const database = new BenchDatabase(":memory:");
    migrateWorkspaceSecuritySchema(database);
    const repository = new WorkspaceSecurityRepository(database);
    const adapter = new ProductionWorkspaceSecurityAdapter(repository);
    expect(() => adapter.initialize("not-a-password-hash")).toThrow(/bootstrap password hash is invalid/);
    for (const algorithm of ["argon2i", "argon2d"]) {
      expect(() => adapter.initialize(`$${algorithm}$v=19$m=65536,t=3,p=1$c2FsdA$dmFsaWQtaGFzaA`)).toThrow(/bootstrap password hash is invalid/);
    }
    expect(repository.get()).toBeNull();
    database.close();
  });

  it("accepts an injected Argon verifier and reopens with the durable Argon hash", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-workspace-argon-"));
    directories.push(dataDir);
    const argonHash = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$dmFsaWQtaGFzaA";
    const verifier = vi.fn(async (password: string, encoded: string) => password === "argon-bootstrap-password" && encoded === argonHash);
    const hasher = vi.fn((password: string) => hashWorkspacePassword(password));
    const first = await createProductionRuntime({ dataDir, workspacePasswordHash: argonHash, workspacePasswordVerifier: verifier, workspacePasswordHasher: hasher, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    expect(await first.workspaceSecurity.verifyPassword("argon-bootstrap-password")).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(await first.workspaceSecurity.changePassword({ currentPassword: "argon-bootstrap-password", newPassword: "rotated-scrypt-password" }, 1)).toEqual({ mode: "password", passwordConfigured: true, version: 2 });
    expect(await first.workspaceSecurity.verifyPassword("rotated-scrypt-password")).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(2);
    await first.close();
    const second = await createProductionRuntime({ dataDir, workspacePasswordHash: "ignored", workspacePasswordVerifier: verifier, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(second);
    expect(await second.workspaceSecurity.getStatus()).toEqual({ mode: "password", passwordConfigured: true, version: 2 });
    expect(await second.workspaceSecurity.verifyPassword("rotated-scrypt-password")).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it("does not delegate malformed or unsupported hashes to the external verifier", async () => {
    const database = new BenchDatabase(":memory:");
    migrateWorkspaceSecuritySchema(database);
    const repository = new WorkspaceSecurityRepository(database);
    const verifier = vi.fn(async () => true);
    const adapter = new ProductionWorkspaceSecurityAdapter(repository, verifier);
    adapter.initialize(undefined);
    repository.update("password", "not-a-supported-password-hash", 1);
    expect(await adapter.verifyPassword("some-password")).toBe(false);
    expect(verifier).not.toHaveBeenCalled();
    database.close();
  });

  it("verifies before hashing, applies optimistic versions, and never exposes credential fields", async () => {
    const database = new BenchDatabase(":memory:");
    migrateWorkspaceSecuritySchema(database);
    const repository = new WorkspaceSecurityRepository(database);
    const hasher = vi.fn((password: string) => hashWorkspacePassword(password));
    const verifier = vi.fn(async (_password: string, _encoded: string) => false);
    const adapter = new ProductionWorkspaceSecurityAdapter(repository, verifier, hasher);
    expect(adapter.initialize(undefined)).toEqual({ mode: "lan_open", passwordConfigured: false, version: 1 });
    await expect(adapter.changePassword({ currentPassword: "old-password", newPassword: "new-password" }, 1)).rejects.toBeInstanceOf(WorkspaceSecurityAuthenticationError);
    expect(hasher).not.toHaveBeenCalled();
    await expect(adapter.enablePassword("first-password", 0)).rejects.toMatchObject({ details: { expectedVersion: 0, actualVersion: 1 } });
    expect(hasher).not.toHaveBeenCalled();
    expect(await adapter.enablePassword("first-password", 1)).toEqual({ mode: "password", passwordConfigured: true, version: 2 });
    await expect(adapter.disablePassword("first-password", 1)).rejects.toMatchObject({ details: { expectedVersion: 1, actualVersion: 2 } });
    await expect(adapter.changePassword({ currentPassword: "first-password", newPassword: "second-password" }, 1)).rejects.toMatchObject({ details: { expectedVersion: 1, actualVersion: 2 } });
    await expect(adapter.disablePassword("wrong-password", 2)).rejects.toBeInstanceOf(WorkspaceSecurityAuthenticationError);
    expect(await adapter.disablePassword("first-password", 2)).toEqual({ mode: "lan_open", passwordConfigured: false, version: 3 });
    database.close();
  });

  it("provides a memory implementation with the same secret boundary", async () => {
    const argonHash = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$dmFsaWQtaGFzaA";
    const adapter = new MemoryWorkspaceSecurity({
      verifier: async (password, hash) => hash === argonHash
        ? password === "old-password"
        : hash === `test-hash:${password}`,
      hasher: hashWorkspacePassword,
      bootstrapHash: argonHash,
    });
    expect(await adapter.getStatus()).toEqual({ mode: "password", passwordConfigured: true, version: 1 });
    expect(await adapter.changePassword({ currentPassword: "old-password", newPassword: "new-password" }, 1)).toMatchObject({ version: 2, passwordConfigured: true });
    expect(await adapter.verifyPassword("new-password")).toBe(true);
    const open = new MemoryWorkspaceSecurity();
    expect(await open.getStatus()).toEqual({ mode: "lan_open", passwordConfigured: false, version: 1 });
  });

  it("looks up idempotency before verification and hashing, and replays disable/change safely", async () => {
    const { runtime, hasher, verifier } = await runtimeWithTestHasher();
    const service = new ApplicationService(runtime.ports);
    const events: unknown[] = [];
    runtime.ports.events.subscribe((event) => events.push(event));
    await expect(service.enableWorkspacePassword("first-password", 1, context({ idempotencyKey: "security-enable-1" }))).rejects.toThrow(/opaque request fingerprint/);
    expect(hasher).not.toHaveBeenCalled();

    const enabled = await service.enableWorkspacePassword("first-password", 1, context({ idempotencyKey: "security-enable-1", fingerprint: "opaque-enable" }));
    expect(enabled.data).toEqual({ mode: "password", passwordConfigured: true, version: 2 });
    expect(hasher).toHaveBeenCalledTimes(1);
    const enableReplay = await service.enableWorkspacePassword("different-password", 1, context({ idempotencyKey: "security-enable-1", fingerprint: "opaque-enable", correlationId: "retry" }));
    expect(enableReplay.replayed).toBe(true);
    expect(enableReplay.data).toEqual(enabled.data);
    expect(hasher).toHaveBeenCalledTimes(1);
    await expect(service.enableWorkspacePassword("different-password", 1, context({ idempotencyKey: "security-enable-1", fingerprint: "other-fingerprint" }))).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(hasher).toHaveBeenCalledTimes(1);

    const disabled = await service.disableWorkspacePassword("first-password", 2, context({ idempotencyKey: "security-disable-1", fingerprint: "opaque-disable" }));
    expect(disabled.data).toEqual({ mode: "lan_open", passwordConfigured: false, version: 3 });
    const verifyCallsAfterDisable = verifier.mock.calls.length;
    const disableReplay = await service.disableWorkspacePassword("obsolete-password", 2, context({ idempotencyKey: "security-disable-1", fingerprint: "opaque-disable" }));
    expect(disableReplay.replayed).toBe(true);
    expect(disableReplay.data).toEqual(disabled.data);
    expect(verifier).toHaveBeenCalledTimes(verifyCallsAfterDisable);

    const reenabled = await service.enableWorkspacePassword("second-password", 3, context({ idempotencyKey: "security-enable-2", fingerprint: "opaque-enable-2" }));
    const changed = await service.changeWorkspacePassword({ currentPassword: "second-password", newPassword: "third-password" }, reenabled.data.version, context({ idempotencyKey: "security-change-1", fingerprint: "opaque-change" }));
    expect(changed.data).toEqual({ mode: "password", passwordConfigured: true, version: 5 });
    const hashCallsAfterChange = hasher.mock.calls.length;
    const verifyCallsAfterChange = verifier.mock.calls.length;
    const changeReplay = await service.changeWorkspacePassword({ currentPassword: "obsolete-password", newPassword: "fourth-password" }, reenabled.data.version, context({ idempotencyKey: "security-change-1", fingerprint: "opaque-change" }));
    expect(changeReplay.replayed).toBe(true);
    expect(changeReplay.data).toEqual(changed.data);
    expect(hasher).toHaveBeenCalledTimes(hashCallsAfterChange);
    expect(verifier).toHaveBeenCalledTimes(verifyCallsAfterChange);
    const changedAgain = await service.changeWorkspacePassword({ currentPassword: "third-password", newPassword: "fourth-password" }, changed.data.version, context({ idempotencyKey: "security-change-2", fingerprint: "opaque-change-2" }));
    expect(await runtime.workspaceSecurity.verifyPassword("fourth-password")).toBe(true);
    expect(changedAgain.data.version).toBe(6);

    const row = runtime.database.get<{ readonly payload_json?: unknown }>("SELECT payload_json FROM forge_runtime_idempotency WHERE actor = ? AND idempotency_key = ?", ["security-test", "security-change-1"]);
    expect(String(row?.payload_json)).not.toContain("second-password");
    expect(String(row?.payload_json)).not.toContain("third-password");
    expect(String(row?.payload_json)).not.toContain("test-hash:");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "password_enabled", metadata: { mode: "password" } }),
      expect.objectContaining({ type: "password_disabled", metadata: { mode: "lan_open" } }),
      expect.objectContaining({ type: "password_changed", metadata: { mode: "password" } }),
    ]));
    expect(JSON.stringify(events)).not.toContain("first-password");
    expect(JSON.stringify(events)).not.toContain("second-password");
    expect(JSON.stringify(events)).not.toContain("third-password");
  });

  it("rolls back each password state transition when audit persistence fails", async () => {
    const { runtime } = await runtimeWithTestHasher();
    const service = new ApplicationService(runtime.ports);
    const originalAppend = runtime.ports.audit.append.bind(runtime.ports.audit);
    runtime.ports.audit.append = async () => { throw new Error("audit unavailable"); };
    await expect(service.enableWorkspacePassword("first-password", 1, context({ idempotencyKey: "rollback-enable", fingerprint: "opaque-rollback-enable" }))).rejects.toThrow(/audit unavailable/);
    expect(await runtime.workspaceSecurity.getStatus()).toEqual({ mode: "lan_open", passwordConfigured: false, version: 1 });
    runtime.ports.audit.append = originalAppend;
    await service.enableWorkspacePassword("first-password", 1, context({ idempotencyKey: "rollback-enable", fingerprint: "opaque-rollback-enable" }));

    runtime.ports.audit.append = async () => { throw new Error("audit unavailable"); };
    await expect(service.disableWorkspacePassword("first-password", 2, context({ idempotencyKey: "rollback-disable", fingerprint: "opaque-rollback-disable" }))).rejects.toThrow(/audit unavailable/);
    expect(await runtime.workspaceSecurity.getStatus()).toEqual({ mode: "password", passwordConfigured: true, version: 2 });
    runtime.ports.audit.append = originalAppend;
    await service.disableWorkspacePassword("first-password", 2, context({ idempotencyKey: "rollback-disable", fingerprint: "opaque-rollback-disable" }));
    await service.enableWorkspacePassword("second-password", 3, context({ idempotencyKey: "commit-enable-2", fingerprint: "opaque-commit-enable-2" }));

    runtime.ports.audit.append = async () => { throw new Error("audit unavailable"); };
    await expect(service.changeWorkspacePassword({ currentPassword: "second-password", newPassword: "third-password" }, 4, context({ idempotencyKey: "rollback-change", fingerprint: "opaque-rollback-change" }))).rejects.toThrow(/audit unavailable/);
    expect(await runtime.workspaceSecurity.getStatus()).toEqual({ mode: "password", passwordConfigured: true, version: 4 });
    expect(await runtime.workspaceSecurity.verifyPassword("second-password")).toBe(true);
    runtime.ports.audit.append = originalAppend;
    await service.changeWorkspacePassword({ currentPassword: "second-password", newPassword: "third-password" }, 4, context({ idempotencyKey: "rollback-change", fingerprint: "opaque-rollback-change" }));
    expect(await runtime.workspaceSecurity.verifyPassword("third-password")).toBe(true);
  });
});
