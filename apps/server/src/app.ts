import { registerInventoryImageRoutes } from "./inventory-image-routes.js";
import { INVENTORY_IMAGE_MAX_BYTES, memberLoginSchema } from "@benchledger/api-contract";
import type { TeamMember } from "@benchledger/api-contract";
import { registerMakerWorkflowRoutes } from "./maker-workflow-routes.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import Fastify, { type FastifyHttpOptions, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Server as HttpServer } from "node:http";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import {
  beginUploadSchema, artifactListQuerySchema, commissionInventoryItemSchema, createBomLineSchema, createInventoryCategorySchema, createInventoryItemSchema, createOfferSchema,
  createProjectRevisionSchema, createProjectSchema, createReservationSchema,
  createProjectWithInitialRevisionSchema, createWorkItemRevisionSchema, createWorkItemSchema, healthSchema,
  inventoryBulkUpdateSchema, inventoryCategoryListQuerySchema, inventoryListQuerySchema, stockEventInputSchema, updateBomLineSchema,
  updateInventoryCategorySchema, updateInventoryItemSchema, updateProjectSchema, updateProjectRevisionSchema, usageInputSchema,
  createCatalogProductSchema, updateCatalogProductSchema,
  createInventoryProductProfileSchema, createInventoryWithProductProfileSchema, updateInventoryProductProfileSchema,
  createBuildConfigurationSnapshotSchema, saveReconciliationDraftSchema, commitReconciliationSchema,
  workspaceSecurityMutationSchema, projectStatusSchema,
  removeProjectSchema, projectSetupProposalSchema, commitProjectSetupSchema, commitProjectSetupBodySchema,
  inspectionObservationSchema, commitInspectionCompletionBodySchema,
  updateWorkspacePreferencesSchema, stockReceivingPolicyImpactQuerySchema
} from "@benchledger/api-contract";
import { ApplicationError, ApplicationService } from "@benchledger/application";
import type { ApplicationPorts, BuildConfigurationListOptions, CatalogProductListOptions, GapEvaluation, Mutation, Page, ProjectListOptions, RequestContext } from "@benchledger/application";
import { createDemoRuntime, createProductionRuntime } from "@benchledger/runtime";
import { createApplicationMcpProtocol, createMcpHttpHandler } from "@benchledger/mcp";
import type { McpRequestContext, Scope as McpScope } from "@benchledger/mcp";
import type {
  Artifact as ApiArtifact, BomLine as ApiBomLine, InventoryItem as ApiInventoryItem,
  Offer as ApiOffer, Project as ApiProject, ProjectRevision as ApiProjectRevision,
  WorkItem as ApiWorkItem, CatalogProduct as ApiCatalogProduct,
  BuildConfigurationSnapshot as ApiBuildConfigurationSnapshot,
  InventoryProductProfile as ApiInventoryProductProfile,
  WorkspaceSecurityStatus as ApiWorkspaceSecurityStatus,
  WorkspaceSecurityMutation, WorkspacePreferences as ApiWorkspacePreferences
} from "@benchledger/api-contract";
import { AuthManager, assertStrongSessionSecret, type AuthConfig, type AuthScope, type Principal, hashBearerToken } from "./auth.js";
import { ArtifactTransferManager, TRANSFER_RESPONSE_HEADERS, TRANSFER_TOKEN_HEADER, type FinalizeCapabilityBody, type TransferCapability } from "./artifact-transfer.js";
import { positiveIntegerFromEnvironment, publicBaseUrlFromEnvironment } from "./config.js";
import { jsonOpenApi } from "./openapi.js";

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
  /** Explicit opt-in while named-account UI and rollout are under evaluation. */
  readonly teamAccessPreview?: boolean;
  readonly dataDir?: string;
  readonly maxUploadBytes?: number;
  readonly maxStorageBytes?: number;
  readonly webRoot?: string;
  readonly version?: string;
  readonly logger?: boolean;
  /**
   * Fastify trust-proxy setting. Default off: X-Forwarded-For is ignored.
   * Prefer a hop count or explicit proxy addresses over `true`.
   */
  readonly trustProxy?: boolean | number | string | readonly string[];
  /**
   * Extra Host names accepted besides the public base URL host and loopback
   * names. Requests with any other Host are rejected (DNS-rebinding defence).
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Fixed delay added to every login attempt (correct or not) while the
   * workspace-wide failed-login ceiling is exceeded. Defaults to one second.
   */
  readonly loginSlowdownMs?: number;
  /** Exact configured origin used for MCP transfer capability links. */
  readonly publicBaseUrl?: string;
  /** Host-owned transfer manager; injectable for route-level integration tests. */
  readonly artifactTransferManager?: ArtifactTransferManager;
}

export interface RuntimeHandle {
  readonly ports: ApplicationPorts;
  readonly close?: () => Promise<void>;
}

const PUBLIC_PATHS = new Set(["/api/v1/health", "/api/v1/ready", "/api/v1/auth/login", "/api/v1/auth/member-login", "/api/v1/auth/access", "/api/v1/auth/lan-session", "/api/v1/openapi.json", "/api/v1/capabilities"]);
const UUID_OR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
/** Default request body ceiling for JSON and other non-upload routes. */
const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
/**
 * The largest MCP payload is add_inventory_image: INVENTORY_IMAGE_MAX_BYTES
 * raw bytes, base64-encoded (4/3 expansion) inside a JSON-RPC envelope with
 * item/image metadata. Other MCP tools stay under the 1 MB general limit.
 */
const MCP_ENVELOPE_ALLOWANCE = 64 * 1024;
const MCP_BODY_LIMIT = Math.ceil(INVENTORY_IMAGE_MAX_BYTES / 3) * 4 + MCP_ENVELOPE_ALLOWANCE;
/** Unauthenticated credential endpoints never need more than a few KiB. */
const AUTH_BODY_LIMIT = 16 * 1024;
const DEFAULT_UPLOAD_BODY_LIMIT = 100 * 1024 * 1024;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";
/**
 * The built SPA loads only same-origin module scripts and stylesheets. Inline
 * style attributes remain allowed for React/three.js layout; blob:/data: cover
 * local previews and embedded GLB/texture resources decoded in the browser.
 */
const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

/**
 * Media types an artifact may be served as. Anything else (HTML, SVG, XML,
 * scripts) is forced to application/octet-stream so a stored file can never
 * execute in the application origin, even if a browser ignores the
 * attachment disposition.
 */
const SAFE_ARTIFACT_MEDIA_TYPES = new Set([
  "application/octet-stream", "application/pdf", "application/zip", "application/json",
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "model/step", "model/stl", "model/gltf-binary", "model/3mf", "application/vnd.ms-package.3dmanufacturing-3mf",
  "text/plain", "text/markdown", "text/csv"
]);

export function artifactResponseType(mediaType: string): string {
  if (typeof mediaType !== "string" || /[\u0000-\u001f\u007f]/u.test(mediaType)) return "application/octet-stream";
  const essence = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (!SAFE_ARTIFACT_MEDIA_TYPES.has(essence)) return "application/octet-stream";
  return essence.startsWith("text/") ? `${essence}; charset=utf-8` : essence;
}

function hostName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end < 0 ? undefined : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  return colon < 0 ? host : host.slice(0, colon);
}

class PreconditionRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreconditionRequiredError";
  }
}

/** Require If-Match on routes where first-party clients always send it. */
function parseMandatoryIfMatch(request: FastifyRequest): number {
  const version = parseExpectedVersion(request);
  if (version === undefined) throw new PreconditionRequiredError("If-Match with the current version is required; reload the record and retry with its version");
  return version;
}

const PAGE_LIMIT_PATTERN = /^[1-9][0-9]{0,2}$/u;

/** Strictly parse limit/cursor query parameters shared by paged REST routes. */
function parsePageQuery(query: unknown, defaultLimit = 50): { readonly limit: number; readonly cursor?: string } {
  const record = query !== null && typeof query === "object" ? query as Record<string, unknown> : {};
  const issues: { path: string[]; message: string }[] = [];
  let limit = defaultLimit;
  if (record.limit !== undefined) {
    const raw = record.limit;
    if (typeof raw !== "string" || !PAGE_LIMIT_PATTERN.test(raw) || Number(raw) > 200) issues.push({ path: ["limit"], message: "limit must be an integer between 1 and 200" });
    else limit = Number(raw);
  }
  let cursor: string | undefined;
  if (record.cursor !== undefined) {
    const raw = record.cursor;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 512 || /[\u0000-\u001f\u007f]/u.test(raw)) issues.push({ path: ["cursor"], message: "cursor must be a non-empty opaque string of at most 512 characters" });
    else cursor = raw;
  }
  if (issues.length > 0) throw new ApplicationError("validation", "Query parameters are invalid", { issues });
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
}

function zodIssues(error: unknown): readonly ValidationIssue[] | null {
  if (!(error instanceof Error) || error.name !== "ZodError") return null;
  const issues = (error as Error & { readonly issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  return issues.map((issue: { path?: unknown; message?: unknown; code?: unknown }) => ({
    path: Array.isArray(issue.path) ? issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number") : [],
    message: typeof issue.message === "string" ? issue.message : "Invalid value",
    ...(typeof issue.code === "string" ? { code: issue.code } : {})
  }));
}

type ValidationIssue = { readonly path: readonly (string | number)[]; readonly message: string; readonly code?: string };

/** Validate a server-built response; a mismatch is a logged 500, never a client 400. */
function shapeResponse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const error = new Error(`Server response failed its schema: ${JSON.stringify(zodIssues(result.error) ?? [])}`);
  error.name = "ResponseShapeError";
  throw error;
}

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
const GLOBAL_LOGIN_FAILURE_LIMIT = 50;
const DEFAULT_LOGIN_SLOWDOWN_MS = 1000;

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

/**
 * Optional optimistic version for stock commands: If-Match and/or body
 * `expectedVersion`. When both are present they must agree. Absent means the
 * legacy unconditional behaviour.
 */
function optionalStockVersion(request: FastifyRequest, body: unknown): number | undefined {
  const header = parseExpectedVersion(request);
  const raw = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).expectedVersion : undefined;
  if (raw !== undefined && (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1)) throw new ApplicationError("validation", "expectedVersion must be a positive integer");
  if (header !== undefined && raw !== undefined && header !== raw) throw new ApplicationError("validation", "If-Match and expectedVersion must agree");
  return raw ?? header;
}

function withoutExpectedVersion(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
  const { expectedVersion: _expectedVersion, ...rest } = body as Record<string, unknown>;
  return rest;
}

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

async function requireBomReferenceScope(request: FastifyRequest, service: ApplicationService, id: string): Promise<void> {
  if (request.principal?.projectIds === undefined) return;
  try {
    const line = await service.getBomLine(id);
    await requireRevisionScope(request, service, line.revisionId);
  } catch (error) {
    if (error instanceof ApplicationError && ["not_found", "forbidden"].includes(error.code)) {
      throw new ApplicationError("forbidden", "The current token is not allowed to address this requirement");
    }
    throw error;
  }
}

async function requireArtifactReferenceScope(request: FastifyRequest, service: ApplicationService, id: string, upload = false): Promise<void> {
  if (request.principal?.projectIds === undefined) return;
  try {
    const record = upload ? await service.getUploadSessionDetails(id) : await service.getArtifact(id);
    requireProjectScope(request, record.projectId);
  } catch {
    // Do not disclose existence or state of indirect IDs outside the allow-list.
    throw new ApplicationError("forbidden", "Artifact reference is not available to this token");
  }
}

function mutationBody<T>(mutation: Mutation<T>): Mutation<T> {
  return mutation;
}

function artifactContentDisposition(filename: string): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/gu, "_") || "artifact";
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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
  readonly capabilities: readonly string[];
  /** Interpretation preferences that label availability (for example the stock receiving policy). */
  readonly preferences: ApiWorkspacePreferences;
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

async function workspaceSnapshot(service: ApplicationService, projectIds?: ReadonlySet<string>): Promise<WorkspaceSnapshot> {
  const [inventory, projects, offers, preferences] = await Promise.all([
    service.listInventory({ limit: 200 }),
    projectIds === undefined ? service.listProjects({ limit: 200 }) : scopedProjectPage(service, { limit: 200 }, projectIds),
    service.listOffers(undefined, 200),
    service.getWorkspacePreferences()
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
      service.listArtifacts(project.id, { projectRevisionId: revision.id }),
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
    capabilities: [...(service.assemblies.supports() ? ["assembly.read", "assembly.write"] : []), ...(service.inventoryImages.supports() ? ["inventory.images.read", "inventory.images.write"] : []), ...(service.supportsReconciliation() ? ["reconciliation.read", "reconciliation.write"] : []), ...(service.makerWorkflows.supports() ? ["maker_workflows.read", "maker_workflows.write"] : [])],
    preferences,
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
  // `internal` may be introduced by the application layer for unknown
  // failures; compare as a string so this host compiles either way.
  if ((error.code as string) === "internal") return 500;
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
  const environmentSessionSecret = options.auth?.sessionSecret === undefined ? process.env.BENCHLEDGER_SESSION_SECRET : undefined;
  // Operator-supplied secrets are checked strictly at startup so the
  // documented placeholder or a trivially guessable value never signs sessions.
  if (environmentSessionSecret !== undefined) assertStrongSessionSecret(environmentSessionSecret, "BENCHLEDGER_SESSION_SECRET");
  const sessionSecret = options.auth?.sessionSecret ?? environmentSessionSecret ?? (demo ? randomSecret() : "");
  const publicBaseUrl = publicBaseUrlFromEnvironment(options.publicBaseUrl ?? process.env.BENCHLEDGER_PUBLIC_BASE_URL, demo);
  const publicOrigin = new URL(publicBaseUrl);
  const allowedHosts = new Set<string>([publicOrigin.hostname.toLowerCase(), ...LOOPBACK_HOSTS, ...(options.allowedHosts ?? []).map((host) => host.toLowerCase())]);
  const uploadBodyLimit = options.maxUploadBytes ?? positiveIntegerFromEnvironment(process.env, "BENCHLEDGER_MAX_UPLOAD_BYTES") ?? DEFAULT_UPLOAD_BODY_LIMIT;
  const artifactTransfer = options.artifactTransferManager ?? new ArtifactTransferManager(publicBaseUrl);
  let activePasswordHashes = 0;
  // Demo mode runs the real SQLite runtime on a disposable in-memory
  // database and temporary artifact directory, seeded with synthetic data.
  const runtime: RuntimeHandle | undefined = options.runtime ?? (options.ports ? undefined : demo ? await createDemoRuntime({
    ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
    ...(options.maxStorageBytes === undefined ? {} : { maxStorageBytes: options.maxStorageBytes })
  }) : await createProductionRuntime({
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
  let teamState = await service.team.sessionState();
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
    sharedSessionsAllowed: () => !teamState.enabled,
    memberSession: (id, version) => {
      const member = teamState.members.find((entry) => entry.id === id);
      if (!teamState.enabled || !member?.enabled || member.version !== version) return null;
      return { actor: `member:${member.id}`, source: "ui", via: "session", memberId: member.id, memberVersion: member.version, scopes: new Set<AuthScope>(member.role === "admin" ? ["read", "write", "admin"] : member.role === "editor" ? ["read", "write"] : ["read"]), ...(member.projectIds === undefined ? {} : { projectIds: new Set(member.projectIds) }) };
    },
    ...(demo ? { demo: true, demoPassword: options.auth?.demoPassword ?? process.env.BENCHLEDGER_DEMO_PASSWORD ?? "demo-password-please-change" } : {}),
    ...(suppliedBearerTokens.length > 0 ? { bearerTokens: suppliedBearerTokens } : {}),
    // Secure cookies by default whenever the public origin is HTTPS.
    secureCookies: options.auth?.secureCookies ?? publicOrigin.protocol === "https:",
    sessionTtlSeconds: options.auth?.sessionTtlSeconds ?? 8 * 60 * 60
  };
  const auth = new AuthManager(authConfig);
  // A hop count trusts only the nearest N proxies (the right-most forwarded
  // addresses), so a client-supplied X-Forwarded-For prefix is never used.
  const configuredTrustProxy = options.trustProxy;
  const trustProxy: FastifyHttpOptions<HttpServer>["trustProxy"] = configuredTrustProxy === undefined ? false
    : typeof configuredTrustProxy === "number" ? (_address: string, hop: number) => hop < configuredTrustProxy
    : typeof configuredTrustProxy === "boolean" || typeof configuredTrustProxy === "string" ? configuredTrustProxy
    : [...configuredTrustProxy];
  const serverOptions: FastifyHttpOptions<HttpServer> = { logger: options.logger ?? false, trustProxy, bodyLimit: DEFAULT_BODY_LIMIT };
  const app = Fastify(serverOptions);
  if (runtime?.close !== undefined) app.addHook("onClose", async () => runtime.close?.());
  await app.register(cookie);
  await app.register(swagger, { openapi: jsonOpenApi(service.getVersion()) });
  for (const contentType of ["application/octet-stream", "application/pdf", "image/jpeg", "image/png", "image/webp", "model/step", "model/stl", "model/gltf-binary", "application/vnd.ms-package.3dmanufacturing-3mf", "text/plain"]) {
    app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  }
  app.decorateRequest("principal", undefined as unknown as Principal);
  app.decorateRequest("correlationId", "");
  // One budget covers login and current-password reauthentication attempts so
  // an attacker cannot bypass the limit by alternating the two endpoints.
  const passwordAttempts = new Map<string, AttemptWindow>();
  const passwordHashAttempts = new Map<string, AttemptWindow>();
  // Workspace-wide ceiling on failed logins, independent of client address.
  // Exceeding it never blocks a login (that would let anyone lock out every
  // user with a burst of wrong guesses); instead every attempt is delayed and
  // still verified, which bounds guessing throughput from rotating addresses.
  // Counters live in memory and are cleared by a restart.
  const globalLoginFailures = new Map<string, AttemptWindow>();
  const GLOBAL_LOGIN_KEY = "*";
  const loginSlowdownMs = Math.max(0, options.loginSlowdownMs ?? DEFAULT_LOGIN_SLOWDOWN_MS);
  let activePasswordVerifications = 0;

  const rateLimitWindow = (attempts: Map<string, AttemptWindow>, key: string, label: string, limit = AUTH_ATTEMPT_LIMIT): void => {
    const current = attempts.get(key);
    const now = Date.now();
    if (current?.resetAt !== undefined && current.resetAt > now && current.count >= limit) {
      throw new WorkspaceSecurityRateLimitError(`Too many ${label} attempts; try again later`, Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
    }
    if (current !== undefined && current.resetAt <= now) attempts.delete(key);
  };

  const recordFailedAttempt = (attempts: Map<string, AttemptWindow>, key: string): void => {
    const current = attempts.get(key);
    const now = Date.now();
    attempts.set(key, { count: (current?.resetAt !== undefined && current.resetAt > now ? current.count : 0) + 1, resetAt: current?.resetAt !== undefined && current.resetAt > now ? current.resetAt : now + AUTH_ATTEMPT_WINDOW_MS });
  };

  const checkLoginBudget = async (clientKey: string): Promise<void> => {
    rateLimitWindow(passwordAttempts, clientKey, "login");
    const global = globalLoginFailures.get(GLOBAL_LOGIN_KEY);
    const now = Date.now();
    if (global !== undefined && global.resetAt <= now) globalLoginFailures.delete(GLOBAL_LOGIN_KEY);
    else if (global !== undefined && global.count >= GLOBAL_LOGIN_FAILURE_LIMIT && loginSlowdownMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, loginSlowdownMs));
    }
  };
  const recordLoginFailure = (clientKey: string): void => {
    recordFailedAttempt(passwordAttempts, clientKey);
    recordFailedAttempt(globalLoginFailures, GLOBAL_LOGIN_KEY);
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

  /**
   * Browser requests carry Origin (and Sec-Fetch-Site). Accept a missing
   * Origin for non-browser clients, but reject any browser request whose
   * Origin is neither the configured public origin nor this request's Host.
   */
  const sameOriginRequest = (request: FastifyRequest): boolean => {
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") return false;
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    if (origin === publicOrigin.origin) return true;
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return false; }
    if (parsed.origin === "null" || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return false;
    return parsed.host.toLowerCase() === (request.headers.host ?? "").trim().toLowerCase();
  };

  app.addHook("onRequest", async (request, reply) => {
    const correlationId = validCorrelation(Array.isArray(request.headers["x-correlation-id"]) ? request.headers["x-correlation-id"][0] : request.headers["x-correlation-id"]);
    request.correlationId = correlationId;
    reply.header("x-correlation-id", correlationId);
    // DNS-rebinding defence: a browser tricked into resolving another name to
    // this server still sends that name in Host. Only the configured public
    // host, explicit extra hosts and loopback names are served.
    const host = hostName(request.headers.host);
    if (host === undefined || !allowedHosts.has(host)) {
      await reply.code(421).send({ error: { code: "host_not_allowed", message: "This Host is not configured for BenchLedger. Use the configured public address or add it to BENCHLEDGER_ALLOWED_HOSTS.", correlationId } });
      return reply;
    }
    const contentLength = Number(request.headers["content-length"] ?? 0);
    const path = request.url.split("?")[0] ?? request.url;
    const bodyLimit = request.routeOptions.bodyLimit ?? DEFAULT_BODY_LIMIT;
    if (Number.isFinite(contentLength) && contentLength > bodyLimit) {
      await reply.code(413).send({ error: { code: "quota_exceeded", message: "Request body is too large", correlationId } });
      return reply;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.authorization === undefined && !sameOriginRequest(request)) {
      await reply.code(403).send({ error: { code: "forbidden", message: "Cross-origin requests are not allowed", correlationId } });
      return reply;
    }
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
    if (!request.url.startsWith("/api/v1")) return;
    teamState = await service.team.sessionState();
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
    const correlationId = request.correlationId;
    if (error instanceof ApplicationError) {
      const applicationError = error as ApplicationError;
      const status = errorStatus(applicationError);
      if (status >= 500) {
        request.log.error({ err: error, code: applicationError.code, correlationId }, "request failed");
        return reply.code(status).send({ error: { code: "internal", message: "An unexpected server error occurred", correlationId } });
      }
      request.log.info({ code: applicationError.code, status, correlationId }, "request rejected");
      return reply.code(status).send({ error: { code: applicationError.code, message: applicationError.message, ...(applicationError.details ? { details: applicationError.details } : {}), correlationId } });
    }
    if (error instanceof PreconditionRequiredError) {
      request.log.info({ code: "precondition_required", status: 428, correlationId }, "request rejected");
      return reply.code(428).send({ error: { code: "precondition_required", message: error.message, correlationId } });
    }
    const securityError = workspaceSecurityError(error);
    if (securityError !== null) {
      request.log.info({ code: securityError.code, status: securityError.status, correlationId }, "request rejected");
      if (securityError.retryAfterSeconds !== undefined) reply.header("retry-after", String(securityError.retryAfterSeconds));
      return reply.code(securityError.status).send({ error: { code: securityError.code, message: securityError.message, ...(securityError.details ? { details: securityError.details } : {}), correlationId } });
    }
    // HTTP-layer request parsing (parseBody, query/If-Match parsers) raises
    // ApplicationError "validation". The application layer still parses its
    // command input with Zod, so a raw ZodError reaching here is reported as
    // client validation; values the HTTP layer builds itself are checked with
    // shapeResponse, whose failure is a logged 500 instead.
    const issues = zodIssues(error);
    if (issues !== null) {
      request.log.info({ code: "validation", status: 400, correlationId }, "request rejected");
      return reply.code(400).send({ error: { code: "validation", message: "Request is invalid", details: { issues }, correlationId } });
    }
    if (error && typeof error === "object" && "validation" in error) {
      return reply.code(400).send({ error: { code: "validation", message: "Request is invalid", correlationId } });
    }
    // Fastify framework errors (body too large, bad JSON, unsupported media)
    // carry a 4xx status; report them as such rather than as server faults.
    const frameworkStatus = error instanceof Error && typeof (error as Error & { statusCode?: unknown }).statusCode === "number" && typeof (error as Error & { code?: unknown }).code === "string" && String((error as Error & { code?: unknown }).code).startsWith("FST_")
      ? (error as Error & { statusCode: number }).statusCode : undefined;
    if (frameworkStatus !== undefined && frameworkStatus >= 400 && frameworkStatus < 500) {
      const code = frameworkStatus === 413 ? "quota_exceeded" : frameworkStatus === 415 ? "unsupported_media" : "validation";
      const message = frameworkStatus === 413 ? "Request body is too large" : frameworkStatus === 415 ? "Unsupported request media type" : "Request is invalid";
      request.log.info({ code, status: frameworkStatus, correlationId }, "request rejected");
      return reply.code(frameworkStatus).send({ error: { code, message, correlationId } });
    }
    request.log.error({ err: error, correlationId: request.correlationId }, "request failed");
    return reply.code(500).send({ error: { code: "internal", message: "An unexpected server error occurred", correlationId: request.correlationId } });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    if (!reply.hasHeader("content-security-policy")) {
      const path = request.url.split("?", 1)[0] ?? request.url;
      const contentType = String(reply.getHeader("content-type") ?? "");
      reply.header("content-security-policy", !path.startsWith("/api/") && contentType.startsWith("text/html") ? SPA_CSP : API_CSP);
    }
    return payload;
  });

  const route = (path: string) => `/api/v1${path}`;
  registerInventoryImageRoutes(app, service, {
    check: (request, write) => { requireScope(request, write ? "write" : "read", auth); rejectScopedGlobalAccess(request); },
    context: requestContext
  });
  registerMakerWorkflowRoutes(app, service, {
    check: (request, write) => { requireScope(request, write ? "write" : "read", auth); requireProjectScope(request, (request.params as { projectId: string }).projectId); },
    context: requestContext
  });
  app.get(route("/health"), async () => {
    const result = await service.health();
    const { checks: _checks, ...health } = result;
    return shapeResponse(healthSchema, { ...health, demo });
  });
  app.get(route("/ready"), async (request, reply) => {
    const result = await service.health();
    const ready = result.status === "ok";
    // Internal dependency checks are diagnostic detail for operators only.
    const { checks: _checks, ...summary } = result;
    const body = auth.authenticate(request) === null ? { ...summary, demo } : { ...result, demo };
    if (!ready) return reply.code(503).send(body);
    return body;
  });
  app.get(route("/capabilities"), async () => ({
    name: "BenchLedger", version: service.getVersion(), protocol: "rest-v1", demo,
    authentication: { accessModes: ["lan_open", "password"], access: "/api/v1/auth/access", explicitLanSession: "/api/v1/auth/lan-session", bearerRequiredForMcp: true },
    vocabulary: { confirmed: "physically counted or commissioned stock", assumed: "delivered or ordered stock that counts as in stock only because the workspace stock receiving policy trusts it; evidence is unchanged", inspect_first: "recorded stock requiring a physical count", ordered: "ordered stock not yet counted as in stock", missing: "no confirmed or inspect-first candidate" },
    stockReceivingPolicy: { policies: ["on_purchase", "on_delivery", "on_receipt"], default: "on_receipt", read: "/api/v1/workspace/preferences", impact: "/api/v1/workspace/preferences/stock-receiving-impact", change: "human workspace administrator browser session only" },
    actions: [...(service.assemblies.supports() ? ["assembly.read", "assembly.write"] : []), ...(service.inventoryImages.supports() ? ["inventory.images.read", "inventory.images.write"] : []), "inventory.read", "inventory.write", "workspace.preferences.read", "inventory.categories.read", "inventory.categories.write", "catalog.read", "catalog.write", "inventory.product_profile.read", "inventory.product_profile.write", "projects.read", "projects.write", "projects.remove", "projects.removed_history", "build_configurations.read", "build_configurations.create", "bom.evaluate", "artifacts.version", "offers.compare", "events.subscribe", ...(service.makerWorkflows.supports() ? ["project_setup.guided", "requirement_offers.read", "requirement_offers.write", "build_plan.read", "build_plan.write", "workstreams.read", "workstreams.write", "bom.import"] : []), ...(service.supportsReconciliation() ? ["reconciliation.read", "reconciliation.write"] : [])],
    approvalBoundaries: ["purchasing", "external publication", "permanent deletion", "credential changes", "printer control"]
  }));
  app.get(route("/openapi.json"), async () => jsonOpenApi(service.getVersion()));
  app.get(route("/docs"), async (_request, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html><title>BenchLedger API</title><p>OpenAPI: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a></p>`));

  app.get(route("/auth/access"), async () => { const access = await readWorkspaceSecurity(); return teamState.enabled ? { ...access, mode: "password", passwordConfigured: true, teamEnabled: true } : access; });
  app.post(route("/auth/lan-session"), { bodyLimit: AUTH_BODY_LIMIT }, async (_request, reply) => {
    const access = await readWorkspaceSecurity();
    if (teamState.enabled) throw new ApplicationError("forbidden", "Sign in with a named account. Shared LAN sessions are disabled.");
    if (access.mode !== "lan_open") return reply.code(403).send({ error: { code: "password_required", message: "Workspace password protection is enabled", correlationId: _request.correlationId } });
    const session = auth.issueSession(reply);
    return { ...access, authenticated: true, actor: "workspace-admin", csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString(), credentialRevision: session.credentialRevision, correlationId: _request.correlationId };
  });

  app.route({ method: ["POST", "GET", "DELETE"], url: route("/mcp"), bodyLimit: MCP_BODY_LIMIT, handler: async (request, reply) => {
    const principal = requireScope(request, "read", auth);
    if (principal.via !== "bearer") {
      return reply.code(401).send({ error: { code: "unauthenticated", message: "A scoped bearer token is required for MCP", correlationId: request.correlationId } });
    }
    if (request.headers.origin !== undefined && request.headers.origin !== new URL(publicBaseUrl).origin) {
      return reply.code(403).send({ error: { code: "forbidden", message: "MCP origin is not allowed" } });
    }
    const context = mcpContext(principal, request);
    // Generic MCP has no model-excluded channel for live transfer URLs or
    // bearer headers. The HTTP host keeps direct browser/transfer routes
    // private; MCP artifact transfer remains fail-closed until a transactional
    // trusted-host bridge is implemented.
    const protocol = createApplicationMcpProtocol(service, { context, serverInfo: { name: "benchledger", version: service.getVersion() } });
    const handler = createMcpHttpHandler(protocol, { context, maxBodyBytes: 1_000_000, maxInventoryImageBodyBytes: MCP_BODY_LIMIT });
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
    const result = await handler({ method: request.method, headers, body: request.body });
    reply.code(result.status);
    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    return reply.send(result.body);
  } });

  app.post(route("/auth/login"), { bodyLimit: AUTH_BODY_LIMIT }, async (request, reply) => {
    const clientKey = request.ip;
    await checkLoginBudget(clientKey);
    const body = request.body as { password?: unknown };
    const valid = await verifyPasswordWithThrottle(async () => {
      const access = await readWorkspaceSecurity();
      return !teamState.enabled && access.mode === "password" && typeof body?.password === "string" && body.password.length >= 12 && body.password.length <= 512
        && await auth.verifyPassword(body.password as string);
    }, "login verification");
    if (!valid) {
      recordLoginFailure(clientKey);
      return reply.code(401).send({ error: { code: "invalid_credentials", message: "Email or password is invalid", correlationId: request.correlationId } });
    }
    passwordAttempts.delete(clientKey);
    const session = auth.issueSession(reply);
    return { authenticated: true, actor: "workspace-admin", csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString(), credentialRevision: session.credentialRevision, correlationId: request.correlationId };
  });
  app.post(route("/auth/member-login"), { bodyLimit: AUTH_BODY_LIMIT }, async (request, reply) => {
    const key = request.ip; await checkLoginBudget(key);
    const body = memberLoginSchema.safeParse(request.body); let member: TeamMember | null = null;
    const valid = await verifyPasswordWithThrottle(async () => { member = await service.team.verifyMember(body.success ? body.data.username : "invalid-member", body.success ? body.data.password : "invalid-password"); return member !== null; }, "login verification");
    if (!valid || !member) { recordLoginFailure(key); return reply.code(401).send({ error: { code: "invalid_credentials", message: "Username or password is invalid", correlationId: request.correlationId } }); }
    passwordAttempts.delete(key); const verified = member as TeamMember; const session = auth.issueSession(reply, `member:${verified.id}`, verified);
    return { authenticated: true, actor: `member:${verified.id}`, csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() };
  });
  const adminSession = (request: FastifyRequest) => { const principal = requireScope(request, "admin", auth); if (principal.via !== "session" || principal.projectIds !== undefined) throw new ApplicationError("forbidden", "A workspace administrator browser session is required."); return principal; };
  app.get(route("/team/directory"), async (request) => { const principal = requireScope(request, "read", auth); return service.team.directory(principal.projectIds ? [...principal.projectIds] : undefined); });
  app.get(route("/team/members"), async (request) => { adminSession(request); return service.team.adminDirectory(requestContext(request)); });
  app.post(route("/team/enable"), async (request, reply) => {
    adminSession(request);
    if (!(options.teamAccessPreview ?? process.env.BENCHLEDGER_TEAM_ACCESS_PREVIEW === "true")) throw new ApplicationError("forbidden", "Named-account switching is disabled for this release. Existing workspace access is unchanged.");
    const current = await readWorkspaceSecurity(); const body = request.body as { currentPassword?: unknown };
    const result = await runPasswordHashMutation(request.ip, async () => { if (current.mode === "password" && (typeof body?.currentPassword !== "string" || !await auth.verifyPassword(body.currentPassword))) throw new ApplicationError("forbidden", "Verify the current workspace password before switching to named accounts."); return service.team.enable(request.body, requestContext(request)); });
    auth.clearSession(reply); return result;
  });
  app.post(route("/team/members"), async (request) => { adminSession(request); return runPasswordHashMutation(request.ip, () => service.team.create(request.body, requestContext(request))); });
  app.patch(route("/team/members/:id"), async (request) => { adminSession(request); return runPasswordHashMutation(request.ip, () => service.team.update((request.params as { id: string }).id, request.body, requestContext(request))); });
  app.post(route("/team/members/:id/password"), async (request, reply) => {
    const principal = requirePrincipal(request); if (principal.via !== "session" || !principal.memberId) throw new ApplicationError("forbidden", "Sign in with a named account before changing member credentials.");
    const id = (request.params as { id: string }).id; const result = await runPasswordHashMutation(request.ip, () => service.team.changePassword(id, request.body, requestContext(request)));
    if (id === principal.memberId) auth.clearSession(reply); return result;
  });
  const securityMutation = async (request: FastifyRequest, reply: FastifyReply) => {
    if (teamState.enabled) throw new ApplicationError("forbidden", "Named-account access is enabled. Manage member credentials in Team access; shared workspace credentials cannot be re-enabled.");
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
  app.patch(route("/auth/access"), { bodyLimit: AUTH_BODY_LIMIT }, securityMutation);
  app.post(route("/auth/security"), { bodyLimit: AUTH_BODY_LIMIT }, securityMutation);
  app.post(route("/auth/logout"), { bodyLimit: AUTH_BODY_LIMIT }, async (request, reply) => { requirePrincipal(request); auth.clearSession(reply); return { authenticated: false, correlationId: request.correlationId }; });
  app.get(route("/auth/session"), async (request) => { const principal = requirePrincipal(request); return { authenticated: true, actor: principal.actor, source: principal.source, scopes: [...principal.scopes], projectIds: principal.projectIds ? [...principal.projectIds] : undefined, ...(principal.memberId ? { memberId: principal.memberId, memberVersion: principal.memberVersion } : {}), teamEnabled: teamState.enabled }; });

  app.get(route("/workspace"), async (request) => { const principal = requireScope(request, "read", auth); if (principal.via === "bearer") rejectScopedGlobalAccess(request); return workspaceSnapshot(service, principal.projectIds); });
  app.get(route("/workspace/preferences"), async (request, reply) => {
    requireScope(request, "read", auth);
    const preferences = await service.getWorkspacePreferences();
    reply.header("etag", `"${preferences.version}"`);
    return preferences;
  });
  app.get(route("/workspace/preferences/stock-receiving-impact"), async (request) => {
    requireScope(request, "read", auth);
    rejectScopedGlobalAccess(request);
    const query = parseBody(stockReceivingPolicyImpactQuerySchema, request.query);
    return service.previewStockReceivingPolicy(query.stockReceivingPolicy);
  });
  app.put(route("/workspace/preferences"), async (request, reply) => {
    // Interpretation of stock evidence is a human workspace decision. Bearer
    // tokens (including MCP agents) and project-scoped sessions cannot change it.
    const principal = requireScope(request, "admin", auth);
    if (principal.via !== "session" || principal.source !== "ui" || principal.projectIds !== undefined) {
      throw new ApplicationError("forbidden", "Only a workspace administrator browser session may change workspace preferences");
    }
    const headerVersion = parseExpectedVersion(request);
    const body = parseBody(updateWorkspacePreferencesSchema, request.body);
    if (headerVersion !== undefined && body.expectedVersion !== undefined && headerVersion !== body.expectedVersion) {
      throw new ApplicationError("validation", "If-Match and expectedVersion must agree");
    }
    const expectedVersion = body.expectedVersion ?? headerVersion;
    const mutation = await service.updateWorkspacePreferences({ stockReceivingPolicy: body.stockReceivingPolicy, ...(expectedVersion === undefined ? {} : { expectedVersion }) }, requestContext(request));
    reply.header("etag", `"${mutation.data.version}"`);
    return mutationBody(mutation);
  });
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
    const expectedVersion = optionalStockVersion(request, request.body);
    const mutation = await service.recordPhysicalCount(params.id, body.quantity, requestContext(request), item.unit, body.note, expectedVersion);
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
  app.delete(route("/inventory/:id"), async (request) => {
    requireScope(request, "write", auth); rejectScopedGlobalAccess(request);
    const params = request.params as { id: string };
    return service.deleteInventoryItem(params.id, parseExpectedVersion(request), requestContext(request));
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
  app.get(route("/inventory/:id/stock-events"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; const page = parsePageQuery(request.query); return service.listStockEvents(params.id, page.limit, page.cursor); });
  app.post(route("/inventory/:id/stock-events"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; const expectedVersion = optionalStockVersion(request, request.body); const input = parseBody(stockEventInputSchema, { ...withoutExpectedVersion(request.body), itemId: params.id }); const mutation = await service.recordStockEvent(input, requestContext(request), expectedVersion); return reply.code(201).send(mutation); });

  app.get(route("/projects"), async (request) => {
    requireScope(request, "read", auth);
    const query = request.query as { q?: string; status?: ProjectListOptions["status"]; limit?: string; cursor?: string };
    const parsedStatus = query.status === undefined ? undefined : projectStatusSchema.safeParse(query.status);
    if (parsedStatus !== undefined && !parsedStatus.success) throw new ApplicationError("validation", "Project status must be one of the canonical lifecycle values");
    if (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 200)) throw new ApplicationError("validation", "Query parameters are invalid", { issues: [{ path: ["q"], message: "q must be at most 200 characters" }] });
    const page = parsePageQuery(request.query);
    const parsed = { ...(query.q === undefined ? {} : { q: query.q }), ...(parsedStatus === undefined ? {} : { status: parsedStatus.data }), limit: page.limit, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) } satisfies ProjectListOptions;
    return request.principal?.projectIds === undefined ? service.listProjects(parsed) : scopedProjectPage(service, parsed, request.principal.projectIds);
  });
  app.get(route("/projects/removed"), async (request) => {
    requireScope(request, "read", auth);
    rejectScopedGlobalAccess(request);
    const page = parsePageQuery(request.query);
    return service.listRemovedProjectPage(page.limit, page.cursor);
  });
  app.post(route("/projects"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const mutation = await service.createProject(parseBody(createProjectSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.post(route("/projects/with-initial-revision"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const mutation = await service.createProjectWithInitialRevision(parseBody(createProjectWithInitialRevisionSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });
  app.post(route("/project-setup/previews"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const preview = await service.previewProjectSetup(parseBody(projectSetupProposalSchema, request.body), requestContext(request)); return reply.code(201).send(preview); });
  app.post(route("/project-setup/previews/:id/commit"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); if (requestIdempotencyKey(request) === undefined) throw new ApplicationError("validation", "Idempotency-Key is required for project setup commit"); const params = request.params as { id: string }; const body = parseBody(commitProjectSetupBodySchema, request.body); const command = { ...body, previewId: params.id }; return service.commitProjectSetup(command, requestContext(request, command)); });
  app.get(route("/projects/:id/removed-history"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; requireProjectScope(request, params.id); const page = parsePageQuery(request.query); return service.readRemovedProjectHistory(params.id, page.limit, page.cursor); });
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
  app.patch(route("/project-revisions/:id"), async (request) => {
    requireScope(request, "write", auth);
    const params = request.params as { id: string };
    await requireRevisionScope(request, service, params.id);
    const expectedVersion = parseRequiredExpectedVersion(request);
    const body = parseBody(updateProjectRevisionSchema, request.body);
    return service.updateProjectRevision(params.id, body, expectedVersion, requestContext(request, { body, expectedVersion }));
  });
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
  app.get(route("/project-revisions/:revisionId/inspections"), async (request) => {
    requireScope(request, "read", auth);
    const params = request.params as { revisionId: string };
    await requireRevisionScope(request, service, params.revisionId);
    const query = request.query as { limit?: string; cursor?: string };
    const parsedLimit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) throw new ApplicationError("validation", "Inspection limit must be between 1 and 200");
    if (query.cursor !== undefined && (typeof query.cursor !== "string" || query.cursor.length > 512)) throw new ApplicationError("validation", "Inspection cursor must be at most 512 characters");
    return service.listInspections(params.revisionId, { limit: parsedLimit, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) });
  });
  app.get(route("/project-revisions/:revisionId/inspections/:inspectionId"), async (request) => {
    requireScope(request, "read", auth);
    const params = request.params as { revisionId: string; inspectionId: string };
    await requireRevisionScope(request, service, params.revisionId);
    return service.getInspection(params.revisionId, params.inspectionId);
  });
  app.post(route("/project-revisions/:revisionId/inspections/:inspectionId/completion-preview"), async (request, reply) => {
    requireScope(request, "write", auth);
    const params = request.params as { revisionId: string; inspectionId: string };
    await requireRevisionScope(request, service, params.revisionId);
    const observation = parseBody(inspectionObservationSchema, request.body);
    const preview = await service.previewInspectionCompletion(params.revisionId, { actionId: params.inspectionId, observation }, requestContext(request));
    return reply.code(201).send(preview);
  });
  app.post(route("/project-revisions/:revisionId/inspections/:inspectionId/completion-commit"), async (request) => {
    requireScope(request, "write", auth);
    const params = request.params as { revisionId: string; inspectionId: string };
    await requireRevisionScope(request, service, params.revisionId);
    if (requestIdempotencyKey(request) === undefined) throw new ApplicationError("validation", "Idempotency-Key is required for inspection completion");
    const body = parseBody(commitInspectionCompletionBodySchema, request.body);
    return service.commitInspectionCompletion(params.revisionId, { ...body, actionId: params.inspectionId }, requestContext(request));
  });
  app.patch(route("/bom-lines/:id"), async (request) => { requireScope(request, "write", auth); const params = request.params as { id: string }; await requireBomReferenceScope(request, service, params.id); const expectedVersion = parseMandatoryIfMatch(request); return service.updateBomLine(params.id, parseBody(updateBomLineSchema, request.body) as never, expectedVersion, requestContext(request)); });
  app.delete(route("/bom-lines/:id"), async (request) => { requireScope(request, "write", auth); const params = request.params as { id: string }; await requireBomReferenceScope(request, service, params.id); return service.retireBomLine(params.id, parseRequiredExpectedVersion(request), requestContext(request)); });
  app.post(route("/bom-lines/:id/restore"), async (request) => { requireScope(request, "write", auth); const params = request.params as { id: string }; await requireBomReferenceScope(request, service, params.id); return service.restoreBomLine(params.id, parseRequiredExpectedVersion(request), requestContext(request)); });
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
    if (query.itemId !== undefined && (typeof query.itemId !== "string" || !UUID_OR_ID.test(query.itemId) || query.itemId.length > 200)) throw new ApplicationError("validation", "Query parameters are invalid", { issues: [{ path: ["itemId"], message: "itemId must be an inventory identifier" }] });
    const page = parsePageQuery(request.query);
    return service.listOffers(query.itemId, page.limit, page.cursor);
  });
  app.post(route("/offers"), async (request, reply) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const mutation = await service.createOffer(parseBody(createOfferSchema, request.body), requestContext(request)); return reply.code(201).send(mutation); });

  app.get(route("/projects/:id/artifacts"), async (request) => {
    requireScope(request, "read", auth);
    const params = request.params as { id: string };
    requireProjectScope(request, params.id);
    const query = parseBody(artifactListQuerySchema, request.query);
    return service.listArtifacts(params.id, query);
  });
  app.post(route("/artifacts/uploads"), async (request, reply) => {
    requireScope(request, "write", auth);
    const input = parseBody(beginArtifactUploadRequestSchema, request.body);
    requireProjectScope(request, input.projectId);
    if ("buildConfigurationSnapshotId" in input && input.buildConfigurationSnapshotId !== undefined) {
      await authorizeScopedBuildConfigurationReference(request, service, input.buildConfigurationSnapshotId);
    }
    const mutation = await service.beginArtifactUpload(input, requestContext(request));
    return reply.code(201).send(mutation);
  });
  app.put(route("/artifacts/uploads/:id"), { bodyLimit: uploadBodyLimit }, async (request) => { requireScope(request, "write", auth); const params = request.params as { id: string }; await requireArtifactReferenceScope(request, service, params.id, true); const body = request.body; if (!(body instanceof Uint8Array)) throw new ApplicationError("validation", "Upload body must be binary"); return service.writeArtifactUpload(params.id, body); });
  app.post(route("/artifacts/uploads/:id/finalize"), async (request) => { requireScope(request, "write", auth); const params = request.params as { id: string }; await requireArtifactReferenceScope(request, service, params.id, true); return service.finalizeArtifactUpload(params.id, requestContext(request)); });
  app.put(route("/transfers/uploads/:id"), { bodyLimit: uploadBodyLimit }, async (request, reply) => {
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
  app.get(route("/artifacts/:id"), async (request) => { requireScope(request, "read", auth); const params = request.params as { id: string }; await requireArtifactReferenceScope(request, service, params.id); return service.getArtifact(params.id); });
  app.get(route("/artifacts/:id/download"), async (request, reply) => { requireScope(request, "read", auth); const params = request.params as { id: string }; await requireArtifactReferenceScope(request, service, params.id); const downloaded = await service.readArtifact(params.id); return reply.type(artifactResponseType(downloaded.artifact.mediaType)).header("content-disposition", artifactContentDisposition(downloaded.artifact.filename)).send(Buffer.from(downloaded.body)); });
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
    return reply.type(artifactResponseType(downloaded.artifact.mediaType)).header("content-disposition", artifactContentDisposition(downloaded.artifact.filename)).send(Buffer.from(downloaded.body));
  });
  app.delete(route("/artifacts/:id"), async (request) => { requireScope(request, "write", auth); rejectScopedGlobalAccess(request); const params = request.params as { id: string }; return service.retireArtifact(params.id, parseExpectedVersion(request), requestContext(request)); });

  app.get(route("/audit"), async (request) => { requireScope(request, "admin", auth); rejectScopedGlobalAccess(request); const page = parsePageQuery(request.query); return ports.audit.list(page.limit, page.cursor); });
  app.get(route("/events"), async (request, reply) => {
    requireScope(request, "read", auth);
    rejectScopedGlobalAccess(request);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
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
