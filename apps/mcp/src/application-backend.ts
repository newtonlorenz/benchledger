import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { ApplicationError, inventoryBulkUpdateFingerprint, type ApplicationService, type Mutation, type Page as AppPage, type RequestContext } from "@benchledger/application";
import type {
  Artifact as ApiArtifact,
  BomGap,
  BomLine as ApiBomLine,
  CreateBomLine,
  CreateInventoryItem,
  CommissionInventoryItem,
  CreateOffer,
  CreateProject,
  CreateProjectWithInitialRevision,
  CreateProjectRevision,
  CreateReservation,
  CreateWorkItem,
  CreateWorkItemRevision,
  Dimension,
  InventoryItem as ApiInventoryItem,
  InventoryBulkUpdate as ApiInventoryBulkUpdate,
  Offer as ApiOffer,
  Project as ApiProject,
  ProjectRevision as ApiProjectRevision,
  Reservation as ApiReservation,
  StockEvent as ApiStockEvent,
  StockEventInput,
  UploadSession,
  WorkItem as ApiWorkItem,
  WorkItemRevision as ApiWorkItemRevision,
  BuildConfigurationSnapshot as ApiBuildConfigurationSnapshot,
  CatalogProduct as ApiCatalogProduct,
  InventoryProductProfile as ApiInventoryProductProfile,
} from "@benchledger/api-contract";
import { bomSpecificationSchema } from "@benchledger/api-contract";
import { McpAdapterError } from "./errors.js";
import { McpAdapter } from "./adapter.js";
import { McpProtocol } from "./protocol.js";
import { BOM_CONSTRAINT_KEYS } from "./types.js";
import type {
  Artifact,
  ArtifactDownloadMetadata,
  ArtifactListInput,
  ArtifactUploadTicket,
  Availability,
  BeginArtifactUploadInput,
  BomAlternative,
  BomCompatibility,
  BomConstraintKey,
  BomConstraints,
  BomEvaluation,
  BomEvaluationInput,
  BomMatch,
  BomLine,
  BomLineCreateInput,
  BomLineListInput,
  BomLineUpdateInput,
  ContextRefreshInput,
  Dimensions,
  EvidenceSummary,
  BenchLedgerBackend,
  InventoryCreateInput,
  InventoryBulkUpdateInput,
  InventoryBulkUpdateResult,
  InventoryCategory,
  InventoryCategoryCreateInput,
  InventoryCategoryUpdateInput,
  InventoryCommissionInput,
  InventoryItem,
  InventoryListInput,
  InventoryUpdateInput,
  McpRequestContext,
  Offer,
  OfferListInput,
  Page,
  Project,
  ProjectCreateInput,
  ProjectWithInitialRevisionCreateInput,
  ProjectListInput,
  ProjectRevisionCreateInput,
  ProjectUpdateInput,
  ProjectWithInitialRevisionResult,
  Quantity,
  RecordOfferSnapshotInput,
  RecordStockEventInput,
  RefreshedContext,
  ReleaseReservationInput,
  Reservation,
  ReservationDetails,
  ReservationInput,
  Revision,
  ProjectScopeResolvers,
  StockEvent,
  StockEventsInput,
  UsageInput,
  UsageResult,
  WorkItem,
  WorkItemCreateInput,
  WorkItemRevisionCreateInput,
  WriteResult,
  McpServerInfo,
  ArtifactTransferProvider,
  BuildConfigurationCreateInput,
  BuildConfigurationListInput,
  BuildConfigurationReadInput,
  BuildConfigurationSnapshot,
  CatalogBackend,
  CatalogProduct,
  CatalogProductCreateInput,
  CatalogProductSearchInput,
  CatalogProductUpdateInput,
  BuildConfigurationsBackend,
  InventoryProductProfile,
  InventoryProductProfileLinkInput,
  InventoryProductProfileReadInput,
  InventoryWithProductProfileCreateInput,
  InventoryWithProductProfileResult,
  ReconciliationBackend,
  ReconciliationReadInput,
  ReconciliationDraftSaveInput,
  ReconciliationCommitInput,
} from "./types.js";

export interface ApplicationBackendOptions {
  /** Absolute origin used by the transport capability provider. */
  publicBaseUrl?: string;
  /** Host-owned short-lived capability issuer for artifact transfers. */
  artifactTransfer?: ArtifactTransferProvider;
  /** Durable ancestry lookups supplied by the host's repository/runtime. */
  projectScope?: ProjectScopeResolvers;
}

export interface ApplicationMcpProtocolOptions extends ApplicationBackendOptions {
  context: McpRequestContext;
  serverInfo?: McpServerInfo;
}

// Summaries are aggregate responses rather than pages, so they may follow the
// application's bounded cursors. Keep a hard ceiling in place in case a host
// returns a malformed/cyclic cursor stream or an unexpectedly large catalog.
const MAX_INVENTORY_SUMMARY_PAGES = 1_000;
const FILTERED_SOURCE_PAGE_LIMIT = 200;
const MAX_FILTERED_SOURCE_PAGES = 1_000;
const FILTERED_CURSOR_PREFIX = "fl1.";

interface FilteredCursorState {
  readonly sourceCursor?: string;
  /** Number of matching records already consumed in the source page. */
  readonly matchOffset: number;
  /** Offset from the legacy numeric cursor format, counted across source pages. */
  readonly legacyOffset?: number;
}

interface FilteredPageOptions<T, M> {
  readonly cursor?: string;
  readonly limit: number;
  readonly loadPage: (cursor: string | undefined) => Promise<AppPage<T>>;
  readonly matches: (value: T) => boolean;
  readonly map: (value: T) => M;
  readonly id: (value: T) => string | undefined;
  readonly label: string;
}

/** Convenience factory for the Fastify/HTTP host; the host still owns auth. */
export function createApplicationMcpProtocol(service: ApplicationService, options: ApplicationMcpProtocolOptions): McpProtocol {
  return new McpProtocol(new McpAdapter(createApplicationBackend(service, options)), { context: options.context, ...(options.serverInfo === undefined ? {} : { serverInfo: options.serverInfo }) });
}

/**
 * Adapt the application service used by the web server to the model-neutral
 * MCP contract. This file contains mapping only: authorization and input
 * validation remain in the MCP adapter and the application service.
 */
export function createApplicationBackend(service: ApplicationService, options: Partial<ApplicationBackendOptions> = {}): BenchLedgerBackend {
  const artifactTransfer = options.artifactTransfer;
  // Indirect IDs must be resolved from durable host-owned state. A previous
  // implementation cached newly-created IDs in request-local maps, which
  // failed as soon as the next HTTP request built a fresh backend instance.
  // Host resolvers take precedence; the application service supplies the
  // repository-backed defaults when a host does not need a custom adapter.
  const configuredScope = options.projectScope;
  const reservationDetails = configuredScope?.reservationDetails ?? (async (reservationId: string): Promise<ReservationDetails | null> => {
    try {
      const details = await service.getReservationDetails(reservationId);
      if (details === null) return null;
      return {
        projectId: details.projectId,
        projectRevisionId: details.projectRevisionId,
        bomLineId: details.reservation.lineId,
        itemId: details.reservation.itemId,
        unit: fromApiUnit(details.bomLine.unit),
      };
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "not_found") return null;
      throw error;
    }
  });
  return {
    catalog: {
      search: async (input: CatalogProductSearchInput) => {
        const result = await service.listCatalogProducts({
          limit: input.limit ?? 25,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.query === undefined ? {} : { q: input.query }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
        });
        return appPage(result.data.map(toMcpCatalogProduct), result);
      },
      get: async (input) => toMcpCatalogProduct(await service.getCatalogProduct(input.productId)),
      create: async (input: CatalogProductCreateInput, context) => mutationResult(await service.createCatalogProduct(input, appContext(context)), "product", toMcpCatalogProduct),
      update: async (input: CatalogProductUpdateInput, context) => {
        const { productId, expectedVersion, ...changes } = input;
        return mutationResult(await service.updateCatalogProduct(productId, changes, expectedVersion, appContext(context)), "product", toMcpCatalogProduct);
      },
      readProfile: async (input: InventoryProductProfileReadInput) => toMcpInventoryProductProfile(await service.getInventoryProductProfile(input.itemId)),
      linkProfile: async (input: InventoryProductProfileLinkInput, context) => {
        const { itemId, expectedVersion, ...changes } = input;
        return mutationResult(await service.putInventoryProductProfile(itemId, changes, expectedVersion, appContext(context)), "profile", toMcpInventoryProductProfile);
      },
    } satisfies CatalogBackend,
    buildConfigurations: {
      create: async (input: BuildConfigurationCreateInput, context) => mutationResult(await service.createBuildConfiguration(input.projectRevisionId, input, appContext(context)), "buildConfiguration", toMcpBuildConfiguration),
      list: async (input: BuildConfigurationListInput, context) => {
        const result = await service.listBuildConfigurations(input.projectRevisionId, { limit: input.limit ?? 25, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
        return appPage(result.data.map(toMcpBuildConfiguration), result);
      },
      get: async (input: BuildConfigurationReadInput) => toMcpBuildConfiguration(await service.getBuildConfiguration(input.buildConfigurationId)),
    } satisfies BuildConfigurationsBackend,
    reconciliation: {
      read: async (input: ReconciliationReadInput) => service.getReconciliation(input.projectRevisionId),
      save: async (input: ReconciliationDraftSaveInput, context) => mutationResult(
        await service.saveReconciliationDraft(input.projectRevisionId, input, appContext(context)),
        "draft",
        (value) => value,
      ),
      commit: async (input: ReconciliationCommitInput, context) => {
        const { projectRevisionId, ...command } = input;
        return mutationResult(
          await service.commitReconciliation(projectRevisionId, command, appContext(context)),
          "commit",
          (value) => value,
        );
      },
    } satisfies ReconciliationBackend,
    inventory: {
      summary: async (input, context) => {
        const limit = Math.min(input.limit ?? 50, 100);
        let cursor = input.cursor;
        let items: readonly InventoryItem[] = [];
        const visitedCursors = new Set<string>(cursor === undefined ? [] : [cursor]);

        for (let pageNumber = 0; pageNumber < MAX_INVENTORY_SUMMARY_PAGES; pageNumber += 1) {
          const page = await service.listInventory({ limit, includeRetired: true, ...(cursor === undefined ? {} : { cursor }) });
          items = [...items, ...page.data.map(toMcpInventoryItem)];
          if (page.nextCursor === undefined) return inventorySummary(items);
          if (visitedCursors.has(page.nextCursor)) {
            throw new McpAdapterError("BACKEND_ERROR", "Inventory summary pagination did not make progress.");
          }
          visitedCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }

        throw new McpAdapterError("BACKEND_ERROR", "Inventory summary pagination exceeded the safe page limit.");
      },
      list: async (input, context) => {
        const localLocationFilter = input.location !== undefined;
        // Availability is derived from evidence, retirement, on-hand, and
        // allocated quantities. Filtering by raw evidence would miss
        // commissioned stock, fully allocated physical stock, and retired
        // records whose historical evidence is still present.
        const localAvailabilityFilter = input.availability !== undefined;
        if (localLocationFilter || localAvailabilityFilter) {
          return filteredPage({
            cursor: input.cursor,
            limit: input.limit ?? 25,
            loadPage: async (cursor) => service.listInventory({
              limit: FILTERED_SOURCE_PAGE_LIMIT,
              ...(cursor === undefined ? {} : { cursor }),
              ...(input.availability === "retired" ? { includeRetired: true } : {}),
              ...(input.query === undefined ? {} : { q: input.query }),
              ...(input.category === undefined ? {} : { kind: toApiKind(input.category) }),
              ...(input.categoryNodeId === undefined ? {} : { categoryNodeId: input.categoryNodeId }),
              ...(input.unassigned === undefined ? {} : { unassigned: input.unassigned }),
            }),
            matches: (item) => {
              const mapped = toMcpInventoryItem(item);
              return (input.location === undefined || mapped.location === input.location)
                && (input.availability === undefined || mapped.availability === input.availability);
            },
            map: toMcpInventoryItem,
            id: (item) => item.id,
            label: "inventory",
          });
        }
        const page = await service.listInventory({
          limit: input.limit ?? 25,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.query === undefined ? {} : { q: input.query }),
          ...(input.category === undefined ? {} : { kind: toApiKind(input.category) }),
          ...(input.categoryNodeId === undefined ? {} : { categoryNodeId: input.categoryNodeId }),
          ...(input.unassigned === undefined ? {} : { unassigned: input.unassigned }),
          ...(input.availability === undefined ? {} : { evidence: toApiEvidence(input.availability) }),
        });
        return appPage(page.data.map(toMcpInventoryItem), page);
      },
      get: async (input) => toMcpInventoryItem(await service.getInventoryItem(input.itemId)),
      create: async (input, context) => mutationResult(await service.createInventoryItem(toApiInventoryCreate(input), appContext(context)), "item", toMcpInventoryItem),
      createWithProductProfile: async (input: InventoryWithProductProfileCreateInput, context): Promise<InventoryWithProductProfileResult> => {
        const mutation = await service.createInventoryWithProductProfile({
          item: toApiInventoryCreate(input.item),
          profile: input.profile,
        }, appContext(context));
        return {
          id: mutation.data.item.id,
          version: mutation.data.item.version,
          item: toMcpInventoryItem(mutation.data.item),
          profile: toMcpInventoryProductProfile(mutation.data.profile),
          auditId: mutation.audit.id,
          correlationId: mutation.correlationId,
          replayed: mutation.replayed,
        };
      },
      update: async (input, context) => {
        const { itemId, expectedVersion, ...changes } = input;
        return mutationResult(await service.updateInventoryItem(itemId, toApiInventoryUpdate(changes), expectedVersion, appContext(context)), "item", toMcpInventoryItem);
      },
      bulkUpdate: async (input: InventoryBulkUpdateInput, context): Promise<InventoryBulkUpdateResult> => {
        const commandContext = context.idempotencyKey === undefined
          ? { ...context, idempotencyKey: mcpBulkIdempotencyKey(context, input) }
          : context;
        const mutation = await service.bulkUpdateInventoryItems(input, appContext(commandContext));
        return {
          updated: mutation.data.updated.map((item) => ({ itemId: item.id, version: item.version })),
          unchanged: mutation.data.unchanged.map((item) => ({ itemId: item.id, version: item.version })),
          auditIds: mutation.audits.map((audit) => audit.id),
          correlationId: mutation.correlationId,
          replayed: mutation.replayed,
        };
      },
      commission: async (input: InventoryCommissionInput, context) => {
        const mutation = await service.commissionInventoryItem(input.itemId, toApiInventoryCommission(input), input.expectedVersion, appContext(context));
        return {
          id: mutation.data.item.id,
          version: mutation.data.item.version,
          item: toMcpInventoryItem(mutation.data.item),
          eventId: mutation.data.event.id,
          auditId: mutation.audit.id,
          correlationId: mutation.correlationId,
        };
      },
      recordStockEvent: async (input, context) => {
        const event = await service.recordStockEvent(toApiStockEvent(input), appContext(context));
        return {
          eventId: event.data.event.id,
          itemId: event.data.item.id,
          resultingQuantity: toQuantity(event.data.item.availableQuantity, event.data.item.unit),
          version: event.data.item.version,
          auditId: event.audit.id,
        };
      },
      listStockEvents: async (input) => {
        const page = await service.listStockEvents(input.itemId, input.limit ?? 25, input.cursor);
        return appPage(page.data.map(toMcpStockEvent), page);
      },
    },
    inventoryCategories: {
      list: async (input) => {
        const page = await service.listInventoryCategories({
          limit: input.limit ?? 25,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
        });
        return appPage(page.data.map(toMcpInventoryCategory), page);
      },
      get: async (input) => toMcpInventoryCategory(await service.getInventoryCategory(input.categoryId)),
      create: async (input: InventoryCategoryCreateInput, context) => mutationResult(
        await service.createInventoryCategory(input, appContext(context)),
        "category",
        toMcpInventoryCategory,
      ),
      update: async (input: { categoryId: string; expectedVersion: number } & InventoryCategoryUpdateInput, context) => {
        const { categoryId, expectedVersion, ...changes } = input;
        return mutationResult(
          await service.updateInventoryCategory(categoryId, changes, expectedVersion, appContext(context)),
          "category",
          toMcpInventoryCategory,
        );
      },
      archive: async (input: { categoryId: string; expectedVersion: number }, context) => mutationResult(
        await service.archiveInventoryCategory(input.categoryId, input.expectedVersion, appContext(context)),
        "category",
        toMcpInventoryCategory,
      ),
    },
    projects: {
      list: async (input, context) => {
        if (context.projectIds !== undefined) {
          const projects = await Promise.all(context.projectIds.map(async (projectId) => {
            try { return await service.getProject(projectId); } catch (error) {
              if (error instanceof ApplicationError && error.code === "not_found") return null;
              throw error;
            }
          }));
          const query = input.query?.toLocaleLowerCase();
          const filtered = projects.filter((project): project is NonNullable<typeof project> => project !== null && (input.status === undefined || toMcpProject(project).status === input.status) && (query === undefined || project.name.toLocaleLowerCase().includes(query) || project.description?.toLocaleLowerCase().includes(query) === true));
          return slicePage(filtered.map(toMcpProject), input.limit ?? 25, input.cursor);
        }
        const page = await service.listProjects({ limit: input.limit ?? 25, ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(input.query === undefined ? {} : { q: input.query }), ...(input.status === undefined ? {} : { status: toApiProjectStatus(input.status) }) });
        return appPage(page.data.map(toMcpProject), page);
      },
      get: async (input) => toMcpProject(await service.getProject(input.projectId)),
      create: async (input, context) => mutationResult(await service.createProject(toApiProjectCreate(input), appContext(context)), "project", toMcpProject),
      createWithInitialRevision: async (input, context) => {
        const mutation = await service.createProjectWithInitialRevision(toApiProjectWithInitialRevisionCreate(input), appContext(context));
        const created = mutation.data;
        return {
          id: created.project.id,
          version: created.project.version,
          project: toMcpProject(created.project),
          revision: toMcpRevision(created.revision),
          auditId: mutation.audit.id,
          correlationId: mutation.correlationId,
          replayed: mutation.replayed,
        } satisfies ProjectWithInitialRevisionResult;
      },
      update: async (input, context) => {
        const { projectId, expectedVersion, ...changes } = input;
        return mutationResult(await service.updateProject(projectId, toApiProjectUpdate(changes), expectedVersion, appContext(context)), "project", toMcpProject);
      },
      retire: async (input, context) => mutationResult(await service.updateProject(input.projectId, { status: "retired" }, input.expectedVersion, appContext(context)), "project", toMcpProject),
      createWorkItem: async (input, context) => mutationResult(await service.createWorkItem(input.projectId, toApiWorkItemCreate(input), appContext(context)), "workItem", toMcpWorkItem),
      getWorkItem: async (input) => toMcpWorkItem(await service.getWorkItem(input.workItemId)),
      createProjectRevision: async (input, context) => mutationResult(await service.createProjectRevision(input.projectId, toApiProjectRevisionCreate(input), appContext(context)), "revision", toMcpRevision),
      getProjectRevision: async (input) => toMcpRevision(await service.getProjectRevision(input.revisionId)),
      createWorkItemRevision: async (input, context) => mutationResult(await service.createWorkItemRevision(input.workItemId, toApiWorkItemRevisionCreate(input), appContext(context)), "revision", toMcpRevision),
      getWorkItemRevision: async (input) => toMcpRevision(await service.getWorkItemRevision(input.revisionId)),
      context: async (input) => {
        const project = await service.getProject(input.projectId);
        const workItems = await service.listWorkItems(input.projectId);
        const text = [
          `Project: ${project.name}`,
          `Status: ${project.status}`,
          project.description === undefined ? undefined : `Description: ${project.description}`,
          `Work items: ${workItems.map((item) => `${item.name} (${item.kind})`).join(", ") || "none recorded"}`,
          project.currentRevisionId === undefined ? "Current revision: not selected" : `Current revision: ${project.currentRevisionId}`,
        ].filter((line): line is string => line !== undefined).join("\n");
        return { projectId: project.id, generatedAt: new Date().toISOString(), text, ...(project.currentRevisionId === undefined ? {} : { currentRevisionId: project.currentRevisionId }) };
      },
    },
    bom: {
      listLines: async (input) => {
        const lines = await service.listBomLines(input.projectRevisionId, { includeRetired: input.includeRetired === true });
        return slicePage(lines.map((line) => toMcpBomLine(line as ApiBomLine)), input.limit ?? 25, input.cursor);
      },
      listProjectLines: async (input) => {
        const project = await service.getProject(input.projectId);
        if (project.currentRevisionId === undefined) return { items: [], nextCursor: null, hasMore: false };
        const lines = await service.listBomLines(project.currentRevisionId);
        return slicePage(lines.map((line) => toMcpBomLine(line as ApiBomLine)), input.limit ?? 25, input.cursor);
      },
      createLine: async (input, context) => {
        const mutation = await service.createBomLine(input.projectRevisionId, toApiBomCreate(input), appContext(context));
        return mutationResult(mutation, "line", (value) => toMcpBomLine(value as ApiBomLine));
      },
      updateLine: async (input, context) => {
        const { bomLineId, expectedVersion, ...changes } = input;
        return mutationResult(await service.updateBomLine(bomLineId, toApiBomUpdate(changes), expectedVersion, appContext(context)), "line", (value) => toMcpBomLine(value as ApiBomLine));
      },
      retireLine: async (input, context) => mutationResult(await service.retireBomLine(input.bomLineId, input.expectedVersion, appContext(context)), "line", (value) => toMcpBomLine(value as ApiBomLine)),
      restoreLine: async (input, context) => mutationResult(await service.restoreBomLine(input.bomLineId, input.expectedVersion, appContext(context)), "line", (value) => toMcpBomLine(value as ApiBomLine)),
      evaluate: async (input) => toMcpBomEvaluation(await service.evaluateBomGaps(input.projectRevisionId), input),
      reserve: async (input, context) => {
        const mutation = await service.createReservation(input.projectRevisionId, toApiReservation(input), appContext(context));
        return mapReservation(mutation, reservationDetails, { projectRevisionId: input.projectRevisionId, unit: input.quantity.unit });
      },
      release: async (input, context) => mapReservation(await service.releaseReservation(input.reservationId, input.expectedVersion, appContext(context)), reservationDetails),
      recordUsage: async (input, context) => {
        if (input.reservationId !== undefined) {
          const details = await reservationDetails(input.reservationId);
          if (details === null) throw new McpAdapterError("NOT_FOUND", "The usage reservation could not be resolved.");
          if (details.projectRevisionId !== input.projectRevisionId) {
            throw new McpAdapterError("INVALID_ARGUMENT", "reservationId must belong to the supplied projectRevisionId.");
          }
        }
        const revision = await service.getProjectRevision(input.projectRevisionId);
        const mutation = await service.recordUsage({ projectId: revision.projectId, itemId: input.itemId, quantity: input.quantity.value, unit: toApiUnit(input.quantity.unit), ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }), ...(input.note === undefined ? {} : { note: input.note }) }, appContext(context));
        return { usageEventId: mutation.data.event.id, itemId: mutation.data.item.id, quantity: input.quantity, resultingQuantity: toQuantity(mutation.data.item.availableQuantity, mutation.data.item.unit), version: mutation.data.item.version, auditId: mutation.audit.id } satisfies UsageResult;
      },
    },
    artifacts: {
      list: async (input) => {
        const artifacts = await service.listArtifacts(input.projectId, input.workItemId, input.revisionId);
        const filtered = input.role === undefined ? artifacts : artifacts.filter((artifact) => toMcpArtifactRole(artifact.role) === input.role);
        return slicePage(filtered.map(toMcpArtifact), input.limit ?? 25, input.cursor);
      },
      getMetadata: async (input) => {
        const artifact = await service.getArtifact(input.artifactId);
        assertArtifactRevision(artifact, input.revisionId);
        return toMcpArtifact(artifact);
      },
      beginUpload: async (input, context) => {
        if (input.sha256 === undefined) throw new McpAdapterError("INVALID_ARGUMENT", "begin_artifact_upload requires sha256 so the application can verify the upload.");
        if (artifactTransfer === undefined) throw new McpAdapterError("BACKEND_ERROR", "Artifact transfer capabilities are not configured for this MCP host.");
        const revisionId = input.projectRevisionId ?? input.workItemRevisionId;
        const mutation = await service.beginArtifactUpload({ projectId: input.projectId, ...(revisionId === undefined ? {} : { revisionId }), ...(input.buildConfigurationSnapshotId === undefined ? {} : { buildConfigurationSnapshotId: input.buildConfigurationSnapshotId }), ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }), role: toApiArtifactRole(input.role), filename: input.filename, mediaType: input.mediaType, byteSize: input.byteLength, sha256: input.sha256 }, appContext(context));
        const session = mutation.data;
        const links = await artifactTransfer.issueUpload({ uploadId: session.id, projectId: input.projectId, expiresAt: session.expiresAt, byteLength: input.byteLength, sha256: input.sha256, actor: context.actorId });
        return { uploadId: session.id, uploadUrl: links.uploadUrl, expiresAt: links.expiresAt, maxBytes: session.maxBytes, method: "PUT", requiredHeaders: links.uploadHeaders, finalizeUrl: links.finalizeUrl, finalizeHeaders: links.finalizeHeaders } satisfies ArtifactUploadTicket;
      },
      finalizeUpload: async (input, context) => toMcpArtifact((await service.finalizeArtifactUpload(input.uploadId, appContext(context))).data as ApiArtifact),
      downloadMetadata: async (input, context) => {
        if (artifactTransfer === undefined) throw new McpAdapterError("BACKEND_ERROR", "Artifact transfer capabilities are not configured for this MCP host.");
        const artifact = await service.getArtifact(input.artifactId);
        assertArtifactRevision(artifact, input.revisionId);
        const link = await artifactTransfer.issueDownload({ artifactId: artifact.id, projectId: artifact.projectId, byteLength: artifact.byteSize, sha256: artifact.sha256, actor: context.actorId });
        return { artifactId: artifact.id, revisionId: artifact.revisionId ?? artifact.id, filename: artifact.filename, byteLength: artifact.byteSize, sha256: artifact.sha256, downloadUrl: link.downloadUrl, requiredHeaders: link.requiredHeaders, expiresAt: link.expiresAt } satisfies ArtifactDownloadMetadata;
      },
      retire: async (input, context) => mutationResult(await service.retireArtifact(input.artifactId, input.expectedVersion, appContext(context)), "artifact", (value) => toMcpArtifact(value as ApiArtifact)),
    },
    offers: {
      list: async (input) => {
        const query = input.query?.trim().toLocaleLowerCase();
        const supplier = input.supplier?.trim().toLocaleLowerCase();
        return filteredPage({
          cursor: input.cursor,
          limit: input.limit ?? 25,
          loadPage: async (cursor) => listOfferPage(service, input.itemId, FILTERED_SOURCE_PAGE_LIMIT, cursor),
          matches: (offer) => {
            const mapped = toMcpOffer(offer);
            return (supplier === undefined || mapped.supplier.toLocaleLowerCase().includes(supplier)) &&
              (query === undefined || mapped.supplier.toLocaleLowerCase().includes(query) || mapped.description?.toLocaleLowerCase().includes(query) === true);
          },
          map: toMcpOffer,
          id: (offer) => offer.id,
          label: "offer",
        });
      },
      recordSnapshot: async (input, context) => mutationResult(await service.createOffer(toApiOfferCreate(input), appContext(context)), "offer", toMcpOffer),
    },
    context: {
      refresh: async (input, context) => {
        const projectUris = input.projectId === undefined ? [] : [`benchledger://projects/${encodeURIComponent(input.projectId)}/context`, `benchledger://projects/${encodeURIComponent(input.projectId)}/bom`, `benchledger://projects/${encodeURIComponent(input.projectId)}/artifacts`];
        return { generatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + Math.max(input.maxAgeSeconds ?? 300, 30) * 1000).toISOString(), inventorySummaryUri: "benchledger://inventory/summary", projectUris, note: input.includeInventory === false ? "Inventory summary was not refreshed by request." : "Read the inventory summary after this refresh." } satisfies RefreshedContext;
      },
    },
    projectScope: {
      projectForWorkItem: configuredScope?.projectForWorkItem ?? (async (workItemId) => {
        try { return (await service.getWorkItem(workItemId)).projectId; } catch (error) {
          if (error instanceof ApplicationError && error.code === "not_found") return null;
          throw error;
        }
      }),
      projectForProjectRevision: configuredScope?.projectForProjectRevision ?? (async (revisionId) => {
        try { return (await service.getProjectRevision(revisionId)).projectId; } catch (error) {
          if (error instanceof ApplicationError && error.code === "not_found") return null;
          throw error;
        }
      }),
      projectForWorkItemRevision: configuredScope?.projectForWorkItemRevision ?? (async (revisionId) => {
        try { return (await service.getWorkItemRevision(revisionId)).projectId; } catch (error) {
          if (error instanceof ApplicationError && error.code === "not_found") return null;
          throw error;
        }
      }),
      projectForBomLine: configuredScope?.projectForBomLine ?? (async (bomLineId) => {
        try {
          const line = await service.getBomLine(bomLineId);
          return (await service.getProjectRevision(line.revisionId)).projectId;
        } catch (error) {
          if (error instanceof ApplicationError && error.code === "not_found") return null;
          throw error;
        }
      }),
      projectForReservation: configuredScope?.projectForReservation ?? (async (reservationId) => {
        try { return (await service.getReservationDetails(reservationId)).projectId; } catch (error) {
          if (error instanceof ApplicationError && error.code === "not_found") return null;
          throw error;
        }
      }),
      projectForArtifact: configuredScope?.projectForArtifact ?? (async (artifactId) => {
        try { return (await service.getArtifact(artifactId)).projectId; } catch (error) {
          if (error instanceof ApplicationError && error.code === "not_found") return null;
          throw error;
        }
      }),
      projectForUpload: configuredScope?.projectForUpload ?? (async (uploadId) => {
        try { return (await service.getUploadSessionDetails(uploadId)).projectId; } catch (error) {
          if (error instanceof ApplicationError && error.code === "not_found") return null;
          throw error;
        }
      }),
      projectForBuildConfiguration: configuredScope?.projectForBuildConfiguration ?? (async (buildConfigurationId) => {
        try {
          const snapshot = await service.getBuildConfiguration(buildConfigurationId);
          return (await service.getProjectRevision(snapshot.projectRevisionId)).projectId;
        } catch (error) {
          if (error instanceof ApplicationError && error.code === "not_found") return null;
          throw error;
        }
      }),
      reservationDetails,
    },
  };
}

function appContext(context: McpRequestContext): RequestContext {
  const scopes = new Set<string>(context.scopes.includes("inventory:read") || context.scopes.includes("projects:read") ? ["read", "write"] : ["write"]);
  return {
    actor: context.actorId,
    source: "mcp",
    correlationId: context.correlationId ?? randomUUID(),
    scopes,
    ...(context.projectIds?.length === 1 ? { projectId: context.projectIds[0] } : {}),
    ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
    ...(context.fingerprint === undefined ? {} : { fingerprint: context.fingerprint }),
  };
}

/**
 * Bulk metadata is the one MCP command whose application contract requires an
 * idempotency key. Stdio clients have no HTTP header to carry one, so derive a
 * bounded actor- and command-scoped key from the same canonical payload the
 * application uses for replay fingerprints. Explicit host keys always win.
 */
function mcpBulkIdempotencyKey(context: McpRequestContext, input: InventoryBulkUpdateInput): string {
  const fingerprint = inventoryBulkUpdateFingerprint(input as unknown as ApiInventoryBulkUpdate);
  const digest = createHash("sha256")
    .update(`${context.actorId}\u0000inventory.item.bulk_update\u0000${fingerprint}`)
    .digest("hex");
  return `mcp:bulk:${digest}`;
}

/**
 * A filtered MCP page may consume only part of an application page. Keep the
 * source-page cursor and the number of matching rows consumed in that page in
 * an opaque cursor so a continuation neither skips the remainder nor repeats
 * rows. Numeric cursors from the previous adapter are accepted as a
 * compatibility path and are interpreted as a global filtered offset.
 */
async function filteredPage<T, M>(options: FilteredPageOptions<T, M>): Promise<Page<M>> {
  const state = decodeFilteredCursor(options.cursor);
  const limit = options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new McpAdapterError("INVALID_ARGUMENT", "The page limit must be a positive safe integer.");
  }

  let sourceCursor = state.sourceCursor;
  let pageMatchOffset = state.matchOffset;
  let legacyOffset = state.legacyOffset;
  const selected: M[] = [];
  const visitedCursors = new Set<string>();
  const seenIds = new Set<string>();

  for (let pageNumber = 0; pageNumber < MAX_FILTERED_SOURCE_PAGES; pageNumber += 1) {
    if (sourceCursor !== undefined) {
      if (visitedCursors.has(sourceCursor)) {
        throw new McpAdapterError("BACKEND_ERROR", `${options.label} pagination cursor repeated.`);
      }
      visitedCursors.add(sourceCursor);
    }

    const page = await options.loadPage(sourceCursor);
    validateFilteredSourcePage(page, options.label);
    for (const value of page.data) {
      const id = options.id(value);
      if (id !== undefined) {
        if (seenIds.has(id)) {
          throw new McpAdapterError("BACKEND_ERROR", `${options.label} pagination returned a duplicate record.`);
        }
        seenIds.add(id);
      }
    }

    const matching = page.data.filter(options.matches);
    let offset = pageMatchOffset;
    if (legacyOffset !== undefined) {
      if (legacyOffset >= matching.length) {
        legacyOffset -= matching.length;
        if (page.nextCursor === undefined) return emptyPage();
        assertFilteredNextCursor(page.nextCursor, sourceCursor, visitedCursors, options.label);
        sourceCursor = page.nextCursor;
        pageMatchOffset = 0;
        continue;
      }
      offset = legacyOffset;
      legacyOffset = undefined;
    }

    if (offset > matching.length) {
      throw new McpAdapterError("BACKEND_ERROR", `${options.label} pagination cursor does not match the source page.`);
    }

    const take = matching.slice(offset, offset + (limit - selected.length));
    selected.push(...take.map(options.map));
    const consumed = offset + take.length;

    if (selected.length >= limit) {
      if (consumed < matching.length) {
        const nextState: FilteredCursorState = {
          matchOffset: consumed,
          ...(sourceCursor === undefined ? {} : { sourceCursor }),
        };
        return pageWithCursor(selected, nextFilteredCursor(nextState, page.nextCursor === undefined));
      }
      if (page.nextCursor !== undefined) {
        assertFilteredNextCursor(page.nextCursor, sourceCursor, visitedCursors, options.label);
        const nextState: FilteredCursorState = { sourceCursor: page.nextCursor, matchOffset: 0 };
        return pageWithCursor(selected, encodeFilteredCursor(nextState));
      }
      return emptyOrSelectedPage(selected);
    }

    if (page.nextCursor === undefined) return emptyOrSelectedPage(selected);
    assertFilteredNextCursor(page.nextCursor, sourceCursor, visitedCursors, options.label);
    sourceCursor = page.nextCursor;
    pageMatchOffset = 0;
  }

  throw new McpAdapterError("BACKEND_ERROR", `${options.label} pagination exceeded the safe page limit.`);
}

function listOfferPage(service: ApplicationService, itemId: string | undefined, limit: number, cursor: string | undefined): Promise<AppPage<ApiOffer>> {
  return cursor === undefined ? service.listOffers(itemId, limit) : service.listOffers(itemId, limit, cursor);
}

function decodeFilteredCursor(cursor: string | undefined): FilteredCursorState {
  if (cursor === undefined) return { matchOffset: 0 };
  if (cursor.length > 512) throw new McpAdapterError("INVALID_ARGUMENT", "The pagination cursor is invalid.");

  // Cursors emitted by the previous implementation were decimal offsets into
  // the filtered result set. Preserve them while new responses use source
  // cursors so an upgrade does not make an in-flight page chain unusable.
  if (/^\d+$/u.test(cursor)) {
    const legacyOffset = Number(cursor);
    if (!Number.isSafeInteger(legacyOffset)) throw new McpAdapterError("INVALID_ARGUMENT", "The pagination cursor is invalid.");
    return { matchOffset: 0, legacyOffset };
  }

  if (!cursor.startsWith(FILTERED_CURSOR_PREFIX)) {
    throw new McpAdapterError("INVALID_ARGUMENT", "The pagination cursor is invalid.");
  }
  const encoded = cursor.slice(FILTERED_CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new McpAdapterError("INVALID_ARGUMENT", "The pagination cursor is invalid.");

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new McpAdapterError("INVALID_ARGUMENT", "The pagination cursor is invalid.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpAdapterError("INVALID_ARGUMENT", "The pagination cursor is invalid.");
  }
  const record = value as Record<string, unknown>;
  const sourceCursor = record.sourceCursor;
  const matchOffset = record.matchOffset;
  if (record.version !== 1 || (sourceCursor !== undefined && !isValidSourceCursor(sourceCursor)) || !Number.isSafeInteger(matchOffset) || (matchOffset as number) < 0 || (matchOffset as number) > FILTERED_SOURCE_PAGE_LIMIT || Object.keys(record).some((key) => !["version", "sourceCursor", "matchOffset"].includes(key))) {
    throw new McpAdapterError("INVALID_ARGUMENT", "The pagination cursor is invalid.");
  }
  return { matchOffset: matchOffset as number, ...(sourceCursor === undefined ? {} : { sourceCursor: sourceCursor as string }) };
}

function isValidSourceCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function validateFilteredSourcePage<T>(page: AppPage<T>, label: string): void {
  if (!Array.isArray(page.data) || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > FILTERED_SOURCE_PAGE_LIMIT || page.data.length > FILTERED_SOURCE_PAGE_LIMIT || page.data.length > page.limit) {
    throw new McpAdapterError("BACKEND_ERROR", `${label} pagination returned a page outside the application bounds.`);
  }
  if (page.total !== undefined && (!Number.isSafeInteger(page.total) || page.total < page.data.length)) {
    throw new McpAdapterError("BACKEND_ERROR", `${label} pagination returned an invalid total.`);
  }
  if (page.nextCursor !== undefined && !isValidSourceCursor(page.nextCursor)) {
    throw new McpAdapterError("BACKEND_ERROR", `${label} pagination returned an invalid continuation cursor.`);
  }
  if (page.nextCursor !== undefined && page.total !== undefined && page.data.length >= page.total) {
    throw new McpAdapterError("BACKEND_ERROR", `${label} pagination returned a continuation after its total was read.`);
  }
  if (page.nextCursor === undefined && page.total !== undefined && page.data.length !== page.total) {
    throw new McpAdapterError("BACKEND_ERROR", `${label} pagination ended before its total was read.`);
  }
  if (page.nextCursor === undefined && page.data.length >= FILTERED_SOURCE_PAGE_LIMIT && (page.total === undefined || page.total > page.data.length)) {
    throw new McpAdapterError("BACKEND_ERROR", `${label} pagination ended at its application page bound without a continuation cursor.`);
  }
}

function assertFilteredNextCursor(cursor: string, current: string | undefined, visited: ReadonlySet<string>, label: string): void {
  if (!isValidSourceCursor(cursor) || cursor === current || visited.has(cursor)) {
    throw new McpAdapterError("BACKEND_ERROR", `${label} pagination did not make progress.`);
  }
}

function encodeFilteredCursor(state: FilteredCursorState): string {
  const value = {
    version: 1,
    ...(state.sourceCursor === undefined ? {} : { sourceCursor: state.sourceCursor }),
    matchOffset: state.matchOffset,
  };
  const cursor = `${FILTERED_CURSOR_PREFIX}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
  if (cursor.length > 512) throw new McpAdapterError("BACKEND_ERROR", "The filtered pagination cursor exceeded the MCP cursor bound.");
  return cursor;
}

function nextFilteredCursor(state: FilteredCursorState, sourceExhausted: boolean): string {
  // Keep the old compact cursor only when the complete source page is known;
  // once an application continuation is involved, retain its opaque cursor.
  return sourceExhausted && state.sourceCursor === undefined ? String(state.matchOffset) : encodeFilteredCursor(state);
}

function pageWithCursor<T>(items: readonly T[], nextCursor: string): Page<T> {
  return { items, nextCursor, hasMore: true };
}

function emptyPage<T>(): Page<T> {
  return { items: [], nextCursor: null, hasMore: false };
}

function emptyOrSelectedPage<T>(items: readonly T[]): Page<T> {
  return { items, nextCursor: null, hasMore: false };
}

function appPage<T>(items: readonly T[], page: AppPage<unknown>): Page<T> {
  return { items, nextCursor: page.nextCursor ?? null, hasMore: page.nextCursor !== undefined };
}

function slicePage<T>(items: readonly T[], limit: number, cursor: string | undefined): Page<T> {
  const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const selected = items.slice(start, start + limit);
  const next = start + selected.length < items.length ? String(start + selected.length) : null;
  return { items: selected, nextCursor: next, hasMore: next !== null };
}

function inventorySummary(items: readonly InventoryItem[]) {
  const categories = new Map<string, number>();
  for (const item of items) categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
  const hasAllocation = (item: InventoryItem): boolean => item.availability !== "retired"
    && (item.availability === "allocated" || (item.allocatedQuantity?.value ?? 0) > 0);
  const confirmedEvidence = (item: InventoryItem): boolean => item.evidence.state === "physical_count" || item.evidence.state === "commissioned";
  const allocatedQuantities = new Map<Quantity["unit"], number>();
  for (const item of items) {
    if (item.availability === "retired") continue;
    const allocated = item.allocatedQuantity;
    if (allocated === undefined || allocated.value <= 0) continue;
    allocatedQuantities.set(allocated.unit, (allocatedQuantities.get(allocated.unit) ?? 0) + allocated.value);
  }
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      totalItems: items.length,
      // Keep the primary buckets mutually exclusive so they sum to
      // totalItems; confirmedEvidenceItems preserves the physical evidence
      // count when an item moves into the allocated bucket.
      confirmedItems: items.filter((item) => item.availability === "confirmed" && !hasAllocation(item)).length,
      confirmedEvidenceItems: items.filter(confirmedEvidence).length,
      availableConfirmedItems: items.filter((item) => item.availability !== "retired" && confirmedEvidence(item) && (item.availableQuantity?.value ?? 0) > 0).length,
      inspectFirstItems: items.filter((item) => item.availability === "inspect_first").length,
      allocatedItems: items.filter(hasAllocation).length,
      allocatedQuantities: [...allocatedQuantities.entries()].map(([unit, value]) => ({ unit, value })),
      depletedItems: items.filter((item) => item.availability === "depleted").length,
      unverifiedItems: items.filter((item) => item.availability === "ordered_unverified" || item.availability === "delivered_uncounted").length,
      retiredItems: items.filter((item) => item.availability === "retired").length,
      missingItems: 0,
    },
    categories: [...categories.entries()].map(([category, itemCount]) => ({ category, itemCount })),
  };
}

function mutationResult<T, M>(mutation: Mutation<T>, key: string, map: (value: T) => M): WriteResult<M> {
  const data = mutation.data as T & { id?: string; version?: number };
  return { id: data.id ?? mutation.audit.entityId, version: data.version ?? mutation.audit.version ?? 1, [key]: map(mutation.data), auditId: mutation.audit.id, correlationId: mutation.correlationId };
}

function toQuantity(value: number, unit: ApiInventoryItem["unit"]): Quantity {
  return { value, unit: fromApiUnit(unit) };
}

function toMcpCatalogProduct(product: ApiCatalogProduct): CatalogProduct {
  return product;
}

function toMcpInventoryProductProfile(profile: ApiInventoryProductProfile): InventoryProductProfile {
  return profile;
}

function toMcpInventoryCategory(category: InventoryCategory): InventoryCategory {
  return category;
}

function toMcpBuildConfiguration(snapshot: ApiBuildConfigurationSnapshot): BuildConfigurationSnapshot {
  return snapshot;
}

function fromApiUnit(unit: ApiInventoryItem["unit"]): Quantity["unit"] {
  switch (unit) {
    case "gram": return "gram";
    case "millimetre": return "millimetre";
    case "millilitre": return "millilitre";
    case "metre": return "metre";
    case "set": return "set";
    default: return "piece";
  }
}

function toApiUnit(unit: Quantity["unit"]): ApiInventoryItem["unit"] {
  return unit === "piece" ? "each" : unit === "roll" || unit === "set" ? "set" : unit === "metre" ? "metre" : unit;
}

function toMcpAvailability(item: ApiInventoryItem): Availability {
  if (item.retiredAt !== undefined) return "retired";
  switch (item.evidence.state) {
    case "physically_counted":
    case "commissioned": return item.quantity <= 0 ? "depleted" : (item.allocatedQuantity ?? Math.max(0, item.quantity - item.availableQuantity)) > 0 ? "allocated" : "confirmed";
    case "delivered_uncounted": return "delivered_uncounted";
    case "ordered_unverified": return "ordered_unverified";
    case "allocated": return "allocated";
    case "consumed": return "depleted";
    default: return "inspect_first";
  }
}

function toMcpEvidence(item: ApiInventoryItem): EvidenceSummary {
  const state: EvidenceSummary["state"] = item.evidence.state === "physically_counted" ? "physical_count" : item.evidence.state === "commissioned" ? "commissioned" : item.evidence.state === "delivered_uncounted" ? "delivery" : item.evidence.state === "ordered_unverified" ? "order" : item.evidence.state === "allocated" ? "user_reported" : "unknown";
  return { state, source: item.evidence.source ?? "unknown", ...(item.evidence.sourceId === undefined ? {} : { sourceId: item.evidence.sourceId }), recordedAt: item.evidence.observedAt ?? item.updatedAt, ...(item.evidence.note === undefined ? {} : { note: item.evidence.note }) };
}

function toMcpDimensions(value: Dimension | undefined): Dimensions | undefined {
  if (value === undefined) return undefined;
  const result: Dimensions = { unit: "millimetre", source: value.measured ? "measured" : "nominal", ...(value.lengthMm === undefined ? {} : { length: value.lengthMm }), ...(value.widthMm === undefined ? {} : { width: value.widthMm }), ...(value.heightMm === undefined ? {} : { height: value.heightMm }), ...(value.diameterMm === undefined ? {} : { diameter: value.diameterMm }), ...(value.uncertaintyMm === undefined ? {} : { uncertainty: value.uncertaintyMm }) };
  return result;
}

function toMcpInventoryItem(item: ApiInventoryItem): InventoryItem {
  const allocatedQuantity = item.allocatedQuantity
    ?? (item.evidence.state === "physically_counted" || item.evidence.state === "commissioned"
      ? Math.max(0, Math.min(item.quantity, item.quantity - item.availableQuantity))
      : 0);
  return {
    id: item.id,
    name: item.name,
    category: item.kind,
    quantity: toQuantity(item.quantity, item.unit),
    availableQuantity: toQuantity(item.availableQuantity, item.unit),
    allocatedQuantity: toQuantity(allocatedQuantity, item.unit),
    availability: toMcpAvailability(item),
    evidence: toMcpEvidence(item),
    ...(item.categoryNodeId === undefined ? {} : { categoryNodeId: item.categoryNodeId }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.manufacturer === undefined ? {} : { manufacturer: item.manufacturer }),
    ...(item.model === undefined ? {} : { model: item.model }),
    ...(item.sku === undefined ? {} : { sku: item.sku }),
    ...(item.dimensions === undefined ? {} : { dimensions: toMcpDimensions(item.dimensions) }),
    ...(item.condition === undefined ? {} : { condition: item.condition === "good" ? "used" : item.condition === "worn" || item.condition === "needs_repair" ? "opened" : item.condition }),
    ...(item.location === undefined ? {} : { location: item.location }),
    ...(item.tags.length === 0 ? {} : { tags: [...item.tags] }),
    links: item.links.map((link) => ({ label: link.label ?? link.supplier, url: link.url, kind: "supplier" as const })),
    version: item.version,
  };
}

function toApiKind(value: string): ApiInventoryItem["kind"] {
  if (["printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"].includes(value)) return value as ApiInventoryItem["kind"];
  if (value === "printer_accessory" || value === "printer_part") return "accessory";
  if (["electronics", "electrical"].includes(value)) return "electronic";
  return "other";
}

function toApiEvidence(value: Availability): ApiInventoryItem["evidence"]["state"] {
  switch (value) {
    case "confirmed": return "physically_counted";
    case "delivered_uncounted": return "delivered_uncounted";
    case "ordered_unverified": return "ordered_unverified";
    case "allocated": return "allocated";
    case "depleted": return "consumed";
    default: return "unknown";
  }
}

function toApiEvidenceInput(value: EvidenceSummary): CreateInventoryItem["evidence"] {
  const state: CreateInventoryItem["evidence"]["state"] = value.state === "physical_count" ? "physically_counted" : value.state === "commissioned" ? "commissioned" : value.state === "delivery" ? "delivered_uncounted" : value.state === "order" ? "ordered_unverified" : value.state === "user_reported" ? "unknown" : "unknown";
  return { state, source: value.source, ...(value.sourceId === undefined ? {} : { sourceId: value.sourceId }), observedAt: value.recordedAt, ...(value.note === undefined ? {} : { note: value.note }) };
}

function toApiInventoryCommission(input: InventoryCommissionInput): CommissionInventoryItem {
  return {
    quantity: input.quantity.value,
    unit: toApiUnit(input.quantity.unit),
    evidence: {
      state: "commissioned",
      source: input.evidence.source,
      ...(input.evidence.sourceId === undefined ? {} : { sourceId: input.evidence.sourceId }),
      observedAt: input.evidence.recordedAt,
      ...(input.evidence.note === undefined ? {} : { note: input.evidence.note }),
    },
  };
}

function toApiDimensions(value: Dimensions | undefined): CreateInventoryItem["dimensions"] {
  if (value === undefined) return undefined;
  const factor = value.unit === "metre" ? 1000 : value.unit === "centimetre" ? 10 : 1;
  return { ...(value.length === undefined ? {} : { lengthMm: value.length * factor }), ...(value.width === undefined ? {} : { widthMm: value.width * factor }), ...(value.height === undefined ? {} : { heightMm: value.height * factor }), ...(value.diameter === undefined ? {} : { diameterMm: value.diameter * factor }), measured: value.source === "measured", ...(value.uncertainty === undefined ? {} : { uncertaintyMm: value.uncertainty * factor }) };
}

function toApiInventoryCreate(input: InventoryCreateInput): CreateInventoryItem {
  return { name: input.name, kind: toApiKind(input.category), quantity: input.quantity.value, unit: toApiUnit(input.quantity.unit), evidence: toApiEvidenceInput(input.evidence), tags: [], links: (input.links ?? []).map((link) => ({ supplier: link.label, url: link.url, ...(link.label === undefined ? {} : { label: link.label }) })), ...(input.categoryNodeId === undefined ? {} : { categoryNodeId: input.categoryNodeId }), ...(input.description === undefined ? {} : { description: input.description }), ...(input.manufacturer === undefined ? {} : { manufacturer: input.manufacturer }), ...(input.model === undefined ? {} : { model: input.model }), ...(input.sku === undefined ? {} : { sku: input.sku }), ...(input.location === undefined ? {} : { location: input.location }), ...(input.condition === undefined ? {} : { condition: input.condition === "used" ? "good" : input.condition === "opened" ? "worn" : input.condition }), ...(input.dimensions === undefined ? {} : { dimensions: toApiDimensions(input.dimensions) }) };
}

function toApiInventoryUpdate(input: Omit<InventoryUpdateInput, "itemId" | "expectedVersion">): Record<string, unknown> {
  return { ...(input.name === undefined ? {} : { name: input.name }), ...(input.category === undefined ? {} : { kind: toApiKind(input.category) }), ...(input.categoryNodeId === undefined ? {} : { categoryNodeId: input.categoryNodeId }), ...(input.description === undefined ? {} : { description: input.description }), ...(input.manufacturer === undefined ? {} : { manufacturer: input.manufacturer }), ...(input.model === undefined ? {} : { model: input.model }), ...(input.sku === undefined ? {} : { sku: input.sku }), ...(input.location === undefined ? {} : { location: input.location }), ...(input.condition === undefined ? {} : { condition: input.condition === "used" ? "good" : input.condition === "opened" ? "worn" : input.condition }), ...(input.tags === undefined ? {} : { tags: [...input.tags] }), ...(input.dimensions === undefined ? {} : { dimensions: toApiDimensions(input.dimensions) }), ...(input.links === undefined ? {} : { links: input.links.map((link) => ({ supplier: link.label, url: link.url, ...(link.label === undefined ? {} : { label: link.label }) })) }) };
}

function toMcpStockEvent(event: ApiStockEvent): StockEvent {
  const kind: StockEvent["kind"] = event.type === "receipt" ? "receipt" : event.type === "count" || event.type === "correction" ? "count_correction" : event.type === "allocate" ? "allocation" : event.type === "consume" ? "use" : event.type === "dispose" ? "disposal" : event.type === "loss" ? "loss" : "return";
  return { id: event.id, itemId: event.itemId, kind, quantity: toQuantity(event.quantity, event.unit), recordedAt: event.createdAt, actorId: event.actor, ...(event.note === undefined ? {} : { note: event.note }), evidence: { state: "user_reported", source: event.source, recordedAt: event.createdAt } };
}

function toApiStockEvent(input: RecordStockEventInput): StockEventInput {
  const type: StockEventInput["type"] = input.kind === "count_correction" ? "count" : input.kind === "allocation" ? "allocate" : input.kind === "use" ? "consume" : input.kind === "disposal" ? "dispose" : input.kind;
  return { itemId: input.itemId, type, quantity: input.quantity.value, unit: toApiUnit(input.quantity.unit), ...(input.note === undefined ? {} : { note: input.note }) };
}

function toMcpProject(project: ApiProject): Project {
  const status: Project["status"] = project.status === "retired" ? "retired" : project.status === "complete" ? "complete" : "active";
  return { id: project.id, name: project.name, status, visibility: "private", ...(project.description === undefined ? {} : { description: project.description }), version: project.version, ...(project.updatedAt === undefined ? {} : { updatedAt: project.updatedAt }) };
}

function toApiProjectStatus(value: Project["status"]): ApiProject["status"] {
  return value === "retired" ? "retired" : value === "complete" ? "complete" : value === "paused" ? "validation" : "in_progress";
}

function toApiProjectCreate(input: ProjectCreateInput): CreateProject {
  return { name: input.name, ...(input.description === undefined ? {} : { description: input.description }), status: "idea" };
}

function toApiProjectWithInitialRevisionCreate(input: ProjectWithInitialRevisionCreateInput): CreateProjectWithInitialRevision {
  const summary = input.revisionSummary ?? "Planning revision";
  return {
    project: { ...toApiProjectCreate(input), ...(input.projectId === undefined ? {} : { id: input.projectId }) },
    revision: { name: summary, status: "concept", notes: summary, ...(input.revisionId === undefined ? {} : { id: input.revisionId }) },
  };
}

function toApiProjectUpdate(input: Omit<ProjectUpdateInput, "projectId" | "expectedVersion">): Record<string, unknown> {
  return { ...(input.name === undefined ? {} : { name: input.name }), ...(input.description === undefined ? {} : { description: input.description }), ...(input.status === undefined ? {} : { status: toApiProjectStatus(input.status) }) };
}

function toMcpWorkItem(item: ApiWorkItem): WorkItem {
  return { id: item.id, projectId: item.projectId, name: item.name, kind: item.kind, ...(item.description === undefined ? {} : { description: item.description }), version: item.version };
}

function toApiWorkItemCreate(input: WorkItemCreateInput): CreateWorkItem {
  return { name: input.name, kind: input.kind, ...(input.description === undefined ? {} : { description: input.description }) };
}

function toMcpRevision(value: ApiProjectRevision | ApiWorkItemRevision): Revision {
  const status = toMcpRevisionStatus(String(value.status));
  const projectId = "projectId" in value && typeof value.projectId === "string" ? value.projectId : undefined;
  const workItemId = "workItemId" in value && typeof value.workItemId === "string" ? value.workItemId : undefined;
  return { id: value.id, number: value.number, status, ...(projectId === undefined ? {} : { projectId }), ...(workItemId === undefined ? {} : { workItemId }), version: value.version };
}

function toMcpRevisionStatus(value: string): Revision["status"] {
  switch (value) {
    case "concept": return "concept";
    case "CAD complete": return "cad_complete";
    case "DFAM reviewed": return "dfam_reviewed";
    case "mesh validated": return "mesh_validated";
    case "slicer validated": return "slicer_validated";
    case "test printed": return "test_printed";
    case "fit/function verified": return "fit_function_verified";
    case "production approved": return "production_approved";
    default: return "concept";
  }
}

function assertArtifactRevision(artifact: ApiArtifact, revisionId: string | undefined): void {
  if (revisionId !== undefined && artifact.revisionId !== revisionId) {
    throw new McpAdapterError("NOT_FOUND", "The artifact is not part of the requested revision.");
  }
}

function toApiProjectRevisionCreate(input: ProjectRevisionCreateInput): CreateProjectRevision {
  return { name: input.summary ?? "Planning revision", status: "concept", ...(input.summary === undefined ? {} : { notes: input.summary }) };
}

function toApiWorkItemRevisionCreate(input: WorkItemRevisionCreateInput): CreateWorkItemRevision {
  return { name: input.summary ?? "Engineering revision", status: "concept", ...(input.summary === undefined ? {} : { notes: input.summary }) };
}

function toMcpBomAlternative(alternative: ApiBomLine["alternatives"][number]): BomAlternative {
  return { itemId: alternative.itemId, compatible: alternative.compatible, ...(alternative.reason === undefined ? {} : { reason: alternative.reason }) };
}

function toMcpBomConstraints(value: ApiBomLine["constraints"]): BomConstraints {
  const result: Partial<Record<BomConstraintKey, string>> & { specification?: BomConstraints["specification"] } = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (key === "specification") {
      const specification = bomSpecificationSchema.safeParse(candidate);
      if (!specification.success) throw new McpAdapterError("BACKEND_ERROR", "The BOM specification decision is malformed.");
      result.specification = specification.data;
      continue;
    }
    if (!(BOM_CONSTRAINT_KEYS as readonly string[]).includes(key) || typeof candidate !== "string") {
      throw new McpAdapterError("BACKEND_ERROR", `The BOM contains unsupported constraint '${key}'.`);
    }
    result[key as BomConstraintKey] = candidate;
  }
  return result;
}

function toApiBomConstraints(value: BomConstraints | undefined): ApiBomLine["constraints"] {
  if (value === undefined) return {};
  const result: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (key === "specification") {
      const specification = bomSpecificationSchema.safeParse(candidate);
      if (!specification.success) {
        throw new McpAdapterError("INVALID_ARGUMENT", "BOM specification must be a bounded decision object.");
      }
      result[key] = specification.data;
      continue;
    }
    if (!(BOM_CONSTRAINT_KEYS as readonly string[]).includes(key) || typeof candidate !== "string") {
      throw new McpAdapterError("INVALID_ARGUMENT", `BOM constraint '${key}' is unsupported; use one of: ${BOM_CONSTRAINT_KEYS.join(", ")}.`);
    }
    result[key] = candidate;
  }
  return result as ApiBomLine["constraints"];
}

function toApiBomAlternatives(input: { alternatives?: readonly BomAlternative[]; compatibleItemIds?: readonly string[] }): ApiBomLine["alternatives"] {
  if (input.alternatives !== undefined && input.compatibleItemIds !== undefined) {
    throw new McpAdapterError("INVALID_ARGUMENT", "alternatives and compatibleItemIds cannot both be provided; use structured alternatives.");
  }
  if (input.alternatives !== undefined) {
    return input.alternatives.map((alternative) => ({ itemId: alternative.itemId, compatible: alternative.compatible, ...(alternative.reason === undefined ? {} : { reason: alternative.reason }) }));
  }
  return (input.compatibleItemIds ?? []).map((itemId) => ({ itemId, compatible: "conditional" as const }));
}

function toMcpBomMatch(line: BomGap, itemId: string): BomMatch {
  const candidate = line.candidates.find((value) => value.itemId === itemId);
  if (candidate === undefined) {
    throw new McpAdapterError("BACKEND_ERROR", `BOM candidate facts are missing for '${itemId}'.`);
  }
  const availableQuantity = { value: candidate.availableQuantity, unit: fromApiUnit(line.unit) };
  const suppliedQuantity = { value: candidate.suppliedQuantity, unit: fromApiUnit(line.unit) };
  const inspectQuantity = { value: candidate.inspectQuantity, unit: fromApiUnit(line.unit) };
  const availability: Availability = candidate.compatibility === "confirmed"
    ? candidate.availableQuantity > 0 ? "confirmed" : "depleted"
    : candidate.availableQuantity > 0 || candidate.inspectQuantity > 0 ? "inspect_first" : "depleted";
  return {
    itemId,
    availableQuantity,
    suppliedQuantity,
    inspectQuantity,
    ...(candidate.suppliedQuantity > 0 ? { quantity: suppliedQuantity } : {}),
    availability,
    compatible: candidate.compatibility,
    reason: candidate.reason,
  };
}

function toMcpBomLine(line: ApiBomLine): BomLine {
  const alternatives = line.alternatives.map(toMcpBomAlternative);
  return {
    id: line.id,
    projectRevisionId: line.revisionId,
    description: line.name,
    quantity: line.requiredQuantity,
    unit: fromApiUnit(line.unit),
    requirement: line.optional ? "optional" : "required",
    ...(line.itemId === undefined ? {} : { itemId: line.itemId }),
    ...(alternatives.length === 0 ? {} : { alternatives, compatibleItemIds: alternatives.map((alternative) => alternative.itemId) }),
    ...(Object.keys(line.constraints ?? {}).length === 0 ? {} : { constraints: toMcpBomConstraints(line.constraints) }),
    ...(line.notes === undefined ? {} : { notes: line.notes }),
    ...(line.retiredAt === undefined ? {} : { retiredAt: line.retiredAt }),
    version: line.version,
  };
}

function toApiBomCreate(input: BomLineCreateInput): CreateBomLine {
  return { name: input.description, requiredQuantity: input.quantity, unit: toApiUnit(input.unit), optional: input.requirement === "optional", ...(input.itemId === undefined ? {} : { itemId: input.itemId }), alternatives: toApiBomAlternatives(input), constraints: toApiBomConstraints(input.constraints), ...(input.notes === undefined ? {} : { notes: input.notes }) };
}

function toApiBomUpdate(input: Omit<BomLineUpdateInput, "bomLineId" | "expectedVersion">): Record<string, unknown> {
  return { ...(input.description === undefined ? {} : { name: input.description }), ...(input.quantity === undefined ? {} : { requiredQuantity: input.quantity }), ...(input.unit === undefined ? {} : { unit: toApiUnit(input.unit) }), ...(input.requirement === undefined ? {} : { optional: input.requirement === "optional" }), ...(input.itemId === undefined ? {} : { itemId: input.itemId }), ...((input.alternatives !== undefined || input.compatibleItemIds !== undefined) ? { alternatives: toApiBomAlternatives(input) } : {}), ...(input.constraints === undefined ? {} : { constraints: toApiBomConstraints(input.constraints) }), ...(input.notes === undefined ? {} : { notes: input.notes }) };
}

function toMcpBomEvaluation(value: { revisionId: string; lines: readonly BomGap[]; totals: { requiredLines: number; suppliedLines: number; inspectFirstLines: number; partialLines: number; missingLines: number; optionalLines: number; readyLines?: number; checkLines?: number; decideLines?: number; sourceLines?: number } }, _input: BomEvaluationInput): BomEvaluation {
  const decisionFor = (line: BomGap): NonNullable<BomGap["decision"]> => {
    if (line.decision !== undefined) return line.decision;
    if (line.status === "supplied") return "ready";
    if (line.status === "inspect_first") return "check";
    if (line.status === "partially_supplied") return line.inspectQuantity > 0 ? "check" : "source";
    if (line.status === "specify_first") return "decide";
    return "source";
  };
  return {
    projectRevisionId: value.revisionId,
    generatedAt: new Date().toISOString(),
    lines: value.lines.map((line) => {
      const decision = decisionFor(line);
      const state = line.status === "partially_supplied" ? "partial" : line.status === "inspect_first" ? "inspect_first" : line.status;
      const recommendedAction = decision === "ready" ? "reuse" : decision === "check" ? "inspect" : decision === "decide" ? "specify" : line.status === "optional" ? "none" : "buy";
      return {
        bomLineId: line.lineId,
        description: line.name,
        requested: { value: line.requiredQuantity, unit: fromApiUnit(line.unit) },
        requirement: line.optional === true ? "optional" : "required",
        state,
        decision,
        ...(line.missingDecisions === undefined ? {} : { missingDecisions: line.missingDecisions }),
        supplied: { value: line.suppliedQuantity, unit: fromApiUnit(line.unit) },
        matches: line.matchedItemIds.map((itemId) => toMcpBomMatch(line, itemId)),
        recommendedAction,
        explanation: line.reasons.join(" "),
      };
    }),
    totals: {
      required: value.totals.requiredLines,
      optional: value.totals.optionalLines,
      supplied: value.totals.suppliedLines,
      inspectFirst: value.totals.inspectFirstLines,
      partial: value.totals.partialLines,
      missing: value.totals.missingLines,
      ready: value.totals.readyLines ?? value.lines.filter((line) => line.optional !== true && decisionFor(line) === "ready").length,
      check: value.totals.checkLines ?? value.lines.filter((line) => line.optional !== true && decisionFor(line) === "check").length,
      decide: value.totals.decideLines ?? value.lines.filter((line) => line.optional !== true && decisionFor(line) === "decide").length,
      source: value.totals.sourceLines ?? value.lines.filter((line) => line.optional !== true && decisionFor(line) === "source").length,
    },
  };
}

function toApiReservation(input: ReservationInput): CreateReservation {
  return { lineId: input.bomLineId, itemId: input.itemId, quantity: input.quantity.value };
}

async function mapReservation(
  value: Mutation<ApiReservation>,
  detailsResolver: (reservationId: string) => Promise<ReservationDetails | null>,
  hint?: { projectRevisionId: string; unit: Quantity['unit'] },
): Promise<Reservation> {
  const reservation = value.data;
  // The create command already carries the exact revision/unit and the
  // application service validates that relationship atomically. A release
  // response has neither field, so it must be resolved from durable state.
  const resolved = hint ?? await detailsResolver(reservation.id);
  if (resolved === null) {
    throw new McpAdapterError("BACKEND_ERROR", "The reservation was committed but its durable project revision could not be resolved.");
  }
  return {
    id: reservation.id,
    projectRevisionId: resolved.projectRevisionId,
    bomLineId: reservation.lineId,
    itemId: reservation.itemId,
    quantity: { value: reservation.quantity, unit: resolved.unit },
    status: reservation.status,
    version: reservation.version,
  };
}

function toMcpArtifact(value: ApiArtifact): Artifact {
  const revision = value.revisionId === undefined
    ? {}
    : value.workItemId === undefined
      ? { projectRevisionId: value.revisionId }
      : { workItemRevisionId: value.revisionId };
  return { id: value.id, projectId: value.projectId, ...(value.workItemId === undefined ? {} : { workItemId: value.workItemId }), ...revision, filename: value.filename, role: toMcpArtifactRole(value.role), mediaType: value.mediaType, byteLength: value.byteSize, sha256: value.sha256, revision: value.version, status: value.retired ? "retired" : value.currentCandidate ? "candidate" : "frozen", ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }) };
}

function toApiArtifactRole(role: BeginArtifactUploadInput["role"]): ApiArtifact["role"] {
  return role as ApiArtifact["role"];
}

function toMcpArtifactRole(role: ApiArtifact["role"]): Artifact["role"] {
  return role as Artifact["role"];
}

function toMcpOffer(value: ApiOffer): Offer {
  return { id: value.id, ...(value.itemId === undefined ? {} : { itemId: value.itemId }), description: value.name, supplier: value.supplier, url: value.url, ...(value.packageQuantity === undefined ? {} : { packageQuantity: { value: value.packageQuantity, unit: "piece" } }), price: { minor: value.priceMinor, currency: value.currency }, ...(value.shippingMinor === undefined ? {} : { shippingMinor: value.shippingMinor }), observedAt: value.observedAt, ...(value.notes === undefined ? {} : { evidence: { state: "user_reported", source: "offer_snapshot", recordedAt: value.observedAt, note: value.notes } }) };
}

function toApiOfferCreate(input: RecordOfferSnapshotInput): CreateOffer {
  return { ...(input.itemId === undefined ? {} : { itemId: input.itemId }), name: input.description ?? "Supplier offer", supplier: input.supplier, url: input.url, priceMinor: input.price.minor, currency: input.price.currency, ...(input.packageQuantity === undefined ? {} : { packageQuantity: input.packageQuantity.value }), ...(input.shippingMinor === undefined ? {} : { shippingMinor: input.shippingMinor }), observedAt: input.observedAt ?? new Date().toISOString(), staleAfterDays: 30 };
}
