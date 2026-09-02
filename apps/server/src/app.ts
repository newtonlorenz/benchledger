import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import {
  beginUploadSchema, commissionInventoryItemSchema, createBomLineSchema, createInventoryCategorySchema, createInventoryItemSchema, createOfferSchema,
  createProjectRevisionSchema, createProjectSchema, createReservationSchema,
  createProjectWithInitialRevisionSchema, createWorkItemRevisionSchema, createWorkItemSchema, healthSchema,
  inventoryBulkUpdateSchema, inventoryCategoryListQuerySchema, inventoryListQuerySchema, stockEventInputSchema, updateBomLineSchema,
  updateInventoryCategorySchema, updateInventoryItemSchema, updateProjectSchema, usageInputSchema,
  createCatalogProductSchema, updateCatalogProductSchema,
  createInventoryProductProfileSchema, createInventoryWithProductProfileSchema, updateInventoryProductProfileSchema,
  createBuildConfigurationSnapshotSchema, saveReconciliationDraftSchema, commitReconciliationSchema,
  workspaceSecurityMutationSchema, projectStatusSchema
  , removeProjectSchema
} from "@benchledger/api-contract";
import { ApplicationError, ApplicationService } from "@benchledger/application";
import type { ApplicationPorts, BeginUploadInput, BuildConfigurationListOptions, CatalogProductListOptions, GapEvaluation, Mutation, Page, ProjectListOptions, RequestContext } from "@benchledger/application";
import { createProductionRuntime } from "@benchledger/runtime";
import { createApplicationMcpProtocol, createMcpHttpHandler } from "@benchledger/mcp";
import type { McpRequestContext, Scope as McpScope } from "@benchledger/mcp";
import type {
  Artifact as ApiArtifact, BomLine as ApiBomLine, InventoryItem as ApiInventoryItem,
  Offer as ApiOffer, Project as ApiProject, ProjectRevision as ApiProjectRevision,
  WorkItem as ApiWorkItem, CatalogProduct as ApiCatalogProduct,
  BuildConfigurationSnapshot as ApiBuildConfigurationSnapshot,
  InventoryProductProfile as ApiInventoryProductProfile,
  WorkspaceSecurityStatus as ApiWorkspaceSecurityStatus,
  WorkspaceSecurityMutation
} from "@benchledger/api-contract";
import { AuthManager, type AuthConfig, type AuthScope, type Principal, hashBearerToken } from "./auth.js";
import { createMemoryRuntime, createSyntheticRuntime, type MemoryRuntime } from "./memory-store.js";
import { ArtifactTransferManager, TRANSFER_RESPONSE_HEADERS, TRANSFER_TOKEN_HEADER, type FinalizeCapabilityBody, type TransferCapability } from "./artifact-transfer.js";
import { publicBaseUrlFromEnvironment } from "./config.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
    correlationId?: string;
  }
}

export interface ServerOptions {
  readonly ports?: ApplicationPorts;
  readonly service?: ApplicationService;
  /** Runtime owns its resources and is closed with the Fastify app. */
  readonly runtime?: RuntimeHandle;
  readonly auth?: Partial<AuthConfig>;
  readonly demo?: boolean;
  readonly dataDir?: string;
  readonly maxUploadBytes?: number;
  readonly maxStorageBytes?: number;
  readonly webRoot?: string;
  readonly version?: string;
  readonly logger?: boolean;
  readonly trustProxy?: boolean;
  /** Exact configured origin used for MCP transfer capability links. */
  readonly publicBaseUrl?: string;
  /** Host-owned transfer manager; injectable for route-level integration tests. */
  readonly artifactTransferManager?: ArtifactTransferManager;
}

export interface RuntimeHandle {
  readonly ports: ApplicationPorts;
  readonly close?: () => Promise<void>;
}

const PUBLIC_PATHS = new Set(["/api/v1/health", "/api/v1/ready", "/api/v1/auth/login", "/api/v1/auth/access", "/api/v1/auth/lan-session", "/api/v1/openapi.json", "/api/v1/capabilities"]);
const UUID_OR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function randomSecret(): string {
  return `${randomUUID()}${randomUUID()}`;
}

function validCorrelation(value: string | undefined): string {
  if (value && value.length <= 160 && UUID_OR_ID.test(value)) return value;
  return randomUUID();
}

function requestIdempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers["idempotency-key"];
  const key = Array.isArray(value) ? value[0] : value;
  if (key !== undefined && (key.length < 8 || key.length > 200)) throw new ApplicationError("validation", "Idempotency-Key must be between 8 and 200 characters");
  return key;
}

function requestFingerprint(value: unknown): string | undefined {
  try { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); } catch { return undefined; }
}

function restRequestFingerprint(request: FastifyRequest, body: unknown = request.body): string | undefined {
  const route = request.routeOptions.url ?? request.url.split("?", 1)[0] ?? request.url;
  const rawParams = request.params;
  const params = rawParams !== null && typeof rawParams === "object" && !Array.isArray(rawParams)
    ? Object.fromEntries(Object.entries(rawParams as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : rawParams;
  return requestFingerprint({ method: request.method.toUpperCase(), route, params, body });
}

function requestContext(request: FastifyRequest, fingerprintBody: unknown = request.body): RequestContext {
  const principal = request.principal;
  if (!principal) throw new ApplicationError("forbidden", "Authentication is required");
  const idempotencyKey = requestIdempotencyKey(request);
  const fingerprint = restRequestFingerprint(request, fingerprintBody);
  return {
    actor: principal.actor,
    source: principal.source,
    correlationId: request.correlationId ?? randomUUID(),
    scopes: principal.scopes,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(fingerprint ? { fingerprint } : {})
  };
}

function transferFinalizeContext(request: FastifyRequest, capability: TransferCapability, uploadId: string, body: FinalizeCapabilityBody): RequestContext {
  const idempotencyKey = requestIdempotencyKey(request);
  const fingerprint = restRequestFingerprint(request, { uploadId, sha256: body.sha256, byteLength: body.byteLength });
  return {
    actor: capability.actor,
    source: "mcp",
    correlationId: request.correlationId ?? randomUUID(),
    scopes: new Set(["read", "write"]),
    projectId: capability.projectId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(fingerprint === undefined ? {} : { fingerprint })
  };
}

function parseExpectedVersion(request: FastifyRequest): number | undefined {
  const value = request.headers["if-match"];
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) return undefined;
  let clean = header.trim();
  const weak = clean.startsWith("W/");
  if (weak) {
    clean = clean.slice(2);
    if (!(clean.startsWith('"') && clean.endsWith('"'))) throw new ApplicationError("validation", "If-Match must contain a positive version");
  }
  if (clean.startsWith('"') || clean.endsWith('"')) {
    if (!(clean.startsWith('"') && clean.endsWith('"'))) throw new ApplicationError("validation", "If-Match must contain a positive version");
    clean = clean.slice(1, -1);
  }
  if (!/^[1-9][0-9]*$/u.test(clean)) throw new ApplicationError("validation", "If-Match must contain a positive version");
  const version = Number(clean);
  if (!Number.isSafeInteger(version)) throw new ApplicationError("validation", "If-Match must contain a positive version");
  return version;
}

function parseRequiredExpectedVersion(request: FastifyRequest): number {
  const version = parseExpectedVersion(request);
  if (version === undefined) throw new ApplicationError("validation", "If-Match is required for this versioned mutation");
  return version;
}

function parseBody<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: readonly unknown[] } } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApplicationError("validation", "Request body is invalid", { issues: result.error.issues });
  return result.data;
}

type WorkspaceSecurityRequest = WorkspaceSecurityMutation;

type AttemptWindow = { readonly count: number; readonly resetAt: number };
const AUTH_ATTEMPT_LIMIT = 5;
const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_HASH_CONCURRENCY_LIMIT = 2;

function securityFingerprint(operation: WorkspaceSecurityRequest, secret: string): string {
  // Do not JSON-serialize a security request: password text and encoded hashes
  // must never enter an audit, idempotency, or request log payload. Streaming
  // each value into the digest keeps retries deterministic without retaining a
  // serialized credential representation.
  const hash = createHmac("sha256", secret);
  const frame = (value: string): void => {
    const bytes = Buffer.byteLength(value, "utf8");
    hash.update(String(bytes));
    hash.update(":");
    hash.update(value, "utf8");
  };
  frame(operation.operation);
  frame(String(operation.expectedVersion));
  frame(operation.operation === "enable" ? "" : operation.currentPassword);
  frame(operation.operation === "disable" ? "" : operation.newPassword);
  return hash.digest("hex");
}

/** Accept the UI's mode form and the operation-first agent form at one strict boundary. */
function parseWorkspaceSecurityRequest(body: unknown, headerVersion: number | undefined): WorkspaceSecurityRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ApplicationError("validation", "Workspace security request is invalid");
  const record = body as Record<string, unknown>;
  const bodyVersion = record.expectedVersion;
  if (headerVersion !== undefined && bodyVersion !== undefined && bodyVersion !== headerVersion) throw new ApplicationError("validation", "If-Match must match expectedVersion");
  const expectedVersion = headerVersion ?? bodyVersion;
  if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new ApplicationError("validation", "If-Match or expectedVersion must contain a positive version");
  if (record.operation !== undefined) {
    return parseBody(workspaceSecurityMutationSchema, { ...record, expectedVersion });
  }
  const mode = record.mode;
  if (mode !== "password" && mode !== "lan_open") throw new ApplicationError("validation", "Workspace security mode is invalid");
  const allowed = mode === "password" && record.currentPassword === undefined ? new Set(["mode", "newPassword"]) : mode === "password" ? new Set(["mode", "currentPassword", "newPassword"]) : new Set(["mode", "currentPassword"]);
  if (Object.keys(record).some((key) => !allowed.has(key) && key !== "expectedVersion")) throw new ApplicationError("validation", "Workspace security request contains unsupported fields");
  if (mode === "lan_open") {
    return parseBody(workspaceSecurityMutationSchema, { operation: "disable", currentPassword: record.currentPassword, expectedVersion });
  }
  const newPassword = record.newPassword;
  if (record.currentPassword === undefined) {
    return parseBody(workspaceSecurityMutationSchema, { operation: "enable", newPassword, expectedVersion });
  }
  return parseBody(workspaceSecurityMutationSchema, { operation: "change_password", currentPassword: record.currentPassword, newPassword, expectedVersion });
}

/**
 * Reconciliation writes are revision-scoped. The canonical save contract
 * carries the revision id as a consistency check, but callers may omit the
 * duplicated path value; inject it only after rejecting an explicit mismatch,
 * then validate the resulting request with the strict schema.
 */
function parseReconciliationDraftBody(body: unknown, revisionId: string) {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const candidate = body as Record<string, unknown>;
    const supplied = candidate.projectRevisionId;
    if (supplied !== undefined && supplied !== revisionId) {
      throw new ApplicationError("validation", "projectRevisionId must match the revision path");
    }
    return parseBody(saveReconciliationDraftSchema, { projectRevisionId: revisionId, ...candidate });
  }
  return parseBody(saveReconciliationDraftSchema, body);
}

function parseCatalogQuery(value: unknown): CatalogProductListOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ApplicationError("validation", "Catalog query is invalid");
  const query = value as Record<string, unknown>;
  const allowed = new Set(["q", "kind", "limit", "cursor"]);
  if (Object.keys(query).some((key) => !allowed.has(key))) throw new ApplicationError("validation", "Catalog query contains an unsupported field");
  const q = query.q;
  if (q !== undefined && (typeof q !== "string" || q.length === 0 || q.length > 200)) throw new ApplicationError("validation", "q must be a non-empty string of at most 200 characters");
  const kind = query.kind;
  if (kind !== undefined && kind !== "filament" && kind !== "printer") throw new ApplicationError("validation", "kind must be filament or printer");
  const rawLimit = query.limit;
  const limit = rawLimit === undefined ? 50 : typeof rawLimit === "number" ? rawLimit : typeof rawLimit === "string" && /^\d+$/u.test(rawLimit) ? Number(rawLimit) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ApplicationError("validation", "limit must be an integer between 1 and 200");
  const cursor = query.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 200 || !/^[A-Za-z0-9._~-]+$/u.test(cursor))) throw new ApplicationError("validation", "cursor is invalid");
  return {
    ...(q === undefined ? {} : { q }),
    ...(kind === undefined ? {} : { kind }),
    limit,
    ...(cursor === undefined ? {} : { cursor })
  };
}

function parseBuildConfigurationQuery(value: unknown): BuildConfigurationListOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ApplicationError("validation", "Build configuration query is invalid");
  const query = value as Record<string, unknown>;
  const allowed = new Set(["limit", "cursor"]);
  if (Object.keys(query).some((key) => !allowed.has(key))) throw new ApplicationError("validation", "Build configuration query contains an unsupported field");
  const rawLimit = query.limit;
  const limit = rawLimit === undefined ? 50 : typeof rawLimit === "number" ? rawLimit : typeof rawLimit === "string" && /^\d+$/u.test(rawLimit) ? Number(rawLimit) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ApplicationError("validation", "limit must be an integer between 1 and 200");
  const cursor = query.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 200 || !/^[A-Za-z0-9._~-]+$/u.test(cursor))) throw new ApplicationError("validation", "cursor is invalid");
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
}

function parseInventoryProductProfileBody(value: unknown): unknown {
  const create = createInventoryProductProfileSchema.safeParse(value);
  if (create.success) return create.data;
  const update = updateInventoryProductProfileSchema.safeParse(value);
  if (update.success) return update.data;
  throw new ApplicationError("validation", "Inventory product profile body is invalid", { issues: [...create.error.issues, ...update.error.issues] });
}

/** The binding is optional and validated by the canonical API contract. */
const beginArtifactUploadRequestSchema = beginUploadSchema;

function parsePhysicalCount(body: unknown): { readonly quantity: number; readonly note?: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ApplicationError("validation", "Request body is invalid");
  const value = body as Record<string, unknown>;
  if (typeof value.quantity !== "number" || !Number.isFinite(value.quantity) || value.quantity < 0) throw new ApplicationError("validation", "Physical count must be zero or greater");
  if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 2000)) throw new ApplicationError("validation", "Count note is invalid");
  return { quantity: value.quantity, ...(value.note === undefined ? {} : { note: value.note }) };
}

function parseTransferFinalize(body: unknown): { readonly sha256: string; readonly byteLength: number } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ApplicationError("validation", "Finalize body is invalid");
  const value = body as Record<string, unknown>;
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new ApplicationError("validation", "Finalize SHA-256 is invalid");
  if (typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0) throw new ApplicationError("validation", "Finalize byte length is invalid");
  return { sha256: value.sha256, byteLength: value.byteLength };
}

function transferContentLength(value: string | string[] | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^\d+$/u.test(value)) throw new ApplicationError("validation", "Content-Length must be a non-negative decimal integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ApplicationError("validation", "Content-Length is too large");
  return parsed;
}

function transferRequest(method: string, path: string): { readonly action: "upload_write" | "upload_finalize" | "artifact_download"; readonly resourceId: string } | null {
  const upload = /^\/api\/v1\/transfers\/uploads\/([^/]+)(?:\/finalize)?$/u.exec(path);
  if (upload !== null) {
    let resourceId: string;
    try { resourceId = decodeURIComponent(upload[1]!); } catch { throw new ApplicationError("validation", "Transfer resource identifier is invalid"); }
    if (upload[0].endsWith("/finalize")) return method === "POST" ? { action: "upload_finalize", resourceId } : null;
    return method === "PUT" ? { action: "upload_write", resourceId } : null;
  }
  const artifact = /^\/api\/v1\/transfers\/artifacts\/([^/]+)\/download$/u.exec(path);
  if (artifact !== null) {
    let resourceId: string;
    try { resourceId = decodeURIComponent(artifact[1]!); } catch { throw new ApplicationError("validation", "Transfer resource identifier is invalid"); }
    return method === "GET" ? { action: "artifact_download", resourceId } : null;
  }
  return null;
}

function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) throw new ApplicationError("forbidden", "Authentication is required");
  return request.principal;
}

function requireScope(request: FastifyRequest, scope: AuthScope, auth: AuthManager): Principal {
  const principal = requirePrincipal(request);
  if (!auth.hasScope(principal, scope)) throw new ApplicationError("forbidden", `This action requires the '${scope}' scope`);
  return principal;
}

function requireProjectScope(request: FastifyRequest, projectId: string): void {
  const projectIds = request.principal?.projectIds;
  if (projectIds && !projectIds.has(projectId)) throw new ApplicationError("forbidden", "Token is not scoped to this project");
}

function rejectScopedGlobalAccess(request: FastifyRequest): void {
  if (request.principal?.projectIds) throw new ApplicationError("forbidden", "This token must address a project-scoped endpoint");
}

function mcpCommandFingerprint(body: unknown): string | undefined {
  const value = body as { method?: unknown; params?: unknown } | null;
  const params = value && typeof value === "object" && value.params && typeof value.params === "object" ? value.params as { name?: unknown; arguments?: unknown } : undefined;
  const command = value?.method === "tools/call" && params && typeof params.name === "string"
    ? { method: value.method, name: params.name, arguments: params.arguments ?? {} }
    : body;
  try { return createHash("sha256").update(JSON.stringify(command)).digest("hex"); } catch { return undefined; }
}

function mcpContext(principal: Principal, request?: FastifyRequest): McpRequestContext {
  const readScopes: readonly McpScope[] = ["inventory:read", "catalog:read", "projects:read", "bom:read", "artifacts:read", "offers:read", "context:read"];
  const writeScopes: readonly McpScope[] = ["inventory:write", "catalog:write", "projects:write", "bom:write", "artifacts:write", "offers:write"];
  const scopes = principal.scopes.has("admin") ? [...readScopes, ...writeScopes] : principal.scopes.has("write") ? [...readScopes, ...writeScopes] : principal.scopes.has("read") ? readScopes : [];
  const requestMetadata = request === undefined ? undefined : requestContext(request);
  const fingerprint = request === undefined ? undefined : mcpCommandFingerprint(request.body);
  return {
    actorId: principal.actor,
    scopes,
    ...(principal.projectIds === undefined ? {} : { projectIds: [...principal.projectIds] }),
    ...(requestMetadata === undefined ? {} : { correlationId: requestMetadata.correlationId }),
    ...(requestMetadata?.idempotencyKey === undefined ? {} : { idempotencyKey: requestMetadata.idempotencyKey }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };
}

function webContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLocaleLowerCase();
  switch (extension) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function defaultWebRoot(): string {
  const configured = process.env.BENCHLEDGER_WEB_DIR;
  if (configured !== undefined && isAbsolute(configured)) return resolve(configured);
  return fileURLToPath(new URL("../../web/dist/", import.meta.url));
}

async function serveWebAsset(root: string, requestPath: string): Promise<{ readonly path: string; readonly body: Buffer } | null> {
  let decoded: string;
  try { decoded = decodeURIComponent(requestPath); } catch { return null; }
  if (decoded.includes("\u0000") || decoded.includes("\\")) return null;
  const normalized = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = resolve(root, normalized);
  const rel = relative(resolve(root), candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  try {
    const details = await stat(candidate);
    if (!details.isFile()) return null;
    return { path: candidate, body: await readFile(candidate) };
  } catch {
    return null;
  }
}

async function projectRevisionForRequest(request: FastifyRequest, service: ApplicationService, revisionId: string): Promise<ApiProjectRevision> {
  try {
    const revision = await service.getProjectRevision(revisionId);
    requireProjectScope(request, revision.projectId);
    return revision;
  } catch (error) {
    // Keep an indirect revision identifier from becoming an existence oracle
    // for a project-scoped bearer. Both a missing revision and a revision in
    // another project are intentionally indistinguishable. Unscoped callers
    // retain the normal 404 and other application errors.
    if (request.principal?.projectIds !== undefined && error instanceof ApplicationError && (error.code === "not_found" || error.code === "forbidden")) {
      throw new ApplicationError("forbidden", "The current token is not allowed to address this project revision");
    }
    throw error;
  }
}

async function requireRevisionScope(request: FastifyRequest, service: ApplicationService, revisionId: string): Promise<void> {
  await projectRevisionForRequest(request, service, revisionId);
}

function scopedBuildConfigurationAccessError(request: FastifyRequest, error: unknown): ApplicationError | null {
  if (request.principal?.projectIds === undefined || !(error instanceof ApplicationError)) return null;
  if (error.code !== "not_found" && error.code !== "forbidden") return null;
  // A snapshot id is an indirect project identifier.  Normalize both a
  // missing snapshot and a snapshot outside the token's project allow-list so
  // this endpoint cannot be used as an existence oracle.
  return new ApplicationError("forbidden", "The current token is not allowed to address this build configuration");
}

async function buildConfigurationForRequest(request: FastifyRequest, service: ApplicationService, configurationId: string): Promise<ApiBuildConfigurationSnapshot> {
  let snapshot: ApiBuildConfigurationSnapshot;
  try {
    snapshot = await service.getBuildConfiguration(configurationId);
  } catch (error) {
    throw scopedBuildConfigurationAccessError(request, error) ?? error;
  }
  try {
    await requireRevisionScope(request, service, snapshot.projectRevisionId);
  } catch (error) {
    throw scopedBuildConfigurationAccessError(request, error) ?? error;
  }
  return snapshot;
}

/**
 * Resolve indirect build-configuration references before a project-scoped
 * mutation reaches the application service. Unscoped sessions/admin callers
 * retain the service's existing not-found and ancestry validation semantics.
 */
async function authorizeScopedBuildConfigurationReference(request: FastifyRequest, service: ApplicationService, configurationId: string): Promise<void> {
  if (request.principal?.projectIds === undefined) return;
  await buildConfigurationForRequest(request, service, configurationId);
}

function mutationBody<T>(mutation: Mutation<T>): Mutation<T> {
  return mutation;
}

function jsonOpenApi(version: string): Record<string, unknown> {
  // Keep the public description aligned with the canonical
  // createInventoryWithProductProfileSchema. The item half is the existing
  // createInventoryItem contract; the profile half deliberately has no
  // itemId because the service assigns the newly-created item's identity.
  const inventoryWithProductProfileSchema = {
    type: "object",
    additionalProperties: false,
    required: ["item", "profile"],
    properties: {
      item: { $ref: "#/components/schemas/CreateInventoryItem" },
      profile: { $ref: "#/components/schemas/CreateInventoryProductProfileWithoutItem" }
    }
  };
  const inventoryBulkUpdateSchema = {
    type: "object",
    additionalProperties: false,
    required: ["targets", "changes"],
    properties: {
      targets: {
        type: "array", minItems: 1, maxItems: 100,
        items: {
          type: "object", additionalProperties: false, required: ["itemId", "expectedVersion"],
          properties: {
            itemId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
            expectedVersion: { type: "integer", minimum: 1 }
          }
        }
      },
      changes: {
        type: "object", additionalProperties: false, minProperties: 1,
        properties: {
          location: { type: "string", minLength: 1, maxLength: 240 },
          condition: { type: "string", enum: ["new", "good", "worn", "needs_repair", "unknown"] },
          tags: {
            type: "object", additionalProperties: false, minProperties: 1,
            properties: {
              add: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 80 } },
              remove: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 80 } }
            }
          }
        }
      }
    }
  };
  const createInventoryItemSchema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "kind", "quantity", "unit", "tags", "links", "evidence"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      name: { type: "string", minLength: 1, maxLength: 240 },
      kind: { type: "string", enum: ["printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"] },
      categoryNodeId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", description: "Optional user-managed category or subcategory assignment." },
      description: { type: "string", maxLength: 5000 },
      manufacturer: { type: "string", maxLength: 200 },
      model: { type: "string", maxLength: 200 },
      sku: { type: "string", maxLength: 200 },
      quantity: { type: "number", minimum: 0 },
      availableQuantity: { type: "number", minimum: 0, description: "Available confirmed stock. availableQuantity cannot exceed quantity; the server rejects requests that violate this cross-field invariant." },
      unit: { type: "string", enum: ["each", "gram", "millimetre", "millilitre", "metre", "set"] },
      location: { type: "string", maxLength: 240 },
      condition: { type: "string", enum: ["new", "good", "worn", "needs_repair", "unknown"] },
      dimensions: {
        type: "object", additionalProperties: false,
        properties: {
          lengthMm: { type: "number", minimum: 0 }, widthMm: { type: "number", minimum: 0 },
          heightMm: { type: "number", minimum: 0 }, diameterMm: { type: "number", minimum: 0 },
          measured: { type: "boolean" }, uncertaintyMm: { type: "number", minimum: 0 }, note: { type: "string", maxLength: 500 }
        }
      },
      tags: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 80 } },
      links: {
        type: "array", maxItems: 30,
        items: {
          type: "object", additionalProperties: false, required: ["supplier", "url"],
          properties: {
            supplier: { type: "string", minLength: 1, maxLength: 160 }, url: { type: "string", format: "uri", maxLength: 2000 },
            label: { type: "string", maxLength: 200 }, currentPriceMinor: { type: "integer", minimum: 0 }, currency: { type: "string", minLength: 3, maxLength: 3 },
            observedAt: { type: "string", format: "date-time" }, packageQuantity: { type: "number", exclusiveMinimum: 0 }
          }
        }
      },
      evidence: {
        type: "object", additionalProperties: false, required: ["state"],
        properties: {
          state: { type: "string", enum: ["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"] },
          source: { type: "string", maxLength: 500 }, sourceId: { type: "string", maxLength: 500 },
          observedAt: { type: "string", format: "date-time" }, note: { type: "string", maxLength: 1000 }
        }
      }
    }
  };
  const commissionInventoryItemSchema = {
    type: "object", additionalProperties: false,
    required: ["quantity", "unit", "evidence"],
    properties: {
      quantity: { type: "number", minimum: 0, description: "Observed usable quantity after commissioning." },
      unit: { type: "string", enum: ["each", "gram", "millimetre", "millilitre", "metre", "set"] },
      evidence: {
        type: "object", additionalProperties: false, required: ["state", "source", "observedAt"],
        properties: {
          state: { const: "commissioned" }, source: { type: "string", minLength: 1, maxLength: 500 }, sourceId: { type: "string", maxLength: 500 },
          observedAt: { type: "string", format: "date-time" }, note: { type: "string", maxLength: 1000 }
        }
      }
    }
  };
  const createInventoryProductProfileWithoutItemSchema = {
    oneOf: [
      {
        type: "object", additionalProperties: false,
        required: ["catalogProductId", "profileType", "linkState", "details"],
        properties: {
          catalogProductId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
          profileType: { const: "filament_spool" },
          linkState: { type: "string", enum: ["confirmed", "reported", "suggested"] },
          details: {
            type: "object", additionalProperties: false,
            properties: {
              lot: { type: "string", minLength: 1, maxLength: 160 }, batch: { type: "string", minLength: 1, maxLength: 160 },
              lotCode: { type: "string", minLength: 1, maxLength: 160 }, openedState: { type: "string", enum: ["sealed", "open", "unknown"] },
              openedAt: { type: "string", format: "date-time" }, tareMassG: { type: "number", minimum: 0 },
              currentPlacement: { type: "string", minLength: 1, maxLength: 240 }, dryingHistory: { type: "string", maxLength: 2000 }
            }
          }
        }
      },
      {
        type: "object", additionalProperties: false,
        required: ["catalogProductId", "profileType", "linkState", "details"],
        properties: {
          catalogProductId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
          profileType: { const: "printer_asset" },
          linkState: { type: "string", enum: ["confirmed", "reported", "suggested"] },
          details: {
            type: "object", additionalProperties: false,
            properties: {
              assetLabel: { type: "string", minLength: 1, maxLength: 240 }, commissionedAt: { type: "string", format: "date-time" },
              location: { type: "string", minLength: 1, maxLength: 240 }, condition: { type: "string", enum: ["new", "good", "worn", "needs_repair", "unknown"] }
            }
          }
        }
      }
    ]
  };
  const inventoryCategorySchema = {
    type: "object", additionalProperties: false,
    required: ["id", "name", "sortOrder", "archived", "createdAt", "updatedAt", "version"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      name: { type: "string", minLength: 1, maxLength: 120 },
      parentId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      sortOrder: { type: "integer", minimum: 0 },
      archived: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      version: { type: "integer", minimum: 1 }
    }
  };
  const createInventoryCategorySchema = {
    type: "object", additionalProperties: false,
    required: ["name"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      name: { type: "string", minLength: 1, maxLength: 120 },
      parentId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      sortOrder: { type: "integer", minimum: 0, default: 0 }
    }
  };
  const updateInventoryCategorySchema = {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 },
      sortOrder: { type: "integer", minimum: 0 }
    }
  };
  const categoryIdParameter = { name: "id", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" } };
  const categoryVersionParameter = { name: "If-Match", in: "header", required: true, description: "Required category version for optimistic concurrency.", schema: { type: "string", pattern: "^[1-9][0-9]*$" } };
  const inventoryQueryParameters = [
    { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 200 } },
    { name: "kind", in: "query", required: false, schema: { type: "string", enum: ["printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"] } },
    { name: "evidence", in: "query", required: false, schema: { type: "string", enum: ["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"] } },
    { name: "available", in: "query", required: false, schema: { type: "boolean" } },
    { name: "includeRetired", in: "query", required: false, description: "Include retired inventory history; active rows are returned by default.", schema: { type: "boolean", default: false } },
    { name: "categoryNodeId", in: "query", required: false, description: "Exact managed category or subcategory ID. Mutually exclusive with unassigned=true.", schema: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" } },
    { name: "unassigned", in: "query", required: false, description: "Return inventory without a managed category assignment. Mutually exclusive with categoryNodeId.", schema: { type: "boolean" } },
    { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
    { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 200 } }
  ];
  const projectLifecycleValues = ["idea", "planned", "ready", "building", "validating", "complete", "archived"];
  const createProjectWithInitialRevisionSchema = {
    type: "object", additionalProperties: false, required: ["project", "revision"],
    properties: {
      project: {
        type: "object", additionalProperties: false, required: ["name", "status"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", description: "Optional caller-provided stable project identifier. It is never regenerated or reclaimed after removal." },
          name: { type: "string", minLength: 1, maxLength: 240 },
          description: { type: "string", maxLength: 5000 },
          status: { type: "string", enum: projectLifecycleValues }
        }
      },
      revision: {
        type: "object", additionalProperties: false, required: ["name", "status"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", description: "Optional caller-provided stable initial revision identifier. It must not already exist." },
          name: { type: "string", minLength: 1, maxLength: 240 },
          notes: { type: "string", maxLength: 10000 },
          status: { type: "string", enum: ["concept", "CAD complete", "DFAM reviewed", "mesh validated", "slicer validated", "test printed", "fit/function verified", "production approved"] }
        }
      }
    }
  };
  const projectCreationConflictDetailsSchema = {
    type: "object", additionalProperties: false,
    required: ["reason", "field", "id", "retryable", "commitState"],
    description: "Safe conflict details identify only the requested target. No project, revision, record, SQL, or backend details are exposed.",
    properties: {
      reason: { type: "string", enum: ["project_id_exists", "revision_id_exists", "project_name_exists", "idempotency_key_reused"] },
      field: { type: "string", enum: ["projectId", "revisionId", "projectName", "idempotencyKey"] },
      id: { type: "string", minLength: 1, maxLength: 240 },
      retryable: { const: false },
      commitState: { const: "not_committed" },
      commandId: { type: "string", minLength: 1, maxLength: 200 }
    }
  };
  const errorResponseSchema = {
    type: "object", additionalProperties: false, required: ["error"],
    properties: {
      error: {
        type: "object", additionalProperties: false, required: ["code", "message"],
        properties: {
          code: { type: "string", minLength: 1, maxLength: 80 },
          message: { type: "string", minLength: 1, maxLength: 1000 },
          details: { $ref: "#/components/schemas/ProjectCreationConflictDetails" },
          correlationId: { type: "string", minLength: 1, maxLength: 160 }
        }
      }
    }
  };
  return {
    openapi: "3.1.0",
    info: { title: "BenchLedger API", version, description: "Evidence-based maker inventory and project workspace API." },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    components: {
      securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "Scoped MCP/API token. Store the plaintext token only in the client secret store." },
      cookieAuth: { type: "apiKey", in: "cookie", name: "forge_session" },
      transferAuth: { type: "apiKey", in: "header", name: "X-Bench-Transfer-Token", description: "Short-lived single-purpose capability issued by the authenticated browser/host transfer flow; keep it in the header and never put it in a URL." }
      },
      schemas: {
        CreateInventoryItem: createInventoryItemSchema,
        CommissionInventoryItem: commissionInventoryItemSchema,
        InventoryBulkUpdate: inventoryBulkUpdateSchema,
        CreateInventoryProductProfileWithoutItem: createInventoryProductProfileWithoutItemSchema,
        CreateInventoryWithProductProfile: inventoryWithProductProfileSchema,
        CreateProjectWithInitialRevision: createProjectWithInitialRevisionSchema,
        ProjectCreationConflictDetails: projectCreationConflictDetailsSchema,
        ErrorResponse: errorResponseSchema,
        InventoryCategory: inventoryCategorySchema,
        CreateInventoryCategory: createInventoryCategorySchema,
        UpdateInventoryCategory: updateInventoryCategorySchema,
        ProjectTombstone: { type: "object", additionalProperties: false, required: ["id", "name", "removedAt", "removedBy", "lastLifecycleStatus", "releasedReservationIds", "version"], properties: { id: { type: "string" }, name: { type: "string" }, removedAt: { type: "string", format: "date-time" }, removedBy: { type: "string" }, lastLifecycleStatus: { $ref: "#/components/schemas/ProjectLifecycle" }, releasedReservationIds: { type: "array", items: { type: "string" } }, version: { type: "integer", minimum: 1 }, auditId: { type: "string" } } },
        ProjectLifecycle: { type: "string", enum: projectLifecycleValues, description: "Canonical project lifecycle. Blocked is derived from reasons and is not a lifecycle value." }
      }
    },
    paths: {
      "/health": { get: { security: [], responses: { "200": { description: "Service health" } } } },
      "/ready": { get: { security: [], responses: { "200": { description: "Readiness checks" }, "503": { description: "Not ready" } } } },
      "/auth/login": { post: { security: [], responses: { "200": { description: "Session created" }, "401": { description: "Invalid credentials" }, "429": { description: "Too many attempts" } } } },
      "/auth/access": {
        get: { security: [], responses: { "200": { description: "Workspace access mode (mode, passwordConfigured, and version only)" } } },
        patch: {
          security: [{ cookieAuth: [] }],
          summary: "Update browser workspace access mode (operation form)",
          description: "UI-only unscoped administrator session. Requires CSRF, Idempotency-Key, and an operation-first body with expectedVersion (If-Match may also carry the same version). A successful mutation rotates the browser session and invalidates prior sessions.",
          parameters: [
            { in: "header", name: "If-Match", required: false, schema: { type: "string", pattern: "^(W/)?\\\"?[1-9][0-9]*\\\"?$" }, description: "Optional when expectedVersion is present in the body; if both are supplied they must match." },
            { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } }
          ],
          requestBody: { required: true, content: { "application/json": { schema: { oneOf: [
            { type: "object", additionalProperties: false, required: ["operation", "newPassword", "expectedVersion"], properties: { operation: { const: "enable" }, newPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } },
            { type: "object", additionalProperties: false, required: ["operation", "currentPassword", "expectedVersion"], properties: { operation: { const: "disable" }, currentPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } },
            { type: "object", additionalProperties: false, required: ["operation", "currentPassword", "newPassword", "expectedVersion"], properties: { operation: { const: "change_password" }, currentPassword: { type: "string", minLength: 12, maxLength: 512 }, newPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } }
          ] } } } },
          responses: { "200": { description: "Updated workspace access mode and fresh session" }, "400": { description: "Invalid operation" }, "401": { description: "Current password is invalid" }, "403": { description: "UI administrator session required" }, "409": { description: "Stale access version or idempotency conflict" }, "429": { description: "Too many attempts" } }
        }
      },
      "/auth/lan-session": { post: { security: [], responses: { "200": { description: "Explicit LAN session" }, "403": { description: "Password mode is enabled" } } } },
      "/auth/security": {
        post: {
          security: [{ cookieAuth: [] }],
          summary: "Update browser workspace access mode (operation form)",
          parameters: [
            { in: "header", name: "If-Match", required: false, schema: { type: "string", pattern: "^(W/)?\\\"?[1-9][0-9]*\\\"?$" }, description: "Required when expectedVersion is omitted from the body." },
            { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } }
          ],
          requestBody: { required: true, content: { "application/json": { schema: { oneOf: [
            { type: "object", additionalProperties: false, required: ["operation", "newPassword", "expectedVersion"], properties: { operation: { const: "enable" }, newPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } },
            { type: "object", additionalProperties: false, required: ["operation", "currentPassword", "expectedVersion"], properties: { operation: { const: "disable" }, currentPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } },
            { type: "object", additionalProperties: false, required: ["operation", "currentPassword", "newPassword", "expectedVersion"], properties: { operation: { const: "change_password" }, currentPassword: { type: "string", minLength: 12, maxLength: 512 }, newPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } }
          ] } } } },
          responses: { "200": { description: "Updated workspace access mode and fresh session" }, "400": { description: "Invalid operation" }, "401": { description: "Current password is invalid" }, "403": { description: "UI administrator session required" }, "409": { description: "Stale access version or idempotency conflict" }, "429": { description: "Too many attempts" } }
        }
      },
      "/workspace": { get: { responses: { "200": { description: "Authenticated aggregate workspace snapshot" } } } },
      "/inventory": { get: { description: "Returns a bounded inventory page; categoryNodeId and unassigned=true are mutually exclusive.", parameters: inventoryQueryParameters, responses: { "200": { description: "Inventory page" } } }, post: { responses: { "201": { description: "Inventory item" } } } },
      "/inventory/categories": {
        get: { parameters: [
          { name: "includeArchived", in: "query", required: false, schema: { type: "boolean", default: false } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 512 } },
        ], responses: { "200": { description: "Managed inventory category page" } } },
        post: { requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateInventoryCategory" } } } }, responses: { "201": { description: "Managed inventory category" } } }
      },
      "/inventory/categories/{id}": {
        parameters: [categoryIdParameter],
        get: { responses: { "200": { description: "Managed inventory category" } } },
        patch: { parameters: [categoryVersionParameter], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateInventoryCategory" } } } }, responses: { "200": { description: "Updated managed inventory category" } } }
      },
      "/inventory/categories/{id}/archive": { parameters: [categoryIdParameter], post: { parameters: [categoryVersionParameter], responses: { "200": { description: "Archived managed inventory category" } } } },
      "/inventory/bulk": {
        patch: {
          summary: "Apply one bounded metadata batch to explicit inventory items",
          description: "Targets carry explicit optimistic versions. The server preflights every target and commits location, condition, and tag add/remove changes atomically; no-op targets keep their version and produce no audit or event.",
          parameters: [{
            name: "Idempotency-Key",
            in: "header",
            required: true,
            description: "Stable command identity used to safely replay an identical bulk update.",
            schema: { type: "string", minLength: 8, maxLength: 200 }
          }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/InventoryBulkUpdate" } } } },
          responses: { "200": { description: "Bulk inventory mutation with per-item audits" }, "400": { description: "Invalid request or missing idempotency key" }, "403": { description: "CSRF, write-scope, or project-scoped denial" }, "409": { description: "Version, idempotency, or atomic commit conflict" } }
        }
      },
      "/inventory/with-product-profile": {
        post: {
          summary: "Create an inventory item and exact physical product profile atomically",
          description: "The strict request contains only item and profile. The profile omits itemId; the server assigns it to the newly-created inventory item and rolls both records back if the compound command cannot commit.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateInventoryWithProductProfile" } } }
          },
          responses: {
            "201": { description: "Inventory item and physical profile mutation" },
            "400": { description: "Invalid compound request" },
            "409": { description: "Conflict or failed atomic commit" }
          }
        }
      },
      "/inventory/{id}": { get: { responses: { "200": { description: "Inventory item" } } }, patch: { responses: { "200": { description: "Updated inventory item" } } } },
      "/inventory/{id}/commission": {
        post: {
          summary: "Commission an uncertain inventory item",
          description: "Records the observed quantity and commissioned provenance as an append-only count event. The item evidence state cannot be changed by generic PATCH.",
          parameters: [
            { name: "If-Match", in: "header", required: true, schema: { type: "integer", minimum: 1 }, description: "Expected inventory item version; stale versions are rejected with 409." },
            { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 }, description: "Stable key for retrying this exact commissioning command; reusing it with different input is rejected." }
          ],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CommissionInventoryItem" } } } },
          responses: { "201": { description: "Commissioning event and resulting inventory item" }, "400": { description: "Invalid commissioning request" }, "409": { description: "Version conflict or invalid evidence transition" } }
        }
      },
      "/inventory/{id}/product-profile": { get: { responses: { "200": { description: "Physical inventory product profile" }, "404": { description: "Profile not found" } } }, put: { responses: { "200": { description: "Updated physical inventory product profile" } } } },
      "/inventory/{id}/count": { post: { responses: { "201": { description: "Recorded physical count" } } } },
      "/inventory/{id}/stock-events": { get: { responses: { "200": { description: "Stock event page" } } }, post: { responses: { "201": { description: "Stock mutation" } } } },
      "/projects": { get: { description: "Returns a bounded project page. Archived and removed projects are hidden by default; status=archived is the explicit reversible Archived view.", parameters: [{ name: "status", in: "query", required: false, schema: { $ref: "#/components/schemas/ProjectLifecycle" } }], responses: { "200": { description: "Project page" } } }, post: { responses: { "201": { description: "Project" } } } },
      "/projects/removed": { get: { description: "List retained project removal tombstones as a bounded page. Removed projects cannot be restored or purged.", parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 200 }, description: "Opaque continuation cursor from the preceding page." }], responses: { "200": { description: "Removed project tombstone page" } } } },
      "/projects/with-initial-revision": {
        post: {
          summary: "Create a project and its first planning revision atomically",
          description: "Accepts optional caller-provided stable project and revision IDs. An identical retry with the same Idempotency-Key replays exactly once. A 409 identifies a project ID, revision ID, generated project name/slug, or reused idempotency key; read the existing project, choose a different ID, or choose a different project name as directed. No records are committed on conflict.",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateProjectWithInitialRevision" } } } },
          responses: {
            "201": { description: "Project and initial revision mutation" },
            "400": { description: "Invalid project, revision, or stable identifier" },
            "409": { description: "Project ID, revision ID, generated project name/slug, or idempotency-key conflict; no records were committed.", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } }
          }
        }
      },
      "/projects/{id}/revisions": { post: { responses: { "201": { description: "Project revision" } } } },
      "/projects/{id}/restore": { post: { description: "Restore an archived project to idea; retained history stays in place and released reservations are not recreated.", responses: { "200": { description: "Restored project" }, "400": { description: "Invalid version precondition" }, "409": { description: "Version or project lifecycle conflict" } } } },
      "/projects/{id}": { delete: { description: "Irreversibly remove an archived or active project from ordinary workspace views. Requires exact name confirmation, If-Match, and Idempotency-Key; retained history remains discoverable and no purge is available.", parameters: [{ in: "header", name: "If-Match", required: true, schema: { type: "string" } }, { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 240 } } } } } }, responses: { "200": { description: "Project tombstone and released reservation IDs" }, "400": { description: "Missing preconditions or invalid confirmation" }, "409": { description: "Version, confirmation, or idempotency conflict" }, "410": { description: "Project was already removed" } } } },
      "/projects/{id}/removed-history": { get: { description: "Read a bounded page of append-only audit history for a removed project.", parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 200 }, description: "Opaque continuation cursor from the preceding page." }], responses: { "200": { description: "Removed project audit page" }, "409": { description: "Project has not been removed" } } } },
      "/catalog/products": { get: { responses: { "200": { description: "Bounded exact catalog product page" } } }, post: { responses: { "201": { description: "Catalog product mutation" } } } },
      "/catalog/products/{id}": { get: { responses: { "200": { description: "Exact catalog product" } } }, patch: { responses: { "200": { description: "Updated exact catalog product" } } } },
      "/project-revisions/{id}/bom": { get: { parameters: [{ name: "includeRetired", in: "query", required: false, schema: { type: "boolean", default: false } }], responses: { "200": { description: "Active BOM lines by default; retired history when explicitly requested" } } }, post: { responses: { "201": { description: "BOM line" } } } },
      "/bom-lines/{id}": { delete: { parameters: [{ name: "If-Match", in: "header", required: true, schema: { type: "integer", minimum: 1 } }], responses: { "200": { description: "Retired BOM line" }, "400": { description: "Missing or invalid version precondition" }, "409": { description: "Version or active-reservation conflict" } } } },
      "/bom-lines/{id}/restore": { post: { parameters: [{ name: "If-Match", in: "header", required: true, schema: { type: "integer", minimum: 1 } }], responses: { "200": { description: "Restored BOM line" }, "400": { description: "Missing or invalid version precondition" }, "409": { description: "Version conflict" } } } },
      "/project-revisions/{id}/build-configurations": { get: { responses: { "200": { description: "Immutable build configuration snapshot page" } } }, post: { responses: { "201": { description: "Immutable build configuration snapshot" } } } },
      "/build-configurations/{id}": { get: { responses: { "200": { description: "Immutable build configuration snapshot" } } } },
      "/project-revisions/{id}/gaps": { get: { responses: { "200": { description: "Evidence-backed BOM gaps" } } } },
      "/project-revisions/{id}/reconciliation": {
        get: { summary: "Read the current post-project reconciliation draft", responses: { "200": { description: "Reconciliation draft, or null before the first save" } } },
        put: { summary: "Save a review-only post-project reconciliation draft", responses: { "200": { description: "Saved reconciliation draft mutation" }, "409": { description: "Version or basis conflict" } } }
      },
      "/project-revisions/{id}/reconciliation/commit": { post: { summary: "Commit a reviewed reconciliation atomically", responses: { "200": { description: "Committed reconciliation mutation" }, "409": { description: "Stale basis, version, or replay conflict" } } } },
      "/project-revisions/{id}/usage": { post: { responses: { "201": { description: "Recorded reviewed project usage" } } } },
      "/artifacts/uploads": { post: { responses: { "201": { description: "Upload session" } } } },
      "/transfers/uploads/{id}": { put: { security: [{ transferAuth: [] }], responses: { "200": { description: "Uploaded bytes" }, "403": { description: "Invalid or expired transfer capability" }, "410": { description: "Expired transfer capability" } } } },
      "/transfers/uploads/{id}/finalize": { post: { security: [{ transferAuth: [] }], responses: { "200": { description: "Finalized artifact" }, "403": { description: "Invalid or expired transfer capability" }, "410": { description: "Expired transfer capability" } } } },
      "/transfers/artifacts/{id}/download": { get: { security: [{ transferAuth: [] }], responses: { "200": { description: "Artifact bytes" }, "403": { description: "Invalid or expired transfer capability" }, "410": { description: "Expired transfer capability" } } } },
      "/mcp": { post: { security: [{ bearerAuth: [] }], responses: { "200": { description: "Authenticated MCP JSON-RPC response" } } } },
      "/events": { get: { responses: { "200": { description: "Server-sent state events" } } } }
    }
  };
}

interface WorkspaceProject extends ApiProject {
  readonly workItems: readonly ApiWorkItem[];
  readonly bom: readonly ApiBomLine[];
  readonly artifacts: readonly ApiArtifact[];
  readonly currentRevision?: ApiProjectRevision & {
    readonly bom: readonly ApiBomLine[];
    readonly artifacts: readonly ApiArtifact[];
    /** Canonical application-service readiness used by the browser. */
    readonly gapEvaluation: GapEvaluation;
    /** Latest immutable setup captured for this current revision, if any. */
    readonly buildConfigSnapshot?: ApiBuildConfigurationSnapshot;
  };
}

interface WorkspaceInventoryItem extends ApiInventoryItem {
  /** Exact catalog identity and physical profile are optional so legacy stock remains readable. */
  readonly catalogProduct?: ApiCatalogProduct;
  readonly productProfile?: ApiInventoryProductProfile;
}

interface WorkspaceSnapshot {
  readonly inventory: readonly WorkspaceInventoryItem[];
  readonly projects: readonly WorkspaceProject[];
  readonly offers: readonly ApiOffer[];
  readonly source: "api";
  readonly fetchedAt: string;
  readonly pagination: {
    readonly inventory: { readonly limit: number; readonly total?: number; readonly nextCursor?: string };
    readonly projects: { readonly limit: number; readonly total?: number; readonly nextCursor?: string };
    readonly offers: { readonly limit: number; readonly total?: number; readonly nextCursor?: string };
  };
}

async function hydrateWorkspaceInventory(
  service: ApplicationService,
  items: readonly ApiInventoryItem[]
): Promise<readonly WorkspaceInventoryItem[]> {
  // Generic legacy items cannot have a printer/filament profile. Restrict the
  // lookups to profile-capable kinds and keep the inventory page bounded by
  // the caller's page size (currently 200), rather than walking the database.
  const profileEntries = await Promise.all(items
    .filter((item) => item.kind === "printer" || item.kind === "filament")
    .map(async (item) => {
      try {
        return { item, profile: await service.getInventoryProductProfile(item.id) };
      } catch (error: unknown) {
        if (error instanceof ApplicationError && error.code === "not_found") return { item, profile: null };
        throw error;
      }
    }));

  const catalogIds = [...new Set(profileEntries
    .flatMap(({ profile }) => profile === null ? [] : [profile.catalogProductId]))];
  const catalogProducts = await Promise.all(catalogIds.map(async (catalogProductId) => [
    catalogProductId,
    await service.getCatalogProduct(catalogProductId)
  ] as const));
  const catalogById = new Map(catalogProducts);
  const profileByItemId = new Map(profileEntries.map(({ item, profile }) => [item.id, profile] as const));

  return items.map((item): WorkspaceInventoryItem => {
    const profile = profileByItemId.get(item.id);
    if (profile === undefined || profile === null) return item;
    const catalogProduct = catalogById.get(profile.catalogProductId);
    if (catalogProduct === undefined) {
      throw new ApplicationError("integrity_error", `Catalog product '${profile.catalogProductId}' was not found for inventory item '${item.id}'`);
    }
    return { ...item, productProfile: profile, catalogProduct };
  });
}

async function workspaceSnapshot(service: ApplicationService): Promise<WorkspaceSnapshot> {
  const [inventory, projects, offers] = await Promise.all([
    service.listInventory({ limit: 200 }),
    service.listProjects({ limit: 200 }),
    service.listOffers(undefined, 200)
  ]);
  const enrichedProjects = await Promise.all(projects.data.map(async (project): Promise<WorkspaceProject> => {
    const [workItems, artifacts] = await Promise.all([
      service.listWorkItems(project.id),
      service.listArtifacts(project.id)
    ]);
    if (project.currentRevisionId === undefined) return { ...project, workItems, bom: [], artifacts };
    const revision = await service.getProjectRevision(project.currentRevisionId);
    const [bom, revisionArtifacts, gapEvaluation] = await Promise.all([
      service.listBomLines(revision.id),
      service.listArtifacts(project.id, undefined, revision.id),
      service.evaluateBomGaps(revision.id),
    ]);
    const latestConfiguration = await service.getLatestBuildConfiguration(revision.id);
    const currentRevision = {
      ...revision,
      bom,
      artifacts: revisionArtifacts,
      gapEvaluation,
      ...(latestConfiguration === null ? {} : { buildConfigSnapshot: latestConfiguration })
    };
    return { ...project, workItems, bom, artifacts, currentRevision };
  }));
  const hydratedInventory = await hydrateWorkspaceInventory(service, inventory.data);
  return {
    inventory: hydratedInventory,
    projects: enrichedProjects,
    offers: offers.data,
    source: "api",
    fetchedAt: new Date().toISOString(),
    pagination: {
      inventory: { limit: inventory.limit, ...(inventory.total === undefined ? {} : { total: inventory.total }), ...(inventory.nextCursor === undefined ? {} : { nextCursor: inventory.nextCursor }) },
      projects: { limit: projects.limit, ...(projects.total === undefined ? {} : { total: projects.total }), ...(projects.nextCursor === undefined ? {} : { nextCursor: projects.nextCursor }) },
      offers: { limit: offers.limit, ...(offers.total === undefined ? {} : { total: offers.total }), ...(offers.nextCursor === undefined ? {} : { nextCursor: offers.nextCursor }) }
    }
  };
}

async function scopedProjectPage(service: ApplicationService, query: ProjectListOptions, projectIds: ReadonlySet<string>): Promise<Page<ApiProject>> {
  const projects = await Promise.all([...projectIds].map(async (projectId) => {
    try { return await service.getProject(projectId); } catch (error) {
      if (error instanceof ApplicationError && error.code === "not_found") return null;
      throw error;
    }
  }));
  const needle = query.q?.trim().toLocaleLowerCase();
  const filtered = projects.filter((project): project is ApiProject => project !== null && (query.status === undefined ? project.status !== "archived" : project.status === query.status) && (needle === undefined || project.name.toLocaleLowerCase().includes(needle) || project.description?.toLocaleLowerCase().includes(needle) === true));
  const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const selected = filtered.slice(start, start + query.limit);
  const nextCursor = start + selected.length < filtered.length ? String(start + selected.length) : undefined;
  return { data: selected, limit: query.limit, total: filtered.length, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function errorStatus(error: ApplicationError): number {
  switch (error.code) {
    case "not_found": return 404;
    case "project_removed": return 410;
    case "invalid_cursor": return 400;
    case "conflict": case "idempotency_conflict": case "integrity_error": return 409;
    case "forbidden": return 403;
    case "quota_exceeded": return 413;
    case "unsupported_media": return 415;
    case "upload_expired": return 410;
    case "validation": default: return 400;
  }
}

class WorkspaceSecurityRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "WorkspaceSecurityRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function workspaceSecurityError(error: unknown): { readonly code: string; readonly status: number; readonly message: string; readonly details?: Readonly<Record<string, unknown>>; readonly retryAfterSeconds?: number } | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "WorkspaceSecurityAuthenticationError") return { code: "invalid_credentials", status: 401, message: "Current workspace password is invalid" };
  if (error instanceof WorkspaceSecurityRateLimitError) return { code: "rate_limited", status: 429, message: error.message, retryAfterSeconds: error.retryAfterSeconds };
  if (error.name === "RuntimeConflict") return { code: "conflict", status: 409, message: error.message, ...((error as Error & { readonly details?: Readonly<Record<string, unknown>> }).details ? { details: (error as Error & { readonly details?: Readonly<Record<string, unknown>> }).details } : {}) };
  return null;
}

export async function createApp(options: ServerOptions = {}): Promise<FastifyInstance> {
  const demo = options.demo ?? false;
  // The bootstrap hash is supplied by the process entrypoint/runtime. Keeping
  // it out of createApp's environment reads allows durable state to become the
  // source of truth after the first startup.
  const adminPasswordHash = options.auth?.adminPasswordHash;
  const sessionSecret = options.auth?.sessionSecret ?? process.env.BENCHLEDGER_SESSION_SECRET ?? (demo ? randomSecret() : "");
  const publicBaseUrl = publicBaseUrlFromEnvironment(options.publicBaseUrl ?? process.env.BENCHLEDGER_PUBLIC_BASE_URL, demo);
  const artifactTransfer = options.artifactTransferManager ?? new ArtifactTransferManager(publicBaseUrl);
  let activePasswordHashes = 0;
  const runtime: RuntimeHandle | undefined = options.runtime ?? (options.ports ? undefined : demo ? createSyntheticRuntime() : await createProductionRuntime({
    dataDir: options.dataDir ?? process.env.BENCHLEDGER_DATA_DIR ?? "",
    ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
    ...(options.maxStorageBytes === undefined ? {} : { maxStorageBytes: options.maxStorageBytes }),
    ...(adminPasswordHash === undefined ? {} : { workspacePasswordHash: adminPasswordHash }),
    ...(options.auth?.passwordVerifier === undefined ? {} : { workspacePasswordVerifier: options.auth.passwordVerifier })
  }));
  const ports = options.ports ?? runtime?.ports;
  if (!ports) throw new Error("createApp requires application ports");
  const service = options.service ?? new ApplicationService(ports, options.version ?? "0.1.0");
  const suppliedBearerTokens = options.auth?.bearerTokens ?? [];
  const workspaceSecurity = ports.workspaceSecurity;
  let credentialRevision = 1;
  const fallbackSecurityStatus = {
    mode: demo || adminPasswordHash !== undefined ? "password" as const : "lan_open" as const,
    passwordConfigured: demo || adminPasswordHash !== undefined,
    version: 1
  };
  if (workspaceSecurity !== undefined) credentialRevision = (await service.getWorkspaceSecurityStatus()).version;
  const readWorkspaceSecurity = async (): Promise<ApiWorkspaceSecurityStatus> => {
    const durable = workspaceSecurity === undefined ? fallbackSecurityStatus : await service.getWorkspaceSecurityStatus();
    // Demo workspaces always retain their protected sample boundary, even if
    // a production runtime was injected for an integration test.
    return demo ? { ...durable, mode: "password", passwordConfigured: true } : durable;
  };
  const authConfig: AuthConfig = {
    sessionSecret,
    ...(adminPasswordHash ? { adminPasswordHash } : {}),
    ...(options.auth?.passwordVerifier ? { passwordVerifier: options.auth.passwordVerifier } : {}),
    ...(workspaceSecurity === undefined ? {} : { workspacePasswordVerifier: (password: string) => service.verifyWorkspacePassword(password) }),
    credentialRevision: () => credentialRevision,
    ...(demo ? { demo: true, demoPassword: options.auth?.demoPassword ?? process.env.BENCHLEDGER_DEMO_PASSWORD ?? "demo-password-please-change" } : {}),
    ...(suppliedBearerTokens.length > 0 ? { bearerTokens: suppliedBearerTokens } : {}),
    secureCookies: options.auth?.secureCookies ?? false,
    sessionTtlSeconds: options.auth?.sessionTtlSeconds ?? 8 * 60 * 60
  };
  const auth = new AuthManager(authConfig);
  const app = Fastify({ logger: options.logger ?? false, trustProxy: options.trustProxy ?? false, bodyLimit: 100 * 1024 * 1024 });
  if (runtime?.close !== undefined) app.addHook("onClose", async () => runtime.close?.());
  await app.register(cookie);
  await app.register(swagger, { openapi: jsonOpenApi(service.getVersion()) });
  for (const contentType of ["application/octet-stream", "application/pdf", "image/jpeg", "image/png", "image/webp", "model/step", "model/stl", "application/vnd.ms-package.3dmanufacturing-3mf", "text/plain"]) {
    app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  }
  app.decorateRequest("principal", undefined as unknown as Principal);
  app.decorateRequest("correlationId", "");
  // One budget covers login and current-password reauthentication attempts so
  // an attacker cannot bypass the limit by alternating the two endpoints.
  const passwordAttempts = new Map<string, AttemptWindow>();
  const passwordHashAttempts = new Map<string, AttemptWindow>();
  let activePasswordVerifications = 0;

  const rateLimitWindow = (attempts: Map<string, AttemptWindow>, key: string, label: string): void => {
    const current = attempts.get(key);
    const now = Date.now();
    if (current?.resetAt !== undefined && current.resetAt > now && current.count >= AUTH_ATTEMPT_LIMIT) {
      throw new WorkspaceSecurityRateLimitError(`Too many ${label} attempts; try again later`, Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
    }
    if (current !== undefined && current.resetAt <= now) attempts.delete(key);
  };

  const recordFailedAttempt = (attempts: Map<string, AttemptWindow>, key: string): void => {
    const current = attempts.get(key);
    const now = Date.now();
    attempts.set(key, { count: (current?.resetAt !== undefined && current.resetAt > now ? current.count : 0) + 1, resetAt: current?.resetAt !== undefined && current.resetAt > now ? current.resetAt : now + AUTH_ATTEMPT_WINDOW_MS });
  };

  const verifyPasswordWithThrottle = async (operation: () => Promise<boolean>, label: string): Promise<boolean> => {
    if (activePasswordVerifications >= PASSWORD_HASH_CONCURRENCY_LIMIT) throw new WorkspaceSecurityRateLimitError(`Too many ${label} requests; try again later`, 1);
    activePasswordVerifications += 1;
    try {
      return await operation();
    } finally {
      activePasswordVerifications -= 1;
    }
  };

  const runCurrentPasswordMutation = async <T>(clientKey: string, operation: () => Promise<T>): Promise<T> => {
    rateLimitWindow(passwordAttempts, clientKey, "current-password");
    if (activePasswordVerifications >= PASSWORD_HASH_CONCURRENCY_LIMIT) throw new WorkspaceSecurityRateLimitError("Too many current-password verification requests; try again later", 1);
    activePasswordVerifications += 1;
    try {
      return await operation();
    } finally {
      activePasswordVerifications -= 1;
    }
  };

  const runPasswordHashMutation = async <T>(clientKey: string, operation: () => Promise<T>): Promise<T> => {
    rateLimitWindow(passwordHashAttempts, clientKey, "password hashing");
    if (activePasswordHashes >= PASSWORD_HASH_CONCURRENCY_LIMIT) throw new WorkspaceSecurityRateLimitError("Too many password hashing requests; try again later", 1);
    activePasswordHashes += 1;
    try {
      const result = await operation();
      recordFailedAttempt(passwordHashAttempts, clientKey);
      return result;
    } catch (error: unknown) {
      // A wrong current password is rejected before the runtime hashes the
      // replacement, so it must not consume the hashing budget.
      if (!(error instanceof Error) || error.name !== "WorkspaceSecurityAuthenticationError") recordFailedAttempt(passwordHashAttempts, clientKey);
      throw error;
    } finally {
      activePasswordHashes -= 1;
    }
  };

  app.addHook("onRequest", async (request, reply) => {
    const correlationId = validCorrelation(Array.isArray(request.headers["x-correlation-id"]) ? request.headers["x-correlation-id"][0] : request.headers["x-correlation-id"]);
    request.correlationId = correlationId;
    reply.header("x-correlation-id", correlationId);
    const contentType = request.headers["content-type"] ?? "";
    const contentLength = Number(request.headers["content-length"] ?? 0);
    const path = request.url.split("?")[0] ?? request.url;
    // Capability endpoints authenticate with their single-purpose transfer
    // header, so they intentionally bypass the session/bearer + CSRF hook.
    if (path.startsWith("/api/v1/transfers/")) {
      const transfer = transferRequest(request.method, path);
      if (transfer === null) throw new ApplicationError("not_found", "Route not found");
      if (transfer.action === "upload_write") {
        artifactTransfer.preflightUploadWrite(request.headers[TRANSFER_TOKEN_HEADER], transfer.resourceId, transferContentLength(request.headers["content-length"]));
      } else {
        artifactTransfer.preflight(transfer.action, request.headers[TRANSFER_TOKEN_HEADER], transfer.resourceId);
      }
      return;
    }
    if (contentType.toLowerCase().startsWith("application/json") && Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      await reply.code(413).send({ error: { code: "quota_exceeded", message: "JSON request body is too large", correlationId } });
      return reply;
    }
    if (!request.url.startsWith("/api/v1")) return;
    // An explicitly supplied Authorization header is never ignored, including
    // on public discovery/auth bootstrap routes. This prevents a malformed
    // header from silently falling through to a cookie or public response.
    if (request.headers.authorization !== undefined && !auth.authenticate(request)) {
      await reply.code(401).send({ error: { code: "unauthenticated", message: "Authentication is required", correlationId } });
      return reply;
    }
    if (PUBLIC_PATHS.has(path) && (path !== "/api/v1/auth/access" || request.method === "GET")) return;
    const principal = auth.authenticate(request);
    if (!principal) {
      await reply.code(401).send({ error: { code: "unauthenticated", message: "Authentication is required", correlationId } });
      return reply;
    }
    request.principal = principal;
    if (!auth.csrfValid(request, principal)) {
      await reply.code(403).send({ error: { code: "csrf", message: "A valid CSRF token is required", correlationId } });
      return reply;
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApplicationError) {
      const applicationError = error as ApplicationError;
      return reply.code(errorStatus(applicationError)).send({ error: { code: applicationError.code, message: applicationError.message, ...(applicationError.details ? { details: applicationError.details } : {}), correlationId: request.correlationId } });
    }
    const securityError = workspaceSecurityError(error);
    if (securityError !== null) {
      if (securityError.retryAfterSeconds !== undefined) reply.header("retry-after", String(securityError.retryAfterSeconds));
      return reply.code(securityError.status).send({ error: { code: securityError.code, message: securityError.message, ...(securityError.details ? { details: securityError.details } : {}), correlationId: request.correlationId } });
    }
    if (error && typeof error === "object" && "validation" in error) {
      return reply.code(400).send({ error: { code: "validation", message: "Request is invalid", correlationId: request.correlationId } });
    }
    request.log.error({ err: error, correlationId: request.correlationId }, "request failed");
    return reply.code(500).send({ error: { code: "internal", message: "An unexpected server error occurred", correlationId: request.correlationId } });
  });

  const route = (path: string) => `/api/v1${path}`;
  app.get(route("/health"), async () => {
    const result = await service.health();
    const { checks: _checks, ...health } = result;
    return healthSchema.parse({ ...health, demo });
  });
  app.get(route("/ready"), async (_request, reply) => {
    const result = await service.health();
    const ready = result.status === "ok";
    if (!ready) return reply.code(503).send({ ...result, demo });
    return { ...result, demo };
  });
  app.get(route("/capabilities"), async () => ({
    name: "BenchLedger", version: service.getVersion(), protocol: "rest-v1", demo,
    authentication: { accessModes: ["lan_open", "password"], access: "/api/v1/auth/access", explicitLanSession: "/api/v1/auth/lan-session", bearerRequiredForMcp: true },
    vocabulary: { confirmed: "physically counted or commissioned stock", inspect_first: "recorded stock requiring a physical count", missing: "no confirmed or inspect-first candidate" },
    actions: ["inventory.read", "inventory.write", "inventory.categories.read", "inventory.categories.write", "catalog.read", "catalog.write", "inventory.product_profile.read", "inventory.product_profile.write", "projects.read", "projects.write", "projects.remove", "projects.removed_history", "build_configurations.read", "build_configurations.create", "bom.evaluate", "artifacts.version", "offers.compare", "events.subscribe"],
    approvalBoundaries: ["purchasing", "external publication", "permanent deletion", "credential changes", "printer control"]
  }));
  app.get(route("/openapi.json"), async () => jsonOpenApi(service.getVersion()));
  app.get(route("/docs"), async (_request, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html><title>BenchLedger API</title><p>OpenAPI: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a></p>`));

  app.get(route("/auth/access"), async () => readWorkspaceSecurity());
  app.post(route("/auth/lan-session"), async (_request, reply) => {
    const access = await readWorkspaceSecurity();
    if (access.mode !== "lan_open") return reply.code(403).send({ error: { code: "password_required", message: "Workspace password protection is enabled", correlationId: _request.correlationId } });
    const session = auth.issueSession(reply);
    return { ...access, authenticated: true, actor: "workspace-admin", csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString(), credentialRevision: session.credentialRevision, correlationId: _request.correlationId };
  });

  app.post(route("/mcp"), async (request, reply) => {
    const principal = requireScope(request, "read", auth);
    if (principal.via !== "bearer") {
      return reply.code(401).send({ error: { code: "unauthenticated", message: "A scoped bearer token is required for MCP", correlationId: request.correlationId } });
    }
    const context = mcpContext(principal, request);
    // Generic MCP has no model-excluded channel for live transfer URLs or
    // bearer headers. The HTTP host keeps direct browser/transfer routes
    // private; MCP artifact transfer remains fail-closed until a transactional
    // trusted-host bridge is implemented.
    const protocol = createApplicationMcpProtocol(service, { context, serverInfo: { name: "benchledger", version: service.getVersion() } });
    const handler = createMcpHttpHandler(protocol, { context, maxBodyBytes: 1_000_000 });
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
    const result = await handler({ method: request.method, headers, body: request.body });
    reply.code(result.status);
    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    return reply.send(result.body);
  });

  app.post(route("/auth/login"), async (request, reply) => {
    const clientKey = request.ip;
    rateLimitWindow(passwordAttempts, clientKey, "login");
    const body = request.body as { password?: unknown };
    const valid = await verifyPasswordWithThrottle(async () => {
      const access = await readWorkspaceSecurity();
      return access.mode === "password" && typeof body?.password === "string" && body.password.length >= 12 && body.password.length <= 512
        && await auth.verifyPassword(body.password as string);
    }, "login verification");
    if (!valid) {
      recordFailedAttempt(passwordAttempts, clientKey);
      return reply.code(401).send({ error: { code: "invalid_credentials", message: "Email or password is invalid", correlationId: request.correlationId } });
    }
    passwordAttempts.delete(clientKey);
    const session = auth.issueSession(reply);
    return { authenticated: true, actor: "workspace-admin", csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString(), credentialRevision: session.credentialRevision, correlationId: request.correlationId };
  });
  const securityMutation = async (request: FastifyRequest, reply: FastifyReply) => {
    if (demo) throw new ApplicationError("forbidden", "Workspace security settings are unavailable in the demo workspace");
    const principal = requirePrincipal(request);
    if (principal.source !== "ui" || principal.via !== "session" || principal.projectIds !== undefined || !auth.hasScope(principal, "admin")) throw new ApplicationError("forbidden", "Only an unscoped workspace administrator session may change security settings");
    const idempotencyKey = requestIdempotencyKey(request);
    if (idempotencyKey === undefined) throw new ApplicationError("validation", "Idempotency-Key is required for workspace security changes");
    const operation = parseWorkspaceSecurityRequest(request.body, parseExpectedVersion(request));
    const context: RequestContext = {
      actor: principal.actor,
      source: "ui",
      correlationId: request.correlationId ?? randomUUID(),
      scopes: principal.scopes,
      idempotencyKey,
      fingerprint: securityFingerprint(operation, sessionSecret)
    };
    try {
      // ApplicationService performs idempotency lookup before it calls the
      // runtime. This preserves safe replay after a lost response and keeps
      // current-password verification ahead of replacement hashing inside the
      // trusted runtime adapter.
      const update = () => operation.operation === "enable" || operation.operation === "change_password"
        ? runPasswordHashMutation(request.ip, () => service.updateWorkspaceSecurity(operation, context))
        : service.updateWorkspaceSecurity(operation, context);
      const mutation = operation.operation === "enable"
        ? await update()
        : await runCurrentPasswordMutation(request.ip, update);
      if (operation.operation !== "enable") passwordAttempts.delete(request.ip);
      // Advance the local verifier immediately after the durable mutation. If
      // the following status read fails, prior sessions must still be invalid.
      credentialRevision = Math.max(credentialRevision, mutation.data.version);
      // The mutation result can be an idempotency replay from an earlier
      // durable revision. Always re-read the current status before issuing a
      // session so replaying a historical key cannot roll back the in-memory
      // revision and revive an invalidated browser cookie.
      const access = await readWorkspaceSecurity();
      credentialRevision = Math.max(credentialRevision, access.version);
      const session = auth.issueSession(reply);
      return {
        ...access,
        access,
        session: { authenticated: true, actor: "workspace-admin", csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString(), credentialRevision: session.credentialRevision },
        authenticated: true,
        actor: "workspace-admin",
        csrfToken: session.csrf,
        expiresAt: new Date(session.expiresAt).toISOString(),
        credentialRevision: session.credentialRevision,
        correlationId: request.correlationId,
        replayed: mutation.replayed
      };
    } catch (error: unknown) {
      if (error instanceof ApplicationError) {
        if (error.code === "forbidden" && error.message.includes("Current workspace password")) return reply.code(401).send({ error: { code: "invalid_credentials", message: "Current workspace password is invalid", correlationId: request.correlationId } });
        throw error;
      }
      const securityError = workspaceSecurityError(error);
      if (securityError !== null) {
        if (securityError.code === "invalid_credentials") recordFailedAttempt(passwordAttempts, request.ip);
        if (securityError.retryAfterSeconds !== undefined) reply.header("retry-after", String(securityError.retryAfterSeconds));
        return reply.code(securityError.status).send({ error: { code: securityError.code, message: securityError.message, ...(securityError.details ? { details: securityError.details } : {}), correlationId: request.correlationId } });
      }
      throw error;
    }
  };
  app.patch(route("/auth/access"), securityMutation);
  app.post(route("/auth/security"), securityMutation);
  app.post(route("/auth/logout"), async (request, reply) => { requirePrincipal(request); auth.clearSession(reply); return { authenticated: false, correlationId: request.correlationId }; });
  app.get(route("/auth/session"), async (request) => { const principal = requirePrincipal(request); return { authenticated: true, actor: principal.actor, source: principal.source, scopes: [...principal.scopes], projectIds: principal.projectIds ? [...principal.projectIds] : undefined }; });

  app.get(route("/workspace"), async (request) => { requireScope(request, "read", auth); rejectScopedGlobalAccess(request); return workspaceSnapshot(service); });
  app.get(route("/catalog/products"), async (request) => {
    requireScope(request, "read", auth);
    return service.listCatalogProducts(parseCatalogQuery(request.query));
  });
  app.post(route("/catalog/products"), async (request, reply) => {
    requireScope(request, "write", auth);
    rejectScopedGlobalAccess(request);
    const mutation = await service.createCatalogProduct(parseBody(createCatalogProductSchema, request.body), requestContext(request));
    return reply.code(201).send(mutationBody(mutation));
  });
  app.get(route("/catalog/products/:id"), async (request) => {
    requireScope(request, "read", auth);
    const params = request.params as { id: string };
    return service.getCatalogProduct(params.id);
  });
  app.patch(route("/catalog/products/:id"), async (request) => {
    requireScope(request, "write", auth);
    rejectScopedGlobalAccess(request);
    const params = request.params as { id: string };
    return service.updateCatalogProduct(params.id, parseBody(updateCatalogProductSchema, request.body), parseExpectedVersion(request), requestContext(request));
  });
  app.get(route("/inventory"), async (request) => {
    requireScope(request, "read", auth);
    const query = parseBody(inventoryListQuerySchema, request.query);
    const page = await service.listInventory(query);
    const inventory = request.principal?.projectIds === undefined
      ? await hydrateWorkspaceInventory(service, page.data)
      : page.data;
    return { ...page, data: inventory };
  });
  app.get(route("/inventory/categories"), async (request) => { requireScope(request, "read", auth); return service.listInventoryCategories(parseBody(inventoryCategoryListQuerySchema, request.query)); });
  app.post(route("/inventory/categories"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const mutation = await service.createInventoryCategory(parseBody(createInventoryCategorySchema, request.body), requestContext(request)); return reply.code(201).send(mutationBody(mutation)); });
  app.get(route("/inventory/categories/:id"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; return service.getInventoryCategory(params.id); });
  app.patch(route("/inventory/categories/:id"), async (request) => {
    requireScope(request, "write", auth);
    rejectScopedGlobalAccess(request);
    const params = request.params as { id: string };
    const body = parseBody(updateInventoryCategorySchema, request.body);
    const expectedVersion = parseRequiredExpectedVersion(request);
    return service.updateInventoryCategory(params.id, body, expectedVersion, requestContext(request, { body, expectedVersion }));
  });
  app.post(route("/inventory/categories/:id/archive"), async (request) => {
    requireScope(request, "write", auth);
    rejectScopedGlobalAccess(request);
    const params = request.params as { id: string };
    const expectedVersion = parseRequiredExpectedVersion(request);
    return service.archiveInventoryCategory(params.id, expectedVersion, requestContext(request, { body: request.body, expectedVersion }));
  });
  app.post(route("/inventory"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const mutation = await service.createInventoryItem(parseBody(createInventoryItemSchema, request.body), requestContext(request)); return reply.code(201).send(mutationBody(mutation)); });
  app.post(route("/inventory/with-product-profile"), async (request, reply) => {
    requireScope(request, "write", auth);
    rejectScopedGlobalAccess(request);
    const mutation = await service.createInventoryWithProductProfile(parseBody(createInventoryWithProductProfileSchema, request.body), requestContext(request));
    return reply.code(201).send(mutationBody(mutation));
  });
  app.patch(route("/inventory/bulk"), async (request) => {
    requireScope(request, "write", auth);
    rejectScopedGlobalAccess(request);
    return service.bulkUpdateInventoryItems(parseBody(inventoryBulkUpdateSchema, request.body), requestContext(request));
  });
  app.get(route("/inventory/:id"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; return service.getInventoryItem(params.id); });
  app.post(route("/inventory/:id/count"), async (request, reply) => {
    requireScope(request, "write", auth);
    rejectScopedGlobalAccess(request);
    const params = request.params as { id: string };
    const item = await service.getInventoryItem(params.id);
    const body = parsePhysicalCount(request.body);
    const mutation = await service.recordPhysicalCount(params.id, body.quantity, requestContext(request), item.unit, body.note);
    return reply.code(201).send(mutation);
  });
  app.post(route("/inventory/:id/commission"), async (request, reply) => {
    requireScope(request, "write", auth);
    rejectScopedGlobalAccess(request);
    const params = request.params as { id: string };
    const expectedVersion = parseExpectedVersion(request);
    if (expectedVersion === undefined) throw new ApplicationError("validation", "If-Match is required when commissioning inventory");
    if (requestIdempotencyKey(request) === undefined) throw new ApplicationError("validation", "Idempotency-Key is required when commissioning inventory");
    const mutation = await service.commissionInventoryItem(params.id, parseBody(commissionInventoryItemSchema, request.body), expectedVersion, requestContext(request));
    return reply.code(201).send(mutation);
  });
  app.patch(route("/inventory/:id"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.updateInventoryItem(params.id, parseBody(updateInventoryItemSchema, request.body) as never, parseExpectedVersion(request), requestContext(request)); });
  app.get(route("/inventory/:id/product-profile"), async (request) => {
    requireScope(request, "read", auth);
    rejectScopedGlobalAccess(request);
    const params = request.params as { id: string };
    return service.getInventoryProductProfile(params.id);
  });
  app.put(route("/inventory/:id/product-profile"), async (request) => {
    requireScope(request, "write", auth);
    rejectScopedGlobalAccess(request);
    const params = request.params as { id: string };
    const mutation = await service.putInventoryProductProfile(params.id, parseInventoryProductProfileBody(request.body), parseExpectedVersion(request), requestContext(request));
    return mutation;
  });
  app.get(route("/inventory/:id/stock-events"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; const query = request.query as { limit?: string; cursor?: string }; return service.listStockEvents(params.id, Number(query.limit ?? 50), query.cursor); });
  app.post(route("/inventory/:id/stock-events"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; const input = parseBody(stockEventInputSchema, { ...(request.body as Record<string, unknown>), itemId: params.id }); const mutation = await service.recordStockEvent(input, requestContext(request)); return reply.code(201).send(mutation); });

  app.get(route("/projects"), async (request) => {
    requireScope(request, "read", auth);
    const query = request.query as { q?: string; status?: ProjectListOptions["status"]; limit?: string; cursor?: string };
    const parsedStatus = query.status === undefined ? undefined : projectStatusSchema.safeParse(query.status);
    if (parsedStatus !== undefined && !parsedStatus.success) throw new ApplicationError("validation", "Project status must be one of the canonical lifecycle values");
    const parsed = { ...(query.q === undefined ? {} : { q: query.q }), ...(parsedStatus === undefined ? {} : { status: parsedStatus.data }), limit: Math.min(Math.max(Number(query.limit ?? 50), 1), 200), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) } satisfies ProjectListOptions;
    return request.principal?.projectIds === undefined ? service.listProjects(parsed) : scopedProjectPage(service, parsed, request.principal.projectIds);
  });
  app.get(route("/projects/removed"), async (request) => {
    requireScope(request, "read", auth);
    rejectScopedGlobalAccess(request);
    const query = request.query as { limit?: string; cursor?: string };
    return service.listRemovedProjectPage(Number(query.limit ?? 50), query.cursor);
  });
  app.post(route("/projects"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const mutation = await service.createProject(parseBody(createProjectSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.post(route("/projects/with-initial-revision"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const mutation = await service.createProjectWithInitialRevision(parseBody(createProjectWithInitialRevisionSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.get(route("/projects/:id/removed-history"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; requireProjectScope(request, params.id); const query = request.query as { limit?: string; cursor?: string }; return service.readRemovedProjectHistory(params.id, Number(query.limit ?? 50), query.cursor); });
  app.get(route("/projects/:id"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; requireProjectScope(request, params.id); const project = await service.getProject(params.id); return { project, workItems: await service.listWorkItems(params.id) }; });
  app.patch(route("/projects/:id"), async (request) => { requireScope(request, "write", auth); const params = request.params as { id: string }; requireProjectScope(request, params.id); return service.updateProject(params.id, parseBody(updateProjectSchema, request.body) as never, parseExpectedVersion(request), requestContext(request)); });
  app.post(route("/projects/:id/restore"), async (request) => { requireScope(request, "write", auth); const params = request.params as { id: string }; requireProjectScope(request, params.id); return service.restoreProject(params.id, parseExpectedVersion(request), requestContext(request)); });
  app.delete(route("/projects/:id"), async (request) => {
    requireScope(request, "write", auth);
    const params = request.params as { id: string };
    requireProjectScope(request, params.id);
    if (requestIdempotencyKey(request) === undefined) throw new ApplicationError("validation", "Idempotency-Key is required for project removal");
    const expectedVersion = parseRequiredExpectedVersion(request);
    const body = parseBody(removeProjectSchema, request.body);
    const confirmationName = body.name ?? body.projectName;
    if (confirmationName === undefined) throw new ApplicationError("validation", "Exact project-name confirmation is required");
    return service.removeProject(params.id, expectedVersion, confirmationName, requestContext(request));
  });
  app.get(route("/projects/:id/work-items"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; requireProjectScope(request, params.id); return service.listWorkItems(params.id); });
  app.post(route("/projects/:id/work-items"), async (request, reply) => { requireScope(request, "write", auth); const params = request.params as { id: string }; requireProjectScope(request, params.id); const mutation = await service.createWorkItem(params.id, parseBody(createWorkItemSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.post(route("/projects/:id/revisions"), async (request, reply) => { requireScope(request, "write", auth); const params = request.params as { id: string }; requireProjectScope(request, params.id); const mutation = await service.createProjectRevision(params.id, parseBody(createProjectRevisionSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.get(route("/project-revisions/:id"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; return projectRevisionForRequest(request, service, params.id); });
  app.get(route("/project-revisions/:id/build-configurations"), async (request) => {
    requireScope(request, "read", auth);
    const params = request.params as { id: string };
    await requireRevisionScope(request, service, params.id);
    return service.listBuildConfigurations(params.id, parseBuildConfigurationQuery(request.query));
  });
  app.post(route("/project-revisions/:id/build-configurations"), async (request, reply) => {
    requireScope(request, "write", auth);
    const params = request.params as { id: string };
    await requireRevisionScope(request, service, params.id);
    const input = parseBody(createBuildConfigurationSnapshotSchema, request.body);
    if (input.supersedesSnapshotId !== undefined) {
      await authorizeScopedBuildConfigurationReference(request, service, input.supersedesSnapshotId);
    }
    const mutation = await service.createBuildConfiguration(params.id, input, requestContext(request));
    return reply.code(201).send(mutation);
  });
  app.get(route("/build-configurations/:id"), async (request) => {
    requireScope(request, "read", auth);
    const params = request.params as { id: string };
    return buildConfigurationForRequest(request, service, params.id);
  });
  app.post(route("/work-items/:id/revisions"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; const mutation = await service.createWorkItemRevision(params.id, parseBody(createWorkItemRevisionSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.get(route("/work-item-revisions/:id"), async (request) => { requireScope(request, "read", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.getWorkItemRevision(params.id); });

  app.get(route("/project-revisions/:id/bom"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; await requireRevisionScope(request, service, params.id); const query = request.query as { includeRetired?: unknown }; const includeRetired = query.includeRetired === true || query.includeRetired === "true"; return service.listBomLines(params.id, { includeRetired }); });
  app.post(route("/project-revisions/:id/bom"), async (request, reply) => { requireScope(request, "write", auth); const params = request.params as { id: string }; await requireRevisionScope(request, service, params.id); const mutation = await service.createBomLine(params.id, parseBody(createBomLineSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.patch(route("/bom-lines/:id"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.updateBomLine(params.id, parseBody(updateBomLineSchema, request.body) as never, parseExpectedVersion(request), requestContext(request)); });
  app.delete(route("/bom-lines/:id"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.retireBomLine(params.id, parseRequiredExpectedVersion(request), requestContext(request)); });
  app.post(route("/bom-lines/:id/restore"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.restoreBomLine(params.id, parseRequiredExpectedVersion(request), requestContext(request)); });
  app.get(route("/project-revisions/:id/gaps"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; await requireRevisionScope(request, service, params.id); return service.evaluateBomGaps(params.id); });
  app.get(route("/project-revisions/:id/reservations"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; await requireRevisionScope(request, service, params.id); return service.listReservations(params.id); });
  app.post(route("/project-revisions/:id/reservations"), async (request, reply) => { requireScope(request, "write", auth); const params = request.params as { id: string }; await requireRevisionScope(request, service, params.id); const mutation = await service.createReservation(params.id, parseBody(createReservationSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.get(route("/project-revisions/:id/reconciliation"), async (request) => {
    requireScope(request, "read", auth);
    const params = request.params as { id: string };
    await requireRevisionScope(request, service, params.id);
    return service.getReconciliation(params.id);
  });
  app.put(route("/project-revisions/:id/reconciliation"), async (request) => {
    requireScope(request, "write", auth);
    const params = request.params as { id: string };
    await requireRevisionScope(request, service, params.id);
    const input = parseReconciliationDraftBody(request.body, params.id);
    return service.saveReconciliationDraft(params.id, input, requestContext(request));
  });
  app.post(route("/project-revisions/:id/reconciliation/commit"), async (request) => {
    requireScope(request, "write", auth);
    const params = request.params as { id: string };
    await requireRevisionScope(request, service, params.id);
    const input = parseBody(commitReconciliationSchema, request.body);
    return service.commitReconciliation(params.id, input, requestContext(request));
  });
  app.post(route("/project-revisions/:id/usage"), async (request, reply) => {
    requireScope(request, "write", auth);
    const params = request.params as { id: string };
    const revision = await projectRevisionForRequest(request, service, params.id);
    const input = parseBody(usageInputSchema, request.body);
    if (input.reservationId !== undefined) {
      const details = await service.getReservationDetails(input.reservationId);
      if (details.projectRevisionId !== params.id) {
        throw new ApplicationError("validation", "reservationId must belong to the supplied project revision");
      }
    }
    const mutation = await service.recordUsage({
      projectId: revision.projectId,
      itemId: input.itemId,
      quantity: input.quantity,
      unit: input.unit,
      ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }),
      ...(input.note === undefined ? {} : { note: input.note })
    }, requestContext(request));
    return reply.code(201).send(mutation);
  });
  app.post(route("/reservations/:id/release"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.releaseReservation(params.id, parseExpectedVersion(request), requestContext(request)); });

  app.get(route("/offers"), async (request) => {
    requireScope(request, "read", auth);
    const query = request.query as { itemId?: string; limit?: string; cursor?: string };
    if (request.principal?.projectIds !== undefined && query.itemId === undefined) throw new ApplicationError("forbidden", "A project-scoped token must provide an inventory item when reading global offers");
    return service.listOffers(query.itemId, Number(query.limit ?? 50), query.cursor);
  });
  app.post(route("/offers"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const mutation = await service.createOffer(parseBody(createOfferSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });

  app.get(route("/projects/:id/artifacts"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; requireProjectScope(request, params.id); const query = request.query as { workItemId?: string; revisionId?: string }; return service.listArtifacts(params.id, query.workItemId, query.revisionId); });
  app.post(route("/artifacts/uploads"), async (request, reply) => {
    requireScope(request, "write", auth);
    const input = parseBody(beginArtifactUploadRequestSchema, request.body) as unknown as BeginUploadInput;
    requireProjectScope(request, input.projectId);
    if (input.buildConfigurationSnapshotId !== undefined) {
      await authorizeScopedBuildConfigurationReference(request, service, input.buildConfigurationSnapshotId);
    }
    const mutation = await service.beginArtifactUpload(input, requestContext(request));
    return reply.code(201).send(mutation);
  });
  app.put(route("/artifacts/uploads/:id"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; const body = request.body; if (!(body instanceof Uint8Array)) throw new ApplicationError("validation", "Upload body must be binary"); return service.writeArtifactUpload(params.id, body); });
  app.post(route("/artifacts/uploads/:id/finalize"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.finalizeArtifactUpload(params.id, requestContext(request)); });
  app.put(route("/transfers/uploads/:id"), async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body;
    if (!(body instanceof Uint8Array)) throw new ApplicationError("validation", "Upload body must be binary");
    const token = request.headers[TRANSFER_TOKEN_HEADER];
    artifactTransfer.claimUploadWrite(token, params.id, body);
    let result: { readonly receivedBytes: number };
    try {
      result = await service.writeArtifactUpload(params.id, body);
      artifactTransfer.commitUploadWrite(token, params.id);
    } catch (error: unknown) {
      artifactTransfer.releaseUploadWrite(token, params.id);
      throw error;
    }
    for (const [name, value] of Object.entries(TRANSFER_RESPONSE_HEADERS)) reply.header(name, value);
    return result;
  });
  app.post(route("/transfers/uploads/:id/finalize"), async (request, reply) => {
    const params = request.params as { id: string };
    const body = parseTransferFinalize(request.body);
    const token = request.headers[TRANSFER_TOKEN_HEADER];
    const capability = artifactTransfer.claimFinalize(token, params.id, body);
    let mutation: Mutation<unknown>;
    try {
      mutation = await service.finalizeArtifactUpload(params.id, transferFinalizeContext(request, capability, params.id, body));
    } catch (error: unknown) {
      artifactTransfer.releaseFinalize(token, params.id);
      throw error;
    }
    artifactTransfer.commitFinalize(token, params.id);
    for (const [name, value] of Object.entries(TRANSFER_RESPONSE_HEADERS)) reply.header(name, value);
    return mutation;
  });
  app.get(route("/artifacts/:id"), async (request) => { requireScope(request, "read", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.getArtifact(params.id); });
  app.get(route("/artifacts/:id/download"), async (request, reply) => { requireScope(request, "read", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; const downloaded = await service.readArtifact(params.id); return reply.type(downloaded.artifact.mediaType).header("content-disposition", `attachment; filename="${downloaded.artifact.filename.replace(/"/gu, "")}"`).send(Buffer.from(downloaded.body)); });
  app.get(route("/transfers/artifacts/:id/download"), async (request, reply) => {
    const params = request.params as { id: string };
    const token = request.headers[TRANSFER_TOKEN_HEADER];
    const capability = artifactTransfer.claimDownload(token, params.id);
    let downloaded: Awaited<ReturnType<typeof service.readArtifact>>;
    try {
      downloaded = await service.readArtifact(params.id);
      artifactTransfer.assertDownloadedArtifact(capability, downloaded.artifact);
      artifactTransfer.commitDownload(token, params.id);
    } catch (error: unknown) {
      artifactTransfer.releaseDownload(token, params.id);
      throw error;
    }
    for (const [name, value] of Object.entries(TRANSFER_RESPONSE_HEADERS)) reply.header(name, value);
    const filename = downloaded.artifact.filename.replace(/["\r\n]/gu, "");
    return reply.type(downloaded.artifact.mediaType).header("content-disposition", `attachment; filename="${filename}"`).send(Buffer.from(downloaded.body));
  });
  app.delete(route("/artifacts/:id"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.retireArtifact(params.id, parseExpectedVersion(request), requestContext(request)); });

  app.get(route("/audit"), async (request) => { requireScope(request, "admin", auth); rejectScopedGlobalAccess(request); const query = request.query as { limit?: string; cursor?: string }; return ports.audit.list(Math.min(Math.max(Number(query.limit ?? 50), 1), 200), query.cursor); });
  app.get(route("/events"), async (request, reply) => {
    requireScope(request, "read", auth);
    rejectScopedGlobalAccess(request);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ correlationId: request.correlationId })}\n\n`);
    const unsubscribe = service.subscribe((event) => { if (!reply.raw.destroyed) reply.raw.write(`id: ${event.id}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`); });
    const heartbeat = setInterval(() => { if (reply.raw.destroyed) clearInterval(heartbeat); else reply.raw.write(": heartbeat\n\n"); }, 25_000);
    request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  const webRoot = resolve(options.webRoot ?? defaultWebRoot());
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (request.method === "GET" || request.method === "HEAD") {
      if (!path.startsWith("/api/") && path !== "/mcp") {
        const asset = await serveWebAsset(webRoot, path);
        const fallback = asset ?? (path.includes(".") ? null : await serveWebAsset(webRoot, "/"));
        if (fallback !== null) return reply.type(webContentType(fallback.path)).send(request.method === "HEAD" ? undefined : fallback.body);
      }
    }
    if (path.startsWith("/api/")) return reply.code(404).send({ error: { code: "not_found", message: "Route not found", correlationId: request.correlationId } });
    return reply.code(404).send({ error: { code: "not_found", message: "Route not found", correlationId: request.correlationId } });
  });

  return app;
}

export function bearerRecord(token: string, scopes: readonly AuthScope[], projectIds?: readonly string[], label?: string) {
  return { hash: hashBearerToken(token), scopes: new Set(scopes), ...(projectIds ? { projectIds: new Set(projectIds) } : {}), ...(label === undefined ? {} : { label }) };
}
