import { DomainError, assertInventoryCategoryName, createId, normalizeInventoryCategoryKey, normalizeInventoryCategoryName, assertInventoryCategoryParent } from "@benchledger/domain";
import type { InventoryCategory, NewInventoryCategory, UpdateInventoryCategory } from "@benchledger/domain";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";

export interface InventoryCategoryListOptions {
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface InventoryCategoryRepositoryPage<T> {
  readonly data: readonly T[];
  readonly nextCursor?: string;
  readonly limit: number;
  readonly total: number;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_CURSOR_LENGTH = 512;

function pageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) throw new DomainError("invalid_limit", `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  return limit;
}

function text(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`database row ${key} is not text`);
  return value;
}

function number(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`database row ${key} is not numeric`);
  return value;
}

function categoryFromRow(row: SqliteRow): InventoryCategory {
  const parentId = row.parent_id;
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    ...(typeof parentId === "string" ? { parentId } : {}),
    sortOrder: number(row, "sort_order"),
    archived: number(row, "archived") === 1,
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    version: number(row, "version"),
  };
}

function encodeCursor(categoryId: string): string {
  return Buffer.from(categoryId, "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length === 0 || value.length > MAX_CURSOR_LENGTH) throw new Error("cursor length out of bounds");
    // Buffer's base64url decoder is intentionally forgiving (it ignores
    // punctuation and accepts non-canonical forms). Cursors are a public
    // pagination boundary, so accept only the exact unpadded encoding that
    // this repository emits.
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw new Error("invalid base64url");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical base64url");
    const decoded = bytes.toString("utf8");
    let categoryId = decoded;
    // Accept cursors emitted by the superseded JSON form while all new
    // cursors stay compact and contain only the immutable category id.
    if (decoded.startsWith("{")) {
      const parsed: unknown = JSON.parse(decoded);
      if (parsed === null || typeof parsed !== "object") throw new Error("not object");
      const candidate = parsed as Record<string, unknown>;
      categoryId = typeof candidate.id === "string" ? candidate.id : "";
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(categoryId) || categoryId.length > 160) throw new Error("invalid fields");
    return categoryId;
  } catch {
    throw new DomainError("invalid_cursor", "cursor is invalid or expired");
  }
}

function nowIso(): string { return new Date().toISOString(); }

function conflict(id: string, expected: number, actual: number): never {
  throw new DomainError("version_conflict", `inventory category ${id} changed since version ${expected} was read (current version ${actual})`);
}

function expectedVersion(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new DomainError("invalid_version", "expected version is required and must be a positive integer");
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: index 'inventory_categories_sibling_name_idx'|inventory_categories_sibling_name_idx/i.test(error.message);
}

export class InventoryCategoryRepository {
  public constructor(private readonly database: BenchDatabase) {}

  public create(input: NewInventoryCategory): InventoryCategory {
    const name = normalizeInventoryCategoryName(input.name);
    const categoryId = input.id ?? createId("category");
    const parent = input.parentId === undefined ? undefined : this.get(input.parentId);
    if (input.parentId !== undefined && parent === undefined) throw new DomainError("category_not_found", `inventory category ${input.parentId} does not exist`);
    assertInventoryCategoryParent({ id: categoryId }, parent, undefined);
    if (parent?.archived) throw new DomainError("invalid_category", "an archived category cannot receive subcategories");
    const createdAt = nowIso();
    const category: InventoryCategory = {
      id: categoryId,
      name,
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      sortOrder: input.sortOrder ?? 0,
      archived: false,
      createdAt,
      updatedAt: createdAt,
      version: 1,
    };
    try {
      this.database.run("INSERT INTO inventory_categories (id, name, normalized_name, parent_id, sort_order, archived, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [category.id, category.name, normalizeInventoryCategoryKey(category.name), category.parentId ?? null, category.sortOrder, 0, category.createdAt, category.updatedAt, category.version]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError("duplicate_category", `duplicate category name: '${name}' already exists beside this category`);
      throw error;
    }
    return category;
  }

  public get(id: string): InventoryCategory | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM inventory_categories WHERE id = ?", [id]);
    return row === undefined ? undefined : categoryFromRow(row);
  }

  public list(options: InventoryCategoryListOptions = {}): InventoryCategoryRepositoryPage<InventoryCategory> {
    const limit = pageLimit(options.limit);
    const cursorId = decodeCursor(options.cursor);
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (options.includeArchived !== true) conditions.push("archived = 0");
    if (cursorId !== undefined) {
      const cursorRow = this.database.get<SqliteRow>("SELECT sort_order, normalized_name FROM inventory_categories WHERE id = ?", [cursorId]);
      if (cursorRow === undefined || typeof cursorRow.sort_order !== "number" || typeof cursorRow.normalized_name !== "string") throw new DomainError("invalid_cursor", "cursor is invalid or expired");
      conditions.push("(sort_order > ? OR (sort_order = ? AND (normalized_name > ? OR (normalized_name = ? AND id > ?))))");
      params.push(cursorRow.sort_order, cursorRow.sort_order, cursorRow.normalized_name, cursorRow.normalized_name, cursorId);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const totalWhere = options.includeArchived === true ? "" : "WHERE archived = 0";
    const count = this.database.get<SqliteRow>(`SELECT COUNT(*) AS count FROM inventory_categories ${totalWhere}`);
    const total = typeof count?.count === "number" ? count.count : 0;
    const rows = this.database.all<SqliteRow>(`SELECT * FROM inventory_categories ${where} ORDER BY sort_order, normalized_name, id LIMIT ?`, [...params, limit + 1]);
    const values = rows.slice(0, limit).map(categoryFromRow);
    const last = values.at(-1);
    return {
      data: values,
      limit,
      total,
      ...(rows.length > limit && last !== undefined ? { nextCursor: encodeCursor(last.id) } : {}),
    };
  }

  public update(id: string, changes: UpdateInventoryCategory, expected: number): InventoryCategory {
    const current = this.get(id);
    if (current === undefined) throw new DomainError("category_not_found", `inventory category ${id} does not exist`);
    const expectedValue = expectedVersion(expected);
    if (current.version !== expectedValue) conflict(id, expectedValue, current.version);
    const parentId = current.parentId;
    const name = changes.name === undefined ? current.name : normalizeInventoryCategoryName(changes.name);
    assertInventoryCategoryName(name);
    const updated: InventoryCategory = {
      ...current,
      name,
      ...(parentId === undefined ? {} : { parentId }),
      sortOrder: changes.sortOrder ?? current.sortOrder,
      updatedAt: nowIso(),
      version: current.version + 1,
    };
    try {
      this.database.run("UPDATE inventory_categories SET name = ?, normalized_name = ?, parent_id = ?, sort_order = ?, updated_at = ?, version = ? WHERE id = ? AND version = ?", [updated.name, normalizeInventoryCategoryKey(updated.name), updated.parentId ?? null, updated.sortOrder, updated.updatedAt, updated.version, id, expectedValue]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError("duplicate_category", `duplicate category name: '${name}' already exists beside this category`);
      throw error;
    }
    if (this.get(id)?.version !== updated.version) conflict(id, expectedValue, this.get(id)?.version ?? expectedValue);
    return updated;
  }

  public archive(id: string, expected: number): InventoryCategory {
    const current = this.get(id);
    if (current === undefined) throw new DomainError("category_not_found", `inventory category ${id} does not exist`);
    const expectedValue = expectedVersion(expected);
    if (current.version !== expectedValue) conflict(id, expectedValue, current.version);
    const children = this.database.all<SqliteRow>("SELECT id FROM inventory_categories WHERE parent_id = ? AND archived = 0 LIMIT 1", [id]);
    if (children.length > 0) throw new DomainError("category_has_children", `inventory category ${id} has active subcategories`);
    const ids = [id];
    const marks = ids.map(() => "?").join(",");
    const references = this.database.get<SqliteRow>(`SELECT a.item_id FROM inventory_item_category_assignments a JOIN inventory_items i ON i.id = a.item_id WHERE i.retired_at IS NULL AND a.category_node_id IN (${marks}) LIMIT 1`, ids);
    if (references !== undefined) throw new DomainError("category_in_use", `inventory category ${id} is referenced by active inventory`);
    const updatedAt = nowIso();
    this.database.run("UPDATE inventory_categories SET archived = 1, updated_at = ?, version = ? WHERE id = ? AND version = ?", [updatedAt, current.version + 1, id, expectedValue]);
    if (this.get(id)?.version !== current.version + 1) conflict(id, expectedValue, this.get(id)?.version ?? expectedValue);
    return { ...current, archived: true, updatedAt, version: current.version + 1 };
  }

  public getItemCategoryNode(itemId: string): string | undefined {
    const row = this.database.get<SqliteRow>("SELECT category_node_id FROM inventory_item_category_assignments WHERE item_id = ?", [itemId]);
    return typeof row?.category_node_id === "string" ? row.category_node_id : undefined;
  }

  public setItemCategoryNode(itemId: string, categoryNodeId: string | undefined, assignedAt = nowIso()): void {
    if (categoryNodeId === undefined) {
      this.database.run("DELETE FROM inventory_item_category_assignments WHERE item_id = ?", [itemId]);
      return;
    }
    this.database.run("INSERT INTO inventory_item_category_assignments (item_id, category_node_id, assigned_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET category_node_id = excluded.category_node_id, assigned_at = excluded.assigned_at", [itemId, categoryNodeId, assignedAt]);
  }
}
