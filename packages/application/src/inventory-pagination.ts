import { ApplicationError } from "./errors.js";

/**
 * Inventory pages retain the existing offset cursor for compatibility. The
 * cursor is an opaque transport value: clients must pass it back unchanged
 * and never derive a page number from it. Keyset cursors can replace this
 * implementation later without changing the HTTP/MCP shape.
 */
export function parseInventoryCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/u.test(cursor)) {
    throw new ApplicationError("invalid_cursor", "The inventory pagination cursor is invalid");
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new ApplicationError("invalid_cursor", "The inventory pagination cursor is invalid");
  }
  return offset;
}
