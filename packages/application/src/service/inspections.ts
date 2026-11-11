import { ApplicationError, conflict, notFound } from "../errors.js";
import { isConfirmedEvidence } from "@benchledger/domain";
import { deriveInspectionActions, hashInspectionBasis, pageInspectionActions } from "../inspection.js";
import type { ApplicationPorts, GapEvaluation, InspectionPort, Mutation, Page, RequestContext } from "../ports.js";
import { evaluateBomGapsFromData } from "./gap-evaluation.js";
import { canonicalize, commandContext, listAllInventory, nowIso, requireId } from "./shared.js";
import { bomLineSchema, commitInspectionCompletionSchema, inspectionCompletionCommitSchema, inspectionCompletionPreviewSchema, inspectionObservationSchema } from "@benchledger/api-contract";
import type { BomLine, InspectionAction, InspectionCompletionCommit, InspectionCompletionPreview, InspectionObservation, InventoryItem, Reservation } from "@benchledger/api-contract";
import { randomUUID } from "node:crypto";
import { ServiceModule } from "./module.js";

export function inspectionPort(ports: ApplicationPorts): InspectionPort {
  if (ports.inspections === undefined) throw new ApplicationError("integrity_error", "Inspection operations are not configured");
  return ports.inspections;
}

export function inspectionBasis(
  action: InspectionAction,
  item: InventoryItem,
  lines: readonly BomLine[],
  reservations: readonly Reservation[],
): {
  readonly actionId: string;
  readonly actionVersion: number;
  readonly itemVersion: number;
  readonly lineVersions: InspectionAction["lineVersions"];
  readonly hash: string;
} {
  // Capture the action's affected lines and reservations that can change the
  // candidate's allocation. This keeps previews small while still failing
  // closed when a competing requirement reserves the same item.
  const sortedLines = lines.filter((line) => action.lineIds.includes(line.id)).sort((left, right) => left.id.localeCompare(right.id));
  const sortedReservations = reservations
    .filter((reservation) => action.lineIds.includes(reservation.lineId) || reservation.itemId === item.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const lineVersions = sortedLines.map((line) => ({ lineId: line.id, version: line.version }));
  return {
    actionId: action.id,
    actionVersion: action.version,
    itemVersion: item.version,
    lineVersions,
    hash: hashInspectionBasis({
      action: { id: action.id, version: action.version, kind: action.kind, normalizedPredicate: action.normalizedPredicate },
      item: { id: item.id, version: item.version, quantity: item.quantity, availableQuantity: item.availableQuantity, allocatedQuantity: item.allocatedQuantity, unit: item.unit, evidence: item.evidence },
      lines: sortedLines,
      reservations: sortedReservations
    })
  };
}

export function projectedInspectionItem(item: InventoryItem, observation: InspectionObservation, updatedAt: string): InventoryItem {
  if (observation.result !== "confirmed" || observation.quantity === undefined) return item;
  if (observation.unit !== item.unit) throw new ApplicationError("validation", `Inspection quantity must use the candidate unit '${item.unit}'`);
  const allocated = item.allocatedQuantity
    ?? (isConfirmedEvidence(item.evidence.state)
      ? Math.max(0, item.quantity - item.availableQuantity)
      : 0);
  if (observation.quantity < allocated) throw new ApplicationError("validation", "Inspected quantity cannot be below allocated stock");
  return {
    ...item,
    quantity: observation.quantity,
    availableQuantity: observation.quantity - allocated,
    allocatedQuantity: allocated,
    evidence: {
      ...item.evidence,
      state: "physically_counted",
      source: observation.source,
      ...(observation.sourceId === undefined ? {} : { sourceId: observation.sourceId }),
      observedAt: observation.observedAt,
      ...(observation.note === undefined ? {} : { note: observation.note })
    },
    updatedAt,
    version: item.version + 1
  };
}

export function validateInspectionObservation(action: InspectionAction, observation: InspectionObservation): void {
  if (action.kind === "physical_quantity") {
    if (observation.result === "confirmed" && (observation.quantity === undefined || observation.unit === undefined)) {
      throw new ApplicationError("validation", "A confirmed physical inspection requires quantity and unit");
    }
    if (observation.quantity !== undefined && observation.unit !== action.itemUnit) throw new ApplicationError("validation", `Inspection quantity must use '${action.itemUnit}'`);
    return;
  }
  if (observation.quantity !== undefined || observation.unit !== undefined) throw new ApplicationError("validation", "Compatibility and conversion inspections do not accept a stock quantity");
  if (action.kind === "compatibility" && observation.conversion !== undefined) {
    throw new ApplicationError("validation", "Compatibility inspections do not accept quantity conversion evidence");
  }
  if (action.kind === "unit_conversion") {
    if (observation.result === "confirmed" && observation.conversion === undefined) {
      throw new ApplicationError("validation", "A confirmed conversion inspection requires explicit quantity conversion evidence");
    }
    if (observation.conversion !== undefined && (observation.conversion.inventory.unit !== action.itemUnit || observation.conversion.requirement.unit !== action.expectedUnit)) {
      throw new ApplicationError("validation", "Conversion evidence units do not match the inspection action");
    }
  }
}

export function inspectionLineSnapshots(
  action: InspectionAction,
  lines: readonly BomLine[],
  observation: InspectionObservation,
  updatedAt: string,
): { readonly before: readonly BomLine[]; readonly after: readonly BomLine[] } {
  const before = lines.filter((line) => action.lineIds.includes(line.id)).sort((left, right) => left.id.localeCompare(right.id));
  if (before.length !== action.lineIds.length) throw new ApplicationError("integrity_error", "Inspection action references a missing BOM line");
  if (observation.result !== "confirmed" || action.kind === "physical_quantity") return { before, after: before };

  const after = before.map((line) => {
    const matches = line.alternatives.filter((alternative) => alternative.itemId === action.itemId);
    const conversion = observation.conversion;
    if (action.kind === "unit_conversion" && conversion === undefined) throw new ApplicationError("validation", "A confirmed conversion inspection requires explicit quantity conversion evidence");
    const alternatives = matches.length === 0
      ? [...line.alternatives, {
        itemId: action.itemId,
        compatible: action.kind === "compatibility" ? "confirmed" as const : "conditional" as const,
        ...(action.kind === "compatibility"
          ? { reason: `Confirmed by inspection ${action.id}` }
          : { reason: `Conversion confirmed by inspection ${action.id}`, quantityConversion: conversion! }),
      }]
      : line.alternatives.map((alternative) => {
        if (alternative.itemId !== action.itemId) return alternative;
        if (action.kind === "compatibility") return { ...alternative, compatible: "confirmed" as const };
        return { ...alternative, quantityConversion: conversion! };
      });
    return bomLineSchema.parse({ ...line, alternatives, updatedAt, version: line.version + 1 });
  });
  return { before, after };
}

/** Inspect-first queue: derive physical checks and commit their confirmed effects. */
export class InspectionModule extends ServiceModule {
  async listInspections(revisionId: string, options: { readonly limit?: number; readonly cursor?: string } = {}): Promise<Page<InspectionAction> & { readonly revisionId: string }> {
    return this.ports.unitOfWork.exclusive(async () => {
      const id = requireId(revisionId, "revision id");
      const snapshot = await this.readInspectionSnapshot(id);
      const actions = snapshot.actions;
      return { ...pageInspectionActions(actions, options.limit ?? 50, options.cursor), revisionId: id };
    });
  }

  async getInspection(revisionId: string, inspectionId: string): Promise<InspectionAction> {
    const id = requireId(inspectionId, "inspection id");
    return this.ports.unitOfWork.exclusive(async () => {
      const revision = requireId(revisionId, "revision id");
      const snapshot = await this.readInspectionSnapshot(revision);
      const action = snapshot.actions.find((candidate) => candidate.id === id);
      if (action === undefined) throw notFound("Inspection", id);
      return action;
    });
  }

  private async readInspectionSnapshot(revisionId: string): Promise<{
    readonly lines: readonly BomLine[];
    readonly inventory: readonly InventoryItem[];
    readonly reservations: readonly Reservation[];
    readonly gaps: GapEvaluation;
    readonly actions: readonly InspectionAction[];
  }> {
    const id = requireId(revisionId, "revision id");
    await this.assertProjectReadableFromRevision(id);
    const lines = await this.ports.projects.listBomLines(id);
    const inventory = await listAllInventory(this.ports.inventory);
    const reservations = await this.ports.projects.listReservations(id);
    const gaps = evaluateBomGapsFromData(id, lines, inventory, reservations);
    return { lines, inventory, reservations, gaps, actions: deriveInspectionActions(id, gaps.lines, lines, inventory) };
  }

  async previewInspectionCompletion(revisionId: string, input: unknown, ctx: RequestContext): Promise<InspectionCompletionPreview> {
    const id = requireId(revisionId, "revision id");
    const record = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const actionId = typeof record.actionId === "string" ? record.actionId : undefined;
    const rawObservation = record.observation ?? Object.fromEntries(Object.entries(record).filter(([key]) => key !== "actionId"));
    const parsed = inspectionObservationSchema.parse(rawObservation) as InspectionObservation;
    return this.ports.unitOfWork.exclusive(async () => {
      const snapshot = await this.readInspectionSnapshot(id);
      if (actionId === undefined) throw new ApplicationError("validation", "Inspection actionId is required");
      const action = snapshot.actions.find((candidate) => candidate.id === actionId);
      if (action === undefined) throw notFound("Inspection", actionId);
      validateInspectionObservation(action, parsed);
      const item = snapshot.inventory.find((candidate) => candidate.id === action.itemId);
      if (item === undefined) throw new ApplicationError("integrity_error", `Inspection candidate '${action.itemId}' is missing from inventory`);
      const basis = inspectionBasis(action, item, snapshot.lines, snapshot.reservations);
      const now = nowIso();
      const lineSnapshots = inspectionLineSnapshots(action, snapshot.lines, parsed, now);
      const afterItem = action.kind === "physical_quantity" && parsed.result === "confirmed"
        ? projectedInspectionItem(item, parsed, now)
        : item;
      const projectedInventory = snapshot.inventory.map((candidate) => candidate.id === item.id ? afterItem : candidate);
      const projectedLines = snapshot.lines.map((line) => lineSnapshots.after.find((candidate) => candidate.id === line.id) ?? line);
      const afterGaps = evaluateBomGapsFromData(id, projectedLines, projectedInventory, snapshot.reservations);
      const affectedLines = action.lineIds.map((lineId) => {
        const before = snapshot.gaps.lines.find((gap) => gap.lineId === lineId);
        const after = afterGaps.lines.find((gap) => gap.lineId === lineId);
        const line = snapshot.lines.find((candidate) => candidate.id === lineId);
        return {
          lineId,
          version: line?.version ?? 1,
          ...(before?.decision === undefined ? {} : { beforeDecision: before.decision }),
          ...(after?.decision === undefined ? {} : { afterDecision: after.decision })
        };
      });
      const previewId = randomUUID();
      const base = {
        id: previewId,
        version: 1,
        projectRevisionId: id,
        actionId: action.id,
        actor: ctx.actor,
        createdAt: now,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        action,
        observation: parsed,
        basis,
        before: { item, lines: lineSnapshots.before, gaps: snapshot.gaps.lines.filter((gap) => action.lineIds.includes(gap.lineId)) },
        after: { item: afterItem, lines: lineSnapshots.after, gaps: afterGaps.lines.filter((gap) => action.lineIds.includes(gap.lineId)) },
        affectedLines,
        reevaluatedGaps: afterGaps,
        requiresHumanConfirmation: true as const
      };
      const preview = inspectionCompletionPreviewSchema.parse({ ...base, contentSha256: hashInspectionBasis(base) });
      return inspectionPort(this.ports).savePreview(preview);
    });
  }

  async commitInspectionCompletion(revisionId: string, input: unknown, ctx: RequestContext): Promise<Mutation<InspectionCompletionCommit>> {
    const id = requireId(revisionId, "revision id");
    if (ctx.idempotencyKey === undefined) throw new ApplicationError("validation", "Idempotency-Key is required for inspection completion");
    const commitRecord = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const requestedActionId = typeof commitRecord.actionId === "string" ? commitRecord.actionId : undefined;
    const parsed = commitInspectionCompletionSchema.parse(Object.fromEntries(Object.entries(commitRecord).filter(([key]) => key !== "actionId")));
    const commandCtx = commandContext(ctx, "project.inspection.completion.commit", { projectRevisionId: id, actionId: requestedActionId, ...parsed });
    return this.mutate(commandCtx, "project.inspection.completion.commit", "inspection_evidence", parsed.previewId, async () => {
      await this.assertProjectActiveFromRevision(id);
      const port = inspectionPort(this.ports);
      const preview = await port.getPreview(parsed.previewId, ctx.actor);
      if (preview === null) throw conflict("Inspection preview is stale or unavailable; create a fresh preview", { reason: "stale_preview", recoveryAction: "list_inspections" });
      if (preview.projectRevisionId !== id) throw conflict("Inspection preview does not belong to this revision", { recoveryAction: "list_inspections" });
      if (requestedActionId !== undefined && preview.actionId !== requestedActionId) throw conflict("Inspection action does not match the preview", { reason: "stale_preview", recoveryAction: "list_inspections" });
      if (preview.version !== parsed.expectedPreviewVersion || preview.contentSha256 !== parsed.contentSha256 || Date.parse(preview.expiresAt) <= Date.now()) {
        throw conflict("Inspection preview is stale or expired; create a fresh preview", { reason: "stale_preview", recoveryAction: "list_inspections" });
      }
      const snapshot = await this.readInspectionSnapshot(id);
      const action = snapshot.actions.find((candidate) => candidate.id === preview.actionId);
      const item = snapshot.inventory.find((candidate) => candidate.id === preview.action.itemId);
      if (action === undefined || item === undefined) throw conflict("Inspection action basis changed; refresh the inspection queue", { reason: "stale_action", recoveryAction: "list_inspections" });
      const basis = inspectionBasis(action, item, snapshot.lines, snapshot.reservations);
      if (basis.hash !== preview.basis.hash
        || basis.itemVersion !== preview.basis.itemVersion
        || JSON.stringify(basis.lineVersions) !== JSON.stringify(preview.basis.lineVersions)) {
        throw conflict("Inspection basis changed; create a fresh preview", { reason: "stale_basis", recoveryAction: "list_inspections" });
      }
      validateInspectionObservation(action, preview.observation);
      // Recompute the exact result the human preview approved from the
      // current affected lines and stored observation. This catches adapter
      // drift even when optimistic versions were not advanced.
      const expectedLines = inspectionLineSnapshots(action, snapshot.lines, preview.observation, preview.createdAt);
      const expectedAfterItem = action.kind === "physical_quantity" && preview.observation.result === "confirmed"
        ? projectedInspectionItem(item, preview.observation, preview.createdAt)
        : item;
      const expectedInventory = snapshot.inventory.map((candidate) => candidate.id === item.id ? expectedAfterItem : candidate);
      const expectedLinesForEvaluation = snapshot.lines.map((line) => expectedLines.after.find((candidate) => candidate.id === line.id) ?? line);
      const expectedAfterGaps = evaluateBomGapsFromData(id, expectedLinesForEvaluation, expectedInventory, snapshot.reservations);
      const expectedAffectedGaps = expectedAfterGaps.lines.filter((gap) => action.lineIds.includes(gap.lineId));
      const same = (left: unknown, right: unknown) => JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
      if (!same(item, preview.before.item)
        || !same(expectedLines.before, preview.before.lines)
        || !same(snapshot.gaps.lines.filter((gap) => action.lineIds.includes(gap.lineId)), preview.before.gaps)
        || !same(expectedAfterItem, preview.after.item)
        || !same(expectedLines.after, preview.after.lines)
        || !same(expectedAffectedGaps, preview.after.gaps)
        || !same(expectedAffectedGaps, preview.reevaluatedGaps.lines.filter((gap) => action.lineIds.includes(gap.lineId)))) {
        throw conflict("Inspection preview result changed; create a fresh preview", { reason: "stale_basis", recoveryAction: "list_inspections" });
      }
      const receipt = await port.commit({ preview, action, basis, observation: preview.observation, projectRevisionId: id, committedAt: nowIso() }, commandCtx);
      const after = await this.readInspectionSnapshot(id);
      const committedAt = nowIso();
      const value = inspectionCompletionCommitSchema.parse({
        id: receipt.id,
        status: "committed",
        projectRevisionId: id,
        actionId: action.id,
        previewId: preview.id,
        evidence: receipt.evidence,
        ...(receipt.item === undefined ? {} : { item: receipt.item }),
        gaps: after.gaps,
        inspections: { ...pageInspectionActions(after.actions, 200), revisionId: id },
        committedAt
      });
      return {
        value,
        entityId: receipt.id,
        ...(receipt.item === undefined ? {} : { version: receipt.item.version }),
        ...(port.rollbackLastCommit === undefined ? {} : { compensate: () => port.rollbackLastCommit!() })
      };
    });
  }
}
