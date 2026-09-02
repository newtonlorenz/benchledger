import { ApplicationError } from "@benchledger/application";
import { DomainError } from "@benchledger/domain";
import { RuntimeConflict } from "./persistence.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function page<T>(items: readonly T[], limit: number, cursor?: string): { readonly data: readonly T[]; readonly nextCursor?: string; readonly limit: number; readonly total: number } {
  const parsed = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  const offset = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  const data = items.slice(offset, offset + limit);
  const nextCursor = offset + data.length < items.length ? String(offset + data.length) : undefined;
  return { data, limit, ...(nextCursor === undefined ? {} : { nextCursor }), total: items.length };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function mapPersistenceError(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof RuntimeConflict) throw new ApplicationError("conflict", error.message, error.details);
  if (error instanceof DomainError) {
    if (error.code === "project_removed") throw new ApplicationError("project_removed", error.message);
    if (error.code.endsWith("_not_found") || error.code === "inventory_not_found" || error.code === "project_not_found" || error.code === "work_item_not_found" || error.code === "supplier_not_found" || error.code === "reservation_not_found" || error.code === "bom_line_not_found") {
      throw new ApplicationError("not_found", error.message);
    }
    if (error.code.startsWith("reconciliation_") && !error.code.endsWith("_not_found")) {
      throw new ApplicationError("conflict", error.message);
    }
    if (error.code.includes("duplicate") || error.code.includes("insufficient") || error.code.includes("negative") || error.code.includes("over_allocation") || error.code.includes("not_active") || error.code.includes("active_reservation") || error.code.includes("version_conflict") || error.code.includes("ancestry_conflict") || error.code.includes("category_in_use") || error.code.includes("category_has_children") || error.code === "project_archived" || error.code === "project_not_archived") {
      throw new ApplicationError("conflict", error.message);
    }
    if (error.code.startsWith("invalid_")) throw new ApplicationError("validation", error.message);
    throw new ApplicationError("integrity_error", "The stored record could not be updated safely");
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("unique constraint") || message.includes("already exists") || message.includes("constraint failed")) {
      throw new ApplicationError("conflict", "The record conflicts with an existing record");
    }
    if (message.includes("foreign key")) throw new ApplicationError("not_found", "A referenced record was not found");
  }
  throw new ApplicationError("integrity_error", "The persistence operation failed");
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
