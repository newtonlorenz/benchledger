#!/usr/bin/env node
// Operator entry point for BenchLedger backups. Wraps the verified backup,
// verify and restore functions in @benchledger/runtime (build it first with
// `npm run build:server`; the Docker image ships it prebuilt).
//
//   benchledger-backup backup  <destination-dir> [--data-dir <dir>] [--online]
//   benchledger-backup verify  <backup-dir>
//   benchledger-backup restore <backup-dir> <new-data-dir> [--force]
//
// A backup is a directory (SQLite snapshot, artifacts, manifest), never a
// single file. All paths must be absolute. Restore never overwrites: it writes
// a new data directory that the operator then points BENCHLEDGER_DATA_DIR at.
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const usage = `Usage:
  benchledger-backup backup  <destination-dir> [--data-dir <dir>] [--online]
  benchledger-backup verify  <backup-dir>
  benchledger-backup restore <backup-dir> <new-data-dir> [--force]

Paths must be absolute. --data-dir defaults to BENCHLEDGER_DATA_DIR.
backup refuses while a BenchLedger server is using the data directory unless
--online is given. restore writes a NEW directory and refuses while a server
is running unless --force is given; it never overwrites existing data.`;

export class UsageError extends Error {}

/** Parses argv (without node/script) into a command description. */
export function parseArguments(argv) {
  const positional = [];
  const flags = { online: false, force: false, dataDir: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--online") flags.online = true;
    else if (value === "--force") flags.force = true;
    else if (value === "--help" || value === "-h") flags.help = true;
    else if (value === "--data-dir") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError("--data-dir requires a value");
      flags.dataDir = next;
      index += 1;
    } else if (value.startsWith("--")) throw new UsageError(`unknown option ${value}`);
    else positional.push(value);
  }
  if (flags.help) return { command: "help" };
  const [command, ...rest] = positional;
  const expected = { backup: 1, verify: 1, restore: 2 }[command];
  if (expected === undefined) throw new UsageError(command === undefined ? "missing command" : `unknown command ${command}`);
  if (rest.length !== expected) throw new UsageError(`${command} expects ${expected} path argument${expected === 1 ? "" : "s"}`);
  for (const path of rest) if (!isAbsolute(path)) throw new UsageError(`path must be absolute: ${path}`);
  if (flags.online && command !== "backup") throw new UsageError("--online applies only to backup");
  if (flags.force && command !== "restore") throw new UsageError("--force applies only to restore");
  if (flags.dataDir !== undefined && command === "verify") throw new UsageError("--data-dir does not apply to verify");
  return { command, paths: rest, ...flags };
}

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function positiveEnv(name, env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new UsageError(`${name} must be a positive integer`);
  return value;
}

/** True when a BenchLedger server answers its health endpoint on this host. */
export async function serverIsRunning(env = process.env, fetchImpl = fetch) {
  const port = env.BENCHLEDGER_PORT ?? "8792";
  try {
    // Any HTTP answer means something is serving on the BenchLedger port.
    await fetchImpl(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Describes why the data directory looks in use: a reachable server, or the
 * SQLite WAL/SHM files that exist while a connection is open (or after an
 * unclean shutdown). Returns an empty list when it looks idle.
 */
export async function liveDatabaseSignals(dataDir, env = process.env, fetchImpl = fetch) {
  const signals = [];
  if (await serverIsRunning(env, fetchImpl)) signals.push(`a BenchLedger server answers on 127.0.0.1:${env.BENCHLEDGER_PORT ?? "8792"}`);
  if (dataDir !== undefined) {
    for (const suffix of ["-wal", "-shm"]) {
      if (await exists(join(dataDir, `benchledger.sqlite${suffix}`))) signals.push(`benchledger.sqlite${suffix} is present (open connection or unclean shutdown)`);
    }
  }
  return signals;
}

async function loadRuntime() {
  try {
    return await import("@benchledger/runtime");
  } catch (error) {
    throw new Error(`cannot load @benchledger/runtime; run \`npm run build:server\` first (${error instanceof Error ? error.message : String(error)})`);
  }
}

function summary(manifest) {
  return `created ${manifest.createdAt}, ${manifest.artifacts.length} artifact revision(s), database sha256 ${manifest.databaseSha256}`;
}

export async function run(argv, { env = process.env, log = console.log, fetchImpl = fetch, runtimeModule } = {}) {
  const parsed = parseArguments(argv);
  if (parsed.command === "help") {
    log(usage);
    return;
  }
  const runtime = runtimeModule ?? (await loadRuntime());
  const quotas = {};
  const maxUploadBytes = positiveEnv("BENCHLEDGER_MAX_UPLOAD_BYTES", env);
  const maxStorageBytes = positiveEnv("BENCHLEDGER_MAX_STORAGE_BYTES", env);
  if (maxUploadBytes !== undefined) quotas.maxUploadBytes = maxUploadBytes;
  if (maxStorageBytes !== undefined) quotas.maxStorageBytes = maxStorageBytes;

  if (parsed.command === "verify") {
    const manifest = await runtime.verifyProductionBackup(parsed.paths[0], quotas);
    log(`Backup verified: ${parsed.paths[0]} (${summary(manifest)})`);
    return;
  }

  const dataDir = parsed.dataDir ?? env.BENCHLEDGER_DATA_DIR;
  if (parsed.command === "backup") {
    if (dataDir === undefined || dataDir === "" || !isAbsolute(dataDir)) throw new UsageError("backup needs an absolute --data-dir or BENCHLEDGER_DATA_DIR");
    const destination = parsed.paths[0];
    if (inside(dataDir, destination)) throw new UsageError("backup destination must be outside the data directory");
    // Opening a runtime on an empty directory would create and initialise a
    // fresh workspace; refuse instead of backing up nothing.
    if (!(await exists(join(dataDir, "benchledger.sqlite")))) throw new Error(`no BenchLedger database at ${join(dataDir, "benchledger.sqlite")}`);
    const signals = await liveDatabaseSignals(dataDir, env, fetchImpl);
    if (signals.length > 0 && !parsed.online) {
      throw new Error(`refusing to back up a data directory that looks in use: ${signals.join("; ")}. Stop the server, or pass --online to take a SQLite-consistent online snapshot (see docs/deployment.md).`);
    }
    const live = await runtime.createProductionRuntime({ dataDir, ...quotas });
    try {
      const manifest = await runtime.backupProductionRuntime(live, destination);
      log(`Backup written and verified: ${destination} (${summary(manifest)})`);
    } finally {
      await live.close();
    }
    return;
  }

  // restore
  const [source, destination] = parsed.paths;
  if (dataDir !== undefined && dataDir !== "" && inside(dataDir, destination)) {
    throw new UsageError("restore destination must not be the live data directory or inside it; restore to a new directory, then point BENCHLEDGER_DATA_DIR at it");
  }
  const signals = await liveDatabaseSignals(dataDir !== undefined && dataDir !== "" ? dataDir : undefined, env, fetchImpl);
  if (signals.length > 0 && !parsed.force) {
    throw new Error(`refusing to restore while BenchLedger looks active: ${signals.join("; ")}. Stop the server first, or pass --force.`);
  }
  const restored = await runtime.restoreProductionBackup(source, destination, quotas);
  await restored.close();
  log(`Backup restored and verified into ${destination}. Stop BenchLedger, point BENCHLEDGER_DATA_DIR at it, then start BenchLedger.`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    console.error(`benchledger-backup: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) console.error(`\n${usage}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
