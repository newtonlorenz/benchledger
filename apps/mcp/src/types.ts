/**
 * Public, model-neutral contracts for the BenchLedger MCP adapter.
 *
 * The adapter deliberately depends on this application boundary instead of a
 * database, HTTP framework, ORM, or model SDK. A server can implement the
 * boundary with the local SQLite application or an authenticated HTTP client.
 */

import type {
  BuildConfigurationSnapshot as ApiBuildConfigurationSnapshot,
  CatalogProduct as ApiCatalogProduct,
  CreateBuildConfigurationSnapshot as ApiCreateBuildConfigurationSnapshot,
  CreatePhysicalOnlyFilamentSelection as ApiCreatePhysicalOnlyFilamentSelection,
  CreateCatalogProduct as ApiCreateCatalogProduct,
  CreateInventoryProductProfile as ApiCreateInventoryProductProfile,
  CreateInventoryProductProfileWithoutItem as ApiCreateInventoryProductProfileWithoutItem,
  InventoryProductProfile as ApiInventoryProductProfile,
  UpdateCatalogProduct as ApiUpdateCatalogProduct,
  UpdateInventoryProductProfile as ApiUpdateInventoryProductProfile,
  ReconciliationDraft as ApiReconciliationDraft,
  SaveReconciliationDraft as ApiSaveReconciliationDraft,
  CommitReconciliation as ApiCommitReconciliation,
  ReconciliationCommit as ApiReconciliationCommit,
  InventoryCategory as ApiInventoryCategory,
  CreateInventoryCategory as ApiCreateInventoryCategory,
  UpdateInventoryCategory as ApiUpdateInventoryCategory,
  ProjectLifecycle as ApiProjectLifecycle,
  ProjectSetupProposal as ApiProjectSetupProposal,
  ProjectSetupPreview as ApiProjectSetupPreview,
  CommitProjectSetup as ApiCommitProjectSetup,
  ProjectSetupCommitResult as ApiProjectSetupCommitResult,
  PhysicalOnlyFilamentSelection as ApiPhysicalOnlyFilamentSelection,
  InspectionAction as ApiInspectionAction,
  InspectionCompletionPreview as ApiInspectionCompletionPreview,
  InspectionCompletionCommit as ApiInspectionCompletionCommit,
  InspectionObservation as ApiInspectionObservation,
  BomGap as ApiBomGap,
} from "@benchledger/api-contract";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Scope =
  | "inventory:read"
  | "inventory:write"
  | "catalog:read"
  | "catalog:write"
  | "projects:read"
  | "projects:write"
  | "bom:read"
  | "bom:write"
  | "artifacts:read"
  | "artifacts:write"
  | "offers:read"
  | "offers:write"
  | "context:read";

export interface McpRequestContext {
  actorId: string;
  scopes: readonly Scope[];
  /** Optional project allow-list for a token scoped to one workspace. */
  projectIds?: readonly string[];
  correlationId?: string;
  /** Optional command idempotency metadata supplied by an HTTP host. */
  idempotencyKey?: string;
  fingerprint?: string;
}

export interface PageInput {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: readonly T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Quantity {
  value: number;
  unit: "piece" | "gram" | "millimetre" | "millilitre" | "metre" | "roll" | "set";
}

export interface Dimensions {
  length?: number;
  width?: number;
  height?: number;
  diameter?: number;
  unit: "millimetre" | "centimetre" | "metre";
  source?: "nominal" | "measured" | "manufacturer" | "user_reported";
  uncertainty?: number;
}

export type Availability =
  | "confirmed"
  | "inspect_first"
  | "ordered_unverified"
  | "delivered_uncounted"
  | "allocated"
  | "depleted"
  | "retired";

export type EvidenceState =
  | "physical_count"
  | "commissioned"
  | "measured"
  | "manufacturer"
  | "order"
  | "delivery"
  | "user_reported"
  | "inferred"
  | "unknown";

export interface EvidenceSummary {
  state: EvidenceState;
  source: string;
  sourceId?: string;
  recordedAt: string;
  note?: string;
}

export interface ExternalLink {
  label: string;
  url: string;
  kind?: "supplier" | "manufacturer" | "documentation" | "project" | "other";
}

/** The application API persists supplier links only; kind is read metadata. */
export type InventoryLinkInput = Pick<ExternalLink, "label" | "url">;

export interface InventoryItem {
  id: string;
  name: string;
  category: string;
  /** Optional user-managed taxonomy assignment; semantic category remains `category`. */
  categoryNodeId?: string;
  quantity: Quantity;
  availableQuantity?: Quantity;
  allocatedQuantity?: Quantity;
  /** Derived semantic-unit state; legacy mismatches remain visible for correction. */
  unitStatus?: "compatible" | "needs_correction";
  unitCorrectionReason?: string;
  availability: Availability;
  evidence: EvidenceSummary;
  description?: string;
  manufacturer?: string;
  model?: string;
  sku?: string;
  dimensions?: Dimensions;
  condition?: "new" | "used" | "opened" | "unknown";
  location?: string;
  /** Searchable tags; omitted by legacy hosts that do not expose tags. */
  tags?: readonly string[];
  links: readonly ExternalLink[];
  version?: number;
}

export interface InventorySummary {
  generatedAt: string;
  counts: {
    totalItems: number;
    /** Confirmed records with no current allocation; mutually exclusive summary bucket. */
    confirmedItems: number;
    /** All physically confirmed/commissioned records, including allocated and depleted records. */
    confirmedEvidenceItems: number;
    /** Confirmed records that still have usable unallocated stock, including partial allocations. */
    availableConfirmedItems: number;
    inspectFirstItems: number;
    allocatedItems: number;
    /** Allocated on-hand quantities grouped by their canonical unit. */
    allocatedQuantities: readonly Quantity[];
    depletedItems: number;
    /** Order or delivery evidence without a current physical count. */
    unverifiedItems: number;
    /** Retired records are retained for history but excluded from reuse. */
    retiredItems: number;
    missingItems: number;
  };
  categories: readonly { category: string; itemCount: number }[];
}

export interface InventoryListInput extends PageInput {
  query?: string;
  category?: string;
  /** Exact managed taxonomy node filter; distinct from semantic `category`. */
  categoryNodeId?: string;
  /** Select only legacy inventory without a managed category assignment. */
  unassigned?: boolean;
  availability?: Availability;
  location?: string;
}

/** Canonical exact-product and physical-profile records are shared with REST. */
export type CatalogProduct = ApiCatalogProduct;
export type CatalogProductCreateInput = ApiCreateCatalogProduct;
export type CatalogProductUpdatePatch = ApiUpdateCatalogProduct;
export type InventoryProductProfile = ApiInventoryProductProfile;
export type InventoryProductProfileCreateInput = ApiCreateInventoryProductProfile;
export type InventoryProductProfileCreateWithoutItemInput = ApiCreateInventoryProductProfileWithoutItem;
export type InventoryProductProfileUpdatePatch = ApiUpdateInventoryProductProfile;
/**
 * A build configuration may use an exact catalog filament or an explicitly
 * unprofiled physical spool.  The latter is intentionally a separate
 * discriminated branch: an item id by itself is not an exact identity.
 */
export type PhysicalOnlyFilamentSelectionInput = ApiCreatePhysicalOnlyFilamentSelection;

export type ExactFilamentSelection = Exclude<ApiCreateBuildConfigurationSnapshot["filamentSelections"][number], PhysicalOnlyFilamentSelectionInput>;
export type BuildConfigurationFilamentSelectionInput = ExactFilamentSelection | PhysicalOnlyFilamentSelectionInput;
export type BuildConfigurationCreateInput = Omit<ApiCreateBuildConfigurationSnapshot, "filamentSelections"> & {
  filamentSelections: readonly BuildConfigurationFilamentSelectionInput[];
};

/** Copied evidence is returned for a physical-only selection; it is not a
 * catalog, compatibility, or availability assertion. */
export type PhysicalOnlyFilamentSelection = ApiPhysicalOnlyFilamentSelection;
export type PhysicalOnlyFilamentSelectionSnapshot = PhysicalOnlyFilamentSelection;

export type BuildConfigurationFilamentSelection = ApiBuildConfigurationSnapshot["filamentSelections"][number] | PhysicalOnlyFilamentSelectionSnapshot;
export type BuildConfigurationSnapshot = Omit<ApiBuildConfigurationSnapshot, "filamentSelections"> & {
  filamentSelections: readonly BuildConfigurationFilamentSelection[];
};
export type ReconciliationDraft = ApiReconciliationDraft;
export type ReconciliationCommit = ApiReconciliationCommit;
export type ReconciliationDraftSaveInput = ApiSaveReconciliationDraft;

export type InspectionAction = Omit<ApiInspectionAction, "itemUnit" | "expectedUnit" | "candidate" | "expected"> & {
  itemUnit: Quantity["unit"];
  expectedUnit: Quantity["unit"];
  candidate: Omit<ApiInspectionAction["candidate"], "unit"> & { unit: Quantity["unit"] };
  expected: Omit<ApiInspectionAction["expected"], "unit" | "lineRequirements"> & {
    unit: Quantity["unit"];
    lineRequirements: readonly (Omit<ApiInspectionAction["expected"]["lineRequirements"][number], "unit"> & { unit: Quantity["unit"] })[];
  };
};
export type InspectionGap = Omit<ApiBomGap, "unit" | "alternatives" | "candidates"> & {
  unit: Quantity["unit"];
  alternatives: readonly BomAlternative[];
  candidates: readonly (Omit<ApiBomGap["candidates"][number], "availableQuantity" | "suppliedQuantity" | "inspectQuantity"> & {
    availableQuantity: Quantity;
    suppliedQuantity: Quantity;
    inspectQuantity: Quantity;
  })[];
};
export type InspectionGapEvaluation = {
  readonly revisionId: string;
  readonly lines: readonly InspectionGap[];
  readonly totals: Readonly<Record<string, number>>;
};
export type InspectionObservation = Omit<ApiInspectionObservation, "unit" | "conversion"> & {
  unit?: Quantity["unit"];
  conversion?: BomAlternativeQuantityConversion;
};
export type InspectionPreview = Omit<ApiInspectionCompletionPreview, "action" | "observation" | "before" | "after" | "reevaluatedGaps"> & {
  action: InspectionAction;
  observation: InspectionObservation;
  before: { item: InventoryItem; gaps: readonly InspectionGap[]; lines: readonly BomLine[] };
  after: { item: InventoryItem; gaps: readonly InspectionGap[]; lines: readonly BomLine[] };
  reevaluatedGaps: InspectionGapEvaluation;
};
export type InspectionEvidence = Omit<ApiInspectionCompletionCommit["evidence"], "unit" | "conversion"> & {
  unit?: Quantity["unit"];
  conversion?: BomAlternativeQuantityConversion;
};
export type InspectionCommit = Omit<ApiInspectionCompletionCommit, "evidence" | "item" | "gaps" | "inspections"> & {
  evidence: InspectionEvidence;
  item?: InventoryItem;
  gaps: InspectionGapEvaluation;
  inspections: {
    revisionId: string;
    data: readonly InspectionAction[];
    limit: number;
    nextCursor?: string;
    total?: number;
  };
};
export type InspectionObservationInput = Omit<InspectionObservation, "observedAt"> & { observedAt?: string };
export interface InspectionListInput extends PageInput { projectRevisionId: string; }
export interface InspectionReadInput { projectRevisionId: string; inspectionId: string; }
export interface InspectionPreviewInput { projectRevisionId: string; inspectionId: string; observation: InspectionObservationInput; }
export interface InspectionCommitInput { projectRevisionId: string; inspectionId: string; previewId: string; expectedPreviewVersion: number; contentSha256: string; confirmed: true; }

type ApiProjectSetupBomLine = ApiProjectSetupProposal["bomLines"][number];
type McpProjectSetupBomLine = Omit<ApiProjectSetupBomLine, "alternatives"> & { alternatives: readonly BomAlternative[] };
type McpProjectSetupGapLine = Omit<ApiProjectSetupPreview["gaps"]["lines"][number], "alternatives"> & { alternatives: readonly BomAlternative[] };
type McpProjectSetupGaps = Omit<ApiProjectSetupPreview["gaps"], "lines"> & { lines: readonly McpProjectSetupGapLine[] };
type McpProjectSetupResultBomLine = Omit<ApiProjectSetupCommitResult["bomLines"][number], "alternatives"> & { alternatives: readonly BomAlternative[] };

/** Project-setup alternatives use the MCP `piece` vocabulary at this boundary. */
export type ProjectSetupProposal = Omit<ApiProjectSetupProposal, "bomLines"> & { bomLines: readonly McpProjectSetupBomLine[] };
export type CommitProjectSetupInput = ApiCommitProjectSetup;
export type ProjectSetupPreview = Omit<ApiProjectSetupPreview, "proposal" | "gaps"> & { proposal: ProjectSetupProposal; gaps: McpProjectSetupGaps };
export type ProjectSetupCommitResult = Omit<ApiProjectSetupCommitResult, "bomLines" | "gaps"> & { bomLines: readonly McpProjectSetupResultBomLine[]; gaps: McpProjectSetupGaps };
/** MCP keeps the revision in the input because it is the ancestry anchor. */
export type ReconciliationCommitInput = { projectRevisionId: string } & ApiCommitReconciliation;

export interface ReconciliationReadInput {
  projectRevisionId: string;
}

export interface InventoryWithProductProfileCreateInput {
  item: InventoryCreateInput;
  profile: InventoryProductProfileCreateWithoutItemInput;
}

export interface InventoryWithProductProfileResult {
  id: string;
  version: number;
  item: InventoryItem;
  profile: InventoryProductProfile;
  auditId?: string;
  correlationId?: string;
  replayed?: boolean;
}

export interface CatalogProductSearchInput extends PageInput {
  query?: string;
  kind?: CatalogProduct["kind"];
}

export type CatalogProductUpdateInput = {
  productId: string;
  expectedVersion?: number;
} & CatalogProductUpdatePatch;

export type InventoryProductProfileLinkInput = {
  itemId: string;
  expectedVersion?: number;
} & (InventoryProductProfileCreateInput | InventoryProductProfileUpdatePatch);

export interface InventoryProductProfileReadInput {
  itemId: string;
}

export interface BuildConfigurationListInput extends PageInput {
  projectRevisionId: string;
}

export interface BuildConfigurationReadInput {
  buildConfigurationId: string;
}

export interface InventoryCreateInput {
  name: string;
  category: string;
  categoryNodeId?: string;
  quantity: Quantity;
  evidence: EvidenceSummary;
  description?: string;
  manufacturer?: string;
  model?: string;
  sku?: string;
  dimensions?: Dimensions;
  condition?: InventoryItem["condition"];
  location?: string;
  links?: readonly InventoryLinkInput[];
}

export interface InventoryUpdateInput {
  itemId: string;
  expectedVersion?: number;
  name?: string;
  category?: string;
  categoryNodeId?: string | null;
  description?: string;
  manufacturer?: string;
  model?: string;
  sku?: string;
  dimensions?: Dimensions;
  condition?: InventoryItem["condition"];
  location?: string;
  tags?: readonly string[];
  links?: readonly InventoryLinkInput[];
}

export type InventoryBulkCondition = "new" | "good" | "worn" | "needs_repair" | "unknown";

export interface InventoryBulkUpdateChanges {
  location?: string;
  condition?: InventoryBulkCondition;
  tags?: { add?: readonly string[]; remove?: readonly string[] };
}

export interface InventoryBulkUpdateTarget {
  itemId: string;
  expectedVersion: number;
}

export interface InventoryBulkUpdateInput {
  targets: readonly InventoryBulkUpdateTarget[];
  changes: InventoryBulkUpdateChanges;
}

export interface InventoryBulkUpdateItemRef {
  itemId: string;
  version: number;
}

export interface InventoryBulkUpdateResult {
  updated: readonly InventoryBulkUpdateItemRef[];
  unchanged: readonly InventoryBulkUpdateItemRef[];
  auditIds: readonly string[];
  correlationId?: string;
  replayed?: boolean;
}

export interface InventoryCommissionInput {
  itemId: string;
  expectedVersion: number;
  quantity: Quantity;
  evidence: Omit<EvidenceSummary, "state"> & { state: "commissioned" };
}

export type StockEventKind = "receipt" | "count_correction" | "allocation" | "return" | "use" | "loss" | "disposal";

export interface RecordStockEventInput {
  itemId: string;
  kind: StockEventKind;
  quantity: Quantity;
  note?: string;
}

export interface StockEvent {
  id: string;
  itemId: string;
  kind: StockEventKind;
  quantity: Quantity;
  recordedAt: string;
  actorId: string;
  note?: string;
  evidence?: EvidenceSummary;
}

export interface WriteResult<T = unknown> {
  id: string;
  version: number;
  auditId?: string;
  [key: string]: JsonValue | T | undefined;
}

export interface StockEventResult {
  eventId: string;
  itemId: string;
  resultingQuantity: Quantity;
  version: number;
  auditId?: string;
}

export interface StockEventsInput extends PageInput {
  itemId: string;
}

export interface Project {
  id: string;
  name: string;
  /** The project lifecycle is intentionally distinct from revision evidence. */
  status: ApiProjectLifecycle;
  visibility: "private" | "public";
  description?: string;
  version: number;
  updatedAt?: string;
}

export interface ProjectTombstone {
  id: string;
  name: string;
  removedAt: string;
  removedBy: string;
  lastLifecycleStatus: ApiProjectLifecycle;
  releasedReservationIds: readonly string[];
  version: number;
  auditId?: string;
}

export interface ProjectRemovalHistoryEntry {
  id: string;
  action: string;
  actor: string;
  source: "ui" | "api" | "mcp" | "import" | "system";
  correlationId: string;
  idempotencyKey?: string;
  entityType: string;
  entityId: string;
  version?: number;
  createdAt: string;
}

export interface ProjectListInput extends PageInput {
  query?: string;
  status?: Project["status"];
}

export interface ProjectCreateInput {
  name: string;
  description?: string;
}

/**
 * The preferred first-project command.  A project and its initial planning
 * revision are committed by one application-service transaction.
 */
export interface ProjectWithInitialRevisionCreateInput extends ProjectCreateInput {
  /** Optional stable IDs make retries and import workflows deterministic. */
  projectId?: string;
  revisionId?: string;
  revisionSummary?: string;
  /** Intended manufacturing route for the initial planning revision. */
  fabricationRoute?: FabricationRoute;
  /** Exact owned printer item used for planning when the route is printed. */
  /** Null deliberately clears; omitted carries the current assignment forward. */
  intendedPrinterItemId?: string | null;
}

export interface ProjectUpdateInput {
  projectId: string;
  expectedVersion?: number;
  name?: string;
  description?: string;
  status?: Project["status"];
}

export interface ProjectWithInitialRevisionResult {
  id: string;
  version: number;
  project: Project;
  revision: Revision;
  auditId?: string;
  correlationId?: string;
  replayed?: boolean;
}

export interface WorkItem {
  id: string;
  projectId: string;
  name: string;
  kind: "part" | "assembly" | "electronics" | "firmware" | "document" | "other";
  description?: string;
  version?: number;
}

export interface WorkItemCreateInput {
  projectId: string;
  name: string;
  kind: WorkItem["kind"];
  description?: string;
}

export type FabricationRoute = "printed" | "ready_made" | "none" | "undecided";

export interface Revision {
  id: string;
  number: number;
  status: "concept" | "cad_complete" | "dfam_reviewed" | "mesh_validated" | "slicer_validated" | "test_printed" | "fit_function_verified" | "production_approved" | "draft" | "frozen" | "retired";
  projectId?: string;
  workItemId?: string;
  summary?: string;
  /** Canonical manufacturing route; legacy records are projected as undecided. */
  fabricationRoute: FabricationRoute;
  /** Planning-only printer selection; it is not a BOM or build snapshot. */
  /** Null deliberately clears; omitted carries the current assignment forward. */
  intendedPrinterItemId?: string | null;
  version?: number;
}

export interface ProjectRevisionCreateInput {
  projectId: string;
  summary?: string;
  fabricationRoute?: FabricationRoute;
  intendedPrinterItemId?: string | null;
}

export interface ProjectRevisionUpdateInput {
  revisionId: string;
  expectedVersion: number;
  fabricationRoute?: FabricationRoute;
  /** Null explicitly clears the planning printer assignment. */
  intendedPrinterItemId?: string | null;
}

export interface WorkItemRevisionCreateInput {
  workItemId: string;
  summary?: string;
}

export interface RevisionReadInput {
  revisionId: string;
}

export interface ProjectContext {
  projectId: string;
  generatedAt: string;
  text: string;
  /** Same canonical lifecycle value returned by the project record. */
  status: Project["status"];
  /** Readiness is derived from the current BOM; it is never a lifecycle value. */
  blocked: ProjectBlocked;
  currentRevisionId?: string;
  /** The selected revision, including its persisted human-readable summary. */
  currentRevision?: Revision;
  nextActions?: readonly string[];
}

export interface ProjectBlockedReason {
  source: "bom";
  projectRevisionId: string;
  bomLineId: string;
  decision: "check" | "decide" | "source";
  reason: string;
}

export interface ProjectBlocked {
  blocked: boolean;
  reasons: readonly ProjectBlockedReason[];
}

export interface BomLine {
  id: string;
  projectRevisionId: string;
  description: string;
  quantity: number;
  unit: Quantity["unit"];
  requirement: "required" | "optional";
  /**
   * Whether using this requirement consumes stock or leaves it reusable.
   * Null is a legacy value whose intent must be reviewed before reserving,
   * consuming, or reconciling the line.
   */
  role?: "consumed" | "reusable" | null;
  itemId?: string;
  /** Structured alternatives preserve compatibility evidence and reasons. */
  alternatives?: readonly BomAlternative[];
  /** @deprecated Use alternatives when compatibility state or reason matters. */
  compatibleItemIds?: readonly string[];
  constraints?: BomConstraints;
  notes?: string;
  retiredAt?: string;
  version?: number;
}

export const BOM_CONSTRAINT_KEYS = ["kind", "manufacturer", "model", "sku", "tag", "nameIncludes"] as const;
export type BomConstraintKey = typeof BOM_CONSTRAINT_KEYS[number];
export type BomSpecificationDecision = "identity" | "purpose" | "voltage" | "current_or_load" | "connector" | "compatibility" | "dimensions" | "resistance" | "power_rating";
export type BomSpecificationDecisions = Readonly<Partial<Record<BomSpecificationDecision, string>>>;
export interface BomSpecification {
  status: "sufficient" | "insufficient";
  decisions?: BomSpecificationDecisions;
  missingDecisions?: readonly BomSpecificationDecision[];
}
export type BomConstraints = Readonly<Partial<Record<BomConstraintKey, string>> & { specification?: BomSpecification }>;
export type BomCompatibility = "confirmed" | "conditional" | "unknown";

export interface BomAlternative {
  itemId: string;
  compatible: BomCompatibility;
  reason?: string;
  /**
   * Evidence-backed package conversion. MCP uses `piece`; the REST and
   * application contracts use the equivalent canonical unit `each`.
   */
  quantityConversion?: BomAlternativeQuantityConversion;
}

export type QuantityConversionEvidenceBasis = "package_label" | "manufacturer_spec" | "physical_count" | "user_assertion";

export interface QuantityConversionEvidence {
  basis: QuantityConversionEvidenceBasis;
  observedAt: string;
  source?: string;
  sourceId?: string;
  note?: string;
}

export interface BomAlternativeQuantityConversion {
  inventory: { quantity: 1; unit: "set" };
  requirement: { quantity: number; unit: "piece" };
  evidence: QuantityConversionEvidence;
}

export type QuantityConversion = BomAlternativeQuantityConversion;

export interface BomLineListInput extends PageInput {
  projectRevisionId: string;
  includeRetired?: boolean;
}

export interface BomLineCreateInput {
  projectRevisionId: string;
  description: string;
  quantity: number;
  unit: Quantity["unit"];
  requirement?: BomLine["requirement"];
  role?: BomLine["role"];
  itemId?: string;
  alternatives?: readonly BomAlternative[];
  /** @deprecated Use alternatives when compatibility state or reason matters. */
  compatibleItemIds?: readonly string[];
  constraints?: BomConstraints;
  notes?: string;
}

export interface BomLineUpdateInput {
  bomLineId: string;
  expectedVersion?: number;
  description?: string;
  quantity?: number;
  unit?: Quantity["unit"];
  requirement?: BomLine["requirement"];
  role?: BomLine["role"];
  itemId?: string;
  alternatives?: readonly BomAlternative[];
  /** @deprecated Use alternatives when compatibility state or reason matters. */
  compatibleItemIds?: readonly string[];
  constraints?: BomConstraints;
  notes?: string;
}

export interface BomEvaluationInput {
  projectRevisionId: string;
}

export interface BomEvaluation {
  projectRevisionId: string;
  generatedAt: string;
  lines: readonly BomEvaluationLine[];
  totals: {
    required: number;
    optional: number;
    supplied: number;
    inspectFirst: number;
    partial: number;
    missing: number;
    ready: number;
    check: number;
    decide: number;
    source: number;
  };
}

export interface BomEvaluationLine {
  bomLineId: string;
  description: string;
  requested: Quantity;
  requirement: "required" | "optional";
  state: "supplied" | "inspect_first" | "specify_first" | "partial" | "missing" | "optional";
  decision: "ready" | "check" | "decide" | "source";
  missingDecisions?: readonly BomSpecificationDecision[];
  supplied: Quantity;
  matches: readonly BomMatch[];
  recommendedAction: "reuse" | "inspect" | "specify" | "buy" | "none";
  explanation: string;
}

export interface BomMatch {
  itemId: string;
  /** Backward-compatible alias for a uniquely attributed supplied quantity. */
  quantity?: Quantity;
  availableQuantity: Quantity;
  suppliedQuantity: Quantity;
  inspectQuantity: Quantity;
  availability: Availability;
  compatible: BomCompatibility;
  reason: string;
  /** Conversion evidence when candidate quantities are requirement-side pieces. */
  quantityConversion?: BomAlternativeQuantityConversion;
}

export interface ReservationInput {
  projectRevisionId: string;
  bomLineId: string;
  itemId: string;
  quantity: Quantity;
}

export interface ReservationListInput extends PageInput {
  projectRevisionId: string;
}

export interface ReservationReadInput {
  reservationId: string;
}

export interface Reservation {
  id: string;
  projectRevisionId: string;
  bomLineId: string;
  itemId: string;
  quantity: Quantity;
  status: "active" | "released" | "consumed" | "settled";
  version: number;
}

export interface ReleaseReservationInput {
  reservationId: string;
  expectedVersion?: number;
}

export interface UsageInput {
  projectRevisionId: string;
  reservationId: string;
  itemId: string;
  quantity: Quantity;
  note?: string;
}

export interface UsageResult {
  usageEventId: string;
  itemId: string;
  quantity: Quantity;
  resultingQuantity?: Quantity;
  version: number;
  auditId?: string;
}

export interface Artifact {
  id: string;
  projectId: string;
  projectRevisionId?: string;
  workItemId?: string;
  workItemRevisionId?: string;
  filename: string;
  role: "source" | "cad" | "cad_source" | "step" | "stl" | "three_mf" | "slicer_project" | "gcode" | "drawing" | "validation" | "document" | "brief" | "design_record" | "firmware" | "photo" | "text" | "other";
  mediaType: string;
  byteLength: number;
  sha256: string;
  revision: number;
  status: "candidate" | "frozen" | "retired";
  createdAt?: string;
}

/**
 * Artifact ancestry is intentionally a closed union.  A project artifact is
 * addressed by its exact project revision; a work-item artifact is addressed
 * by both the work item and its exact revision.  The all-project branch is
 * read-only list access and carries no revision filter.
 */
export type ArtifactScope =
  | { projectRevisionId: string }
  | { workItemId: string; workItemRevisionId: string };

export type ArtifactListScope = ArtifactScope | {
  projectRevisionId?: never;
  workItemId?: never;
  workItemRevisionId?: never;
};

export type ArtifactListInput = PageInput & {
  projectId: string;
  role?: Artifact["role"];
} & ArtifactListScope;

export interface ArtifactMetadataInput {
  artifactId: string;
  revisionId?: string;
}

export type BeginArtifactUploadInput = {
  projectId: string;
  filename: string;
  role: Artifact["role"];
  mediaType: string;
  byteLength: number;
  sha256: string;
} & (
  | (Extract<ArtifactScope, { projectRevisionId: string }> & {
      /** Optional immutable build-configuration snapshot to bind at finalize. */
      buildConfigurationSnapshotId?: string;
    })
  | Extract<ArtifactScope, { workItemId: string }>
);

export interface ArtifactUploadTicket {
  uploadId: string;
  uploadUrl: string;
  expiresAt: string;
  maxBytes: number;
  method: "PUT" | "POST";
  requiredHeaders?: Readonly<Record<string, string>>;
  /** A separate one-use capability for the finalize step. */
  finalizeUrl?: string;
  finalizeHeaders?: Readonly<Record<string, string>>;
}

export interface FinalizeArtifactUploadInput {
  uploadId: string;
}

export interface ArtifactDownloadMetadataInput {
  artifactId: string;
  revisionId?: string;
}

export interface ArtifactDownloadMetadata {
  artifactId: string;
  revisionId: string;
  filename: string;
  byteLength: number;
  sha256: string;
  downloadUrl: string;
  expiresAt: string;
  /** The capability is deliberately carried in a header, never in the URL. */
  requiredHeaders?: Readonly<Record<string, string>>;
}

/**
 * Legacy HTTP-host issuer for direct browser/HTTP transfer routes. Generic MCP
 * never invokes this provider because it cannot safely expose the resulting
 * URL/header capability to a model. It remains available to the authenticated
 * HTTP routes.
 */
export interface ArtifactTransferProvider {
  issueUpload(input: {
    uploadId: string;
    projectId: string;
    expiresAt: string;
    byteLength: number;
    sha256: string;
    actor: string;
  }): Promise<{
    uploadUrl: string;
    uploadHeaders: Readonly<Record<string, string>>;
    finalizeUrl: string;
    finalizeHeaders: Readonly<Record<string, string>>;
    expiresAt: string;
  }> | {
    uploadUrl: string;
    uploadHeaders: Readonly<Record<string, string>>;
    finalizeUrl: string;
    finalizeHeaders: Readonly<Record<string, string>>;
    expiresAt: string;
  };
  issueDownload(input: {
    artifactId: string;
    projectId: string;
    byteLength: number;
    sha256: string;
    actor: string;
  }): Promise<{
    downloadUrl: string;
    requiredHeaders: Readonly<Record<string, string>>;
    expiresAt: string;
  }> | {
    downloadUrl: string;
    requiredHeaders: Readonly<Record<string, string>>;
    expiresAt: string;
  };
}

export interface RetireArtifactInput {
  artifactId: string;
  expectedVersion?: number;
}

export interface Offer {
  id: string;
  itemId?: string;
  description?: string;
  supplier: string;
  url: string;
  packageQuantity?: Quantity;
  price: { minor: number; currency: string };
  shippingMinor?: number;
  observedAt: string;
  expiresAt?: string;
  evidence?: EvidenceSummary;
}

export interface OfferListInput extends PageInput {
  itemId?: string;
  query?: string;
  supplier?: string;
}

export interface RecordOfferSnapshotInput {
  itemId?: string;
  description?: string;
  supplier: string;
  url: string;
  packageQuantity?: Quantity;
  price: { minor: number; currency: string };
  shippingMinor?: number;
  observedAt?: string;
}

export interface ContextRefreshInput {
  projectId?: string;
  includeInventory?: boolean;
  maxAgeSeconds?: number;
}

export interface RefreshedContext {
  generatedAt: string;
  expiresAt: string;
  inventorySummaryUri: string;
  projectUris: readonly string[];
  note?: string;
}

export interface InventoryBackend {
  summary(input: PageInput, context: McpRequestContext): Promise<InventorySummary>;
  list(input: InventoryListInput, context: McpRequestContext): Promise<Page<InventoryItem>>;
  get(input: { itemId: string }, context: McpRequestContext): Promise<InventoryItem>;
  create(input: InventoryCreateInput, context: McpRequestContext): Promise<WriteResult<InventoryItem>>;
  /** Atomically create a physical inventory item and its exact product profile. */
  createWithProductProfile?(input: InventoryWithProductProfileCreateInput, context: McpRequestContext): Promise<InventoryWithProductProfileResult>;
  update(input: InventoryUpdateInput, context: McpRequestContext): Promise<WriteResult<InventoryItem>>;
  bulkUpdate(input: InventoryBulkUpdateInput, context: McpRequestContext): Promise<InventoryBulkUpdateResult>;
  /** Promote uncertain evidence through an observed quantity and append-only event. */
  commission?(input: InventoryCommissionInput, context: McpRequestContext): Promise<WriteResult<InventoryItem>>;
  recordStockEvent(input: RecordStockEventInput, context: McpRequestContext): Promise<StockEventResult>;
  listStockEvents(input: StockEventsInput, context: McpRequestContext): Promise<Page<StockEvent>>;
}

export type InventoryCategory = ApiInventoryCategory;
export type InventoryCategoryCreateInput = ApiCreateInventoryCategory;
export type InventoryCategoryUpdateInput = ApiUpdateInventoryCategory;

export interface InventoryCategoriesBackend {
  list(input: PageInput & { includeArchived?: boolean }, context: McpRequestContext): Promise<Page<InventoryCategory>>;
  get(input: { categoryId: string }, context: McpRequestContext): Promise<InventoryCategory>;
  create(input: InventoryCategoryCreateInput, context: McpRequestContext): Promise<WriteResult<InventoryCategory>>;
  update(input: { categoryId: string; expectedVersion: number } & InventoryCategoryUpdateInput, context: McpRequestContext): Promise<WriteResult<InventoryCategory>>;
  archive(input: { categoryId: string; expectedVersion: number }, context: McpRequestContext): Promise<WriteResult<InventoryCategory>>;
}

export interface ProjectsBackend {
  list(input: ProjectListInput, context: McpRequestContext): Promise<Page<Project>>;
  listRemoved?(input: PageInput, context: McpRequestContext): Promise<Page<ProjectTombstone>>;
  get(input: { projectId: string }, context: McpRequestContext): Promise<Project>;
  create(input: ProjectCreateInput, context: McpRequestContext): Promise<WriteResult<Project>>;
  createWithInitialRevision(input: ProjectWithInitialRevisionCreateInput, context: McpRequestContext): Promise<ProjectWithInitialRevisionResult>;
  previewSetup?(input: ProjectSetupProposal, context: McpRequestContext): Promise<ProjectSetupPreview>;
  commitSetup?(input: CommitProjectSetupInput, context: McpRequestContext): Promise<ProjectSetupCommitResult & { auditId?: string; correlationId?: string; replayed?: boolean }>;
  update(input: ProjectUpdateInput, context: McpRequestContext): Promise<WriteResult<Project>>;
  retire(input: { projectId: string; expectedVersion?: number }, context: McpRequestContext): Promise<WriteResult>;
  /** Canonical reversible lifecycle command; retire remains a compatibility alias. */
  archive?(input: { projectId: string; expectedVersion?: number }, context: McpRequestContext): Promise<WriteResult<Project>>;
  restore?(input: { projectId: string; expectedVersion?: number }, context: McpRequestContext): Promise<WriteResult<Project>>;
  remove?(input: { projectId: string; expectedVersion: number; projectName: string }, context: McpRequestContext): Promise<WriteResult<ProjectTombstone>>;
  readRemovedHistory?(input: { projectId: string } & PageInput, context: McpRequestContext): Promise<Page<ProjectRemovalHistoryEntry>>;
  createWorkItem(input: WorkItemCreateInput, context: McpRequestContext): Promise<WriteResult<WorkItem>>;
  getWorkItem(input: { workItemId: string }, context: McpRequestContext): Promise<WorkItem>;
  createProjectRevision(input: ProjectRevisionCreateInput, context: McpRequestContext): Promise<WriteResult<Revision>>;
  updateProjectRevision?(input: ProjectRevisionUpdateInput, context: McpRequestContext): Promise<WriteResult<Revision>>;
  getProjectRevision(input: RevisionReadInput, context: McpRequestContext): Promise<Revision>;
  createWorkItemRevision(input: WorkItemRevisionCreateInput, context: McpRequestContext): Promise<WriteResult<Revision>>;
  getWorkItemRevision(input: RevisionReadInput, context: McpRequestContext): Promise<Revision>;
  context(input: { projectId: string }, context: McpRequestContext): Promise<ProjectContext>;
}

export interface BomBackend {
  listLines(input: BomLineListInput, context: McpRequestContext): Promise<Page<BomLine>>;
  /** Optional explicit project-to-current-revision lookup for the project BOM resource. */
  listProjectLines?(input: { projectId: string } & PageInput, context: McpRequestContext): Promise<Page<BomLine>>;
  createLine(input: BomLineCreateInput, context: McpRequestContext): Promise<WriteResult<BomLine>>;
  updateLine(input: BomLineUpdateInput, context: McpRequestContext): Promise<WriteResult<BomLine>>;
  retireLine(input: { bomLineId: string; expectedVersion: number }, context: McpRequestContext): Promise<WriteResult>;
  restoreLine(input: { bomLineId: string; expectedVersion: number }, context: McpRequestContext): Promise<WriteResult>;
  evaluate(input: BomEvaluationInput, context: McpRequestContext): Promise<BomEvaluation>;
  /** Read reservation state within one project revision with bounded pagination. */
  listReservations?(input: ReservationListInput, context: McpRequestContext): Promise<Page<Reservation>>;
  /** Read one reservation after resolving its durable project/revision identity. */
  getReservation?(input: ReservationReadInput, context: McpRequestContext): Promise<Reservation>;
  reserve(input: ReservationInput, context: McpRequestContext): Promise<Reservation>;
  release(input: ReleaseReservationInput, context: McpRequestContext): Promise<Reservation>;
  recordUsage(input: UsageInput, context: McpRequestContext): Promise<UsageResult>;
}

export interface ArtifactsBackend {
  list(input: ArtifactListInput, context: McpRequestContext): Promise<Page<Artifact>>;
  getMetadata(input: ArtifactMetadataInput, context: McpRequestContext): Promise<Artifact>;
  beginUpload(input: BeginArtifactUploadInput, context: McpRequestContext): Promise<ArtifactUploadTicket>;
  finalizeUpload(input: FinalizeArtifactUploadInput, context: McpRequestContext): Promise<Artifact>;
  downloadMetadata(input: ArtifactDownloadMetadataInput, context: McpRequestContext): Promise<ArtifactDownloadMetadata>;
  retire(input: RetireArtifactInput, context: McpRequestContext): Promise<WriteResult>;
}

export interface OffersBackend {
  list(input: OfferListInput, context: McpRequestContext): Promise<Page<Offer>>;
  recordSnapshot(input: RecordOfferSnapshotInput, context: McpRequestContext): Promise<WriteResult<Offer>>;
}

export interface ContextBackend {
  refresh(input: ContextRefreshInput, context: McpRequestContext): Promise<RefreshedContext>;
}

export interface CatalogBackend {
  search(input: CatalogProductSearchInput, context: McpRequestContext): Promise<Page<CatalogProduct>>;
  get(input: { productId: string }, context: McpRequestContext): Promise<CatalogProduct>;
  create(input: CatalogProductCreateInput, context: McpRequestContext): Promise<WriteResult<CatalogProduct>>;
  update(input: CatalogProductUpdateInput, context: McpRequestContext): Promise<WriteResult<CatalogProduct>>;
  readProfile(input: InventoryProductProfileReadInput, context: McpRequestContext): Promise<InventoryProductProfile>;
  linkProfile(input: InventoryProductProfileLinkInput, context: McpRequestContext): Promise<WriteResult<InventoryProductProfile>>;
}

export interface BuildConfigurationsBackend {
  create(input: BuildConfigurationCreateInput, context: McpRequestContext): Promise<WriteResult<BuildConfigurationSnapshot>>;
  list(input: BuildConfigurationListInput, context: McpRequestContext): Promise<Page<BuildConfigurationSnapshot>>;
  get(input: BuildConfigurationReadInput, context: McpRequestContext): Promise<BuildConfigurationSnapshot>;
}

export interface ReconciliationBackend {
  read(input: ReconciliationReadInput, context: McpRequestContext): Promise<ReconciliationDraft | null>;
  save(input: ReconciliationDraftSaveInput, context: McpRequestContext): Promise<WriteResult<ReconciliationDraft>>;
  commit(input: ReconciliationCommitInput, context: McpRequestContext): Promise<WriteResult<ReconciliationCommit>>;
}

export interface InspectionsBackend {
  list(input: InspectionListInput, context: McpRequestContext): Promise<Page<InspectionAction>>;
  get(input: InspectionReadInput, context: McpRequestContext): Promise<InspectionAction>;
  preview(input: InspectionPreviewInput, context: McpRequestContext): Promise<InspectionPreview>;
  commit(input: InspectionCommitInput, context: McpRequestContext): Promise<WriteResult<InspectionCommit>>;
}

export interface BenchLedgerBackend {
  inventory: InventoryBackend;
  inventoryCategories?: InventoryCategoriesBackend;
  /** Optional for backwards-compatible hosts that have not enabled the v2 catalog. */
  catalog?: CatalogBackend;
  projects: ProjectsBackend;
  /** Optional for backwards-compatible hosts that have not enabled v2 snapshots. */
  buildConfigurations?: BuildConfigurationsBackend;
  /** Optional for backwards-compatible hosts that have not enabled close-out. */
  reconciliation?: ReconciliationBackend;
  inspections?: InspectionsBackend;
  bom: BomBackend;
  artifacts: ArtifactsBackend;
  offers: OffersBackend;
  context: ContextBackend;
  /**
   * Read-only ancestry lookups used by the adapter before an indirect-ID
   * operation is dispatched. Production backends should implement all
   * applicable lookups; scoped callers fail closed when one is unavailable.
   */
  projectScope?: ProjectScopeResolvers;
}

export interface ProjectScopeResolvers {
  projectForWorkItem?(workItemId: string): Promise<string | null>;
  projectForProjectRevision?(revisionId: string): Promise<string | null>;
  projectForWorkItemRevision?(revisionId: string): Promise<string | null>;
  projectForBomLine?(bomLineId: string): Promise<string | null>;
  projectForReservation?(reservationId: string): Promise<string | null>;
  projectForArtifact?(artifactId: string): Promise<string | null>;
  projectForUpload?(uploadId: string): Promise<string | null>;
  projectForBuildConfiguration?(buildConfigurationId: string): Promise<string | null>;
  /** Durable reservation identity used to return the actual revision/unit. */
  reservationDetails?(reservationId: string): Promise<ReservationDetails | null>;
}

export interface ReservationDetails {
  projectId: string;
  projectRevisionId: string;
  bomLineId: string;
  itemId: string;
  unit: Quantity["unit"];
}

export interface McpContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: readonly McpContent[];
  structuredContent: JsonObject;
  isError: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  requiredScope: Scope;
  mutating: boolean;
  /** The host must obtain explicit human approval before this mutation. */
  approvalRequired?: boolean;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: "application/json" | "text/plain";
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: "application/json" | "text/plain";
}

export interface McpResourceContent {
  uri: string;
  mimeType: "application/json" | "text/plain";
  text: string;
}

export interface McpResourceReadResult {
  contents: readonly McpResourceContent[];
}

export interface McpServerInfo {
  name: string;
  version: string;
}
