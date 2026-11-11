import { ApplicationError, conflict } from "../errors.js";
import type { Mutation, RequestContext } from "../ports.js";
import {
  stockReceivingPolicyImpactSchema, stockReceivingPolicySchema, updateWorkspacePreferencesSchema, workspacePreferencesSchema
} from "@benchledger/api-contract";
import type {
  InventoryItem, StockReceivingPolicy, StockReceivingPolicyImpact, StockReceivingPolicyImpactItem, UpdateWorkspacePreferences, WorkspacePreferences
} from "@benchledger/api-contract";
import { DEFAULT_STOCK_RECEIVING_POLICY, classifyEvidenceAvailability, countsAsInStock } from "@benchledger/domain";
import { ServiceModule } from "./module.js";

export const WORKSPACE_PREFERENCES_ENTITY_ID = "workspace";
const IMPACT_PAGE_SIZE = 200;
const IMPACT_MAX_PAGES = 50;

/** Preferences a legacy host without the port reports (never persisted). */
function defaultPreferences(): WorkspacePreferences {
  return { stockReceivingPolicy: DEFAULT_STOCK_RECEIVING_POLICY, version: 1, updatedAt: "1970-01-01T00:00:00.000Z" };
}

function impactRow(item: InventoryItem, from: StockReceivingPolicy, to: StockReceivingPolicy): StockReceivingPolicyImpactItem {
  return {
    itemId: item.id,
    name: item.name,
    evidenceState: item.evidence.state,
    quantity: item.quantity,
    unit: item.unit,
    from: classifyEvidenceAvailability(item.evidence.state, from),
    to: classifyEvidenceAvailability(item.evidence.state, to),
    allocatedQuantity: Math.max(0, item.allocatedQuantity ?? 0)
  };
}

/**
 * Workspace stock receiving policy: when bought, delivered or received stock
 * counts as in stock. A change is audited (actor, from, to), versioned and
 * refused while project reservations depend on stock that would stop
 * counting. Stored evidence is never rewritten.
 */
export class WorkspacePreferencesModule extends ServiceModule {
  async getWorkspacePreferences(): Promise<WorkspacePreferences> {
    return this.ports.unitOfWork.exclusive(async () => this.readPreferences());
  }

  /** Read-only impact of switching to `to`, computed from current inventory. */
  async previewStockReceivingPolicy(to: unknown): Promise<StockReceivingPolicyImpact> {
    const target = stockReceivingPolicySchema.parse(to);
    return this.ports.unitOfWork.exclusive(async () => this.impact(await this.readPreferences(), target));
  }

  async updateWorkspacePreferences(input: UpdateWorkspacePreferences, ctx: RequestContext): Promise<Mutation<WorkspacePreferences>> {
    const parsed = updateWorkspacePreferencesSchema.parse(input);
    const port = this.ports.workspacePreferences;
    if (port === undefined) throw new ApplicationError("integrity_error", "This runtime does not support workspace preferences");
    return this.mutate(ctx, "workspace.preferences.update", "workspace_preferences", WORKSPACE_PREFERENCES_ENTITY_ID, async () => {
      const current = await this.readPreferences();
      if (parsed.expectedVersion !== undefined && parsed.expectedVersion !== current.version) {
        throw conflict("Workspace preferences changed since they were read", { reason: "version_mismatch", expectedVersion: parsed.expectedVersion, actualVersion: current.version, retryable: true });
      }
      const from = current.stockReceivingPolicy;
      const to = parsed.stockReceivingPolicy;
      const impact = await this.impact(current, to);
      if (impact.blockedBy.length > 0) {
        throw conflict(
          `${impact.blockedBy.length} reserved item${impact.blockedBy.length === 1 ? "" : "s"} would no longer count as in stock. Receive (count) them or release their reservations first.`,
          { reason: "policy_change_strands_reservations", itemIds: impact.blockedBy.map((row) => row.itemId), recoveryAction: "record_physical_count_or_release_reservation", retryable: false }
        );
      }
      const next = from === to
        ? current
        : workspacePreferencesSchema.parse(await port.setStockReceivingPolicy(to, current.version));
      return {
        value: next,
        entityId: WORKSPACE_PREFERENCES_ENTITY_ID,
        version: next.version,
        auditChange: { setting: "stockReceivingPolicy", from, to, gained: impact.gained.length, lost: impact.lost.length },
        eventMetadata: { stockReceivingPolicy: to, from }
      };
    });
  }

  private async readPreferences(): Promise<WorkspacePreferences> {
    const port = this.ports.workspacePreferences;
    return port === undefined ? defaultPreferences() : workspacePreferencesSchema.parse(await port.get());
  }

  private async impact(current: WorkspacePreferences, to: StockReceivingPolicy): Promise<StockReceivingPolicyImpact> {
    const from = current.stockReceivingPolicy;
    const gained: StockReceivingPolicyImpactItem[] = [];
    const lost: StockReceivingPolicyImpactItem[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await this.ports.inventory.listItems({ limit: IMPACT_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) });
      for (const item of page.data) {
        if (item.retiredAt !== undefined) continue;
        const before = countsAsInStock(item.evidence.state, from);
        const after = countsAsInStock(item.evidence.state, to);
        if (before === after) continue;
        (after ? gained : lost).push(impactRow(item, from, to));
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < IMPACT_MAX_PAGES);
    return stockReceivingPolicyImpactSchema.parse({
      from,
      to,
      version: current.version,
      gained,
      lost,
      blockedBy: lost.filter((row) => row.allocatedQuantity > 0),
      truncated: cursor !== undefined
    });
  }
}
