import { ApplicationError, conflict } from "../errors.js";
import type { GapEvaluation, Mutation, RequestContext } from "../ports.js";
import { bomRequirementRequestsPrinter, bomSpecification, canonicalizeBomLineWrite, matchesBomConstraints } from "./bom-rules.js";
import { assertOwnedPrinter } from "./catalog.js";
import { bomCandidateQuantityConversion, canReserveBomItem, evaluateBomGapsFromData } from "./gap-evaluation.js";
import { canonicalize, listAllInventory, nowIso } from "./shared.js";
import { bomLineSchema, commitProjectSetupSchema, isUnitCompatibleWithItemKind, projectSetupPreviewSchema, projectSetupProposalSchema, reservationSchema, unitCorrectionReason } from "@benchledger/api-contract";
import type { BomLine, CommitProjectSetup, CreateProjectWithInitialRevision, InventoryItem, ProjectSetupCommitResult, ProjectSetupFieldError, ProjectSetupPreview, ProjectSetupProposal, Reservation } from "@benchledger/api-contract";
import { exceedsReservableQuantity, quantityExceeds, isConfirmedEvidence } from "@benchledger/domain";
import { createHash, randomUUID } from "node:crypto";
import { ServiceModule } from "./module.js";

export function canonicalizeSetupProposal(proposal: ProjectSetupProposal): ProjectSetupProposal {
  return {
    ...proposal,
    bomLines: proposal.bomLines.map((line) => canonicalizeBomLineWrite(line) as typeof line),
  };
}

export function setupDerivedId(previewId: string, localRef: string, prefix: string): string {
  const digest = createHash("sha256").update(`${previewId}\u0000${localRef}`).digest("hex").slice(0, 28);
  return `${prefix}-${digest}`;
}

export function setupCanonicalHash(proposal: ProjectSetupProposal): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(proposal))).digest("hex");
}

export function setupNormalize(previewId: string, input: ProjectSetupProposal): ProjectSetupProposal {
  const projectId = input.project.id ?? setupDerivedId(previewId, "project", "project");
  const revisionId = input.revision.id ?? setupDerivedId(previewId, "project-revision", "revision");
  const workItems = [...input.workItems].sort((left, right) => left.localRef.localeCompare(right.localRef)).map((workItem) => ({
    ...workItem,
    id: workItem.id ?? setupDerivedId(previewId, workItem.localRef, "work"),
    revision: { ...workItem.revision, id: workItem.revision.id ?? setupDerivedId(previewId, `${workItem.localRef}:revision`, "work-revision") }
  }));
  return {
    ...input,
    project: { ...input.project, id: projectId },
    revision: { ...input.revision, id: revisionId },
    workItems,
    bomLines: [...input.bomLines].sort((left, right) => left.localRef.localeCompare(right.localRef)).map((line) => ({
      ...line,
      revisionLocalRef: line.revisionLocalRef ?? "project",
      id: line.id ?? setupDerivedId(previewId, line.localRef, "bom")
    })),
    reservations: [...input.reservations].sort((left, right) => left.localRef.localeCompare(right.localRef)).map((reservation) => ({
      ...reservation,
      id: reservation.id ?? setupDerivedId(previewId, reservation.localRef, "reservation")
    }))
  };
}

export function setupBomLines(proposal: ProjectSetupProposal, now: string): readonly BomLine[] {
  return proposal.bomLines.map((line) => canonicalizeBomLineWrite(bomLineSchema.parse({
      id: line.id,
      revisionId: proposal.revision.id,
      name: line.name,
      requiredQuantity: line.requiredQuantity,
      unit: line.unit,
      role: line.role,
      optional: line.optional,
      ...(line.itemId === undefined ? {} : { itemId: line.itemId }),
      constraints: line.constraints,
      alternatives: line.alternatives,
      ...(line.notes === undefined ? {} : { notes: line.notes }),
      createdAt: now,
      updatedAt: now,
      version: 1,
    })));
}

export function setupReservationRecords(proposal: ProjectSetupProposal, lines: readonly BomLine[], now: string): readonly Reservation[] {
  const lineByRef = new Map(proposal.bomLines.map((line, index) => [line.localRef, lines[index]]));
  return proposal.reservations.flatMap((reservation) => {
    const line = lineByRef.get(reservation.bomLineLocalRef);
    if (line === undefined) return [];
    return [reservationSchema.parse({
      id: reservation.id,
      lineId: line.id,
      itemId: reservation.itemId,
      quantity: reservation.quantity,
      status: "active",
      createdAt: now,
      updatedAt: now,
      version: 1,
    })];
  });
}

export function setupProjectedInventory(inventory: readonly InventoryItem[], reservations: readonly Reservation[]): readonly InventoryItem[] {
  const plannedByItem = new Map<string, number>();
  for (const reservation of reservations) plannedByItem.set(reservation.itemId, (plannedByItem.get(reservation.itemId) ?? 0) + reservation.quantity);
  return inventory.map((item) => {
    const planned = plannedByItem.get(item.id) ?? 0;
    if (planned <= 0) return item;
    const allocated = item.allocatedQuantity ?? Math.max(0, item.quantity - item.availableQuantity);
    return { ...item, availableQuantity: Math.max(0, item.availableQuantity - planned), allocatedQuantity: allocated + planned };
  });
}

export function setupGapCandidateIds(gaps: GapEvaluation): ReadonlySet<string> {
  return new Set(gaps.lines.flatMap((gap) => gap.matchedItemIds));
}

export function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Project setup is a structured command whose parsed payload is the replay
 * identity. Transport envelopes may reorder fields or carry an unrelated
 * request fingerprint, so this command must always replace that fingerprint
 * with the canonical payload digest.
 */
export function canonicalProjectSetupContext(ctx: RequestContext, input: CreateProjectWithInitialRevision): RequestContext {
  return { ...ctx, fingerprint: createHash("sha256").update(JSON.stringify(canonicalize({ scope: "project.create_with_initial_revision", input }))).digest("hex") };
}

export function canonicalProjectSetupCommitContext(ctx: RequestContext, input: CommitProjectSetup): RequestContext {
  return { ...ctx, fingerprint: createHash("sha256").update(JSON.stringify(canonicalize({ scope: "project.setup.commit", input }))).digest("hex") };
}

/** Review-first project setup: preview a whole graph, then commit it atomically. */
export class ProjectSetupModule extends ServiceModule {
  async previewProjectSetup(input: ProjectSetupProposal, ctx: RequestContext): Promise<ProjectSetupPreview> {
    const parsed = projectSetupProposalSchema.parse(input);
    if (ctx.projectId !== undefined) throw new ApplicationError("forbidden", "Project-scoped tokens cannot create workspace project setup previews");
    const projectWrite = ctx.scopes.has("projects:write") || ctx.scopes.has("write") || ctx.scopes.has("admin");
    const bomWrite = ctx.scopes.has("bom:write") || ctx.scopes.has("write") || ctx.scopes.has("admin");
    if (!projectWrite || !bomWrite) throw new ApplicationError("forbidden", "Project setup preview requires projects:write and bom:write");
    const setup = this.ports.projectSetups;
    if (setup === undefined) throw new ApplicationError("integrity_error", "This runtime does not support project setup previews");
    const previewId = setupDerivedId(randomUUID(), "preview", "setup-preview");
    const proposal = canonicalizeSetupProposal(setupNormalize(previewId, parsed));
    const intendedPrinterItemId = proposal.revision.intendedPrinterItemId;
    if (intendedPrinterItemId !== undefined && intendedPrinterItemId !== null) {
      if (proposal.revision.fabricationRoute !== "printed") throw new ApplicationError("validation", "The intended printer requires the printed fabrication route");
      await assertOwnedPrinter(this.ports, intendedPrinterItemId);
    }
    const inventory = await this.ports.unitOfWork.exclusive(() => listAllInventory(this.ports.inventory));
    const now = nowIso();
    const setupLines = setupBomLines(proposal, now);
    const plannedByItem = new Map<string, number>();
    const plannedByLineCoverage = new Map<string, number>();
    const reservationUnitsByLine = new Map<string, InventoryItem["unit"]>();
    const mixedReservationLines = new Set<string>();
    const fieldErrors: ProjectSetupFieldError[] = [];
    const lineByRef = new Map(proposal.bomLines.map((line) => [line.localRef, line]));
    const setupLineByRef = new Map(proposal.bomLines.map((line, index) => [line.localRef, setupLines[index]! ]));
    for (const [index, line] of proposal.bomLines.entries()) {
      if (bomRequirementRequestsPrinter(line)) {
        fieldErrors.push({ path: `bomLines.${index}.constraints.kind`, code: "printer_requirement_not_allowed", message: "Printers are selected through build configuration, not BOM requirements" });
      }
      for (const itemId of [line.itemId, ...line.alternatives.map((alternative) => alternative.itemId)].filter((value): value is string => value !== undefined)) {
        const item = inventory.find((candidate) => candidate.id === itemId);
        if (item === undefined) fieldErrors.push({ path: `bomLines.${index}.itemId`, code: "inventory_not_found", message: "The selected inventory identifier does not exist. Clear it or select an existing item." });
        if (item?.kind === "printer") {
          fieldErrors.push({ path: `bomLines.${index}.itemId`, code: "printer_requirement_not_allowed", message: "Printers are selected through build configuration, not BOM requirements" });
        }
      }
    }
    for (let index = 0; index < proposal.reservations.length; index += 1) {
      const reservation = proposal.reservations[index];
      if (reservation === undefined) continue;
      const line = lineByRef.get(reservation.bomLineLocalRef);
      const setupLine = setupLineByRef.get(reservation.bomLineLocalRef);
      const item = inventory.find((candidate) => candidate.id === reservation.itemId);
      if (line === undefined) fieldErrors.push({ path: `reservations.${index}.bomLineLocalRef`, code: "unknown_bom_line", message: "Reservation references an unknown BOM line" });
      if (item === undefined) fieldErrors.push({ path: `reservations.${index}.itemId`, code: "inventory_not_found", message: "Reservation references an unknown inventory item" });
      if (line !== undefined && setupLine !== undefined && item !== undefined) {
        if (setupLine.role !== "consumed") {
          fieldErrors.push({ path: `reservations.${index}.bomLineLocalRef`, code: setupLine.role === "reusable" ? "reusable_requirement_not_reservable" : "bom_line_role_required", message: setupLine.role === "reusable" ? "Reusable tools and equipment remain owned and are not reserved as consumable stock" : "Review whether this BOM line is consumed or reusable before reserving stock" });
          continue;
        }
        if (!isUnitCompatibleWithItemKind(item.kind, item.unit)) {
          const reason = unitCorrectionReason(item.kind, item.unit) ?? `unit '${item.unit}' is not recognized for kind '${item.kind}'`;
          fieldErrors.push({ path: `reservations.${index}.itemId`, code: "incompatible_inventory_unit", message: `Inventory item needs unit correction before it can be used in project setup: ${reason}` });
          continue;
        }
        const approved = canReserveBomItem(setupLine, item);
        const conversion = bomCandidateQuantityConversion(setupLine, item);
        const factor = conversion?.requirement.quantity ?? 1;
        if (!approved) fieldErrors.push({ path: `reservations.${index}.itemId`, code: "invalid_reservation_reference", message: "Reservation item must be the exact BOM item or a confirmed alternative" });
        if (!bomSpecification(setupLine).sufficient) fieldErrors.push({ path: `reservations.${index}.bomLineLocalRef`, code: "unresolved_specification", message: "Resolve the BOM specification decisions before reserving stock" });
        if (item.unit !== line.unit && conversion === undefined) {
          // Keep the legacy semantic diagnostic alongside the more precise
          // conversion error. Consumers use unit_mismatch to group all
          // cross-unit reservation failures, while invalid_quantity_conversion
          // explains why this particular pair cannot be reserved safely.
          fieldErrors.push({ path: `reservations.${index}.unit`, code: "unit_mismatch", message: "Reservation unit must match the inventory item" });
          fieldErrors.push({ path: `reservations.${index}.unit`, code: "invalid_quantity_conversion", message: `Reservation requires a valid one-set conversion from ${item.unit} to ${line.unit}` });
        }
        if (reservation.unit !== undefined && reservation.unit !== item.unit) fieldErrors.push({ path: `reservations.${index}.unit`, code: "unit_mismatch", message: "Reservation unit must match the inventory item" });
        if (conversion !== undefined && !Number.isSafeInteger(reservation.quantity)) fieldErrors.push({ path: `reservations.${index}.quantity`, code: "unit_mismatch", message: "Converted reservations must use a whole number of sets" });
        if (!matchesBomConstraints(item, line.constraints)) fieldErrors.push({ path: `reservations.${index}.itemId`, code: "constraint_mismatch", message: "Inventory item does not satisfy the BOM constraints" });
        if (!isConfirmedEvidence(item.evidence.state)) fieldErrors.push({ path: `reservations.${index}.itemId`, code: "insufficient_evidence", message: "Only physically confirmed stock can be reserved" });
        const priorUnit = reservationUnitsByLine.get(line.localRef);
        if (priorUnit !== undefined && priorUnit !== item.unit) {
          mixedReservationLines.add(line.localRef);
          fieldErrors.push({ path: `reservations.${index}.unit`, code: "unit_mismatch", message: `BOM line '${line.localRef}' cannot mix active reservation units` });
        } else if (priorUnit === undefined) {
          reservationUnitsByLine.set(line.localRef, item.unit);
        }
        // Do not sum quantities for a line after its active reservation units
        // diverge. The preview remains reviewable, but cannot imply a valid
        // scalar total or commit a mixed-unit reservation set.
        if (mixedReservationLines.has(line.localRef)) continue;
        const priorCoverage = plannedByLineCoverage.get(line.localRef) ?? 0;
        if (exceedsReservableQuantity(reservation.quantity, line.requiredQuantity, priorCoverage, conversion?.requirement.quantity)) fieldErrors.push({ path: `reservations.${index}.quantity`, code: "requirement_exceeded", message: "Reservation cannot exceed the BOM requirement after whole-unit conversion" });
        plannedByItem.set(item.id, (plannedByItem.get(item.id) ?? 0) + reservation.quantity);
        plannedByLineCoverage.set(line.localRef, priorCoverage + reservation.quantity * factor);
      }
    }
    for (const item of inventory) {
      const planned = plannedByItem.get(item.id) ?? 0;
      if (quantityExceeds(planned, item.availableQuantity)) fieldErrors.push({ path: "reservations", code: "insufficient_stock", message: `Planned reservations exceed available stock for '${item.id}'` });
    }
    const revisionId = proposal.revision.id as string;
    const plannedReservationRecords = setupReservationRecords(proposal, setupLines, now);
    // The preview is evaluated before reservation writes exist, so project the
    // proposed allocation onto the inventory snapshot first. The evaluator
    // then treats the projected reservation as owned by its declaring line,
    // while keeping the remaining free pool unavailable to other lines.
    const plannedInventory = setupProjectedInventory(inventory, plannedReservationRecords);
    const evaluated = evaluateBomGapsFromData(revisionId, setupLines, plannedInventory, plannedReservationRecords);
    const gaps = evaluated.lines;
    const unresolvedSpecifications = proposal.bomLines.flatMap((line) => {
      const specification = line.constraints.specification;
      return specification?.status === "insufficient" ? [{ bomLineLocalRef: line.localRef, missingDecisions: [...(specification.missingDecisions ?? [])] }] : [];
    });
    const reservationState = new Map<string, { version: number; availableQuantity: number; allocatedQuantity: number }>();
    const plannedReservations = proposal.reservations.flatMap((reservation) => {
      const item = inventory.find((candidate) => candidate.id === reservation.itemId);
      if (item === undefined) return [];
      const prior = reservationState.get(item.id) ?? { version: item.version, availableQuantity: item.availableQuantity, allocatedQuantity: item.allocatedQuantity ?? Math.max(0, item.quantity - item.availableQuantity) };
      const before = { ...prior };
      const after = { version: prior.version + 1, availableQuantity: Math.max(0, prior.availableQuantity - reservation.quantity), allocatedQuantity: prior.allocatedQuantity + reservation.quantity };
      reservationState.set(item.id, after);
      return [{ localRef: reservation.localRef, bomLineLocalRef: reservation.bomLineLocalRef, reservationId: reservation.id as string, itemId: item.id, quantity: reservation.quantity, unit: item.unit, before, after }];
    });
    // Every candidate can change the setup decision. Include all matching
    // candidates, even when no reservation is planned, so a changed row or a
    // newly matching row cannot be committed against an old preview.
    const affectedItemIds = new Set([...setupGapCandidateIds(evaluated), ...proposal.reservations.map((reservation) => reservation.itemId)]);
    const affectedInventory = [...affectedItemIds].sort((left, right) => left.localeCompare(right)).flatMap((itemId) => {
      const item = inventory.find((candidate) => candidate.id === itemId);
      if (item === undefined) return [];
      const planned = plannedByItem.get(item.id) ?? 0;
      const allocated = item.allocatedQuantity ?? Math.max(0, item.quantity - item.availableQuantity);
      return [{ itemId: item.id, unit: item.unit, evidenceBasis: item.evidence, before: { version: item.version, quantity: item.quantity, availableQuantity: item.availableQuantity, allocatedQuantity: allocated }, after: { version: item.version + (planned > 0 ? proposal.reservations.filter((reservation) => reservation.itemId === item.id).length : 0), quantity: item.quantity, availableQuantity: Math.max(0, item.availableQuantity - planned), allocatedQuantity: allocated + planned } }];
    });
    const preview = projectSetupPreviewSchema.parse({
      id: previewId, version: 1, status: "active", createdAt: now, updatedAt: now,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), contentSha256: setupCanonicalHash(proposal), proposal,
      fieldErrors, unresolvedSpecifications,
      gaps: { revisionId, lines: gaps, totals: evaluated.totals },
      plannedReservations, affectedInventory, correlationId: ctx.correlationId
    });
    return this.ports.unitOfWork.run(() => setup.savePreview(preview, ctx.actor));
  }

  /** Commit exactly one validated preview as one audited mutation. */

  async commitProjectSetup(input: CommitProjectSetup, ctx: RequestContext): Promise<Mutation<ProjectSetupCommitResult>> {
    const parsed = commitProjectSetupSchema.parse(input);
    if (ctx.projectId !== undefined) throw new ApplicationError("forbidden", "Project-scoped tokens cannot commit project setup");
    const projectWrite = ctx.scopes.has("projects:write") || ctx.scopes.has("write") || ctx.scopes.has("admin");
    const bomWrite = ctx.scopes.has("bom:write") || ctx.scopes.has("write") || ctx.scopes.has("admin");
    if (!projectWrite || !bomWrite) throw new ApplicationError("forbidden", "Project setup commit requires projects:write and bom:write");
    if (ctx.idempotencyKey === undefined || ctx.idempotencyKey.length < 8 || ctx.idempotencyKey.length > 200) throw new ApplicationError("validation", "An 8-200 character idempotency key is required");
    const setup = this.ports.projectSetups;
    if (setup === undefined) throw new ApplicationError("integrity_error", "This runtime does not support project setup commits");
    const commandCtx = canonicalProjectSetupCommitContext(ctx, parsed);
    return this.mutate(commandCtx, "project.setup.commit", "project", parsed.previewId, async () => {
      const preview = await setup.getPreview(parsed.previewId, ctx.actor);
      if (preview === null) throw conflict("Project setup preview was not found or is not owned by this actor", { reason: "preview_ownership", retryable: false, commitState: "not_committed" });
      if (preview.status === "committed") throw conflict("Project setup preview has already been committed", { reason: "already_committed", retryable: false, commitState: "committed" });
      if (preview.status !== "active") throw conflict("Project setup preview is no longer active", { reason: "preview_expired", retryable: false, commitState: "not_committed", recoveryAction: "preview_project_setup" });
      if (preview.expiresAt <= nowIso()) throw conflict("Project setup preview has expired", { reason: "preview_expired", retryable: false, commitState: "not_committed", recoveryAction: "preview_project_setup" });
      if (preview.version !== parsed.expectedPreviewVersion || preview.contentSha256 !== parsed.contentSha256) throw conflict("Project setup preview is stale", { reason: "stale_preview", retryable: false, commitState: "not_committed", recoveryAction: "preview_project_setup" });
      if (preview.plannedReservations.length > 0 && parsed.confirmReservations !== true) throw new ApplicationError("validation", "confirmReservations must be true when reservations are planned");
      // Semantic preview errors have always been rejected as validation
      // failures. Preserve that precedence before reading the live inventory;
      // stale-basis checks apply only to otherwise valid previews.
      if (preview.fieldErrors.length > 0) throw new ApplicationError("validation", "Project setup preview contains semantic field errors");
      const intendedPrinterItemId = preview.proposal.revision.intendedPrinterItemId;
      if (intendedPrinterItemId !== undefined && intendedPrinterItemId !== null) {
        if (preview.proposal.revision.fabricationRoute !== "printed") throw new ApplicationError("validation", "The intended printer requires the printed fabrication route");
        await assertOwnedPrinter(this.ports, intendedPrinterItemId);
      }
      // Candidate identity is part of the preview basis as well as the
      // quantity/evidence rows below. A new inventory row that now matches a
      // constraint has no prior version to compare, so recompute candidate
      // identities before allowing the graph commit.
      const currentInventory = await listAllInventory(this.ports.inventory);
      const setupLines = setupBomLines(preview.proposal, preview.createdAt);
      const setupReservations = setupReservationRecords(preview.proposal, setupLines, preview.createdAt);
      const currentInventoryById = new Map(currentInventory.map((item) => [item.id, item]));
      const changedReservationItems = preview.affectedInventory.flatMap((basis) => {
        const item = currentInventoryById.get(basis.itemId);
        if (item === undefined) return [basis.itemId];
        const allocated = item.allocatedQuantity ?? Math.max(0, item.quantity - item.availableQuantity);
        const evidenceChanged = JSON.stringify(canonicalize(item.evidence)) !== JSON.stringify(canonicalize(basis.evidenceBasis));
        return item.unit !== basis.unit || item.version !== basis.before.version || item.quantity !== basis.before.quantity
          || item.availableQuantity !== basis.before.availableQuantity || allocated !== basis.before.allocatedQuantity || evidenceChanged
          ? [basis.itemId]
          : [];
      });
      if (changedReservationItems.length > 0) {
        throw conflict("Project setup inventory reservation basis is stale", {
          reason: "stale_basis",
          staleItems: [...new Set(changedReservationItems)].sort((left, right) => left.localeCompare(right)),
          recoveryAction: "preview_project_setup",
          retryable: false,
          commitState: "not_committed",
        });
      }
      for (const reservation of preview.proposal.reservations) {
        const line = setupLines.find((candidate) => candidate.id === preview.proposal.bomLines.find((entry) => entry.localRef === reservation.bomLineLocalRef)?.id);
        const item = currentInventoryById.get(reservation.itemId);
        if (line === undefined || item === undefined || !isUnitCompatibleWithItemKind(item.kind, item.unit) || !canReserveBomItem(line, item) || !isConfirmedEvidence(item.evidence.state)) {
          throw conflict("Project setup reservation basis is stale", { reason: "stale_basis", staleItems: [reservation.itemId], recoveryAction: "preview_project_setup", retryable: false, commitState: "not_committed" });
        }
      }
      const currentGaps = evaluateBomGapsFromData(preview.gaps.revisionId, setupLines, setupProjectedInventory(currentInventory, setupReservations), setupReservations);
      const previewGaps = new Map(preview.gaps.lines.map((gap) => [gap.lineId, gap]));
      const changedCandidates = currentGaps.lines.filter((gap) => {
        const prior = previewGaps.get(gap.lineId);
        return prior === undefined || !sameStringArray(prior.matchedItemIds, gap.matchedItemIds);
      });
      if (changedCandidates.length > 0) {
        throw conflict("Project setup inventory candidate basis is stale", {
          reason: "stale_basis",
          staleItems: changedCandidates.flatMap((gap) => gap.matchedItemIds),
          recoveryAction: "preview_project_setup",
          retryable: false,
          commitState: "not_committed",
        });
      }
      const value = await setup.commitPreview({ preview, command: parsed, actor: ctx.actor, source: ctx.source, correlationId: ctx.correlationId });
      // Return the same live allocator's post-commit result. In particular,
      // planned reservations now exist as active reservations and must still
      // count for their own lines without becoming free stock elsewhere.
      const committedInventory = await listAllInventory(this.ports.inventory);
      const committedGaps = evaluateBomGapsFromData(value.revision.id, value.bomLines, committedInventory, value.reservations);
      const committed: ProjectSetupCommitResult = {
        ...value,
        gaps: { revisionId: committedGaps.revisionId, lines: [...committedGaps.lines], totals: { ...committedGaps.totals } }
      };
      return {
        value: committed,
        entityId: value.project.id,
        version: value.project.version,
        withAudit: (audit) => ({ ...committed, auditIds: [audit.id] }),
        ...(setup.rollbackLastCommit === undefined ? {} : { compensate: () => setup.rollbackLastCommit!() })
      };
    });
  }
}
