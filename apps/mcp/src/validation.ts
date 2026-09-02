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
  bomSpecificationSchema,
  projectSetupProposalSchema,
  commitProjectSetupSchema,
  inspectionObservationSchema,
  commitInspectionCompletionSchema,
} from "@benchledger/api-contract";
import { fromApiQuantityConversion, parseMcpQuantityConversion, toApiQuantityConversion } from "./quantity-conversion.js";
import { BOM_CONSTRAINT_KEYS } from "./types.js";
import type {
  Availability,
  ArtifactScope,
  BomAlternative,
  ArtifactListScope,
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
  InventoryBulkCondition,
  InventoryBulkUpdateInput,
  InventoryCommissionInput,
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
  ReservationListInput,
  ReservationReadInput,
  RetireArtifactInput,
  Scope,
  StockEventKind,
  StockEventsInput,
  UsageInput,
  WorkItemCreateInput,
  WorkItemRevisionCreateInput,
  InspectionListInput,
  InspectionReadInput,
  InspectionPreviewInput,
  InspectionCommitInput,
  InspectionObservationInput,
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

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(`${label} must be a boolean.`);
  return value;
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

/** Irreversible removal requires both optimistic concurrency and exact name confirmation. */
export function removeProject(value: unknown): { projectId: string; expectedVersion: number; projectName: string } {
  const input = record(value, "arguments");
  keys(input, ["projectId", "expectedVersion", "projectName", "name"], "arguments");
  const projectName = input.projectName ?? input.name;
  return {
    projectId: id(input.projectId, "arguments.projectId"),
    expectedVersion: integer(input.expectedVersion, "arguments.expectedVersion", 1),
    projectName: stringValue(projectName, "arguments.projectName", { max: 240 })
  };
}

export function removedProjectList(value: unknown): PageInput {
  return parsePageInput(value ?? {});
}

export function removedProjectHistory(value: unknown): { projectId: string; limit?: number; cursor?: string } {
  const input = record(value, "arguments");
  keys(input, ["projectId", "limit", "cursor"], "arguments");
  const page = parsePageInput({ limit: input.limit, cursor: input.cursor });
  return { projectId: id(input.projectId, "arguments.projectId"), ...(page.limit === undefined ? {} : { limit: page.limit }), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
}

export function archiveProject(value: unknown): { projectId: string; expectedVersion?: number } {
  return retireProject(value);
}

export function restoreProject(value: unknown): { projectId: string; expectedVersion?: number } {
  return retireProject(value);
}

export function projectSetupProposal(value: unknown): import("./types.js").ProjectSetupProposal {
  const input = record(value, "arguments");
  const normalized = {
    ...input,
    ...(Array.isArray(input.bomLines)
      ? {
          bomLines: input.bomLines.map((line, lineIndex) => {
            const lineRecord = record(line, `arguments.bomLines[${lineIndex}]`);
            if (!Array.isArray(lineRecord.alternatives)) return lineRecord;
            return {
              ...lineRecord,
              alternatives: lineRecord.alternatives.map((alternative, alternativeIndex) => {
                const alternativeRecord = record(alternative, `arguments.bomLines[${lineIndex}].alternatives[${alternativeIndex}]`);
                if (alternativeRecord.quantityConversion === undefined) return alternativeRecord;
                const conversion = parseMcpQuantityConversion(alternativeRecord.quantityConversion, `arguments.bomLines[${lineIndex}].alternatives[${alternativeIndex}].quantityConversion`);
                return { ...alternativeRecord, quantityConversion: toApiQuantityConversion(conversion, `arguments.bomLines[${lineIndex}].alternatives[${alternativeIndex}].quantityConversion`) };
              }),
            };
          }),
        }
      : {}),
  };
  const parsed = canonicalSchema(projectSetupProposalSchema, normalized, "arguments");
  return {
    ...parsed,
    bomLines: parsed.bomLines.map((line) => ({
      ...line,
      alternatives: line.alternatives.map((alternative) => ({
        ...alternative,
        ...(alternative.quantityConversion === undefined ? {} : { quantityConversion: fromApiQuantityConversion(alternative.quantityConversion, "arguments.bomLines.alternatives.quantityConversion") }),
      })),
    })),
  } as import("./types.js").ProjectSetupProposal;
}

export function projectSetupCommit(value: unknown): import("./types.js").CommitProjectSetupInput {
  return canonicalSchema(commitProjectSetupSchema, record(value, "arguments"), "arguments");
}

export function inspectionList(value: unknown): InspectionListInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId", "limit", "cursor"], "arguments");
  const page = parsePageInput({ limit: input.limit, cursor: input.cursor });
  return { projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId"), ...(page.limit === undefined ? {} : { limit: page.limit }), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
}

export function inspectionRead(value: unknown): InspectionReadInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId", "inspectionId"], "arguments");
  return { projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId"), inspectionId: id(input.inspectionId, "arguments.inspectionId") };
}

function inspectionObservation(value: unknown, label: string): InspectionObservationInput {
  const input = record(value, label);
  keys(input, ["result", "quantity", "unit", "source", "sourceId", "observedAt", "note", "conversion"], label);
  const result = enumValue(input.result, `${label}.result`, ["confirmed", "inconclusive"] as const);
  const quantity = input.quantity === undefined ? undefined : finiteNumber(input.quantity, `${label}.quantity`);
  const unit = input.unit === undefined ? undefined : enumValue(input.unit, `${label}.unit`, ["piece", "gram", "millimetre", "millilitre", "metre", "roll", "set"] as const);
  const source = stringValue(input.source, `${label}.source`, { max: 500 });
  const sourceId = optionalString(input.sourceId, `${label}.sourceId`, 500);
  const observedAt = stringValue(input.observedAt, `${label}.observedAt`, { max: 80 });
  const note = optionalString(input.note, `${label}.note`, 1000);
  const conversion = input.conversion === undefined ? undefined : parseMcpQuantityConversion(input.conversion, `${label}.conversion`);
  return { result, ...(quantity === undefined ? {} : { quantity }), ...(unit === undefined ? {} : { unit }), source, ...(sourceId === undefined ? {} : { sourceId }), observedAt, ...(note === undefined ? {} : { note }), ...(conversion === undefined ? {} : { conversion }) };
}

export function inspectionPreview(value: unknown): InspectionPreviewInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId", "inspectionId", "observation"], "arguments");
  return { projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId"), inspectionId: id(input.inspectionId, "arguments.inspectionId"), observation: inspectionObservation(input.observation, "arguments.observation") };
}

export function inspectionCommit(value: unknown): InspectionCommitInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId", "inspectionId", "previewId", "expectedPreviewVersion", "contentSha256", "confirmed"], "arguments");
  const parsed = canonicalSchema(commitInspectionCompletionSchema, { previewId: input.previewId, expectedPreviewVersion: input.expectedPreviewVersion, contentSha256: input.contentSha256, confirmed: input.confirmed }, "arguments");
  return { projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId"), inspectionId: id(input.inspectionId, "arguments.inspectionId"), ...parsed };
}

export function retireBomLine(value: unknown): { bomLineId: string; expectedVersion: number } {
  const input = record(value, "arguments");
  keys(input, ["bomLineId", "expectedVersion"], "arguments");
  return { bomLineId: id(input.bomLineId, "arguments.bomLineId"), expectedVersion: integer(input.expectedVersion, "arguments.expectedVersion") };
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
  const result: CatalogProductSearchInput = {
    ...page,
    ...(query === undefined ? {} : { query: query.trim() }),
    kind: optionalEnum(input.kind, "arguments.kind", ["filament", "printer"] as const),
  };
  return result;
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
  return canonicalSchema(createBuildConfigurationSnapshotSchema, record(value, "arguments"), "arguments") as BuildConfigurationCreateInput;
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
  const result: Quantity = {
    value: finiteNumber(input.value, `${label}.value`, 0.000001),
    unit: enumValue(input.unit, `${label}.unit`, ["piece", "gram", "millimetre", "millilitre", "metre", "roll", "set"] as const),
  };
  return result;
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
  keys(input, ["state", "source", "sourceId", "recordedAt", "note"], label);
  const result: EvidenceSummary = {
    state: enumValue(input.state, `${label}.state`, ["physical_count", "commissioned", "measured", "manufacturer", "order", "delivery", "user_reported", "inferred", "unknown"] as const),
    source: stringValue(input.source, `${label}.source`, { max: 256 }),
    ...(input.sourceId === undefined ? {} : { sourceId: optionalString(input.sourceId, `${label}.sourceId`, 500) }),
    recordedAt: stringValue(input.recordedAt, `${label}.recordedAt`, { max: 64 }),
    note: optionalString(input.note, `${label}.note`, 2000),
  };
  return result;
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

/** Normalize tags at the MCP boundary while preserving the first display spelling. */
function tagList(value: unknown, label: string, max = 50): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max) fail(`${label} must contain at most ${max} tags.`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    const tag = stringValue(entry, `${label}[${index}]`, { max: 80 }).trim();
    if (tag.length === 0) fail(`${label}[${index}] must not be blank.`);
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

const INVENTORY_BULK_CONDITIONS = ["new", "good", "worn", "needs_repair", "unknown"] as const satisfies readonly InventoryBulkCondition[];

function inventoryBulkTags(value: unknown, label: string): NonNullable<InventoryBulkUpdateInput["changes"]["tags"]> {
  const input = record(value, label);
  keys(input, ["add", "remove"], label);
  const add = tagList(input.add, `${label}.add`);
  const remove = tagList(input.remove, `${label}.remove`);
  if ((add?.length ?? 0) === 0 && (remove?.length ?? 0) === 0) {
    fail(`${label}.add or ${label}.remove must contain at least one tag.`);
  }
  const removed = new Set((remove ?? []).map((tag) => tag.toLocaleLowerCase()));
  if ((add ?? []).some((tag) => removed.has(tag.toLocaleLowerCase()))) {
    fail(`${label} cannot add and remove the same tag.`);
  }
  return {
    ...(add === undefined || add.length === 0 ? {} : { add }),
    ...(remove === undefined || remove.length === 0 ? {} : { remove }),
  };
}

function textFields(input: UnknownRecord, label: string, output: Record<string, string | undefined>): void {
  for (const [field, max] of Object.entries({ description: 4096, manufacturer: 256, model: 256, sku: 256, location: 256 })) {
    output[field] = optionalString(input[field], `${label}.${field}`, max);
  }
}

export function inventoryList(value: unknown): InventoryListInput {
  const input = record(value ?? {}, "arguments");
  keys(input, ["limit", "cursor", "query", "category", "categoryNodeId", "unassigned", "availability", "location"], "arguments");
  // Location filtering is applied after bounded application pages and uses a
  // compact opaque cursor that can contain a near-maximum source cursor.
  const page = parsePageInput({ limit: input.limit, cursor: input.cursor }, "arguments", input.location === undefined ? 200 : 512);
  const result: InventoryListInput = {
    ...page,
    query: optionalString(input.query, "arguments.query", 200),
    category: optionalString(input.category, "arguments.category", 128),
    categoryNodeId: input.categoryNodeId === undefined ? undefined : categoryId(input.categoryNodeId, "arguments.categoryNodeId"),
    unassigned: optionalBoolean(input.unassigned, "arguments.unassigned"),
    availability: optionalEnum(input.availability, "arguments.availability", ["confirmed", "inspect_first", "ordered_unverified", "delivered_uncounted", "allocated", "depleted", "retired"] satisfies readonly Availability[]),
    location: optionalString(input.location, "arguments.location", 256),
  };
  if (result.categoryNodeId !== undefined && result.unassigned === true) fail("arguments.categoryNodeId and arguments.unassigned cannot be combined.");
  return result;
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
  keys(input, ["itemId", "expectedVersion", "name", "category", "categoryNodeId", "description", "manufacturer", "model", "sku", "dimensions", "condition", "location", "tags", "links"], "arguments");
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
  result.tags = tagList(input.tags, "arguments.tags");
  if (input.links !== undefined) result.links = links(input.links, "arguments.links");
  return result;
}

/** Validate one bounded, explicit optimistic-lock metadata batch. */
export function inventoryBulkUpdate(value: unknown): InventoryBulkUpdateInput {
  const input = record(value, "arguments");
  keys(input, ["targets", "changes"], "arguments");
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 100) {
    fail("arguments.targets must contain between 1 and 100 items.");
  }
  const seen = new Set<string>();
  const targets = input.targets.map((target, index) => {
    const value = record(target, `arguments.targets[${index}]`);
    keys(value, ["itemId", "expectedVersion"], `arguments.targets[${index}]`);
    const itemId = id(value.itemId, `arguments.targets[${index}].itemId`);
    if (seen.has(itemId)) fail("arguments.targets must contain unique item ids.");
    seen.add(itemId);
    return { itemId, expectedVersion: integer(value.expectedVersion, `arguments.targets[${index}].expectedVersion`, 1) };
  });
  const changes = record(input.changes, "arguments.changes");
  keys(changes, ["location", "condition", "tags"], "arguments.changes");
  const location = changes.location === undefined ? undefined : stringValue(changes.location, "arguments.changes.location", { max: 256 }).trim();
  if (location !== undefined && location.length === 0) fail("arguments.changes.location must not be blank.");
  const condition = optionalEnum(changes.condition, "arguments.changes.condition", INVENTORY_BULK_CONDITIONS);
  const tags = changes.tags === undefined ? undefined : inventoryBulkTags(changes.tags, "arguments.changes.tags");
  if (location === undefined && condition === undefined && tags === undefined) fail("arguments.changes must contain at least one metadata change.");
  return {
    targets,
    changes: {
      ...(location === undefined ? {} : { location }),
      ...(condition === undefined ? {} : { condition }),
      ...(tags === undefined ? {} : { tags }),
    },
  };
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

export function inventoryCommission(value: unknown): InventoryCommissionInput {
  const input = record(value, "arguments");
  keys(input, ["itemId", "expectedVersion", "quantity", "evidence"], "arguments");
  const parsedEvidence = evidence(input.evidence, "arguments.evidence");
  if (parsedEvidence.state !== "commissioned") fail("arguments.evidence.state must be commissioned");
  return {
    itemId: id(input.itemId, "arguments.itemId"),
    expectedVersion: integer(input.expectedVersion, "arguments.expectedVersion", 1),
    quantity: quantity(input.quantity, "arguments.quantity"),
    evidence: parsedEvidence as InventoryCommissionInput["evidence"]
  };
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
    status: optionalEnum(input.status, "arguments.status", ["idea", "planned", "ready", "building", "validating", "complete", "archived"] as const),
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
  result.status = optionalEnum(input.status, "arguments.status", ["idea", "planned", "ready", "building", "validating", "complete", "archived"] as const);
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
  keys(input, ["projectRevisionId", "includeRetired", "limit", "cursor"], "arguments");
  return { ...parsePageInput({ limit: input.limit, cursor: input.cursor }), projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId"), ...(optionalBoolean(input.includeRetired, "arguments.includeRetired") === undefined ? {} : { includeRetired: optionalBoolean(input.includeRetired, "arguments.includeRetired") }) };
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
    if (key === "specification") {
      const specification = bomSpecificationSchema.safeParse(candidate);
      if (!specification.success) fail(`${label}.specification is invalid.`);
      continue;
    }
    if (!(BOM_CONSTRAINT_KEYS as readonly string[]).includes(key)) fail(`${label}.${key} is unsupported; use one of: ${BOM_CONSTRAINT_KEYS.join(", ")}.`);
    if (typeof candidate !== "string") fail(`${label}.${key} must be a string.`);
  }
  return parsed as BomLineCreateInput["constraints"];
}

function alternatives(value: unknown, label: string): readonly BomAlternative[] {
  if (!Array.isArray(value) || value.length > 100) fail(`${label} must be an array of at most 100 alternatives.`);
  return value.map((entry, index) => {
    const candidate = record(entry, `${label}[${index}]`);
    keys(candidate, ["itemId", "compatible", "reason", "quantityConversion"], `${label}[${index}]`);
    const conversion = candidate.quantityConversion === undefined
      ? undefined
      : parseMcpQuantityConversion(candidate.quantityConversion, `${label}[${index}].quantityConversion`);
    return {
      itemId: id(candidate.itemId, `${label}[${index}].itemId`),
      compatible: enumValue(candidate.compatible, `${label}[${index}].compatible`, ["confirmed", "conditional", "unknown"] as const),
      ...(candidate.reason === undefined ? {} : { reason: optionalString(candidate.reason, `${label}[${index}].reason`, 1000) }),
      ...(conversion === undefined ? {} : { quantityConversion: conversion }),
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

export function reservationList(value: unknown): ReservationListInput {
  const input = record(value, "arguments");
  keys(input, ["projectRevisionId", "limit", "cursor"], "arguments");
  return {
    ...parsePageInput({ limit: input.limit, cursor: input.cursor }),
    projectRevisionId: id(input.projectRevisionId, "arguments.projectRevisionId"),
  };
}

export function reservationRead(value: unknown): ReservationReadInput {
  return { reservationId: singleId(value, "reservationId") };
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

/**
 * Parse the shared artifact scope union used by list and begin.  MCP keeps
 * projectId as the list resource path, so the no-scope branch is allowed only
 * for the read-only all-project listing.  A revision-less work-item filter is
 * deliberately rejected as ambiguous.
 */
export function artifactScope(value: UnknownRecord, label?: string, allowAllProject?: false): ArtifactScope;
export function artifactScope(value: UnknownRecord, label: string, allowAllProject: true): ArtifactListScope;
export function artifactScope(value: UnknownRecord, label = "arguments", allowAllProject = false): ArtifactListScope {
  const projectRevisionId = optionalId(value.projectRevisionId, `${label}.projectRevisionId`);
  const workItemId = optionalId(value.workItemId, `${label}.workItemId`);
  const workItemRevisionId = optionalId(value.workItemRevisionId, `${label}.workItemRevisionId`);
  const hasProjectRevision = projectRevisionId !== undefined;
  const hasWorkItem = workItemId !== undefined;
  const hasWorkItemRevision = workItemRevisionId !== undefined;

  if (hasProjectRevision && (hasWorkItem || hasWorkItemRevision)) {
    fail(`${label} must contain exactly one artifact scope: projectRevisionId or workItemId plus workItemRevisionId.`);
  }
  if (hasWorkItem !== hasWorkItemRevision) {
    fail(`${label} must contain both workItemId and workItemRevisionId for a work-item artifact scope.`);
  }
  if (hasProjectRevision) return { projectRevisionId };
  if (hasWorkItem && hasWorkItemRevision) return { workItemId, workItemRevisionId };
  if (allowAllProject) return {};
  fail(`${label} must contain exactly one artifact scope: projectRevisionId or workItemId plus workItemRevisionId.`);
}

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
  keys(input, ["projectId", "projectRevisionId", "workItemId", "workItemRevisionId", "role", "limit", "cursor"], "arguments");
  const scope = artifactScope(input, "arguments", true);
  return {
    ...parsePageInput({ limit: input.limit, cursor: input.cursor }),
    projectId: id(input.projectId, "arguments.projectId"),
    ...scope,
    role: optionalEnum(input.role, "arguments.role", artifactRoles),
  };
}

export function beginArtifactUpload(value: unknown): BeginArtifactUploadInput {
  const input = record(value, "arguments");
  keys(input, ["projectId", "projectRevisionId", "buildConfigurationSnapshotId", "workItemId", "workItemRevisionId", "filename", "role", "mediaType", "byteLength", "sha256"], "arguments");
  const scope = artifactScope(input);
  const common = {
    projectId: id(input.projectId, "arguments.projectId"),
    filename: filename(input.filename, "arguments.filename"),
    role: enumValue(input.role, "arguments.role", artifactRoles),
    mediaType: stringValue(input.mediaType, "arguments.mediaType", { max: 256 }),
    byteLength: integer(input.byteLength, "arguments.byteLength", 0, 2_000_000_000),
    sha256: sha256(input.sha256, "arguments.sha256"),
  };
  if ("projectRevisionId" in scope) {
    return {
      ...common,
      projectRevisionId: scope.projectRevisionId,
      buildConfigurationSnapshotId: optionalId(input.buildConfigurationSnapshotId, "arguments.buildConfigurationSnapshotId"),
    };
  }
  if (input.buildConfigurationSnapshotId !== undefined) {
    fail("arguments.buildConfigurationSnapshotId is only valid for a projectRevisionId artifact scope.");
  }
  if ("workItemId" in scope) {
    return { ...common, workItemId: scope.workItemId, workItemRevisionId: scope.workItemRevisionId };
  }
  // artifactScope() has already rejected this path; keep the return type
  // explicit so a future change cannot accidentally reintroduce an unscoped
  // upload branch.
  fail("arguments must contain an artifact scope.");
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
