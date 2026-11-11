import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionRuntime, type ProductionRuntime, type ProductionRuntimeOptions } from "./index.js";
import { seedSyntheticDemoWorkspace } from "./demo-seed.js";

export interface DemoRuntimeOptions extends Pick<ProductionRuntimeOptions, "maxUploadBytes" | "maxStorageBytes" | "workspacePasswordHash" | "workspacePasswordVerifier" | "workspacePasswordHasher"> {
  /** `synthetic` (default) loads the demo workspace; `empty` starts blank. */
  readonly seed?: "synthetic" | "empty";
  /** Also load the reviewed starter catalog. Defaults to false for demo parity. */
  readonly seedStarterCatalog?: boolean;
}

/**
 * Disposable runtime for demo mode and integration tests.
 *
 * It is the production SQLite runtime — the same adapters, transactions and
 * stock rules — backed by an in-memory database and a private temporary
 * artifact directory. Closing the runtime closes SQLite and removes the
 * temporary directory, so nothing outlives the process.
 */
export async function createDemoRuntime(options: DemoRuntimeOptions = {}): Promise<ProductionRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), "benchledger-demo-"));
  let runtime: ProductionRuntime;
  try {
    runtime = await createProductionRuntime({
      dataDir,
      databasePath: ":memory:",
      seedStarterCatalog: options.seedStarterCatalog ?? false,
      ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
      ...(options.maxStorageBytes === undefined ? {} : { maxStorageBytes: options.maxStorageBytes }),
      ...(options.workspacePasswordHash === undefined ? {} : { workspacePasswordHash: options.workspacePasswordHash }),
      ...(options.workspacePasswordVerifier === undefined ? {} : { workspacePasswordVerifier: options.workspacePasswordVerifier }),
      ...(options.workspacePasswordHasher === undefined ? {} : { workspacePasswordHasher: options.workspacePasswordHasher })
    });
  } catch (error: unknown) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= runtime.close().finally(() => rm(dataDir, { recursive: true, force: true }));
    return closing;
  };
  try {
    if ((options.seed ?? "synthetic") === "synthetic") await seedSyntheticDemoWorkspace(runtime.ports);
  } catch (error: unknown) {
    await close();
    throw error;
  }
  return { ...runtime, close };
}
