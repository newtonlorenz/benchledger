import type { JsonObject, JsonValue, McpResource, McpResourceTemplate, McpToolDefinition } from "./types.js";
import { BOM_CONSTRAINT_KEYS } from "./types.js";

const string = (description?: string): JsonObject => ({ type: "string", ...(description === undefined ? {} : { description }) });
const enumString = (values: readonly string[], description?: string): JsonObject => ({ type: "string", enum: [...values], ...(description === undefined ? {} : { description }) });
const number = (description?: string): JsonObject => ({ type: "number", ...(description === undefined ? {} : { description }) });
const integer = (description?: string): JsonObject => ({ type: "integer", ...(description === undefined ? {} : { description }) });
const boolean = (description?: string): JsonObject => ({ type: "boolean", ...(description === undefined ? {} : { description }) });
const object = (properties: Record<string, JsonValue>, required: readonly string[] = []): JsonObject => ({ type: "object", properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false });
const array = (items: JsonObject): JsonObject => ({ type: "array", items });

function tool(name: string, description: string, requiredScope: McpToolDefinition["requiredScope"], mutating: boolean, properties: Record<string, JsonValue>, required: readonly string[] = []): McpToolDefinition {
  return { name, description, requiredScope, mutating, inputSchema: object(properties, required) };
}

const pageProperties = {
  limit: integer("Maximum 100 results; defaults to 25."),
  cursor: string("Opaque pagination cursor from the previous response; maximum 200 characters."),
};
const categoryPageProperties = {
  ...pageProperties,
  cursor: string("Opaque category pagination cursor from the previous response; maximum 512 characters."),
};
const idProperty = (description = "Stable identifier."): JsonObject => string(description);
const nullableIdProperty = (description: string): JsonObject => ({ oneOf: [idProperty(description), { type: "null" }] });
const categoryIdProperty = (description = "Stable managed category identifier."): JsonObject => ({ ...string(description), maxLength: 160 });
const nullableCategoryIdProperty = (description: string): JsonObject => ({ oneOf: [categoryIdProperty(description), { type: "null" }] });
const quantityProperty: JsonObject = object({ value: number("Positive amount."), unit: string("Canonical unit: piece, gram, millimetre, millilitre, metre, roll, or set.") }, ["value", "unit"]);
const bomConstraintsProperty: JsonObject = object(Object.fromEntries(BOM_CONSTRAINT_KEYS.map((key) => [key, string(`Match inventory ${key}.`)])));
const bomAlternativeProperty: JsonObject = object({ itemId: idProperty("Alternative inventory item."), compatible: string("Compatibility evidence: confirmed, conditional, or unknown."), reason: string("Why this alternative is or is not compatible.") }, ["itemId", "compatible"]);

const catalogFilamentProperty: JsonObject = object({
  kind: string("Exact catalog kind: filament."),
  manufacturer: string("Manufacturer of the exact product."),
  productName: string("Manufacturer product name."),
  sku: string("Manufacturer SKU."),
  materialFamily: string("Canonical material family, for example PETG."),
  materialSubtype: string("Optional material subtype."),
  colourName: string("Manufacturer colour name."),
  colourCode: string("Manufacturer colour code."),
  diameterMm: number("Nominal filament diameter in millimetres."),
  nominalNetMassG: number("Nominal net mass in grams."),
  nominalLengthM: number("Optional nominal filament length in metres."),
  lengthBasis: string("manufacturer_declared, calculated, or unknown."),
  densityGcm3: number("Optional density in grams per cubic centimetre."),
}, ["kind", "manufacturer", "materialFamily", "colourName", "diameterMm", "nominalNetMassG", "lengthBasis"]);
const buildVolumeProperty: JsonObject = object({ x: number("X build volume in millimetres."), y: number("Y build volume in millimetres."), z: number("Z build volume in millimetres.") }, ["x", "y", "z"]);
const catalogPrinterProperty: JsonObject = object({
  kind: string("Exact catalog kind: printer."),
  manufacturer: string("Manufacturer of the exact printer."),
  exactModel: string("Exact model, not a product family."),
  exactVariant: string("Optional exact variant."),
  technology: string("Must be fff for this release."),
  buildVolumeMm: buildVolumeProperty,
}, ["kind", "manufacturer", "exactModel", "technology", "buildVolumeMm"]);
const catalogProductProperty: JsonObject = { oneOf: [catalogFilamentProperty, catalogPrinterProperty] };
const profileDetailsProperty: JsonObject = object({
  lot: string("Filament lot identifier."), batch: string("Filament batch identifier."), lotCode: string("Optional supplier lot code."),
  openedState: string("sealed, open, or unknown."), openedAt: string("ISO timestamp when opened."), tareMassG: number("Optional empty-spool tare mass."),
  currentPlacement: string("Current physical placement."), dryingHistory: string("Drying history note."), assetLabel: string("Local printer asset label."),
  commissionedAt: string("ISO commissioning timestamp."), location: string("Physical location."), condition: string("new, good, worn, needs_repair, or unknown."),
});
const inventoryItemCreateProperty: JsonObject = object({
  name: string("Human-readable inventory item name."),
  category: string("Inventory category, for example filament or printer."),
  categoryNodeId: categoryIdProperty("Optional user-managed category or subcategory assignment."),
  quantity: quantityProperty,
  evidence: object({ state: string(), source: string(), recordedAt: string(), note: string() }, ["state", "source", "recordedAt"]),
  description: string(), manufacturer: string(), model: string(), sku: string(),
  dimensions: object({ length: number(), width: number(), height: number(), diameter: number(), unit: string(), source: string(), uncertainty: number() }),
  condition: string(), location: string(), links: array(object({ label: string(), url: string() }, ["label", "url"])),
}, ["name", "category", "quantity", "evidence"]);
const inventoryProductProfileCreateProperty: JsonObject = object({
  catalogProductId: idProperty("Exact catalog product identifier."),
  profileType: string("filament_spool or printer_asset."),
  linkState: string("confirmed, reported, or suggested."),
  details: profileDetailsProperty,
}, ["catalogProductId", "profileType", "linkState", "details"]);
const inventoryWithProductProfileProperty: JsonObject = object({
  item: inventoryItemCreateProperty,
  profile: inventoryProductProfileCreateProperty,
}, ["item", "profile"]);
const descriptorProperty: JsonObject = {
  oneOf: [string("Short descriptor."), object({
    name: string(), version: string(), model: string(), material: string(), side: string(), type: string(), surface: string(),
    diameterMm: number(), nozzleMaterial: string(), state: string(), recordedAt: string(), quantity: number(),
  })],
};
const snapshotCreateProperties: Record<string, JsonValue> = {
  projectRevisionId: idProperty("Project revision that owns the immutable snapshot."),
  printerItemSnapshot: object({ itemId: idProperty("Inventory printer item."), catalogProductId: idProperty("Exact printer catalog product."), profileId: idProperty("Optional linked printer profile.") }, ["itemId", "catalogProductId"]),
  filamentSelections: array(object({ itemId: idProperty("Inventory filament item."), catalogProductId: idProperty("Exact filament catalog product."), profileId: idProperty("Optional linked spool profile."), role: string(), quantity: number() }, ["itemId", "catalogProductId"])),
  activeHotend: descriptorProperty, nozzle: descriptorProperty, plate: descriptorProperty, accessories: array(descriptorProperty), firmware: descriptorProperty,
  slicer: descriptorProperty, profile: descriptorProperty, calibration: descriptorProperty, explicitUnknowns: array(string()), supersedesSnapshotId: idProperty("Optional predecessor in the same revision."),
};
const reconciliationEvidenceProperty: JsonObject = object({
  state: enumString(["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"], "Evidence state for this disposition."),
  source: string("Where the observation came from."),
  sourceId: string("Optional source reference."),
  observedAt: string("ISO-8601 observation timestamp."),
  note: string("What was observed."),
  condition: string("Optional resulting condition."),
  uncertainty: number("Optional quantity uncertainty."),
}, ["state"]);

/**
 * Keep this in lockstep with api-contract's createInventoryItemSchema. A
 * converted asset is persisted through that same create command, so an agent
 * following the advertised MCP schema must be able to provide every required
 * field rather than receiving an undocumented validation error.
 */
const reconciliationConvertedAssetProperty: JsonObject = object({
  id: idProperty("Optional stable identifier for the new reusable item."),
  name: string("Name for the new reusable asset."),
  kind: enumString(["printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"], "Inventory kind for the new asset."),
  description: string("Optional description."),
  manufacturer: string("Optional manufacturer."),
  model: string("Optional model or variant."),
  sku: string("Optional manufacturer or supplier SKU."),
  quantity: number("Positive starting quantity."),
  availableQuantity: number("Optional available quantity; normally calculated by the server."),
  unit: enumString(["each", "gram", "millimetre", "millilitre", "metre", "set"], "Canonical quantity unit."),
  location: string("Optional physical location."),
  condition: enumString(["new", "good", "worn", "needs_repair", "unknown"], "Optional resulting condition."),
  dimensions: object({
    lengthMm: number("Optional length in millimetres."),
    widthMm: number("Optional width in millimetres."),
    heightMm: number("Optional height in millimetres."),
    diameterMm: number("Optional diameter in millimetres."),
    measured: boolean("Whether dimensions were measured rather than nominal."),
    uncertaintyMm: number("Optional dimensional uncertainty in millimetres."),
    note: string("Optional dimensional note."),
  }),
  tags: array(string("Searchable item tag.")),
  links: array(object({
    supplier: string("Supplier or source name."),
    url: string("Absolute supplier or source URL."),
    label: string("Optional link label."),
    currentPriceMinor: integer("Optional observed price in minor currency units."),
    currency: string("Optional ISO-4217 currency code."),
    observedAt: string("Optional ISO-8601 price observation time."),
    packageQuantity: number("Optional quantity represented by the source package."),
  }, ["supplier", "url"])),
  evidence: object({
    state: enumString(["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"], "Evidence state for the new reusable item."),
    source: string("Optional evidence source."),
    sourceId: string("Optional source reference."),
    observedAt: string("Optional ISO-8601 evidence observation time."),
    note: string("Optional evidence note."),
  }, ["state"]),
}, ["name", "kind", "quantity", "unit", "tags", "links", "evidence"]);
const reconciliationOutcomeProperty: JsonObject = object({
  reservationId: idProperty("Reservation being closed out."),
  itemId: idProperty("Inventory item affected by this outcome."),
  kind: enumString(["consumed", "returned", "damaged_lost", "usable_leftover", "converted_asset", "reviewed_no_change"], "Disposition kind."),
  quantity: number("Non-negative disposition quantity."),
  unit: enumString(["each", "gram", "millimetre", "millilitre", "metre", "set"], "Canonical quantity unit."),
  evidence: reconciliationEvidenceProperty,
  convertedAsset: reconciliationConvertedAssetProperty,
}, ["kind", "quantity", "unit", "evidence"]);
const reconciliationLineProperty: JsonObject = object({
  bomLineId: idProperty("BOM line being reviewed."),
  outcomes: array(reconciliationOutcomeProperty),
}, ["bomLineId", "outcomes"]);

export const TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  tool("read_inventory_summary", "Read a bounded inventory summary and category counts.", "inventory:read", false, pageProperties),
  tool("list_inventory", "List equipment, tools, consumables, and electronics with evidence-aware availability.", "inventory:read", false, { ...pageProperties, query: string(), category: string(), availability: string(), location: string() }),
  tool("read_inventory_item", "Read one inventory item, including dimensions, links, evidence, and current quantity.", "inventory:read", false, { itemId: idProperty("Inventory item identifier.") }, ["itemId"]),
  tool("create_inventory_item", "Add a catalog item or stock record with an explicit evidence state.", "inventory:write", true, inventoryItemCreateProperty.properties as Record<string, JsonValue>, ["name", "category", "quantity", "evidence"]),
  tool("create_inventory_with_product_profile", "Atomically create one physical printer or filament inventory item and its exact product profile. Requires both inventory:write and catalog:write; retries with the same idempotency key are safe and failed profile/audit writes are compensated.", "inventory:write", true, inventoryWithProductProfileProperty.properties as Record<string, JsonValue>, ["item", "profile"]),
  tool("update_inventory_item", "Update descriptive inventory metadata and optionally assign a user-managed category using optimistic versioning.", "inventory:write", true, { itemId: idProperty("Inventory item identifier."), expectedVersion: integer(), name: string(), category: string(), categoryNodeId: nullableCategoryIdProperty("Optional category assignment; null clears it."), description: string(), manufacturer: string(), model: string(), sku: string(), dimensions: object({ length: number(), width: number(), height: number(), diameter: number(), unit: string(), source: string(), uncertainty: number() }), condition: string(), location: string(), links: array(object({ label: string(), url: string() }, ["label", "url"])) }, ["itemId"]),
  tool("record_stock_event", "Record one append-only receipt, count correction, allocation, use, return, loss, or disposal event.", "inventory:write", true, { itemId: idProperty("Inventory item identifier."), kind: string(), quantity: quantityProperty, note: string() }, ["itemId", "kind", "quantity"]),
  tool("list_stock_events", "List the append-only stock event history for one item.", "inventory:read", false, { ...pageProperties, itemId: idProperty("Inventory item identifier.") }, ["itemId"]),
  tool("list_inventory_categories", "List the bounded user-managed inventory taxonomy; semantic inventory kinds remain closed and separate.", "inventory:read", false, { ...categoryPageProperties, includeArchived: boolean("Include archived categories.") }),
  tool("read_inventory_category", "Read one user-managed inventory category or subcategory.", "inventory:read", false, { categoryId: categoryIdProperty("Inventory category identifier.") }, ["categoryId"]),
  tool("create_inventory_category", "Create a top-level category or one-level subcategory with a stable identifier.", "inventory:write", true, { id: categoryIdProperty("Optional stable category identifier."), name: string("Category name."), parentId: categoryIdProperty("Optional top-level parent category."), sortOrder: integer("Deterministic sibling order.") }, ["name"]),
  tool("update_inventory_category", "Rename or reorder a category using optimistic versioning; its parent is immutable after creation.", "inventory:write", true, { categoryId: categoryIdProperty("Inventory category identifier."), expectedVersion: integer("Required optimistic concurrency version."), name: string("Replacement category name."), sortOrder: integer("Replacement sibling order.") }, ["categoryId", "expectedVersion"]),
  tool("archive_inventory_category", "Archive a category using a dedicated optimistic-version command; active children or inventory references block the archive.", "inventory:write", true, { categoryId: categoryIdProperty("Inventory category identifier."), expectedVersion: integer("Required optimistic concurrency version.") }, ["categoryId", "expectedVersion"]),

  tool("search_catalog_products", "Search exact printer and filament catalog products with bounded pagination; this never asserts physical stock.", "catalog:read", false, { ...pageProperties, query: string("Case-insensitive product search."), kind: string("filament or printer.") }),
  tool("read_catalog_product", "Read one exact catalog product. Catalog identity is not evidence that a matching physical item exists.", "catalog:read", false, { productId: idProperty("Catalog product identifier.") }, ["productId"]),
  { name: "create_catalog_product", description: "Create one exact manufacturer product or printer model in the local catalog.", requiredScope: "catalog:write", mutating: true, inputSchema: { oneOf: [catalogFilamentProperty, catalogPrinterProperty] } },
  tool("update_catalog_product", "Correct an exact catalog product with optimistic version checking; product kind cannot change.", "catalog:write", true, { productId: idProperty("Catalog product identifier."), expectedVersion: integer(), manufacturer: string(), productName: string(), sku: string(), materialFamily: string(), materialSubtype: string(), colourName: string(), colourCode: string(), diameterMm: number(), nominalNetMassG: number(), nominalLengthM: number(), lengthBasis: string(), densityGcm3: number(), exactModel: string(), exactVariant: string(), technology: string(), buildVolumeMm: buildVolumeProperty }, ["productId"]),
  tool("read_inventory_product_profile", "Read the exact-product link for one physical inventory item without exposing serials or implying stock confirmation.", "catalog:read", false, { itemId: idProperty("Inventory item identifier.") }, ["itemId"]),
  tool("link_inventory_product_profile", "Link one physical printer or filament inventory item to an exact catalog product; reported and suggested links remain non-confirming.", "catalog:write", true, { itemId: idProperty("Inventory item identifier."), expectedVersion: integer(), catalogProductId: idProperty("Exact catalog product identifier."), profileType: string("filament_spool or printer_asset."), linkState: string("confirmed, reported, or suggested."), details: profileDetailsProperty }, ["itemId", "catalogProductId", "profileType", "linkState", "details"]),

  tool("list_projects", "List projects with bounded pagination and status filtering.", "projects:read", false, { ...pageProperties, query: string(), status: string() }),
  tool("read_project", "Read a project identity and current lifecycle state.", "projects:read", false, { projectId: idProperty("Project identifier.") }, ["projectId"]),
  tool("create_project", "Create a project workspace for an end-to-end build.", "projects:write", true, { name: string(), description: string() }, ["name"]),
  tool("create_project_with_initial_revision", "Atomically create a project and its first planning revision; retries with the same idempotency key are safe.", "projects:write", true, { name: string(), description: string(), projectId: idProperty("Optional stable project identifier."), revisionId: idProperty("Optional stable initial revision identifier."), revisionSummary: string("Optional summary for the initial planning revision.") }, ["name"]),
  tool("update_project", "Update project metadata with optimistic versioning.", "projects:write", true, { projectId: idProperty("Project identifier."), expectedVersion: integer(), name: string(), description: string(), status: string() }, ["projectId"]),
  tool("retire_project", "Retire a project while retaining its revisions, artifacts, and evidence.", "projects:write", true, { projectId: idProperty("Project identifier."), expectedVersion: integer() }, ["projectId"]),
  tool("create_work_item", "Create a versioned part, assembly, electronics, firmware, or document within a project.", "projects:write", true, { projectId: idProperty("Project identifier."), name: string(), kind: string(), description: string() }, ["projectId", "name", "kind"]),
  tool("read_work_item", "Read one project work item.", "projects:read", false, { workItemId: idProperty("Work-item identifier.") }, ["workItemId"]),
  tool("create_project_revision", "Create a versioned planning revision for a project.", "projects:write", true, { projectId: idProperty("Project identifier."), summary: string() }, ["projectId"]),
  tool("read_project_revision", "Read one project planning revision and its status.", "projects:read", false, { revisionId: idProperty("Project revision identifier.") }, ["revisionId"]),
  tool("create_work_item_revision", "Create a versioned engineering revision for a work item.", "projects:write", true, { workItemId: idProperty("Work-item identifier."), summary: string() }, ["workItemId"]),
  tool("read_work_item_revision", "Read one work-item engineering revision.", "projects:read", false, { revisionId: idProperty("Work-item revision identifier.") }, ["revisionId"]),

  tool("list_bom_lines", "List the requirements for one project revision.", "bom:read", false, { ...pageProperties, projectRevisionId: idProperty("Project revision identifier.") }, ["projectRevisionId"]),
  tool("create_bom_line", "Add one required or optional BOM requirement with evidence-bearing compatible alternatives.", "bom:write", true, { projectRevisionId: idProperty("Project revision identifier."), description: string(), quantity: number(), unit: string(), requirement: string(), itemId: idProperty("Exact inventory item, when known."), alternatives: array(bomAlternativeProperty), compatibleItemIds: array(string("Deprecated IDs-only alternative list; use alternatives for compatibility evidence.")), constraints: bomConstraintsProperty, notes: string() }, ["projectRevisionId", "description", "quantity", "unit"]),
  tool("update_bom_line", "Update one BOM requirement using optimistic versioning and evidence-bearing alternatives.", "bom:write", true, { bomLineId: idProperty("BOM line identifier."), expectedVersion: integer(), description: string(), quantity: number(), unit: string(), requirement: string(), itemId: idProperty("Exact inventory item, when known."), alternatives: array(bomAlternativeProperty), compatibleItemIds: array(string("Deprecated IDs-only alternative list; use alternatives for compatibility evidence.")), constraints: bomConstraintsProperty, notes: string() }, ["bomLineId"]),
  tool("retire_bom_line", "Retire a BOM requirement without erasing its history.", "bom:write", true, { bomLineId: idProperty("BOM line identifier."), expectedVersion: integer() }, ["bomLineId"]),
  tool("calculate_bom_gaps", "Evaluate each BOM line as supplied, inspect-first, partial, missing, or optional, with match reasons.", "bom:read", false, { projectRevisionId: idProperty("Project revision identifier.") }, ["projectRevisionId"]),
  tool("create_reservation", "Reserve confirmed stock for one BOM line; uncertain stock is never silently reserved.", "bom:write", true, { projectRevisionId: idProperty("Project revision identifier."), bomLineId: idProperty("BOM line identifier."), itemId: idProperty("Inventory item identifier."), quantity: quantityProperty }, ["projectRevisionId", "bomLineId", "itemId", "quantity"]),
  tool("release_reservation", "Release one stock reservation with optimistic version checking.", "bom:write", true, { reservationId: idProperty("Reservation identifier."), expectedVersion: integer() }, ["reservationId"]),
  tool("record_usage", "Record actual consumption against a project and optional reservation.", "bom:write", true, { projectRevisionId: idProperty("Project revision identifier."), reservationId: idProperty("Optional reservation identifier."), itemId: idProperty("Inventory item identifier."), quantity: quantityProperty, note: string() }, ["projectRevisionId", "itemId", "quantity"]),

  tool("read_reconciliation", "Read the review-only close-out document for a project revision. A missing draft is normal before the first save; this never changes stock.", "bom:read", false, { projectRevisionId: idProperty("Project revision identifier.") }, ["projectRevisionId"]),
  tool("save_reconciliation_draft", "Save an evidence-bearing post-project close-out draft and server-calculated preview. Draft saves never change stock or reservations and support optimistic version checks. This save is a separate command from commit and must not share its idempotency key.", "bom:write", true, { projectRevisionId: idProperty("Project revision identifier."), draftId: idProperty("Existing draft identifier."), expectedVersion: integer("Version read before editing."), lines: array(reconciliationLineProperty) }, ["projectRevisionId", "lines"]),
  tool("commit_reconciliation", "Explicitly commit a reviewed close-out. The server applies stock, reservation, and reusable-asset changes atomically; an ambiguous retry with the commit command's original idempotency key and identical payload replays safely.", "bom:write", true, { projectRevisionId: idProperty("Project revision identifier."), draftId: idProperty("Draft to commit."), expectedVersion: integer("Draft version read before confirmation.") }, ["projectRevisionId", "draftId"]),

  tool("create_build_configuration", "Create an immutable build-configuration snapshot for a project revision; the service copies exact catalog/profile facts and records unknowns.", "projects:write", true, snapshotCreateProperties, ["projectRevisionId", "printerItemSnapshot", "filamentSelections", "activeHotend", "nozzle", "plate", "accessories", "firmware", "slicer", "profile", "calibration", "explicitUnknowns"]),
  tool("list_build_configurations", "List immutable build-configuration snapshots for one project revision with bounded pagination.", "projects:read", false, { ...pageProperties, projectRevisionId: idProperty("Project revision identifier.") }, ["projectRevisionId"]),
  tool("read_build_configuration", "Read one immutable build-configuration snapshot, including copied product/profile facts and server content hash.", "projects:read", false, { buildConfigurationId: idProperty("Build-configuration snapshot identifier.") }, ["buildConfigurationId"]),

  tool("list_artifacts", "List versioned project files by project, work item, revision, or role.", "artifacts:read", false, { ...pageProperties, projectId: idProperty("Project identifier."), workItemId: idProperty(), revisionId: idProperty(), role: string() }, ["projectId"]),
  tool("read_artifact_metadata", "Read file metadata, hash, provenance, role, and revision without downloading bytes.", "artifacts:read", false, { artifactId: idProperty("Artifact identifier."), revisionId: idProperty() }, ["artifactId"]),
  tool("begin_artifact_upload", "Start a bounded upload session; upload bytes through the short-lived scoped HTTP URL returned by the application. Use projectRevisionId alone for a project artifact, or workItemId plus workItemRevisionId for a work-item artifact. An optional buildConfigurationSnapshotId is bound only after finalization and must belong to the same project revision.", "artifacts:write", true, { projectId: idProperty("Project identifier."), projectRevisionId: idProperty("Project revision identifier; mutually exclusive with workItemId."), buildConfigurationSnapshotId: idProperty("Optional immutable build-configuration snapshot to bind at finalize."), workItemId: idProperty("Work-item identifier; pair with workItemRevisionId when revision-bound."), workItemRevisionId: idProperty("Work-item revision identifier; requires workItemId and is mutually exclusive with projectRevisionId."), filename: string(), role: string("source, cad, cad_source, step, stl, three_mf, slicer_project, gcode, drawing, validation, document, brief, design_record, firmware, photo, text, or other."), mediaType: string(), byteLength: integer(), sha256: string("Required SHA-256 digest of the bytes to be uploaded.") }, ["projectId", "filename", "role", "mediaType", "byteLength", "sha256"]),
  tool("finalize_artifact_upload", "Finalize an upload after the application verifies the declared byte length and SHA-256 against the stored bytes.", "artifacts:write", true, { uploadId: idProperty("Upload session identifier.") }, ["uploadId"]),
  tool("read_artifact_download_metadata", "Return metadata and a short-lived scoped HTTP download link; file bytes are never embedded in MCP.", "artifacts:read", false, { artifactId: idProperty("Artifact identifier."), revisionId: idProperty() }, ["artifactId"]),
  tool("download_artifact", "Compatibility alias for read_artifact_download_metadata; returns a scoped link and metadata, never file bytes.", "artifacts:read", false, { artifactId: idProperty("Artifact identifier."), revisionId: idProperty() }, ["artifactId"]),
  tool("retire_artifact", "Retire a logical artifact revision while retaining its content hash and audit record.", "artifacts:write", true, { artifactId: idProperty("Artifact identifier."), expectedVersion: integer() }, ["artifactId"]),

  tool("list_offers", "List supplier offer observations and historical prices; links are data and are not fetched by BenchLedger.", "offers:read", false, { ...pageProperties, itemId: idProperty(), query: string(), supplier: string() }),
  tool("record_offer_snapshot", "Record a supplier link and price observation for shopping-list comparison; this never purchases.", "offers:write", true, { itemId: idProperty(), description: string(), supplier: string(), url: string(), packageQuantity: quantityProperty, price: object({ minor: integer(), currency: string() }, ["minor", "currency"]), shippingMinor: integer(), observedAt: string() }, ["supplier", "url", "price"]),
  tool("refresh_context", "Refresh bounded current-state context for an agent before it makes a recommendation or write.", "context:read", false, { projectId: idProperty(), includeInventory: boolean(), maxAgeSeconds: integer() }),
  tool("get_capabilities", "Discover the BenchLedger MCP contract, resources, safety boundaries, and supported tool families.", "context:read", false, {}),
];

export const RESOURCES: readonly McpResource[] = [
  { uri: "benchledger://capabilities", name: "BenchLedger capabilities", description: "Machine-readable capability and safety contract.", mimeType: "application/json" },
  { uri: "benchledger://inventory/summary", name: "Inventory summary", description: "Bounded counts and categories for the current inventory.", mimeType: "application/json" },
  { uri: "benchledger://inventory/categories", name: "Inventory categories", description: "Bounded user-managed inventory taxonomy; archived nodes are omitted by default.", mimeType: "application/json" },
];

export const RESOURCE_TEMPLATES: readonly McpResourceTemplate[] = [
  { uriTemplate: "benchledger://catalog/products/{productId}", name: "Catalog product", description: "One exact printer or filament product; catalog identity does not prove physical stock.", mimeType: "application/json" },
  { uriTemplate: "benchledger://inventory/items/{itemId}", name: "Inventory item", description: "One inventory item with evidence and links.", mimeType: "application/json" },
  { uriTemplate: "benchledger://inventory/categories/{categoryId}", name: "Inventory category", description: "One user-managed inventory category or subcategory.", mimeType: "application/json" },
  { uriTemplate: "benchledger://inventory/items/{itemId}/product-profile", name: "Inventory product profile", description: "The exact-product profile for one physical item; serial-like fields are withheld. Exact inventory/profile creates return this resource only after both records commit.", mimeType: "application/json" },
  { uriTemplate: "benchledger://projects/{projectId}/context", name: "Project context", description: "Bounded project context and next actions.", mimeType: "application/json" },
  { uriTemplate: "benchledger://projects/{projectId}/revisions/{revisionId}", name: "Project revision", description: "One versioned project planning revision.", mimeType: "application/json" },
  { uriTemplate: "benchledger://projects/{projectId}/revisions/{revisionId}/build-configurations", name: "Revision build configurations", description: "Immutable build-configuration snapshots owned by one project revision.", mimeType: "application/json" },
  { uriTemplate: "benchledger://build-configurations/{buildConfigurationId}", name: "Build configuration", description: "One immutable build-configuration snapshot with copied catalog/profile facts.", mimeType: "application/json" },
  { uriTemplate: "benchledger://projects/{projectId}/revisions/{revisionId}/reconciliation", name: "Project reconciliation", description: "Review-only close-out draft and server preview for a project revision; reading it never changes stock.", mimeType: "application/json" },
  { uriTemplate: "benchledger://projects/{projectId}/bom", name: "Project BOM", description: "Bounded BOM lines for a project revision/workspace.", mimeType: "application/json" },
  { uriTemplate: "benchledger://projects/{projectId}/artifacts", name: "Project artifacts", description: "Bounded artifact metadata; bytes remain behind scoped HTTP links.", mimeType: "application/json" },
];

export const CAPABILITY_DOCUMENT: JsonObject = {
  product: "BenchLedger",
  contractVersion: "0.1",
  modelNeutral: true,
  summary: "Evidence-first inventory and versioned project workspace for 3D printing and electronics.",
  resources: RESOURCES as unknown as JsonValue,
  resourceTemplates: RESOURCE_TEMPLATES as unknown as JsonValue,
  tools: TOOL_DEFINITIONS as unknown as JsonValue,
  stockSemantics: {
    confirmed: "Physically counted or commissioned and eligible for automatic reuse when compatibility and quantity match.",
    inspect_first: "Evidence exists but current physical quantity or condition needs a human check before reservation.",
    delivered_uncounted: "Delivery evidence only; never treated as available stock until counted.",
    ordered_unverified: "Order evidence only; never treated as available stock.",
    allocated: "Reserved or assigned stock; availability is reduced by the allocation.",
    depleted: "No remaining usable quantity recorded.",
  },
  scopeBehavior: {
    projectTokens: "A token with projectIds may address only those projects. Project list results are allow-list filtered; workspace-wide aggregate endpoints are rejected.",
    indirectProjectIds: "Revision, work-item, BOM-line, reservation, artifact, and upload identifiers are resolved from durable host state before dispatch. If ancestry cannot be proven, the request is rejected; request-local ID caches are never authoritative.",
    inventory: "The inventory catalog and user-managed category taxonomy are shared workspace context. Project-scoped tokens may read inventory, categories, and stock history for matching, but cannot create, update, retire, count, record stock events, or mutate categories.",
    atomicInventoryProfile: "create_inventory_with_product_profile requires both inventory:write and catalog:write on an unscoped token. Its item and profile commit as one audited, idempotent command; a failed profile, audit, idempotency, or binding step compensates the just-created records.",
    catalog: "Exact catalog products are shared workspace context. Project-scoped tokens may search and read products for in-scope snapshots, but only unscoped catalog tokens may create or correct products.",
    profiles: "Physical product profiles are workspace-global. Profile reads and writes require catalog scope and are not available to project-scoped tokens; reported and suggested links never imply confirmed stock or compatibility.",
    buildConfigurations: "Snapshots require projects:write/read and are authorized through durable project-revision ancestry. They are immutable; corrections create a superseding snapshot.",
    reconciliation: "Close-out drafts use bom:write and remain review-only until commit_reconciliation. Project-scoped tokens may save and commit only for an allow-listed revision; no inventory:write scope is granted.",
    commandIdempotency: "When the MCP host supplies idempotency metadata, each logical write gets its own stable key. Reuse a key only for an ambiguous retry with the identical payload. Draft save and commit are distinct commands and must use different keys.",
    offers: "Supplier offer observations are shared workspace context. Project-scoped tokens may list offers only with an itemId, but cannot record offer snapshots.",
  },
  approvalBoundaries: [
    "MCP can propose a shopping list and record supplier price observations, but cannot purchase, add to a cart, or submit an order.",
    "MCP can record reservations and usage events, but cannot start a printer, heat hardware, flash firmware, or generate/submit a print job.",
    "MCP can stage and finalize project artifacts, but cannot execute uploaded files or provide arbitrary filesystem access.",
    "MCP never exposes arbitrary shell, SQL, URL-fetch, path, credential, or database tools.",
    "Public publication, deployment, credential changes, and destructive purge require explicit human approval outside this adapter.",
  ],
  artifactTransfer: "Large files use short-lived, header-bound, single-purpose HTTP upload/finalize/download capabilities. Tokens are never placed in URLs; MCP results never contain base64 or inline binary bytes.",
  reconciliationSemantics: {
    consumed: "Settle the reservation and remove the outcome quantity from source stock.",
    returned: "Settle the reservation without reducing on-hand stock; the quantity becomes available again.",
    usable_leftover: "Settle the reservation without reducing on-hand stock; the usable remainder becomes available again.",
    damaged_lost: "Settle the reservation and remove the outcome quantity as loss.",
    converted_asset: "Settle the reservation, remove the source quantity, and create the explicitly described reusable inventory item. BOM line, reservation, and source item retain lineage.",
    reviewed_no_change: "Make no stock change; valid only as the sole outcome for a BOM line with zero active reservations.",
    authority: "The server-calculated preview is authoritative before commit.",
  },
  recommendedSequence: [
    "refresh_context",
    "read_inventory_summary",
    "list_inventory",
    "read_project or create_project_with_initial_revision",
    "create_project_revision (only for an existing project or later revision)",
    "search_catalog_products",
    "read_catalog_product",
    "read_inventory_product_profile (only with unscoped catalog access)",
    "create_inventory_with_product_profile (only when intentionally adding exact physical stock)",
    "list_bom_lines or create_bom_line",
    "calculate_bom_gaps",
    "create_reservation",
    "list_offers",
    "record_offer_snapshot (only for an authorized observation)",
    "create_build_configuration",
    "begin_artifact_upload",
    "finalize_artifact_upload",
    "read_reconciliation",
    "save_reconciliation_draft",
    "commit_reconciliation",
  ],
};

export function publicToolDefinitions(): readonly JsonObject[] {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
