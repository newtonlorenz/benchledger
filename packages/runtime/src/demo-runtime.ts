import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionRuntime, type ProductionRuntime, type ProductionRuntimeOptions } from "./index.js";
import type { ApplicationPorts, ProjectPort } from "@benchledger/application";
import { seedSyntheticDemoWorkspace } from "./demo-seed.js";
import { page } from "./utils.js";

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
  return { ...runtime, ports: withCreationOrderedProjects(runtime.ports), close };
}

/**
 * Presentation-only difference from a durable workspace: the demo lists
 * active projects in creation order, so the synthetic reference project stays
 * the default "current" project after sign-in (the browser opens the first
 * listed project). Production lists the most recently updated project first.
 * Filtering, paging and every stock/reservation rule are the real adapter's.
 */
function withCreationOrderedProjects(ports: ApplicationPorts): ApplicationPorts {
  const projects = ports.projects;
  const listProjects: ProjectPort["listProjects"] = async (options) => {
    const { cursor, ...filters } = options;
    const all = await projects.listProjects({ ...filters, limit: Number.MAX_SAFE_INTEGER });
    const ordered = [...all.data].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return page(ordered, options.limit, cursor);
  };
  const wrapped = new Proxy(projects, {
    get(target, property) {
      if (property === "listProjects") return listProjects;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
  return { ...ports, projects: wrapped };
}
