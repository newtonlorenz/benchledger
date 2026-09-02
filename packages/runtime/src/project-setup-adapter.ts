import type { CommitProjectSetup, ProjectSetupCommitResult, ProjectSetupPreview } from "@benchledger/api-contract";
import type { ProjectSetupPort, RequestContext } from "@benchledger/application";
import { ApplicationError, bomSpecification, conflict } from "@benchledger/application";
import { ProjectSetupRepository } from "@benchledger/database";
import { ProductionInventoryAdapter } from "./inventory-adapter.js";
import { ProductionProjectAdapter } from "./project-adapter.js";
import { nowIso } from "./utils.js";

/** Production implementation of the preview/commit aggregate. All methods
 * assume the caller has already entered the outer UnitOfWork transaction. */
export class ProductionProjectSetupAdapter implements ProjectSetupPort {
  constructor(
    private readonly previews: ProjectSetupRepository,
    private readonly projects: ProductionProjectAdapter,
    private readonly inventory: ProductionInventoryAdapter
  ) {}

  async savePreview(preview: ProjectSetupPreview, actor: string): Promise<ProjectSetupPreview> {
    return this.previews.save(preview, actor);
  }

  async getPreview(id: string, actor: string): Promise<ProjectSetupPreview | null> {
    return this.previews.get(id, actor);
  }

  async commitPreview(input: {
    readonly preview: ProjectSetupPreview;
    readonly command: CommitProjectSetup;
    readonly actor: string;
    readonly source: RequestContext["source"];
    readonly correlationId: string;
  }): Promise<ProjectSetupCommitResult> {
    const { preview } = input;
    if (preview.fieldErrors.length > 0) throw new ApplicationError("validation", "Project setup preview contains semantic field errors");
    for (const reservation of preview.proposal.reservations) {
      const line = preview.proposal.bomLines.find((candidate) => candidate.localRef === reservation.bomLineLocalRef);
      if (line === undefined || !bomSpecification(line).sufficient) {
        throw new ApplicationError("validation", "Resolve the BOM specification decisions before reserving stock");
      }
    }
    const staleItems: string[] = [];
    for (const basis of preview.affectedInventory) {
      const current = await this.inventory.getItem(basis.itemId);
      const allocated = current === null ? undefined : current.allocatedQuantity ?? Math.max(0, current.quantity - current.availableQuantity);
      if (current === null || current.version !== basis.before.version || current.quantity !== basis.before.quantity || current.availableQuantity !== basis.before.availableQuantity || allocated !== basis.before.allocatedQuantity || current.unit !== basis.unit || JSON.stringify(current.evidence) !== JSON.stringify(basis.evidenceBasis)) staleItems.push(basis.itemId);
    }
    if (staleItems.length > 0) throw conflict("Project setup inventory basis is stale", { reason: "stale_basis", staleItems, recoveryAction: "preview_project_setup", retryable: false, commitState: "not_committed" });
    if (await this.projects.getProject(preview.proposal.project.id as string) !== null) throw conflict("Project ID is already in use", { reason: "project_id_exists", field: "projectId", id: preview.proposal.project.id, retryable: false, commitState: "not_committed" });
    if (await this.projects.getProjectRevision(preview.proposal.revision.id as string) !== null) throw conflict("Revision ID is already in use", { reason: "revision_id_exists", field: "revisionId", id: preview.proposal.revision.id, retryable: false, commitState: "not_committed" });
    for (const item of preview.proposal.workItems) {
      if (await this.projects.getWorkItem(item.id as string) !== null) throw conflict("Work-item ID is already in use", { reason: "work_item_id_exists", field: "workItemId", id: item.id, retryable: false, commitState: "not_committed" });
      if (await this.projects.getWorkItemRevision(item.revision.id as string) !== null) throw conflict("Work-item revision ID is already in use", { reason: "work_item_revision_id_exists", field: "workItemRevisionId", id: item.revision.id, retryable: false, commitState: "not_committed" });
    }
    for (const line of preview.proposal.bomLines) if (await this.projects.getBomLine(line.id as string) !== null) throw conflict("BOM line ID is already in use", { reason: "bom_line_id_exists", field: "bomLineId", id: line.id, retryable: false, commitState: "not_committed" });
    for (const reservation of preview.proposal.reservations) if (await this.projects.getReservationDetails(reservation.id as string) !== null) throw conflict("Reservation ID is already in use", { reason: "reservation_id_exists", field: "reservationId", id: reservation.id, retryable: false, commitState: "not_committed" });
    const ctx: RequestContext = { actor: input.actor, source: input.source, correlationId: input.correlationId, scopes: new Set(["projects:write", "bom:write", "inventory:read"]) };
    const created = await this.projects.createProjectWithInitialRevision({ project: preview.proposal.project, revision: preview.proposal.revision }, ctx);
    const workItems = [] as ProjectSetupCommitResult["workItems"];
    const workItemRevisions = [] as ProjectSetupCommitResult["workItemRevisions"];
    for (const item of preview.proposal.workItems) {
      const workItem = await this.projects.createWorkItem(created.project.id, { id: item.id, name: item.name, kind: item.kind, ...(item.description === undefined ? {} : { description: item.description }) }, ctx);
      const workRevision = await this.projects.createWorkItemRevision(workItem.id, item.revision, ctx);
      workItems.push(workItem);
      workItemRevisions.push(workRevision);
    }
    const bomLines = [] as ProjectSetupCommitResult["bomLines"];
    // BOM rows are requirements of the project planning revision. A
    // `revisionLocalRef` can document which work-item revision informed a
    // requirement, but the durable BOM foreign key remains project_revision.
    for (const line of preview.proposal.bomLines) {
      bomLines.push(await this.projects.createBomLine(created.revision.id, { id: line.id, name: line.name, ...(line.itemId === undefined ? {} : { itemId: line.itemId }), requiredQuantity: line.requiredQuantity, unit: line.unit, optional: line.optional, constraints: line.constraints, alternatives: line.alternatives, ...(line.notes === undefined ? {} : { notes: line.notes }) }, ctx));
    }
    const reservations = [] as ProjectSetupCommitResult["reservations"];
    for (const reservation of preview.proposal.reservations) {
      const line = preview.proposal.bomLines.find((candidate) => candidate.localRef === reservation.bomLineLocalRef);
      if (line === undefined) throw new ApplicationError("validation", `Reservation '${reservation.localRef}' references an unknown BOM line`);
      const bomLine = bomLines.find((candidate) => candidate.id === line.id);
      if (bomLine === undefined) throw new ApplicationError("integrity_error", "Project setup graph mapping is incomplete");
      reservations.push(await this.projects.createReservation(created.revision.id, { id: reservation.id, lineId: bomLine.id, itemId: reservation.itemId, quantity: reservation.quantity }, ctx));
    }
    this.previews.markCommitted(preview.id, input.actor, nowIso());
    const project = await this.projects.getProject(created.project.id);
    if (project === null) throw new ApplicationError("integrity_error", "Committed project could not be read back");
    return { project, revision: created.revision, workItems, workItemRevisions, bomLines, reservations, auditIds: [], context: { previewId: preview.id, contentSha256: preview.contentSha256 }, gaps: preview.gaps, nextAction: "Review the committed project setup and resolve any remaining gaps." };
  }
}
