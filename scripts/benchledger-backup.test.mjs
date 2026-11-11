import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as runtimeModule from "@benchledger/runtime";
import { liveDatabaseSignals, parseArguments, run, UsageError } from "./benchledger-backup.mjs";

const offline = async () => { throw new Error("connection refused"); };
const online = async () => new Response("{}", { status: 200 });

describe("backup CLI arguments", () => {
  it("parses each subcommand", () => {
    expect(parseArguments(["backup", "/b", "--data-dir", "/d", "--online"])).toMatchObject({ command: "backup", paths: ["/b"], dataDir: "/d", online: true });
    expect(parseArguments(["verify", "/b"])).toMatchObject({ command: "verify", paths: ["/b"] });
    expect(parseArguments(["restore", "/b", "/r", "--force"])).toMatchObject({ command: "restore", paths: ["/b", "/r"], force: true });
    expect(parseArguments(["--help"])).toEqual({ command: "help" });
  });

  it("rejects relative paths, misplaced flags and unknown input", () => {
    for (const argv of [[], ["nope"], ["backup", "relative"], ["verify"], ["verify", "/b", "--force"], ["restore", "/b", "/r", "--online"], ["backup", "/b", "--data-dir"], ["backup", "/b", "--bogus"]]) {
      expect(() => parseArguments(argv), argv.join(" ")).toThrow(UsageError);
    }
  });
});

describe("backup CLI against a real runtime", () => {
  let root;
  let dataDir;
  const logs = [];
  const log = (line) => logs.push(line);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "benchledger-backup-cli-"));
    dataDir = join(root, "data");
    const runtime = await runtimeModule.createProductionRuntime({ dataDir });
    await runtime.close();
    logs.length = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("backs up, verifies and restores into a new directory", async () => {
    const env = { BENCHLEDGER_DATA_DIR: dataDir };
    const backup = join(root, "backup-1");
    const restored = join(root, "restored");
    await run(["backup", backup], { env, log, fetchImpl: offline, runtimeModule });
    await run(["verify", backup], { env, log, fetchImpl: offline, runtimeModule });
    await run(["restore", backup, restored], { env, log, fetchImpl: offline, runtimeModule });
    expect(logs[0]).toMatch(/^Backup written and verified/);
    expect(logs[1]).toMatch(/^Backup verified/);
    expect(logs[2]).toMatch(/^Backup restored and verified/);
    const reopened = await runtimeModule.createProductionRuntime({ dataDir: restored });
    try {
      await expect(reopened.ports.health.check()).resolves.toMatchObject({ database: "ok", artifacts: "ok" });
    } finally {
      await reopened.close();
    }
  });

  it("refuses to back up or restore while a server is running unless told to", async () => {
    const env = { BENCHLEDGER_DATA_DIR: dataDir };
    const backup = join(root, "backup-2");
    await expect(run(["backup", backup], { env, log, fetchImpl: online, runtimeModule })).rejects.toThrow(/looks in use/);
    await run(["backup", backup, "--online"], { env, log, fetchImpl: online, runtimeModule });
    await expect(run(["restore", backup, join(root, "r1")], { env, log, fetchImpl: online, runtimeModule })).rejects.toThrow(/looks active/);
    await run(["restore", backup, join(root, "r2"), "--force"], { env, log, fetchImpl: online, runtimeModule });
  });

  it("never restores into the live data directory and needs an existing database", async () => {
    const env = { BENCHLEDGER_DATA_DIR: dataDir };
    await expect(run(["restore", join(root, "any"), join(dataDir, "nested")], { env, log, fetchImpl: offline, runtimeModule })).rejects.toThrow(UsageError);
    await expect(run(["backup", join(root, "b"), "--data-dir", join(root, "empty")], { env, log, fetchImpl: offline, runtimeModule })).rejects.toThrow(/no BenchLedger database/);
    await expect(run(["backup", join(dataDir, "inside")], { env, log, fetchImpl: offline, runtimeModule })).rejects.toThrow(/outside the data directory/);
  });

  it("reports WAL files as a live-database signal", async () => {
    await writeFile(join(dataDir, "benchledger.sqlite-wal"), "");
    expect(await liveDatabaseSignals(dataDir, {}, offline)).toEqual([expect.stringMatching(/sqlite-wal is present/)]);
  });
});
