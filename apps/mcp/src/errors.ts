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

export function mapBackendError(error: unknown): McpAdapterError {
  if (isMcpAdapterError(error)) return error;

  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; statusCode?: unknown };
    // ApplicationService uses lower-case domain error codes while HTTP
    // adapters commonly expose an upper-case/status-code variant. Normalize
    // both at the MCP boundary so conflicts and validation failures are not
    // obscured as an opaque backend error.
    if (candidate.code === "NOT_FOUND" || candidate.code === "not_found" || candidate.statusCode === 404) {
      return new McpAdapterError("NOT_FOUND", "The requested record was not found.");
    }
    if (candidate.code === "CONFLICT" || candidate.code === "conflict" || candidate.code === "idempotency_conflict" || candidate.statusCode === 409) {
      return new McpAdapterError("CONFLICT", "The record changed; read it again and retry with its current version.");
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
