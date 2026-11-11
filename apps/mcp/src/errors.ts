import type { JsonObject } from "./types.js";

export type McpErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_TOOL"
  | "INVALID_RESOURCE"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNSAFE_LINK"
  | "RESOURCE_TOO_LARGE"
  | "HOST_TRANSFER_UNAVAILABLE"
  | "BACKEND_ERROR";

/**
 * Machine-readable recovery category. CONFLICT is split so an agent can tell a
 * stale optimistic version (re-read and retry) from a business rule (change
 * the request) or a reused idempotency key (choose a new key or resend the
 * identical payload).
 */
export type McpErrorReason =
  | "version_conflict"
  | "rule_conflict"
  | "idempotency_conflict"
  | "validation"
  | "not_found"
  | "forbidden";

export class McpAdapterError extends Error {
  readonly code: McpErrorCode;
  readonly details?: JsonObject;
  readonly reason?: McpErrorReason;

  constructor(code: McpErrorCode, message: string, details?: JsonObject, reason?: McpErrorReason) {
    super(message);
    this.name = "McpAdapterError";
    this.code = code;
    this.details = details;
    if (reason !== undefined) this.reason = reason;
  }
}

export function isMcpAdapterError(error: unknown): error is McpAdapterError {
  return error instanceof McpAdapterError;
}

const SAFE_CONFLICT_REASONS = new Set([
  "project_id_exists",
  "revision_id_exists",
  "project_name_exists",
  "idempotency_key_reused",
]);
const SAFE_CONFLICT_FIELDS = new Set(["projectId", "revisionId", "projectName", "idempotencyKey"]);
const SAFE_PROJECT_SETUP_CONFLICT_REASONS = new Set([
  "stale_basis",
  "preview_expired",
  "preview_ownership",
  "already_committed",
  "stale_preview",
]);
const SAFE_PROJECT_SETUP_RECOVERY_ACTION = "preview_project_setup";
const MAX_SAFE_CONFLICT_ID_LENGTH = 240;
const MAX_SAFE_STALE_ITEMS = 100;

function safeBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeProjectSetupConflictDetails(raw: Record<string, unknown>): JsonObject | undefined {
  if (typeof raw.reason !== "string" || !SAFE_PROJECT_SETUP_CONFLICT_REASONS.has(raw.reason)) return undefined;
  if (raw.retryable !== false) return undefined;

  // The committed state is part of the actionable contract. In particular,
  // already_committed is the one setup conflict that is not a failed commit.
  const expectedCommitState = raw.reason === "already_committed" ? "committed" : "not_committed";
  if (raw.commitState !== expectedCommitState) return undefined;

  const hasRecoveryAction = raw.recoveryAction !== undefined;
  const recoveryActionIsAllowed = raw.recoveryAction === SAFE_PROJECT_SETUP_RECOVERY_ACTION;
  if (hasRecoveryAction && !recoveryActionIsAllowed) return undefined;
  if (hasRecoveryAction && !["stale_basis", "preview_expired", "stale_preview"].includes(raw.reason)) return undefined;

  let staleItems: string[] | undefined;
  if (raw.staleItems !== undefined) {
    if (raw.reason !== "stale_basis" || !Array.isArray(raw.staleItems) || raw.staleItems.length > MAX_SAFE_STALE_ITEMS) return undefined;
    if (!raw.staleItems.every((item) => safeBoundedString(item, MAX_SAFE_CONFLICT_ID_LENGTH))) return undefined;
    staleItems = raw.staleItems.map((item) => item as string);
  }

  return {
    reason: raw.reason,
    retryable: false,
    commitState: expectedCommitState,
    ...(recoveryActionIsAllowed ? { recoveryAction: SAFE_PROJECT_SETUP_RECOVERY_ACTION } : {}),
    ...(staleItems === undefined ? {} : { staleItems }),
  };
}

function safeConflictDetails(error: Error): JsonObject | undefined {
  const candidate = error as Error & { details?: unknown };
  const details = candidate.details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  const raw = details as Record<string, unknown>;
  if (typeof raw.reason === "string" && SAFE_PROJECT_SETUP_CONFLICT_REASONS.has(raw.reason)) {
    return safeProjectSetupConflictDetails(raw);
  }
  if (typeof raw.reason !== "string" || !SAFE_CONFLICT_REASONS.has(raw.reason)) return undefined;
  if (typeof raw.field !== "string" || !SAFE_CONFLICT_FIELDS.has(raw.field)) return undefined;
  if (!safeBoundedString(raw.id, MAX_SAFE_CONFLICT_ID_LENGTH)) return undefined;
  if (raw.retryable !== false || raw.commitState !== "not_committed") return undefined;
  return {
    reason: raw.reason,
    field: raw.field,
    id: raw.id,
    retryable: false,
    commitState: "not_committed",
    ...(safeBoundedString(raw.commandId, 200) ? { commandId: raw.commandId } : {}),
  };
}

function conflictMessage(reason: string | undefined): string {
  switch (reason) {
    case "project_id_exists": return "The project ID is already in use; read the existing project or choose a different project ID.";
    case "revision_id_exists": return "The revision ID is already in use; choose a different revision ID.";
    case "project_name_exists": return "A project with this name already exists; read the existing project or choose a different project name.";
    case "idempotency_key_reused": return "The idempotency key was already used for a different command; retry only with the identical payload or choose a new key.";
    case "stale_basis": return "The project setup inventory basis is stale; create a new project setup preview before committing.";
    case "preview_expired": return "The project setup preview has expired; create a new project setup preview before committing.";
    case "preview_ownership": return "The project setup preview was not found or is not owned by this actor; use a preview created by this actor.";
    case "already_committed": return "The project setup preview has already been committed; use a new preview for another setup.";
    case "stale_preview": return "The project setup preview is stale; create a new project setup preview before committing.";
    default: return "The record changed; read it again and retry with its current version.";
  }
}

const MAX_SAFE_MESSAGE_LENGTH = 500;
const MAX_SAFE_ISSUES = 10;
// Anything that looks like a host path, stack frame, storage engine or SQL
// text is withheld; ApplicationError messages are written for end users, but
// a wrapped persistence failure must never leak through this boundary.
const UNSAFE_MESSAGE_PATTERN = /(?:\/Users\/|\/home\/|\/var\/|\/tmp\/|\/private\/|[A-Za-z]:\\|node_modules|\bat\s+\S+\s+\(|\n\s+at\s|sqlite|\bselect\s.+\sfrom\b|\binsert\s+into\b|\bdelete\s+from\b|\.(?:ts|js|mjs|cjs):\d+)/i;
const SAFE_INSPECTION_CONFLICT_REASONS = new Set(["stale_preview", "stale_action", "stale_basis"]);

/** Return a bounded, single-line user-facing message, or undefined if unsafe. */
export function safeMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || UNSAFE_MESSAGE_PATTERN.test(value)) return undefined;
  return normalized.length > MAX_SAFE_MESSAGE_LENGTH ? `${normalized.slice(0, MAX_SAFE_MESSAGE_LENGTH - 1)}…` : normalized;
}

/** Bounded zod-style field issues: dotted path plus message only. */
function safeIssues(value: unknown): { path: string; message: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: { path: string; message: string }[] = [];
  for (const entry of value.slice(0, MAX_SAFE_ISSUES)) {
    if (entry === null || typeof entry !== "object") continue;
    const raw = entry as { path?: unknown; message?: unknown };
    const path = Array.isArray(raw.path) ? raw.path.filter((part) => typeof part === "string" || typeof part === "number").join(".").slice(0, 200) : "";
    const message = safeMessage(raw.message)?.slice(0, 200) ?? "Invalid value.";
    issues.push({ path, message });
  }
  return issues.length === 0 ? undefined : issues;
}

function issueSummary(issues: readonly { path: string; message: string }[]): string {
  return issues.map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path}: ${issue.message}`)).join("; ");
}

function isApplicationError(error: Error): boolean {
  return error.name === "ApplicationError";
}

function positiveVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function versionConflictDetails(error: Error): JsonObject | undefined {
  const raw = (error as Error & { details?: unknown }).details;
  const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const expectedVersion = positiveVersion(record.expectedVersion);
  const actualVersion = positiveVersion(record.actualVersion);
  const looksVersioned = expectedVersion !== undefined || actualVersion !== undefined || /changed since (?:it|version \d+) was read|stale (?:version|category)|version_conflict/i.test(error.message);
  if (!looksVersioned) return undefined;
  return {
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    ...(actualVersion === undefined ? {} : { actualVersion }),
  };
}

function genericRecoveryDetails(error: Error): JsonObject | undefined {
  const raw = (error as Error & { details?: unknown }).details;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  // Inspection conflicts are the only non-setup conflicts that carry a
  // structured recovery action; everything else stays message-only.
  if (record.recoveryAction !== "list_inspections") return undefined;
  const reason = typeof record.reason === "string" && SAFE_INSPECTION_CONFLICT_REASONS.has(record.reason) ? record.reason : undefined;
  return { ...(reason === undefined ? {} : { reason }), recoveryAction: "list_inspections" };
}

function mapConflict(candidate: Error & { code?: unknown }): McpAdapterError {
  const details = safeConflictDetails(candidate);
  const knownReason = typeof details?.reason === "string" ? details.reason : undefined;
  const appMessage = isApplicationError(candidate) ? safeMessage(candidate.message) : undefined;
  if (candidate.code === "idempotency_conflict" || knownReason === "idempotency_key_reused") {
    return new McpAdapterError("CONFLICT", knownReason === undefined ? `${appMessage ?? "The idempotency key was already used for a different command."} Retry only with the identical payload or choose a new idempotencyKey.` : conflictMessage(knownReason), details, "idempotency_conflict");
  }
  if (knownReason !== undefined) return new McpAdapterError("CONFLICT", conflictMessage(knownReason), details, "rule_conflict");
  const version = versionConflictDetails(candidate);
  if (version !== undefined) {
    const current = typeof version.actualVersion === "number" ? ` (current version ${version.actualVersion})` : "";
    const prefix = appMessage ?? "The record changed since it was read.";
    return new McpAdapterError("CONFLICT", `${prefix} Read it again${current} and retry with its current expectedVersion.`, version, "version_conflict");
  }
  return new McpAdapterError(
    "CONFLICT",
    appMessage ?? "The request conflicts with the current record state; read the record and change the request before retrying.",
    genericRecoveryDetails(candidate),
    "rule_conflict",
  );
}

export function mapBackendError(error: unknown): McpAdapterError {
  if (isMcpAdapterError(error)) return error;

  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; statusCode?: unknown; issues?: unknown; details?: unknown };
    const appMessage = isApplicationError(candidate) ? safeMessage(candidate.message) : undefined;
    // ApplicationService uses lower-case domain error codes while HTTP
    // adapters commonly expose an upper-case/status-code variant. Normalize
    // both at the MCP boundary so conflicts and validation failures are not
    // obscured as an opaque backend error.
    if (candidate.code === "NOT_FOUND" || candidate.code === "not_found" || candidate.code === "project_removed" || candidate.statusCode === 404 || candidate.statusCode === 410) {
      return new McpAdapterError("NOT_FOUND", appMessage ?? "The requested record was not found.", undefined, "not_found");
    }
    if (candidate.code === "CONFLICT" || candidate.code === "conflict" || candidate.code === "idempotency_conflict" || candidate.statusCode === 409) {
      return mapConflict(candidate);
    }
    if (candidate.code === "FORBIDDEN" || candidate.code === "forbidden" || candidate.statusCode === 403) {
      return new McpAdapterError("FORBIDDEN", "The current token is not allowed to perform this action.", undefined, "forbidden");
    }
    if (candidate.name === "ZodError" && Array.isArray(candidate.issues)) {
      const issues = safeIssues(candidate.issues);
      return new McpAdapterError("INVALID_ARGUMENT", issues === undefined ? "The request arguments are invalid." : `The request arguments are invalid: ${issueSummary(issues)}`.slice(0, MAX_SAFE_MESSAGE_LENGTH), issues === undefined ? undefined : { issues }, "validation");
    }
    if (candidate.code === "validation" || candidate.code === "invalid_cursor" || candidate.code === "quota_exceeded" || candidate.code === "unsupported_media") {
      const nested = candidate.details !== null && typeof candidate.details === "object" ? safeIssues((candidate.details as { issues?: unknown }).issues) : undefined;
      return new McpAdapterError("INVALID_ARGUMENT", appMessage ?? "The request arguments are invalid.", nested === undefined ? undefined : { issues: nested }, "validation");
    }
  }

  return new McpAdapterError("BACKEND_ERROR", "The application service could not complete this operation.");
}
