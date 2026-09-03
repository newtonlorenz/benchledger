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

export class McpAdapterError extends Error {
  readonly code: McpErrorCode;
  readonly details?: JsonObject;

  constructor(code: McpErrorCode, message: string, details?: JsonObject) {
    super(message);
    this.name = "McpAdapterError";
    this.code = code;
    this.details = details;
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

export function mapBackendError(error: unknown): McpAdapterError {
  if (isMcpAdapterError(error)) return error;

  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; statusCode?: unknown; issues?: unknown };
    // ApplicationService uses lower-case domain error codes while HTTP
    // adapters commonly expose an upper-case/status-code variant. Normalize
    // both at the MCP boundary so conflicts and validation failures are not
    // obscured as an opaque backend error.
    if (candidate.code === "NOT_FOUND" || candidate.code === "not_found" || candidate.code === "project_removed" || candidate.statusCode === 404 || candidate.statusCode === 410) {
      return new McpAdapterError("NOT_FOUND", "The requested record was not found.");
    }
    if (candidate.code === "CONFLICT" || candidate.code === "conflict" || candidate.code === "idempotency_conflict" || candidate.statusCode === 409) {
      const details = safeConflictDetails(candidate);
      const reason = details?.reason;
      return new McpAdapterError("CONFLICT", conflictMessage(typeof reason === "string" ? reason : undefined), details);
    }
    if (candidate.code === "FORBIDDEN" || candidate.code === "forbidden" || candidate.statusCode === 403) {
      return new McpAdapterError("FORBIDDEN", "The current token is not allowed to perform this action.");
    }
    if (candidate.code === "validation" || candidate.code === "invalid_cursor" || candidate.code === "quota_exceeded" || candidate.code === "unsupported_media" || (candidate.name === "ZodError" && Array.isArray(candidate.issues))) {
      return new McpAdapterError("INVALID_ARGUMENT", "The request arguments are invalid.");
    }
  }

  return new McpAdapterError("BACKEND_ERROR", "The application service could not complete this operation.");
}
