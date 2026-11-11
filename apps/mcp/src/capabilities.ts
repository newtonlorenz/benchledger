import { INVENTORY_IMAGE_TOOLS } from "./inventory-images.js";
import { MAKER_TOOL_DEFINITIONS } from "./maker-workflows.js";
import type { JsonObject, JsonValue, McpResource, McpResourceTemplate, McpToolAnnotations, McpToolDefinition } from "./types.js";
import { BOM_CONSTRAINT_KEYS, MCP_QUANTITY_UNITS, MCP_EVIDENCE_STATES, MCP_CONDITIONS, CANONICAL_CONDITIONS, INVENTORY_KINDS } from "./types.js";
import { BACKEND_DERIVED_IDEMPOTENCY_TOOL_NAMES, DERIVED_IDEMPOTENCY_TOOL_NAMES } from "./idempotency.js";

const string = (description?: string): JsonObject => ({ type: "string", ...(description === undefined ? {} : { description }) });
const enumString = (values: readonly string[], description?: string): JsonObject => ({ type: "string", enum: [...values], ...(description === undefined ? {} : { description }) });
const nullableEnumString = (values: readonly string[], description?: string): JsonObject => ({ oneOf: [enumString(values), { type: "null" }], ...(description === undefined ? {} : { description }) });
const number = (description?: string): JsonObject => ({ type: "number", ...(description === undefined ? {} : { description }) });
const integer = (description?: string): JsonObject => ({ type: "integer", ...(description === undefined ? {} : { description }) });
const boolean = (description?: string): JsonObject => ({ type: "boolean", ...(description === undefined ? {} : { description }) });
const object = (properties: Record<string, JsonValue>, required: readonly string[] = []): JsonObject => ({ type: "object", properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false });
const array = (items: JsonObject): JsonObject => ({ type: "array", items });

function tool(name: string, description: string, requiredScope: McpToolDefinition["requiredScope"], mutating: boolean, properties: Record<string, JsonValue>, required: readonly string[] = [], approvalRequired = false): McpToolDefinition {
  return { name, description, requiredScope, mutating, inputSchema: object(properties, required), ...(approvalRequired ? { approvalRequired: true } : {}) };
}

const pageProperties = {
  limit: { ...integer("Defaults to 25."), minimum: 1, maximum: 100 },
  cursor: { ...string("Cursor from the previous page."), maxLength: 200 },
};
const filteredPageProperties = {
  ...pageProperties,
  cursor: { ...string("Cursor from the previous page."), maxLength: 512 },
};
const categoryPageProperties = {
  ...pageProperties,
  cursor: { ...string("Cursor from the previous page."), maxLength: 512 },
};
const projectLifecycleProperty = enumString(["idea", "planned", "ready", "building", "validating", "complete", "archived"], "Canonical project lifecycle; blocked is derived from reasons and is not a status.");
const fabricationRouteProperty = enumString(["printed", "ready_made", "none", "undecided"], "Planning-only manufacturing route. An intended printer is valid only with printed.");
const idProperty = (description = "Stable identifier."): JsonObject => string(description);
const nullableIdProperty = (description: string): JsonObject => ({ oneOf: [idProperty(description), { type: "null" }] });
const categoryIdProperty = (description = "Stable managed category identifier."): JsonObject => ({ ...string(description), maxLength: 160 });
const nullableCategoryIdProperty = (description: string): JsonObject => ({ oneOf: [categoryIdProperty(description), { type: "null" }] });
const unitProperty = (description = "Legacy input aliases: piece = each, roll = set."): JsonObject => enumString(MCP_QUANTITY_UNITS, description);
const quantityProperty: JsonObject = object({ value: number("Positive amount."), unit: unitProperty() }, ["value", "unit"]);
const expectedVersionProperty = (description = "Current version from your last read."): JsonObject => ({ ...integer(description), minimum: 1 });
const inventoryKindProperty = (description = "Semantic inventory kind. Input aliases: printer_accessory/printer_part = accessory, electronics/electrical = electronic. Unknown values are rejected; use categoryNodeId for your own categories."): JsonObject => enumString(INVENTORY_KINDS, description);
const conditionProperty: JsonObject = enumString(MCP_CONDITIONS, `Canonical: ${CANONICAL_CONDITIONS.join(", ")}. Input-only aliases: used = good, opened = worn.`);
const availabilityProperty: JsonObject = enumString(["confirmed", "inspect_first", "ordered_unverified", "delivered_uncounted", "allocated", "depleted", "retired"], "Derived availability filter.");
const dimensionsProperty: JsonObject = object({ length: number(), width: number(), height: number(), diameter: number(), unit: enumString(["millimetre", "centimetre", "metre"]), source: enumString(["nominal", "measured", "manufacturer", "user_reported"]), uncertainty: number() }, ["unit"]);
const linksProperty: JsonObject = { ...array(object({ label: string(), url: string("Absolute http(s) URL.") }, ["label", "url"])), maxItems: 20 };
const bomSpecificationProperty: JsonObject = { ...object({
  status: enumString(["sufficient", "insufficient"]),
  decisions: object(Object.fromEntries(["identity", "purpose", "voltage", "current_or_load", "connector", "compatibility", "dimensions", "resistance", "power_rating"].map((key) => [key, string()]))),
  missingDecisions: { ...array(enumString(["identity", "purpose", "voltage", "current_or_load", "connector", "compatibility", "dimensions", "resistance", "power_rating"])), minItems: 1, maxItems: 9 },
}, ["status"]), description: "Insufficient requires missingDecisions; sufficient requires decisions. Power supplies require current_or_load and connector. LED resistors require resistance and power_rating." };
const bomRequirementRoleProperty: JsonObject = nullableEnumString(["consumed", "reusable"], "Stock behavior: consumed depletes stock when used; reusable remains owned after use. Null or omission is a legacy role and requires review before reservation, usage, or reconciliation.");
const bomConstraintsProperty: JsonObject = object({
  ...Object.fromEntries(BOM_CONSTRAINT_KEYS.map((key) => [key, string(`Match inventory ${key}.`)])),
  specification: bomSpecificationProperty,
});
const quantityConversionProperty: JsonObject = object({
  inventory: object({
    quantity: { ...integer("Exactly one indivisible inventory package."), const: 1 },
    unit: enumString(["set"], "Inventory-side package unit."),
  }, ["quantity", "unit"]),
  requirement: object({
    quantity: { ...integer("Positive whole-number requirement coverage per package."), minimum: 1 },
    unit: enumString(["each", "piece"], "Requirement unit each (legacy alias piece)."),
  }, ["quantity", "unit"]),
  evidence: object({
    basis: enumString(["package_label", "manufacturer_spec", "physical_count", "user_assertion"], "Evidence basis for the package conversion."),
    observedAt: string("ISO-8601 observation timestamp."),
    source: string("Optional evidence source."),
    sourceId: string("Optional evidence source identifier."),
    note: string("Optional observation note."),
  }, ["basis", "observedAt"]),
}, ["inventory", "requirement", "evidence"]);
const inspectionObservationProperty: JsonObject = object({
  result: enumString(["confirmed", "inconclusive"], "Human inspection result; inconclusive preserves uncertainty."),
  quantity: number("Observed physical quantity when the action is a quantity count."),
  unit: unitProperty("Observed quantity unit (canonical; piece/roll accepted as aliases)."),
  source: string("Where the human observation came from."),
  sourceId: string("Optional source or record identifier."),
  observedAt: string("ISO-8601 observation timestamp."),
  note: string("Optional observation note."),
  conversion: quantityConversionProperty,
}, ["result", "source", "observedAt"]);
const bomAlternativeProperty: JsonObject = object({
  itemId: idProperty("Alternative inventory item."),
  compatible: enumString(["confirmed", "conditional", "unknown"], "Compatibility evidence, not an inferred catalogue match."),
  reason: string("Why this alternative is or is not compatible; converted candidates retain capacity/allocation/overage diagnostics here."),
  quantityConversion: quantityConversionProperty,
}, ["itemId", "compatible"]);
const projectSetupRevisionProperty: JsonObject = object({ id: idProperty("Optional stable revision identifier."), name: string("Revision name."), notes: string("Optional revision notes."), status: string("Initial revision status."), fabricationRoute: fabricationRouteProperty, intendedPrinterItemId: nullableIdProperty("Planning-only owned printer item; omit to inherit, or pass null to clear. Valid only when non-null with printed.") }, ["name", "status"]);
const projectSetupWorkItemRevisionProperty: JsonObject = object({ id: idProperty("Optional stable work-item revision identifier."), name: string("Revision name."), notes: string("Optional revision notes."), status: string("Initial revision status.") }, ["name", "status"]);
const projectSetupWorkItemProperty: JsonObject = object({ localRef: idProperty("Unique proposal-local reference."), id: idProperty("Optional stable work-item identifier."), name: string("Work-item name."), kind: string("Work-item kind."), description: string("Optional work-item description."), revision: projectSetupWorkItemRevisionProperty }, ["localRef", "name", "kind", "revision"]);
const projectSetupBomLineProperty: JsonObject = object({ localRef: idProperty("Unique proposal-local reference."), revisionLocalRef: idProperty("Optional work-item revision reference; defaults to project."), id: idProperty("Optional stable BOM-line identifier."), name: string("Requirement name."), itemId: idProperty("Optional exact inventory item."), role: bomRequirementRoleProperty, requiredQuantity: { ...number("Positive required quantity."), exclusiveMinimum: 0 }, unit: enumString(["each", "gram", "millimetre", "millilitre", "metre", "set"], "Atomic setup uses canonical application units, unlike legacy piece quantities."), optional: boolean("Whether the requirement is optional."), constraints: bomConstraintsProperty, alternatives: { ...array(bomAlternativeProperty), maxItems: 20 }, notes: string("Optional requirement notes.") }, ["localRef", "name", "requiredQuantity", "unit"]);
const projectSetupReservationProperty: JsonObject = object({ localRef: idProperty("Unique proposal-local reference."), bomLineLocalRef: idProperty("BOM-line local reference."), id: idProperty("Optional stable reservation identifier."), itemId: idProperty("Inventory item to reserve."), quantity: { ...number("Positive reservation quantity."), exclusiveMinimum: 0 }, unit: enumString(["each", "gram", "millimetre", "millilitre", "metre", "set"], "Canonical setup reservation unit.") }, ["localRef", "bomLineLocalRef", "itemId", "quantity"]);
const projectSetupProposalProperty: JsonObject = object({
  project: object({ id: idProperty("Optional stable project identifier."), name: string("Project name."), description: string("Optional project description."), status: projectLifecycleProperty }, ["name", "status"]),
  revision: projectSetupRevisionProperty,
  workItems: { ...array(projectSetupWorkItemProperty), maxItems: 6 },
  bomLines: { ...array(projectSetupBomLineProperty), minItems: 1, maxItems: 24 },
  reservations: { ...array(projectSetupReservationProperty), maxItems: 48 }
}, ["project", "revision", "bomLines"]);

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
// One flat object with a `kind` discriminator: root-level oneOf/anyOf is
// rejected by common model tool APIs. The validator enforces each variant.
const catalogProductCreateSchema: JsonObject = {
  type: "object",
  description: "kind=filament requires manufacturer, materialFamily, colourName, diameterMm, nominalNetMassG and lengthBasis. kind=printer requires manufacturer, exactModel, technology (fff) and buildVolumeMm.",
  properties: {
    ...(catalogFilamentProperty.properties as Record<string, JsonValue>),
    ...(catalogPrinterProperty.properties as Record<string, JsonValue>),
    kind: enumString(["filament", "printer"], "Exact catalog kind; selects which fields apply."),
    lengthBasis: enumString(["manufacturer_declared", "calculated", "unknown"]),
    technology: enumString(["fff"]),
  },
  required: ["kind", "manufacturer"],
  additionalProperties: false,
};
const profileDetailsProperty: JsonObject = object({
  lot: string("Filament lot identifier."), batch: string("Filament batch identifier."), lotCode: string("Optional supplier lot code."),
  openedState: string("sealed, open, or unknown."), openedAt: string("ISO timestamp when opened."), tareMassG: number("Optional empty-spool tare mass."),
  currentPlacement: string("Current physical placement."), dryingHistory: string("Drying history note."), assetLabel: string("Local printer asset label."),
  commissionedAt: string("ISO commissioning timestamp."), location: string("Physical location."), condition: string("new, good, worn, needs_repair, or unknown."),
});
const inventoryItemCreateProperty: JsonObject = object({
  name: string("Human-readable inventory item name."),
  category: inventoryKindProperty(),
  categoryNodeId: categoryIdProperty("Optional user-managed category or subcategory assignment."),
  quantity: quantityProperty,
  evidence: object({ state: enumString(MCP_EVIDENCE_STATES, "Canonical: physically_counted, commissioned, delivered_uncounted, ordered_unverified, allocated, consumed, unknown. Legacy input aliases: physical_count, delivery, order; measured/manufacturer/user_reported/inferred store unknown. Never infer a physical observation."), source: string(), sourceId: string("Optional source reference."), recordedAt: string("ISO-8601 observation time."), note: string() }, ["state", "source", "recordedAt"]),
  description: string(), manufacturer: string(), model: string(), sku: string(),
  dimensions: dimensionsProperty,
  condition: conditionProperty, location: string(), tags: { ...array(string("Searchable tag.")), maxItems: 50 }, links: linksProperty,
}, ["name", "category", "quantity", "evidence"]);
const inventoryProductProfileCreateProperty: JsonObject = object({
  catalogProductId: idProperty("Exact catalog product identifier."),
  profileType: enumString(["filament_spool", "printer_asset"]),
  linkState: enumString(["confirmed", "reported", "suggested"]),
  details: profileDetailsProperty,
}, ["catalogProductId", "profileType", "linkState", "details"]);
const inventoryWithProductProfileProperty: JsonObject = object({
  item: inventoryItemCreateProperty,
  profile: inventoryProductProfileCreateProperty,
}, ["item", "profile"]);
const inventoryBulkTargetProperty: JsonObject = object({
  itemId: idProperty("Explicit inventory item identifier."),
  expectedVersion: { ...integer("Current item version required for this atomic batch."), minimum: 1 },
}, ["itemId", "expectedVersion"]);
const inventoryBulkChangesProperty: JsonObject = object({
  location: string("Replacement physical location; must not be blank."),
  condition: conditionProperty,
  tags: { ...object({
    add: { ...array(string("Tag to add; tags are normalized case-insensitively.")), minItems: 1, maxItems: 50 },
    remove: { ...array(string("Tag to remove; tags are normalized case-insensitively.")), minItems: 1, maxItems: 50 },
  }), minProperties: 1 },
}, []);
const inventoryCommissionProperty: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    itemId: idProperty("Uncertain inventory item to commission."),
    expectedVersion: expectedVersionProperty("Inventory item version read before commissioning."),
    quantity: quantityProperty,
    evidence: object({
      state: { const: "commissioned", description: "Required deliberate commissioning evidence state." },
      source: string("Where the commissioning observation came from."),
      sourceId: string("Optional source reference."),
      recordedAt: string("ISO-8601 commissioning observation timestamp."),
      note: string("What was observed during commissioning."),
    }, ["state", "source", "recordedAt"]),
  },
  required: ["itemId", "expectedVersion", "quantity", "evidence"],
};
const descriptorProperty: JsonObject = {
  oneOf: [string("Short descriptor."), object({
    name: string(), version: string(), model: string(), material: string(), side: string(), type: string(), surface: string(),
    diameterMm: number(), nozzleMaterial: string(), state: string(), recordedAt: string(), quantity: number(),
  })],
};
const exactFilamentSelectionProperty: JsonObject = object({
  itemId: idProperty("Physical filament inventory item."),
  catalogProductId: idProperty("Exact filament catalog product identity."),
  profileId: idProperty("Optional exact physical-spool profile."),
  role: string("Optional material role."),
  quantity: number("Optional selection quantity."),
}, ["itemId", "catalogProductId"]);
const physicalOnlyFilamentSelectionProperty: JsonObject = object({
  itemId: idProperty("Physical filament inventory item."),
  catalogIdentityState: { type: "string", const: "unknown", description: "Catalog identity is intentionally unknown." },
  role: string("Optional material role."),
  quantity: number("Optional selection quantity."),
}, ["itemId", "catalogIdentityState"]);
const filamentSelectionProperty: JsonObject = {
  oneOf: [exactFilamentSelectionProperty, physicalOnlyFilamentSelectionProperty],
  description: "Use exactly one branch. Physical-only selections return a copied label and evidence, but infer no compatibility, availability, or catalog identity; their configuration remains design-open and production approval is blocked.",
};
const snapshotCreateProperties: Record<string, JsonValue> = {
  projectRevisionId: idProperty("Project revision that owns the immutable snapshot."),
  printerItemSnapshot: object({ itemId: idProperty("Inventory printer item."), catalogProductId: idProperty("Exact printer catalog product."), profileId: idProperty("Optional linked printer profile.") }, ["itemId", "catalogProductId"]),
  filamentSelections: array(filamentSelectionProperty),
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
  bomLineId: idProperty("BOM line whose active reservations are being accounted for; zero-reservation lines may be omitted."),
  outcomes: { ...array(reconciliationOutcomeProperty), description: "Disposition outcomes for active reservations, or one optional reviewed_no_change outcome for a zero-reservation line." },
}, ["bomLineId", "outcomes"]);

const artifactScopeProjectRevisionProperties = {
  projectId: idProperty("Project identifier."),
  projectRevisionId: idProperty("Exact project revision identifier."),
};
const artifactScopeWorkItemRevisionProperties = {
  projectId: idProperty("Project identifier."),
  workItemId: idProperty("Work-item identifier."),
  workItemRevisionId: idProperty("Exact work-item revision identifier."),
};
const artifactListProperties = {
  ...pageProperties,
  role: string("Optional artifact role filter."),
};
// Flat object: scope combinations (projectId only; plus projectRevisionId; or
// plus workItemId and workItemRevisionId) are enforced by the validator.
const artifactListInputSchema: JsonObject = object({
  ...artifactListProperties,
  projectId: idProperty("Project identifier; alone it lists every artifact revision in the project."),
  projectRevisionId: idProperty("Exact project revision scope; do not combine with work-item fields."),
  workItemId: idProperty("Work-item scope; requires workItemRevisionId."),
  workItemRevisionId: idProperty("Exact work-item revision; requires workItemId."),
  role: enumString(["source", "cad", "cad_source", "step", "stl", "three_mf", "slicer_project", "gcode", "drawing", "validation", "document", "brief", "design_record", "firmware", "photo", "text", "other"], "Optional artifact role filter."),
}, ["projectId"]);
const artifactUploadCommonProperties = {
  projectId: idProperty("Project identifier."),
  filename: string("Safe filename, not a path."),
  role: string("source, cad, cad_source, step, stl, three_mf, slicer_project, gcode, drawing, validation, document, brief, design_record, firmware, photo, text, or other."),
  mediaType: string(),
  byteLength: integer("Declared byte length; the application verifies it before finalization."),
  sha256: string("Required SHA-256 digest of the bytes to be uploaded."),
};
const artifactUploadInputSchema: JsonObject = {
  oneOf: [
    object({
      ...artifactUploadCommonProperties,
      projectRevisionId: idProperty("Exact project revision identifier."),
      buildConfigurationSnapshotId: idProperty("Optional immutable build-configuration snapshot to bind at finalize."),
    }, ["projectId", "projectRevisionId", "filename", "role", "mediaType", "byteLength", "sha256"]),
    object({
      ...artifactUploadCommonProperties,
      ...artifactScopeWorkItemRevisionProperties,
    }, ["projectId", "workItemId", "workItemRevisionId", "filename", "role", "mediaType", "byteLength", "sha256"]),
  ],
};

// Compatibility dispatch only: these are deliberately absent from discovery.
export const LEGACY_TRANSFER_DEFINITIONS: readonly McpToolDefinition[] = [
  { name: "begin_artifact_upload", description: "Unavailable through generic MCP.", requiredScope: "artifacts:write", mutating: true, inputSchema: artifactUploadInputSchema },
  tool("finalize_artifact_upload", "Unavailable through generic MCP.", "artifacts:write", true, { uploadId: idProperty() }, ["uploadId"]),
  tool("read_artifact_download_metadata", "Unavailable through generic MCP.", "artifacts:read", false, { artifactId: idProperty(), revisionId: idProperty() }, ["artifactId"]),
  tool("download_artifact", "Unavailable through generic MCP.", "artifacts:read", false, { artifactId: idProperty(), revisionId: idProperty() }, ["artifactId"]),
];

export const TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  ...MAKER_TOOL_DEFINITIONS,
  ...INVENTORY_IMAGE_TOOLS,
  tool("read_inventory_summary", "Read whole-inventory counts by availability and semantic kind. Takes no arguments; it always scans every item.", "inventory:read", false, {}),
  tool("list_inventory", "List equipment, tools, consumables, and electronics with evidence-aware availability.", "inventory:read", false, { ...filteredPageProperties, query: string(), category: inventoryKindProperty("Semantic item kind filter; unknown values are rejected."), categoryNodeId: categoryIdProperty("Exact user-managed category or subcategory."), unassigned: boolean("Only inventory without a managed category assignment; cannot be combined with categoryNodeId."), availability: availabilityProperty, location: string() }),
  tool("read_inventory_item", "Read one inventory item, including dimensions, links, evidence, and current quantity.", "inventory:read", false, { itemId: idProperty("Inventory item identifier.") }, ["itemId"]),
  tool("create_inventory_item", "Add a stock record with an explicit evidence state. Only physically_counted or commissioned evidence counts as usable stock.", "inventory:write", true, inventoryItemCreateProperty.properties as Record<string, JsonValue>, ["name", "category", "quantity", "evidence"]),
  tool("create_inventory_with_product_profile", "Atomically create one physical printer or filament inventory item and its exact product profile. Requires inventory:write and catalog:write; retries with the same idempotencyKey replay safely.", "inventory:write", true, inventoryWithProductProfileProperty.properties as Record<string, JsonValue>, ["item", "profile"]),
  tool("update_inventory_item", "Update descriptive inventory metadata and optionally assign a user-managed category. expectedVersion is required; tags replace the full normalized tag list when supplied.", "inventory:write", true, { itemId: idProperty("Inventory item identifier."), expectedVersion: expectedVersionProperty(), name: string(), category: inventoryKindProperty(), categoryNodeId: nullableCategoryIdProperty("Optional category assignment; null clears it."), description: string(), manufacturer: string(), model: string(), sku: string(), dimensions: dimensionsProperty, condition: conditionProperty, location: string(), tags: { ...array(string("Replacement searchable tag.")), maxItems: 50 }, links: linksProperty }, ["itemId", "expectedVersion"]),
  tool("bulk_update_inventory_items", "Apply one bounded atomic metadata batch to explicit inventory items with optimistic versions. Supports only location, canonical condition, and normalized tag add/remove; all targets preflight together and no-op targets are not versioned or audited.", "inventory:write", true, { targets: { ...array(inventoryBulkTargetProperty), minItems: 1, maxItems: 100 }, changes: inventoryBulkChangesProperty }, ["targets", "changes"]),
  tool("commission_inventory_item", "Promote delivered or ordered inventory to commissioned with an observed quantity and provenance; records an append-only count event and preserves prior evidence. This (or an inspection commit) is how uncertain stock becomes counted. Requires expectedVersion; idempotencyKey is optional (derived from the arguments when omitted).", "inventory:write", true, inventoryCommissionProperty.properties as Record<string, JsonValue>, ["itemId", "expectedVersion", "quantity", "evidence"]),
  tool("record_stock_event", "Record one append-only receipt, count correction, allocation, use, return, loss, or disposal event. count_correction adjusts already-counted stock only; it never makes delivered/ordered stock counted (use commission_inventory_item).", "inventory:write", true, { itemId: idProperty("Inventory item identifier."), kind: enumString(["receipt", "count_correction", "allocation", "return", "use", "loss", "disposal"]), quantity: quantityProperty, note: string() }, ["itemId", "kind", "quantity"]),
  tool("retire_inventory_item", "Retire (soft-delete) one inventory item. It disappears from ordinary lists and matching; its stock events and audit history are retained. expectedVersion is required.", "inventory:write", true, { itemId: idProperty("Inventory item identifier."), expectedVersion: expectedVersionProperty() }, ["itemId", "expectedVersion"]),
  tool("list_stock_events", "List the append-only stock event history for one item.", "inventory:read", false, { ...pageProperties, itemId: idProperty("Inventory item identifier.") }, ["itemId"]),
  tool("list_inventory_categories", "List the bounded user-managed inventory taxonomy; semantic inventory kinds remain closed and separate.", "inventory:read", false, { ...categoryPageProperties, includeArchived: boolean("Include archived categories.") }),
  tool("read_inventory_category", "Read one user-managed inventory category or subcategory.", "inventory:read", false, { categoryId: categoryIdProperty("Inventory category identifier.") }, ["categoryId"]),
  tool("create_inventory_category", "Create a top-level category or one-level subcategory with a stable identifier.", "inventory:write", true, { id: categoryIdProperty("Optional stable category identifier."), name: string("Category name."), parentId: categoryIdProperty("Optional top-level parent category."), sortOrder: integer("Deterministic sibling order.") }, ["name"]),
  tool("update_inventory_category", "Rename or reorder a category using optimistic versioning; its parent is immutable after creation.", "inventory:write", true, { categoryId: categoryIdProperty("Inventory category identifier."), expectedVersion: expectedVersionProperty(), name: string("Replacement category name."), sortOrder: integer("Replacement sibling order.") }, ["categoryId", "expectedVersion"]),
  tool("archive_inventory_category", "Archive a category using a dedicated optimistic-version command; active children or inventory references block the archive.", "inventory:write", true, { categoryId: categoryIdProperty("Inventory category identifier."), expectedVersion: expectedVersionProperty() }, ["categoryId", "expectedVersion"]),

  tool("search_catalog_products", "Search the curated starter catalog and workspace-added exact printer and filament products with bounded pagination; identity fields are searched, read-only provenance URLs are not, and results never assert physical stock.", "catalog:read", false, { ...pageProperties, query: string("Case-insensitive identity/specification search; provenance URLs are excluded."), kind: enumString(["filament", "printer"]) }),
  tool("read_catalog_product", "Read one exact catalog product, including server-owned provenance when present. Catalog identity is not evidence that a matching physical item exists.", "catalog:read", false, { productId: idProperty("Catalog product identifier.") }, ["productId"]),
  { name: "create_catalog_product", description: "Create one exact manufacturer filament product or printer model in the local catalog. Set kind first; the description lists the fields each kind requires.", requiredScope: "catalog:write", mutating: true, inputSchema: catalogProductCreateSchema },
  tool("update_catalog_product", "Correct an exact catalog product; expectedVersion is required and product kind cannot change.", "catalog:write", true, { productId: idProperty("Catalog product identifier."), expectedVersion: expectedVersionProperty(), manufacturer: string(), productName: string(), sku: string(), materialFamily: string(), materialSubtype: string(), colourName: string(), colourCode: string(), diameterMm: number(), nominalNetMassG: number(), nominalLengthM: number(), lengthBasis: enumString(["manufacturer_declared", "calculated", "unknown"]), densityGcm3: number(), exactModel: string(), exactVariant: string(), technology: enumString(["fff"]), buildVolumeMm: buildVolumeProperty }, ["productId", "expectedVersion"]),
  tool("read_inventory_product_profile", "Read the exact-product link for one physical inventory item without exposing serials or implying stock confirmation.", "catalog:read", false, { itemId: idProperty("Inventory item identifier.") }, ["itemId"]),
  tool("link_inventory_product_profile", "Link one physical printer or filament inventory item to an exact catalog product; reported and suggested links remain non-confirming.", "catalog:write", true, { itemId: idProperty("Inventory item identifier."), expectedVersion: { ...integer("Current profile version; required when a profile already exists, omitted only for the first link."), minimum: 1 }, catalogProductId: idProperty("Exact catalog product identifier."), profileType: enumString(["filament_spool", "printer_asset"]), linkState: enumString(["confirmed", "reported", "suggested"]), details: profileDetailsProperty }, ["itemId", "catalogProductId", "profileType", "linkState", "details"]),

  tool("list_projects", "List projects with bounded pagination and canonical lifecycle filtering.", "projects:read", false, { ...pageProperties, query: string(), status: projectLifecycleProperty }),
  tool("list_removed_projects", "List retained project-removal tombstones. Removed projects are excluded from ordinary lists and cannot be restored or purged.", "projects:read", false, pageProperties),
  tool("read_project", "Read a project identity and current lifecycle state.", "projects:read", false, { projectId: idProperty("Project identifier.") }, ["projectId"]),
  tool("create_project", "Create a project workspace for an end-to-end build.", "projects:write", true, { name: string(), description: string() }, ["name"]),
  tool("create_project_with_initial_revision", "Atomically create a project and its first revision. fabricationRoute is planning metadata; a non-null intendedPrinterItemId requires printed and is never a BOM line. projectId/revisionId are stable identities, not replay keys; pass idempotencyKey for replayable retries. Conflicts report project_id_exists, revision_id_exists, project_name_exists or idempotency_key_reused and commit nothing.", "projects:write", true, { name: string(), description: string(), projectId: idProperty("Optional stable project identity; it does not make a command idempotent."), revisionId: idProperty("Optional stable initial revision identity; it does not make a command idempotent."), revisionSummary: string("Optional summary for the initial planning revision."), fabricationRoute: fabricationRouteProperty, intendedPrinterItemId: nullableIdProperty("Planning-only owned printer item; omit to leave unassigned, or pass null to explicitly clear. A non-null value requires printed.") }, ["name"]),
  tool("preview_project_setup", "Preview a project, initial revision, up to 6 work items, 24 BOM lines and 48 reservations. Only consumed-role lines may reserve stock; null role needs review. Stores only an actor-owned 30-minute preview (no project, stock or audit changes) and returns gaps, inventory basis and a content hash for commit_project_setup.", "projects:write", false, projectSetupProposalProperty.properties as Record<string, JsonValue>, ["project", "revision", "bomLines"]),
  tool("commit_project_setup", "Commit an exact project setup preview atomically. Requires project and BOM write scopes, the preview version/hash, and confirmReservations when reservations are planned. idempotencyKey is optional (derived when omitted). A stale basis returns a conflict with recoveryAction preview_project_setup.", "bom:write", true, { previewId: idProperty("Actor-owned preview identifier."), expectedPreviewVersion: { ...integer("Preview version."), minimum: 1 }, contentSha256: string("Preview content SHA-256."), confirmReservations: boolean("Explicitly approve planned reservations.") }, ["previewId", "expectedPreviewVersion", "contentSha256", "confirmReservations"]),
  tool("update_project", "Update project metadata or its canonical lifecycle; expectedVersion is required.", "projects:write", true, { projectId: idProperty("Project identifier."), expectedVersion: expectedVersionProperty(), name: string(), description: string(), status: projectLifecycleProperty }, ["projectId", "expectedVersion"]),
  tool("archive_project", "Reversibly archive a project: hide it from default lists, release active reservations, and retain all revisions, artifacts, stock evidence, and audit history. expectedVersion is required.", "projects:write", true, { projectId: idProperty("Project identifier."), expectedVersion: expectedVersionProperty() }, ["projectId", "expectedVersion"]),
  tool("restore_project", "Restore an archived project to idea; history remains intact and released reservations are never recreated. expectedVersion is required.", "projects:write", true, { projectId: idProperty("Project identifier."), expectedVersion: expectedVersionProperty() }, ["projectId", "expectedVersion"]),
  tool("remove_project", "Irreversibly remove a project from the workspace. Hosts must obtain explicit human approval first. Requires the current expectedVersion and exact case-sensitive project-name confirmation; releases every active reservation with evidence, keeps a tombstone/history, and never restores or purges.", "projects:write", true, { projectId: idProperty("Project identifier."), expectedVersion: expectedVersionProperty("Current project version required for removal."), projectName: string("Exact case-sensitive project name confirmation.") }, ["projectId", "expectedVersion", "projectName"], true),
  tool("read_removed_project_history", "Read retained append-only audit history for a removed project.", "projects:read", false, { ...pageProperties, projectId: idProperty("Removed project identifier.") }, ["projectId"]),
  tool("create_work_item", "Create a versioned part, assembly, electronics, firmware, or document within a project.", "projects:write", true, { projectId: idProperty("Project identifier."), name: string(), kind: enumString(["part", "assembly", "electronics", "firmware", "document", "other"]), description: string() }, ["projectId", "name", "kind"]),
  tool("read_work_item", "Read one project work item.", "projects:read", false, { workItemId: idProperty("Work-item identifier.") }, ["workItemId"]),
  tool("create_project_revision", "Create a versioned planning revision for a project. fabricationRoute is planning metadata; omitted route and printer fields carry forward the current route and intended printer. Omit intendedPrinterItemId to inherit it, or pass null to explicitly clear it. A non-null printer requires printed and is planning equipment, not a BOM or build configuration.", "projects:write", true, { projectId: idProperty("Project identifier."), summary: string(), fabricationRoute: fabricationRouteProperty, intendedPrinterItemId: nullableIdProperty("Planning-only owned printer item; omit to inherit, or pass null to clear. A non-null value requires printed.") }, ["projectId"]),
  tool("update_project_revision", "Narrowly update a project revision's fabricationRoute and planning-only intendedPrinterItemId. Pass null to clear the printer assignment; a non-null printer requires printed. expectedVersion is required to protect the revision from stale writes. This does not change lifecycle, evidence, BOM, or build configuration.", "projects:write", true, { revisionId: idProperty("Project revision identifier."), expectedVersion: { ...integer("Required current revision version."), minimum: 1 }, fabricationRoute: fabricationRouteProperty, intendedPrinterItemId: nullableIdProperty("Planning-only owned printer item; null clears it.") }, ["revisionId", "expectedVersion"]),
  tool("read_project_revision", "Read one project planning revision, its status, persisted summary, and canonical fabricationRoute (printed, ready_made, none, or undecided). intendedPrinterItemId is planning equipment only and is never a BOM or build-configuration snapshot.", "projects:read", false, { revisionId: idProperty("Project revision identifier.") }, ["revisionId"]),
  tool("create_work_item_revision", "Create a versioned engineering revision for a work item.", "projects:write", true, { workItemId: idProperty("Work-item identifier."), summary: string() }, ["workItemId"]),
  tool("read_work_item_revision", "Read one work-item engineering revision.", "projects:read", false, { revisionId: idProperty("Work-item revision identifier.") }, ["revisionId"]),

  tool("list_bom_lines", "List active requirements for one project revision, with retired history only when explicitly requested. Each line returns role consumed, reusable, or null; null is legacy intent that requires review before reservation, usage, or reconciliation.", "bom:read", false, { ...pageProperties, projectRevisionId: idProperty("Project revision identifier."), includeRetired: boolean() }, ["projectRevisionId"]),
  tool("create_bom_line", "Add one required or optional BOM requirement with evidence-bearing compatible alternatives and an optional stock role: consumed depletes stock when used, reusable remains owned. Omit role or pass null only for legacy records requiring review; only consumed requirements may reserve, consume, or reconcile.", "bom:write", true, { projectRevisionId: idProperty("Project revision identifier."), description: string(), quantity: number(), unit: unitProperty(), requirement: enumString(["required", "optional"]), role: bomRequirementRoleProperty, itemId: idProperty("Exact inventory item, when known."), alternatives: array(bomAlternativeProperty), compatibleItemIds: array(string("Deprecated IDs-only alternative list; use alternatives for compatibility evidence.")), constraints: bomConstraintsProperty, notes: string() }, ["projectRevisionId", "description", "quantity", "unit"]),
  tool("update_bom_line", "Update one BOM requirement and its evidence-bearing alternatives; expectedVersion is required. Role consumed or reusable controls stock behavior; null clears it to review-required. Only consumed requirements may reserve, consume, or reconcile.", "bom:write", true, { bomLineId: idProperty("BOM line identifier."), expectedVersion: expectedVersionProperty(), description: string(), quantity: number(), unit: unitProperty(), requirement: enumString(["required", "optional"]), role: bomRequirementRoleProperty, itemId: { anyOf: [idProperty(), { type: "null" }], description: "Null clears the selected item; omission preserves it." }, alternatives: array(bomAlternativeProperty), compatibleItemIds: array(string("Deprecated IDs-only alternative list; use alternatives for compatibility evidence.")), constraints: bomConstraintsProperty, notes: string() }, ["bomLineId", "expectedVersion"]),
  tool("retire_bom_line", "Retire a BOM requirement without erasing its history.", "bom:write", true, { bomLineId: idProperty("BOM line identifier."), expectedVersion: expectedVersionProperty() }, ["bomLineId", "expectedVersion"]),
  tool("restore_bom_line", "Restore a retired BOM requirement with optimistic versioning.", "bom:write", true, { bomLineId: idProperty("BOM line identifier."), expectedVersion: expectedVersionProperty() }, ["bomLineId", "expectedVersion"]),
  tool("calculate_bom_gaps", "Evaluate BOM lines as Ready, Check, Decide or Source with candidate available/supplied/inspect quantities in the requirement unit. Under-specified or unconfirmed lines stay Check/Decide and are never buy recommendations. totals cover the whole revision; lines are paged (default 50) with nextCursor.", "bom:read", false, { ...pageProperties, limit: { ...integer("Lines per page; defaults to 50."), minimum: 1, maximum: 100 }, cursor: { ...string("Cursor from the previous page."), maxLength: 20 }, projectRevisionId: idProperty("Project revision identifier.") }, ["projectRevisionId"]),
  tool("list_reservations", "List reservations for one project revision with bounded pagination, including active and historical states. Start project close-out here and submit outcomes only for reservations still active; released, consumed, and settled records remain available for audit.", "bom:read", false, { ...pageProperties, projectRevisionId: idProperty("Project revision identifier.") }, ["projectRevisionId"]),
  tool("read_reservation", "Read one reservation and its durable project-revision identity.", "bom:read", false, { reservationId: idProperty("Reservation identifier.") }, ["reservationId"]),
  tool("create_reservation", "Reserve confirmed stock for one consumed BOM line; reusable requirements and legacy null-role lines are not reservable, and uncertain stock is never silently reserved.", "bom:write", true, { projectRevisionId: idProperty("Project revision identifier."), bomLineId: idProperty("BOM line identifier; its role must be consumed."), itemId: idProperty("Inventory item identifier."), quantity: quantityProperty }, ["projectRevisionId", "bomLineId", "itemId", "quantity"]),
  tool("release_reservation", "Release one stock reservation; expectedVersion is required.", "bom:write", true, { reservationId: idProperty("Reservation identifier."), expectedVersion: expectedVersionProperty() }, ["reservationId", "expectedVersion"]),
  tool("record_usage", "Record actual consumption against a reservation for a consumed BOM line. Reusable requirements and legacy null-role lines cannot be consumed; use release_reservation when stock was not used.", "bom:write", true, { projectRevisionId: idProperty("Project revision identifier."), reservationId: idProperty("Required reservation identifier for a consumed BOM line."), itemId: idProperty("Inventory item identifier."), quantity: quantityProperty, note: string() }, ["projectRevisionId", "reservationId", "itemId", "quantity"]),

  tool("list_inspections", "List the derived human inspection queue for one project revision. Actions come only from required canonical Check gaps; optional, Decide, Source, and Ready lines never appear. The queue is recomputed from current inventory and BOM evidence, sorted by deterministic action id, and paginated with an exhaustive candidate scan.", "bom:read", false, { ...pageProperties, projectRevisionId: idProperty("Project revision identifier.") }, ["projectRevisionId"]),
  tool("read_inspection", "Read one current derived inspection action by id. Action rows are not persisted; a resolved or changed candidate disappears and callers should list_inspections again.", "bom:read", false, { projectRevisionId: idProperty("Project revision identifier."), inspectionId: idProperty("Inspection action identifier.") }, ["projectRevisionId", "inspectionId"]),
  tool("preview_inspection_completion", "Create an actor-bound, expiring completion preview for one inspection action: the observation, before/after item, lines and gaps, and the version/hash basis. Records no stock, BOM, evidence or audit change. Show it to the human; commit only after explicit confirmation.", "bom:write", false, { projectRevisionId: idProperty("Project revision identifier."), inspectionId: idProperty("Inspection action identifier."), observation: inspectionObservationProperty }, ["projectRevisionId", "inspectionId", "observation"]),
  tool("commit_inspection_completion", "Commit a human-confirmed inspection preview. Requires bom:write and inventory:write; rechecks the preview basis atomically, appends inspection evidence, applies confirmed counts and only explicitly confirmed compatibility/conversion updates. idempotencyKey is optional (derived when omitted). Returns current gaps and queue.", "bom:write", true, { projectRevisionId: idProperty("Project revision identifier."), inspectionId: idProperty("Inspection action identifier."), previewId: idProperty("Actor-bound completion preview identifier."), expectedPreviewVersion: { ...integer("Preview version."), minimum: 1 }, contentSha256: string("Preview content SHA-256."), confirmed: { const: true, description: "Explicit human confirmation is required." } }, ["projectRevisionId", "inspectionId", "previewId", "expectedPreviewVersion", "contentSha256", "confirmed"]),

  tool("read_reconciliation", "Read the review-only close-out document for a project revision. A missing draft is normal before the first save; this never changes stock. The preview and basis retain every BOM line, reservation, and source item even when the submitted review contains only active-reservation lines.", "bom:read", false, { projectRevisionId: idProperty("Project revision identifier.") }, ["projectRevisionId"]),
  tool("save_reconciliation_draft", "Save a close-out draft and server preview for consumed-role BOM lines with active reservations (list_reservations first). Zero-reservation lines may be omitted or given one reviewed_no_change outcome. Never changes stock. Omit draftId for the first save; when updating a draft, draftId and expectedVersion are required. Use a different idempotencyKey from the commit.", "bom:write", true, { projectRevisionId: idProperty("Project revision identifier."), draftId: idProperty("Existing draft identifier."), expectedVersion: expectedVersionProperty("Draft version read before editing; required with draftId."), lines: array(reconciliationLineProperty) }, ["projectRevisionId", "lines"]),
  tool("commit_reconciliation", "Commit a human-reviewed close-out for consumed-role BOM lines. Every active reservation must be exactly accounted for. Applies stock, reservation and reusable-asset changes atomically against the full basis. A retry with the same idempotencyKey and payload replays safely.", "bom:write", true, { projectRevisionId: idProperty("Project revision identifier."), draftId: idProperty("Draft to commit."), expectedVersion: expectedVersionProperty("Draft version read before confirmation.") }, ["projectRevisionId", "draftId", "expectedVersion"]),

  tool("create_build_configuration", "Create an immutable build-configuration snapshot for a project revision. Exact filament identities copy catalog/profile facts; physical-only filament selections copy only the inventory label/evidence, infer no compatibility, availability, or catalog identity, and leave the snapshot design-open with production approval blocked.", "projects:write", true, snapshotCreateProperties, ["projectRevisionId", "printerItemSnapshot", "filamentSelections", "activeHotend", "nozzle", "plate", "accessories", "firmware", "slicer", "profile", "calibration", "explicitUnknowns"]),
  tool("list_build_configurations", "List immutable build-configuration snapshots for one project revision with bounded pagination.", "projects:read", false, { ...pageProperties, projectRevisionId: idProperty("Project revision identifier.") }, ["projectRevisionId"]),
  tool("read_build_configuration", "Read one immutable build-configuration snapshot, including copied product/profile facts for exact selections and physicalLabel/physicalEvidence for physical-only selections. Physical-only identity infers no compatibility, availability, or catalog identity; explicitUnknowns keep it design-open and production approval blocked.", "projects:read", false, { buildConfigurationId: idProperty("Build-configuration snapshot identifier.") }, ["buildConfigurationId"]),

  { name: "list_artifacts", description: "List versioned artifact metadata read-only. Supply only projectId for every artifact in the project, or add exactly one scope: projectRevisionId, or workItemId plus workItemRevisionId.", requiredScope: "artifacts:read", mutating: false, inputSchema: artifactListInputSchema },
  tool("read_artifact_metadata", "Read file metadata, hash, provenance, role, and revision without downloading bytes.", "artifacts:read", false, { artifactId: idProperty("Artifact identifier."), revisionId: idProperty() }, ["artifactId"]),
  tool("retire_artifact", "Retire a logical artifact revision while retaining its content hash and audit record; expectedVersion is required.", "artifacts:write", true, { artifactId: idProperty("Artifact identifier."), expectedVersion: expectedVersionProperty() }, ["artifactId", "expectedVersion"]),

  tool("list_offers", "List supplier offer observations and historical prices; links are data and are not fetched by BenchLedger.", "offers:read", false, { ...filteredPageProperties, itemId: idProperty(), query: string(), supplier: string() }),
  tool("record_offer_snapshot", "Record a supplier link and price observation for shopping-list comparison; this never purchases.", "offers:write", true, { itemId: idProperty(), description: string(), supplier: string(), url: string(), packageQuantity: quantityProperty, price: object({ minor: integer(), currency: string() }, ["minor", "currency"]), shippingMinor: integer(), observedAt: string() }, ["supplier", "url", "price"]),
  tool("refresh_context", "Read a small live snapshot: server time, inventory attention counts (first 100 items) and, with projectId, the project's status, version, current revision and blocked state. Optional; use it to re-check state before a write.", "context:read", false, { projectId: idProperty("Optional project to include."), includeInventory: boolean("Set false to skip the inventory counts.") }),
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
  { uriTemplate: "benchledger://projects/{projectId}/context", name: "Project context", description: "Bounded project context, selected revision summary, and next actions.", mimeType: "application/json" },
  { uriTemplate: "benchledger://projects/{projectId}/revisions/{revisionId}", name: "Project revision", description: "One versioned project planning revision.", mimeType: "application/json" },
  { uriTemplate: "benchledger://projects/{projectId}/revisions/{revisionId}/build-configurations", name: "Revision build configurations", description: "Immutable build-configuration snapshots owned by one project revision.", mimeType: "application/json" },
  { uriTemplate: "benchledger://build-configurations/{buildConfigurationId}", name: "Build configuration", description: "One immutable build-configuration snapshot; physical-only filament selections return copied physicalLabel/physicalEvidence and remain design-open until catalog identity is resolved.", mimeType: "application/json" },
  { uriTemplate: "benchledger://projects/{projectId}/revisions/{revisionId}/reconciliation", name: "Project reconciliation", description: "Review-only close-out draft and server preview for a project revision; reading it never changes stock.", mimeType: "application/json" },
  { uriTemplate: "benchledger://projects/{projectId}/bom", name: "Project BOM", description: "Bounded BOM lines for a project revision/workspace.", mimeType: "application/json" },
  { uriTemplate: "benchledger://projects/{projectId}/artifacts", name: "Project artifacts", description: "Bounded read-only artifact metadata for all artifacts in a project; exact revision filters are available through list_artifacts. Bytes remain behind authenticated host-mediated transfer. Generic MCP exposes no live URL, header, token, or file bytes.", mimeType: "application/json" },
];

export const CAPABILITY_DOCUMENT: JsonObject = {
  product: "BenchLedger",
  contractVersion: "0.1",
  modelNeutral: true,
  summary: "Evidence-first inventory and versioned project workspace for 3D printing and electronics.",
  resources: RESOURCES as unknown as JsonValue,
  resourceTemplates: RESOURCE_TEMPLATES as unknown as JsonValue,
  // Compact index only: descriptions and schemas live in tools/list.
  tools: TOOL_DEFINITIONS.map((definition) => ({ name: definition.name, requiredScope: definition.requiredScope, mutating: definition.mutating, ...(definition.approvalRequired === undefined ? {} : { approvalRequired: definition.approvalRequired }), ...(toolAnnotations(definition).destructiveHint ? { destructive: true } : {}) })) as unknown as JsonValue,
  toolDiscovery: "Call tools/list for descriptions, input schemas and MCP annotations (readOnlyHint, destructiveHint, idempotentHint). This resource keeps a compact index and the safety semantics.",
  vocabulary: {
    units: "Outputs use canonical units each, gram, millimetre, millilitre, metre and set. Inputs also accept legacy piece (= each) and roll (= packaged set).",
    evidence: "Outputs use canonical evidence physically_counted, commissioned, delivered_uncounted, ordered_unverified, allocated, consumed, unknown. Inputs also accept legacy physical_count, delivery and order; measured, manufacturer, user_reported and inferred store unknown.",
    condition: "Outputs use new, good, worn, needs_repair, unknown. Inputs also accept legacy used (= good) and opened (= worn).",
    category: "category is a closed semantic kind: printer, tool, accessory, consumable, electronic, fastener, filament, wire, adhesive, other. Unknown values are rejected; use categoryNodeId for user-managed categories.",
  },
  errors: "Tool errors return isError with error.code, error.message (the application's own explanation), error.reason (version_conflict, rule_conflict, idempotency_conflict, validation, not_found, forbidden), optional details (expectedVersion/actualVersion, field issues, recoveryAction) and correlationId. version_conflict: re-read and retry with the current version. rule_conflict: change the request; retrying unchanged fails again. idempotency_conflict: resend the identical payload or use a new idempotencyKey.",
  browserAccess: {
    modes: {
      lan_open: "Browser session routes do not require a workspace password. Use only on a trusted LAN: anyone who can reach the configured interface and port can use the browser workspace as an authenticated user, including write actions available to that session.",
      ["password"]: "Browser session routes require the configured workspace password.",
    },
    initialization: "Fresh installations with no password hash start in lan_open mode. Existing hash-configured installations stay password-protected and import that hash into durable settings once; after initialization, the durable setting wins.",
    demo: "Demo mode remains password-protected regardless of the browser access mode setting.",
    sessionInvalidation: "Changing the browser access mode or workspace password invalidates existing browser sessions; the browser must sign in again.",
    mcpBoundary: "Browser access modes affect browser sessions only. /api/v1/mcp always requires a scoped bearer token and never gains implicit LAN access.",
  },
  stockSemantics: {
    confirmed: "Physically counted or commissioned and eligible for automatic reuse when compatibility and quantity match.",
    inspect_first: "Evidence exists but current physical quantity or condition needs a human check before reservation.",
    delivered_uncounted: "Delivery evidence only; never treated as available stock until counted.",
    ordered_unverified: "Order evidence only; never treated as available stock.",
    allocated: "Reserved or assigned stock; availability is reduced by the allocation.",
    depleted: "No remaining usable quantity recorded.",
  },
  bomSemantics: {
    decisions: ["identity", "purpose", "voltage", "current_or_load", "connector", "compatibility", "dimensions", "resistance", "power_rating"],
    outcomes: ["ready", "check", "decide", "source"],
    role: "Each BOM requirement may declare role consumed or reusable. A null or omitted role is retained for legacy rows and requires human review; only consumed requirements may reserve, record usage, or participate in reconciliation. Printers are configured through create_build_configuration and are never treated as BOM stock to reserve or consume.",
    decide: "Requirements with unresolved specification decisions are Decide and return those exact missingDecisions; recommendedAction is specify and they are excluded from shopping proposals.",
    resistor: "LED resistor requirements remain Decide until both resistance and power_rating are recorded; a sufficient claim with only one is still incomplete.",
    shopping: "Only required Source lines may appear in a shopping proposal. Ready, Check, Decide, and optional lines are excluded.",
    quantityConversions: "Structured alternatives may include evidence-backed quantityConversion: one inventory set equals a positive whole number of MCP requirement pieces. MCP maps requirement piece losslessly to REST/application each. Candidate quantities remain in requirement units and candidate reasons preserve capacity, allocation, and overage diagnostics. Missing/invalid conversions and conditional or unknown alternatives remain Check and are never buyable or reservable; valid converted reservations use whole inventory set quantities and read back as set.",
  },
  projectLifecycle: {
    values: ["idea", "planned", "ready", "building", "validating", "complete", "archived"],
    archive: "archive_project hides the project from default lists, releases active reservations with stock-release evidence, and retains revisions, BOM, artifacts, stock events, and audit history; restore_project returns it to idea without recreating reservations.",
    removal: "remove_project is irreversible and approval-required. It requires exact project-name confirmation and expectedVersion, releases every active reservation across every revision with evidence, writes an orthogonal tombstone, excludes the project from ordinary lists, and retains audit history with no restore or purge operation.",
    blocked: "Derived from current required BOM readiness with structured reasons; blocked is never a project lifecycle value.",
    manufacturingEvidence: "Revision-scoped concept/CAD/DFAM/mesh/slicer/test/fit/production evidence remains independent and is never advanced or reset by a project lifecycle change.",
  },
  fabricationPlanning: {
    routes: ["printed", "ready_made", "none", "undecided"],
    intendedPrinter: "Optional planning-only owned printer item. It is accepted only with the printed route, can be cleared with null, is carried to later revisions when omitted, and never creates a BOM line or immutable build-configuration snapshot. Revision reads always expose a canonical route; legacy rows become undecided.",
  },
  scopeBehavior: {
    projectTokens: "A token with projectIds may address only those projects. Project list results are allow-list filtered; workspace-wide aggregate endpoints are rejected.",
    indirectProjectIds: "Revision, work-item, BOM-line, reservation, artifact, and upload identifiers are resolved from durable host state before dispatch. If ancestry cannot be proven, the request is rejected; request-local ID caches are never authoritative.",
    artifacts: "Artifact begin and exact list filters use one closed union: projectRevisionId, or workItemId plus workItemRevisionId. Missing, mixed, legacy revisionId, and revision-less work-item scopes are rejected. list_artifacts with only projectId is the read-only all-artifacts-in-project view, and each returned artifact preserves its exact revision ancestry.",
    inventory: "The inventory catalog and user-managed category taxonomy are shared workspace context. Project-scoped tokens may read inventory, categories, and stock history for matching, but cannot create, update, bulk-update, retire (retire_inventory_item), commission, record stock events, or mutate categories. Uncertain delivery/order evidence becomes counted only through commission_inventory_item (observed quantity, commissioned provenance, expectedVersion) or a confirmed inspection commit; count_correction never promotes it. The prior evidence remains in the append-only count event. Bulk metadata edits require 1-100 explicit itemId/expectedVersion targets and leave no-op rows unaudited.",
    atomicInventoryProfile: "create_inventory_with_product_profile requires both inventory:write and catalog:write on an unscoped token. Its item and profile commit as one audited, idempotent command; a failed profile, audit, idempotency, or binding step compensates the just-created records.",
    catalog: "The runtime starts with a curated, versioned starter catalog of major FFF printer and filament identities. Exact catalog products are shared workspace context; project-scoped tokens may search and read products for in-scope snapshots, but only unscoped catalog tokens may create or correct products. Curated records may expose read-only manufacturer provenance; provenance is excluded from create/update inputs and is not searched as identity.",
    profiles: "Physical product profiles are workspace-global. Profile reads and writes require catalog scope and are not available to project-scoped tokens; reported and suggested links never imply confirmed stock or compatibility.",
    buildConfigurations: "Snapshots require projects:write/read and are authorized through durable project-revision ancestry. They are immutable; corrections create a superseding snapshot. Filaments use a strict exact-or-physical-only oneOf: physical-only selections carry catalogIdentityState='unknown' plus copied physicalLabel/physicalEvidence, infer no compatibility, availability, or catalog identity, and remain design-open with production approval blocked via explicitUnknowns.",
    reconciliation: "Close-out drafts use bom:write and remain review-only until commit_reconciliation. Only consumed-role BOM requirements may be reserved, used, or reconciled; reusable and legacy null-role lines require review and cannot enter close-out. Start with list_reservations and submit/account only lines containing active reservations; every active reservation must be fully and exactly accounted before commit. Zero-reservation BOM lines may be omitted, while reviewed_no_change remains an optional explicit sole outcome for a submitted zero-reservation line. Server previews and staleness bases still retain every BOM line, reservation, and source item. Project-scoped tokens may save and commit only for an allow-listed revision; no inventory:write scope is granted.",
    inspections: "Inspection actions are a derived, non-persisted projection of canonical Check gaps. They are sorted by deterministic SHA-256 identity and disappear when their underlying candidate resolves. Preview requires bom:write but never changes stock or BOM state; completion commit requires both bom:write and inventory:write, a separate idempotency key, confirmed=true, an actor-bound unexpired preview, and an unchanged affected-line/item and relevant-reservation basis. Every completion appends inspection evidence; confirmed physical quantity observations update stock, and only explicitly confirmed compatibility or unit-conversion observations update affected alternatives. The service never infers either value.",
    commandIdempotency: "Every mutating tool accepts an optional idempotencyKey argument (8-200 printable characters); a host Idempotency-Key header is equivalent and, if both are sent, they must match. Commands that require a key (commission, remove_project, commit_project_setup, commit_inspection_completion, bulk_update_inventory_items, add_inventory_image and the maker-workflow writes) derive a deterministic actor/tool/canonical-arguments key when none is supplied, so identical retries replay; repeating the same command deliberately needs a fresh key. Reusing a key for a different payload returns an idempotency_conflict. Stable projectId/revisionId values identify records and never imply replay. Draft save and commit are distinct commands and must use different keys.",
    offers: "Supplier offer observations are shared workspace context. Project-scoped tokens may list offers only with an itemId, but cannot record offer snapshots.",
  },
  approvalBoundaries: [
    "MCP can propose a shopping list and record supplier price observations, but cannot purchase, add to a cart, or submit an order.",
    "MCP can record reservations and usage events only for consumed-role BOM requirements, but cannot start a printer, heat hardware, flash firmware, or generate/submit a print job.",
    "MCP can read artifact metadata and retire an artifact, but cannot execute uploaded files or provide arbitrary filesystem access.",
    "MCP never exposes arbitrary shell, SQL, URL-fetch, path, credential, or database tools.",
    "Public publication, deployment, browser access mode or password changes, other credential changes, and destructive purge require explicit human approval outside this adapter.",
    "approvalRequired and destructiveHint tools (remove_project, retire_*, archive_*) are not gated by the server beyond scopes, versions and confirmations; the MCP host must ask the human before calling them.",
  ],
  artifactTransfer: "The authenticated browser/HTTP Files surface performs revision-scoped upload and integrity-checked download. Trusted agent hosts can run node scripts/artifact-transfer.mjs --help for single-file HTTP upload/download with explicit file, revision and role, environment credentials, SHA-256 verification and no download overwrite. Host filesystem/execution access is a separate prerequisite, not an MCP capability. Generic MCP raw begin/finalize/download tools fail closed; live URLs, bearer headers, tokens, _meta credentials, base64, inline bytes, host paths, and diagnostics are never serialized. Atomic batch transfer remains deferred.",
  reconciliationSemantics: {
    consumed: "Settle the reservation and remove the outcome quantity from source stock.",
    returned: "Settle the reservation without reducing on-hand stock; the quantity becomes available again.",
    usable_leftover: "Settle the reservation without reducing on-hand stock; the usable remainder becomes available again.",
    damaged_lost: "Settle the reservation and remove the outcome quantity as loss.",
    converted_asset: "Settle the reservation, remove the source quantity, and create the explicitly described reusable inventory item. BOM line, reservation, and source item retain lineage.",
    reviewed_no_change: "Make no stock change; optional only as the sole outcome for a submitted BOM line with zero active reservations. Zero-reservation lines may instead be omitted from the close-out draft.",
    authority: "The server-calculated preview is authoritative before commit.",
  },
  recommendedSequence: [
    "read_inventory_summary",
    "list_inventory",
    "bulk_update_inventory_items (only for an explicit, confirmed metadata batch)",
    "read_project or create_project_with_initial_revision",
    "create_project_revision (only for an existing project or later revision)",
    "update_project_revision (narrow route/printer planning update with expectedVersion)",
    "search_catalog_products",
    "read_catalog_product",
    "read_inventory_product_profile (only with unscoped catalog access)",
    "create_inventory_with_product_profile (only when intentionally adding exact physical stock)",
    "list_bom_lines or create_bom_line",
    "calculate_bom_gaps",
    "list_inspections",
    "read_inspection",
    "preview_inspection_completion",
    "commit_inspection_completion",
    "create_reservation",
    "list_reservations",
    "read_reservation",
    "list_offers",
    "record_offer_snapshot (only for an authorized observation)",
    "create_build_configuration",
    "read_reconciliation",
    "save_reconciliation_draft",
    "commit_reconciliation",
  ],
};

const IDEMPOTENCY_KEY_PROPERTY: JsonObject = { type: "string", minLength: 8, maxLength: 200, description: "Optional retry key; reuse only for an identical retry." };

/**
 * MCP 2025-06-18 annotations. Hints only: authorization is still enforced by
 * scopes, project ancestry and the application service. Hosts should require
 * human confirmation before any destructiveHint tool.
 */
export function toolAnnotations(definition: McpToolDefinition): McpToolAnnotations {
  // Previews persist actor-owned preview metadata, so they are not read-only
  // even though they never change stock, BOM or project records.
  const readOnly = !definition.mutating && !definition.name.startsWith("preview_");
  const destructive = definition.mutating && (/^(?:remove|retire|archive|delete)_/u.test(definition.name) || definition.approvalRequired === true);
  const idempotent = readOnly || DERIVED_IDEMPOTENCY_TOOL_NAMES.has(definition.name) || BACKEND_DERIVED_IDEMPOTENCY_TOOL_NAMES.has(definition.name);
  return { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false };
}

/** Every mutating tool accepts the transport-level idempotencyKey argument. */
function publicInputSchema(definition: McpToolDefinition): JsonObject {
  if (!definition.mutating) return definition.inputSchema;
  const properties = (definition.inputSchema.properties ?? {}) as Record<string, JsonValue>;
  return { ...definition.inputSchema, type: "object", properties: { ...properties, idempotencyKey: IDEMPOTENCY_KEY_PROPERTY } };
}

export function publicToolDefinitions(): readonly JsonObject[] {
  return TOOL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: publicInputSchema(definition),
    annotations: toolAnnotations(definition) as unknown as JsonValue,
  }));
}
