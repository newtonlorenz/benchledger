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
const MAX_SAFE_CONFLICT_ID_LENGTH = 240;

function safeConflictDetails(error: Error): JsonObject | undefined {
  const candidate = error as Error & { details?: unknown };
  const details = candidate.details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  const raw = details as Record<string, unknown>;
  if (typeof raw.reason !== "string" || !SAFE_CONFLICT_REASONS.has(raw.reason)) return undefined;
  if (typeof raw.field !== "string" || !SAFE_CONFLICT_FIELDS.has(raw.field)) return undefined;
  if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > MAX_SAFE_CONFLICT_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(raw.id)) return undefined;
  if (raw.retryable !== false || raw.commitState !== "not_committed") return undefined;
  return {
    reason: raw.reason,
    field: raw.field,
    id: raw.id,
    retryable: false,
    commitState: "not_committed",
    ...(typeof raw.commandId === "string" && raw.commandId.length > 0 && raw.commandId.length <= 200 ? { commandId: raw.commandId } : {}),
  };
}

function conflictMessage(reason: string | undefined): string {
  switch (reason) {
    case "project_id_exists": return "The project ID is already in use; read the existing project or choose a different project ID.";
    case "revision_id_exists": return "The revision ID is already in use; choose a different revision ID.";
    case "project_name_exists": return "A project with this name already exists; read the existing project or choose a different project name.";
    case "idempotency_key_reused": return "The idempotency key was already used for a different command; retry only with the identical payload or choose a new key.";
    default: return "The record changed; read it again and retry with its current version.";
  }
}

export function mapBackendError(error: unknown): McpAdapterError {
  if (isMcpAdapterError(error)) return error;

  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; statusCode?: unknown };
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
    if (candidate.code === "validation" || candidate.code === "invalid_cursor" || candidate.code === "quota_exceeded" || candidate.code === "unsupported_media") {
      return new McpAdapterError("INVALID_ARGUMENT", "The request arguments are invalid.");
    }
  }

  return new McpAdapterError("BACKEND_ERROR", "The application service could not complete this operation.");
}
