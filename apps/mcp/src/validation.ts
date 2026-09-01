import { McpAdapterError } from "./errors.js";
import {
  createBuildConfigurationSnapshotSchema,
  createCatalogProductSchema,
  createInventoryProductProfileWithoutItemSchema,
  createInventoryProductProfileSchema,
  createInventoryCategorySchema,
  updateInventoryCategorySchema,
  updateCatalogProductSchema,
  updateInventoryProductProfileSchema,
  saveReconciliationDraftSchema,
  commitReconciliationSchema,
} from "@benchledger/api-contract";
import { BOM_CONSTRAINT_KEYS } from "./types.js";
import type {
  Availability,
  BomAlternative,
  BeginArtifactUploadInput,
  BomEvaluationInput,
  BomLineCreateInput,
  BomLineListInput,
  BomLineUpdateInput,
  ContextRefreshInput,
  BuildConfigurationCreateInput,
  BuildConfigurationListInput,
  BuildConfigurationReadInput,
  CatalogProductCreateInput,
  CatalogProductSearchInput,
  CatalogProductUpdateInput,
  Dimensions,
  EvidenceSummary,
  ExternalLink,
  FinalizeArtifactUploadInput,
  InventoryCreateInput,
  InventoryListInput,
  InventoryUpdateInput,
  InventoryProductProfileLinkInput,
  InventoryProductProfileReadInput,
  InventoryWithProductProfileCreateInput,
  InventoryCategoryCreateInput,
  InventoryCategoryUpdateInput,
  ReconciliationReadInput,
  ReconciliationDraftSaveInput,
  ReconciliationCommitInput,
  JsonObject,
  JsonValue,
  OfferListInput,
  PageInput,
  ProjectCreateInput,
  ProjectWithInitialRevisionCreateInput,
  ProjectListInput,
  ProjectRevisionCreateInput,
  ProjectUpdateInput,
  Quantity,
  RecordOfferSnapshotInput,
  RecordStockEventInput,
  ReleaseReservationInput,
  ReservationInput,
  RetireArtifactInput,
  Scope,
  StockEventKind,
  StockEventsInput,
  UsageInput,
  WorkItemCreateInput,
  WorkItemRevisionCreateInput,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new McpAdapterError("INVALID_ARGUMENT", message);
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function keys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${label} contains unknown field '${key}'.`);
  }
}

function stringValue(value: unknown, label: string, options: { min?: number; max?: number } = {}): string {
  if (typeof value !== "string") fail(`${label} must be a string.`);
  const min = options.min ?? 1;
  const max = options.max ?? 512;
  if (value.length < min || value.length > max) fail(`${label} must be between ${min} and ${max} characters.`);
  return value;
}

function optionalString(value: unknown, label: string, max = 4096): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, label, { max });
}

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label} must be a safe integer between ${min} and ${max}.`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string, min = 0, max = 1_000_000_000_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${label} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return integer(value, label);
}

function enumValue<T extends string>(value: unknown, label: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(`${label} must be one of: ${values.join(", ")}.`);
  }
  return value as T;
}

function optionalEnum<T extends string>(value: unknown, label: string, values: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  return enumValue(value, label, values);
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const categoryIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function id(value: unknown, label: string): string {
  const result = stringValue(value, label, { max: 128 });
  if (!idPattern.test(result)) fail(`${label} must be a stable identifier without path separators.`);
  return result;
}

/** Managed taxonomy IDs have a 160-character API limit; unrelated MCP IDs
 * intentionally retain the narrower 128-character contract above. */
export function categoryId(value: unknown, label: string): string {
  const result = stringValue(value, label, { max: 160 });
  if (!categoryIdPattern.test(result)) fail(`${label} must be a stable category identifier without path separators.`);
  return result;
}

export function singleId(value: unknown, field: string): string {
  const input = record(value, "arguments");
  keys(input, [field], "arguments");
  return id(input[field], `arguments.${field}`);
}

export function categorySingleId(value: unknown, field: string): string {
  const input = record(value, "arguments");
  keys(input, [field], "arguments");
  return categoryId(input[field], `arguments.${field}`);
}

export function retireProject(value: unknown): { projectId: string; expectedVersion?: number } {
  const input = record(value, "arguments");
  keys(input, ["projectId", "expectedVersion"], "arguments");
  const result: { projectId: string; expectedVersion?: number } = { projectId: id(input.projectId, "arguments.projectId") };
  const version = optionalInteger(input.expectedVersion, "arguments.expectedVersion");
  if (version !== undefined) result.expectedVersion = version;
  return result;
}

export function retireBomLine(value: unknown): { bomLineId: string; expectedVersion?: number } {
  const input = record(value, "arguments");
  keys(input, ["bomLineId", "expectedVersion"], "arguments");
  const result: { bomLineId: string; expectedVersion?: number } = { bomLineId: id(input.bomLineId, "arguments.bomLineId") };
  const version = optionalInteger(input.expectedVersion, "arguments.expectedVersion");
  if (version !== undefined) result.expectedVersion = version;
  return result;
}

export function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return id(value, label);
}

export function parsePageInput(value: unknown, label = "arguments", maxCursor = 200): PageInput {
  const input = record(value ?? {}, label);
  keys(input, ["limit", "cursor"], label);
  const limit = input.limit === undefined ? 25 : integer(input.limit, `${label}.limit`, 1, 100);
  const cursor = optionalString(input.cursor, `${label}.cursor`, maxCursor);
  return cursor === undefined ? { limit } : { limit, cursor };
}

type SchemaLike<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly unknown[] } } };

function canonicalSchema<T>(schema: SchemaLike<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(`${label} is invalid.`);
  return parsed.data;
}

const catalogProductUpdateKeys = [
  "kind", "manufacturer", "productName", "sku", "materialFamily", "materialSubtype", "colourName", "colourCode",
  "diameterMm", "nominalNetMassG", "nominalLengthM", "lengthBasis", "densityGcm3", "exactModel", "exactVariant",
  "technology", "buildVolumeMm",
] as const;

/** Search is bounded at the MCP boundary before the application sees it. */
export function catalogProductSearch(value: unknown): CatalogProductSearchInput {
  const input = record(value ?? {}, "arguments");
  keys(input, ["limit", "cursor", "query", "kind"], "arguments");
  const page = parsePageInput({ limit: input.limit, cursor: input.cursor });
  const query = optionalString(input.query, "arguments.query", 200);
  if (query !== undefined && query.trim().length === 0) fail("arguments.query must not be blank.");
  return {
    ...page,
    ...(query === undefined ? {} : { query: query.trim() }),
    kind: optionalEnum(input.kind, "arguments.kind", ["filament", "printer"] as const),
  };
}

export function catalogProductCreate(value: unknown): CatalogProductCreateInput {
  return canonicalSchema(createCatalogProductSchema, record(value, "arguments"), "arguments");
}

export function catalogProductUpdate(value: unknown): CatalogProductUpdateInput {
  const input = record(value, "arguments");
  keys(input, ["productId", "expectedVersion", ...catalogProductUpdateKeys], "arguments");
  const productId = id(input.productId, "arguments.productId");
  const expectedVersion = optionalInteger(input.expectedVersion, "arguments.expectedVersion");
  const changes: UnknownRecord = { ...input };
  delete changes.productId;
  delete changes.expectedVersion;
  const parsed = canonicalSchema(updateCatalogProductSchema, changes, "arguments");
  if (Object.keys(changes).length === 0) fail("arguments must contain at least one catalog product change.");
  return { productId, ...(expectedVersion === undefined ? {} : { expectedVersion }), ...parsed } as CatalogProductUpdateInput;
}

export function inventoryProductProfileRead(value: unknown): InventoryProductProfileReadInput {
  return { itemId: singleId(value, "itemId") };
}

export function inventoryProductProfileLink(value: unknown): InventoryProductProfileLinkInput {
  const input = record(value, "arguments");
  keys(input, ["itemId", "expectedVersion", "catalogProductId", "linkState", "profileType", "details"], "arguments");
  const itemId = id(input.itemId, "arguments.itemId");
  const expectedVersion = optionalInteger(input.expectedVersion, "arguments.expectedVersion");
  const candidate: UnknownRecord = { ...input };
  delete candidate.itemId;
  delete candidate.expectedVersion;
  let parsed: unknown;
  const created = createInventoryProductProfileSchema.safeParse({ ...candidate, itemId });
  if (created.success) parsed = created.data;
  else parsed = canonicalSchema(updateInventoryProductProfileSchema, candidate, "arguments");
  return { ...(parsed as UnknownRecord), itemId, ...(expectedVersion === undefined ? {} : { expectedVersion }) } as InventoryProductProfileLinkInput;
}

export function buildConfigurationCreate(value: unknown): BuildConfigurationCreateInput {
  return canonicalSchema(createBuildConfigurationSnapshotSchema, record(value, "arguments"), "arguments");
}

export function buildConfigurationList(value: unknown): BuildConfigurationListInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId", "limit", "cursor"], "arguments");
  return { ...parsePageInput({ limit: input.limit, cursor: input.cursor }), projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId") };
}

export function buildConfigurationRead(value: unknown): BuildConfigurationReadInput {
  return { buildConfigurationId: singleId(value, "buildConfigurationId") };
}

export function reconciliationRead(value: unknown): ReconciliationReadInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId"], "arguments");
  return { projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId") };
}

/** Validate the full canonical draft shape, including all evidence-bearing outcomes. */
export function reconciliationDraftSave(value: unknown): ReconciliationDraftSaveInput {
  return canonicalSchema(saveReconciliationDraftSchema, record(value, "arguments"), "arguments");
}

/** The revision is the MCP ancestry anchor; the remaining fields use the canonical commit schema. */
export function reconciliationCommit(value: unknown): ReconciliationCommitInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId", "draftId", "expectedVersion"], "arguments");
  const projectRevisionId = id(input.projectRevisionId, "arguments.projectRevisionId");
  const command = canonicalSchema(commitReconciliationSchema, {
    draftId: input.draftId,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
  }, "arguments");
  return { projectRevisionId, ...command };
}

export function quantity(value: unknown, label: string): Quantity {
  const input = record(value, label);
  keys(input, ["value", "unit"], label);
  return {
    value: finiteNumber(input.value, `${label}.value`, 0.000001),
    unit: enumValue(input.unit, `${label}.unit`, ["piece", "gram", "millimetre", "millilitre", "metre", "roll", "set"] as const),
  };
}

function optionalQuantity(value: unknown, label: string): Quantity | undefined {
  if (value === undefined) return undefined;
  return quantity(value, label);
}

export function dimensions(value: unknown, label: string): Dimensions {
  const input = record(value, label);
  keys(input, ["length", "width", "height", "diameter", "unit", "source", "uncertainty"], label);
  const result: Dimensions = {
    unit: enumValue(input.unit, `${label}.unit`, ["millimetre", "centimetre", "metre"] as const),
  };
  for (const field of ["length", "width", "height", "diameter"] as const) {
    if (input[field] !== undefined) result[field] = finiteNumber(input[field], `${label}.${field}`, 0.000001);
  }
  result.source = optionalEnum(input.source, `${label}.source`, ["nominal", "measured", "manufacturer", "user_reported"] as const);
  if (input.uncertainty !== undefined) result.uncertainty = finiteNumber(input.uncertainty, `${label}.uncertainty`);
  return result;
}

function optionalDimensions(value: unknown, label: string): Dimensions | undefined {
  if (value === undefined) return undefined;
  return dimensions(value, label);
}

export function evidence(value: unknown, label: string): EvidenceSummary {
  const input = record(value, label);
  keys(input, ["state", "source", "recordedAt", "note"], label);
  return {
    state: enumValue(input.state, `${label}.state`, ["physical_count", "commissioned", "measured", "manufacturer", "order", "delivery", "user_reported", "inferred", "unknown"] as const),
    source: stringValue(input.source, `${label}.source`, { max: 256 }),
    recordedAt: stringValue(input.recordedAt, `${label}.recordedAt`, { max: 64 }),
    note: optionalString(input.note, `${label}.note`, 2000),
  };
}

function optionalEvidence(value: unknown, label: string): EvidenceSummary | undefined {
  if (value === undefined) return undefined;
  return evidence(value, label);
}

function httpUrl(value: unknown, label: string): string {
  const url = stringValue(value, label, { max: 2048 });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail(`${label} must use HTTP or HTTPS.`);
  return url;
}

function links(value: unknown, label: string): readonly ExternalLink[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) fail(`${label} must contain at most 20 links.`);
  return value.map((entry, index) => {
    const input = record(entry, `${label}[${index}]`);
    keys(input, ["label", "url"], `${label}[${index}]`);
    const result: ExternalLink = {
      label: stringValue(input.label, `${label}[${index}].label`, { max: 128 }),
      url: httpUrl(input.url, `${label}[${index}].url`),
    };
    return result;
  });
}

function textFields(input: UnknownRecord, label: string, output: Record<string, string | undefined>): void {
  for (const [field, max] of Object.entries({ description: 4096, manufacturer: 256, model: 256, sku: 256, location: 256 })) {
    output[field] = optionalString(input[field], `${label}.${field}`, max);
  }
}

export function inventoryList(value: unknown): InventoryListInput {
  const input = record(value ?? {}, "arguments");
  keys(input, ["limit", "cursor", "query", "category", "availability", "location"], "arguments");
  // Location filtering is applied after bounded application pages and uses a
  // compact opaque cursor that can contain a near-maximum source cursor.
  const page = parsePageInput({ limit: input.limit, cursor: input.cursor }, "arguments", 512);
  return {
    ...page,
    query: optionalString(input.query, "arguments.query", 256),
    category: optionalString(input.category, "arguments.category", 128),
    availability: optionalEnum(input.availability, "arguments.availability", ["confirmed", "inspect_first", "ordered_unverified", "delivered_uncounted", "allocated", "depleted", "retired"] satisfies readonly Availability[]),
    location: optionalString(input.location, "arguments.location", 256),
  };
}

export function inventoryCreate(value: unknown): InventoryCreateInput {
  const input = record(value, "arguments");
  keys(input, ["name", "category", "categoryNodeId", "quantity", "evidence", "description", "manufacturer", "model", "sku", "dimensions", "condition", "location", "links"], "arguments");
  const result: InventoryCreateInput = {
    name: stringValue(input.name, "arguments.name", { max: 256 }),
    category: stringValue(input.category, "arguments.category", { max: 128 }),
    quantity: quantity(input.quantity, "arguments.quantity"),
    evidence: evidence(input.evidence, "arguments.evidence"),
  };
  result.categoryNodeId = input.categoryNodeId === undefined ? undefined : categoryId(input.categoryNodeId, "arguments.categoryNodeId");
  const text = {} as Record<string, string | undefined>;
  textFields(input, "arguments", text);
  Object.assign(result, text);
  result.dimensions = optionalDimensions(input.dimensions, "arguments.dimensions");
  result.condition = optionalEnum(input.condition, "arguments.condition", ["new", "used", "opened", "unknown"] as const);
  result.links = links(input.links, "arguments.links");
  return result;
}

/** Validate the atomic inventory/profile command at the MCP boundary. */
export function inventoryWithProductProfileCreate(value: unknown): InventoryWithProductProfileCreateInput {
  const input = record(value, "arguments");
  keys(input, ["item", "profile"], "arguments");
  const item = inventoryCreate(input.item);
  const profile = canonicalSchema(createInventoryProductProfileWithoutItemSchema, record(input.profile, "arguments.profile"), "arguments.profile");
  return { item, profile };
}

export function inventoryUpdate(value: unknown): InventoryUpdateInput {
  const input = record(value, "arguments");
  keys(input, ["itemId", "expectedVersion", "name", "category", "categoryNodeId", "description", "manufacturer", "model", "sku", "dimensions", "condition", "location", "links"], "arguments");
  const result: InventoryUpdateInput = { itemId: id(input.itemId, "arguments.itemId") };
  result.expectedVersion = optionalInteger(input.expectedVersion, "arguments.expectedVersion");
  result.categoryNodeId = input.categoryNodeId === null || input.categoryNodeId === undefined
    ? input.categoryNodeId
    : categoryId(input.categoryNodeId, "arguments.categoryNodeId");
  const text = {} as Record<string, string | undefined>;
  textFields(input, "arguments", text);
  Object.assign(result, text);
  result.dimensions = optionalDimensions(input.dimensions, "arguments.dimensions");
  result.condition = optionalEnum(input.condition, "arguments.condition", ["new", "used", "opened", "unknown"] as const);
  if (input.links !== undefined) result.links = links(input.links, "arguments.links");
  return result;
}

export function inventoryCategoryList(value: unknown): PageInput & { includeArchived?: boolean } {
  const input = record(value ?? {}, "arguments");
  keys(input, ["limit", "cursor", "includeArchived"], "arguments");
  const page = parsePageInput({ limit: input.limit, cursor: input.cursor }, "arguments", 512);
  if (input.includeArchived !== undefined && typeof input.includeArchived !== "boolean") fail("arguments.includeArchived must be a boolean.");
  return { ...page, ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }) };
}

export function inventoryCategoryCreate(value: unknown): InventoryCategoryCreateInput {
  return canonicalSchema(createInventoryCategorySchema, record(value, "arguments"), "arguments");
}

export function inventoryCategoryUpdate(value: unknown): { categoryId: string; expectedVersion: number } & InventoryCategoryUpdateInput {
  const input = record(value, "arguments");
  keys(input, ["categoryId", "expectedVersion", "name", "sortOrder"], "arguments");
  const parsedCategoryId = categoryId(input.categoryId, "arguments.categoryId");
  const expectedVersion = integer(input.expectedVersion, "arguments.expectedVersion", 1);
  const changes = canonicalSchema(updateInventoryCategorySchema, { ...(input.name === undefined ? {} : { name: input.name }), ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }) }, "arguments");
  if (Object.keys(changes).length === 0) fail("arguments must contain at least one category change.");
  return { categoryId: parsedCategoryId, expectedVersion, ...changes };
}

export function inventoryCategoryArchive(value: unknown): { categoryId: string; expectedVersion: number } {
  const input = record(value, "arguments");
  keys(input, ["categoryId", "expectedVersion"], "arguments");
  const parsedCategoryId = categoryId(input.categoryId, "arguments.categoryId");
  const expectedVersion = integer(input.expectedVersion, "arguments.expectedVersion", 1);
  return { categoryId: parsedCategoryId, expectedVersion };
}

export function stockEvent(value: unknown): RecordStockEventInput {
  const input = record(value, "arguments");
  keys(input, ["itemId", "kind", "quantity", "note"], "arguments");
  const result: RecordStockEventInput = {
    itemId: id(input.itemId, "arguments.itemId"),
    kind: enumValue(input.kind, "arguments.kind", ["receipt", "count_correction", "allocation", "return", "use", "loss", "disposal"] satisfies readonly StockEventKind[]),
    quantity: quantity(input.quantity, "arguments.quantity"),
  };
  result.note = optionalString(input.note, "arguments.note", 2000);
  return result;
}

export function stockEvents(value: unknown): StockEventsInput {
  const input = record(value, "arguments");
  keys(input, ["itemId", "limit", "cursor"], "arguments");
  return { ...parsePageInput({ limit: input.limit, cursor: input.cursor }), itemId: id(input.itemId, "arguments.itemId") };
}

export function projectList(value: unknown): ProjectListInput {
  const input = record(value ?? {}, "arguments");
  keys(input, ["limit", "cursor", "query", "status"], "arguments");
  return {
    ...parsePageInput({ limit: input.limit, cursor: input.cursor }),
    query: optionalString(input.query, "arguments.query", 256),
    status: optionalEnum(input.status, "arguments.status", ["active", "paused", "complete", "retired"] as const),
  };
}

export function projectCreate(value: unknown): ProjectCreateInput {
  const input = record(value, "arguments");
  keys(input, ["name", "description"], "arguments");
  return {
    name: stringValue(input.name, "arguments.name", { max: 256 }),
    description: optionalString(input.description, "arguments.description"),
  };
}

export function projectWithInitialRevisionCreate(value: unknown): ProjectWithInitialRevisionCreateInput {
  const input = record(value, "arguments");
  keys(input, ["name", "description", "projectId", "revisionId", "revisionSummary"], "arguments");
  const result: ProjectWithInitialRevisionCreateInput = {
    name: stringValue(input.name, "arguments.name", { max: 256 }),
    description: optionalString(input.description, "arguments.description"),
    revisionSummary: optionalString(input.revisionSummary, "arguments.revisionSummary", 2000),
  };
  result.projectId = optionalId(input.projectId, "arguments.projectId");
  result.revisionId = optionalId(input.revisionId, "arguments.revisionId");
  return result;
}

export function projectUpdate(value: unknown): ProjectUpdateInput {
  const input = record(value, "arguments");
  keys(input, ["projectId", "expectedVersion", "name", "description", "status"], "arguments");
  const result: ProjectUpdateInput = { projectId: id(input.projectId, "arguments.projectId") };
  result.expectedVersion = optionalInteger(input.expectedVersion, "arguments.expectedVersion");
  result.name = optionalString(input.name, "arguments.name", 256);
  result.description = optionalString(input.description, "arguments.description");
  result.status = optionalEnum(input.status, "arguments.status", ["active", "paused", "complete", "retired"] as const);
  return result;
}

export function workItemCreate(value: unknown): WorkItemCreateInput {
  const input = record(value, "arguments");
  keys(input, ["projectId", "name", "kind", "description"], "arguments");
  return {
    projectId: id(input.projectId, "arguments.projectId"),
    name: stringValue(input.name, "arguments.name", { max: 256 }),
    kind: enumValue(input.kind, "arguments.kind", ["part", "assembly", "electronics", "firmware", "document", "other"] as const),
    description: optionalString(input.description, "arguments.description"),
  };
}

export function projectRevisionCreate(value: unknown): ProjectRevisionCreateInput {
  const input = record(value, "arguments");
  keys(input, ["projectId", "summary"], "arguments");
  return {
    projectId: id(input.projectId, "arguments.projectId"),
    summary: optionalString(input.summary, "arguments.summary"),
  };
}

export function workItemRevisionCreate(value: unknown): WorkItemRevisionCreateInput {
  const input = record(value, "arguments");
  keys(input, ["workItemId", "summary"], "arguments");
  return {
    workItemId: id(input.workItemId, "arguments.workItemId"),
    summary: optionalString(input.summary, "arguments.summary"),
  };
}

export function revisionRead(value: unknown): { revisionId: string } {
  const input = record(value, "arguments");
  keys(input, ["revisionId"], "arguments");
  return { revisionId: id(input.revisionId, "arguments.revisionId") };
}

export function bomLineList(value: unknown): BomLineListInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId", "limit", "cursor"], "arguments");
  return { ...parsePageInput({ limit: input.limit, cursor: input.cursor }), projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId") };
}

function optionalJsonObject(value: unknown, label: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  const input = record(value, label);
  return jsonObject(input, label);
}

function jsonValue(value: unknown, label: string, depth = 0): JsonValue {
  if (depth > 8) fail(`${label} is nested too deeply.`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 100) fail(`${label} contains too many values.`);
    return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`, depth + 1));
  }
  if (typeof value === "object") return jsonObject(value as UnknownRecord, label, depth + 1);
  fail(`${label} must contain JSON values only.`);
}

function jsonObject(value: UnknownRecord, label: string, depth = 0): JsonObject {
  if (depth > 8) fail(`${label} is nested too deeply.`);
  const result: JsonObject = {};
  const entries = Object.entries(value);
  if (entries.length > 100) fail(`${label} contains too many fields.`);
  for (const [key, entry] of entries) result[key] = jsonValue(entry, `${label}.${key}`, depth + 1);
  return result;
}

function optionalBomConstraints(value: unknown, label: string): BomLineCreateInput["constraints"] {
  const parsed = optionalJsonObject(value, label);
  if (parsed === undefined) return undefined;
  for (const [key, candidate] of Object.entries(parsed)) {
    if (!(BOM_CONSTRAINT_KEYS as readonly string[]).includes(key)) fail(`${label}.${key} is unsupported; use one of: ${BOM_CONSTRAINT_KEYS.join(", ")}.`);
    if (typeof candidate !== "string") fail(`${label}.${key} must be a string.`);
  }
  return parsed as BomLineCreateInput["constraints"];
}

function alternatives(value: unknown, label: string): readonly BomAlternative[] {
  if (!Array.isArray(value) || value.length > 100) fail(`${label} must be an array of at most 100 alternatives.`);
  return value.map((entry, index) => {
    const candidate = record(entry, `${label}[${index}]`);
    keys(candidate, ["itemId", "compatible", "reason"], `${label}[${index}]`);
    return {
      itemId: id(candidate.itemId, `${label}[${index}].itemId`),
      compatible: enumValue(candidate.compatible, `${label}[${index}].compatible`, ["confirmed", "conditional", "unknown"] as const),
      ...(candidate.reason === undefined ? {} : { reason: optionalString(candidate.reason, `${label}[${index}].reason`, 1000) }),
    };
  });
}

function parseBomAlternatives(input: UnknownRecord): { alternatives?: readonly BomAlternative[]; compatibleItemIds?: readonly string[] } {
  if (input.alternatives !== undefined && input.compatibleItemIds !== undefined) {
    fail("arguments.alternatives and arguments.compatibleItemIds cannot both be provided; use structured alternatives.");
  }
  if (input.alternatives !== undefined) return { alternatives: alternatives(input.alternatives, "arguments.alternatives") };
  if (input.compatibleItemIds === undefined) return {};
  if (!Array.isArray(input.compatibleItemIds) || input.compatibleItemIds.length > 100) fail("arguments.compatibleItemIds must be an array of at most 100 ids.");
  return { compatibleItemIds: input.compatibleItemIds.map((entry, index) => id(entry, `arguments.compatibleItemIds[${index}]`)) };
}

export function bomLineCreate(value: unknown): BomLineCreateInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId", "description", "quantity", "unit", "requirement", "itemId", "alternatives", "compatibleItemIds", "constraints", "notes"], "arguments");
  const result: BomLineCreateInput = {
    projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId"),
    description: stringValue(input.description, "arguments.description", { max: 512 }),
    quantity: finiteNumber(input.quantity, "arguments.quantity", 0.000001),
    unit: enumValue(input.unit, "arguments.unit", ["piece", "gram", "millimetre", "millilitre", "metre", "roll", "set"] as const),
    requirement: optionalEnum(input.requirement, "arguments.requirement", ["required", "optional"] as const),
  };
  result.itemId = optionalId(input.itemId, "arguments.itemId");
  Object.assign(result, parseBomAlternatives(input));
  result.constraints = optionalBomConstraints(input.constraints, "arguments.constraints");
  result.notes = optionalString(input.notes, "arguments.notes", 2000);
  return result;
}

export function bomLineUpdate(value: unknown): BomLineUpdateInput {
  const input = record(value, "arguments");
  keys(input, ["bomLineId", "expectedVersion", "description", "quantity", "unit", "requirement", "itemId", "alternatives", "compatibleItemIds", "constraints", "notes"], "arguments");
  const result: BomLineUpdateInput = { bomLineId: id(input.bomLineId, "arguments.bomLineId") };
  result.expectedVersion = optionalInteger(input.expectedVersion, "arguments.expectedVersion");
  result.description = optionalString(input.description, "arguments.description", 512);
  result.quantity = input.quantity === undefined ? undefined : finiteNumber(input.quantity, "arguments.quantity", 0.000001);
  result.unit = optionalEnum(input.unit, "arguments.unit", ["piece", "gram", "millimetre", "millilitre", "metre", "roll", "set"] as const);
  result.requirement = optionalEnum(input.requirement, "arguments.requirement", ["required", "optional"] as const);
  result.itemId = optionalId(input.itemId, "arguments.itemId");
  Object.assign(result, parseBomAlternatives(input));
  result.constraints = optionalBomConstraints(input.constraints, "arguments.constraints");
  result.notes = optionalString(input.notes, "arguments.notes", 2000);
  return result;
}

export function bomEvaluation(value: unknown): BomEvaluationInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId"], "arguments");
  return { projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId") };
}

export function reservation(value: unknown): ReservationInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId", "bomLineId", "itemId", "quantity"], "arguments");
  return {
    projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId"),
    bomLineId: id(input.bomLineId, "arguments.bomLineId"),
    itemId: id(input.itemId, "arguments.itemId"),
    quantity: quantity(input.quantity, "arguments.quantity"),
  };
}

export function releaseReservation(value: unknown): ReleaseReservationInput {
  const input = record(value, "arguments");
  keys(input, ["reservationId", "expectedVersion"], "arguments");
  return {
    reservationId: id(input.reservationId, "arguments.reservationId"),
    expectedVersion: optionalInteger(input.expectedVersion, "arguments.expectedVersion"),
  };
}

export function usage(value: unknown): UsageInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId", "reservationId", "itemId", "quantity", "note"], "arguments");
  return {
    projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId"),
    reservationId: optionalId(input.reservationId, "arguments.reservationId"),
    itemId: id(input.itemId, "arguments.itemId"),
    quantity: quantity(input.quantity, "arguments.quantity"),
    note: optionalString(input.note, "arguments.note", 2000),
  };
}

const artifactRoles = ["source", "cad", "cad_source", "step", "stl", "three_mf", "slicer_project", "gcode", "drawing", "validation", "document", "brief", "design_record", "firmware", "photo", "text", "other"] as const;

function filename(value: unknown, label: string): string {
  const result = stringValue(value, label, { max: 255 });
  if (result === "." || result === ".." || result.includes("/") || result.includes("\\") || result.includes("\0") || result.includes("\n") || result.includes("\r")) {
    fail(`${label} must be a single safe filename, not a path.`);
  }
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = stringValue(value, label, { min: 64, max: 64 });
  if (!/^[a-fA-F0-9]{64}$/.test(result)) fail(`${label} must be a SHA-256 hex digest.`);
  return result.toLowerCase();
}

export function artifactList(value: unknown): import("./types.js").ArtifactListInput {
  const input = record(value, "arguments");
  keys(input, ["projectId", "workItemId", "revisionId", "role", "limit", "cursor"], "arguments");
  return {
    ...parsePageInput({ limit: input.limit, cursor: input.cursor }),
    projectId: id(input.projectId, "arguments.projectId"),
    workItemId: optionalId(input.workItemId, "arguments.workItemId"),
    revisionId: optionalId(input.revisionId, "arguments.revisionId"),
    role: optionalEnum(input.role, "arguments.role", artifactRoles),
  };
}

export function beginArtifactUpload(value: unknown): BeginArtifactUploadInput {
  const input = record(value, "arguments");
  keys(input, ["projectId", "projectRevisionId", "buildConfigurationSnapshotId", "workItemId", "workItemRevisionId", "filename", "role", "mediaType", "byteLength", "sha256"], "arguments");
  const result: BeginArtifactUploadInput = {
    projectId: id(input.projectId, "arguments.projectId"),
    filename: filename(input.filename, "arguments.filename"),
    role: enumValue(input.role, "arguments.role", artifactRoles),
    mediaType: stringValue(input.mediaType, "arguments.mediaType", { max: 256 }),
    byteLength: integer(input.byteLength, "arguments.byteLength", 0, 2_000_000_000),
  };
  result.projectRevisionId = optionalId(input.projectRevisionId, "arguments.projectRevisionId");
  result.buildConfigurationSnapshotId = optionalId(input.buildConfigurationSnapshotId, "arguments.buildConfigurationSnapshotId");
  result.workItemId = optionalId(input.workItemId, "arguments.workItemId");
  result.workItemRevisionId = optionalId(input.workItemRevisionId, "arguments.workItemRevisionId");
  if (result.projectRevisionId !== undefined && result.workItemRevisionId !== undefined) fail("arguments may include projectRevisionId or workItemRevisionId, not both.");
  if (result.workItemRevisionId !== undefined && result.workItemId === undefined) fail("arguments.workItemId is required when workItemRevisionId is provided.");
  if (result.projectRevisionId !== undefined && result.workItemId !== undefined) fail("arguments may include projectRevisionId or workItemId, not both.");
  result.sha256 = sha256(input.sha256, "arguments.sha256");
  return result;
}

export function finalizeArtifactUpload(value: unknown): FinalizeArtifactUploadInput {
  const input = record(value, "arguments");
  keys(input, ["uploadId"], "arguments");
  return { uploadId: id(input.uploadId, "arguments.uploadId") };
}

export function artifactMetadata(value: unknown): { artifactId: string; revisionId?: string } {
  const input = record(value, "arguments");
  keys(input, ["artifactId", "revisionId"], "arguments");
  return { artifactId: id(input.artifactId, "arguments.artifactId"), revisionId: optionalId(input.revisionId, "arguments.revisionId") };
}

export function retireArtifact(value: unknown): RetireArtifactInput {
  const input = record(value, "arguments");
  keys(input, ["artifactId", "expectedVersion"], "arguments");
  return { artifactId: id(input.artifactId, "arguments.artifactId"), expectedVersion: optionalInteger(input.expectedVersion, "arguments.expectedVersion") };
}

export function offerList(value: unknown): OfferListInput {
  const input = record(value, "arguments");
  keys(input, ["itemId", "query", "supplier", "limit", "cursor"], "arguments");
  // Offer query/supplier filters are applied across bounded application pages
  // and therefore share the larger opaque cursor bound with filtered inventory.
  return { ...parsePageInput({ limit: input.limit, cursor: input.cursor }, "arguments", 512), itemId: optionalId(input.itemId, "arguments.itemId"), query: optionalString(input.query, "arguments.query", 256), supplier: optionalString(input.supplier, "arguments.supplier", 256) };
}

function money(value: unknown, label: string): { minor: number; currency: string } {
  const input = record(value, label);
  keys(input, ["minor", "currency"], label);
  return { minor: integer(input.minor, `${label}.minor`, 0, 1_000_000_000_000), currency: stringValue(input.currency, `${label}.currency`, { min: 3, max: 3 }).toUpperCase() };
}

export function recordOffer(value: unknown): RecordOfferSnapshotInput {
  const input = record(value, "arguments");
  keys(input, ["itemId", "description", "supplier", "url", "packageQuantity", "price", "shippingMinor", "observedAt"], "arguments");
  const result: RecordOfferSnapshotInput = {
    supplier: stringValue(input.supplier, "arguments.supplier", { max: 256 }),
    url: httpUrl(input.url, "arguments.url"),
    price: money(input.price, "arguments.price"),
  };
  result.itemId = optionalId(input.itemId, "arguments.itemId");
  result.description = optionalString(input.description, "arguments.description", 512);
  result.packageQuantity = optionalQuantity(input.packageQuantity, "arguments.packageQuantity");
  result.shippingMinor = input.shippingMinor === undefined ? undefined : integer(input.shippingMinor, "arguments.shippingMinor", 0, 1_000_000_000_000);
  result.observedAt = optionalString(input.observedAt, "arguments.observedAt", 64);
  return result;
}

export function contextRefresh(value: unknown): ContextRefreshInput {
  const input = record(value ?? {}, "arguments");
  keys(input, ["projectId", "includeInventory", "maxAgeSeconds"], "arguments");
  if (input.includeInventory !== undefined && typeof input.includeInventory !== "boolean") fail("arguments.includeInventory must be a boolean.");
  return { projectId: optionalId(input.projectId, "arguments.projectId"), includeInventory: input.includeInventory as boolean | undefined, maxAgeSeconds: input.maxAgeSeconds === undefined ? undefined : integer(input.maxAgeSeconds, "arguments.maxAgeSeconds", 0, 86_400) };
}

export function assertScope(scopes: readonly Scope[], required: Scope): void {
  if (!scopes.includes(required)) throw new McpAdapterError("FORBIDDEN", `This operation requires the '${required}' scope.`);
}

export function assertProjectAccess(context: { projectIds?: readonly string[] }, projectId: string): void {
  if (context.projectIds !== undefined && !context.projectIds.includes(projectId)) {
    throw new McpAdapterError("FORBIDDEN", "The current token is not scoped to this project.");
  }
}

export function safeHttpLink(value: unknown, label: string): string {
  if (typeof value === "string" && /^data:/i.test(value)) throw new McpAdapterError("UNSAFE_LINK", `${label} must be a scoped HTTP link.`);
  let url: string;
  try {
    url = httpUrl(value, label);
  } catch {
    throw new McpAdapterError("UNSAFE_LINK", `${label} must be a scoped HTTP link.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpAdapterError("UNSAFE_LINK", `${label} is not a valid scoped HTTP link.`);
  }
  const artifactEndpoint = parsed.pathname.includes("/api/") && (
    parsed.pathname.includes("/artifacts/") ||
    parsed.pathname.includes("/transfers/uploads/") ||
    parsed.pathname.includes("/transfers/artifacts/")
  );
  if (!artifactEndpoint || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new McpAdapterError("UNSAFE_LINK", `${label} must point to a scoped BenchLedger artifact endpoint.`);
  }
  return url;
}

export function safeJson(value: unknown, label = "result", depth = 0, maxDepth = 12): JsonValue {
  if (depth > maxDepth) throw new McpAdapterError("BACKEND_ERROR", `${label} is nested too deeply.`);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.startsWith("data:")) throw new McpAdapterError("UNSAFE_LINK", "Inline data URLs are not returned by MCP.");
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new McpAdapterError("RESOURCE_TOO_LARGE", `${label} contains too many entries; use pagination.`);
    return value.map((entry, index) => safeJson(entry, `${label}[${index}]`, depth + 1, maxDepth));
  }
  if (typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value as UnknownRecord)) {
      if (/base64|inline.?bytes|file.?bytes|raw.?binary/i.test(key)) throw new McpAdapterError("UNSAFE_LINK", "Binary content must be transferred using a scoped HTTP link.");
      result[key] = safeJson(entry, `${label}.${key}`, depth + 1, maxDepth);
    }
    return result;
  }
  throw new McpAdapterError("BACKEND_ERROR", `${label} contains a value that cannot be returned as JSON.`);
}

export function boundedJsonObject(value: unknown, maxBytes: number, label = "result", maxDepth = 12): JsonObject {
  const safe = safeJson(value, label, 0, maxDepth);
  if (safe === null || typeof safe !== "object" || Array.isArray(safe)) throw new McpAdapterError("BACKEND_ERROR", `${label} must be a JSON object.`);
  const text = JSON.stringify(safe);
  if (text.length > maxBytes) throw new McpAdapterError("RESOURCE_TOO_LARGE", `${label} is too large; use pagination or a scoped artifact link.`);
  return safe as JsonObject;
}
