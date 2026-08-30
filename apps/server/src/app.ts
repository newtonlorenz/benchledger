import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import {
  beginUploadSchema, createBomLineSchema, createInventoryItemSchema, createOfferSchema,
  createProjectRevisionSchema, createProjectSchema, createReservationSchema,
  createProjectWithInitialRevisionSchema, createWorkItemRevisionSchema, createWorkItemSchema, healthSchema,
  inventoryListQuerySchema, stockEventInputSchema, updateBomLineSchema,
  updateInventoryItemSchema, updateProjectSchema, usageInputSchema,
  createCatalogProductSchema, updateCatalogProductSchema,
  createInventoryProductProfileSchema, createInventoryWithProductProfileSchema, updateInventoryProductProfileSchema,
  createBuildConfigurationSnapshotSchema, saveReconciliationDraftSchema, commitReconciliationSchema
} from "@benchledger/api-contract";
import { ApplicationError, ApplicationService } from "@benchledger/application";
import type { ApplicationPorts, BeginUploadInput, BuildConfigurationListOptions, CatalogProductListOptions, Mutation, Page, ProjectListOptions, RequestContext } from "@benchledger/application";
import { createProductionRuntime } from "@benchledger/runtime";
import { createApplicationMcpProtocol, createMcpHttpHandler } from "@benchledger/mcp";
import type { McpRequestContext, Scope as McpScope } from "@benchledger/mcp";
import type {
  Artifact as ApiArtifact, BomLine as ApiBomLine, InventoryItem as ApiInventoryItem,
  Offer as ApiOffer, Project as ApiProject, ProjectRevision as ApiProjectRevision,
  WorkItem as ApiWorkItem, CatalogProduct as ApiCatalogProduct,
  BuildConfigurationSnapshot as ApiBuildConfigurationSnapshot,
  InventoryProductProfile as ApiInventoryProductProfile
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
}

export interface RuntimeHandle {
  readonly ports: ApplicationPorts;
  readonly close?: () => Promise<void>;
}

const PUBLIC_PATHS = new Set(["/api/v1/health", "/api/v1/ready", "/api/v1/auth/login", "/api/v1/openapi.json", "/api/v1/capabilities"]);
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

function requestContext(request: FastifyRequest): RequestContext {
  const principal = request.principal;
  if (!principal) throw new ApplicationError("forbidden", "Authentication is required");
  const idempotencyKey = requestIdempotencyKey(request);
  const fingerprint = restRequestFingerprint(request);
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
  const clean = header.replace(/^W\//u, "").replace(/^"|"$/gu, "");
  const version = Number.parseInt(clean, 10);
  if (!Number.isInteger(version) || version <= 0) throw new ApplicationError("validation", "If-Match must contain a positive version");
  return version;
}

function parseBody<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: readonly unknown[] } } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApplicationError("validation", "Request body is invalid", { issues: result.error.issues });
  return result.data;
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
  const createInventoryItemSchema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "kind", "quantity", "unit", "tags", "links", "evidence"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      name: { type: "string", minLength: 1, maxLength: 240 },
      kind: { type: "string", enum: ["printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"] },
      description: { type: "string", maxLength: 5000 },
      manufacturer: { type: "string", maxLength: 200 },
      model: { type: "string", maxLength: 200 },
      sku: { type: "string", maxLength: 200 },
      quantity: { type: "number", minimum: 0 },
      availableQuantity: { type: "number", minimum: 0 },
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
  return {
    openapi: "3.1.0",
    info: { title: "BenchLedger API", version, description: "Evidence-based maker inventory and project workspace API." },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    components: {
      securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "Scoped MCP/API token. Store the plaintext token only in the client secret store." },
      cookieAuth: { type: "apiKey", in: "cookie", name: "forge_session" },
      transferAuth: { type: "apiKey", in: "header", name: "X-Bench-Transfer-Token", description: "Short-lived single-purpose artifact capability returned by MCP; never put it in a URL." }
      },
      schemas: {
        CreateInventoryItem: createInventoryItemSchema,
        CreateInventoryProductProfileWithoutItem: createInventoryProductProfileWithoutItemSchema,
        CreateInventoryWithProductProfile: inventoryWithProductProfileSchema
      }
    },
    paths: {
      "/health": { get: { security: [], responses: { "200": { description: "Service health" } } } },
      "/ready": { get: { security: [], responses: { "200": { description: "Readiness checks" }, "503": { description: "Not ready" } } } },
      "/auth/login": { post: { security: [], responses: { "200": { description: "Session created" }, "401": { description: "Invalid credentials" } } } },
      "/workspace": { get: { responses: { "200": { description: "Authenticated aggregate workspace snapshot" } } } },
      "/inventory": { get: { responses: { "200": { description: "Inventory page" } } }, post: { responses: { "201": { description: "Inventory item" } } } },
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
      "/inventory/{id}/product-profile": { get: { responses: { "200": { description: "Physical inventory product profile" }, "404": { description: "Profile not found" } } }, put: { responses: { "200": { description: "Updated physical inventory product profile" } } } },
      "/inventory/{id}/count": { post: { responses: { "201": { description: "Recorded physical count" } } } },
      "/inventory/{id}/stock-events": { get: { responses: { "200": { description: "Stock event page" } } }, post: { responses: { "201": { description: "Stock mutation" } } } },
      "/projects": { get: { responses: { "200": { description: "Project page" } } }, post: { responses: { "201": { description: "Project" } } } },
      "/projects/with-initial-revision": { post: { responses: { "201": { description: "Project and initial revision mutation" } } } },
      "/projects/{id}/revisions": { post: { responses: { "201": { description: "Project revision" } } } },
      "/catalog/products": { get: { responses: { "200": { description: "Bounded exact catalog product page" } } }, post: { responses: { "201": { description: "Catalog product mutation" } } } },
      "/catalog/products/{id}": { get: { responses: { "200": { description: "Exact catalog product" } } }, patch: { responses: { "200": { description: "Updated exact catalog product" } } } },
      "/project-revisions/{id}/bom": { get: { responses: { "200": { description: "BOM lines" } } }, post: { responses: { "201": { description: "BOM line" } } } },
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
      "/mcp": { post: { responses: { "200": { description: "Authenticated MCP JSON-RPC response" } } } },
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
    const [bom, revisionArtifacts] = await Promise.all([
      service.listBomLines(revision.id),
      service.listArtifacts(project.id, undefined, revision.id)
    ]);
    const latestConfiguration = await service.getLatestBuildConfiguration(revision.id);
    const currentRevision = {
      ...revision,
      bom,
      artifacts: revisionArtifacts,
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
  const filtered = projects.filter((project): project is ApiProject => project !== null && (query.status === undefined || project.status === query.status) && (needle === undefined || project.name.toLocaleLowerCase().includes(needle) || project.description?.toLocaleLowerCase().includes(needle) === true));
  const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const selected = filtered.slice(start, start + query.limit);
  const nextCursor = start + selected.length < filtered.length ? String(start + selected.length) : undefined;
  return { data: selected, limit: query.limit, total: filtered.length, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function errorStatus(error: ApplicationError): number {
  switch (error.code) {
    case "not_found": return 404;
    case "conflict": case "idempotency_conflict": case "integrity_error": return 409;
    case "forbidden": return 403;
    case "quota_exceeded": return 413;
    case "unsupported_media": return 415;
    case "upload_expired": return 410;
    case "validation": default: return 400;
  }
}

export async function createApp(options: ServerOptions = {}): Promise<FastifyInstance> {
  const demo = options.demo ?? false;
  const publicBaseUrl = publicBaseUrlFromEnvironment(options.publicBaseUrl ?? process.env.BENCHLEDGER_PUBLIC_BASE_URL, demo);
  const artifactTransfer = new ArtifactTransferManager(publicBaseUrl);
  const runtime: RuntimeHandle | undefined = options.runtime ?? (options.ports ? undefined : demo ? createSyntheticRuntime() : await createProductionRuntime({
    dataDir: options.dataDir ?? process.env.BENCHLEDGER_DATA_DIR ?? "",
    ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
    ...(options.maxStorageBytes === undefined ? {} : { maxStorageBytes: options.maxStorageBytes })
  }));
  const ports = options.ports ?? runtime?.ports;
  if (!ports) throw new Error("createApp requires application ports");
  const service = options.service ?? new ApplicationService(ports, options.version ?? "0.1.0");
  const suppliedBearerTokens = options.auth?.bearerTokens ?? [];
  const adminPasswordHash = options.auth?.adminPasswordHash ?? process.env.BENCHLEDGER_ADMIN_PASSWORD_HASH;
  const authConfig: AuthConfig = {
    sessionSecret: options.auth?.sessionSecret ?? process.env.BENCHLEDGER_SESSION_SECRET ?? (demo ? randomSecret() : ""),
    ...(adminPasswordHash ? { adminPasswordHash } : {}),
    ...(options.auth?.passwordVerifier ? { passwordVerifier: options.auth.passwordVerifier } : {}),
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
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();

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
    if (PUBLIC_PATHS.has(path)) return;
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
    vocabulary: { confirmed: "physically counted or commissioned stock", inspect_first: "recorded stock requiring a physical count", missing: "no confirmed or inspect-first candidate" },
    actions: ["inventory.read", "inventory.write", "catalog.read", "catalog.write", "inventory.product_profile.read", "inventory.product_profile.write", "projects.read", "projects.write", "build_configurations.read", "build_configurations.create", "bom.evaluate", "artifacts.version", "offers.compare", "events.subscribe"],
    approvalBoundaries: ["purchasing", "external publication", "permanent deletion", "credential changes", "printer control"]
  }));
  app.get(route("/openapi.json"), async () => jsonOpenApi(service.getVersion()));
  app.get(route("/docs"), async (_request, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html><title>BenchLedger API</title><p>OpenAPI: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a></p>`));

  app.post(route("/mcp"), async (request, reply) => {
    const principal = requireScope(request, "read", auth);
    const context = mcpContext(principal, request);
    const protocol = createApplicationMcpProtocol(service, { publicBaseUrl, artifactTransfer, context, serverInfo: { name: "benchledger", version: service.getVersion() } });
    const handler = createMcpHttpHandler(protocol, { context, maxBodyBytes: 1_000_000 });
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
    const result = await handler({ method: request.method, headers, body: request.body });
    reply.code(result.status);
    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    return reply.send(result.body);
  });

  app.post(route("/auth/login"), async (request, reply) => {
    const clientKey = request.ip;
    const currentAttempt = loginAttempts.get(clientKey);
    if (currentAttempt && currentAttempt.resetAt > Date.now() && currentAttempt.count >= 5) {
      return reply.code(429).header("retry-after", String(Math.ceil((currentAttempt.resetAt - Date.now()) / 1000))).send({ error: { code: "rate_limited", message: "Too many login attempts; try again later", correlationId: request.correlationId } });
    }
    if (currentAttempt && currentAttempt.resetAt <= Date.now()) loginAttempts.delete(clientKey);
    const body = request.body as { password?: unknown };
    if (typeof body?.password !== "string" || body.password.length > 512 || !(await auth.verifyPassword(body.password))) {
      const previous = loginAttempts.get(clientKey);
      loginAttempts.set(clientKey, { count: (previous?.count ?? 0) + 1, resetAt: previous?.resetAt && previous.resetAt > Date.now() ? previous.resetAt : Date.now() + 15 * 60 * 1000 });
      return reply.code(401).send({ error: { code: "invalid_credentials", message: "Email or password is invalid", correlationId: request.correlationId } });
    }
    loginAttempts.delete(clientKey);
    const session = auth.issueSession(reply);
    return { authenticated: true, actor: "admin", csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString(), correlationId: request.correlationId };
  });
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
  app.get(route("/inventory"), async (request) => { requireScope(request, "read", auth); const query = parseBody(inventoryListQuerySchema, request.query); return service.listInventory(query); });
  app.post(route("/inventory"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const mutation = await service.createInventoryItem(parseBody(createInventoryItemSchema, request.body), requestContext(request)); return reply.code(201).send(mutationBody(mutation)); });
  app.post(route("/inventory/with-product-profile"), async (request, reply) => {
    requireScope(request, "write", auth);
    rejectScopedGlobalAccess(request);
    const mutation = await service.createInventoryWithProductProfile(parseBody(createInventoryWithProductProfileSchema, request.body), requestContext(request));
    return reply.code(201).send(mutationBody(mutation));
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
    const parsed = { ...(query.q === undefined ? {} : { q: query.q }), ...(query.status === undefined ? {} : { status: query.status }), limit: Math.min(Math.max(Number(query.limit ?? 50), 1), 200), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) } satisfies ProjectListOptions;
    return request.principal?.projectIds === undefined ? service.listProjects(parsed) : scopedProjectPage(service, parsed, request.principal.projectIds);
  });
  app.post(route("/projects"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const mutation = await service.createProject(parseBody(createProjectSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.post(route("/projects/with-initial-revision"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const mutation = await service.createProjectWithInitialRevision(parseBody(createProjectWithInitialRevisionSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.get(route("/projects/:id"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; requireProjectScope(request, params.id); const project = await service.getProject(params.id); return { project, workItems: await service.listWorkItems(params.id) }; });
  app.patch(route("/projects/:id"), async (request) => { requireScope(request, "write", auth); const params = request.params as { id: string }; requireProjectScope(request, params.id); return service.updateProject(params.id, parseBody(updateProjectSchema, request.body) as never, parseExpectedVersion(request), requestContext(request)); });
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

  app.get(route("/project-revisions/:id/bom"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; await requireRevisionScope(request, service, params.id); return service.listBomLines(params.id); });
  app.post(route("/project-revisions/:id/bom"), async (request, reply) => { requireScope(request, "write", auth); const params = request.params as { id: string }; await requireRevisionScope(request, service, params.id); const mutation = await service.createBomLine(params.id, parseBody(createBomLineSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.patch(route("/bom-lines/:id"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.updateBomLine(params.id, parseBody(updateBomLineSchema, request.body) as never, parseExpectedVersion(request), requestContext(request)); });
  app.delete(route("/bom-lines/:id"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.retireBomLine(params.id, parseExpectedVersion(request), requestContext(request)); });
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
    const capability = artifactTransfer.authorizeDownload(request.headers[TRANSFER_TOKEN_HEADER], params.id);
    const downloaded = await service.readArtifact(params.id);
    artifactTransfer.assertDownloadedArtifact(capability, downloaded.artifact);
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
