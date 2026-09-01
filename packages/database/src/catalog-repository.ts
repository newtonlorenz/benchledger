import { createHash } from "node:crypto";
import {
  artifactBuildConfigurationBindingSchema,
  buildConfigurationSnapshotSchema,
  buildConfigurationSnapshotStorageInputSchema,
  catalogProductSchema,
  createArtifactBuildConfigurationBindingSchema,
  inventoryProductProfileSchema,
  updateCatalogProductSchema,
  updateInventoryProductProfileSchema,
} from "@benchledger/api-contract";
import type {
  ArtifactBuildConfigurationBinding,
  BuildConfigurationSnapshot,
  BuildConfigurationSnapshotStorageInput,
  CatalogProduct,
  CreateArtifactBuildConfigurationBinding,
  CreateBuildConfigurationSnapshot,
  CreateCatalogProduct,
  CreateInventoryProductProfile,
  InventoryProductProfile,
} from "@benchledger/api-contract";
import { DomainError, createId } from "@benchledger/domain";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";

export interface CatalogProductListOptions {
  readonly kind?: CatalogProduct["kind"];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface InventoryProductProfileListOptions {
  readonly itemId?: string;
  readonly catalogProductId?: string;
  readonly profileType?: InventoryProductProfile["profileType"];
  readonly linkState?: InventoryProductProfile["linkState"];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface BuildConfigurationSnapshotListOptions {
  readonly projectRevisionId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ArtifactBuildConfigurationBindingListOptions {
  readonly artifactId?: string;
  readonly buildConfigurationSnapshotId?: string;
  readonly projectRevisionId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RepositoryPage<T> {
  readonly data: readonly T[];
  readonly nextCursor?: string;
  readonly limit: number;
  readonly total: number;
}

type CatalogProductPatch = Partial<CatalogProduct>;
type InventoryProductProfilePatch = Partial<InventoryProductProfile>;
type BuildConfigurationSnapshotDraft = CreateBuildConfigurationSnapshot | BuildConfigurationSnapshotStorageInput;

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new DomainError("invalid_limit", `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return value;
}

function text(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`database row ${key} is not text`);
  return value;
}

function integer(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`database row ${key} is not an integer`);
  return value;
}

function jsonObject(row: SqliteRow, key: string): unknown {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`database row ${key} is not JSON text`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`database row ${key} contains malformed JSON`);
  }
}

interface Cursor {
  readonly createdAt: string;
  readonly id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object") throw new Error("not object");
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.createdAt !== "string" || typeof candidate.id !== "string" || candidate.id.length === 0) throw new Error("invalid fields");
    return { createdAt: candidate.createdAt, id: candidate.id };
  } catch {
    throw new DomainError("invalid_cursor", "cursor is invalid or expired");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DomainError("invalid_snapshot", "snapshot content must contain finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
  }
  throw new DomainError("invalid_snapshot", "snapshot content contains an unsupported value");
}

/** Stable JSON is exported for audit/debug tooling and hash test vectors. */
export function deterministicJson(value: unknown): string {
  return canonicalJson(value);
}

function snapshotContent(snapshot: Partial<BuildConfigurationSnapshot>): unknown {
  const {
    id: _id,
    contentSha256: _contentSha256,
    createdAt: _createdAt,
    projectRevisionId: _projectRevisionId,
    supersedesSnapshotId: _supersedesSnapshotId,
    capturedAt: _capturedAt,
    createdBy: _createdBy,
    ...content
  } = snapshot;
  return content;
}

/** Hashes only configuration content; server metadata and the hash itself are excluded. */
export function computeBuildConfigurationContentSha256(snapshot: Partial<BuildConfigurationSnapshot>): string {
  return createHash("sha256").update(canonicalJson(snapshotContent(snapshot)), "utf8").digest("hex");
}

export const buildConfigurationSnapshotContentSha256 = computeBuildConfigurationContentSha256;
export const computeBuildConfigurationSnapshotHash = computeBuildConfigurationContentSha256;

function expectedVersion(value: number | undefined, fallback?: number): number {
  const result = value ?? fallback;
  if (result === undefined || !Number.isInteger(result) || result < 1) {
    throw new DomainError("invalid_version", "expected version must be a positive integer");
  }
  return result;
}

function conflict(entity: string, id: string, expected: number, actual: number): never {
  throw new DomainError("version_conflict", `${entity} ${id} changed since version ${expected} was read (current version ${actual})`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseCatalogProduct(row: SqliteRow): CatalogProduct {
  const product = catalogProductSchema.parse(jsonObject(row, "payload_json"));
  if (product.id !== text(row, "id") || product.kind !== text(row, "kind") || product.version !== integer(row, "version") || product.createdAt !== text(row, "created_at") || product.updatedAt !== text(row, "updated_at")) {
    throw new Error(`catalog product ${product.id} metadata is inconsistent`);
  }
  return product;
}

const FILAMENT_FACT_FIELDS = [
  "manufacturer",
  "productName",
  "sku",
  "materialFamily",
  "materialSubtype",
  "colourName",
  "colourCode",
  "diameterMm",
  "nominalNetMassG",
  "nominalLengthM",
  "lengthBasis",
  "densityGcm3",
] as const;

const PRINTER_FACT_FIELDS = [
  "manufacturer",
  "exactModel",
  "exactVariant",
  "technology",
  "buildVolumeMm",
] as const;

function sameCatalogFact(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  return canonicalJson(left) === canonicalJson(right);
}

/** A corrected identity/specification fact invalidates the old verification. */
function catalogFactsChanged(current: CatalogProduct, changes: Record<string, unknown>): boolean {
  const currentRecord = current as unknown as Record<string, unknown>;
  const fields = current.kind === "filament" ? FILAMENT_FACT_FIELDS : PRINTER_FACT_FIELDS;
  return fields.some((field) => Object.hasOwn(changes, field) && !sameCatalogFact(currentRecord[field], changes[field]));
}

function parseInventoryProductProfile(row: SqliteRow): InventoryProductProfile {
  const profile = inventoryProductProfileSchema.parse({
    id: text(row, "id"),
    itemId: text(row, "item_id"),
    catalogProductId: text(row, "catalog_product_id"),
    profileType: text(row, "profile_type"),
    linkState: text(row, "link_state"),
    details: jsonObject(row, "details_json"),
    version: integer(row, "version"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at")
  });
  return profile;
}

function parseBuildConfigurationSnapshot(row: SqliteRow): BuildConfigurationSnapshot {
  const snapshot = buildConfigurationSnapshotSchema.parse(jsonObject(row, "payload_json"));
  const storedHash = text(row, "content_sha256");
  if (snapshot.contentSha256 !== storedHash) throw new Error(`snapshot ${snapshot.id} hash is inconsistent`);
  if (computeBuildConfigurationContentSha256(snapshot) !== snapshot.contentSha256) {
    throw new Error(`snapshot ${snapshot.id} content hash does not match its configuration`);
  }
  return snapshot;
}

function parseBinding(row: SqliteRow): ArtifactBuildConfigurationBinding {
  return artifactBuildConfigurationBindingSchema.parse({
    id: text(row, "id"),
    artifactId: text(row, "artifact_id"),
    buildConfigurationSnapshotId: text(row, "build_configuration_snapshot_id"),
    projectRevisionId: text(row, "project_revision_id"),
    createdAt: text(row, "created_at")
  });
}

export class CatalogProductRepository {
  public constructor(private readonly database: BenchDatabase) {}

  public create(product: CatalogProduct | CreateCatalogProduct & { readonly id?: string; readonly createdAt?: string; readonly updatedAt?: string; readonly version?: number }): CatalogProduct {
    const candidate = product as Record<string, unknown>;
    const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : nowIso();
    const parsed = catalogProductSchema.parse({
      ...candidate,
      id: candidate.id ?? createId("catalog"),
      createdAt,
      updatedAt: candidate.updatedAt ?? createdAt,
      version: candidate.version ?? 1
    });
    if (parsed.version !== 1) throw new DomainError("invalid_version", "new catalog products must start at version 1");
    this.database.run(
      "INSERT INTO catalog_products (id, kind, payload_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [parsed.id, parsed.kind, JSON.stringify(parsed), parsed.version, parsed.createdAt, parsed.updatedAt]
    );
    return parsed;
  }

  public get(id: string): CatalogProduct | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM catalog_products WHERE id = ?", [id]);
    return row === undefined ? undefined : parseCatalogProduct(row);
  }

  public list(options: CatalogProductListOptions = {}): RepositoryPage<CatalogProduct> {
    const limit = pageLimit(options.limit);
    const cursor = decodeCursor(options.cursor);
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (options.kind !== undefined) {
      conditions.push("kind = ?");
      params.push(options.kind);
    }
    if (cursor !== undefined) {
      conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const totalWhere = options.kind === undefined ? "" : "WHERE kind = ?";
    const totalParams = options.kind === undefined ? [] : [options.kind];
    const countRow = this.database.get<SqliteRow>(`SELECT COUNT(*) AS count FROM catalog_products ${totalWhere}`, totalParams);
    const total = typeof countRow?.count === "number" ? countRow.count : 0;
    const rows = this.database.all<SqliteRow>(`SELECT * FROM catalog_products ${where} ORDER BY created_at, id LIMIT ?`, [...params, limit + 1]);
    const hasMore = rows.length > limit;
    const values = rows.slice(0, limit).map(parseCatalogProduct);
    const last = values.at(-1);
    return {
      data: values,
      limit,
      total,
      ...(hasMore && last !== undefined ? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) } : {})
    };
  }

  public listAll(options: Omit<CatalogProductListOptions, "limit" | "cursor"> = {}): readonly CatalogProduct[] {
    const values: CatalogProduct[] = [];
    let cursor: string | undefined;
    do {
      const page = cursor === undefined
        ? this.list({ ...options, limit: MAX_PAGE_LIMIT })
        : this.list({ ...options, limit: MAX_PAGE_LIMIT, cursor });
      values.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return values;
  }

  public update(id: string, changes: CatalogProductPatch, expected: number): CatalogProduct;
  public update(id: string, expected: number, changes: CatalogProductPatch): CatalogProduct;
  public update(product: CatalogProduct, expected?: number): CatalogProduct;
  public update(idOrProduct: string | CatalogProduct, changesOrExpected: unknown, expectedOrChanges?: unknown): CatalogProduct {
    const current = typeof idOrProduct === "string" ? this.get(idOrProduct) : this.get(idOrProduct.id);
    const id = typeof idOrProduct === "string" ? idOrProduct : idOrProduct.id;
    if (current === undefined) throw new DomainError("catalog_product_not_found", `catalog product ${id} does not exist`);
    const changes: CatalogProductPatch = typeof changesOrExpected === "number" ? (expectedOrChanges as CatalogProductPatch) : changesOrExpected as CatalogProductPatch;
    const expected: number | undefined = typeof changesOrExpected === "number"
      ? changesOrExpected
      : (typeof expectedOrChanges === "number" ? expectedOrChanges : typeof idOrProduct === "string" ? undefined : idOrProduct.version);
    const expectedValue = expectedVersion(expected);
    if (current.version !== expectedValue) conflict("catalog product", id, expectedValue, current.version);
    if (changes === undefined || typeof changes !== "object") throw new DomainError("invalid_update", "catalog product changes are required");
    const changedRecord = changes as Record<string, unknown>;
    if (changedRecord.id !== undefined && changedRecord.id !== id) throw new DomainError("invalid_update", "catalog product id cannot change");
    if (changedRecord.kind !== undefined && changedRecord.kind !== current.kind) throw new DomainError("invalid_update", "catalog product kind cannot change");
    const mergedCandidate = {
      ...current,
      ...changedRecord,
      id,
      kind: current.kind,
      createdAt: current.createdAt,
      updatedAt: changedRecord.updatedAt ?? nowIso(),
      version: current.version + 1
    };
    const merged = catalogFactsChanged(current, changedRecord)
      ? Object.fromEntries(Object.entries(mergedCandidate).filter(([key]) => key !== "provenance"))
      : mergedCandidate;
    const parsed = catalogProductSchema.parse(merged);
    const result = this.database.run(
      "UPDATE catalog_products SET payload_json = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
      [JSON.stringify(parsed), parsed.version, parsed.updatedAt, id, expectedValue]
    ) as { changes?: number | bigint };
    if (typeof result?.changes === "number" ? result.changes !== 1 : typeof result?.changes === "bigint" ? result.changes !== 1n : this.get(id)?.version !== parsed.version) {
      const actual = this.get(id)?.version ?? expectedValue;
      conflict("catalog product", id, expectedValue, actual);
    }
    return parsed;
  }

  public updateCatalogProduct(id: string, changes: CatalogProductPatch, expectedVersion: number): CatalogProduct {
    return this.update(id, changes, expectedVersion);
  }
}

export class InventoryProductProfileRepository {
  public constructor(private readonly database: BenchDatabase, private readonly products = new CatalogProductRepository(database)) {}

  private assertReferences(profile: InventoryProductProfile): void {
    if (this.database.get("SELECT id FROM inventory_items WHERE id = ?", [profile.itemId]) === undefined) {
      throw new DomainError("inventory_not_found", `inventory item ${profile.itemId} does not exist`);
    }
    const product = this.products.get(profile.catalogProductId);
    if (product === undefined) throw new DomainError("catalog_product_not_found", `catalog product ${profile.catalogProductId} does not exist`);
    const expectedKind = profile.profileType === "filament_spool" ? "filament" : "printer";
    if (product.kind !== expectedKind) throw new DomainError("profile_product_mismatch", `${profile.profileType} requires a ${expectedKind} catalog product`);
  }

  public create(profile: InventoryProductProfile | CreateInventoryProductProfile & { readonly id?: string; readonly createdAt?: string; readonly updatedAt?: string; readonly version?: number }): InventoryProductProfile {
    const candidate = profile as Record<string, unknown>;
    const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : nowIso();
    const parsed = inventoryProductProfileSchema.parse({
      ...candidate,
      id: candidate.id ?? createId("profile"),
      createdAt,
      updatedAt: candidate.updatedAt ?? createdAt,
      version: candidate.version ?? 1
    });
    if (parsed.version !== 1) throw new DomainError("invalid_version", "new inventory profiles must start at version 1");
    this.assertReferences(parsed);
    this.database.run(
      "INSERT INTO inventory_product_profiles (id, item_id, catalog_product_id, profile_type, link_state, details_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [parsed.id, parsed.itemId, parsed.catalogProductId, parsed.profileType, parsed.linkState, JSON.stringify(parsed.details), parsed.version, parsed.createdAt, parsed.updatedAt]
    );
    return parsed;
  }

  public get(id: string): InventoryProductProfile | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM inventory_product_profiles WHERE id = ?", [id]);
    return row === undefined ? undefined : parseInventoryProductProfile(row);
  }

  public list(options: InventoryProductProfileListOptions = {}): RepositoryPage<InventoryProductProfile> {
    const limit = pageLimit(options.limit);
    const cursor = decodeCursor(options.cursor);
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    for (const [column, value] of [["item_id", options.itemId], ["catalog_product_id", options.catalogProductId], ["profile_type", options.profileType], ["link_state", options.linkState]] as const) {
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value as string);
      }
    }
    if (cursor !== undefined) {
      conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const filterPairs = [["item_id", options.itemId], ["catalog_product_id", options.catalogProductId], ["profile_type", options.profileType], ["link_state", options.linkState]] as const;
    const totalConditions = filterPairs.filter((pair) => pair[1] !== undefined);
    const totalWhere = totalConditions.length === 0 ? "" : `WHERE ${totalConditions.map(([column]) => `${column} = ?`).join(" AND ")}`;
    const countRow = this.database.get<SqliteRow>(`SELECT COUNT(*) AS count FROM inventory_product_profiles ${totalWhere}`, totalConditions.flatMap(([, value]) => value === undefined ? [] : [value]));
    const total = typeof countRow?.count === "number" ? countRow.count : 0;
    const rows = this.database.all<SqliteRow>(`SELECT * FROM inventory_product_profiles ${where} ORDER BY created_at, id LIMIT ?`, [...params, limit + 1]);
    const hasMore = rows.length > limit;
    const values = rows.slice(0, limit).map(parseInventoryProductProfile);
    const last = values.at(-1);
    return { data: values, limit, total, ...(hasMore && last !== undefined ? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) } : {}) };
  }

  public listAll(options: Omit<InventoryProductProfileListOptions, "limit" | "cursor"> = {}): readonly InventoryProductProfile[] {
    const values: InventoryProductProfile[] = [];
    let cursor: string | undefined;
    do {
      const page = cursor === undefined
        ? this.list({ ...options, limit: MAX_PAGE_LIMIT })
        : this.list({ ...options, limit: MAX_PAGE_LIMIT, cursor });
      values.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return values;
  }

  public update(id: string, changes: InventoryProductProfilePatch, expected: number): InventoryProductProfile;
  public update(id: string, expected: number, changes: InventoryProductProfilePatch): InventoryProductProfile;
  public update(profile: InventoryProductProfile, expected?: number): InventoryProductProfile;
  public update(idOrProfile: string | InventoryProductProfile, changesOrExpected: unknown, expectedOrChanges?: unknown): InventoryProductProfile {
    const id = typeof idOrProfile === "string" ? idOrProfile : idOrProfile.id;
    const current = this.get(id);
    if (current === undefined) throw new DomainError("inventory_product_profile_not_found", `inventory profile ${id} does not exist`);
    const changes: InventoryProductProfilePatch = typeof changesOrExpected === "number" ? expectedOrChanges as InventoryProductProfilePatch : changesOrExpected as InventoryProductProfilePatch;
    const expected: number | undefined = typeof changesOrExpected === "number"
      ? changesOrExpected
      : (typeof expectedOrChanges === "number" ? expectedOrChanges : typeof idOrProfile === "string" ? undefined : idOrProfile.version);
    const expectedValue = expectedVersion(expected);
    if (current.version !== expectedValue) conflict("inventory profile", id, expectedValue, current.version);
    if (changes === undefined || typeof changes !== "object") throw new DomainError("invalid_update", "inventory profile changes are required");
    const changedRecord = changes as Record<string, unknown>;
    if (changedRecord.id !== undefined && changedRecord.id !== id) throw new DomainError("invalid_update", "inventory profile id cannot change");
    if (changedRecord.itemId !== undefined && changedRecord.itemId !== current.itemId) throw new DomainError("invalid_update", "inventory profile itemId cannot change");
    if (changedRecord.profileType !== undefined && changedRecord.profileType !== current.profileType) throw new DomainError("invalid_update", "inventory profile type cannot change");
    const parsed = inventoryProductProfileSchema.parse({
      ...current,
      ...changedRecord,
      id,
      profileType: current.profileType,
      createdAt: current.createdAt,
      updatedAt: changedRecord.updatedAt ?? nowIso(),
      version: current.version + 1
    });
    this.assertReferences(parsed);
    const result = this.database.run(
      "UPDATE inventory_product_profiles SET catalog_product_id = ?, link_state = ?, details_json = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
      [parsed.catalogProductId, parsed.linkState, JSON.stringify(parsed.details), parsed.version, parsed.updatedAt, id, expectedValue]
    ) as { changes?: number | bigint };
    if (typeof result?.changes === "number" ? result.changes !== 1 : typeof result?.changes === "bigint" ? result.changes !== 1n : this.get(id)?.version !== parsed.version) {
      const actual = this.get(id)?.version ?? expectedValue;
      conflict("inventory profile", id, expectedValue, actual);
    }
    return parsed;
  }

  public updateInventoryProductProfile(id: string, changes: InventoryProductProfilePatch, expectedVersion: number): InventoryProductProfile {
    return this.update(id, changes, expectedVersion);
  }
}

export class BuildConfigurationSnapshotRepository {
  private readonly clock: () => string;

  public constructor(private readonly database: BenchDatabase, options: { readonly clock?: () => string } = {}) {
    this.clock = options.clock ?? nowIso;
  }

  public create(input: BuildConfigurationSnapshotDraft | (Omit<BuildConfigurationSnapshot, "contentSha256"> & { readonly contentSha256?: never })): BuildConfigurationSnapshot {
    const candidate = input as Record<string, unknown>;
    if (candidate.contentSha256 !== undefined || candidate.createdAt !== undefined) {
      throw new DomainError("invalid_snapshot", "snapshot hash and timestamp are server-owned");
    }
    // The public create schema is reference-only. Internal adapters pass the
    // service-enriched storage shape so copied evidence is persisted exactly
    // as resolved by the service, never as client-supplied authority.
    const parsedInput = buildConfigurationSnapshotStorageInputSchema.parse(input);
    const id = typeof candidate.id === "string" ? candidate.id : createId("build-config");
    const createdAt = this.clock();
    if (!Number.isFinite(Date.parse(createdAt))) throw new DomainError("invalid_timestamp", "snapshot clock must return an ISO timestamp");
    const supersedesSnapshotId = parsedInput.supersedesSnapshotId;
    if (supersedesSnapshotId !== undefined) {
      const predecessor = this.get(supersedesSnapshotId);
      if (predecessor === undefined) throw new DomainError("snapshot_not_found", `superseded snapshot ${supersedesSnapshotId} does not exist`);
      if (predecessor.projectRevisionId !== parsedInput.projectRevisionId) throw new DomainError("snapshot_ancestry_conflict", "superseded snapshot belongs to another project revision");
      if (predecessor.id === id) throw new DomainError("snapshot_ancestry_conflict", "snapshot cannot supersede itself");
    }
    const contentSha256 = computeBuildConfigurationContentSha256(parsedInput as unknown as Partial<BuildConfigurationSnapshot>);
    const snapshot = buildConfigurationSnapshotSchema.parse({ ...parsedInput, id, createdAt, contentSha256 });
    if (this.database.get("SELECT id FROM project_revisions WHERE id = ?", [snapshot.projectRevisionId]) === undefined) {
      throw new DomainError("project_revision_not_found", `project revision ${snapshot.projectRevisionId} does not exist`);
    }
    this.database.run(
      "INSERT INTO build_configuration_snapshots (id, project_revision_id, payload_json, content_sha256, supersedes_snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [snapshot.id, snapshot.projectRevisionId, JSON.stringify(snapshot), snapshot.contentSha256, snapshot.supersedesSnapshotId ?? null, snapshot.createdAt]
    );
    return snapshot;
  }

  public get(id: string): BuildConfigurationSnapshot | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM build_configuration_snapshots WHERE id = ?", [id]);
    if (row === undefined) return undefined;
    const snapshot = parseBuildConfigurationSnapshot(row);
    if (snapshot.projectRevisionId !== text(row, "project_revision_id")) throw new Error(`snapshot ${id} ancestry is inconsistent`);
    return snapshot;
  }

  public list(options: BuildConfigurationSnapshotListOptions = {}): RepositoryPage<BuildConfigurationSnapshot> {
    const limit = pageLimit(options.limit);
    const cursor = decodeCursor(options.cursor);
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (options.projectRevisionId !== undefined) {
      conditions.push("project_revision_id = ?");
      params.push(options.projectRevisionId);
    }
    if (cursor !== undefined) {
      conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const totalWhere = options.projectRevisionId === undefined ? "" : "WHERE project_revision_id = ?";
    const countRow = this.database.get<SqliteRow>(`SELECT COUNT(*) AS count FROM build_configuration_snapshots ${totalWhere}`, options.projectRevisionId === undefined ? [] : [options.projectRevisionId]);
    const total = typeof countRow?.count === "number" ? countRow.count : 0;
    const rows = this.database.all<SqliteRow>(`SELECT * FROM build_configuration_snapshots ${where} ORDER BY created_at, id LIMIT ?`, [...params, limit + 1]);
    const hasMore = rows.length > limit;
    const values = rows.slice(0, limit).map(parseBuildConfigurationSnapshot);
    const last = values.at(-1);
    return { data: values, limit, total, ...(hasMore && last !== undefined ? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) } : {}) };
  }

  /**
   * Read the newest snapshot directly from the indexed revision stream.
   *
   * A normal list is intentionally ascending for cursor stability and may be
   * bounded to 200 rows. Callers rendering a current workspace must not infer
   * "latest" from that first page once a revision has more snapshots.
   */
  public latest(projectRevisionId: string): BuildConfigurationSnapshot | undefined {
    const row = this.database.get<SqliteRow>(
      "SELECT * FROM build_configuration_snapshots WHERE project_revision_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      [projectRevisionId],
    );
    return row === undefined ? undefined : parseBuildConfigurationSnapshot(row);
  }

  public update(_id: string, _changes: unknown): never {
    throw new DomainError("immutable_snapshot", "build configuration snapshots cannot be updated; create a superseding snapshot");
  }

  public delete(_id: string): never {
    throw new DomainError("immutable_snapshot", "build configuration snapshots cannot be deleted");
  }
}

export class ArtifactBuildConfigurationBindingRepository {
  private readonly clock: () => string;

  public constructor(private readonly database: BenchDatabase, private readonly snapshots = new BuildConfigurationSnapshotRepository(database), options: { readonly clock?: () => string } = {}) {
    this.clock = options.clock ?? nowIso;
  }

  public create(input: CreateArtifactBuildConfigurationBinding | ArtifactBuildConfigurationBinding): ArtifactBuildConfigurationBinding {
    const candidate = input as Record<string, unknown>;
    const parsedInput = createArtifactBuildConfigurationBindingSchema.parse({ ...candidate });
    const snapshot = this.snapshots.get(parsedInput.buildConfigurationSnapshotId);
    if (snapshot === undefined) throw new DomainError("snapshot_not_found", `snapshot ${parsedInput.buildConfigurationSnapshotId} does not exist`);
    if (parsedInput.projectRevisionId !== undefined && parsedInput.projectRevisionId !== snapshot.projectRevisionId) {
      throw new DomainError("binding_ancestry_conflict", "artifact binding revision does not match snapshot revision");
    }
    const id = typeof candidate.id === "string" ? candidate.id : createId("artifact-binding");
    const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : this.clock();
    const binding = artifactBuildConfigurationBindingSchema.parse({
      ...parsedInput,
      id,
      projectRevisionId: snapshot.projectRevisionId,
      createdAt
    });
    this.database.run(
      "INSERT INTO artifact_build_configuration_bindings (id, artifact_id, build_configuration_snapshot_id, project_revision_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [binding.id, binding.artifactId, binding.buildConfigurationSnapshotId, binding.projectRevisionId ?? snapshot.projectRevisionId, binding.createdAt]
    );
    return binding;
  }

  public get(id: string): ArtifactBuildConfigurationBinding | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM artifact_build_configuration_bindings WHERE id = ?", [id]);
    return row === undefined ? undefined : parseBinding(row);
  }

  public list(options: ArtifactBuildConfigurationBindingListOptions = {}): RepositoryPage<ArtifactBuildConfigurationBinding> {
    const limit = pageLimit(options.limit);
    const cursor = decodeCursor(options.cursor);
    const filters = [["artifact_id", options.artifactId], ["build_configuration_snapshot_id", options.buildConfigurationSnapshotId], ["project_revision_id", options.projectRevisionId]] as const;
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    for (const [column, value] of filters) {
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (cursor !== undefined) {
      conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const totalFilters = filters.filter((pair) => pair[1] !== undefined);
    const totalWhere = totalFilters.length === 0 ? "" : `WHERE ${totalFilters.map(([column]) => `${column} = ?`).join(" AND ")}`;
    const countRow = this.database.get<SqliteRow>(`SELECT COUNT(*) AS count FROM artifact_build_configuration_bindings ${totalWhere}`, totalFilters.flatMap(([, value]) => value === undefined ? [] : [value]));
    const total = typeof countRow?.count === "number" ? countRow.count : 0;
    const rows = this.database.all<SqliteRow>(`SELECT * FROM artifact_build_configuration_bindings ${where} ORDER BY created_at, id LIMIT ?`, [...params, limit + 1]);
    const hasMore = rows.length > limit;
    const values = rows.slice(0, limit).map(parseBinding);
    const last = values.at(-1);
    return { data: values, limit, total, ...(hasMore && last !== undefined ? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) } : {}) };
  }

  public delete(_id: string): never {
    throw new DomainError("immutable_binding", "artifact build configuration bindings cannot be deleted");
  }
}

/** Aggregate alias for callers that want one v2 catalog gateway. */
export class CanonicalCatalogRepository {
  public readonly products: CatalogProductRepository;
  public readonly profiles: InventoryProductProfileRepository;
  public readonly snapshots: BuildConfigurationSnapshotRepository;
  public readonly bindings: ArtifactBuildConfigurationBindingRepository;

  public constructor(database: BenchDatabase) {
    this.products = new CatalogProductRepository(database);
    this.profiles = new InventoryProductProfileRepository(database, this.products);
    this.snapshots = new BuildConfigurationSnapshotRepository(database);
    this.bindings = new ArtifactBuildConfigurationBindingRepository(database, this.snapshots);
  }
}

export const CatalogRepository = CanonicalCatalogRepository;
