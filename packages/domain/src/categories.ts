import { DomainError } from "./errors.js";

/** User-managed taxonomy. This is deliberately separate from InventoryItem.kind. */
export interface InventoryCategory {
  readonly id: string;
  readonly name: string;
  /** Only top-level categories omit parentId; children may not have children. */
  readonly parentId?: string;
  readonly sortOrder: number;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface NewInventoryCategory {
  readonly id?: string;
  readonly name: string;
  readonly parentId?: string;
  readonly sortOrder?: number;
}

export interface UpdateInventoryCategory {
  readonly name?: string;
  readonly sortOrder?: number;
}

/** Stable defaults for new workspaces. These names are taxonomy labels, not item kinds. */
export const BUILTIN_INVENTORY_CATEGORIES: readonly InventoryCategory[] = [
  "printers",
  "printer-accessories",
  "printer-parts",
  "filament",
  "tools",
  "workshop",
  "fasteners",
  "adhesives",
  "finishes",
  "lighting",
  "electronics",
  "electrical",
  "consumables",
  "other",
].map((slug, sortOrder) => ({
  id: `category-${slug}`,
  name: slug.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
  sortOrder,
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
}));

export function assertInventoryCategoryName(name: string): void {
  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 120) {
    throw new DomainError("invalid_category", "category name must be between 1 and 120 characters");
  }
}

export function assertInventoryCategoryParent(
  category: Pick<InventoryCategory, "id">,
  parent: Pick<InventoryCategory, "id" | "parentId"> | undefined,
  _grandparent: Pick<InventoryCategory, "id" | "parentId"> | undefined,
): void {
  if (parent === undefined) {
    if (category.id === undefined) throw new DomainError("invalid_category", "category id is required");
    return;
  }
  if (category.id === parent.id) throw new DomainError("invalid_category", "a category cannot be its own parent or form a cycle");
  if (parent.parentId !== undefined) throw new DomainError("invalid_category", "categories support only one level of subcategories");
}

export function normalizeInventoryCategoryName(name: string): string {
  assertInventoryCategoryName(name);
  return name.trim().replace(/\s+/gu, " ");
}

/**
 * Stable ASCII sibling identity/order key shared by durable and synthetic
 * stores. NFKC folds canonically equivalent presentation forms before the
 * locale-independent lower-case operation. Encoding the resulting UTF-8
 * bytes as fixed-width hexadecimal makes JavaScript string ordering identical
 * to SQLite BINARY ordering for every Unicode scalar value (including values
 * whose UTF-16 order differs from their UTF-8 order).
 */
export function normalizeInventoryCategoryKey(name: string): string {
  const normalized = normalizeInventoryCategoryName(name).normalize("NFKC").toLowerCase();
  return Array.from(new TextEncoder().encode(normalized), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compare persisted category keys using SQLite's default BINARY collation. */
export function compareInventoryCategoryKeys(left: string, right: string): number {
  const leftKey = normalizeInventoryCategoryKey(left);
  const rightKey = normalizeInventoryCategoryKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
