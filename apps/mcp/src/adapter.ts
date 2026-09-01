import { CAPABILITY_DOCUMENT, RESOURCE_TEMPLATES, RESOURCES, TOOL_DEFINITIONS } from "./capabilities.js";
import { McpAdapterError, mapBackendError } from "./errors.js";
import {
  artifactList,
  artifactMetadata,
  assertProjectAccess,
  assertScope,
  beginArtifactUpload,
  buildConfigurationCreate,
  buildConfigurationList,
  buildConfigurationRead,
  reconciliationCommit,
  reconciliationDraftSave,
  reconciliationRead,
  bomEvaluation,
  bomLineCreate,
  bomLineList,
  bomLineUpdate,
  boundedJsonObject,
  contextRefresh,
  catalogProductCreate,
  catalogProductSearch,
  catalogProductUpdate,
  categoryId,
  categorySingleId,
  finalizeArtifactUpload,
  inventoryCreate,
  inventoryCategoryList,
  inventoryCategoryCreate,
  inventoryCategoryUpdate,
  inventoryCategoryArchive,
  inventoryWithProductProfileCreate,
  inventoryProductProfileLink,
  inventoryProductProfileRead,
  inventoryList,
  inventoryUpdate,
  id,
  offerList,
  parsePageInput,
  projectCreate,
  projectWithInitialRevisionCreate,
  projectList,
  projectRevisionCreate,
  projectUpdate,
  recordOffer,
  retireBomLine,
  retireProject,
  reservation,
  releaseReservation,
  retireArtifact,
  revisionRead,
  safeHttpLink,
  singleId,
  stockEvent,
  stockEvents,
  usage,
  workItemCreate,
  workItemRevisionCreate,
} from "./validation.js";
import type {
  ArtifactDownloadMetadata,
  ArtifactUploadTicket,
  BenchLedgerBackend,
  JsonObject,
  McpRequestContext,
  McpResource,
  McpResourceReadResult,
  McpResourceTemplate,
  McpToolDefinition,
  McpToolResult,
} from "./types.js";

export interface McpAdapterOptions {
  /** Maximum serialized tool result in bytes. */
  maxToolResultBytes?: number;
  /** Maximum serialized resource result in bytes. */
  maxResourceBytes?: number;
}

export type ToolHandler = (input: unknown, context: McpRequestContext) => Promise<unknown>;

export interface ResourceReadOptions {
  maxBytes?: number;
}

const DEFAULT_TOOL_RESULT_BYTES = 128 * 1024;
const DEFAULT_RESOURCE_BYTES = 64 * 1024;
// The static capability document contains JSON Schema input definitions, so
// it is intentionally deeper than ordinary backend payloads. Keep the normal
// result depth limit for all untrusted data.
const CAPABILITY_DOCUMENT_MAX_DEPTH = 24;

function emptyObject(value: unknown): JsonObject {
  if (value === undefined) return {};
  return boundedJsonObject(value, DEFAULT_TOOL_RESULT_BYTES);
}

function errorPayload(error: McpAdapterError): JsonObject {
  const result: JsonObject = { error: { code: error.code, message: error.message } };
  if (error.details !== undefined) result.error = { code: error.code, message: error.message, details: error.details };
  return result;
}

function okResult(value: unknown, maxBytes: number, maxDepth = 12): McpToolResult {
  const structuredContent = boundedJsonObject(value ?? {}, maxBytes, "result", maxDepth);
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: false,
  };
}

function failedResult(error: unknown): McpToolResult {
  const mapped = mapBackendError(error);
  const structuredContent = errorPayload(mapped);
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new McpAdapterError("BACKEND_ERROR", `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function validateArtifactLinks(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) validateArtifactLinks(entry);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "uploadUrl" || key === "downloadUrl") safeHttpLink(entry, key);
    validateArtifactLinks(entry);
  }
}

function resourceId(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new McpAdapterError("INVALID_RESOURCE", `${label} contains an invalid encoded identifier.`);
  }
  return id(decoded, label);
}

function categoryResourceId(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new McpAdapterError("INVALID_RESOURCE", `${label} contains an invalid encoded identifier.`);
  }
  return categoryId(decoded, label);
}

function projectIdFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const candidate = (input as Record<string, unknown>).projectId;
  return typeof candidate === "string" ? candidate : undefined;
}

function inputString(input: unknown, field: string): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const candidate = (input as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : undefined;
}

function isProjectScoped(context: McpRequestContext): boolean {
  return context.projectIds !== undefined;
}

function rejectScopedGlobalWrite(context: McpRequestContext, message: string): void {
  if (isProjectScoped(context)) throw new McpAdapterError("FORBIDDEN", message);
}

function rejectScopedGlobalAccess(context: McpRequestContext, message: string): void {
  if (isProjectScoped(context)) throw new McpAdapterError("FORBIDDEN", message);
}

function requireCatalogBackend(adapter: McpAdapter): NonNullable<BenchLedgerBackend["catalog"]> {
  if (adapter.backend.catalog === undefined) throw new McpAdapterError("BACKEND_ERROR", "The catalog backend is not configured for this MCP host.");
  return adapter.backend.catalog;
}

function requireInventoryCategoriesBackend(adapter: McpAdapter): NonNullable<BenchLedgerBackend["inventoryCategories"]> {
  if (adapter.backend.inventoryCategories === undefined) throw new McpAdapterError("BACKEND_ERROR", "The inventory category backend is not configured for this MCP host.");
  return adapter.backend.inventoryCategories;
}

function requireAtomicInventoryBackend(adapter: McpAdapter): NonNullable<BenchLedgerBackend["inventory"]["createWithProductProfile"]> {
  const create = adapter.backend.inventory.createWithProductProfile;
  if (create === undefined) throw new McpAdapterError("BACKEND_ERROR", "The atomic inventory/profile command is not configured for this MCP host.");
  return create;
}

function requireBuildConfigurationsBackend(adapter: McpAdapter): NonNullable<BenchLedgerBackend["buildConfigurations"]> {
  if (adapter.backend.buildConfigurations === undefined) throw new McpAdapterError("BACKEND_ERROR", "The build configuration backend is not configured for this MCP host.");
  return adapter.backend.buildConfigurations;
}

function requireReconciliationBackend(adapter: McpAdapter): NonNullable<BenchLedgerBackend["reconciliation"]> {
  if (adapter.backend.reconciliation === undefined) throw new McpAdapterError("BACKEND_ERROR", "The reconciliation backend is not configured for this MCP host.");
  return adapter.backend.reconciliation;
}

/** Remove serial-like fields at the MCP boundary without mutating backend data. */
function redactSerials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSerials);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:serial|serialNumber|serialNo)$/iu.test(key)) continue;
    result[key] = redactSerials(entry);
  }
  return result;
}

async function assertResolvedProjectAccess(
  context: McpRequestContext,
  resolver: (() => Promise<string | null>) | undefined,
  label: string,
  expectedProjectId?: string,
): Promise<void> {
  if (!isProjectScoped(context)) return;
  if (resolver === undefined) {
    throw new McpAdapterError("FORBIDDEN", `A project-scoped token cannot address ${label} without a project ancestry lookup.`);
  }
  let projectId: string | null;
  try {
    projectId = await resolver();
  } catch {
    // A scoped identifier must not become an existence oracle.
    throw new McpAdapterError("FORBIDDEN", `The current token is not allowed to address this ${label}.`);
  }
  // Keep both an unknown identifier and an identifier belonging to another
  // project indistinguishable.  Calling assertProjectAccess here would emit a
  // different message for the latter and turn this lookup into an existence
  // oracle at the MCP boundary.
  if (projectId === null || !context.projectIds?.includes(projectId) || (expectedProjectId !== undefined && projectId !== expectedProjectId)) {
    throw new McpAdapterError("FORBIDDEN", `The current token is not allowed to address this ${label}.`);
  }
}

async function assertAnyRevisionAccess(adapter: McpAdapter, context: McpRequestContext, revisionId: string, label: string, expectedProjectId?: string): Promise<void> {
  if (!isProjectScoped(context)) return;
  const projectRevisionResolver = adapter.backend.projectScope?.projectForProjectRevision;
  const workItemRevisionResolver = adapter.backend.projectScope?.projectForWorkItemRevision;
  if (projectRevisionResolver === undefined && workItemRevisionResolver === undefined) {
    throw new McpAdapterError("FORBIDDEN", `A project-scoped token cannot address ${label} without a project ancestry lookup.`);
  }
  let projectId: string | null = null;
  if (projectRevisionResolver !== undefined) {
    try { projectId = await projectRevisionResolver(revisionId); } catch {
      throw new McpAdapterError("FORBIDDEN", `The current token is not allowed to address this ${label}.`);
    }
  }
  if (projectId === null && workItemRevisionResolver !== undefined) {
    try { projectId = await workItemRevisionResolver(revisionId); } catch {
      throw new McpAdapterError("FORBIDDEN", `The current token is not allowed to address this ${label}.`);
    }
  }
  if (projectId === null || !context.projectIds?.includes(projectId) || (expectedProjectId !== undefined && projectId !== expectedProjectId)) {
    throw new McpAdapterError("FORBIDDEN", `The current token is not allowed to address this ${label}.`);
  }
}

/**
 * Authorize indirect project identifiers before invoking a backend operation.
 * This is deliberately fail-closed for project-scoped contexts: a backend
 * that cannot prove ancestry must not receive a mutating request.
 */
async function authorizeProjectScope(adapter: McpAdapter, name: string, input: unknown, context: McpRequestContext): Promise<void> {
  if (!isProjectScoped(context)) return;

  const directProjectId = projectIdFromInput(input);
  if (directProjectId !== undefined) assertProjectAccess(context, directProjectId);

  const projectRevisionId = inputString(input, "projectRevisionId");
  if (projectRevisionId !== undefined) {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForProjectRevision === undefined ? undefined : () => adapter.backend.projectScope!.projectForProjectRevision!(projectRevisionId), "project revision");
  }

  const workItemId = inputString(input, "workItemId");
  if (workItemId !== undefined) {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForWorkItem === undefined ? undefined : () => adapter.backend.projectScope!.projectForWorkItem!(workItemId), "work item");
  }

  const workItemRevisionId = inputString(input, "workItemRevisionId");
  if (workItemRevisionId !== undefined) {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForWorkItemRevision === undefined ? undefined : () => adapter.backend.projectScope!.projectForWorkItemRevision!(workItemRevisionId), "work-item revision");
  }

  const bomLineId = inputString(input, "bomLineId");
  if (bomLineId !== undefined) {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForBomLine === undefined ? undefined : () => adapter.backend.projectScope!.projectForBomLine!(bomLineId), "BOM line");
  }

  const reservationId = inputString(input, "reservationId");
  if (reservationId !== undefined) {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForReservation === undefined ? undefined : () => adapter.backend.projectScope!.projectForReservation!(reservationId), "reservation");
  }

  const artifactId = inputString(input, "artifactId");
  if (artifactId !== undefined) {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForArtifact === undefined ? undefined : () => adapter.backend.projectScope!.projectForArtifact!(artifactId), "artifact");
  }

  const uploadId = inputString(input, "uploadId");
  if (uploadId !== undefined) {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForUpload === undefined ? undefined : () => adapter.backend.projectScope!.projectForUpload!(uploadId), "upload");
  }

  const buildConfigurationId = inputString(input, "buildConfigurationId");
  if (buildConfigurationId !== undefined) {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForBuildConfiguration === undefined ? undefined : () => adapter.backend.projectScope!.projectForBuildConfiguration!(buildConfigurationId), "build configuration");
  }

  const buildConfigurationSnapshotId = inputString(input, "buildConfigurationSnapshotId");
  if (buildConfigurationSnapshotId !== undefined) {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForBuildConfiguration === undefined ? undefined : () => adapter.backend.projectScope!.projectForBuildConfiguration!(buildConfigurationSnapshotId), "build configuration");
  }

  const supersedesSnapshotId = inputString(input, "supersedesSnapshotId");
  if (supersedesSnapshotId !== undefined) {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForBuildConfiguration === undefined ? undefined : () => adapter.backend.projectScope!.projectForBuildConfiguration!(supersedesSnapshotId), "build configuration");
  }

  const revisionId = inputString(input, "revisionId");
  if (revisionId !== undefined && (name === "read_project_revision" || name === "list_bom_lines" || name === "calculate_bom_gaps")) {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForProjectRevision === undefined ? undefined : () => adapter.backend.projectScope!.projectForProjectRevision!(revisionId), "project revision");
  } else if (revisionId !== undefined && name === "read_work_item_revision") {
    await assertResolvedProjectAccess(context, adapter.backend.projectScope?.projectForWorkItemRevision === undefined ? undefined : () => adapter.backend.projectScope!.projectForWorkItemRevision!(revisionId), "work-item revision");
  } else if (revisionId !== undefined && (name === "list_artifacts" || name === "read_artifact_metadata" || name === "read_artifact_download_metadata" || name === "download_artifact")) {
    await assertAnyRevisionAccess(adapter, context, revisionId, "artifact revision", directProjectId);
  }

  if (name === "create_project" || name === "create_project_with_initial_revision") {
    rejectScopedGlobalWrite(context, "A project-scoped token cannot create a new workspace outside its allow-list.");
  }
  if (name === "create_inventory_item" || name === "create_inventory_with_product_profile" || name === "update_inventory_item" || name === "record_stock_event" || name === "create_inventory_category" || name === "update_inventory_category" || name === "archive_inventory_category") {
    rejectScopedGlobalWrite(context, "Inventory is workspace-global; project-scoped tokens may read it but cannot mutate it.");
  }
  if (name === "create_catalog_product" || name === "update_catalog_product") {
    rejectScopedGlobalWrite(context, "Catalog products are workspace-global; project-scoped tokens may read them but cannot mutate them.");
  }
  if (name === "read_inventory_product_profile" || name === "link_inventory_product_profile") {
    rejectScopedGlobalAccess(context, "Physical product profiles are workspace-global and require an unscoped catalog token.");
  }
  if (name === "record_offer_snapshot") {
    rejectScopedGlobalWrite(context, "Supplier offers are workspace-global; project-scoped tokens may compare them but cannot record them.");
  }
  if (name === "list_offers" && inputString(input, "itemId") === undefined) {
    throw new McpAdapterError("FORBIDDEN", "A project-scoped token must provide an inventory item when reading global offers.");
  }
  if (name === "finalize_artifact_upload" && adapter.backend.projectScope?.projectForUpload === undefined) {
    throw new McpAdapterError("FORBIDDEN", "A project-scoped token cannot finalize an upload without a project ancestry lookup.");
  }
}

/**
 * The MCP-facing application adapter. It contains no model calls and no
 * persistence knowledge; every operation delegates to one atomic backend
 * application-service method.
 */
export class McpAdapter {
  readonly backend: BenchLedgerBackend;
  readonly maxToolResultBytes: number;
  readonly maxResourceBytes: number;
  private readonly handlers: ReadonlyMap<string, ToolHandler>;
  private readonly definitions: ReadonlyMap<string, McpToolDefinition>;

  constructor(backend: BenchLedgerBackend, options: McpAdapterOptions = {}) {
    this.backend = backend;
    this.maxToolResultBytes = options.maxToolResultBytes ?? DEFAULT_TOOL_RESULT_BYTES;
    this.maxResourceBytes = options.maxResourceBytes ?? DEFAULT_RESOURCE_BYTES;
    this.definitions = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
    this.handlers = new Map<string, ToolHandler>([
      ["read_inventory_summary", (input, context) => this.backend.inventory.summary(parsePageInput(input), context)],
      ["list_inventory", (input, context) => this.backend.inventory.list(inventoryList(input), context)],
      ["read_inventory_item", (input, context) => this.backend.inventory.get({ itemId: singleId(input, "itemId") }, context)],
      ["create_inventory_item", (input, context) => this.backend.inventory.create(inventoryCreate(input), context)],
      ["create_inventory_with_product_profile", (input, context) => requireAtomicInventoryBackend(this)(inventoryWithProductProfileCreate(input), context)],
      ["update_inventory_item", (input, context) => this.backend.inventory.update(inventoryUpdate(input), context)],
      ["record_stock_event", (input, context) => this.backend.inventory.recordStockEvent(stockEvent(input), context)],
      ["list_stock_events", (input, context) => this.backend.inventory.listStockEvents(stockEvents(input), context)],
      ["list_inventory_categories", (input, context) => requireInventoryCategoriesBackend(this).list(inventoryCategoryList(input), context)],
      ["read_inventory_category", (input, context) => requireInventoryCategoriesBackend(this).get({ categoryId: categorySingleId(input, "categoryId") }, context)],
      ["create_inventory_category", (input, context) => requireInventoryCategoriesBackend(this).create(inventoryCategoryCreate(input), context)],
      ["update_inventory_category", (input, context) => requireInventoryCategoriesBackend(this).update(inventoryCategoryUpdate(input), context)],
      ["archive_inventory_category", (input, context) => requireInventoryCategoriesBackend(this).archive(inventoryCategoryArchive(input), context)],

      ["search_catalog_products", (input, context) => requireCatalogBackend(this).search(catalogProductSearch(input), context)],
      ["read_catalog_product", (input, context) => requireCatalogBackend(this).get({ productId: singleId(input, "productId") }, context)],
      ["create_catalog_product", (input, context) => requireCatalogBackend(this).create(catalogProductCreate(input), context)],
      ["update_catalog_product", (input, context) => requireCatalogBackend(this).update(catalogProductUpdate(input), context)],
      ["read_inventory_product_profile", (input, context) => requireCatalogBackend(this).readProfile(inventoryProductProfileRead(input), context)],
      ["link_inventory_product_profile", (input, context) => requireCatalogBackend(this).linkProfile(inventoryProductProfileLink(input), context)],

      ["create_build_configuration", (input, context) => requireBuildConfigurationsBackend(this).create(buildConfigurationCreate(input), context)],
      ["list_build_configurations", (input, context) => requireBuildConfigurationsBackend(this).list(buildConfigurationList(input), context)],
      ["read_build_configuration", (input, context) => requireBuildConfigurationsBackend(this).get(buildConfigurationRead(input), context)],

      ["read_reconciliation", (input, context) => requireReconciliationBackend(this).read(reconciliationRead(input), context).then((draft) => ({ draft }))],
      ["save_reconciliation_draft", (input, context) => requireReconciliationBackend(this).save(reconciliationDraftSave(input), context)],
      ["commit_reconciliation", (input, context) => requireReconciliationBackend(this).commit(reconciliationCommit(input), context)],

      ["list_projects", (input, context) => this.backend.projects.list(projectList(input), context)],
      ["read_project", (input, context) => this.backend.projects.get({ projectId: singleId(input, "projectId") }, context)],
      ["create_project", (input, context) => this.backend.projects.create(projectCreate(input), context)],
      ["create_project_with_initial_revision", (input, context) => this.backend.projects.createWithInitialRevision(projectWithInitialRevisionCreate(input), context)],
      ["update_project", (input, context) => this.backend.projects.update(projectUpdate(input), context)],
      ["retire_project", (input, context) => this.backend.projects.retire(retireProject(input), context)],
      ["create_work_item", (input, context) => this.backend.projects.createWorkItem(workItemCreate(input), context)],
      ["read_work_item", (input, context) => this.backend.projects.getWorkItem({ workItemId: singleId(input, "workItemId") }, context)],
      ["create_project_revision", (input, context) => this.backend.projects.createProjectRevision(projectRevisionCreate(input), context)],
      ["read_project_revision", (input, context) => this.backend.projects.getProjectRevision(revisionRead(input), context)],
      ["create_work_item_revision", (input, context) => this.backend.projects.createWorkItemRevision(workItemRevisionCreate(input), context)],
      ["read_work_item_revision", (input, context) => this.backend.projects.getWorkItemRevision(revisionRead(input), context)],

      ["list_bom_lines", (input, context) => this.backend.bom.listLines(bomLineList(input), context)],
      ["create_bom_line", (input, context) => this.backend.bom.createLine(bomLineCreate(input), context)],
      ["update_bom_line", (input, context) => this.backend.bom.updateLine(bomLineUpdate(input), context)],
      ["retire_bom_line", (input, context) => this.backend.bom.retireLine(retireBomLine(input), context)],
      ["calculate_bom_gaps", (input, context) => this.backend.bom.evaluate(bomEvaluation(input), context)],
      ["create_reservation", (input, context) => this.backend.bom.reserve(reservation(input), context)],
      ["release_reservation", (input, context) => this.backend.bom.release(releaseReservation(input), context)],
      ["record_usage", (input, context) => this.backend.bom.recordUsage(usage(input), context)],

      ["list_artifacts", (input, context) => this.backend.artifacts.list(artifactList(input), context)],
      ["read_artifact_metadata", (input, context) => this.backend.artifacts.getMetadata(artifactMetadata(input), context)],
      ["begin_artifact_upload", (input, context) => this.backend.artifacts.beginUpload(beginArtifactUpload(input), context)],
      ["finalize_artifact_upload", (input, context) => this.backend.artifacts.finalizeUpload(finalizeArtifactUpload(input), context)],
      ["read_artifact_download_metadata", (input, context) => this.backend.artifacts.downloadMetadata(artifactMetadata(input), context)],
      ["download_artifact", (input, context) => this.backend.artifacts.downloadMetadata(artifactMetadata(input), context)],
      ["retire_artifact", (input, context) => this.backend.artifacts.retire(retireArtifact(input), context)],

      ["list_offers", (input, context) => this.backend.offers.list(offerList(input), context)],
      ["record_offer_snapshot", (input, context) => this.backend.offers.recordSnapshot(recordOffer(input), context)],
      ["refresh_context", (input, context) => this.backend.context.refresh(contextRefresh(input), context)],
      ["get_capabilities", () => Promise.resolve(CAPABILITY_DOCUMENT)],
    ]);
  }

  listTools(): readonly McpToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  listResources(): readonly McpResource[] {
    return RESOURCES;
  }

  listResourceTemplates(): readonly McpResourceTemplate[] {
    return RESOURCE_TEMPLATES;
  }

  capabilityDocument(): JsonObject {
    return CAPABILITY_DOCUMENT;
  }

  async callTool(name: string, rawInput: unknown, context: McpRequestContext): Promise<McpToolResult> {
    const definition = this.definitions.get(name);
    const handler = this.handlers.get(name);
    if (definition === undefined || handler === undefined) return failedResult(new McpAdapterError("INVALID_TOOL", `Unknown BenchLedger tool '${name}'.`));

    try {
      assertScope(context.scopes, definition.requiredScope);
      if (name === "create_inventory_with_product_profile") assertScope(context.scopes, "catalog:write");
      const input = rawInput ?? {};
      await authorizeProjectScope(this, name, input, context);
      let value = await handler(input, context);
      // Filter generic project pages as a second line of defence for custom
      // backends. Production backends also filter before querying where
      // possible; this prevents accidental cross-project result leakage.
      if (name === "list_projects" && isProjectScoped(context)) {
        const page = objectValue(value, "project page");
        const items = page.items;
        const filteredItems = Array.isArray(items) ? items.filter((entry) => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
          const project = entry as Record<string, unknown>;
          return typeof project.id === "string" && context.projectIds!.includes(project.id);
        }) : [];
        value = { ...page, items: filteredItems, nextCursor: null, hasMore: false };
      }
      if (name === "begin_artifact_upload" || name === "read_artifact_download_metadata" || name === "download_artifact" || name === "finalize_artifact_upload") validateArtifactLinks(value);
      return okResult(redactSerials(value), this.maxToolResultBytes, name === "get_capabilities" ? CAPABILITY_DOCUMENT_MAX_DEPTH : undefined);
    } catch (error) {
      return failedResult(error);
    }
  }

  async readResource(uri: string, context: McpRequestContext, options: ResourceReadOptions = {}): Promise<McpResourceReadResult> {
    try {
      const result = await this.readResourceValue(uri, context);
      const maxBytes = options.maxBytes ?? this.maxResourceBytes;
      const structured = boundedJsonObject(redactSerials(result), maxBytes, `resource ${uri}`, uri === "benchledger://capabilities" ? CAPABILITY_DOCUMENT_MAX_DEPTH : undefined);
      const text = JSON.stringify(structured);
      return { contents: [{ uri, mimeType: "application/json", text }] };
    } catch (error) {
      throw mapBackendError(error);
    }
  }

  private async readResourceValue(uri: string, context: McpRequestContext): Promise<unknown> {
    if (uri === "benchledger://capabilities") {
      assertScope(context.scopes, "context:read");
      return CAPABILITY_DOCUMENT;
    }
    if (uri === "benchledger://inventory/summary") {
      assertScope(context.scopes, "inventory:read");
      return this.backend.inventory.summary({ limit: 50 }, context);
    }
    if (uri === "benchledger://inventory/categories") {
      assertScope(context.scopes, "inventory:read");
      return requireInventoryCategoriesBackend(this).list({ limit: 50 }, context);
    }

    const catalogProductMatch = /^benchledger:\/\/catalog\/products\/([^/]+)$/.exec(uri);
    if (catalogProductMatch !== null) {
      assertScope(context.scopes, "catalog:read");
      return requireCatalogBackend(this).get({ productId: resourceId(catalogProductMatch[1]!, "productId") }, context);
    }

    const inventoryProfileMatch = /^benchledger:\/\/inventory\/items\/([^/]+)\/product-profile$/.exec(uri);
    if (inventoryProfileMatch !== null) {
      assertScope(context.scopes, "catalog:read");
      rejectScopedGlobalAccess(context, "Physical product profiles are workspace-global and require an unscoped catalog token.");
      return requireCatalogBackend(this).readProfile({ itemId: resourceId(inventoryProfileMatch[1]!, "itemId") }, context);
    }

    const inventoryMatch = /^benchledger:\/\/inventory\/items\/([^/]+)$/.exec(uri);
    if (inventoryMatch !== null) {
      assertScope(context.scopes, "inventory:read");
      return this.backend.inventory.get({ itemId: resourceId(inventoryMatch[1]!, "itemId") }, context);
    }

    const inventoryCategoryMatch = /^benchledger:\/\/inventory\/categories\/([^/]+)$/.exec(uri);
    if (inventoryCategoryMatch !== null) {
      assertScope(context.scopes, "inventory:read");
      return requireInventoryCategoriesBackend(this).get({ categoryId: categoryResourceId(inventoryCategoryMatch[1]!, "categoryId") }, context);
    }

    const projectContextMatch = /^benchledger:\/\/projects\/([^/]+)\/context$/.exec(uri);
    if (projectContextMatch !== null) {
      assertScope(context.scopes, "projects:read");
      const projectId = resourceId(projectContextMatch[1]!, "projectId");
      assertProjectAccess(context, projectId);
      return this.backend.projects.context({ projectId }, context);
    }

    const revisionMatch = /^benchledger:\/\/projects\/([^/]+)\/revisions\/([^/]+)$/.exec(uri);
    if (revisionMatch !== null) {
      assertScope(context.scopes, "projects:read");
      const projectId = resourceId(revisionMatch[1]!, "projectId");
      const revisionId = resourceId(revisionMatch[2]!, "revisionId");
      assertProjectAccess(context, projectId);
      await assertResolvedProjectAccess(context, this.backend.projectScope?.projectForProjectRevision === undefined ? undefined : () => this.backend.projectScope!.projectForProjectRevision!(revisionId), "project revision", projectId);
      const revision = await this.backend.projects.getProjectRevision({ revisionId }, context);
      if (revision.projectId !== projectId) throw new McpAdapterError("FORBIDDEN", isProjectScoped(context) ? "The current token is not allowed to address this project revision." : "The requested revision is not part of this project.");
      return revision;
    }

    const buildConfigurationsMatch = /^benchledger:\/\/projects\/([^/]+)\/revisions\/([^/]+)\/build-configurations$/.exec(uri);
    if (buildConfigurationsMatch !== null) {
      assertScope(context.scopes, "projects:read");
      const projectId = resourceId(buildConfigurationsMatch[1]!, "projectId");
      const revisionId = resourceId(buildConfigurationsMatch[2]!, "revisionId");
      assertProjectAccess(context, projectId);
      await assertResolvedProjectAccess(context, this.backend.projectScope?.projectForProjectRevision === undefined ? undefined : () => this.backend.projectScope!.projectForProjectRevision!(revisionId), "project revision", projectId);
      const revision = await this.backend.projects.getProjectRevision({ revisionId }, context);
      if (revision.projectId !== projectId) throw new McpAdapterError("FORBIDDEN", isProjectScoped(context) ? "The current token is not allowed to address this project revision." : "The requested revision is not part of this project.");
      return requireBuildConfigurationsBackend(this).list({ projectRevisionId: revisionId, limit: 50 }, context);
    }

    const buildConfigurationMatch = /^benchledger:\/\/build-configurations\/([^/]+)$/.exec(uri);
    if (buildConfigurationMatch !== null) {
      assertScope(context.scopes, "projects:read");
      const buildConfigurationId = resourceId(buildConfigurationMatch[1]!, "buildConfigurationId");
      await assertResolvedProjectAccess(context, this.backend.projectScope?.projectForBuildConfiguration === undefined ? undefined : () => this.backend.projectScope!.projectForBuildConfiguration!(buildConfigurationId), "build configuration");
      const snapshot = await requireBuildConfigurationsBackend(this).get({ buildConfigurationId }, context);
      return snapshot;
    }

    const reconciliationMatch = /^benchledger:\/\/projects\/([^/]+)\/revisions\/([^/]+)\/reconciliation$/.exec(uri);
    if (reconciliationMatch !== null) {
      assertScope(context.scopes, "bom:read");
      const projectId = resourceId(reconciliationMatch[1]!, "projectId");
      const revisionId = resourceId(reconciliationMatch[2]!, "revisionId");
      assertProjectAccess(context, projectId);
      await assertResolvedProjectAccess(context, this.backend.projectScope?.projectForProjectRevision === undefined ? undefined : () => this.backend.projectScope!.projectForProjectRevision!(revisionId), "project revision", projectId);
      const revision = await this.backend.projects.getProjectRevision({ revisionId }, context);
      if (revision.projectId !== projectId) throw new McpAdapterError("FORBIDDEN", isProjectScoped(context) ? "The current token is not allowed to address this project revision." : "The requested revision is not part of this project.");
      const draft = await requireReconciliationBackend(this).read({ projectRevisionId: revisionId }, context);
      return { draft };
    }

    const bomMatch = /^benchledger:\/\/projects\/([^/]+)\/bom$/.exec(uri);
    if (bomMatch !== null) {
      assertScope(context.scopes, "bom:read");
      const projectId = resourceId(bomMatch[1]!, "projectId");
      assertProjectAccess(context, projectId);
      if (this.backend.bom.listProjectLines !== undefined) return this.backend.bom.listProjectLines({ projectId, limit: 50 }, context);
      // The fallback keeps the URI useful for backends whose current revision
      // id is also the project workspace id. Production backends should expose
      // listProjectLines so the relationship is explicit.
      return this.backend.bom.listLines({ projectRevisionId: projectId, limit: 50 }, context);
    }

    const artifactMatch = /^benchledger:\/\/projects\/([^/]+)\/artifacts$/.exec(uri);
    if (artifactMatch !== null) {
      assertScope(context.scopes, "artifacts:read");
      const projectId = resourceId(artifactMatch[1]!, "projectId");
      assertProjectAccess(context, projectId);
      return this.backend.artifacts.list({ projectId, limit: 50 }, context);
    }

    throw new McpAdapterError("INVALID_RESOURCE", `Unknown BenchLedger resource '${uri}'.`);
  }
}
