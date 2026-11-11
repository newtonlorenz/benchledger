import type { WorkspacePreferencesPort } from "@benchledger/application";
import type { StockReceivingPolicy, WorkspacePreferences } from "@benchledger/api-contract";
import { DEFAULT_STOCK_RECEIVING_POLICY } from "@benchledger/domain";
import { WorkspacePreferencesConflict, WorkspacePreferencesRepository } from "@benchledger/database";
import type { BenchDatabase } from "@benchledger/database";
import { RuntimeConflict } from "./persistence.js";
import type { UnitOfWorkPort } from "@benchledger/application";
import { attempt } from "./utils.js";

/**
 * Supplies the current receiving policy to runtime projections. Adapters
 * call it per read and pass the value explicitly to the domain classifier.
 */
export interface StockReceivingPolicyReader {
  stockReceivingPolicy(): StockReceivingPolicy;
}

/** Hosts and tests without durable preferences use the conservative default. */
export const DEFAULT_STOCK_RECEIVING_POLICY_READER: StockReceivingPolicyReader = {
  stockReceivingPolicy: () => DEFAULT_STOCK_RECEIVING_POLICY
};

/** SQLite-backed singleton preferences with optimistic versions. */
export class ProductionWorkspacePreferencesAdapter implements WorkspacePreferencesPort, StockReceivingPolicyReader {
  constructor(private readonly repository: WorkspacePreferencesRepository, private readonly unitOfWork: Pick<UnitOfWorkPort, "exclusive">) {}

  /** Create the default row once; existing durable state always wins. */
  initialize(): WorkspacePreferences {
    return { ...this.repository.ensureInitialized() };
  }

  stockReceivingPolicy(): StockReceivingPolicy {
    return this.repository.get()?.stockReceivingPolicy ?? DEFAULT_STOCK_RECEIVING_POLICY;
  }

  async get(): Promise<WorkspacePreferences> {
    return this.unitOfWork.exclusive(() => attempt(() => ({ ...this.repository.ensureInitialized() })));
  }

  async setStockReceivingPolicy(policy: StockReceivingPolicy, expectedVersion: number | undefined): Promise<WorkspacePreferences> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      this.repository.ensureInitialized();
      try {
        return { ...this.repository.update(policy, expectedVersion) };
      } catch (error: unknown) {
        if (error instanceof WorkspacePreferencesConflict) throw new RuntimeConflict(error.message, error.details);
        throw error;
      }
    }));
  }
}

export function createProductionWorkspacePreferencesAdapter(database: BenchDatabase, unitOfWork: Pick<UnitOfWorkPort, "exclusive">): ProductionWorkspacePreferencesAdapter {
  return new ProductionWorkspacePreferencesAdapter(new WorkspacePreferencesRepository(database), unitOfWork);
}
