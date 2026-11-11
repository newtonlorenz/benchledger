import { ApplicationError } from "@benchledger/application";
import type { ApplicationErrorCode } from "@benchledger/application";
import { DomainError } from "@benchledger/domain";
import { RuntimeConflict } from "./persistence.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function page<T>(items: readonly T[], limit: number, cursor?: string): { readonly data: readonly T[]; readonly nextCursor?: string; readonly limit: number; readonly total: number } {
  const offset = parseOffsetCursor(cursor);
  const data = items.slice(offset, offset + limit);
  const nextCursor = offset + data.length < items.length ? String(offset + data.length) : undefined;
  return { data, limit, ...(nextCursor === undefined ? {} : { nextCursor }), total: items.length };
}

/** Offset cursors are canonical non-negative decimal integers; anything else is rejected rather than silently restarting at the first page. */
export function parseOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/u.test(cursor)) throw new ApplicationError("invalid_cursor", "Cursor is invalid");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new ApplicationError("invalid_cursor", "Cursor is invalid");
  return offset;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Explicit domain-code table. Codes not listed fall back to the naming
 * conventions below (`*_not_found`, `invalid_*`, `reconciliation_*`), and a
 * domain rule with no classification stays an integrity error (409).
 */
const DOMAIN_ERROR_CODES: Readonly<Record<string, ApplicationErrorCode>> = {
  project_removed: "project_removed",
  idempotency_conflict: "idempotency_conflict",
  invalid_cursor: "invalid_cursor",
  duplicate_event: "conflict",
  duplicate_idempotency_key: "conflict",
  duplicate_category: "conflict",
  insufficient_stock: "conflict",
  negative_stock: "conflict",
  negative_allocation: "conflict",
  over_allocation: "conflict",
  reservation_not_active: "conflict",
  active_reservation_conflict: "conflict",
  version_conflict: "conflict",
  snapshot_ancestry_conflict: "conflict",
  binding_ancestry_conflict: "conflict",
  category_in_use: "conflict",
  category_has_children: "conflict",
  project_archived: "conflict",
  project_not_archived: "conflict",
  reservation_required: "validation",
  bom_line_role_required: "validation",
  reusable_requirement_not_reservable: "validation",
  reusable_requirement_not_consumable: "validation",
};

function domainErrorCode(code: string): ApplicationErrorCode | undefined {
  const explicit = DOMAIN_ERROR_CODES[code];
  if (explicit !== undefined) return explicit;
  if (code.endsWith("_not_found")) return "not_found";
  if (code.startsWith("reconciliation_")) return "conflict";
  if (code.startsWith("invalid_")) return "validation";
  return undefined;
}

/** SQLite extended result codes (node:sqlite exposes them as `errcode`). */
const SQLITE_CONSTRAINT = 19;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

function sqliteErrorCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const candidate = error as Error & { readonly code?: unknown; readonly errcode?: unknown };
  return candidate.code === "ERR_SQLITE_ERROR" && typeof candidate.errcode === "number" ? candidate.errcode : undefined;
}

/**
 * Translate expected persistence/domain failures into application errors,
 * keeping the original error as `cause`. Unclassified failures (programming
 * errors, I/O, unexpected SQLite errors) become `internal` (HTTP 500) with a
 * generic message and the original as `cause`, instead of being disguised as
 * a 409 integrity conflict or leaking storage details in the message.
 */
export function mapPersistenceError(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof RuntimeConflict) throw new ApplicationError("conflict", error.message, error.details, { cause: error });
  if (error instanceof DomainError) {
    const code = domainErrorCode(error.code);
    if (code === "idempotency_conflict") throw new ApplicationError(code, error.message, { reason: "idempotency_key_reused", field: "idempotencyKey", retryable: false, commitState: "not_committed" }, { cause: error });
    if (code !== undefined) throw new ApplicationError(code, error.message, undefined, { cause: error });
    throw new ApplicationError("integrity_error", "The stored record could not be updated safely", undefined, { cause: error });
  }
  const sqlite = sqliteErrorCode(error);
  if (sqlite === SQLITE_CONSTRAINT_FOREIGNKEY) throw new ApplicationError("not_found", "A referenced record was not found", undefined, { cause: error });
  if (sqlite !== undefined && (sqlite & 0xff) === SQLITE_CONSTRAINT) throw new ApplicationError("conflict", "The record conflicts with an existing record", undefined, { cause: error });
  throw new ApplicationError("internal", "An unexpected persistence failure occurred", undefined, { cause: error });
}

export async function attempt<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    return mapPersistenceError(error);
  }
}

export function resultValue<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }): T {
  if (result.ok) return result.value;
  switch (result.error.code) {
    case "NOT_FOUND": throw new ApplicationError("not_found", result.error.message);
    case "CONFLICT":
    case "MANIFEST_IMMUTABLE":
    case "BUNDLE_EXISTS": throw new ApplicationError("conflict", result.error.message);
    case "UPLOAD_QUOTA_EXCEEDED":
    case "STORAGE_QUOTA_EXCEEDED": throw new ApplicationError("quota_exceeded", result.error.message);
    case "DIGEST_MISMATCH":
    case "SIZE_MISMATCH": throw new ApplicationError("validation", result.error.message);
    case "UPLOAD_STATE": throw new ApplicationError("upload_expired", result.error.message);
    case "INVALID_INPUT":
    case "PATH_UNSAFE": throw new ApplicationError("validation", result.error.message);
    default: throw new ApplicationError("integrity_error", "The artifact operation failed");
  }
}
