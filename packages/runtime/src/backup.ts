import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ArtifactStore } from "@benchledger/artifacts";
import type { ProductionRuntime, ProductionRuntimeOptions } from "./index.js";

export interface RuntimeBackupArtifact {
  readonly artifactId: string;
  readonly artifactRevisionId: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface RuntimeBackupManifest {
  readonly format: "benchledger-backup";
  readonly version: 1;
  readonly createdAt: string;
  readonly databaseFile: "benchledger.sqlite";
  readonly artifactDirectory: "artifacts";
  readonly databaseSha256: string;
  readonly artifacts: readonly RuntimeBackupArtifact[];
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function requireExternalDirectory(path: string, name: string): string {
  if (!isAbsolute(path) || path.trim().length === 0) throw new Error(`${name} must be an absolute path`);
  return resolve(path);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function quoteSqlitePath(path: string): string {
  if (path.includes("\u0000")) throw new Error("backup path contains a NUL byte");
  return path.replaceAll("'", "''");
}

function parseManifest(value: unknown): RuntimeBackupManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("backup manifest is not an object");
  const record = value as Record<string, unknown>;
  if (record.format !== "benchledger-backup" || record.version !== 1 || record.databaseFile !== "benchledger.sqlite" || record.artifactDirectory !== "artifacts") throw new Error("unsupported BenchLedger backup manifest");
  if (typeof record.databaseSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.databaseSha256)) throw new Error("backup manifest has an invalid database digest");
  if (typeof record.createdAt !== "string" || !Array.isArray(record.artifacts)) throw new Error("backup manifest is incomplete");
  const artifacts: RuntimeBackupArtifact[] = [];
  for (const value of record.artifacts) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("backup artifact entry is invalid");
    const artifact = value as Record<string, unknown>;
    if (typeof artifact.artifactId !== "string" || typeof artifact.artifactRevisionId !== "string" || typeof artifact.bytes !== "number" || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error("backup artifact entry is invalid");
    artifacts.push({ artifactId: artifact.artifactId, artifactRevisionId: artifact.artifactRevisionId, bytes: artifact.bytes, sha256: artifact.sha256 });
  }
  return { format: "benchledger-backup", version: 1, createdAt: record.createdAt, databaseFile: "benchledger.sqlite", artifactDirectory: "artifacts", databaseSha256: record.databaseSha256, artifacts };
}

/**
 * Create a portable directory backup. SQLite is copied with VACUUM INTO while
 * artifacts are copied as opaque content-addressed files; the manifest records
 * every stored artifact digest for an independent restore check.
 */
export async function backupProductionRuntime(runtime: ProductionRuntime, destination: string): Promise<RuntimeBackupManifest> {
  const target = requireExternalDirectory(destination, "backup destination");
  if (inside(runtime.dataDir, target)) throw new Error("backup destination must not be inside the live data directory");
  await assertAbsent(target, "backup destination already exists");
  if (runtime.databasePath === ":memory:") throw new Error("online backup requires a file-backed SQLite database");
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.${basename(target)}.partial-${randomUUID()}`);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    // The barrier covers VACUUM, the artifact copy, and the manifest's source
    // listing. SQLite's transaction is intentionally *not* held here:
    // VACUUM INTO cannot run inside a transaction, and the barrier is the
    // cross-store consistency boundary for this single-replica runtime.
    const manifest = await runtime.unitOfWork.exclusive(async () => {
      const databaseFile = join(staging, "benchledger.sqlite");
      runtime.database.exec(`VACUUM INTO '${quoteSqlitePath(databaseFile)}'`);
      const artifactDirectory = join(staging, "artifacts");
      await cp(runtime.artifactDir, artifactDirectory, { recursive: true, force: false, errorOnExist: true });
      const records = await runtime.artifacts.listArtifactRevisions();
      if (!records.ok) throw new Error(`cannot enumerate artifacts for backup: ${records.error.message}`);
      const snapshot: RuntimeBackupManifest = {
        format: "benchledger-backup",
        version: 1,
        createdAt: new Date().toISOString(),
        databaseFile: "benchledger.sqlite",
        artifactDirectory: "artifacts",
        databaseSha256: await sha256File(databaseFile),
        artifacts: records.value.map((artifact) => ({ artifactId: artifact.artifactId, artifactRevisionId: artifact.artifactRevisionId, bytes: artifact.bytes, sha256: artifact.sha256 }))
      };
      await writeFile(join(staging, "benchledger-backup.json"), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return snapshot;
    });
    // Verification runs after releasing the barrier. No incomplete directory
    // can be mistaken for a successful backup: the verified staging tree is
    // atomically renamed only after every SQLite/artifact check passes.
    await verifyProductionBackup(staging, { maxUploadBytes: runtime.maxUploadBytes, maxStorageBytes: runtime.maxStorageBytes });
    await assertAbsent(target, "backup destination already exists");
    await rename(staging, target);
    return manifest;
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function assertAbsent(path: string, message: string): Promise<void> {
  try {
    await stat(path);
  } catch (error: unknown) {
    if (isNodeNotFound(error)) return;
    throw error;
  }
  throw new Error(message);
}

function isNodeNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}

/** Verify a backup directory without modifying the live runtime. */
export async function verifyProductionBackup(backupDirectory: string, quotas: Pick<ProductionRuntimeOptions, "maxUploadBytes" | "maxStorageBytes"> = {}): Promise<RuntimeBackupManifest> {
  const root = requireExternalDirectory(backupDirectory, "backup directory");
  const manifest = parseManifest(JSON.parse(await readFile(join(root, "benchledger-backup.json"), "utf8")) as unknown);
  const databaseFile = join(root, manifest.databaseFile);
  const databaseStat = await stat(databaseFile);
  if (!databaseStat.isFile() || databaseStat.size === 0) throw new Error("backup SQLite file is missing or invalid");
  if (await sha256File(databaseFile) !== manifest.databaseSha256) throw new Error("backup SQLite digest does not match its manifest");
  const store = new ArtifactStore({
    root: join(root, manifest.artifactDirectory),
    maxUploadBytes: quotas.maxUploadBytes ?? 100 * 1024 * 1024,
    maxStorageBytes: quotas.maxStorageBytes ?? 10 * 1024 * 1024 * 1024
  });
  const initialized = await store.init();
  if (!initialized.ok) throw new Error(`backup artifact store could not initialize: ${initialized.error.message}`);
  const records = await store.listArtifactRevisions();
  if (!records.ok) throw new Error(`backup artifact records could not be read: ${records.error.message}`);
  const expected = new Map(manifest.artifacts.map((artifact) => [artifact.artifactRevisionId, artifact]));
  if (records.value.length !== expected.size) throw new Error("backup artifact count does not match its manifest");
  for (const artifact of records.value) {
    const entry = expected.get(artifact.artifactRevisionId);
    if (entry === undefined || entry.artifactId !== artifact.artifactId || entry.bytes !== artifact.bytes || entry.sha256 !== artifact.sha256) throw new Error(`backup artifact ${artifact.artifactRevisionId} does not match its manifest`);
    const bytes = await store.readArtifact(artifact.artifactRevisionId);
    if (!bytes.ok || bytes.value.bytes.byteLength !== entry.bytes) throw new Error(`backup artifact ${artifact.artifactRevisionId} failed byte verification`);
  }
  return manifest;
}

/** Restore into a new directory and verify both SQLite and every artifact hash. */
export async function restoreProductionBackup(backupDirectory: string, destination: string, quotas: Pick<ProductionRuntimeOptions, "maxUploadBytes" | "maxStorageBytes"> = {}): Promise<ProductionRuntime> {
  const source = requireExternalDirectory(backupDirectory, "backup directory");
  const target = requireExternalDirectory(destination, "restore destination");
  if (inside(source, target) || inside(target, source)) throw new Error("restore and backup directories must be separate");
  await verifyProductionBackup(source, quotas);
  try {
    await stat(target);
    throw new Error("restore destination already exists");
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "restore destination already exists") throw error;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  await cp(join(source, "benchledger.sqlite"), join(target, "benchledger.sqlite"), { force: false, errorOnExist: true });
  await cp(join(source, "artifacts"), join(target, "artifacts"), { recursive: true, force: false, errorOnExist: true });
  await cp(join(source, "benchledger-backup.json"), join(target, "benchledger-backup.json"), { force: false, errorOnExist: true });
  await verifyProductionBackup(target, quotas);
  const runtimeOptions: ProductionRuntimeOptions = {
    dataDir: target,
    ...(quotas.maxUploadBytes === undefined ? {} : { maxUploadBytes: quotas.maxUploadBytes }),
    ...(quotas.maxStorageBytes === undefined ? {} : { maxStorageBytes: quotas.maxStorageBytes })
  };
  const runtime = await import("./index.js").then((module) => module.createProductionRuntime(runtimeOptions));
  try {
    // Startup initializes the restored SQLite connection. The copied file and
    // artifact hashes were verified immediately before opening it; the runtime
    // health check then verifies that its schema is usable.
    const health = await runtime.ports.health?.check();
    if (health === undefined || health.database !== "ok" || health.artifacts !== "ok") throw new Error("restored runtime did not become ready");
  } catch (error: unknown) {
    await runtime.close();
    throw error;
  }
  return runtime;
}
