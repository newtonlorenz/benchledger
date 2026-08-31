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
  availability: Availability;
  evidence: EvidenceSummary;
  description?: string;
  manufacturer?: string;
  model?: string;
  sku?: string;
  dimensions?: Dimensions;
  condition?: "new" | "used" | "opened" | "unknown";
  location?: string;
  links: readonly ExternalLink[];
  version?: number;
}

export interface InventorySummary {
  generatedAt: string;
  counts: {
    totalItems: number;
    confirmedItems: number;
    inspectFirstItems: number;
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
export type BuildConfigurationSnapshot = ApiBuildConfigurationSnapshot;
export type BuildConfigurationCreateInput = ApiCreateBuildConfigurationSnapshot;
export type ReconciliationDraft = ApiReconciliationDraft;
export type ReconciliationCommit = ApiReconciliationCommit;
export type ReconciliationDraftSaveInput = ApiSaveReconciliationDraft;
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
  links?: readonly InventoryLinkInput[];
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
  status: "active" | "paused" | "complete" | "retired";
  visibility: "private" | "public";
  description?: string;
  version: number;
  updatedAt?: string;
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

export interface Revision {
  id: string;
  number: number;
  status: "concept" | "cad_complete" | "dfam_reviewed" | "mesh_validated" | "slicer_validated" | "test_printed" | "fit_function_verified" | "production_approved" | "draft" | "frozen" | "retired";
  projectId?: string;
  workItemId?: string;
  summary?: string;
  version?: number;
}

export interface ProjectRevisionCreateInput {
  projectId: string;
  summary?: string;
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
  currentRevisionId?: string;
  nextActions?: readonly string[];
}

export interface BomLine {
  id: string;
  projectRevisionId: string;
  description: string;
  quantity: number;
  unit: Quantity["unit"];
  requirement: "required" | "optional";
  itemId?: string;
  /** Structured alternatives preserve compatibility evidence and reasons. */
  alternatives?: readonly BomAlternative[];
  /** @deprecated Use alternatives when compatibility state or reason matters. */
  compatibleItemIds?: readonly string[];
  constraints?: BomConstraints;
  notes?: string;
  version?: number;
}

export const BOM_CONSTRAINT_KEYS = ["kind", "manufacturer", "model", "sku", "tag", "nameIncludes"] as const;
export type BomConstraintKey = typeof BOM_CONSTRAINT_KEYS[number];
export type BomConstraints = Readonly<Partial<Record<BomConstraintKey, string>>>;
export type BomCompatibility = "confirmed" | "conditional" | "unknown";

export interface BomAlternative {
  itemId: string;
  compatible: BomCompatibility;
  reason?: string;
}

export interface BomLineListInput extends PageInput {
  projectRevisionId: string;
}

export interface BomLineCreateInput {
  projectRevisionId: string;
  description: string;
  quantity: number;
  unit: Quantity["unit"];
  requirement?: BomLine["requirement"];
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
    supplied: number;
    inspectFirst: number;
    partial: number;
    missing: number;
  };
}

export interface BomEvaluationLine {
  bomLineId: string;
  description: string;
  requested: Quantity;
  state: "supplied" | "inspect_first" | "partial" | "missing" | "optional";
  supplied: Quantity;
  matches: readonly BomMatch[];
  recommendedAction: "reuse" | "inspect" | "buy" | "none";
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
}

export interface ReservationInput {
  projectRevisionId: string;
  bomLineId: string;
  itemId: string;
  quantity: Quantity;
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
  reservationId?: string;
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

export interface ArtifactListInput extends PageInput {
  projectId: string;
  workItemId?: string;
  revisionId?: string;
  role?: Artifact["role"];
}

export interface ArtifactMetadataInput {
  artifactId: string;
  revisionId?: string;
}

export interface BeginArtifactUploadInput {
  projectId: string;
  projectRevisionId?: string;
  /** Optional immutable build-configuration snapshot to bind at finalize. */
  buildConfigurationSnapshotId?: string;
  workItemId?: string;
  workItemRevisionId?: string;
  filename: string;
  role: Artifact["role"];
  mediaType: string;
  byteLength: number;
  sha256?: string;
}

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
 * The application adapter does not mint or validate transport credentials.
 * An HTTP host supplies this small provider so the MCP package remains
 * model-neutral while still returning usable, bounded transfer links.
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
  get(input: { projectId: string }, context: McpRequestContext): Promise<Project>;
  create(input: ProjectCreateInput, context: McpRequestContext): Promise<WriteResult<Project>>;
  createWithInitialRevision(input: ProjectWithInitialRevisionCreateInput, context: McpRequestContext): Promise<ProjectWithInitialRevisionResult>;
  update(input: ProjectUpdateInput, context: McpRequestContext): Promise<WriteResult<Project>>;
  retire(input: { projectId: string; expectedVersion?: number }, context: McpRequestContext): Promise<WriteResult>;
  createWorkItem(input: WorkItemCreateInput, context: McpRequestContext): Promise<WriteResult<WorkItem>>;
  getWorkItem(input: { workItemId: string }, context: McpRequestContext): Promise<WorkItem>;
  createProjectRevision(input: ProjectRevisionCreateInput, context: McpRequestContext): Promise<WriteResult<Revision>>;
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
  retireLine(input: { bomLineId: string; expectedVersion?: number }, context: McpRequestContext): Promise<WriteResult>;
  evaluate(input: BomEvaluationInput, context: McpRequestContext): Promise<BomEvaluation>;
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
