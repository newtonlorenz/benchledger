import { createHash, randomUUID } from "node:crypto";
import {
  bomAlternativeSchema, bomGapSchema, bomLineSchema, bomLineRoleSchema, bomSpecificationDecisionSchema, bomSpecificationSchema, createInventoryCategorySchema, createInventoryItemSchema, createOfferSchema,
  createProjectRevisionSchema, createProjectSchema, createReservationSchema,
  createProjectWithInitialRevisionSchema, createWorkItemRevisionSchema, createWorkItemSchema, idSchema, inventoryListQuerySchema,
  commissionInventoryItemSchema, quantityUnitSchema, stockEventInputSchema, updateInventoryCategorySchema, updateInventoryItemSchema,
  inventoryBulkUpdateSchema,
  updateProjectSchema, updateProjectRevisionSchema, catalogProductSchema, createCatalogProductSchema,
  updateCatalogProductSchema, inventoryProductProfileSchema,
  createInventoryProductProfileSchema, updateInventoryProductProfileSchema,
  buildConfigurationSnapshotSchema, createBuildConfigurationSnapshotSchema,
  beginUploadSchema, artifactListQuerySchema,
  createInventoryWithProductProfileSchema,
  inventoryItemSchema,
  saveReconciliationDraftSchema, commitReconciliationSchema, reconciliationDraftSchema,
  reconciliationCommitSchema, reservationSchema, workspaceSecurityStatusSchema, workspaceSecurityMutationSchema,
  projectSetupProposalSchema, commitProjectSetupSchema, projectSetupPreviewSchema, quantityConversionSchema,
  inspectionObservationSchema, inspectionCompletionPreviewSchema, commitInspectionCompletionSchema, inspectionCompletionCommitSchema,
  FILAMENT_CATALOG_IDENTITY_UNKNOWN_BLOCKER,
  isUnitCompatibleWithItemKind, unitCorrectionReason
} from "@benchledger/api-contract";
import type {
  Artifact, BomGap, BomGapCandidate, BomLine, CreateBomLine, CreateInventoryItem, CreateOffer, CreateProject,
  CreateProjectRevision, CreateReservation, CreateWorkItem, CreateWorkItemRevision,
  CreateProjectWithInitialRevision, InventoryItem, InventoryListQuery, Offer, Project, ProjectRevision, ProjectWithInitialRevision, Reservation,
  InventoryBulkUpdate, StockEventInput, CommissionInventoryItem, UploadSession, WorkItem, WorkItemRevision, CatalogProduct, CreateCatalogProduct,
  UpdateCatalogProduct, InventoryProductProfile, CreateInventoryProductProfile,
  UpdateProjectRevision,
  UpdateInventoryProductProfile, BuildConfigurationSnapshot, CreateBuildConfigurationSnapshot,
  ReconciliationDraft, ReconciliationCommit, CommitReconciliation, InventoryCategory, CreateInventoryCategory, UpdateInventoryCategory, WorkspaceSecurityMutation, ProjectTombstone,
  ProjectSetupProposal, ProjectSetupPreview, CommitProjectSetup, ProjectSetupCommitResult, ProjectSetupFieldError, BeginUpload as ApiBeginUpload, ArtifactListQuery, InspectionAction, InspectionCompletionPreview, InspectionObservation, InspectionCompletionCommit
} from "@benchledger/api-contract";
import { ApplicationError, conflict, notFound, projectRemoved } from "./errors.js";
import { isLedResistorRequirement, resolveBomSpecification } from "@benchledger/domain";
import { parseInventoryCursor } from "./inventory-pagination.js";
import type {
  ApplicationPorts, ArtifactDownload, AuditEvent, AuditInput, BeginUploadInput, BulkMutation, EventBusEvent,
  GapEvaluation, InventoryBulkUpdateResult, InventoryListOptions, Mutation, Page, ProjectListOptions, RequestContext,
  ReservationDetails, StockMutation, UpdateInventoryInput, UploadSessionDetails, UsageInput,
  CatalogProductListOptions, BuildConfigurationListOptions, InventoryCategoryListOptions, InventoryCategoryPort, InspectionPort
} from "./ports.js";
import { z } from "zod";
import { buildReconciliationDocument, reconciliationCommitId, reconciliationDraftId, type ReconciliationSourceSnapshot } from "./reconciliation.js";
import { canonicalInventoryBulkUpdate, inventoryBulkUpdateFingerprint, normalizeInventoryBulkChanges } from "./inventory-bulk.js";
import { deriveInspectionActions, hashInspectionBasis, pageInspectionActions } from "./inspection.js";

const CONFIRMED_EVIDENCE = new Set(["physically_counted", "commissioned"]);
/** Stable blocker recorded when a physical filament has no catalog identity. */
export const FILAMENT_CATALOG_IDENTITY_UNKNOWN = FILAMENT_CATALOG_IDENTITY_UNKNOWN_BLOCKER;
const COMMISSIONABLE_EVIDENCE = new Set(["delivered_uncounted", "ordered_unverified"]);
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const ALLOWED_BINARY_MEDIA = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp", "application/octet-stream",
  "model/step", "model/stl", "application/vnd.ms-package.3dmanufacturing-3mf"
]);
const DISALLOWED_EXTENSIONS = new Set([".html", ".htm", ".svg", ".js", ".mjs", ".cjs", ".exe", ".sh", ".zip", ".tar", ".gz"]);
const INVENTORY_SCAN_PAGE_SIZE = 200;
const WORKSPACE_SECURITY_ENTITY_ID = "workspace";

function inventoryWithUnitStatus(item: InventoryItem): InventoryItem {
  const reason = unitCorrectionReason(item.kind, item.unit);
  const { unitStatus: _storedStatus, unitCorrectionReason: _storedReason, ...withoutStoredStatus } = item;
  return {
    ...withoutStoredStatus,
    unitStatus: reason === undefined ? "compatible" : "needs_correction",
    ...(reason === undefined ? {} : { unitCorrectionReason: reason })
  };
}

function assertCompatibleInventoryUnit(item: Pick<InventoryItem, "kind" | "unit" | "id">, action: string): void {
  if (!isUnitCompatibleWithItemKind(item.kind, item.unit)) {
    const reason = unitCorrectionReason(item.kind, item.unit) ?? `unit '${item.unit}' is not recognized for kind '${item.kind}'`;
    throw new ApplicationError("validation", `${action}: inventory item '${item.id}' needs unit correction. ${reason}`);
  }
}

/**
 * The REST and MCP boundaries use the closed bomConstraintsSchema. The
 * application service also reads older persisted BOM records, so it accepts
 * their string maps here and keeps unsupported keys fail-closed in matching,
 * reservation, and evaluation. This is an internal compatibility path only;
 * new external requests are validated by the strict boundary schemas.
 */
const legacyBomConstraintValueSchema = z.union([z.string(), bomSpecificationSchema]);
const legacyBomConstraintsSchema = z.record(z.string(), legacyBomConstraintValueSchema).default({});
const legacyCreateBomLineSchema = z.object({
  id: idSchema.optional(),
  name: z.string().min(1).max(240),
  itemId: idSchema.optional(),
  role: bomLineRoleSchema.nullable().optional(),
  requiredQuantity: z.number().finite().positive(),
  unit: quantityUnitSchema,
  optional: z.boolean(),
  constraints: legacyBomConstraintsSchema,
  alternatives: z.array(bomAlternativeSchema).max(20),
  notes: z.string().max(2000).optional(),
}).strict();
const legacyUpdateBomLineSchema = z.object({
  name: z.string().min(1).max(240).optional(),
  itemId: idSchema.optional(),
  role: bomLineRoleSchema.nullable().optional(),
  requiredQuantity: z.number().finite().positive().optional(),
  unit: quantityUnitSchema.optional(),
  optional: z.boolean().optional(),
  constraints: legacyBomConstraintsSchema.optional(),
  alternatives: z.array(bomAlternativeSchema).max(20).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

/**
 * Constraint keys are deliberately allow-listed at the API boundary. BOM
 * records are persisted as a flexible string map for forward compatibility,
 * but an unknown key must never silently broaden a match to every item.
 */
export const SUPPORTED_BOM_CONSTRAINT_KEYS: ReadonlySet<string> = new Set([
  "kind", "manufacturer", "model", "sku", "tag", "nameIncludes"
]);

const SPECIFICATION_CONSTRAINT_KEY = "specification";

type BomConstraintValue = string | z.infer<typeof bomSpecificationSchema>;

export function unsupportedBomConstraintKeys(constraints: Readonly<Record<string, BomConstraintValue | undefined>> | undefined): readonly string[] {
  if (constraints === undefined) return [];
  return Object.keys(constraints).filter((key) => key !== SPECIFICATION_CONSTRAINT_KEY && !SUPPORTED_BOM_CONSTRAINT_KEYS.has(key));
}

export function matchesBomConstraints(item: InventoryItem, constraints: Readonly<Record<string, BomConstraintValue | undefined>> | undefined): boolean {
  if (constraints === undefined) return true;
  if (unsupportedBomConstraintKeys(constraints).length > 0) return false;
  return Object.entries(constraints).every(([key, expected]) => {
    if (key === SPECIFICATION_CONSTRAINT_KEY) return bomSpecificationSchema.safeParse(expected).success;
    if (typeof expected !== "string") return false;
    if (key === "kind") return item.kind === expected;
    if (key === "manufacturer") return item.manufacturer?.toLowerCase() === expected.toLowerCase();
    if (key === "model") return item.model?.toLowerCase() === expected.toLowerCase();
    if (key === "sku") return item.sku?.toLowerCase() === expected.toLowerCase();
    if (key === "tag") return item.tags.some((tag) => tag.toLowerCase() === expected.toLowerCase());
    if (key === "nameIncludes") return item.name.toLowerCase().includes(expected.toLowerCase());
    return false;
  });
}

type BomCandidateKind = "exact" | "confirmed_alternative" | "uncertain_alternative";

interface BomCandidate {
  readonly item: InventoryItem;
  readonly kind: BomCandidateKind;
}

type BomQuantityConversion = NonNullable<BomLine["alternatives"][number]["quantityConversion"]>;

type LegacyBomLineInput = Omit<CreateBomLine, "constraints"> & {
  /** @deprecated Accepted only for internal callers reading legacy records. */
  constraints?: Readonly<Record<string, BomConstraintValue>>;
};

function bomCandidateRelationship(kind: BomCandidateKind): BomGapCandidate["relationship"] {
  return kind;
}

function bomCandidateAlternative(line: BomLine, itemId: string): BomLine["alternatives"][number] | undefined {
  return line.alternatives.find((alternative) => alternative.itemId === itemId);
}

/**
 * Resolve a persisted conversion only when its orientation matches the
 * inventory row and BOM line. Boundary schemas validate new writes, but live
 * gap reads also need to fail closed for older or hand-written records.
 * Conflicting conversion factors are ambiguous and therefore unusable.
 */
function bomCandidateQuantityConversion(line: BomLine, item: InventoryItem): BomQuantityConversion | undefined {
  if (item.unit === line.unit) return undefined;
  const conversions = line.alternatives
    .filter((alternative) => alternative.itemId === item.id)
    .map((alternative) => {
      const parsed = quantityConversionSchema.safeParse(alternative.quantityConversion);
      return parsed.success && parsed.data.inventory.unit === item.unit && parsed.data.requirement.unit === line.unit
        ? parsed.data
        : undefined;
    })
    .filter((conversion): conversion is BomQuantityConversion => conversion !== undefined);
  const quantities = new Set(conversions.map((conversion) => conversion.requirement.quantity));
  if (quantities.size !== 1) return undefined;
  return conversions[0];
}

function bomCandidateQuantityFactor(line: BomLine, item: InventoryItem): number | undefined {
  if (!isUnitCompatibleWithItemKind(item.kind, item.unit)) return undefined;
  if (item.unit === line.unit) return 1;
  return bomCandidateQuantityConversion(line, item)?.requirement.quantity;
}

function bomCandidateHasResolvableQuantity(line: BomLine, candidate: BomCandidate): boolean {
  return bomCandidateQuantityFactor(line, candidate.item) !== undefined;
}

function bomCandidateUsesWholeSets(line: BomLine, item: InventoryItem): boolean {
  return item.unit !== line.unit && bomCandidateQuantityConversion(line, item) !== undefined;
}

function bomCandidateCompatibility(line: BomLine, candidate: BomCandidate): BomGapCandidate["compatibility"] {
  if (candidate.kind === "exact") return "confirmed";
  return bomCandidateAlternative(line, candidate.item.id)?.compatible ?? "unknown";
}

function bomCandidateReason(line: BomLine, candidate: BomCandidate): string {
  const alternative = bomCandidateAlternative(line, candidate.item.id);
  const base = alternative?.reason
    ?? (candidate.kind === "exact" ? "Exact inventory item declared by the BOM."
      : candidate.kind === "confirmed_alternative" ? "Explicitly confirmed BOM alternative."
      : "Alternative compatibility is not explicitly confirmed.");
  if (!isUnitCompatibleWithItemKind(candidate.item.kind, candidate.item.unit)) {
    return `${base} Unit needs correction before this stock can be matched or reserved.`;
  }
  if (candidate.item.unit === line.unit) return base;
  const conversion = bomCandidateQuantityConversion(line, candidate.item);
  if (conversion === undefined) return `${base} No valid one-set conversion from ${candidate.item.unit} to ${line.unit} is recorded; inspect before use.`;
  return `${base} Conversion: 1 set = ${conversion.requirement.quantity} each.`;
}

/**
 * Resolve a stock row to the relationship explicitly declared by the BOM.
 * An item that merely happens to satisfy a descriptive constraint is not a
 * candidate: discovery requires an explicit item identity or alternative.
 */
function bomCandidateKind(line: BomLine, item: InventoryItem): BomCandidateKind | undefined {
  const alternatives = line.alternatives.filter((alternative) => alternative.itemId === item.id);
  if (line.itemId === item.id) {
    // A contradictory conditional/unknown alternative must not be silently
    // upgraded to an exact, reservable match just because the same ID is also
    // present in itemId. Keep the relationship inspect-first until a human
    // resolves the compatibility decision.
    if (alternatives.some((alternative) => alternative.compatible !== "confirmed")) return "uncertain_alternative";
    return "exact";
  }
  if (alternatives.some((alternative) => alternative.compatible === "confirmed")) return "confirmed_alternative";
  if (alternatives.length > 0) return "uncertain_alternative";
  return undefined;
}

function canSupplyBomCandidate(candidate: BomCandidate): boolean {
  return candidate.kind === "exact" || candidate.kind === "confirmed_alternative";
}

function canReserveBomItem(line: BomLine, item: InventoryItem): boolean {
  const kind = bomCandidateKind(line, item);
  return (kind === "exact" || kind === "confirmed_alternative")
    && bomCandidateHasResolvableQuantity(line, { item, kind });
}

type BomSpecificationDecision = z.infer<typeof bomSpecificationDecisionSchema>;

export function bomSpecification(line: Pick<BomLine, "name" | "constraints"> & { readonly id?: string | undefined; readonly itemId?: string | undefined }): { readonly sufficient: boolean; readonly missingDecisions: readonly BomSpecificationDecision[] } {
  const raw = line.constraints?.[SPECIFICATION_CONSTRAINT_KEY];
  if (raw !== undefined && !bomSpecificationSchema.safeParse(raw).success) {
    throw new ApplicationError("integrity_error", `BOM line ${line.id ?? "unknown"} contains a malformed specification decision.`);
  }
  return resolveBomSpecification(line);
}

function canonicalizeBomLineWrite<T extends { readonly name: string; readonly constraints?: unknown }>(input: T): T {
  if (!isLedResistorRequirement(input.name)) return input;
  const constraints = isRecord(input.constraints) ? input.constraints : undefined;
  const specification = constraints?.[SPECIFICATION_CONSTRAINT_KEY];
  const resolved = resolveBomSpecification(input);
  if (isSpecificationSufficientClaim(specification) && !resolved.sufficient) {
    throw new ApplicationError("validation", "A sufficient LED resistor requirement must resolve resistance and power_rating.");
  }
  if (specification !== undefined) {
    if (!isRecord(specification) || specification.status !== "insufficient") return input;
    return {
      ...input,
      constraints: {
        ...(constraints ?? {}),
        specification: { ...specification, status: "insufficient", missingDecisions: [...resolved.missingDecisions] },
      },
    } as T;
  }
  return {
    ...input,
    constraints: {
      ...(constraints ?? {}),
      specification: { status: "insufficient", missingDecisions: [...resolved.missingDecisions] },
    },
  } as T;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSpecificationSufficientClaim(value: unknown): value is Readonly<Record<string, unknown>> & { readonly status: "sufficient" } {
  return isRecord(value) && value.status === "sufficient";
}

function bomRequirementRequestsPrinter(input: Pick<CreateBomLine, "constraints">): boolean {
  return input.constraints?.kind === "printer";
}

function assertConsumedBomRequirement(line: Pick<BomLine, "role">): void {
  if (line.role === undefined || line.role === null) {
    throw new ApplicationError("validation", "Review whether this BOM line is consumed or reusable before changing stock");
  }
  if (line.role !== "consumed") {
    throw new ApplicationError("validation", "Only consumed BOM requirements may reserve or consume stock");
  }
}

function canonicalizeSetupProposal(proposal: ProjectSetupProposal): ProjectSetupProposal {
  return {
    ...proposal,
    bomLines: proposal.bomLines.map((line) => canonicalizeBomLineWrite(line) as typeof line),
  };
}

function bomDecision(line: BomLine, status: BomGap["status"], sufficient: boolean, inspectQuantity: number): BomGap["decision"] {
  if (status === "supplied") return "ready";
  if (status === "inspect_first") return "check";
  if (status === "partially_supplied") return inspectQuantity > 0 ? "check" : "source";
  if (status === "specify_first") return "decide";
  if (status === "optional") return sufficient ? "source" : "decide";
  return sufficient ? "source" : "decide";
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * BOM evaluation is an allocation report, so a line must have a stable place
 * in the allocation order even when an adapter returns rows in a different
 * order. Exact references take precedence over approved alternatives; IDs then
 * provide the deterministic tie-breaker.
 */
function bomLineAllocationPriority(line: BomLine): number {
  if (line.itemId !== undefined) return 0;
  if (line.alternatives.some((alternative) => alternative.compatible === "confirmed")) return 1;
  if (line.alternatives.length > 0) return 2;
  if (Object.keys(line.constraints ?? {}).length > 0) return 3;
  return 4;
}

function compareBomLinesForAllocation(left: BomLine, right: BomLine): number {
  return bomLineAllocationPriority(left) - bomLineAllocationPriority(right) || compareStableId(left.id, right.id);
}

function compareBomCandidates(left: BomCandidate, right: BomCandidate): number {
  const priority = (kind: BomCandidateKind): number => kind === "exact" ? 0 : kind === "confirmed_alternative" ? 1 : 2;
  return priority(left.kind) - priority(right.kind) || compareStableId(left.item.id, right.item.id);
}

/**
 * Inventory is a shared pool, so BOM evaluation must never make an allocation
 * decision from a truncated page. Follow the adapter's cursor until it says
 * the scan is complete, while rejecting contradictory or non-progressing
 * pagination rather than silently evaluating a partial snapshot.
 */
async function listAllInventory(inventory: ApplicationPorts["inventory"]): Promise<readonly InventoryItem[]> {
  const values: InventoryItem[] = [];
  const seenItemIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let expectedTotal: number | undefined;

  for (;;) {
    const current = await inventory.listItems(cursor === undefined
      ? { limit: INVENTORY_SCAN_PAGE_SIZE }
      : { limit: INVENTORY_SCAN_PAGE_SIZE, cursor });
    if (current.total !== undefined) {
      if (!Number.isSafeInteger(current.total) || current.total < 0) {
        throw new ApplicationError("integrity_error", "Inventory pagination returned an invalid total");
      }
      if (expectedTotal === undefined) expectedTotal = current.total;
      else if (current.total !== expectedTotal) throw new ApplicationError("integrity_error", "Inventory pagination returned inconsistent totals");
    }
    for (const item of current.data) {
      if (seenItemIds.has(item.id)) throw new ApplicationError("integrity_error", "Inventory pagination returned a duplicate item");
      seenItemIds.add(item.id);
      values.push(item);
    }
    if (expectedTotal !== undefined && values.length > expectedTotal) {
      throw new ApplicationError("integrity_error", "Inventory pagination returned more items than its total");
    }

    const nextCursor = current.nextCursor;
    if (nextCursor === undefined) {
      if (expectedTotal !== undefined && values.length !== expectedTotal) {
        throw new ApplicationError("integrity_error", "Inventory pagination ended before its total was read");
      }
      // A full page without a total or continuation cursor is ambiguous: it
      // may be a truncated adapter response. Fail closed instead of making a
      // BOM recommendation from an unknown inventory suffix.
      if (expectedTotal === undefined && current.data.length >= INVENTORY_SCAN_PAGE_SIZE) {
        throw new ApplicationError("integrity_error", "Inventory pagination ended without a continuation cursor");
      }
      return values;
    }
    if (nextCursor.length === 0 || seenCursors.has(nextCursor) || nextCursor === cursor) {
      throw new ApplicationError("integrity_error", "Inventory pagination did not make progress");
    }
    if (expectedTotal !== undefined && values.length >= expectedTotal) {
      throw new ApplicationError("integrity_error", "Inventory pagination returned a cursor after its total was read");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function inspectionPort(ports: ApplicationPorts): InspectionPort {
  if (ports.inspections === undefined) throw new ApplicationError("integrity_error", "Inspection operations are not configured");
  return ports.inspections;
}

function inspectionBasis(
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

function projectedInspectionItem(item: InventoryItem, observation: InspectionObservation, updatedAt: string): InventoryItem {
  if (observation.result !== "confirmed" || observation.quantity === undefined) return item;
  if (observation.unit !== item.unit) throw new ApplicationError("validation", `Inspection quantity must use the candidate unit '${item.unit}'`);
  const allocated = item.allocatedQuantity
    ?? ((item.evidence.state === "physically_counted" || item.evidence.state === "commissioned")
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

function validateInspectionObservation(action: InspectionAction, observation: InspectionObservation): void {
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

function inspectionLineSnapshots(
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

interface BomLineAllocation {
  readonly suppliedQuantity: number;
  readonly inspectQuantity: number;
}

function commandContext(ctx: RequestContext, scope: string, input: unknown): RequestContext {
  if (ctx.fingerprint !== undefined) return ctx;
  return { ...ctx, fingerprint: createHash("sha256").update(JSON.stringify(canonicalize({ scope, input }))).digest("hex") };
}

function setupDerivedId(previewId: string, localRef: string, prefix: string): string {
  const digest = createHash("sha256").update(`${previewId}\u0000${localRef}`).digest("hex").slice(0, 28);
  return `${prefix}-${digest}`;
}

function setupCanonicalHash(proposal: ProjectSetupProposal): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(proposal))).digest("hex");
}

function setupNormalize(previewId: string, input: ProjectSetupProposal): ProjectSetupProposal {
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

/**
 * Evaluate one already-loaded snapshot. Project setup previews use this same
 * allocator with their proposed reservations, so preview and live BOM reads
 * cannot drift in candidate ordering, shared-stock allocation, or totals.
 */
function evaluateBomGapsFromData(id: string, lines: readonly BomLine[], active: readonly InventoryItem[], reservations: readonly Reservation[]): GapEvaluation {
  const ownedReservations = new Map<string, number>();
  const reservedByItem = new Map<string, number>();
  for (const reservation of reservations) {
    if (reservation.status !== "active") continue;
    const key = `${reservation.lineId}\u0000${reservation.itemId}`;
    ownedReservations.set(key, (ownedReservations.get(key) ?? 0) + reservation.quantity);
    reservedByItem.set(reservation.itemId, (reservedByItem.get(reservation.itemId) ?? 0) + reservation.quantity);
  }
  const candidatesByLine = new Map<BomLine, readonly BomCandidate[]>();
  for (const line of lines) {
    const candidates = active
      // Explicit identities are retained across units so the gap can explain
      // why an alternative is blocked. Constraint-only matches are not
      // candidates: there is no discovery opt-in in the current BOM contract.
      .filter((item) => matchesBomConstraints(item, line.constraints))
      .flatMap((item): readonly BomCandidate[] => {
        const kind = bomCandidateKind(line, item);
        if (kind === undefined || (item.unit !== line.unit && line.alternatives.every((alternative) => alternative.itemId !== item.id))) return [];
        return [{ item, kind }];
      });
    candidatesByLine.set(line, candidates);
  }

  // `availableQuantity` is the unreserved quantity across all projects.
  // Keep three local ledgers so a candidate can be allocated at most once
  // across this evaluation while this revision's own reservations remain
  // available to their declaring line. The physical and reservation caps
  // also make malformed adapter data fail closed rather than count an item
  // twice.
  const remainingPhysical = new Map(active.map((item) => [item.id, Math.max(0, item.quantity)]));
  const remainingFree = new Map(active.map((item) => [item.id, Math.min(Math.max(0, item.quantity), Math.max(0, item.availableQuantity))]));
  const remainingReserved = new Map(active.map((item) => [item.id, Math.min(Math.max(0, item.quantity), Math.max(0, reservedByItem.get(item.id) ?? 0))]));
  const allocations = new Map<BomLine, BomLineAllocation>();
  const candidateFacts = new Map<string, BomGapCandidate>();
  const candidateInventoryAllocations = new Map<string, number>();
  const allocationLines = [...lines].sort(compareBomLinesForAllocation);

  const candidateCapacity = (line: BomLine, candidate: BomCandidate, mode: "confirmed" | "inspect"): number => {
    const itemId = candidate.item.id;
    const physical = remainingPhysical.get(itemId) ?? 0;
    const free = remainingFree.get(itemId) ?? 0;
    const reserved = remainingReserved.get(itemId) ?? 0;
    const own = Math.min(reserved, Math.max(0, ownedReservations.get(`${line.id}\u0000${itemId}`) ?? 0));
    // Uncounted stock may still be an inspect-first candidate even when its
    // free balance is zero, but an active reservation belongs exclusively to
    // its declaring line. Exclude reservations owned by other lines while
    // retaining the historical inspect-first treatment of otherwise
    // unavailable, unreserved physical stock.
    const inventoryCapacity = mode === "inspect"
      ? Math.min(physical, Math.max(0, physical - (reserved - own)))
      : Math.min(physical, free + own);
    const factor = bomCandidateQuantityFactor(line, candidate.item);
    if (factor === undefined) return 0;
    // A converted package is indivisible for planning/reservation purposes.
    // Fractional set rows therefore cannot create phantom individual parts.
    const wholeInventoryCapacity = bomCandidateUsesWholeSets(line, candidate.item)
      ? Math.floor(inventoryCapacity)
      : inventoryCapacity;
    return wholeInventoryCapacity * factor;
  };

  const recordCandidateFacts = (line: BomLine, candidates: readonly BomCandidate[], mode: "confirmed" | "inspect"): void => {
    for (const candidate of candidates) {
      const factKey = `${line.id}\u0000${candidate.item.id}`;
      const prior = candidateFacts.get(factKey);
      candidateFacts.set(factKey, {
        itemId: candidate.item.id,
        relationship: bomCandidateRelationship(candidate.kind),
        compatibility: bomCandidateCompatibility(line, candidate),
        availableQuantity: Math.max(prior?.availableQuantity ?? 0, candidateCapacity(line, candidate, mode)),
        suppliedQuantity: prior?.suppliedQuantity ?? 0,
        inspectQuantity: prior?.inspectQuantity ?? 0,
        reason: bomCandidateReason(line, candidate),
      });
    }
  };

  const allocate = (line: BomLine, candidates: readonly BomCandidate[], requested: number, mode: "confirmed" | "inspect"): number => {
    let remaining = requested;
    for (const candidate of [...candidates].sort(compareBomCandidates)) {
      if (remaining <= 0) break;
      const itemId = candidate.item.id;
      const physical = remainingPhysical.get(itemId) ?? 0;
      const capacity = candidateCapacity(line, candidate, mode);
      const factor = bomCandidateQuantityFactor(line, candidate.item);
      if (factor === undefined) {
        recordCandidateFacts(line, [candidate], mode);
        continue;
      }
      const free = mode === "confirmed" ? remainingFree.get(itemId) ?? 0 : 0;
      const own = mode === "confirmed"
        ? Math.min(remainingReserved.get(itemId) ?? 0, Math.max(0, ownedReservations.get(`${line.id}\u0000${itemId}`) ?? 0))
        : 0;
      const inventoryCapacity = mode === "inspect"
        ? Math.min(physical, Math.max(0, physical - (remainingReserved.get(itemId) ?? 0) + own))
        : Math.min(physical, free + own);
      const wholeInventoryCapacity = bomCandidateUsesWholeSets(line, candidate.item)
        ? Math.floor(inventoryCapacity)
        : inventoryCapacity;
      const factKey = `${line.id}\u0000${itemId}`;
      const prior = candidateFacts.get(factKey);
      const taken = Math.min(remaining, capacity);
      const requestedInventory = bomCandidateUsesWholeSets(line, candidate.item) ? Math.ceil(taken / factor) : taken;
      const takenInventory = Math.min(wholeInventoryCapacity, requestedInventory);
      const covered = Math.min(remaining, takenInventory * factor);
      candidateFacts.set(factKey, {
        itemId,
        relationship: bomCandidateRelationship(candidate.kind),
        compatibility: bomCandidateCompatibility(line, candidate),
        availableQuantity: Math.max(prior?.availableQuantity ?? 0, capacity),
        suppliedQuantity: (prior?.suppliedQuantity ?? 0) + (mode === "confirmed" ? taken : 0),
        inspectQuantity: (prior?.inspectQuantity ?? 0) + (mode === "inspect" ? covered : 0),
        reason: bomCandidateReason(line, candidate),
      });
      if (takenInventory <= 0 || covered <= 0) continue;
      if (mode === "confirmed") {
        // Consume a line's own reservation first; unreserved stock is then
        // consumed from the shared free pool for later lines.
        const fromReservation = Math.min(own, takenInventory);
        const fromFree = takenInventory - fromReservation;
        remainingReserved.set(itemId, Math.max(0, (remainingReserved.get(itemId) ?? 0) - fromReservation));
        remainingFree.set(itemId, Math.max(0, free - fromFree));
      }
      remainingPhysical.set(itemId, Math.max(0, physical - takenInventory));
      candidateInventoryAllocations.set(factKey, (candidateInventoryAllocations.get(factKey) ?? 0) + takenInventory);
      remaining -= covered;
    }
    return requested - remaining;
  };

  // Confirmed supply is allocated first, so a line that only has an
  // inspect-first relationship cannot consume capacity needed by an exact or
  // approved-alternative line later in the stable ordering.
  for (const line of allocationLines) {
    const candidates = candidatesByLine.get(line) ?? [];
    const confirmed = candidates.filter((candidate) => canSupplyBomCandidate(candidate) && CONFIRMED_EVIDENCE.has(candidate.item.evidence.state) && bomCandidateHasResolvableQuantity(line, candidate));
    recordCandidateFacts(line, confirmed, "confirmed");
    const suppliedQuantity = bomSpecification(line).sufficient ? allocate(line, confirmed, line.requiredQuantity, "confirmed") : 0;
    allocations.set(line, { suppliedQuantity, inspectQuantity: 0 });
  }
  for (const line of allocationLines) {
    const candidates = candidatesByLine.get(line) ?? [];
    const uncertain = candidates.filter((candidate) => !canSupplyBomCandidate(candidate) || !CONFIRMED_EVIDENCE.has(candidate.item.evidence.state) || !bomCandidateHasResolvableQuantity(line, candidate));
    recordCandidateFacts(line, uncertain, "inspect");
    const suppliedQuantity = allocations.get(line)?.suppliedQuantity ?? 0;
    const inspectQuantity = allocate(line, uncertain, Math.max(line.requiredQuantity - suppliedQuantity, 0), "inspect");
    allocations.set(line, { suppliedQuantity, inspectQuantity });
  }

  const gaps: BomGap[] = lines.map((line) => {
    const candidates = candidatesByLine.get(line) ?? [];
    const uncertain = candidates.filter((candidate) => !canSupplyBomCandidate(candidate) || !CONFIRMED_EVIDENCE.has(candidate.item.evidence.state) || !bomCandidateHasResolvableQuantity(line, candidate));
    const suppliedQuantity = allocations.get(line)?.suppliedQuantity ?? 0;
    const inspectQuantity = allocations.get(line)?.inspectQuantity ?? 0;
    const missingQuantity = Math.max(line.requiredQuantity - suppliedQuantity - inspectQuantity, 0);
    const specification = bomSpecification(line);
    // Preserve Source for an identified same-unit item with no stock. A
    // cross-unit explicit alternative is different: even with no conversion
    // capacity it remains visible as Check so the maker can resolve it.
    const uncoveredQuantity = Math.max(line.requiredQuantity - suppliedQuantity, 0);
    const inspectFirstCandidate = inspectQuantity > 0 || (uncoveredQuantity > 0 && uncertain.some((candidate) =>
      candidate.item.unit !== line.unit || !isUnitCompatibleWithItemKind(candidate.item.kind, candidate.item.unit)
    ));
    let status: BomGap["status"];
    if (line.optional && suppliedQuantity === 0 && inspectQuantity === 0) status = "optional";
    else if (inspectFirstCandidate && inspectQuantity === 0) status = "inspect_first";
    else if (!specification.sufficient && inspectQuantity === 0) status = "specify_first";
    else if (missingQuantity === 0 && inspectQuantity === 0) status = "supplied";
    else if (suppliedQuantity > 0 && missingQuantity > 0) status = "partially_supplied";
    else if (inspectQuantity > 0) status = "inspect_first";
    else status = "missing";
    const roleNeedsReview = line.role === undefined || line.role === null;
    const decision = roleNeedsReview ? "check" : bomDecision(line, status, specification.sufficient, inspectQuantity);
    const candidateResults = candidates.map((candidate) => {
      const fact = candidateFacts.get(`${line.id}\u0000${candidate.item.id}`);
      if (fact === undefined) throw new ApplicationError("integrity_error", "BOM candidate facts were not recorded");
      const conversion = bomCandidateQuantityConversion(line, candidate.item);
      if (conversion === undefined || candidate.item.unit === line.unit) return fact;
      const allocatedInventory = candidateInventoryAllocations.get(`${line.id}\u0000${candidate.item.id}`) ?? 0;
      const availableSets = Math.floor(fact.availableQuantity / conversion.requirement.quantity);
      const allocatedCoverage = allocatedInventory * conversion.requirement.quantity;
      const overage = allocatedCoverage > fact.suppliedQuantity ? allocatedCoverage - fact.suppliedQuantity : 0;
      return {
        ...fact,
        reason: `${fact.reason} Capacity: ${availableSets} set(s) = ${fact.availableQuantity} each.${allocatedInventory > 0 ? ` Allocation: ${allocatedInventory} set(s) = ${allocatedCoverage} each${overage > 0 ? `, ${overage} each overage` : ""}.` : ""}`,
      };
    });
    const reasons = [
      ...(suppliedQuantity > 0 ? ["Physically confirmed stock covers part or all of this requirement."] : []),
      ...(uncertain.some((candidate) => !canSupplyBomCandidate(candidate)) ? ["Some matching stock needs an explicit compatibility decision before use."] : []),
      ...(uncertain.some((candidate) => canSupplyBomCandidate(candidate) && !CONFIRMED_EVIDENCE.has(candidate.item.evidence.state)) ? ["Some matching stock is recorded but needs a physical count before use."] : []),
      ...(uncertain.some((candidate) => isUnitCompatibleWithItemKind(candidate.item.kind, candidate.item.unit) && !bomCandidateHasResolvableQuantity(line, candidate)) ? ["A cross-unit alternative has no valid evidence-backed conversion; inspect before use."] : []),
      ...(uncertain.some((candidate) => !isUnitCompatibleWithItemKind(candidate.item.kind, candidate.item.unit)) ? ["Matching stock has a unit that needs correction before use."] : []),
      ...(decision === "decide" ? [`Specify ${specification.missingDecisions.join(" and ")} before sourcing this requirement.`] : []),
      ...(roleNeedsReview ? ["Requirement role is not recorded; review whether this item is consumed or reusable before reserving or closing out."] : []),
      ...(decision !== "decide" && missingQuantity > 0 ? ["No confirmed stock covers the remaining quantity."] : []),
      ...(decision !== "decide" && candidates.length === 0 ? ["No matching inventory item was found for this line."] : []),
    ];
    return bomGapSchema.parse({
      lineId: line.id,
      name: line.name,
      optional: line.optional,
      status,
      decision,
      ...(specification.missingDecisions.length === 0 ? {} : { missingDecisions: [...specification.missingDecisions] }),
      requiredQuantity: line.requiredQuantity,
      suppliedQuantity,
      inspectQuantity,
      missingQuantity,
      unit: line.unit,
      matchedItemIds: candidates.map((candidate) => candidate.item.id),
      reasons,
      alternatives: line.alternatives,
      candidates: candidateResults
    });
  });
  return {
    revisionId: id,
    lines: gaps,
    totals: {
      requiredLines: gaps.filter((gap) => gap.optional !== true).length,
      suppliedLines: gaps.filter((gap) => gap.optional !== true && gap.status === "supplied").length,
      inspectFirstLines: gaps.filter((gap) => gap.optional !== true && gap.status === "inspect_first").length,
      partialLines: gaps.filter((gap) => gap.optional !== true && gap.status === "partially_supplied").length,
      missingLines: gaps.filter((gap) => gap.optional !== true && gap.status === "missing").length,
      optionalLines: gaps.filter((gap) => gap.optional === true).length,
      readyLines: gaps.filter((gap) => gap.optional !== true && gap.decision === "ready").length,
      checkLines: gaps.filter((gap) => gap.optional !== true && gap.decision === "check").length,
      decideLines: gaps.filter((gap) => gap.optional !== true && gap.decision === "decide").length,
      sourceLines: gaps.filter((gap) => gap.optional !== true && gap.decision === "source").length,
    }
  };
}

function setupBomLines(proposal: ProjectSetupProposal, now: string): readonly BomLine[] {
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

function setupReservationRecords(proposal: ProjectSetupProposal, lines: readonly BomLine[], now: string): readonly Reservation[] {
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

function setupProjectedInventory(inventory: readonly InventoryItem[], reservations: readonly Reservation[]): readonly InventoryItem[] {
  const plannedByItem = new Map<string, number>();
  for (const reservation of reservations) plannedByItem.set(reservation.itemId, (plannedByItem.get(reservation.itemId) ?? 0) + reservation.quantity);
  return inventory.map((item) => {
    const planned = plannedByItem.get(item.id) ?? 0;
    if (planned <= 0) return item;
    const allocated = item.allocatedQuantity ?? Math.max(0, item.quantity - item.availableQuantity);
    return { ...item, availableQuantity: Math.max(0, item.availableQuantity - planned), allocatedQuantity: allocated + planned };
  });
}

function setupGapCandidateIds(gaps: GapEvaluation): ReadonlySet<string> {
  return new Set(gaps.lines.flatMap((gap) => gap.matchedItemIds));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Project setup is a structured command whose parsed payload is the replay
 * identity. Transport envelopes may reorder fields or carry an unrelated
 * request fingerprint, so this command must always replace that fingerprint
 * with the canonical payload digest.
 */
function canonicalProjectSetupContext(ctx: RequestContext, input: CreateProjectWithInitialRevision): RequestContext {
  return { ...ctx, fingerprint: createHash("sha256").update(JSON.stringify(canonicalize({ scope: "project.create_with_initial_revision", input }))).digest("hex") };
}

function canonicalProjectSetupCommitContext(ctx: RequestContext, input: CommitProjectSetup): RequestContext {
  return { ...ctx, fingerprint: createHash("sha256").update(JSON.stringify(canonicalize({ scope: "project.setup.commit", input }))).digest("hex") };
}

/**
 * Password commands must not derive idempotency data from plaintext or an
 * encoded credential. Hosts must provide an opaque, secret-keyed request
 * fingerprint (for example, a transport-level HMAC digest).
 */
function workspaceSecurityCommandContext(ctx: RequestContext): RequestContext {
  if (ctx.fingerprint === undefined || ctx.fingerprint.length === 0 || ctx.fingerprint.length > 512) {
    throw new ApplicationError("validation", "Password commands require an opaque request fingerprint");
  }
  return ctx;
}

function safeFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed || trimmed.length > 255 || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new ApplicationError("validation", "Filename must be a single safe relative name");
  }
  const dot = trimmed.lastIndexOf(".");
  const extension = dot >= 0 ? trimmed.slice(dot).toLowerCase() : "";
  if (DISALLOWED_EXTENSIONS.has(extension)) {
    throw new ApplicationError("unsupported_media", "This file type is not accepted");
  }
  return trimmed;
}

/**
 * Translate the strict public upload shape to the storage-facing shape used by
 * existing artifact adapters. Every application caller must cross the strict
 * public revisioned contract before this normalization step.
 */
function normalizeArtifactUpload(input: ApiBeginUpload): BeginUploadInput {
  const result = beginUploadSchema.safeParse(input);
  if (!result.success) {
    throw new ApplicationError("validation", "Artifact upload must contain exactly one revisioned scope", { issues: result.error.issues });
  }
  const parsed = result.data;
  if ("projectRevisionId" in parsed) {
    const { projectRevisionId, buildConfigurationSnapshotId, ...rest } = parsed;
    return {
      ...rest,
      revisionId: projectRevisionId,
      ...(buildConfigurationSnapshotId === undefined ? {} : { buildConfigurationSnapshotId }),
    } as BeginUploadInput;
  }
  const { workItemId, workItemRevisionId, ...rest } = parsed;
  return { ...rest, workItemId, revisionId: workItemRevisionId } as BeginUploadInput;
}

function requireId(value: string, label: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new ApplicationError("validation", `${label} is invalid`);
  return parsed.data;
}

function catalogPort(ports: Pick<ApplicationPorts, "catalog">): NonNullable<ApplicationPorts["catalog"]> {
  if (ports.catalog === undefined) throw new ApplicationError("integrity_error", "This runtime does not support the product catalog");
  return ports.catalog;
}

/**
 * Resolve an intended printer through the owned inventory item and its exact
 * product profile. A bare item kind is not enough ancestry to make a printer
 * assignment trustworthy.
 */
export async function assertOwnedPrinter(ports: Pick<ApplicationPorts, "inventory" | "catalog">, itemId: string): Promise<void> {
  const item = await ports.inventory.getItem(itemId);
  if (item === null) throw notFound("Inventory item", itemId);
  if (item.kind !== "printer") throw new ApplicationError("validation", "The intended printer must be an owned printer inventory item");
  if (item.retiredAt !== undefined) throw new ApplicationError("validation", "The intended printer inventory item is retired");
  if (item.unit !== "each" || item.unitStatus === "needs_correction") {
    throw new ApplicationError("validation", "The intended printer must use a compatible each unit");
  }
  if ((item.evidence.state !== "physically_counted" && item.evidence.state !== "commissioned") || item.quantity <= 0 || item.availableQuantity <= 0) {
    throw new ApplicationError("validation", "The intended printer must have positive available stock with physically counted or commissioned evidence");
  }
  const profile = await catalogPort(ports).getInventoryProductProfile(itemId);
  if (profile === null || profile.itemId !== itemId || profile.profileType !== "printer_asset" || profile.linkState !== "confirmed") {
    throw new ApplicationError("validation", "The intended printer must have an exact printer product profile");
  }
  const product = await catalogPort(ports).getProduct(profile.catalogProductId);
  if (product === null) throw notFound("Catalog product", profile.catalogProductId);
  if (product.kind !== "printer") throw new ApplicationError("validation", "The intended printer profile must point to a printer catalog product");
}

function inventoryCategoryPort(ports: ApplicationPorts): InventoryCategoryPort {
  if (ports.inventoryCategories === undefined) throw new ApplicationError("integrity_error", "This runtime does not support managed inventory categories");
  return ports.inventoryCategories;
}

function buildConfigurationPort(ports: ApplicationPorts): NonNullable<ApplicationPorts["buildConfigurations"]> {
  if (ports.buildConfigurations === undefined) throw new ApplicationError("integrity_error", "This runtime does not support build configuration snapshots");
  return ports.buildConfigurations;
}

function reconciliationPort(ports: ApplicationPorts): NonNullable<ApplicationPorts["reconciliations"]> {
  if (ports.reconciliations === undefined) throw new ApplicationError("integrity_error", "This runtime does not support post-project reconciliation");
  return ports.reconciliations;
}

function workspaceSecurityPort(ports: ApplicationPorts): NonNullable<ApplicationPorts["workspaceSecurity"]> {
  if (ports.workspaceSecurity === undefined) throw new ApplicationError("integrity_error", "This runtime does not support workspace security settings");
  return ports.workspaceSecurity;
}

function boundedLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new ApplicationError("validation", `${label} must be an integer between 1 and 200`);
  }
  return limit;
}

function boundedCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 200 || !/^[A-Za-z0-9._~-]+$/.test(value)) throw new ApplicationError("validation", "cursor is invalid");
  return value;
}

function boundedCategoryCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(value)) throw new ApplicationError("validation", "cursor is invalid");
  return value;
}

function requiredCategoryVersion(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApplicationError("validation", "expectedVersion is required and must be a positive integer");
  }
  return value;
}

function catalogListOptions(query: Partial<CatalogProductListOptions> | undefined): CatalogProductListOptions {
  const q = query?.q;
  if (q !== undefined && (q.length > 200 || q.trim().length === 0)) {
    throw new ApplicationError("validation", "q must be a non-empty search string of at most 200 characters");
  }
  const kind = query?.kind;
  if (kind !== undefined && kind !== "filament" && kind !== "printer") {
    throw new ApplicationError("validation", "kind must be filament or printer");
  }
  const cursor = boundedCursor(query?.cursor);
  return {
    ...(q === undefined ? {} : { q: q.trim() }),
    ...(kind === undefined ? {} : { kind }),
    limit: boundedLimit(query?.limit, 50, "limit"),
    ...(cursor === undefined ? {} : { cursor })
  };
}

function configurationListOptions(query: Partial<BuildConfigurationListOptions> | undefined): BuildConfigurationListOptions {
  const cursor = boundedCursor(query?.cursor);
  return {
    limit: boundedLimit(query?.limit, 50, "limit"),
    ...(cursor === undefined ? {} : { cursor })
  };
}

function categoryListOptions(query: Partial<InventoryCategoryListOptions> | undefined): InventoryCategoryListOptions {
  const includeArchived = query?.includeArchived ?? false;
  if (typeof includeArchived !== "boolean") throw new ApplicationError("validation", "includeArchived must be a boolean");
  const cursor = boundedCategoryCursor(query?.cursor);
  return {
    includeArchived,
    limit: boundedLimit(query?.limit, 50, "limit"),
    ...(cursor === undefined ? {} : { cursor })
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function snapshotHash(snapshot: Omit<BuildConfigurationSnapshot, "contentSha256">): string {
  const {
    id: _id,
    createdAt: _createdAt,
    projectRevisionId: _projectRevisionId,
    contentSha256: _contentSha256,
    supersedesSnapshotId: _supersedesSnapshotId,
    capturedAt: _capturedAt,
    createdBy: _createdBy,
    ...content
  } = snapshot as Partial<BuildConfigurationSnapshot>;
  return createHash("sha256").update(JSON.stringify(canonicalize(content))).digest("hex");
}

type SnapshotSelection = BuildConfigurationSnapshot["filamentSelections"][number];

function productForSnapshot(product: CatalogProduct, item: InventoryItem, profile: InventoryProductProfile | null): Record<string, unknown> {
  if (product.kind === "printer") {
    return {
      itemId: item.id,
      catalogProductId: product.id,
      ...(profile === null ? { linkState: "reported" as const } : { profileId: profile.id, linkState: profile.linkState }),
      name: item.name,
      manufacturer: product.manufacturer,
      exactModel: product.exactModel,
      ...(product.exactVariant === undefined ? {} : { exactVariant: product.exactVariant }),
      technology: product.technology,
      buildVolumeMm: product.buildVolumeMm
    };
  }
  return {
    itemId: item.id,
    catalogProductId: product.id,
    ...(profile === null ? { linkState: "reported" as const } : { profileId: profile.id, linkState: profile.linkState }),
    ...(product.productName === undefined ? {} : { name: product.productName }),
    manufacturer: product.manufacturer,
    ...(product.sku === undefined ? {} : { sku: product.sku }),
    ...(product.materialFamily === undefined ? {} : { materialFamily: product.materialFamily }),
    ...(product.materialSubtype === undefined ? {} : { materialSubtype: product.materialSubtype }),
    colourName: product.colourName,
    ...(product.colourCode === undefined ? {} : { colourCode: product.colourCode }),
    ...(profile?.profileType === "filament_spool" && profile.details.lot === undefined ? {} : profile?.profileType === "filament_spool" ? { lot: profile.details.lot } : {}),
    ...(profile?.profileType === "filament_spool" && profile.details.batch === undefined ? {} : profile?.profileType === "filament_spool" ? { batch: profile.details.batch } : {}),
    diameterMm: product.diameterMm,
    nominalNetMassG: product.nominalNetMassG,
    ...(product.nominalLengthM === undefined ? {} : { nominalLengthM: product.nominalLengthM }),
    lengthBasis: product.lengthBasis,
    ...(product.densityGcm3 === undefined ? {} : { densityGcm3: product.densityGcm3 })
  };
}

async function linkedProfile(
  catalog: NonNullable<ApplicationPorts["catalog"]>,
  itemId: string,
  expectedProfileId: string | undefined,
  productId: string,
  kind: "filament" | "printer",
  unknowns: string[]
): Promise<InventoryProductProfile | null> {
  const profile = await catalog.getInventoryProductProfile(itemId);
  if (expectedProfileId !== undefined && profile === null) throw notFound("Inventory product profile", expectedProfileId);
  if (expectedProfileId !== undefined && profile?.id !== expectedProfileId) {
    throw new ApplicationError("validation", `Profile '${expectedProfileId}' is not linked to inventory item '${itemId}'`);
  }
  if (profile === null) {
    unknowns.push(`No ${kind} product profile is recorded for inventory item '${itemId}'`);
    return null;
  }
  if (profile.itemId !== itemId || profile.catalogProductId !== productId) {
    throw new ApplicationError("validation", `Product profile '${profile.id}' does not match the selected product or inventory item`);
  }
  if (profile.profileType !== (kind === "filament" ? "filament_spool" : "printer_asset")) {
    throw new ApplicationError("validation", `Product profile '${profile.id}' has the wrong profile type`);
  }
  if (profile.linkState !== "confirmed") {
    unknowns.push(`Product profile '${profile.id}' has non-confirmed link state '${profile.linkState}'`);
  }
  return profile;
}

export class ApplicationService {
  constructor(private readonly ports: ApplicationPorts, private readonly version = "0.1.0") {}

  getVersion(): string {
    return this.version;
  }

  /** Report whether this runtime can provide revision-scoped reconciliation. */
  supportsReconciliation(): boolean {
    return this.ports.reconciliations !== undefined;
  }

  /** Return only the safe workspace-access projection. */
  async getWorkspaceSecurityStatus(): Promise<import("@benchledger/api-contract").WorkspaceSecurityStatus> {
    return this.ports.unitOfWork.exclusive(async () => workspaceSecurityStatusSchema.parse(await workspaceSecurityPort(this.ports).getStatus()));
  }

  /** Verify a password at the storage boundary without exposing its hash. */
  async verifyWorkspacePassword(password: string): Promise<boolean> {
    if (typeof password !== "string" || password.length === 0) return false;
    return this.ports.unitOfWork.exclusive(() => workspaceSecurityPort(this.ports).verifyPassword(password));
  }

  /** Hashing happens in the runtime after idempotency lookup. */
  async enableWorkspacePassword(newPassword: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    const commandContext = workspaceSecurityCommandContext(ctx);
    return this.mutate(commandContext, "password_enabled", "workspace_security", WORKSPACE_SECURITY_ENTITY_ID, async () => {
      if (typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 512) {
        throw new ApplicationError("validation", "New password must contain between 12 and 512 characters");
      }
      const status = workspaceSecurityStatusSchema.parse(await workspaceSecurityPort(this.ports).enablePassword(newPassword, expectedVersion));
      return { value: status, entityId: WORKSPACE_SECURITY_ENTITY_ID, version: status.version, eventMetadata: { mode: status.mode } };
    });
  }

  async disableWorkspacePassword(currentPassword: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    const commandContext = workspaceSecurityCommandContext(ctx);
    return this.mutate(commandContext, "password_disabled", "workspace_security", WORKSPACE_SECURITY_ENTITY_ID, async () => {
      if (typeof currentPassword !== "string" || currentPassword.length < 12 || currentPassword.length > 512) {
        throw new ApplicationError("validation", "Current password must contain between 12 and 512 characters");
      }
      const status = workspaceSecurityStatusSchema.parse(await workspaceSecurityPort(this.ports).disablePassword(currentPassword, expectedVersion));
      return { value: status, entityId: WORKSPACE_SECURITY_ENTITY_ID, version: status.version, eventMetadata: { mode: status.mode } };
    });
  }

  /** Change the password at the trusted verification boundary. */
  async changeWorkspacePassword(input: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    const commandContext = workspaceSecurityCommandContext(ctx);
    return this.mutate(commandContext, "password_changed", "workspace_security", WORKSPACE_SECURITY_ENTITY_ID, async () => {
      if (typeof input.currentPassword !== "string" || input.currentPassword.length < 12 || input.currentPassword.length > 512 || typeof input.newPassword !== "string" || input.newPassword.length < 12 || input.newPassword.length > 512) {
        throw new ApplicationError("validation", "Current and new passwords must contain between 12 and 512 characters");
      }
      const status = workspaceSecurityStatusSchema.parse(await workspaceSecurityPort(this.ports).changePassword(input, expectedVersion));
      return { value: status, entityId: WORKSPACE_SECURITY_ENTITY_ID, version: status.version, eventMetadata: { mode: status.mode } };
    });
  }

  /** Canonical public operation dispatcher shared by REST, UI, and agents. */
  async updateWorkspaceSecurity(input: WorkspaceSecurityMutation, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    const parsed = workspaceSecurityMutationSchema.parse(input) as WorkspaceSecurityMutation;
    if (parsed.operation === "enable") return this.enableWorkspacePassword(parsed.newPassword, parsed.expectedVersion, ctx);
    if (parsed.operation === "disable") return this.disableWorkspacePassword(parsed.currentPassword, parsed.expectedVersion, ctx);
    return this.changeWorkspacePassword({ currentPassword: parsed.currentPassword, newPassword: parsed.newPassword }, parsed.expectedVersion, ctx);
  }

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

  async listCatalogProducts(query: Partial<CatalogProductListOptions> = {}): Promise<Page<CatalogProduct>> {
    const options = catalogListOptions(query);
    return this.ports.unitOfWork.exclusive(() => catalogPort(this.ports).listProducts(options));
  }

  async getCatalogProduct(id: string): Promise<CatalogProduct> {
    const productId = requireId(id, "catalog product id");
    return this.ports.unitOfWork.exclusive(async () => {
      const product = await catalogPort(this.ports).getProduct(productId);
      if (product === null) throw notFound("Catalog product", productId);
      return catalogProductSchema.parse(product);
    });
  }

  async createCatalogProduct(input: CreateCatalogProduct, ctx: RequestContext): Promise<Mutation<CatalogProduct>> {
    const parsed = createCatalogProductSchema.parse(input);
    return this.mutate(ctx, "catalog.product.create", "catalog_product", "pending", async () => {
      const product = catalogProductSchema.parse(await catalogPort(this.ports).createProduct(parsed, ctx));
      return { value: product, entityId: product.id, version: product.version };
    });
  }

  async updateCatalogProduct(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<CatalogProduct>> {
    const productId = requireId(id, "catalog product id");
    const parsed = updateCatalogProductSchema.parse(input) as UpdateCatalogProduct;
    return this.mutate(ctx, "catalog.product.update", "catalog_product", productId, async () => {
      const product = catalogProductSchema.parse(await catalogPort(this.ports).updateProduct(productId, parsed, expectedVersion, ctx));
      return { value: product, entityId: product.id, version: product.version };
    });
  }

  async getInventoryProductProfile(itemId: string): Promise<InventoryProductProfile> {
    const parsedItemId = requireId(itemId, "inventory item id");
    return this.ports.unitOfWork.exclusive(async () => {
      const profile = await catalogPort(this.ports).getInventoryProductProfile(parsedItemId);
      if (profile === null) throw notFound("Inventory product profile", parsedItemId);
      return inventoryProductProfileSchema.parse(profile);
    });
  }

  async putInventoryProductProfile(itemId: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<InventoryProductProfile>> {
    const parsedItemId = requireId(itemId, "inventory item id");
    const current = await this.ports.unitOfWork.exclusive(() => catalogPort(this.ports).getInventoryProductProfile(parsedItemId));
    const inventoryItem = await this.ports.inventory.getItem(parsedItemId);
    if (inventoryItem === null) throw notFound("Inventory item", parsedItemId);
    if (inventoryItem.kind !== "printer" && inventoryItem.kind !== "filament") {
      throw new ApplicationError("validation", "Only printer and filament inventory items can have product profiles");
    }
    const raw = input !== null && typeof input === "object" ? { ...(input as Record<string, unknown>), itemId: parsedItemId } : input;
    const parsed = current === null
      ? createInventoryProductProfileSchema.parse(raw)
      : updateInventoryProductProfileSchema.parse(raw);
    const profileProductId = "catalogProductId" in parsed && parsed.catalogProductId !== undefined
      ? parsed.catalogProductId
      : current?.catalogProductId;
    if (profileProductId === undefined) throw new ApplicationError("validation", "catalogProductId is required");
    const product = await catalogPort(this.ports).getProduct(profileProductId);
    if (product === null) throw notFound("Catalog product", profileProductId);
    if (product.kind !== inventoryItem.kind) {
      throw new ApplicationError("validation", `Catalog product kind '${product.kind}' does not match inventory item kind '${inventoryItem.kind}'`);
    }
    if ("itemId" in parsed && parsed.itemId !== undefined && parsed.itemId !== parsedItemId) {
      throw new ApplicationError("validation", "Profile itemId must match the inventory path");
    }
    if (current !== null && "profileType" in parsed && parsed.profileType !== undefined && parsed.profileType !== current.profileType) {
      throw new ApplicationError("validation", "Profile type cannot change after creation");
    }
    const normalized = {
      ...parsed,
      itemId: parsedItemId,
      catalogProductId: profileProductId,
      profileType: "profileType" in parsed && parsed.profileType !== undefined
        ? parsed.profileType
        : current?.profileType ?? (inventoryItem.kind === "filament" ? "filament_spool" : "printer_asset")
    } as CreateInventoryProductProfile | UpdateInventoryProductProfile;
    return this.mutate(ctx, "inventory.product_profile.put", "inventory_product_profile", current?.id ?? parsedItemId, async () => {
      const profile = inventoryProductProfileSchema.parse(await catalogPort(this.ports).putInventoryProductProfile(parsedItemId, normalized, expectedVersion, ctx));
      return { value: profile, entityId: profile.id, version: profile.version };
    });
  }

  async listBuildConfigurations(revisionId: string, query: Partial<BuildConfigurationListOptions> = {}): Promise<Page<BuildConfigurationSnapshot>> {
    const parsedRevisionId = requireId(revisionId, "project revision id");
    const options = configurationListOptions(query);
    await this.getProjectRevision(parsedRevisionId);
    return this.ports.unitOfWork.exclusive(() => buildConfigurationPort(this.ports).listBuildConfigurations(parsedRevisionId, options));
  }

  async getLatestBuildConfiguration(revisionId: string): Promise<BuildConfigurationSnapshot | null> {
    const parsedRevisionId = requireId(revisionId, "project revision id");
    await this.getProjectRevision(parsedRevisionId);
    return this.ports.unitOfWork.exclusive(async () => {
      const configuration = await buildConfigurationPort(this.ports).getLatestBuildConfiguration(parsedRevisionId);
      return configuration === null ? null : buildConfigurationSnapshotSchema.parse(configuration);
    });
  }

  async getBuildConfiguration(id: string): Promise<BuildConfigurationSnapshot> {
    const configurationId = requireId(id, "build configuration id");
    return this.ports.unitOfWork.exclusive(async () => {
      const configuration = await buildConfigurationPort(this.ports).getBuildConfiguration(configurationId);
      if (configuration === null) throw notFound("Build configuration", configurationId);
      await this.assertProjectReadableFromRevision(configuration.projectRevisionId);
      return buildConfigurationSnapshotSchema.parse(configuration);
    });
  }

  async createBuildConfiguration(revisionId: string, input: unknown, ctx: RequestContext): Promise<Mutation<BuildConfigurationSnapshot>> {
    const parsedRevisionId = requireId(revisionId, "project revision id");
    const revision = await this.getProjectRevision(parsedRevisionId);
    // Keep legacy revision-only adapters readable while still closing the
    // mutation boundary for archived projects in authoritative runtimes.
    const revisionProject = await this.ports.projects.getProject(revision.projectId);
    if (revisionProject?.status === "archived") {
      throw conflict(`Project '${revisionProject.id}' is archived; restore it before creating or committing work`);
    }
    if (input === null || typeof input !== "object") throw new ApplicationError("validation", "Build configuration body must be an object");
    const raw = input as Record<string, unknown>;
    if (raw.projectRevisionId !== undefined && raw.projectRevisionId !== parsedRevisionId) {
      throw new ApplicationError("validation", "projectRevisionId must match the revision path");
    }
    const supplied: Record<string, unknown> = { ...raw, projectRevisionId: parsedRevisionId };
    delete supplied.contentSha256;
    delete supplied.createdAt;
    const parsed = createBuildConfigurationSnapshotSchema.parse(supplied);
    const unknowns = [...parsed.explicitUnknowns];
    const hasPhysicalOnlyFilament = parsed.filamentSelections.some((selection) => "catalogIdentityState" in selection);
    if (hasPhysicalOnlyFilament && revision.status === "production approved") {
      throw conflict("A production-approved revision cannot use a filament with unknown catalog identity");
    }
    const catalog = catalogPort(this.ports);
    const printerItem = await this.ports.inventory.getItem(parsed.printerItemSnapshot.itemId);
    if (printerItem === null) throw notFound("Inventory item", parsed.printerItemSnapshot.itemId);
    if (printerItem.kind !== "printer") throw new ApplicationError("validation", "Build configurations require a printer inventory item");
    assertCompatibleInventoryUnit(printerItem, "Cannot use printer in build configuration");
    const printerProduct = await catalog.getProduct(parsed.printerItemSnapshot.catalogProductId);
    if (printerProduct === null) throw notFound("Catalog product", parsed.printerItemSnapshot.catalogProductId);
    if (printerProduct.kind !== "printer") throw new ApplicationError("validation", "Printer inventory item must link to a printer catalog product");
    const printerProfile = await linkedProfile(catalog, printerItem.id, parsed.printerItemSnapshot.profileId, printerProduct.id, "printer", unknowns);
    const printerItemSnapshot = productForSnapshot(printerProduct, printerItem, printerProfile) as BuildConfigurationSnapshot["printerItemSnapshot"];

    const filamentSelections: SnapshotSelection[] = [];
    for (const selection of parsed.filamentSelections) {
      const item = await this.ports.inventory.getItem(selection.itemId);
      if (item === null) throw notFound("Inventory item", selection.itemId);
      if (item.kind !== "filament") throw new ApplicationError("validation", `Inventory item '${item.id}' is not a filament`);
      assertCompatibleInventoryUnit(item, "Cannot use filament in build configuration");
      if ("catalogIdentityState" in selection) {
        if (item.retiredAt !== undefined) {
          throw new ApplicationError("validation", `Inventory item '${item.id}' is retired and cannot be selected as a physical filament`);
        }
        if (!CONFIRMED_EVIDENCE.has(item.evidence.state)) {
          throw new ApplicationError("validation", `Inventory item '${item.id}' requires physically_counted or commissioned evidence before an unlinked filament can be selected`);
        }
        filamentSelections.push({
          itemId: item.id,
          catalogIdentityState: "unknown",
          physicalLabel: item.name,
          physicalEvidence: { ...item.evidence },
          ...(selection.role === undefined ? {} : { role: selection.role }),
          ...(selection.quantity === undefined ? {} : { quantity: selection.quantity }),
        });
        unknowns.push(FILAMENT_CATALOG_IDENTITY_UNKNOWN);
        continue;
      }
      const product = await catalog.getProduct(selection.catalogProductId);
      if (product === null) throw notFound("Catalog product", selection.catalogProductId);
      if (product.kind !== "filament") throw new ApplicationError("validation", `Catalog product '${product.id}' is not a filament`);
      const profile = await linkedProfile(catalog, item.id, selection.profileId, product.id, "filament", unknowns);
      filamentSelections.push({
        ...productForSnapshot(product, item, profile),
        ...(selection.role === undefined ? {} : { role: selection.role }),
        ...(selection.quantity === undefined ? {} : { quantity: selection.quantity }),
      } as SnapshotSelection);
    }

    const snapshotWithoutHash = {
      id: parsed.id ?? `build-config-${randomUUID()}`,
      projectRevisionId: revision.id,
      printerItemSnapshot,
      filamentSelections,
      activeHotend: parsed.activeHotend,
      nozzle: parsed.nozzle,
      plate: parsed.plate,
      accessories: parsed.accessories,
      firmware: parsed.firmware,
      slicer: parsed.slicer,
      profile: parsed.profile,
      calibration: parsed.calibration,
      explicitUnknowns: [...new Set(unknowns)].sort(),
      ...(parsed.supersedesSnapshotId === undefined ? {} : { supersedesSnapshotId: parsed.supersedesSnapshotId }),
      createdAt: nowIso()
    } satisfies Omit<BuildConfigurationSnapshot, "contentSha256">;
    if (snapshotWithoutHash.supersedesSnapshotId !== undefined) {
      const prior = await buildConfigurationPort(this.ports).getBuildConfiguration(snapshotWithoutHash.supersedesSnapshotId);
      if (prior === null) throw notFound("Build configuration", snapshotWithoutHash.supersedesSnapshotId);
      if (prior.projectRevisionId !== revision.id) throw new ApplicationError("validation", "A superseded snapshot must belong to the same project revision");
    }
    const snapshot = buildConfigurationSnapshotSchema.parse({ ...snapshotWithoutHash, contentSha256: snapshotHash(snapshotWithoutHash) });
    return this.mutate(ctx, "project.build_configuration.create", "build_configuration_snapshot", snapshot.id, async () => {
      const created = buildConfigurationSnapshotSchema.parse(await buildConfigurationPort(this.ports).createBuildConfiguration(snapshot, ctx));
      return { value: created, entityId: created.id };
    });
  }

  async listInventory(query: InventoryListQuery): Promise<Page<InventoryItem>> {
    const parsed = inventoryListQuerySchema.parse(query) as InventoryListOptions;
    parseInventoryCursor(parsed.cursor);
    return this.ports.unitOfWork.exclusive(async () => {
      const page = await this.ports.inventory.listItems(parsed);
      return { ...page, data: page.data.map(inventoryWithUnitStatus) };
    });
  }

  async getInventoryItem(id: string): Promise<InventoryItem> {
    return this.ports.unitOfWork.exclusive(async () => {
      const item = await this.ports.inventory.getItem(requireId(id, "item id"));
      if (!item) throw notFound("Inventory item", id);
      return inventoryWithUnitStatus(item);
    });
  }

  async listInventoryCategories(query: Partial<InventoryCategoryListOptions> = {}): Promise<Page<InventoryCategory>> {
    const options = categoryListOptions(query);
    return this.ports.unitOfWork.exclusive(() => inventoryCategoryPort(this.ports).listCategories(options));
  }

  async getInventoryCategory(id: string): Promise<InventoryCategory> {
    const categoryId = requireId(id, "inventory category id");
    return this.ports.unitOfWork.exclusive(async () => {
      const category = await inventoryCategoryPort(this.ports).getCategory(categoryId);
      if (category === null) throw notFound("Inventory category", categoryId);
      return category;
    });
  }

  async createInventoryCategory(input: CreateInventoryCategory, ctx: RequestContext): Promise<Mutation<InventoryCategory>> {
    const parsed = createInventoryCategorySchema.parse(input);
    const commandCtx = commandContext(ctx, "inventory.category.create", parsed);
    return this.mutate(commandCtx, "inventory.category.create", "inventory_category", parsed.id ?? "pending", async () => {
      const category = await inventoryCategoryPort(this.ports).createCategory(parsed, commandCtx);
      return { value: category, entityId: category.id, version: category.version };
    });
  }

  async updateInventoryCategory(id: string, input: unknown, expectedVersion: number, ctx: RequestContext): Promise<Mutation<InventoryCategory>> {
    const categoryId = requireId(id, "inventory category id");
    const parsed = updateInventoryCategorySchema.parse(input) as UpdateInventoryCategory;
    const requiredVersion = requiredCategoryVersion(expectedVersion);
    const commandCtx = commandContext(ctx, "inventory.category.update", { categoryId, input: parsed, expectedVersion: requiredVersion });
    return this.mutate(commandCtx, "inventory.category.update", "inventory_category", categoryId, async () => {
      const category = await inventoryCategoryPort(this.ports).updateCategory(categoryId, parsed, requiredVersion, commandCtx);
      return { value: category, entityId: category.id, version: category.version };
    });
  }

  async archiveInventoryCategory(id: string, expectedVersion: number, ctx: RequestContext): Promise<Mutation<InventoryCategory>> {
    const categoryId = requireId(id, "inventory category id");
    const requiredVersion = requiredCategoryVersion(expectedVersion);
    const commandCtx = commandContext(ctx, "inventory.category.archive", { categoryId, expectedVersion: requiredVersion });
    return this.mutate(commandCtx, "inventory.category.archive", "inventory_category", categoryId, async () => {
      const category = await inventoryCategoryPort(this.ports).archiveCategory(categoryId, requiredVersion, commandCtx);
      return { value: category, entityId: category.id, version: category.version };
    });
  }

  private async validateInventoryCategoryReferences(categoryNodeId: string | null | undefined): Promise<void> {
    if (categoryNodeId === undefined || categoryNodeId === null) return;
    const categories = inventoryCategoryPort(this.ports);
    const category = await categories.getCategory(categoryNodeId);
    if (category === null) throw notFound("Inventory category", categoryNodeId);
    if (category.archived) throw new ApplicationError("validation", "archived categories cannot be assigned to inventory");
  }

  async createInventoryItem(input: CreateInventoryItem, ctx: RequestContext): Promise<Mutation<InventoryItem>> {
    const parsed = createInventoryItemSchema.parse(input);
    return this.mutate(ctx, "inventory.item.create", "inventory_item", parsed.id ?? "pending", async () => {
      await this.validateInventoryCategoryReferences(parsed.categoryNodeId);
      const item = await this.ports.inventory.createItem(parsed, ctx);
      const value = inventoryWithUnitStatus(item);
      return { value, entityId: value.id, version: value.version };
    });
  }

  /**
   * Create an exact inventory item and its physical product profile as one
   * audited command. The profile is deliberately reference-only at the
   * boundary; its itemId is injected only after the inventory adapter returns
   * the durable item identity. Adapters provide narrowly-scoped compensation
   * hooks so a non-transactional boundary cannot leave an orphan item when
   * the profile write fails.
   */
  async createInventoryWithProductProfile(input: unknown, ctx: RequestContext): Promise<Mutation<{ readonly item: InventoryItem; readonly profile: InventoryProductProfile }>> {
    const parsed = createInventoryWithProductProfileSchema.parse(input);
    const parsedItem = parsed.item;
    const parsedProfile = parsed.profile;
    const expectedProfileKind = parsedProfile.profileType === "filament_spool" ? "filament" : "printer";
    if (parsedItem.kind !== expectedProfileKind) {
      throw new ApplicationError("validation", `Profile type '${parsedProfile.profileType}' does not match inventory item kind '${parsedItem.kind}'`);
    }
    const catalog = catalogPort(this.ports);
    const product = await catalog.getProduct(parsedProfile.catalogProductId);
    if (product === null) throw notFound("Catalog product", parsedProfile.catalogProductId);
    if (product.kind !== parsedItem.kind) {
      throw new ApplicationError("validation", `Catalog product kind '${product.kind}' does not match inventory item kind '${parsedItem.kind}'`);
    }
    if (this.ports.inventory.rollbackCreatedItem === undefined || catalog.rollbackCreatedProfile === undefined) {
      throw new ApplicationError("integrity_error", "The inventory/profile adapters cannot compensate a failed compound create");
    }

    // A direct application caller may omit a fingerprint; derive one from the
    // parsed, canonical command so idempotency-key reuse remains safe.
    const commandContext = ctx.fingerprint === undefined
      ? { ...ctx, fingerprint: createHash("sha256").update(JSON.stringify({ item: parsedItem, profile: parsedProfile })).digest("hex") }
      : ctx;
    return this.mutate(commandContext, "inventory.item_with_product_profile.create", "inventory_item", parsedItem.id ?? "pending", async () => {
      await this.validateInventoryCategoryReferences(parsedItem.categoryNodeId);
      let createdItem: InventoryItem | undefined;
      let createdProfile: InventoryProductProfile | undefined;
      const compensate = async (): Promise<void> => {
        if (createdProfile !== undefined) await catalog.rollbackCreatedProfile!(createdProfile.id, createdProfile.itemId);
        if (createdItem !== undefined) await this.ports.inventory.rollbackCreatedItem!(createdItem.id);
      };
      try {
        createdItem = await this.ports.inventory.createItem(parsedItem, commandContext);
        const profile = await catalog.putInventoryProductProfile(createdItem.id, { ...parsedProfile, itemId: createdItem.id }, undefined, commandContext);
        createdProfile = inventoryProductProfileSchema.parse(profile);
        return {
          value: { item: inventoryItemSchema.parse(inventoryWithUnitStatus(createdItem)), profile: createdProfile },
          entityId: createdItem.id,
          version: createdItem.version,
          compensate
        };
      } catch (error: unknown) {
        try {
          await compensate();
        } catch {
          throw new ApplicationError("integrity_error", "The compound inventory/profile create failed and could not be compensated");
        }
        throw error;
      }
    });
  }

  async updateInventoryItem(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<InventoryItem>> {
    const itemId = requireId(id, "item id");
    const parsed = updateInventoryItemSchema.parse(input) as UpdateInventoryInput;
    return this.mutate(ctx, "inventory.item.update", "inventory_item", itemId, async () => {
      await this.validateInventoryCategoryReferences(parsed.categoryNodeId);
      if (parsed.kind !== undefined) {
        const current = await this.ports.inventory.getItem(itemId);
        if (!current) throw notFound("Inventory item", itemId);
        if (parsed.kind !== current.kind) {
          throw new ApplicationError("validation", "Cannot change inventory kind in place. Create a corrected replacement so reservations, evidence, and history stay attached to the original item");
        }
      }
      const item = await this.ports.inventory.updateItem(itemId, parsed, expectedVersion, ctx);
      const value = inventoryWithUnitStatus(item);
      return { value, entityId: value.id, version: value.version };
    });
  }

  async bulkUpdateInventoryItems(input: unknown, ctx: RequestContext): Promise<BulkMutation<InventoryBulkUpdateResult>> {
    if (ctx.idempotencyKey === undefined) throw new ApplicationError("validation", "Bulk inventory updates require an idempotency key");
    const parsed = inventoryBulkUpdateSchema.parse(input) as InventoryBulkUpdate;
    const execution: InventoryBulkUpdate = {
      targets: [...parsed.targets].sort((left, right) => left.itemId.localeCompare(right.itemId)),
      changes: normalizeInventoryBulkChanges(parsed.changes),
    };
    const canonical = canonicalInventoryBulkUpdate(execution);
    // Bulk retries must hash the parsed canonical command rather than a raw
    // transport body. This keeps whitespace, tag order/duplicates, and target
    // order from changing the meaning of one actor-scoped idempotency key.
    const commandContext = { ...ctx, fingerprint: inventoryBulkUpdateFingerprint(canonical) };
    return this.mutateBulk(commandContext, async () => {
      const result = await this.ports.inventory.bulkUpdateItems(execution, commandContext);
      const updated = result.updated.map((item) => inventoryWithUnitStatus(inventoryItemSchema.parse(item))).sort((left, right) => left.id.localeCompare(right.id));
      const unchanged = result.unchanged.map((item) => inventoryWithUnitStatus(inventoryItemSchema.parse(item))).sort((left, right) => left.id.localeCompare(right.id));
      const targetIds = new Set(execution.targets.map((target) => target.itemId));
      const resultIds = [...updated, ...unchanged].map((item) => item.id);
      const resultIdSet = new Set(resultIds);
      if (resultIds.length !== resultIdSet.size || resultIdSet.size !== targetIds.size || resultIds.some((itemId) => !targetIds.has(itemId))) {
        throw new ApplicationError("integrity_error", "Bulk inventory results must contain each requested item exactly once");
      }
      return { updated, unchanged };
    });
  }

  async recordStockEvent(input: StockEventInput, ctx: RequestContext): Promise<Mutation<StockMutation>> {
    const parsed = stockEventInputSchema.parse(input);
    if (parsed.type === "count") return this.recordPhysicalCount(parsed.itemId, parsed.quantity, ctx, parsed.unit, parsed.note);
    return this.mutate(ctx, `inventory.stock.${parsed.type}`, "inventory_item", parsed.itemId, async () => {
      const current = await this.ports.inventory.getItem(parsed.itemId);
      if (!current) throw notFound("Inventory item", parsed.itemId);
      assertCompatibleInventoryUnit(current, `Cannot record ${parsed.type}`);
      const mutation = await this.ports.inventory.recordStockEvent(parsed, ctx);
      return { value: { ...mutation, item: inventoryWithUnitStatus(mutation.item) }, entityId: mutation.item.id, version: mutation.item.version };
    });
  }

  async recordPhysicalCount(itemId: string, quantity: number, ctx: RequestContext, unit?: InventoryItem["unit"], note?: string): Promise<Mutation<StockMutation>> {
    const parsedId = requireId(itemId, "item id");
    if (!Number.isFinite(quantity) || quantity < 0) throw new ApplicationError("validation", "Physical count must be zero or greater");
    return this.mutate(ctx, "inventory.stock.count", "inventory_item", parsedId, async () => {
      const current = await this.ports.inventory.getItem(parsedId);
      if (!current) throw notFound("Inventory item", parsedId);
      assertCompatibleInventoryUnit(current, "Cannot record a physical count");
      if (unit !== undefined && unit !== current.unit) throw new ApplicationError("validation", `Unit mismatch: item uses ${current.unit}, count uses ${unit}`);
      const value = this.ports.inventory.recordPhysicalCount
        ? await this.ports.inventory.recordPhysicalCount(parsedId, quantity, ctx, note)
        : await this.recordPhysicalCountFallback(parsedId, quantity, ctx, note);
      return { value: { ...value, item: inventoryWithUnitStatus(value.item) }, entityId: value.item.id, version: value.item.version };
    });
  }

  /**
   * Promote uncertain delivery/order evidence only through a counted,
   * provenance-bearing ledger command. Generic metadata PATCHes cannot change
   * evidence, so this operation preserves both the new commissioning evidence
   * and the prior evidence in the append-only stock event.
   */
  async commissionInventoryItem(itemId: string, input: CommissionInventoryItem, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<StockMutation>> {
    const parsedId = requireId(itemId, "item id");
    const parsed = commissionInventoryItemSchema.parse(input);
    const commandCtx = commandContext(ctx, "inventory.item.commission", { itemId: parsedId, expectedVersion, input: parsed });
    return this.mutate(commandCtx, "inventory.item.commission", "inventory_item", parsedId, async () => {
      const current = await this.ports.inventory.getItem(parsedId);
      if (!current) throw notFound("Inventory item", parsedId);
      assertCompatibleInventoryUnit(current, "Cannot commission inventory");
      if (!COMMISSIONABLE_EVIDENCE.has(current.evidence.state)) {
        throw conflict("Only delivered or ordered inventory can be commissioned; record a physical count for other evidence states");
      }
      if (this.ports.inventory.commissionItem === undefined) {
        throw new ApplicationError("integrity_error", "This runtime does not support inventory commissioning");
      }
      const mutation = await this.ports.inventory.commissionItem(parsedId, parsed, expectedVersion, commandCtx);
      return { value: { ...mutation, item: inventoryWithUnitStatus(mutation.item) }, entityId: mutation.item.id, version: mutation.item.version };
    });
  }

  private async recordPhysicalCountFallback(itemId: string, quantity: number, ctx: RequestContext, note?: string): Promise<StockMutation> {
    const current = await this.ports.inventory.getItem(itemId);
    if (!current) throw notFound("Inventory item", itemId);
    const stock = await this.ports.inventory.recordStockEvent({ itemId, type: "count", quantity, unit: current.unit, ...(note === undefined ? {} : { note }) }, ctx);
    const updated = await this.ports.inventory.updateItem(itemId, { quantity, evidence: { ...current.evidence, state: "physically_counted", observedAt: nowIso() } }, stock.item.version, ctx);
    return { event: stock.event, item: updated };
  }

  async listStockEvents(itemId: string, limit = 50, cursor?: string) {
    return this.ports.unitOfWork.exclusive(() => this.ports.inventory.listStockEvents(requireId(itemId, "item id"), Math.min(Math.max(limit, 1), 200), cursor));
  }

  async listProjects(query: ProjectListOptions): Promise<Page<Project>> {
    return this.ports.unitOfWork.exclusive(() => this.ports.projects.listProjects(query));
  }

  async getProject(id: string): Promise<Project> {
    return this.ports.unitOfWork.exclusive(async () => {
      const project = await this.ports.projects.getProject(requireId(id, "project id"));
      if (!project) throw notFound("Project", id);
      if (project.removedAt !== undefined) {
        throw projectRemoved(project.id, { removedAt: project.removedAt, removedBy: project.removedBy, lastLifecycleStatus: project.lastLifecycleStatus });
      }
      return project;
    });
  }

  /** Return retained tombstones without making them ordinary project records. */
  async listRemovedProjects(): Promise<readonly ProjectTombstone[]> {
    return this.ports.unitOfWork.exclusive(async () => {
      const list = this.ports.projects.listRemovedProjects;
      if (list === undefined) throw new ApplicationError("integrity_error", "This runtime does not support removed-project history");
      return list.call(this.ports.projects);
    });
  }

  /** Return a bounded page of retained tombstones. Normal project scope is
   * rejected by the transport boundary before this workspace-global command
   * is dispatched. */
  async listRemovedProjectPage(limit = 50, cursor?: string): Promise<Page<ProjectTombstone>> {
    const bounded = boundedLimit(limit, 50, "limit");
    const boundedPageCursor = boundedCursor(cursor);
    return this.ports.unitOfWork.exclusive(async () => {
      const listPage = this.ports.projects.listRemovedProjectsPage;
      if (listPage !== undefined) return listPage.call(this.ports.projects, bounded, boundedPageCursor);
      const list = this.ports.projects.listRemovedProjects;
      if (list === undefined) throw new ApplicationError("integrity_error", "This runtime does not support removed-project history");
      const data = (await list.call(this.ports.projects)).slice(0, bounded);
      return { data, limit: bounded };
    });
  }

  /** Read append-only project history after verifying the project is removed. */
  async readRemovedProjectHistory(id: string, limit = 50, cursor?: string): Promise<Page<AuditEvent>> {
    const projectId = requireId(id, "project id");
    const bounded = boundedLimit(limit, 50, "limit");
    const boundedPageCursor = boundedCursor(cursor);
    return this.ports.unitOfWork.exclusive(async () => {
      const project = await this.ports.projects.getProject(projectId);
      if (project === null) throw notFound("Project", projectId);
      if (project.removedAt === undefined) throw conflict(`Project '${projectId}' has not been removed`);
      if (this.ports.audit.listEntity !== undefined) {
        return this.ports.audit.listEntity("project", projectId, bounded, boundedPageCursor);
      }
      const all = await this.ports.audit.list(200, boundedPageCursor);
      const data = all.data.filter((event) => event.entityType === "project" && event.entityId === projectId).slice(0, bounded);
      return { data, limit: bounded };
    });
  }

  /** Irreversible removal. The runtime port owns the atomic tombstone/release transaction. */
  async removeProject(id: string, expectedVersion: number | undefined, confirmationName: string, ctx: RequestContext): Promise<Mutation<ProjectTombstone>> {
    const projectId = requireId(id, "project id");
    if (typeof confirmationName !== "string" || confirmationName.length === 0) throw new ApplicationError("validation", "Exact project-name confirmation is required");
    const commandCtx = commandContext(ctx, "project.remove", { projectId, expectedVersion, confirmationName });
    const mutation = await this.mutate(commandCtx, "project.remove", "project", projectId, async () => {
      const current = await this.ports.projects.getProject(projectId);
      if (current === null) throw notFound("Project", projectId);
      if (current.removedAt !== undefined) {
        throw projectRemoved(projectId, { removedAt: current.removedAt, removedBy: current.removedBy, lastLifecycleStatus: current.lastLifecycleStatus });
      }
      if (current.name !== confirmationName) {
        throw conflict("Project removal requires an exact, case-sensitive project-name confirmation", { expectedName: current.name });
      }
      const remove = this.ports.projects.removeProject;
      if (remove === undefined) throw new ApplicationError("integrity_error", "This runtime does not support irreversible project removal");
      const tombstone = await remove.call(this.ports.projects, projectId, expectedVersion, confirmationName, commandCtx);
      const rollback = this.ports.projects.rollbackProjectRemoval;
      return {
        value: tombstone,
        entityId: projectId,
        version: tombstone.version,
        eventMetadata: { releasedReservationCount: tombstone.releasedReservationIds.length },
        ...(rollback === undefined ? {} : { compensate: () => rollback.call(this.ports.projects, projectId) })
      };
    });
    // The audit is created by mutate after the atomic runtime operation. Add
    // its identity to the response while preserving replay determinism.
    await this.ports.projects.commitProjectRemoval?.(projectId);
    return { ...mutation, data: { ...mutation.data, ...(mutation.data.auditId === undefined ? { auditId: mutation.audit.id } : {}) } };
  }

  async createProject(input: CreateProject, ctx: RequestContext): Promise<Mutation<Project>> {
    const parsed = createProjectSchema.parse(input);
    return this.mutate(ctx, "project.create", "project", parsed.id ?? "pending", async () => {
      const project = await this.ports.projects.createProject(parsed, ctx);
      return { value: project, entityId: project.id, version: project.version };
    });
  }

  async updateProject(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Project>> {
    const projectId = requireId(id, "project id");
    const parsed = updateProjectSchema.parse(input) as Partial<CreateProject>;
    if (parsed.status === "archived") return this.archiveProject(projectId, expectedVersion, ctx);
    if (parsed.status === "idea") {
      const current = await this.getProject(projectId);
      if (current.status === "archived") return this.restoreProject(projectId, expectedVersion, ctx);
    }
    return this.mutate(ctx, "project.update", "project", projectId, async () => {
      const project = await this.ports.projects.updateProject(projectId, parsed, expectedVersion, ctx);
      return { value: project, entityId: project.id, version: project.version };
    });
  }

  async archiveProject(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Project>> {
    const projectId = requireId(id, "project id");
    const commandCtx = commandContext(ctx, "project.archive", { projectId, expectedVersion });
    const mutation = await this.mutate(commandCtx, "project.archive", "project", projectId, async () => {
      const archive = this.ports.projects.archiveProject;
      if (archive === undefined) throw new ApplicationError("integrity_error", "This runtime does not support atomic project archiving");
      const project = await archive.call(this.ports.projects, projectId, expectedVersion, commandCtx);
      const rollback = this.ports.projects.rollbackProjectArchive;
      return {
        value: project,
        entityId: project.id,
        version: project.version,
        ...(rollback === undefined ? {} : { compensate: () => rollback.call(this.ports.projects, projectId) })
      };
    });
    // The memory adapter keeps a process-local compensation receipt until the
    // surrounding audit transaction commits. Closing it here ensures a later
    // no-op/audit failure cannot roll back this already committed archive.
    await this.ports.projects.commitProjectArchive?.(projectId);
    return mutation;
  }

  async restoreProject(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Project>> {
    const projectId = requireId(id, "project id");
    const commandCtx = commandContext(ctx, "project.restore", { projectId, expectedVersion });
    return this.mutate(commandCtx, "project.restore", "project", projectId, async () => {
      const restore = this.ports.projects.restoreProject;
      const project = restore === undefined
        ? await this.ports.projects.updateProject(projectId, { status: "idea" }, expectedVersion, commandCtx)
        : await restore.call(this.ports.projects, projectId, expectedVersion, commandCtx);
      return { value: project, entityId: project.id, version: project.version };
    });
  }

  async listWorkItems(projectId: string): Promise<readonly WorkItem[]> {
    const parsedProjectId = requireId(projectId, "project id");
    await this.assertProjectReadable(parsedProjectId);
    return this.ports.unitOfWork.exclusive(() => this.ports.projects.listWorkItems(parsedProjectId));
  }

  async getWorkItem(id: string): Promise<WorkItem> {
    return this.ports.unitOfWork.exclusive(async () => {
      const workItem = await this.ports.projects.getWorkItem(requireId(id, "work item id"));
      if (!workItem) throw notFound("Work item", id);
      await this.assertProjectReadable(workItem.projectId);
      return workItem;
    });
  }

  async createWorkItem(projectId: string, input: CreateWorkItem, ctx: RequestContext): Promise<Mutation<WorkItem>> {
    const parsed = createWorkItemSchema.parse(input);
    const parentId = requireId(projectId, "project id");
    return this.mutate(ctx, "project.work_item.create", "work_item", parsed.id ?? "pending", async () => {
      await this.assertProjectActive(parentId);
      const item = await this.ports.projects.createWorkItem(parentId, parsed, ctx);
      return { value: item, entityId: item.id, version: item.version };
    });
  }

  async createProjectRevision(projectId: string, input: CreateProjectRevision, ctx: RequestContext): Promise<Mutation<ProjectRevision>> {
    const parsed = createProjectRevisionSchema.parse(input);
    const parentId = requireId(projectId, "project id");
    return this.mutate(ctx, "project.revision.create", "project_revision", parsed.id ?? "pending", async () => {
      await this.assertProjectActive(parentId);
      const project = await this.ports.projects.getProject(parentId);
      const predecessor = project?.currentRevisionId === undefined ? null : await this.ports.projects.getProjectRevision(project.currentRevisionId);
      const route = parsed.fabricationRoute ?? predecessor?.fabricationRoute;
      const hasPrinterField = Object.prototype.hasOwnProperty.call(parsed, "intendedPrinterItemId");
      if (hasPrinterField && parsed.intendedPrinterItemId !== undefined && parsed.intendedPrinterItemId !== null && route !== "printed") {
        throw new ApplicationError("validation", "The intended printer requires the printed fabrication route");
      }
      const intendedPrinterItemId = route === "printed"
        ? (hasPrinterField ? parsed.intendedPrinterItemId : predecessor?.intendedPrinterItemId ?? null)
        : null;
      if (intendedPrinterItemId !== undefined && intendedPrinterItemId !== null) await assertOwnedPrinter(this.ports, intendedPrinterItemId);
      const createInput: CreateProjectRevision = {
        ...parsed,
        ...(route === undefined ? {} : { fabricationRoute: route }),
        intendedPrinterItemId
      };
      const revision = await this.ports.projects.createProjectRevision(parentId, createInput, ctx);
      return { value: revision, entityId: revision.id, version: revision.version };
    });
  }

  async updateProjectRevision(id: string, input: UpdateProjectRevision, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<ProjectRevision>> {
    const parsed = updateProjectRevisionSchema.parse(input);
    const revisionId = requireId(id, "revision id");
    return this.mutate(ctx, "project.revision.update", "project_revision", revisionId, async () => {
      const current = await this.ports.projects.getProjectRevision(revisionId);
      if (current === null) throw notFound("Project revision", revisionId);
      await this.assertProjectActive(current.projectId);
      const route = parsed.fabricationRoute ?? current.fabricationRoute ?? "undecided";
      const hasPrinterField = Object.prototype.hasOwnProperty.call(parsed, "intendedPrinterItemId");
      if (hasPrinterField && parsed.intendedPrinterItemId !== undefined && parsed.intendedPrinterItemId !== null && route !== "printed") {
        throw new ApplicationError("validation", "The intended printer requires the printed fabrication route");
      }
      const intendedPrinterItemId = route === "printed"
        ? (hasPrinterField ? parsed.intendedPrinterItemId : current.intendedPrinterItemId ?? null)
        : null;
      if (intendedPrinterItemId !== undefined && intendedPrinterItemId !== null) await assertOwnedPrinter(this.ports, intendedPrinterItemId);
      const update = {
        ...parsed,
        fabricationRoute: route,
        intendedPrinterItemId
      } as UpdateProjectRevision;
      const updateRevision = this.ports.projects.updateProjectRevision;
      if (updateRevision === undefined) throw new ApplicationError("integrity_error", "This project adapter does not support revision planning updates");
      const revision = await updateRevision.call(this.ports.projects, revisionId, update, expectedVersion, ctx);
      return { value: revision, entityId: revision.id, version: revision.version };
    });
  }

  async createProjectWithInitialRevision(input: CreateProjectWithInitialRevision, ctx: RequestContext): Promise<Mutation<ProjectWithInitialRevision>> {
    const parsed = createProjectWithInitialRevisionSchema.parse(input);
    const createAtomic = this.ports.projects.createProjectWithInitialRevision;
    if (createAtomic === undefined) throw new ApplicationError("integrity_error", "This project adapter does not support atomic project creation");
    const action = "project.create_with_initial_revision";
    const effectiveRoute = parsed.revision.fabricationRoute ?? "undecided";
    if (parsed.revision.intendedPrinterItemId !== undefined && parsed.revision.intendedPrinterItemId !== null && effectiveRoute !== "printed") {
      throw new ApplicationError("validation", "The intended printer requires the printed fabrication route");
    }
    if (parsed.revision.intendedPrinterItemId !== undefined && parsed.revision.intendedPrinterItemId !== null) await assertOwnedPrinter(this.ports, parsed.revision.intendedPrinterItemId);
    // The atomic command is also used by MCP hosts without an HTTP request
    // fingerprint. Always derive the digest from the parsed, canonical
    // payload so transport envelope differences cannot change replay
    // semantics and a reused key cannot replay changed command fields.
    const commandCtx = canonicalProjectSetupContext(ctx, parsed);
    return this.mutate(commandCtx, action, "project", parsed.project.id ?? "pending", async () => {
      const created = await createAtomic.call(this.ports.projects, parsed, commandCtx);
      return { value: created, entityId: created.project.id, version: created.project.version };
    });
  }

  /** Build a bounded, actor-owned setup proposal without touching graph data. */
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
        if (!CONFIRMED_EVIDENCE.has(item.evidence.state)) fieldErrors.push({ path: `reservations.${index}.itemId`, code: "insufficient_evidence", message: "Only physically confirmed stock can be reserved" });
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
        const remainingCoverage = Math.max(0, line.requiredQuantity - priorCoverage);
        if (reservation.quantity > Math.ceil(remainingCoverage / factor)) fieldErrors.push({ path: `reservations.${index}.quantity`, code: "requirement_exceeded", message: "Reservation cannot exceed the BOM requirement after whole-unit conversion" });
        plannedByItem.set(item.id, (plannedByItem.get(item.id) ?? 0) + reservation.quantity);
        plannedByLineCoverage.set(line.localRef, priorCoverage + reservation.quantity * factor);
      }
    }
    for (const item of inventory) {
      const planned = plannedByItem.get(item.id) ?? 0;
      if (planned > item.availableQuantity) fieldErrors.push({ path: "reservations", code: "insufficient_stock", message: `Planned reservations exceed available stock for '${item.id}'` });
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
        if (line === undefined || item === undefined || !isUnitCompatibleWithItemKind(item.kind, item.unit) || !canReserveBomItem(line, item) || !CONFIRMED_EVIDENCE.has(item.evidence.state)) {
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

  async getProjectRevision(id: string): Promise<ProjectRevision> {
    return this.ports.unitOfWork.exclusive(async () => {
      const revision = await this.ports.projects.getProjectRevision(requireId(id, "revision id"));
      if (!revision) throw notFound("Project revision", id);
      await this.assertProjectReadable(revision.projectId);
      return revision;
    });
  }

  async createWorkItemRevision(workItemId: string, input: CreateWorkItemRevision, ctx: RequestContext): Promise<Mutation<WorkItemRevision>> {
    const parsed = createWorkItemRevisionSchema.parse(input);
    const parentId = requireId(workItemId, "work item id");
    return this.mutate(ctx, "project.work_item_revision.create", "work_item_revision", parsed.id ?? "pending", async () => {
      const workItem = await this.ports.projects.getWorkItem(parentId);
      if (workItem === null) throw notFound("Work item", parentId);
      await this.assertProjectActive(workItem.projectId);
      const revision = await this.ports.projects.createWorkItemRevision(parentId, parsed, ctx);
      return { value: revision, entityId: revision.id, version: revision.version };
    });
  }

  async getWorkItemRevision(id: string): Promise<WorkItemRevision> {
    return this.ports.unitOfWork.exclusive(async () => {
      const revision = await this.ports.projects.getWorkItemRevision(requireId(id, "work item revision id"));
      if (!revision) throw notFound("Work item revision", id);
      await this.assertProjectReadable(revision.projectId);
      return revision;
    });
  }

  async listBomLines(revisionId: string, options?: { readonly includeRetired?: boolean }): Promise<readonly BomLine[]> {
    const parsedRevisionId = requireId(revisionId, "revision id");
    await this.assertProjectReadableFromRevision(parsedRevisionId);
    return this.ports.unitOfWork.exclusive(() => this.ports.projects.listBomLines(parsedRevisionId, options));
  }

  async getBomLine(id: string): Promise<BomLine> {
    return this.ports.unitOfWork.exclusive(async () => {
      const line = await this.ports.projects.getBomLine(requireId(id, "BOM line id"));
      if (!line) throw notFound("BOM line", id);
      await this.assertProjectReadableFromRevision(line.revisionId);
      return line;
    });
  }

  async createBomLine(revisionId: string, input: CreateBomLine | LegacyBomLineInput, ctx: RequestContext): Promise<Mutation<BomLine>> {
    const parsed = canonicalizeBomLineWrite(legacyCreateBomLineSchema.parse(input) as CreateBomLine);
    const parentId = requireId(revisionId, "revision id");
    return this.mutate(ctx, "project.bom_line.create", "bom_line", parsed.id ?? "pending", async () => {
      await this.assertProjectActiveFromRevision(parentId);
      if (bomRequirementRequestsPrinter(parsed)) {
        throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
      }
      for (const itemId of [parsed.itemId, ...parsed.alternatives.map((alternative) => alternative.itemId)].filter((value): value is string => value !== undefined)) {
        const item = await this.ports.inventory.getItem(itemId);
        if (item?.kind === "printer") {
          throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
        }
      }
      const line = await this.ports.projects.createBomLine(parentId, parsed, ctx);
      return { value: line, entityId: line.id, version: line.version };
    });
  }

  async updateBomLine(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<BomLine>> {
    const lineId = requireId(id, "BOM line id");
    const parsed = legacyUpdateBomLineSchema.parse(input) as Partial<CreateBomLine>;
    return this.mutate(ctx, "project.bom_line.update", "bom_line", lineId, async () => {
      const existing = await this.ports.projects.getBomLine(lineId);
      if (existing === null) throw notFound("BOM line", lineId);
      await this.assertProjectActiveFromRevision(existing.revisionId);
      if (Object.prototype.hasOwnProperty.call(parsed, "role") && (parsed.role === "reusable" || (existing.role === "consumed" && parsed.role !== "consumed"))) {
        const hasActiveReservation = (await this.ports.projects.listReservations(existing.revisionId))
          .some((reservation) => reservation.lineId === lineId && reservation.status === "active");
        if (hasActiveReservation) throw conflict("Release or reconcile active reservations before changing this requirement from a part or material", { lineId });
      }
      const merged = canonicalizeBomLineWrite({
        ...existing,
        ...parsed,
        ...(parsed.constraints === undefined ? { constraints: existing.constraints } : {}),
      });
      if (bomRequirementRequestsPrinter(merged)) {
        throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
      }
      for (const itemId of [merged.itemId, ...merged.alternatives.map((alternative) => alternative.itemId)].filter((value): value is string => value !== undefined)) {
        const item = await this.ports.inventory.getItem(itemId);
        if (item?.kind === "printer") {
          throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
        }
      }
      const canonicalConstraints = isRecord(merged.constraints) ? { constraints: merged.constraints } : {};
      const line = await this.ports.projects.updateBomLine(lineId, { ...parsed, ...canonicalConstraints }, expectedVersion, ctx);
      return { value: line, entityId: line.id, version: line.version };
    });
  }

  async retireBomLine(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<BomLine>> {
    const lineId = requireId(id, "BOM line id");
    return this.mutate(ctx, "project.bom_line.retire", "bom_line", lineId, async () => {
      const existing = await this.ports.projects.getBomLine(lineId);
      if (existing === null) throw notFound("BOM line", lineId);
      await this.assertProjectActiveFromRevision(existing.revisionId);
      const line = await this.ports.projects.retireBomLine(lineId, expectedVersion, ctx);
      return { value: line, entityId: line.id, version: line.version };
    });
  }

  async restoreBomLine(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<BomLine>> {
    const lineId = requireId(id, "BOM line id");
    return this.mutate(ctx, "project.bom_line.restore", "bom_line", lineId, async () => {
      const existing = await this.ports.projects.getBomLine(lineId);
      if (existing === null) throw notFound("BOM line", lineId);
      await this.assertProjectActiveFromRevision(existing.revisionId);
      const line = await this.ports.projects.restoreBomLine(lineId, expectedVersion, ctx);
      return { value: line, entityId: line.id, version: line.version };
    });
  }

  async evaluateBomGaps(revisionId: string): Promise<GapEvaluation> {
    return this.ports.unitOfWork.exclusive(async () => {
      const id = requireId(revisionId, "revision id");
      await this.assertProjectReadableFromRevision(id);
      const lines = await this.ports.projects.listBomLines(id);
      const inventory = await listAllInventory(this.ports.inventory);
      const reservations = await this.ports.projects.listReservations(id);
      return evaluateBomGapsFromData(id, lines, inventory, reservations);
    });
  }

  /** Derived review queue for canonical Check/inspect candidates. */
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

  async createReservation(revisionId: string, input: CreateReservation, ctx: RequestContext): Promise<Mutation<Reservation>> {
    const parsed = createReservationSchema.parse(input);
    const parentId = requireId(revisionId, "revision id");
    return this.mutate(ctx, "project.reservation.create", "reservation", parsed.id ?? "pending", async () => {
      await this.assertProjectActiveFromRevision(parentId);
      const lines = await this.ports.projects.listBomLines(parentId);
      const line = lines.find((candidate) => candidate.id === parsed.lineId);
      if (line === undefined) throw notFound("BOM line", parsed.lineId);
      assertConsumedBomRequirement(line);
      if (!bomSpecification(line).sufficient) {
        throw new ApplicationError("validation", "Resolve the BOM specification decisions before reserving stock");
      }
      const unsupported = unsupportedBomConstraintKeys(line.constraints);
      if (unsupported.length > 0) {
        throw new ApplicationError("validation", `Unsupported BOM constraint key(s): ${unsupported.join(", ")}`);
      }
      const item = await this.ports.inventory.getItem(parsed.itemId);
      if (item === null) throw notFound("Inventory item", parsed.itemId);
      assertCompatibleInventoryUnit(item, "Cannot reserve stock");
      if (!canReserveBomItem(line, item)) {
        throw new ApplicationError("validation", "Reservation item must be the exact BOM item or an approved alternative");
      }
      const conversion = bomCandidateQuantityConversion(line, item);
      if (item.unit !== line.unit && conversion === undefined) {
        throw new ApplicationError("validation", `Reservation requires a valid one-set conversion from ${item.unit} to ${line.unit}`);
      }
      if (conversion !== undefined && !Number.isSafeInteger(parsed.quantity)) {
        throw new ApplicationError("validation", "Converted reservations must use a whole number of sets");
      }
      if (!matchesBomConstraints(item, line.constraints)) {
        throw new ApplicationError("validation", "Inventory item does not satisfy the BOM constraints");
      }
      if (!CONFIRMED_EVIDENCE.has(item.evidence.state)) {
        throw new ApplicationError("conflict", "Only physically confirmed stock can be reserved");
      }
      const activeReservations = (await this.ports.projects.listReservations(parentId))
        .filter((reservation) => reservation.status === "active" && reservation.lineId === line.id);
      const activeUnits = new Set<InventoryItem["unit"]>([item.unit]);
      let reservedCoverage = 0;
      for (const reservation of activeReservations) {
        const reservedItem = reservation.itemId === item.id ? item : await this.ports.inventory.getItem(reservation.itemId);
        if (reservedItem === null) throw new ApplicationError("integrity_error", `Reservation references missing inventory item '${reservation.itemId}'`);
        assertCompatibleInventoryUnit(reservedItem, "Cannot evaluate existing reservation");
        activeUnits.add(reservedItem.unit);
        if (activeUnits.size > 1) {
          throw new ApplicationError("validation", `BOM line '${line.id}' cannot mix active reservation units`);
        }
        if (reservedItem.unit === line.unit) {
          reservedCoverage += reservation.quantity;
          continue;
        }
        const reservedConversion = bomCandidateQuantityConversion(line, reservedItem);
        if (reservedConversion === undefined || !Number.isSafeInteger(reservation.quantity)) {
          throw new ApplicationError("integrity_error", "Existing reservation has no valid quantity conversion for this BOM line");
        }
        reservedCoverage += reservation.quantity * reservedConversion.requirement.quantity;
      }
      if (conversion === undefined) {
        if (reservedCoverage + parsed.quantity > line.requiredQuantity) {
          throw conflict(`Cannot reserve beyond the BOM requirement of ${line.requiredQuantity} ${line.unit}`);
        }
      } else {
        const remainingCoverage = Math.max(0, line.requiredQuantity - reservedCoverage);
        const maximumSets = Math.ceil(remainingCoverage / conversion.requirement.quantity);
        if (parsed.quantity > maximumSets) {
          throw conflict(`Cannot reserve beyond the BOM requirement of ${line.requiredQuantity} ${line.unit}; ${parsed.quantity} set(s) would exceed whole-set coverage`);
        }
      }
      if (item.availableQuantity < parsed.quantity) {
        throw conflict(`Not enough confirmed stock to reserve ${parsed.quantity} ${item.unit}`);
      }
      const reservation = await this.ports.projects.createReservation(parentId, parsed, ctx);
      return { value: reservation, entityId: reservation.id, version: reservation.version };
    });
  }

  async releaseReservation(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Reservation>> {
    const reservationId = requireId(id, "reservation id");
    return this.mutate(ctx, "project.reservation.release", "reservation", reservationId, async () => {
      const details = await this.ports.projects.getReservationDetails(reservationId);
      if (details === null) throw notFound("Reservation", reservationId);
      await this.assertProjectActive(details.projectId);
      const reservation = await this.ports.projects.releaseReservation(reservationId, expectedVersion, ctx);
      return { value: reservation, entityId: reservation.id, version: reservation.version };
    });
  }

  async listReservations(revisionId: string): Promise<readonly Reservation[]> {
    const parsedRevisionId = requireId(revisionId, "revision id");
    await this.assertProjectReadableFromRevision(parsedRevisionId);
    return this.ports.unitOfWork.exclusive(() => this.ports.projects.listReservations(parsedRevisionId));
  }

  async getReservationDetails(id: string): Promise<ReservationDetails> {
    return this.ports.unitOfWork.exclusive(async () => {
      const details = await this.ports.projects.getReservationDetails(requireId(id, "reservation id"));
      if (!details) throw notFound("Reservation", id);
      await this.assertProjectReadable(details.projectId);
      return details;
    });
  }

  /** Read the current review document. A missing document is a normal first
   * visit; callers can save an explicit set of line outcomes to create it. */
  async getReconciliation(revisionId: string): Promise<ReconciliationDraft | null> {
    const id = requireId(revisionId, "project revision id");
    await this.getProjectRevision(id);
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

  async recordUsage(input: UsageInput, ctx: RequestContext): Promise<Mutation<StockMutation>> {
    const itemId = requireId(input.itemId, "item id");
    requireId(input.projectId, "project id");
    const reservationId = requireId(input.reservationId ?? "", "reservation id");
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new ApplicationError("validation", "Usage quantity must be greater than zero");
    }
    return this.mutate(ctx, "project.usage.record", "inventory_item", itemId, async () => {
      await this.assertProjectActive(input.projectId);
      const item = await this.ports.inventory.getItem(itemId);
      if (item === null) throw notFound("Inventory item", itemId);
      assertCompatibleInventoryUnit(item, "Cannot record usage");
      if (item.unit !== input.unit) {
        throw new ApplicationError("validation", `Unit mismatch: item uses ${item.unit}, usage uses ${input.unit}`);
      }
      const details = await this.ports.projects.getReservationDetails(reservationId);
      if (details === null) throw notFound("Reservation", reservationId);
      if (details.projectId !== input.projectId) throw new ApplicationError("validation", "Reservation belongs to a different project");
      assertConsumedBomRequirement(details.bomLine);
      const usage = await this.ports.projects.recordUsage({ ...input, itemId, reservationId }, ctx);
      return { value: { ...usage, item: inventoryWithUnitStatus(usage.item) }, entityId: usage.item.id, version: usage.item.version };
    });
  }

  async listOffers(itemId: string | undefined, limit = 50, cursor?: string): Promise<Page<Offer>> {
    const normalizedCursor = boundedCursor(cursor);
    return this.ports.unitOfWork.exclusive(() => this.ports.offers.listOffers(itemId ? requireId(itemId, "item id") : undefined, Math.min(Math.max(limit, 1), 200), normalizedCursor));
  }

  async createOffer(input: CreateOffer, ctx: RequestContext): Promise<Mutation<Offer>> {
    const parsed = createOfferSchema.parse(input);
    return this.mutate(ctx, "offer.create", "offer", parsed.id ?? "pending", async () => {
      const offer = await this.ports.offers.createOffer(parsed, ctx);
      return { value: offer, entityId: offer.id, version: offer.version };
    });
  }

  async listArtifacts(projectId: string, query?: ArtifactListQuery) {
    const parsedProjectId = requireId(projectId, "project id");
    await this.assertProjectReadable(parsedProjectId);
    const parsedQuery = artifactListQuerySchema.parse(query ?? {});
    let workItemId: string | undefined;
    let revisionId: string | undefined;
    if ("projectRevisionId" in parsedQuery) {
      const revision = await this.ports.projects.getProjectRevision(parsedQuery.projectRevisionId);
      const collidingWorkRevision = await this.ports.projects.getWorkItemRevision(parsedQuery.projectRevisionId);
      if (revision === null || revision.projectId !== parsedProjectId || collidingWorkRevision !== null) {
        throw notFound("Project revision", parsedQuery.projectRevisionId);
      }
      revisionId = parsedQuery.projectRevisionId;
    } else if ("workItemRevisionId" in parsedQuery) {
      const workItem = await this.ports.projects.getWorkItem(parsedQuery.workItemId);
      const revision = await this.ports.projects.getWorkItemRevision(parsedQuery.workItemRevisionId);
      const collidingProjectRevision = await this.ports.projects.getProjectRevision(parsedQuery.workItemRevisionId);
      if (workItem === null || workItem.projectId !== parsedProjectId || revision === null || revision.projectId !== parsedProjectId || revision.workItemId !== parsedQuery.workItemId || collidingProjectRevision !== null) {
        throw notFound("Work-item revision", parsedQuery.workItemRevisionId);
      }
      workItemId = parsedQuery.workItemId;
      revisionId = parsedQuery.workItemRevisionId;
    }
    const artifacts = await this.ports.unitOfWork.exclusive(() => this.ports.artifacts.listArtifacts(parsedProjectId, workItemId, revisionId));
    return parsedQuery.role === undefined ? artifacts : artifacts.filter((artifact) => artifact.role === parsedQuery.role);
  }

  async getArtifact(id: string) {
    return this.ports.unitOfWork.exclusive(async () => {
      const artifact = await this.ports.artifacts.getArtifact(requireId(id, "artifact id"));
      if (!artifact) throw notFound("Artifact", id);
      await this.assertProjectReadable(artifact.projectId);
      return artifact;
    });
  }

  async getUploadSessionDetails(id: string): Promise<UploadSessionDetails> {
    return this.ports.unitOfWork.exclusive(async () => {
      const details = await this.ports.artifacts.getUploadSessionDetails(requireId(id, "upload session id"));
      if (!details) throw notFound("Upload session", id);
      await this.assertProjectReadable(details.projectId);
      return details;
    });
  }

  async beginArtifactUpload(input: ApiBeginUpload, ctx: RequestContext): Promise<Mutation<UploadSession>> {
    const normalizedInput = normalizeArtifactUpload(input);
    // Validate ancestry before entering mutate(): malformed/cross-project
    // requests must not create a session, audit row, or idempotency record.
    await this.assertArtifactAncestry(normalizedInput);
    if (normalizedInput.byteSize <= 0 || normalizedInput.byteSize > MAX_UPLOAD_BYTES) throw new ApplicationError("quota_exceeded", "Upload exceeds the per-file limit");
    const filename = safeFilename(normalizedInput.filename);
    if (!ALLOWED_BINARY_MEDIA.has(normalizedInput.mediaType) && !normalizedInput.mediaType.startsWith("text/")) {
      throw new ApplicationError("unsupported_media", "This media type is not accepted");
    }
    const normalized = { ...normalizedInput, filename };
    return this.mutate(ctx, "artifact.upload.begin", "project", normalized.projectId, async () => {
      const session = await this.ports.artifacts.beginUpload(normalized, ctx);
      return {
        value: session,
        entityId: session.id,
        compensate: async () => {
          if (this.ports.artifacts.abortUpload === undefined) {
            throw new ApplicationError("integrity_error", "The artifact upload adapter cannot compensate an uncommitted session");
          }
          await this.ports.artifacts.abortUpload(session.id);
        }
      };
    });
  }

  async writeArtifactUpload(sessionId: string, body: Uint8Array) {
    requireId(sessionId, "upload session id");
    if (body.byteLength > MAX_UPLOAD_BYTES) throw new ApplicationError("quota_exceeded", "Upload exceeds the per-file limit");
    return this.ports.unitOfWork.exclusive(() => this.ports.artifacts.writeUpload(sessionId, body));
  }

  async finalizeArtifactUpload(sessionId: string, ctx: RequestContext): Promise<Mutation<Artifact>> {
    const id = requireId(sessionId, "upload session id");
    let finalizedArtifactId: string | undefined;
    let createdFinalization = false;
    const mutation = await this.mutate(ctx, "artifact.upload.finalize", "upload_session", id, async () => {
      const upload = await this.ports.artifacts.getUploadSessionDetails(id);
      if (upload === null) throw notFound("Upload session", id);
      await this.assertProjectActive(upload.projectId);
      // A finalized session may be retried with another idempotency key after
      // its original database transaction committed. It may still have a
      // process-local filesystem receipt if post-commit cleanup failed, but a
      // later transaction must never own compensation for that already
      // committed artifact.
      createdFinalization = upload.session.status !== "finalized";
      const snapshotId = upload.buildConfigurationSnapshotId;
      if (snapshotId !== undefined) {
        if (upload.revisionId === undefined || upload.workItemId !== undefined) {
          throw new ApplicationError("validation", "A build configuration can only bind to a project-revision upload");
        }
        const configurations = buildConfigurationPort(this.ports);
        const snapshot = await configurations.getBuildConfiguration(snapshotId);
        if (snapshot === null) throw notFound("Build configuration", snapshotId);
        if (snapshot.projectRevisionId !== upload.revisionId) {
          throw new ApplicationError("validation", "The build configuration snapshot does not belong to the upload revision");
        }
        const revision = await this.ports.projects.getProjectRevision(upload.revisionId);
        if (revision === null || revision.projectId !== upload.projectId) {
          throw new ApplicationError("validation", "The build configuration snapshot is not in the upload project ancestry");
        }
        if (this.ports.artifacts.bindBuildConfiguration === undefined) {
          throw new ApplicationError("integrity_error", "The artifact adapter cannot persist build configuration bindings");
        }
      }
      let artifact: Artifact;
      try {
        artifact = await this.ports.artifacts.finalizeUpload(id, ctx);
        finalizedArtifactId = artifact.id;
        if (snapshotId !== undefined) {
          await this.ports.artifacts.bindBuildConfiguration!({ artifactId: artifact.id, buildConfigurationSnapshotId: snapshotId, projectRevisionId: upload.revisionId! });
        }
      } catch (error: unknown) {
        // Binding is part of this operation, so a failure happens before the
        // normal mutate() compensation receipt can be registered. Roll back a
        // filesystem finalization immediately only when this invocation
        // created it; a finalized session belongs to an earlier committed
        // operation and must remain visible.
        if (finalizedArtifactId !== undefined && createdFinalization) {
          if (this.ports.artifacts.rollbackFinalization === undefined) {
            throw new ApplicationError("integrity_error", "Artifact finalization failed and cannot be compensated");
          }
          try {
            await this.ports.artifacts.rollbackFinalization(id, finalizedArtifactId);
          } catch {
            throw new ApplicationError("integrity_error", "Artifact finalization failed and could not be compensated");
          }
        }
        throw error;
      }
      return {
        value: artifact,
        entityId: artifact.id,
        version: artifact.version,
        ...(createdFinalization ? {
          compensate: async () => {
            if (this.ports.artifacts.rollbackFinalization !== undefined) await this.ports.artifacts.rollbackFinalization(id, artifact.id);
          }
        } : {})
      };
    });
    // The artifact store keeps a process-local compensation receipt until the
    // surrounding SQLite transaction has committed. A post-commit cleanup
    // failure is recoverable: an idempotency replay still has the committed
    // artifact in its result, so retry receipt closure for every successful
    // return rather than only for the operation that created the artifact.
    await this.ports.artifacts.commitFinalization?.(id, mutation.data.id);
    return mutation;
  }

  async readArtifact(id: string): Promise<ArtifactDownload> {
    const artifactId = requireId(id, "artifact id");
    await this.getArtifact(artifactId);
    return this.ports.unitOfWork.exclusive(() => this.ports.artifacts.readArtifact(artifactId));
  }

  async retireArtifact(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Artifact>> {
    const artifactId = requireId(id, "artifact id");
    return this.mutate(ctx, "artifact.retire", "artifact", artifactId, async () => {
      const existing = await this.ports.artifacts.getArtifact(artifactId);
      if (existing === null) throw notFound("Artifact", artifactId);
      await this.assertProjectActive(existing.projectId);
      const artifact = await this.ports.artifacts.retireArtifact(artifactId, expectedVersion, ctx);
      return { value: artifact, entityId: artifact.id, version: artifact.version };
    });
  }

  async health() {
    return this.ports.unitOfWork.exclusive(async () => {
      const checks = this.ports.health ? await this.ports.health.check() : { database: "ok", artifacts: "ok" } as const;
      const status = Object.values(checks).every((value) => value === "ok") ? "ok" : "degraded";
      return { status, service: "benchledger", version: this.version, demo: false, now: nowIso(), checks };
    });
  }

  subscribe(listener: (event: EventBusEvent) => void): () => void {
    return this.ports.events.subscribe(listener);
  }

  /**
   * Artifact paths are derived from the three logical ancestry components.
   * Resolve all of them before creating an upload session so an artifact can
   * never be staged under a missing, cross-project, or mixed work-item tree.
   * `revisionId` is intentionally interpreted by the presence of
   * `workItemId`: without a work item it must be a project revision; with one
   * it must be that work item's revision.
   */
  private async assertArtifactAncestry(input: BeginUploadInput): Promise<void> {
    const projectId = requireId(input.projectId, "project id");
    await this.assertProjectActive(projectId);

    if (input.workItemId !== undefined) {
      const workItemId = requireId(input.workItemId, "work item id");
      const workItem = await this.ports.projects.getWorkItem(workItemId);
      if (workItem === null || workItem.projectId !== projectId) throw notFound("Work item", workItemId);
    }

    if (input.buildConfigurationSnapshotId !== undefined && (input.revisionId === undefined || input.workItemId !== undefined)) {
      throw new ApplicationError("validation", "A build configuration can only bind to a project-revision upload");
    }
    if (input.revisionId === undefined) {
      throw new ApplicationError("validation", "Artifact upload must be anchored to exactly one revisioned scope");
    }
    const revisionId = requireId(input.revisionId, "revision id");
    const projectRevision = await this.ports.projects.getProjectRevision(revisionId);
    const workItemRevision = await this.ports.projects.getWorkItemRevision(revisionId);
    if (input.workItemId === undefined) {
      if (projectRevision === null || projectRevision.projectId !== projectId || workItemRevision !== null) {
        throw notFound("Project revision", revisionId);
      }
      if (input.buildConfigurationSnapshotId !== undefined) {
        const snapshot = await buildConfigurationPort(this.ports).getBuildConfiguration(requireId(input.buildConfigurationSnapshotId, "build configuration id"));
        if (snapshot === null) throw notFound("Build configuration", input.buildConfigurationSnapshotId);
        if (snapshot.projectRevisionId !== revisionId) throw new ApplicationError("validation", "The build configuration snapshot does not belong to the upload revision");
      }
      return;
    }

    if (
      workItemRevision === null ||
      workItemRevision.projectId !== projectId ||
      workItemRevision.workItemId !== input.workItemId ||
      projectRevision !== null
    ) {
      throw notFound("Work-item revision", revisionId);
    }
  }

  private async assertProjectActive(projectId: string): Promise<Project> {
    const project = await this.assertProjectReadable(projectId);
    if (project.status === "archived") {
      throw conflict(`Project '${project.id}' is archived; restore it before creating or committing work`);
    }
    return project;
  }

  private async assertProjectActiveFromRevision(revisionId: string): Promise<Project> {
    const revision = await this.ports.projects.getProjectRevision(requireId(revisionId, "revision id"));
    if (revision === null) throw notFound("Project revision", revisionId);
    return this.assertProjectActive(revision.projectId);
  }

  /** Central ancestry guard for all ordinary descendant reads and writes. */
  private async assertProjectReadable(projectId: string): Promise<Project> {
    const parsedProjectId = requireId(projectId, "project id");
    const project = await this.ports.projects.getProject(parsedProjectId);
    if (project === null) throw notFound("Project", parsedProjectId);
    if (project.removedAt !== undefined) {
      throw projectRemoved(project.id, { removedAt: project.removedAt, removedBy: project.removedBy, lastLifecycleStatus: project.lastLifecycleStatus });
    }
    return project;
  }

  private async assertProjectReadableFromRevision(revisionId: string): Promise<Project> {
    const parsedRevisionId = requireId(revisionId, "revision id");
    const revision = await this.ports.projects.getProjectRevision(parsedRevisionId);
    if (revision === null) throw notFound("Project revision", parsedRevisionId);
    return this.assertProjectReadable(revision.projectId);
  }

  private async mutate<T>(
    ctx: RequestContext,
    action: string,
    entityType: string,
    provisionalEntityId: string,
    operation: () => Promise<{
      readonly value: T;
      readonly entityId: string;
      readonly version?: number;
      readonly eventMetadata?: Readonly<Record<string, unknown>>;
      /** Allow an aggregate result to include the single audit identity. */
      readonly withAudit?: (audit: AuditEvent) => T;
      /** Cleanup for filesystem state if the audited mutation cannot commit. */
      readonly compensate?: () => Promise<void>;
    }>
  ): Promise<Mutation<T>> {
    const fingerprint = ctx.fingerprint ?? `${action}:${entityType}:${provisionalEntityId}`;
    let compensate: (() => Promise<void>) | undefined;
    let committed: { readonly mutation: Mutation<T>; readonly event: EventBusEvent | undefined };
    try {
      committed = await this.ports.unitOfWork.run(async () => {
        if (ctx.idempotencyKey) {
          const prior = await this.ports.idempotency.get(ctx.actor, ctx.idempotencyKey);
          if (prior !== null) {
            const stored = prior as { readonly action?: string; readonly fingerprint?: string; readonly mutation?: Mutation<T> };
            if (stored.mutation) {
              if (stored.action !== action || (stored.fingerprint !== undefined && stored.fingerprint !== fingerprint)) {
                throw new ApplicationError("idempotency_conflict", "Idempotency key was already used for a different command", {
                  reason: "idempotency_key_reused",
                  field: "idempotencyKey",
                  id: ctx.idempotencyKey,
                  retryable: false,
                  commitState: "not_committed",
                  commandId: ctx.idempotencyKey,
                });
              }
              return { mutation: { ...stored.mutation, replayed: true }, event: undefined };
            }
            return { mutation: { ...(prior as Mutation<T>), replayed: true }, event: undefined };
          }
        }
        const result = await operation();
        compensate = result.compensate;
        const auditInput: AuditInput = {
          action,
          actor: ctx.actor,
          source: ctx.source,
          correlationId: ctx.correlationId,
          ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
          entityType,
          entityId: result.entityId || provisionalEntityId,
          ...(result.version !== undefined ? { version: result.version } : {})
        };
        const audit = await this.ports.audit.append(auditInput);
        const mutation: Mutation<T> = { data: result.withAudit?.(audit) ?? result.value, audit, correlationId: ctx.correlationId, replayed: false };
        if (ctx.idempotencyKey) await this.ports.idempotency.set(ctx.actor, ctx.idempotencyKey, { action, fingerprint, mutation });
        const event: EventBusEvent = {
          id: audit.id,
          type: action,
          entityType,
          entityId: result.entityId || provisionalEntityId,
          ...(result.version !== undefined ? { version: result.version } : {}),
          correlationId: ctx.correlationId,
          at: audit.createdAt,
          ...(result.eventMetadata === undefined ? {} : { metadata: { ...result.eventMetadata } })
        };
        return { mutation, event };
      });
    } catch (error: unknown) {
      if (compensate !== undefined) {
        try {
          await compensate();
        } catch {
          throw new ApplicationError("integrity_error", "The mutation failed and artifact state could not be compensated");
        }
      }
      throw error;
    }
    if (committed.event !== undefined) {
      // Event delivery is deliberately post-commit. A listener is an
      // integration boundary and must not turn a durable mutation into a
      // failed/retryable command after SQLite has committed it.
      try {
        this.ports.events.publish(committed.event);
      } catch {
        // Event subscribers are best-effort; the committed audit/idempotency
        // record remains the source of truth for replay and reconciliation.
      }
    }
    return committed.mutation;
  }

  /**
   * Audited orchestration for one atomic inventory batch. The inventory port
   * owns the all-or-nothing state transition; this layer adds one idempotency
   * record and one audit/event pair for each actually changed item.
   */
  private async mutateBulk(
    ctx: RequestContext,
    operation: () => Promise<InventoryBulkUpdateResult>,
  ): Promise<BulkMutation<InventoryBulkUpdateResult>> {
    const action = "inventory.item.bulk_update";
    const fingerprint = ctx.fingerprint ?? action;
    let committed: {
      readonly mutation: BulkMutation<InventoryBulkUpdateResult>;
      readonly events: readonly EventBusEvent[];
    };
    committed = await this.ports.unitOfWork.run(async () => {
      if (ctx.idempotencyKey) {
        const prior = await this.ports.idempotency.get(ctx.actor, ctx.idempotencyKey);
        if (prior !== null) {
          const stored = prior as { readonly action?: string; readonly fingerprint?: string; readonly mutation?: BulkMutation<InventoryBulkUpdateResult> };
          if (stored.mutation) {
            if (stored.action !== action || (stored.fingerprint !== undefined && stored.fingerprint !== fingerprint)) {
              throw new ApplicationError("idempotency_conflict", "Idempotency key was already used for a different command");
            }
            return { mutation: { ...stored.mutation, replayed: true }, events: [] };
          }
          throw new ApplicationError("idempotency_conflict", "Idempotency key belongs to a different mutation shape");
        }
      }

      const data = await operation();
      const audits: AuditEvent[] = [];
      for (const item of data.updated) {
        const auditIdempotencyKey = ctx.idempotencyKey === undefined
          ? undefined
          : `bulk:${createHash("sha256").update(`${ctx.actor}:${ctx.idempotencyKey}:${item.id}`).digest("hex")}`;
        audits.push(await this.ports.audit.append({
          action,
          actor: ctx.actor,
          source: ctx.source,
          correlationId: ctx.correlationId,
          ...(auditIdempotencyKey === undefined ? {} : { idempotencyKey: auditIdempotencyKey }),
          entityType: "inventory_item",
          entityId: item.id,
          version: item.version,
        }));
      }
      const mutation: BulkMutation<InventoryBulkUpdateResult> = { data, audits, correlationId: ctx.correlationId, replayed: false };
      if (ctx.idempotencyKey) await this.ports.idempotency.set(ctx.actor, ctx.idempotencyKey, { action, fingerprint, mutation });
      const events = audits.map((audit) => ({
        id: audit.id,
        type: action,
        entityType: audit.entityType,
        entityId: audit.entityId,
        ...(audit.version === undefined ? {} : { version: audit.version }),
        correlationId: ctx.correlationId,
        at: audit.createdAt,
      } satisfies EventBusEvent));
      return { mutation, events };
    });

    for (const event of committed.events) {
      try {
        this.ports.events.publish(event);
      } catch {
        // Delivery is post-commit and best-effort, matching single-item
        // mutation semantics.
      }
    }
    return committed.mutation;
  }
}
