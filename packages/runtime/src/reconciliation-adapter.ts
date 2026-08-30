import { createStockEvent, DomainError } from "@benchledger/domain";
import type { StockEvent as NativeStockEvent } from "@benchledger/domain";
import type {
  InventoryItem,
  ReconciliationCommit,
  ReconciliationDraft,
  ReconciliationLine
} from "@benchledger/api-contract";
import type {
  InventoryPort,
  ProjectPort,
  ReconciliationCommitInput,
  ReconciliationPort,
  ReconciliationSourceSnapshot,
  RequestContext,
  UnitOfWorkPort
} from "@benchledger/application";
import { buildReconciliationDocument, reconciliationStockEventKey } from "@benchledger/application";
import { ReconciliationRepository, InventoryRepository, ProjectRepository, BomRepository, ReservationRepository } from "@benchledger/database";
import type { BenchDatabase } from "@benchledger/database";
import { RuntimeConflict, RuntimeState } from "./persistence.js";
import { attempt, clone } from "./utils.js";
import { mapApiUnitToDomain } from "./mappers.js";

const INVENTORY_ITEM = "inventory_item";
const RESERVATION = "reservation";

function actorForContext(ctx: RequestContext): { readonly type: "human" | "agent" | "system" | "import"; readonly id: string } {
  return {
    type: ctx.source === "mcp" ? "agent" : ctx.source === "import" ? "import" : ctx.source === "system" ? "system" : "human",
    id: ctx.actor
  };
}

function eventEvidence(lines: readonly ReconciliationLine[], eventKey: string, revisionId: string): Record<string, unknown> {
  const releaseCandidates: Array<{ readonly line: ReconciliationLine; readonly outcome: ReconciliationLine["outcomes"][number] }> = [];
  for (const line of lines) {
    for (const [index, outcome] of line.outcomes.entries()) {
      if (outcome.reservationId === undefined || outcome.kind === "reviewed_no_change") continue;
      const kind = outcome.kind === "damaged_lost" ? "loss" : outcome.kind === "consumed" || outcome.kind === "converted_asset" ? "consume" : undefined;
      if (kind !== undefined && eventKey === reconciliationStockEventKey(revisionId, outcome.reservationId, kind, index)) {
        return { ...outcome.evidence, outcomeKind: outcome.kind, reservationId: outcome.reservationId, bomLineId: line.bomLineId, reconciliationRevisionId: revisionId };
      }
      if (eventKey === reconciliationStockEventKey(revisionId, outcome.reservationId, "release")) releaseCandidates.push({ line, outcome });
    }
  }
  if (releaseCandidates.length > 0) {
    const preferred = releaseCandidates.find(({ outcome }) => outcome.kind === "returned" || outcome.kind === "usable_leftover") ?? releaseCandidates[0]!;
    const evidence = releaseCandidates.length === 1
      ? { ...preferred.outcome.evidence }
      : { state: "unknown" as const, source: "post-project-reconciliation", note: "Allocation release covers multiple reviewed outcomes" };
    return {
      ...evidence,
      ...(releaseCandidates.length === 1 ? { outcomeKind: preferred.outcome.kind } : { outcomeKinds: releaseCandidates.map(({ outcome }) => outcome.kind) }),
      reservationId: preferred.outcome.reservationId,
      bomLineId: preferred.line.bomLineId,
      reconciliationRevisionId: revisionId
    };
  }
  return { state: "unknown", source: "post-project-reconciliation", reconciliationRevisionId: revisionId };
}

/**
 * Durable implementation of the review-first close-out command. All calls
 * made by ApplicationService are already inside its mutation transaction;
 * `transactional` also protects direct adapter use and nests as a SAVEPOINT
 * when an outer UnitOfWork is present.
 */
export class ProductionReconciliationAdapter implements ReconciliationPort {
  constructor(
    private readonly database: BenchDatabase,
    private readonly repository: ReconciliationRepository,
    private readonly projects: ProjectRepository,
    private readonly boms: BomRepository,
    private readonly reservations: ReservationRepository,
    private readonly inventoryRepository: InventoryRepository,
    private readonly inventory: InventoryPort,
    private readonly projectsPort: ProjectPort,
    private readonly state: RuntimeState,
    private readonly unitOfWork: Pick<UnitOfWorkPort, "transactional">
  ) {}

  async getDraft(projectRevisionId: string): Promise<ReconciliationDraft | null> {
    return clone(this.repository.getDraftByRevision(projectRevisionId) ?? null);
  }

  async saveDraft(draft: ReconciliationDraft, expectedVersion: number | undefined): Promise<ReconciliationDraft> {
    return this.unitOfWork.transactional(() => attempt(() => clone(this.repository.saveDraft(draft, expectedVersion))));
  }

  async commit(input: ReconciliationCommitInput, ctx: RequestContext): Promise<ReconciliationCommit> {
    return this.unitOfWork.transactional(() => attempt(() => this.commitWithinTransaction(input, ctx)));
  }

  private async commitWithinTransaction(input: ReconciliationCommitInput, ctx: RequestContext): Promise<ReconciliationCommit> {
    const currentDraft = this.repository.getDraft(input.draftId);
    if (currentDraft === undefined) throw new DomainError("reconciliation_not_found", `reconciliation draft ${input.draftId} does not exist`);
    if (currentDraft.version !== input.expectedDraftVersion) {
      throw new RuntimeConflict(`Reconciliation draft '${input.draftId}' changed since it was read`, { expectedVersion: input.expectedDraftVersion, actualVersion: currentDraft.version });
    }
    if (currentDraft.status !== "draft") throw new RuntimeConflict(`Project revision '${input.projectRevisionId}' already has a committed reconciliation`);
    const priorCommit = this.repository.getCommitByRevision(input.projectRevisionId);
    if (priorCommit !== undefined) {
      if (priorCommit.id === input.id) return clone(priorCommit);
      throw new RuntimeConflict(`Project revision '${input.projectRevisionId}' already has a committed reconciliation`);
    }

    const source = await this.source(input.projectRevisionId);
    const document = buildReconciliationDocument(source, input.lines, true);
    if (document.basis.hash !== input.basis.hash || document.basis.hash !== currentDraft.basis.hash) {
      throw new RuntimeConflict("Reconciliation basis changed; refresh the draft before committing", { expectedBasisHash: input.basis.hash, actualBasisHash: document.basis.hash });
    }

    const eventIds = new Map<string, string>();
    const reservationVersions = new Map<string, number>();
    const stockEvents = [...document.preview.stockChanges].sort((a, b) => {
      const rank = (kind: string): number => kind === "release" ? 0 : 1;
      return rank(a.kind) - rank(b.kind) || a.eventKey.localeCompare(b.eventKey);
    });
    for (const change of stockEvents) {
      const nativeItem = this.inventoryRepository.get(change.itemId);
      if (nativeItem === undefined) throw new DomainError("inventory_not_found", `inventory item ${change.itemId} does not exist`);
      const event: NativeStockEvent = createStockEvent({
        id: change.eventKey,
        itemId: change.itemId,
        kind: change.kind,
        quantity: change.quantity,
        unit: mapApiUnitToDomain(change.unit),
        reason: `Post-project reconciliation ${input.projectRevisionId}`,
        actor: actorForContext(ctx),
        source: ctx.source,
        evidence: eventEvidence(document.lines, change.eventKey, input.projectRevisionId),
        correlationId: ctx.correlationId,
        idempotencyKey: change.eventKey,
        occurredAt: input.committedAt,
        createdAt: input.committedAt
      });
      const appended = this.inventoryRepository.appendStockEvent(event);
      if (appended.inserted) {
        const nextVersion = this.state.getVersion(INVENTORY_ITEM, change.itemId) + 1;
        this.state.setVersion(INVENTORY_ITEM, change.itemId, nextVersion);
        this.state.setMetadata("stock_event", event.id, { apiItemVersion: nextVersion, reconciliationId: input.id });
      }
      eventIds.set(change.eventKey, appended.event.id);
    }

    for (const reservationChange of document.preview.reservationChanges.slice().sort((a, b) => a.reservationId.localeCompare(b.reservationId))) {
      const current = this.reservations.get(reservationChange.reservationId);
      if (current === undefined) throw new DomainError("reservation_not_found", `reservation ${reservationChange.reservationId} does not exist`);
      if (current.status !== "active") throw new RuntimeConflict(`Reservation '${current.id}' is no longer active`);
      this.database.run("UPDATE reservations SET status = 'settled', released_at = ? WHERE id = ? AND status = 'active'", [input.committedAt, current.id]);
      reservationVersions.set(current.id, this.state.bumpVersion(RESERVATION, current.id));
    }

    const createdAssets: InventoryItem[] = [];
    const assetInputs = document.lines.flatMap((line) => line.outcomes.flatMap((outcome) => outcome.kind === "converted_asset" && outcome.convertedAsset !== undefined ? [outcome.convertedAsset] : []));
    for (const asset of assetInputs) {
      const created = await this.inventory.createItem(asset, ctx);
      createdAssets.push(created);
    }

    const commit: ReconciliationCommit = {
      id: input.id,
      projectId: input.projectId,
      projectRevisionId: input.projectRevisionId,
      draftId: input.draftId,
      status: "committed",
      basis: document.basis,
      lines: [...document.lines],
      stockChanges: document.preview.stockChanges.map((change) => ({ ...change, eventId: eventIds.get(change.eventKey) ?? change.eventKey })),
      reservationChanges: document.preview.reservationChanges.map((change) => ({ ...change, version: reservationVersions.get(change.reservationId) ?? this.state.getVersion(RESERVATION, change.reservationId) })),
      createdAssets,
      committedAt: input.committedAt
    };
    return clone(this.repository.markCommitted(input.draftId, commit));
  }

  private async source(projectRevisionId: string): Promise<ReconciliationSourceSnapshot> {
    const revision = this.projects.getRevision(projectRevisionId);
    if (revision === undefined) throw new DomainError("project_revision_not_found", `project revision ${projectRevisionId} does not exist`);
    const lines = await this.projectsPort.listBomLines(projectRevisionId);
    const apiReservations = await this.projectsPort.listReservations(projectRevisionId);
    const itemIds = [...new Set(apiReservations.map((reservation) => reservation.itemId))].sort((left, right) => left.localeCompare(right));
    const items: InventoryItem[] = [];
    for (const itemId of itemIds) {
      const item = await this.inventory.getItem(itemId);
      if (item === null) throw new DomainError("inventory_not_found", `inventory item ${itemId} does not exist`);
      items.push(item);
    }
    const itemById = new Map(items.map((item) => [item.id, item]));
    return {
      projectId: revision.projectId,
      projectRevisionId,
      lines,
      reservations: apiReservations.map((reservation) => {
        const item = itemById.get(reservation.itemId);
        if (item === undefined) throw new DomainError("inventory_not_found", `inventory item ${reservation.itemId} does not exist`);
        return { id: reservation.id, lineId: reservation.lineId, itemId: reservation.itemId, quantity: reservation.quantity, status: reservation.status, unit: item.unit, version: reservation.version };
      }),
      items
    };
  }

}
