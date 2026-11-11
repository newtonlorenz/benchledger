import { ApplicationError, conflict, notFound } from "../errors.js";
import type { ApplicationPorts, Mutation, RequestContext } from "../ports.js";
import { buildReconciliationDocument, reconciliationCommitId, reconciliationDraftId } from "../reconciliation.js";
import type { ReconciliationSourceSnapshot } from "../reconciliation.js";
import { commandContext, nowIso, requireId } from "./shared.js";
import { commitReconciliationSchema, reconciliationCommitSchema, reconciliationDraftSchema, saveReconciliationDraftSchema } from "@benchledger/api-contract";
import type { CommitReconciliation, InventoryItem, ReconciliationCommit, ReconciliationDraft } from "@benchledger/api-contract";
import { ServiceModule } from "./module.js";

export function reconciliationPort(ports: ApplicationPorts): NonNullable<ApplicationPorts["reconciliations"]> {
  if (ports.reconciliations === undefined) throw new ApplicationError("integrity_error", "This runtime does not support post-project reconciliation");
  return ports.reconciliations;
}

/** Review-first project close-out drafts and commits. */
export class ReconciliationModule extends ServiceModule {
  private async reconciliationSource(revisionId: string): Promise<ReconciliationSourceSnapshot> {
    const revision = await this.ports.projects.getProjectRevision(revisionId);
    if (revision === null) throw notFound("Project revision", revisionId);
    await this.assertProjectReadable(revision.projectId);
    const lines = await this.ports.projects.listBomLines(revisionId);
    const rawReservations = await this.ports.projects.listReservations(revisionId);
    const itemIds = [...new Set(rawReservations.map((reservation) => reservation.itemId))].sort((left, right) => left.localeCompare(right));
    const items: InventoryItem[] = [];
    for (const itemId of itemIds) {
      const item = await this.ports.inventory.getItem(itemId);
      if (item === null) throw notFound("Inventory item", itemId);
      items.push(item);
    }
    const itemById = new Map(items.map((item) => [item.id, item]));
    const reservations = rawReservations.map((reservation) => {
      const item = itemById.get(reservation.itemId);
      if (item === undefined) throw new ApplicationError("integrity_error", `Reservation ${reservation.id} references missing item ${reservation.itemId}`);
      return {
        id: reservation.id,
        lineId: reservation.lineId,
        itemId: reservation.itemId,
        quantity: reservation.quantity,
        status: reservation.status,
        unit: item.unit,
        version: reservation.version
      };
    });
    return { projectId: revision.projectId, projectRevisionId: revisionId, lines, reservations, items };
  }

  async getReconciliation(revisionId: string): Promise<ReconciliationDraft | null> {
    const id = requireId(revisionId, "project revision id");
    await this.app.getProjectRevision(id);
    return this.ports.unitOfWork.exclusive(async () => {
      const draft = await reconciliationPort(this.ports).getDraft(id);
      return draft === null ? null : reconciliationDraftSchema.parse(draft);
    });
  }

  /** Save a review-only draft. This operation never mutates stock or
   * reservations; the server recomputes both the basis and preview. */

  async saveReconciliationDraft(revisionId: string, input: unknown, ctx: RequestContext): Promise<Mutation<ReconciliationDraft>> {
    const id = requireId(revisionId, "project revision id");
    const raw = input !== null && typeof input === "object" && !Array.isArray(input)
      ? { projectRevisionId: id, ...(input as Record<string, unknown>) }
      : input;
    if (input !== null && typeof input === "object" && !Array.isArray(input)) {
      const supplied = (input as Record<string, unknown>).projectRevisionId;
      if (supplied !== undefined && supplied !== id) throw new ApplicationError("validation", "projectRevisionId must match the revision path");
    }
    const parsed = saveReconciliationDraftSchema.parse(raw);
    const commandCtx = commandContext(ctx, "project.reconciliation.draft.save", parsed);
    const provisionalId = parsed.draftId ?? reconciliationDraftId(id);
    return this.mutate(commandCtx, "project.reconciliation.draft.save", "reconciliation_draft", provisionalId, async () => {
      const port = reconciliationPort(this.ports);
      const current = await port.getDraft(id);
      if (parsed.draftId !== undefined && current !== null && current.id !== parsed.draftId) {
        throw conflict(`Reconciliation draft '${parsed.draftId}' does not belong to revision '${id}'`);
      }
      if (parsed.draftId !== undefined && current === null) throw notFound("Reconciliation draft", parsed.draftId);
      const source = await this.reconciliationSource(id);
      const document = buildReconciliationDocument(source, parsed.lines, false);
      const now = nowIso();
      const draft: ReconciliationDraft = {
        id: current?.id ?? provisionalId,
        projectId: source.projectId,
        projectRevisionId: id,
        status: "draft",
        version: current === null ? 1 : current.version + 1,
        lines: [...document.lines],
        basis: document.basis,
        preview: document.preview,
        createdAt: current?.createdAt ?? now,
        updatedAt: now
      };
      const saved = reconciliationDraftSchema.parse(await port.saveDraft(draft, parsed.expectedVersion));
      return { value: saved, entityId: saved.id, version: saved.version };
    });
  }

  /** Commit a saved review atomically. The durable adapter repeats the basis
   * check while holding the UnitOfWork transaction before writing any event. */

  async commitReconciliation(revisionId: string, input: unknown, ctx: RequestContext): Promise<Mutation<ReconciliationCommit>> {
    const id = requireId(revisionId, "project revision id");
    const parsed = commitReconciliationSchema.parse(input) as CommitReconciliation;
    const commandCtx = commandContext(ctx, "project.reconciliation.commit", { projectRevisionId: id, ...parsed });
    const commitId = reconciliationCommitId(id);
    return this.mutate(commandCtx, "project.reconciliation.commit", "reconciliation_commit", commitId, async () => {
      await this.assertProjectActiveFromRevision(id);
      const port = reconciliationPort(this.ports);
      const draft = await port.getDraft(id);
      if (draft === null) throw notFound("Reconciliation draft", parsed.draftId);
      if (draft.id !== parsed.draftId) throw conflict(`Reconciliation draft '${parsed.draftId}' does not belong to revision '${id}'`);
      if (draft.status !== "draft") throw conflict(`Project revision '${id}' already has a committed reconciliation`);
      if (parsed.expectedVersion !== undefined && parsed.expectedVersion !== draft.version) {
        throw conflict(`Reconciliation draft '${draft.id}' changed since it was read`, { expectedVersion: parsed.expectedVersion, actualVersion: draft.version });
      }
      const source = await this.reconciliationSource(id);
      const document = buildReconciliationDocument(source, draft.lines, true);
      if (document.basis.hash !== draft.basis.hash) {
        throw conflict("Reconciliation basis changed; refresh the draft before committing", { expectedBasisHash: draft.basis.hash, actualBasisHash: document.basis.hash });
      }
      const committed = await port.commit({
        id: commitId,
        draftId: draft.id,
        projectId: draft.projectId,
        projectRevisionId: id,
        expectedDraftVersion: draft.version,
        basis: document.basis,
        lines: document.lines,
        preview: document.preview,
        committedAt: nowIso()
      }, commandCtx);
      return { value: reconciliationCommitSchema.parse(committed), entityId: committed.id };
    });
  }
}
