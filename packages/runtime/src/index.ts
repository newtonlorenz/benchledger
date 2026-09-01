import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ApplicationPorts } from "@benchledger/application";
import { ArtifactStore } from "@benchledger/artifacts";
import {
  AuditRepository, BomRepository, BenchDatabase, InventoryRepository, ProcurementRepository,
  ProjectRepository, ReservationRepository, CanonicalCatalogRepository,
  ReconciliationRepository, migrateCatalogSchema, migrateProjectSchema, migrateWorkspaceSecuritySchema,
  WorkspaceSecurityRepository
} from "@benchledger/database";
import type { WorkspacePasswordHasher, WorkspacePasswordVerifier } from "./workspace-security-adapter.js";
import { ProductionWorkspaceSecurityAdapter } from "./workspace-security-adapter.js";
import { ProductionArtifactAdapter } from "./artifact-adapter.js";
import { ProductionAuditAdapter } from "./audit-adapter.js";
import { ProductionInventoryAdapter } from "./inventory-adapter.js";
import { ProductionOfferAdapter } from "./offer-adapter.js";
import { ProductionProjectAdapter } from "./project-adapter.js";
import { migrateRuntimeSchema, RuntimeState } from "./persistence.js";
import { ProductionEventBus, ProductionHealth, ProductionIdempotency } from "./runtime-ports.js";
import { ExclusiveBarrier } from "./barrier.js";
import { ProductionUnitOfWork } from "./unit-of-work.js";
import { ProductionBuildConfigurationAdapter, ProductionCatalogAdapter } from "./catalog-adapter.js";
import { ProductionReconciliationAdapter } from "./reconciliation-adapter.js";
import { ProductionInventoryCategoryAdapter } from "./category-adapter.js";
import { seedStarterCatalog } from "./starter-catalog.js";

export interface ProductionRuntimeOptions {
  /** A persistent directory outside the source checkout. */
  readonly dataDir: string;
  readonly databasePath?: string;
  readonly artifactDir?: string;
  readonly maxUploadBytes?: number;
  readonly maxStorageBytes?: number;
  /** Optional one-time bootstrap hash. Durable state wins after first start. */
  readonly workspacePasswordHash?: string;
  /** Optional verifier for host-managed Argon2id hashes. */
  readonly workspacePasswordVerifier?: WorkspacePasswordVerifier;
  /** Optional host-managed password hasher; defaults to bounded scrypt. */
  readonly workspacePasswordHasher?: WorkspacePasswordHasher;
}

export interface ProductionRuntime {
  readonly ports: ApplicationPorts;
  readonly unitOfWork: ProductionUnitOfWork;
  readonly database: BenchDatabase;
  readonly artifacts: ArtifactStore;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly artifactDir: string;
  readonly maxUploadBytes: number;
  readonly maxStorageBytes: number;
  readonly workspaceSecurity: ProductionWorkspaceSecurityAdapter;
  close(): Promise<void>;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new Error(`${name} must be a positive safe integer`);
  return candidate;
}

function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return positiveInteger(parsed, fallback, name);
}

function ensureExternalDirectory(path: string, name: string): string {
  if (typeof path !== "string" || path.trim().length === 0 || !isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  const resolved = resolve(path);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stats = statSync(resolved);
  if (!stats.isDirectory()) throw new Error(`${name} must be a directory`);
  return resolved;
}

function childPath(root: string, candidate: string | undefined, fallback: string, name: string): string {
  const selected = candidate === undefined ? join(root, fallback) : candidate;
  const resolved = resolve(selected);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${name} must remain within dataDir`);
  return resolved;
}

/**
 * Open and initialize the durable runtime. All mutations are still expressed
 * through ApplicationPorts; the runtime only supplies storage and mappings.
 */
export async function createProductionRuntime(options: ProductionRuntimeOptions): Promise<ProductionRuntime> {
  const dataDir = ensureExternalDirectory(options.dataDir, "dataDir");
  const databasePath = options.databasePath === ":memory:" ? ":memory:" : childPath(dataDir, options.databasePath, "benchledger.sqlite", "databasePath");
  const artifactDir = childPath(dataDir, options.artifactDir, "artifacts", "artifactDir");
  const maxUploadBytes = positiveInteger(options.maxUploadBytes, envPositiveInteger("BENCHLEDGER_MAX_UPLOAD_BYTES", 100 * 1024 * 1024), "maxUploadBytes");
  const maxStorageBytes = positiveInteger(options.maxStorageBytes, envPositiveInteger("BENCHLEDGER_MAX_STORAGE_BYTES", 10 * 1024 * 1024 * 1024), "maxStorageBytes");
  if (maxUploadBytes > maxStorageBytes) throw new Error("maxUploadBytes cannot exceed maxStorageBytes");

  const database = new BenchDatabase(databasePath);
  try {
    migrateRuntimeSchema(database);
    migrateCatalogSchema(database);
    migrateProjectSchema(database);
    migrateWorkspaceSecuritySchema(database);
    seedStarterCatalog(database);
    const artifacts = new ArtifactStore({ root: artifactDir, maxUploadBytes, maxStorageBytes });
    const initialized = await artifacts.init();
    if (!initialized.ok) throw new Error(`artifact store initialization failed: ${initialized.error.message}`);
    const state = new RuntimeState(database);
    const workspaceSecurity = new ProductionWorkspaceSecurityAdapter(new WorkspaceSecurityRepository(database), options.workspacePasswordVerifier, options.workspacePasswordHasher);
    workspaceSecurity.initialize(options.workspacePasswordHash);
    const inventoryRepository = new InventoryRepository(database);
    const projectRepository = new ProjectRepository(database);
    const bomRepository = new BomRepository(database);
    const reservationRepository = new ReservationRepository(database, inventoryRepository);
    const procurementRepository = new ProcurementRepository(database);
    const auditRepository = new AuditRepository(database);
    const barrier = new ExclusiveBarrier();
    const unitOfWork = new ProductionUnitOfWork(database, barrier);
    const inventoryCategories = new ProductionInventoryCategoryAdapter(database, unitOfWork);
    const inventory = new ProductionInventoryAdapter(database, inventoryRepository, state, unitOfWork, inventoryCategories.repository);
    const events = new ProductionEventBus();
    const health = new ProductionHealth(database, artifacts);
    const canonicalCatalog = new CanonicalCatalogRepository(database);
    const reconciliationRepository = new ReconciliationRepository(database);
    const projectAdapter = new ProductionProjectAdapter(database, projectRepository, bomRepository, reservationRepository, inventory, state);
    const ports: ApplicationPorts = {
      inventory,
      inventoryCategories,
      projects: projectAdapter,
      offers: new ProductionOfferAdapter(database, procurementRepository, inventoryRepository, state),
      artifacts: new ProductionArtifactAdapter(artifacts, state, unitOfWork, canonicalCatalog.bindings),
      catalog: new ProductionCatalogAdapter(database, state, unitOfWork, canonicalCatalog.products, canonicalCatalog.profiles),
      buildConfigurations: new ProductionBuildConfigurationAdapter(database, canonicalCatalog.snapshots, unitOfWork),
      reconciliations: new ProductionReconciliationAdapter(database, reconciliationRepository, projectRepository, bomRepository, reservationRepository, inventoryRepository, inventory, projectAdapter, state, unitOfWork),
      workspaceSecurity,
      audit: new ProductionAuditAdapter(auditRepository, database, state, unitOfWork),
      events,
      idempotency: new ProductionIdempotency(state),
      unitOfWork,
      health
    };
    let closePromise: Promise<void> | undefined;
    return {
      ports,
      unitOfWork,
      database,
      artifacts,
      dataDir,
      databasePath,
      artifactDir,
      maxUploadBytes,
      maxStorageBytes,
      workspaceSecurity,
      async close(): Promise<void> {
        if (closePromise !== undefined) return closePromise;
        closePromise = barrier.shutdown(() => {
          health.markClosed();
          database.close();
        });
        return closePromise;
      }
    };
  } catch (error: unknown) {
    database.close();
    throw error;
  }
}

export * from "./backup.js";
export * from "./barrier.js";
export * from "./catalog-adapter.js";
export * from "./mappers.js";
export * from "./persistence.js";
export * from "./unit-of-work.js";
export * from "./reconciliation-adapter.js";
export * from "./category-adapter.js";
export * from "./starter-catalog-data.js";
export * from "./starter-catalog.js";
export * from "./workspace-security-adapter.js";
