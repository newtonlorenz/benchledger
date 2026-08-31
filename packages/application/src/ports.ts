import type {
  Artifact, BomGap, BomLine, CreateBomLine, CreateInventoryItem, CreateOffer,
  CreateProject, CreateProjectRevision, CreateProjectWithInitialRevision, CreateReservation, CreateWorkItem,
  CreateWorkItemRevision, InventoryItem, InventoryListQuery, Offer, Project,
  ProjectRevision, ProjectWithInitialRevision, Reservation, StockEvent, StockEventInput, UploadSession,
  WorkItem, WorkItemRevision, CatalogProduct as ApiCatalogProduct,
  CreateCatalogProduct as ApiCreateCatalogProduct, UpdateCatalogProduct as ApiUpdateCatalogProduct,
  InventoryProductProfile as ApiInventoryProductProfile,
  CreateInventoryProductProfile as ApiCreateInventoryProductProfile,
  UpdateInventoryProductProfile as ApiUpdateInventoryProductProfile,
  BuildConfigurationSnapshot as ApiBuildConfigurationSnapshot,
  CreateBuildConfigurationSnapshot as ApiCreateBuildConfigurationSnapshot,
  ArtifactBuildConfigurationBinding as ApiArtifactBuildConfigurationBinding,
  CommissionInventoryItem,
  ReconciliationCommit,
  ReconciliationDraft,
  ReconciliationBasis,
  ReconciliationLine,
  ReconciliationPreview
} from "@benchledger/api-contract";
import type {
  InventoryCategory as ApiInventoryCategory,
  CreateInventoryCategory as ApiCreateInventoryCategory,
  UpdateInventoryCategory as ApiUpdateInventoryCategory,
  InventoryCategoryListQuery as ApiInventoryCategoryListQuery,
} from "@benchledger/api-contract";

/** Application aliases intentionally re-export the canonical API contracts. */
export type CatalogProduct = ApiCatalogProduct;
export type CreateCatalogProduct = ApiCreateCatalogProduct;
export type UpdateCatalogProduct = ApiUpdateCatalogProduct;
export type InventoryProductProfile = ApiInventoryProductProfile;
export type CreateInventoryProductProfile = ApiCreateInventoryProductProfile;
export type UpdateInventoryProductProfile = ApiUpdateInventoryProductProfile;
export type BuildConfiguration = ApiBuildConfigurationSnapshot;
export type CreateBuildConfiguration = ApiCreateBuildConfigurationSnapshot;
export type CatalogProductKind = CatalogProduct["kind"];
export type CatalogProductLinkStatus = InventoryProductProfile["linkState"];
export type InventoryCategory = ApiInventoryCategory;
export type CreateInventoryCategory = ApiCreateInventoryCategory;
export type UpdateInventoryCategory = ApiUpdateInventoryCategory;

export interface CatalogProductListOptions {
  readonly q?: string;
  readonly kind?: CatalogProductKind;
  readonly limit: number;
  readonly cursor?: string;
}

export interface BuildConfigurationListOptions {
  readonly limit: number;
  readonly cursor?: string;
}

export interface CatalogPort {
  listProducts(options: CatalogProductListOptions): Promise<Page<CatalogProduct>>;
  getProduct(id: string): Promise<CatalogProduct | null>;
  createProduct(input: CreateCatalogProduct, ctx: RequestContext): Promise<CatalogProduct>;
  updateProduct(id: string, input: UpdateCatalogProduct, expectedVersion: number | undefined, ctx: RequestContext): Promise<CatalogProduct>;
  getInventoryProductProfile(itemId: string): Promise<InventoryProductProfile | null>;
  putInventoryProductProfile(itemId: string, input: CreateInventoryProductProfile | UpdateInventoryProductProfile, expectedVersion: number | undefined, ctx: RequestContext): Promise<InventoryProductProfile>;
  /**
   * Compensate a profile created by the compound inventory/profile command.
   * This is intentionally not a public delete operation: adapters must only
   * remove the just-created version-1 profile for the matching inventory item.
   */
  rollbackCreatedProfile?(profileId: string, itemId: string): Promise<void>;
}

export interface BuildConfigurationPort {
  listBuildConfigurations(revisionId: string, options: BuildConfigurationListOptions): Promise<Page<BuildConfiguration>>;
  /** Read the newest snapshot without scanning an ascending bounded page. */
  getLatestBuildConfiguration(revisionId: string): Promise<BuildConfiguration | null>;
  getBuildConfiguration(id: string): Promise<BuildConfiguration | null>;
  createBuildConfiguration(input: CreateBuildConfiguration, ctx: RequestContext): Promise<BuildConfiguration>;
}

export interface ReconciliationCommitInput {
  readonly id: string;
  readonly draftId: string;
  readonly projectId: string;
  readonly projectRevisionId: string;
  readonly expectedDraftVersion: number;
  readonly basis: ReconciliationBasis;
  readonly lines: readonly ReconciliationLine[];
  readonly preview: ReconciliationPreview;
  readonly committedAt: string;
}

/** Storage/runtime seam for the review-first close-out aggregate. */
export interface ReconciliationPort {
  getDraft(projectRevisionId: string): Promise<ReconciliationDraft | null>;
  saveDraft(draft: ReconciliationDraft, expectedVersion: number | undefined): Promise<ReconciliationDraft>;
  /** Re-read the canonical basis and apply every effect in one transaction. */
  commit(input: ReconciliationCommitInput, ctx: RequestContext): Promise<ReconciliationCommit>;
}

export type RequestSource = "ui" | "api" | "mcp" | "import" | "system";

export interface RequestContext {
  readonly actor: string;
  readonly source: RequestSource;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  /** Stable digest of the command payload, used to detect key reuse with different input. */
  readonly fingerprint?: string;
  readonly scopes: ReadonlySet<string>;
  readonly projectId?: string;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor?: string;
  readonly limit: number;
  readonly total?: number;
}

export interface InventoryListOptions {
  readonly q?: string;
  readonly kind?: InventoryListQuery["kind"];
  readonly evidence?: InventoryListQuery["evidence"];
  readonly available?: boolean;
  /** Exact managed taxonomy node; applied before ordering and pagination. */
  readonly categoryNodeId?: InventoryListQuery["categoryNodeId"];
  /** Select only legacy items with no managed taxonomy assignment. */
  readonly unassigned?: boolean;
  readonly limit: number;
  readonly cursor?: string;
  readonly includeRetired?: boolean;
}

export type InventoryCategoryListOptions = ApiInventoryCategoryListQuery;

export interface InventoryCategoryPort {
  listCategories(options: InventoryCategoryListOptions): Promise<Page<InventoryCategory>>;
  getCategory(id: string): Promise<InventoryCategory | null>;
  createCategory(input: CreateInventoryCategory, ctx: RequestContext): Promise<InventoryCategory>;
  updateCategory(id: string, input: UpdateInventoryCategory, expectedVersion: number, ctx: RequestContext): Promise<InventoryCategory>;
  archiveCategory(id: string, expectedVersion: number, ctx: RequestContext): Promise<InventoryCategory>;
  /** Internal additive assignment seam used by inventory adapters. */
  getItemCategoryNode?(itemId: string): Promise<string | null>;
  assignItemCategory?(itemId: string, categoryNodeId: string | null): Promise<void>;
}

export interface UpdateInventoryInput {
  readonly name?: string;
  readonly kind?: InventoryItem["kind"];
  readonly description?: string;
  readonly manufacturer?: string;
  readonly model?: string;
  readonly sku?: string;
  readonly categoryNodeId?: string | null;
  readonly quantity?: number;
  readonly unit?: InventoryItem["unit"];
  readonly location?: string;
  readonly condition?: NonNullable<InventoryItem["condition"]>;
  readonly dimensions?: InventoryItem["dimensions"];
  readonly tags?: readonly string[];
  readonly links?: readonly InventoryItem["links"][number][];
  readonly evidence?: InventoryItem["evidence"];
}

export interface StockMutation {
  readonly event: StockEvent;
  readonly item: InventoryItem;
}

export interface InventoryPort {
  listItems(options: InventoryListOptions): Promise<Page<InventoryItem>>;
  getItem(id: string): Promise<InventoryItem | null>;
  createItem(input: CreateInventoryItem, ctx: RequestContext): Promise<InventoryItem>;
  /**
   * Compensate an item created by the compound inventory/profile command.
   * Implementations must make this safe for only a just-created item.
   */
  rollbackCreatedItem?(itemId: string): Promise<void>;
  updateItem(id: string, input: UpdateInventoryInput, expectedVersion: number | undefined, ctx: RequestContext): Promise<InventoryItem>;
  /** Record an observed physical count and promote its evidence atomically. */
  recordPhysicalCount?(itemId: string, quantity: number, ctx: RequestContext, note?: string): Promise<StockMutation>;
  /** Record an observed count that deliberately promotes uncertain evidence to commissioned. */
  commissionItem?(itemId: string, input: CommissionInventoryItem, expectedVersion: number | undefined, ctx: RequestContext): Promise<StockMutation>;
  recordStockEvent(input: StockEventInput, ctx: RequestContext): Promise<StockMutation>;
  listStockEvents(itemId: string, limit: number, cursor?: string): Promise<Page<StockEvent>>;
}

export interface ProjectListOptions {
  readonly q?: string;
  readonly status?: Project["status"];
  readonly limit: number;
  readonly cursor?: string;
}

export interface UsageInput {
  readonly reservationId?: string;
  readonly itemId: string;
  readonly projectId: string;
  readonly quantity: number;
  readonly unit: InventoryItem["unit"];
  readonly note?: string;
}

export interface ProjectPort {
  listProjects(options: ProjectListOptions): Promise<Page<Project>>;
  getProject(id: string): Promise<Project | null>;
  createProject(input: CreateProject, ctx: RequestContext): Promise<Project>;
  updateProject(id: string, input: Partial<CreateProject>, expectedVersion: number | undefined, ctx: RequestContext): Promise<Project>;
  createWorkItem(projectId: string, input: CreateWorkItem, ctx: RequestContext): Promise<WorkItem>;
  /** Resolve a work item without enumerating every project. */
  getWorkItem(id: string): Promise<WorkItem | null>;
  listWorkItems(projectId: string): Promise<readonly WorkItem[]>;
  createProjectRevision(projectId: string, input: CreateProjectRevision, ctx: RequestContext): Promise<ProjectRevision>;
  /** Create a project and its first revision atomically in the adapter's transaction boundary. */
  createProjectWithInitialRevision?(input: CreateProjectWithInitialRevision, ctx: RequestContext): Promise<ProjectWithInitialRevision>;
  getProjectRevision(id: string): Promise<ProjectRevision | null>;
  createWorkItemRevision(workItemId: string, input: CreateWorkItemRevision, ctx: RequestContext): Promise<WorkItemRevision>;
  getWorkItemRevision(id: string): Promise<WorkItemRevision | null>;
  listBomLines(revisionId: string): Promise<readonly BomLine[]>;
  /** Resolve a BOM line across all revisions, including historical ones. */
  getBomLine(id: string): Promise<BomLine | null>;
  createBomLine(revisionId: string, input: CreateBomLine, ctx: RequestContext): Promise<BomLine>;
  updateBomLine(id: string, input: Partial<CreateBomLine>, expectedVersion: number | undefined, ctx: RequestContext): Promise<BomLine>;
  retireBomLine(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<BomLine>;
  createReservation(revisionId: string, input: CreateReservation, ctx: RequestContext): Promise<Reservation>;
  releaseReservation(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Reservation>;
  listReservations(revisionId: string): Promise<readonly Reservation[]>;
  /** Resolve a reservation and its durable project/revision/BOM ancestry. */
  getReservationDetails(id: string): Promise<ReservationDetails | null>;
  recordUsage(input: UsageInput, ctx: RequestContext): Promise<StockMutation>;
}

export interface ReservationDetails {
  readonly reservation: Reservation;
  readonly projectId: string;
  readonly projectRevisionId: string;
  readonly bomLine: BomLine;
}

export interface OfferPort {
  listOffers(itemId: string | undefined, limit: number, cursor?: string): Promise<Page<Offer>>;
  createOffer(input: CreateOffer, ctx: RequestContext): Promise<Offer>;
}

export interface BeginUploadInput {
  readonly projectId: string;
  readonly workItemId?: string;
  readonly revisionId?: string;
  /** Optional immutable project-revision snapshot to bind on finalization. */
  readonly buildConfigurationSnapshotId?: string;
  readonly role: Artifact["role"];
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly author?: string;
  readonly source?: string;
}

export interface ArtifactDownload {
  readonly artifact: Artifact;
  readonly body: Uint8Array;
}

export interface ArtifactPort {
  listArtifacts(projectId: string, workItemId?: string, revisionId?: string): Promise<readonly Artifact[]>;
  getArtifact(id: string): Promise<Artifact | null>;
  /** Resolve an upload session's durable ancestry across requests. */
  getUploadSessionDetails(id: string): Promise<UploadSessionDetails | null>;
  beginUpload(input: BeginUploadInput, ctx: RequestContext): Promise<UploadSession>;
  writeUpload(sessionId: string, body: Uint8Array): Promise<{ readonly receivedBytes: number }>;
  /** Remove an uncommitted upload session during audited begin compensation. */
  abortUpload?(sessionId: string): Promise<void>;
  finalizeUpload(sessionId: string, ctx: RequestContext): Promise<Artifact>;
  /** Persist an already validated snapshot binding within the finalization transaction. */
  bindBuildConfiguration?(input: {
    readonly artifactId: string;
    readonly buildConfigurationSnapshotId: string;
    readonly projectRevisionId: string;
  }): Promise<ApiArtifactBuildConfigurationBinding>;
  /**
   * Compensate a filesystem finalization when the surrounding audited
   * mutation cannot commit. Production adapters use this to remove a newly
   * visible artifact and return the upload session to a retryable state.
   * Adapters without a durable filesystem may omit the hook.
   */
  rollbackFinalization?(sessionId: string, artifactId: string): Promise<void>;
  /** Mark a successful audited finalization as no longer compensatable. */
  commitFinalization?(sessionId: string, artifactId: string): Promise<void>;
  readArtifact(id: string): Promise<ArtifactDownload>;
  retireArtifact(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Artifact>;
}

export interface UploadSessionDetails {
  readonly session: UploadSession;
  readonly projectId: string;
  readonly workItemId?: string;
  readonly revisionId?: string;
  readonly buildConfigurationSnapshotId?: string;
}

export interface AuditInput {
  readonly action: string;
  readonly actor: string;
  readonly source: RequestSource;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly version?: number;
}

export interface AuditEvent {
  readonly id: string;
  readonly action: string;
  readonly actor: string;
  readonly source: RequestSource;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly version?: number;
  readonly createdAt: string;
}

export interface AuditPort {
  append(input: AuditInput): Promise<AuditEvent>;
  list(limit: number, cursor?: string): Promise<Page<AuditEvent>>;
}

export interface EventBusEvent {
  readonly id: string;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly version?: number;
  readonly correlationId: string;
  readonly at: string;
}

export type EventListener = (event: EventBusEvent) => void;

export interface EventBusPort {
  publish(event: EventBusEvent): void;
  subscribe(listener: EventListener): () => void;
}

export interface IdempotencyPort {
  get(actor: string, key: string): Promise<unknown | null>;
  set(actor: string, key: string, value: unknown): Promise<void>;
}

export type UnitOfWorkOperation<T> = () => T | PromiseLike<T>;

/**
 * Coordinates application mutations with the storage/runtime boundary.
 *
 * `run` is the application-facing name used by mutation orchestration;
 * `transactional` is the explicit spelling used by production adapters and
 * tests that need to state the durability guarantee. Implementations must
 * provide both aliases: neither may silently fall back to an unprotected
 * operation. `exclusive` serializes filesystem work and consistent reads that
 * must not overlap an outer transaction, without opening a database
 * transaction itself.
 */
export interface UnitOfWorkPort {
  run<T>(operation: UnitOfWorkOperation<T>): Promise<T>;
  transactional<T>(operation: UnitOfWorkOperation<T>): Promise<T>;
  exclusive<T>(operation: UnitOfWorkOperation<T>): Promise<T>;
}

export interface HealthPort {
  check(): Promise<Readonly<Record<string, "ok" | "degraded" | "failed">>>;
}

export interface ApplicationPorts {
  readonly inventory: InventoryPort;
  /** Shared user-managed taxonomy for inventory; absent on legacy hosts. */
  readonly inventoryCategories?: InventoryCategoryPort;
  readonly projects: ProjectPort;
  readonly offers: OfferPort;
  readonly artifacts: ArtifactPort;
  /** Shared exact-product catalog and physical inventory profiles. */
  readonly catalog?: CatalogPort;
  /** Immutable setup snapshots owned by a project revision. */
  readonly buildConfigurations?: BuildConfigurationPort;
  readonly reconciliations?: ReconciliationPort;
  readonly audit: AuditPort;
  readonly events: EventBusPort;
  readonly idempotency: IdempotencyPort;
  readonly unitOfWork: UnitOfWorkPort;
  readonly health?: HealthPort;
}

export interface Mutation<T> {
  readonly data: T;
  readonly audit: AuditEvent;
  readonly correlationId: string;
  readonly replayed: boolean;
}

export interface GapEvaluation {
  readonly revisionId: string;
  readonly lines: readonly BomGap[];
  readonly totals: {
    readonly suppliedLines: number;
    readonly inspectFirstLines: number;
    readonly partialLines: number;
    readonly missingLines: number;
    readonly optionalLines: number;
  };
}
