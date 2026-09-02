// Import the browser-safe specification subpath so the web bundle does not
// pull the domain package's Node-only ID helpers through its barrel export.
import { resolveBomSpecification } from "@benchledger/domain/specification";
import { resolveBomAlternativeQuantity } from "@benchledger/domain/quantity-conversion";
import type { InspectionAction } from "./inspection-ui";

export type StockState =
  | "available"
  | "inspect-first"
  | "ordered-unverified"
  | "reserved"
  | "depleted";

export type BomSpecificationDecision =
  | "identity"
  | "purpose"
  | "voltage"
  | "current_or_load"
  | "connector"
  | "compatibility"
  | "dimensions"
  | "resistance"
  | "power_rating";

export type BomSpecificationDecisions = Readonly<Partial<Record<BomSpecificationDecision, string>>>;

export interface BomSpecification {
  status: "sufficient" | "insufficient";
  decisions?: BomSpecificationDecisions;
  missingDecisions?: readonly BomSpecificationDecision[];
}

export type BomCompatibility = "confirmed" | "conditional" | "unknown";
export type BomDecision = "ready" | "check" | "decide" | "source";

/** Browser display units retain the server's set identity. The short aliases
 * are kept for the existing beginner-facing grams/metres copy. */
export type QuantityDisplayUnit = "each" | "g" | "m" | "set" | "millimetre" | "millilitre";

export type QuantityConversionEvidenceBasis = "package_label" | "manufacturer_spec" | "physical_count" | "user_assertion";

export interface QuantityConversion {
  readonly inventory: { readonly quantity: 1; readonly unit: "set" };
  readonly requirement: { readonly quantity: number; readonly unit: "each" };
  readonly evidence: {
    readonly basis: QuantityConversionEvidenceBasis;
    readonly observedAt: string;
    readonly source?: string;
    readonly sourceId?: string;
    readonly note?: string;
  };
}

export interface BomAlternative {
  readonly itemId: string;
  readonly compatible?: BomCompatibility;
  readonly reason?: string;
  readonly quantityConversion?: QuantityConversion;
}

export interface BomGapCandidate {
  readonly itemId: string;
  readonly relationship: "exact" | "confirmed_alternative" | "uncertain_alternative" | "constraint_match";
  readonly compatibility: BomCompatibility;
  readonly availableQuantity: number;
  readonly suppliedQuantity: number;
  readonly inspectQuantity: number;
  readonly reason: string;
}

export type InventoryCategory =
  | "Printers"
  | "Filament"
  | "Tools"
  | "Accessories"
  | "Electronics"
  | "Fasteners"
  | "Wire & cable";

/** Catalog-backed identities are deliberately narrower than generic inventory.
 * A name match is not an exact product link; the link state travels with the
 * physical profile so old inventory can remain intact while it is confirmed. */
export type CatalogKind = "filament" | "printer";
export type LinkState = "reported" | "suggested" | "confirmed";

/** Read-only source context for curated catalog identity facts. */
export interface CatalogProductProvenance {
  sourceUrl: string;
  sourceLabel: string;
  verifiedAt: string;
}

export interface CatalogProduct {
  id: string;
  kind: CatalogKind;
  manufacturer: string;
  /** Canonical catalog names are retained alongside friendly display aliases. */
  productName?: string;
  materialFamily?: string;
  materialSubtype?: string;
  colourName?: string;
  nominalNetMassG?: number;
  nominalLengthM?: number;
  lengthBasis?: "manufacturer_declared" | "calculated" | "unknown";
  densityGcm3?: number;
  exactModel?: string;
  exactVariant?: string;
  technology?: "fff";
  buildVolumeMm?: { x: number; y: number; z: number };
  family?: string;
  model?: string;
  variant?: string;
  colour?: string;
  color?: string;
  colourCode?: string;
  colorCode?: string;
  diameterMm?: number;
  netMassG?: number;
  productCode?: string;
  /** Canonical catalog spelling retained for expert/API views. */
  sku?: string;
  provenance?: CatalogProductProvenance;
  version?: number;
  evidence?: string;
  contentHash?: string;
}

export interface FilamentPhysicalProfile {
  lotBatch?: string;
  lot?: string;
  batch?: string;
  lotCode?: string;
  /** A spool starts as reported/sealed until its physical state is checked. */
  state?: "sealed" | "opened";
  openedState?: "sealed" | "open" | "unknown";
  openedAt?: string;
  tareMassG?: number;
  placement?: string;
  currentPlacement?: string;
}

export interface PrinterPhysicalProfile {
  assetLabel?: string;
  commissionedAt?: string;
  placement?: string;
  location?: string;
  condition?: "new" | "good" | "worn" | "needs_repair" | "unknown";
}

export interface InventoryProductProfile {
  id?: string;
  inventoryItemId?: string;
  catalogProductId?: string;
  linkState: LinkState;
  filament?: FilamentPhysicalProfile;
  printer?: PrinterPhysicalProfile;
  evidence?: string;
  version?: number;
  contentHash?: string;
}

export type SnapshotDescriptor = string | {
  name?: string;
  version?: string;
  model?: string;
  material?: string;
  side?: string;
  type?: string;
  surface?: string;
  diameterMm?: number;
  nozzleMaterial?: string;
  state?: string;
  recordedAt?: string;
  quantity?: number;
};

/**
 * A build may retain a physical filament spool even when its catalog identity
 * is not known.  The unknown state is explicit so a client cannot silently
 * discard the selected spool or replace it with a similarly named product.
 */
export interface BuildFilamentSelection {
  [key: string]: unknown;
  itemId: string;
  catalogProductId?: string;
  profileId?: string;
  catalogIdentityState?: "unknown";
  role?: string;
  quantity?: number;
  /** Server-copied display context for a legacy/unlinked physical spool. */
  physicalLabel?: string;
}

export interface BuildConfigInput {
  printerItemId?: string;
  printerProfileId?: string;
  filamentItemId?: string;
  filamentProfileId?: string;
  printerProductId?: string;
  filamentProductId?: string;
  filamentSelections?: readonly BuildFilamentSelection[];
  hotendSide?: string;
  nozzleDiameterMm?: number;
  nozzleMaterial?: string;
  buildPlate?: string;
  accessories: string[];
  firmware?: string;
  slicer?: string;
  slicerVersion?: string;
  profile?: string;
  calibration?: string;
  unknowns: string[];
}

export interface BuildConfigSnapshot extends BuildConfigInput {
  id: string;
  projectId: string;
  revisionId: string;
  createdAt: string;
  version: number;
  contentHash?: string;
  evidence?: string;
  projectRevisionId?: string;
  printerItemSnapshot?: Record<string, unknown>;
  filamentSelections?: readonly BuildFilamentSelection[];
  activeHotend?: SnapshotDescriptor;
  nozzle?: SnapshotDescriptor;
  plate?: SnapshotDescriptor;
  accessoryDescriptors?: readonly SnapshotDescriptor[];
  firmwareDescriptor?: SnapshotDescriptor;
  slicerDescriptor?: SnapshotDescriptor;
  profileDescriptor?: SnapshotDescriptor;
  calibrationDescriptor?: SnapshotDescriptor;
  explicitUnknowns?: readonly string[];
  contentSha256?: string;
}

export type EvidenceState = "counted" | "commissioned" | "delivered" | "ordered";
/** Canonical API evidence values retained for exact server-side filtering. */
export type InventoryEvidenceState =
  | "physically_counted"
  | "commissioned"
  | "delivered_uncounted"
  | "ordered_unverified"
  | "allocated"
  | "consumed"
  | "unknown";

/** Condition values accepted by the descriptive inventory bulk-edit command. */
export type InventoryCondition = "new" | "good" | "worn" | "needs_repair" | "unknown";

export interface Dimensions {
  length?: number;
  width?: number;
  height?: number;
  diameter?: number;
  unit: "mm" | "cm";
}

export interface InventoryItem {
  id: string;
  name: string;
  /** API item kind retained for exact filtering and lossless edits. */
  kind?: string;
  /** Optional user-managed taxonomy assignment; legacy semantic category remains separate. */
  categoryNodeId?: string;
  category: InventoryCategory;
  variant: string;
  model?: string;
  description: string;
  quantity: number;
  /** Server-calculated quantity that is available for reuse. */
  availableQuantity?: number;
  /** Lossless API evidence state used by the paginated inventory query. */
  serverEvidence?: InventoryEvidenceState;
  unit: QuantityDisplayUnit;
  reserved: number;
  state: StockState;
  evidence: EvidenceState;
  location: string;
  dimensions?: Dimensions;
  manufacturer?: string;
  sku?: string;
  condition?: InventoryCondition;
  tags: string[];
  compatibility: string[];
  provenance?: {
    source?: string;
    sourceId?: string;
    observedAt?: string;
    note?: string;
  };
  /** Server version used for optimistic updates. */
  version?: number;
  /** Original API unit retained so writes remain lossless after UI normalization. */
  serverUnit?: string;
  lastCounted?: string;
  accent: "orange" | "teal" | "blue" | "yellow" | "slate";
  /** Exact catalog identity and physical profile, when this legacy item has
   * been through the guided confirmation flow. */
  catalogProduct?: CatalogProduct;
  productProfile?: InventoryProductProfile;
}

export interface BomLine {
  id: string;
  /** Server version used for optimistic BOM updates and expert read-back. */
  version: number;
  label: string;
  itemId?: string;
  required: number;
  unit: QuantityDisplayUnit;
  optional?: boolean;
  note?: string;
  constraints?: {
    kind?: string;
    manufacturer?: string;
    model?: string;
    sku?: string;
    tag?: string;
    nameIncludes?: string;
    specification?: BomSpecification;
  };
  /** Alternatives retain compatibility evidence; an uncertain alternative is
   * still a Check item even when its ID exactly matches itemId. */
  alternatives?: readonly BomAlternative[];
  /** Canonical API unit retained for expert/read-back use when the beginner
   * display uses a short alias (for example gram -> g). */
  serverUnit?: string;
}

export interface ProjectGapLine {
  lineId: string;
  status: "supplied" | "inspect_first" | "specify_first" | "partially_supplied" | "missing" | "optional";
  decision: BomDecision;
  missingDecisions?: readonly BomSpecificationDecision[];
  suppliedQuantity: number;
  inspectQuantity: number;
  missingQuantity: number;
  matchedItemIds: readonly string[];
  reasons: readonly string[];
  requiredQuantity?: number;
  unit?: QuantityDisplayUnit;
  alternatives?: readonly BomAlternative[];
  candidates?: readonly BomGapCandidate[];
}

export interface ProjectGapEvaluation {
  lines: readonly ProjectGapLine[];
  totals: {
    requiredLines: number;
    optionalLines: number;
    readyLines: number;
    checkLines: number;
    decideLines: number;
    sourceLines: number;
    partialLines: number;
    missingLines: number;
  };
}

export interface Artifact {
  id: string;
  name: string;
  role: "Editable CAD" | "STEP" | "STL" | "Build plate" | "Validation" | "Notes";
  revision: string;
  size: string;
  hash: string;
  updated: string;
  status: "candidate" | "validated" | "superseded";
  machine?: string;
  material?: string;
  /** Exact artifact ancestry. Legacy/unbound files intentionally omit all
   * three IDs and are shown only in the read-only All files view. */
  projectRevisionId?: string;
  workItemId?: string;
  workItemRevisionId?: string;
}

export interface ProjectRevisionReference {
  id: string;
  number?: number;
  name?: string;
  status?: string;
}

export interface ProjectWorkItem {
  id: string;
  name: string;
  kind: string;
  description?: string;
  currentRevisionId?: string;
  currentRevision?: ProjectRevisionReference;
}

export interface Project {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  /** Canonical project lifecycle; manufacturing revision status is separate. */
  status: "idea" | "planned" | "ready" | "building" | "validating" | "complete" | "archived";
  /** Server-owned project version used for archive/restore optimistic writes. */
  version?: number;
  /** Present only on a removal result; removed projects are not ordinary rows. */
  removedAt?: string;
  removedBy?: string;
  lastLifecycleStatus?: Project["status"];
  updated: string;
  currentRevision: string;
  workItem: string;
  railStep: number;
  bom: BomLine[];
  artifacts: Artifact[];
  notes: string[];
  accent: "orange" | "teal" | "blue";
  /** API revision identifier retained for revision, BOM, and artifact writes. */
  serverRevisionId?: string;
  /** Bounded revision references used by the artifact scope picker. */
  projectRevisions?: ProjectRevisionReference[];
  /** Every real work item is offered independently; no item is inferred. */
  workItems?: ProjectWorkItem[];
  /** All project artifacts, including historical and legacy/unbound files. */
  allArtifacts?: Artifact[];
  /** Canonical application-service readiness returned by the workspace API. */
  gapEvaluation?: ProjectGapEvaluation;
  /** Connected readiness was invalidated and could not be reloaded. Source
   * recommendations remain disabled until a canonical evaluation returns. */
  readinessUnavailable?: boolean;
  /** Revision-scoped physical checks returned by the inspection queue. */
  inspectionActions?: readonly InspectionAction[];
  buildConfigSnapshot?: BuildConfigSnapshot;
}

/** ISO 4217 code. The API validates three uppercase letters at its boundary. */
export type CurrencyCode = Uppercase<string>;

export interface Offer {
  id: string;
  itemId: string;
  supplier: string;
  title: string;
  priceMinor: number;
  currency: CurrencyCode;
  pack: string;
  eta: string;
  url: string;
  observed: string;
  preferred?: boolean;
}

export type StockLabelTone = "good" | "warn" | "muted" | "bad" | "info";

export function getStockLabel(state: StockState): { label: string; tone: StockLabelTone } {
  switch (state) {
    case "available":
      return { label: "Ready to use", tone: "good" };
    case "inspect-first":
      return { label: "Check quantity", tone: "warn" };
    case "ordered-unverified":
      return { label: "Ordered, not verified", tone: "muted" };
    case "reserved":
      return { label: "Reserved", tone: "warn" };
    case "depleted":
      return { label: "Need to buy", tone: "bad" };
  }
}

export function formatMoney(minorUnits: number, currency: CurrencyCode = "EUR"): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(minorUnits / 100);
}

/**
 * Keep observed prices in their source currency. A shopping list may contain
 * offers in more than one currency, but the UI has no exchange-rate source.
 */
export function sumMoneyByCurrency(amounts: ReadonlyArray<Pick<Offer, "priceMinor" | "currency">>): Partial<Record<Offer["currency"], number>> {
  return amounts.reduce<Partial<Record<Offer["currency"], number>>>((totals, amount) => ({
    ...totals,
    [amount.currency]: (totals[amount.currency] ?? 0) + amount.priceMinor
  }), {});
}

export function formatQuantity(quantity: number, unit: InventoryItem["unit"] | BomLine["unit"]): string {
  if (unit === "g") return `${quantity.toLocaleString()} g`;
  if (unit === "m") return `${quantity.toLocaleString()} m`;
  if (unit === "millimetre") return `${quantity.toLocaleString()} mm`;
  if (unit === "millilitre") return `${quantity.toLocaleString()} ml`;
  if (unit === "set") return `${quantity.toLocaleString()} ${quantity === 1 ? "set" : "sets"}`;
  return `${quantity.toLocaleString()} ${quantity === 1 ? "piece" : "pieces"}`;
}

export interface InventoryFilters {
  category?: InventoryCategory | "All";
  /** Managed category node id; null explicitly selects unassigned legacy items. */
  categoryNodeId?: string | null;
  kind?: string | "All";
  evidence?: EvidenceState | "All";
  available?: boolean;
}

export const inventoryKindOptions = [
  { value: "printer", label: "Printer" },
  { value: "tool", label: "Tool" },
  { value: "accessory", label: "Accessory" },
  { value: "consumable", label: "Consumable" },
  { value: "electronic", label: "Electronic part" },
  { value: "fastener", label: "Fastener" },
  { value: "filament", label: "Filament" },
  { value: "wire", label: "Wire or cable" },
  { value: "adhesive", label: "Adhesive" },
  { value: "other", label: "Other" }
] as const;

function inventoryKind(item: Pick<InventoryItem, "kind" | "category">): string {
  if (item.kind) return item.kind;
  switch (item.category) {
    case "Printers": return "printer";
    case "Filament": return "filament";
    case "Tools": return "tool";
    case "Electronics": return "electronic";
    case "Fasteners": return "fastener";
    case "Wire & cable": return "wire";
    default: return "accessory";
  }
}

export function filterInventory(items: InventoryItem[], query: string, filters?: InventoryFilters | InventoryCategory | "All"): InventoryItem[] {
  const normalized = query.trim().toLowerCase();
  const resolved = typeof filters === "string" ? { category: filters } : filters ?? {};
  return items.filter((item) => {
    const categoryMatch = !resolved.category || resolved.category === "All" || item.category === resolved.category;
    if (!categoryMatch) return false;
    const managedCategoryMatch = resolved.categoryNodeId === undefined
      || (resolved.categoryNodeId === null ? item.categoryNodeId === undefined : item.categoryNodeId === resolved.categoryNodeId);
    if (!managedCategoryMatch) return false;
    const kindMatch = !resolved.kind || resolved.kind === "All" || inventoryKind(item) === resolved.kind;
    if (!kindMatch) return false;
    const evidenceMatch = !resolved.evidence || resolved.evidence === "All" || item.evidence === resolved.evidence;
    if (!evidenceMatch) return false;
    const availableQuantity = item.availableQuantity ?? (["available", "reserved"].includes(item.state) ? Math.max(item.quantity - item.reserved, 0) : 0);
    if (resolved.available !== undefined && (availableQuantity > 0) !== resolved.available) return false;
    if (!normalized) return true;
    return [item.name, item.category, item.variant, item.description, item.location, ...item.tags]
      .join(" ")
      .toLowerCase()
      .includes(normalized);
  });
}

export function isExactProductConfirmed(item: Pick<InventoryItem, "category" | "catalogProduct" | "productProfile">): boolean {
  return (item.category === "Filament" || item.category === "Printers")
    && item.catalogProduct !== undefined
    && item.productProfile?.linkState === "confirmed";
}

export function exactProductLabel(item: Pick<InventoryItem, "category" | "catalogProduct" | "productProfile">): string {
  return isExactProductConfirmed(item) ? "Exact product confirmed" : "Exact product not confirmed";
}

export function catalogProductLabel(product: Pick<CatalogProduct, "manufacturer" | "family" | "model" | "variant">): string {
  return [product.manufacturer, product.family, product.model, product.variant].filter((part): part is string => Boolean(part?.trim())).join(" · ");
}

function snapshotField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function snapshotIdentity(value: unknown, printer: boolean): string | undefined {
  const manufacturer = snapshotField(value, "manufacturer");
  const primary = snapshotField(value, printer ? "exactModel" : "name")
    ?? snapshotField(value, printer ? "model" : "materialFamily");
  const variant = snapshotField(value, printer ? "exactVariant" : "materialSubtype");
  return [manufacturer, primary, variant].filter((part): part is string => Boolean(part)).join(" · ") || undefined;
}

export function buildSetupSummary(input: BuildConfigInput, printer?: InventoryItem, filament?: InventoryItem): string {
  const snapshot = input as BuildConfigInput & { printerItemSnapshot?: unknown; filamentSelections?: readonly unknown[] };
  const printerName = printer?.catalogProduct ? catalogProductLabel(printer.catalogProduct) : printer?.name ?? snapshotIdentity(snapshot.printerItemSnapshot, true) ?? "No printer selected";
  const filamentSnapshot = snapshot.filamentSelections?.[0];
  const filamentName = filament?.catalogProduct ? catalogProductLabel(filament.catalogProduct) : snapshotPhysicalLabel(filamentSnapshot) ?? filament?.name ?? snapshotIdentity(filamentSnapshot, false) ?? "No filament selected";
  const unknownFilament = isUnknownFilamentSelection(input, filament);
  const process = [
    input.nozzleDiameterMm === undefined ? undefined : `${input.nozzleDiameterMm} mm nozzle`,
    input.nozzleMaterial,
    input.buildPlate
  ].filter((part): part is string => Boolean(part?.trim())).join(" · ");
  const software = [input.slicer, input.slicerVersion, input.profile].filter((part): part is string => Boolean(part?.trim())).join(" ");
  return [
    `Use ${printerName} with ${filamentName}.`,
    process ? `Print setup: ${process}.` : undefined,
    software ? `Software: ${software}.` : undefined,
    input.calibration ? `Calibration: ${input.calibration}.` : undefined,
    input.unknowns.length ? `${input.unknowns.length} setup detail${input.unknowns.length === 1 ? " remains" : "s remain"} to confirm.` : undefined,
    unknownFilament ? "Exact product unknown. Design open: confirm the filament identity before production approval." : undefined
  ].filter((part): part is string => Boolean(part)).join(" ");
}

function snapshotRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function snapshotPhysicalLabel(value: unknown): string | undefined {
  const record = snapshotRecord(value);
  if (!record) return undefined;
  for (const key of ["physicalLabel", "physicalName", "label", "displayName", "name"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/** Whether a setup retains a filament whose catalog identity is intentionally unknown. */
export function isUnknownFilamentSelection(input: BuildConfigInput, filament?: InventoryItem): boolean {
  const selection = input.filamentSelections?.[0] as (BuildFilamentSelection & Record<string, unknown>) | undefined;
  if (selection?.catalogIdentityState === "unknown") return true;
  if (!selection || selection.catalogProductId) return false;
  return Boolean(input.filamentItemId || filament) && !filament?.catalogProduct;
}

export interface BomLineStatus {
  line: BomLine;
  item?: InventoryItem;
  /** All candidates returned by the canonical gap read, retained for expert
   * unit/compatibility diagnostics even when the compact row shows one. */
  items?: readonly InventoryItem[];
  supplied: number;
  remaining: number;
  state: "ready" | "inspect-first" | "specify-first" | "partial" | "missing" | "optional";
  decision: BomDecision;
  missingDecisions?: readonly BomSpecificationDecision[];
  /** The server's full canonical gap row, when connected. */
  gap?: ProjectGapLine;
}

export interface ProjectSummary {
  totalLines: number;
  readyLines: number;
  inspectLines: number;
  missingLines: number;
  optionalLines: number;
  readyDecisionLines: number;
  checkLines: number;
  decideLines: number;
  sourceLines: number;
  partialLines: number;
  readinessUnavailable: boolean;
  lineStatuses: BomLineStatus[];
}

function resolverUnit(unit: QuantityDisplayUnit): "piece" | "gram" | "meter" | "millimetre" | "millilitre" | "set" {
  if (unit === "each") return "piece";
  if (unit === "g") return "gram";
  if (unit === "m") return "meter";
  return unit;
}

/**
 * Resolve only the shared, evidence-backed one-set conversion in sample mode.
 * Unknown or malformed conversions intentionally return undefined so offline
 * data cannot make a cross-unit candidate look ready by inference.
 */
function offlineAlternativeQuantity(line: BomLine, item: InventoryItem, alternative: BomAlternative | undefined, inventoryQuantity = item.quantity): number | undefined {
  const conversion = alternative?.quantityConversion;
  if (conversion === undefined) return line.unit === item.unit ? inventoryQuantity : undefined;
  const converted = {
    inventory: conversion.inventory,
    requirement: { quantity: conversion.requirement.quantity, unit: "piece" as const },
    evidence: conversion.evidence,
  };
  return resolveBomAlternativeQuantity({
    inventoryQuantity,
    inventoryUnit: resolverUnit(item.unit),
    requirementUnit: resolverUnit(line.unit),
    conversion: converted,
  // The browser contract spells the requirement unit `each`; the shared
  // domain resolver uses its canonical `piece` synonym. The shape above is
  // deliberately checked before this narrow adapter cast.
  } as Parameters<typeof resolveBomAlternativeQuantity>[0]);
}

function alternativeForItem(line: BomLine, itemId: string): BomAlternative | undefined {
  return line.alternatives?.find((alternative) => alternative.itemId === itemId);
}

export function unitDiagnostics(status: Pick<BomLineStatus, "line" | "item" | "items" | "gap">): readonly string[] {
  const lineUnit = status.gap?.unit ?? status.line.unit;
  const candidates = status.gap?.candidates ?? [];
  const diagnostics = candidates.flatMap((candidate) => {
    const item = (status.items ?? (status.item ? [status.item] : [])).find((candidateItem) => candidateItem.id === candidate.itemId);
    const alternative = alternativeForItem(status.line, candidate.itemId) ?? status.gap?.alternatives?.find((entry) => entry.itemId === candidate.itemId);
    if (!item || item.unit === lineUnit) return [];
    if (alternative?.quantityConversion === undefined) return [`Unit mismatch: inventory is ${item.unit}, requirement is ${lineUnit}; no evidence-backed conversion is recorded.`];
    const conversion = alternative.quantityConversion;
    return [`Conversion: 1 ${conversion.inventory.unit} = ${conversion.requirement.quantity} ${conversion.requirement.unit} (observed ${conversion.evidence.observedAt.slice(0, 10)}).`];
  });
  return [...new Set(diagnostics)];
}

/** The shopping surface is a proposal for required Source lines only. */
export function shoppingEligibleLines(summary: ProjectSummary): BomLineStatus[] {
  if (summary.readinessUnavailable) return [];
  return summary.lineStatuses.filter((line) => line.line.optional !== true && line.decision === "source");
}

/**
 * Return offer identities that are safe for a required Source row. Connected
 * rows use the server's candidate relationships; fallback rows only expose
 * explicitly confirmed alternatives. Check/Decide rows return no identities.
 */
export function shoppingOfferItemIds(status: Pick<BomLineStatus, "line" | "decision" | "gap">): readonly string[] {
  if (status.line.optional === true || status.decision !== "source") return [];
  const candidateIds = status.gap?.candidates === undefined
    ? (status.line.alternatives ?? []).filter((alternative) => alternative.compatible === "confirmed").map((alternative) => alternative.itemId)
    : status.gap.candidates
      .filter((candidate) => (candidate.relationship === "exact" || candidate.relationship === "confirmed_alternative") && candidate.compatibility === "confirmed")
      .map((candidate) => candidate.itemId);
  return [...new Set([status.line.id, status.line.itemId, ...candidateIds].filter((itemId): itemId is string => typeof itemId === "string" && itemId.length > 0))];
}

export function shoppingEmptyState(summary: ProjectSummary): { title: string; description: string } {
  if (summary.readinessUnavailable) {
    return {
      title: "Readiness needs to reload",
      description: "Inventory changed, but canonical project readiness is unavailable. Reload before preparing a shopping proposal.",
    };
  }
  if (summary.decideLines > 0 || summary.checkLines > 0 || summary.optionalLines > 0) {
    const blockers = [
      summary.decideLines > 0 ? `${summary.decideLines} requirement${summary.decideLines === 1 ? " still needs" : "s still need"} a decision` : undefined,
      summary.checkLines > 0 ? `${summary.checkLines} requirement${summary.checkLines === 1 ? " still needs" : "s still need"} checking` : undefined,
    ].filter((value): value is string => value !== undefined);
    return {
      title: "Nothing is ready to source",
      description: blockers.length > 0
        ? `${blockers.join(" and ")}. Optional requirements are not included in shopping proposals.`
        : "Optional requirements are not included in shopping proposals.",
    };
  }
  return { title: "No items required", description: "Current inventory covers every required line." };
}

function specificationForLine(line: BomLine): { sufficient: boolean; missingDecisions: readonly BomSpecificationDecision[] } {
  return resolveBomSpecification({
    name: line.label,
    ...(line.itemId === undefined ? {} : { itemId: line.itemId }),
    ...(line.constraints === undefined ? {} : { constraints: line.constraints }),
  } as Parameters<typeof resolveBomSpecification>[0]);
}

function decisionForLine(line: BomLine, state: BomLineStatus["state"], sufficient: boolean, needsCheck: boolean): BomDecision {
  if (state === "ready") return "ready";
  if (state === "inspect-first") return "check";
  if (state === "partial") return needsCheck ? "check" : "source";
  if (state === "specify-first") return "decide";
  return sufficient ? "source" : "decide";
}

function summaryFromCanonicalGaps(project: Project, items: InventoryItem[], gaps: ProjectGapEvaluation): ProjectSummary {
  const gapByLineId = new Map(gaps.lines.map((gap) => [gap.lineId, gap] as const));
  const stateFor = (gap: ProjectGapLine): BomLineStatus["state"] => {
    if (gap.status === "supplied") return "ready";
    if (gap.status === "inspect_first") return "inspect-first";
    if (gap.status === "specify_first") return "specify-first";
    if (gap.status === "partially_supplied") return "partial";
    return gap.status;
  };
  const lineStatuses = project.bom.flatMap((line): BomLineStatus[] => {
    const gap = gapByLineId.get(line.id);
    if (gap === undefined) return [];
    const matchedItems = gap.matchedItemIds.map((id) => items.find((candidate) => candidate.id === id)).filter((candidate): candidate is InventoryItem => candidate !== undefined);
    const item = matchedItems[0];
    return [{
      line,
      ...(item === undefined ? {} : { item }),
      ...(matchedItems.length === 0 ? {} : { items: matchedItems }),
      supplied: gap.suppliedQuantity,
      remaining: Math.max(gap.missingQuantity + gap.inspectQuantity, 0),
      state: stateFor(gap),
      decision: gap.decision,
      ...(gap.missingDecisions === undefined ? {} : { missingDecisions: gap.missingDecisions.slice() }),
      gap,
    }];
  });
  return {
    totalLines: gaps.totals.requiredLines + gaps.totals.optionalLines,
    readyLines: gaps.totals.readyLines,
    inspectLines: lineStatuses.filter((line) => line.state === "inspect-first" && line.line.optional !== true).length,
    missingLines: gaps.totals.missingLines + gaps.totals.partialLines,
    optionalLines: gaps.totals.optionalLines,
    readyDecisionLines: gaps.totals.readyLines,
    checkLines: gaps.totals.checkLines,
    decideLines: gaps.totals.decideLines,
    sourceLines: gaps.totals.sourceLines,
    partialLines: gaps.totals.partialLines,
    readinessUnavailable: false,
    lineStatuses,
  };
}

export function calculateProjectSummary(project: Project, items: InventoryItem[]): ProjectSummary {
  if (project.gapEvaluation !== undefined) return summaryFromCanonicalGaps(project, items, project.gapEvaluation);
  const lineStatuses = project.bom.map((line): BomLineStatus => {
    const candidateIds = [...new Set([line.itemId, ...(line.alternatives ?? []).map((alternative) => alternative.itemId)].filter((id): id is string => Boolean(id)))];
    const candidates = candidateIds.flatMap((id) => {
      const candidate = items.find((item) => item.id === id);
      return candidate === undefined ? [] : [candidate];
    });
    const specification = specificationForLine(line);
    const candidateAvailable = (item: InventoryItem): number => {
      const available = item.state === "depleted" ? 0 : Math.max(item.availableQuantity ?? item.quantity - item.reserved, 0);
      return offlineAlternativeQuantity(line, item, alternativeForItem(line, item.id), available) ?? 0;
    };
    const quantityResolvable = (item: InventoryItem): boolean => offlineAlternativeQuantity(line, item, alternativeForItem(line, item.id)) !== undefined;
    const needsInspection = (item: InventoryItem): boolean => item.state === "inspect-first"
      || item.state === "ordered-unverified"
      || !quantityResolvable(item)
      || (line.alternatives ?? []).some((alternative) => alternative.itemId === item.id && alternative.compatible !== undefined && alternative.compatible !== "confirmed");
    const confirmedCandidates = candidates.filter((item) => !needsInspection(item));
    const inspectCandidates = candidates.filter(needsInspection);
    const confirmedAvailable = confirmedCandidates.reduce((total, item) => total + candidateAvailable(item), 0);
    const supplied = specification.sufficient ? Math.min(line.required, confirmedAvailable) : 0;
    const inspectAvailable = inspectCandidates.reduce((total, item) => total + candidateAvailable(item), 0);
    const inspectQuantity = Math.min(Math.max(line.required - supplied, 0), inspectAvailable);
    const missingQuantity = Math.max(line.required - supplied - inspectQuantity, 0);
    const item = confirmedCandidates[0] ?? inspectCandidates[0];
    const unresolvedUnitMismatch = candidates.some((candidate) => candidate.unit !== line.unit && !quantityResolvable(candidate));
    const baseState: BomLineStatus["state"] = missingQuantity === 0 && inspectQuantity === 0
      ? "ready"
      : supplied > 0 && missingQuantity > 0
        ? "partial"
        : inspectQuantity > 0
          ? "inspect-first"
          : "missing";
    const state: BomLineStatus["state"] = line.optional === true && supplied === 0 && inspectQuantity === 0
      ? "optional"
      : unresolvedUnitMismatch
        ? "inspect-first"
      : !specification.sufficient && inspectQuantity === 0
        ? "specify-first"
        : baseState;
    return {
      line,
      ...(item === undefined ? {} : { item }),
      ...(candidates.length === 0 ? {} : { items: candidates }),
      supplied,
      remaining: Math.max(inspectQuantity + missingQuantity, 0),
      state,
      decision: decisionForLine(line, state, specification.sufficient, inspectQuantity > 0),
      ...(specification.missingDecisions.length === 0 ? {} : { missingDecisions: specification.missingDecisions.slice() })
    };
  });

  return {
    totalLines: lineStatuses.length,
    readyLines: lineStatuses.filter((line) => line.line.optional !== true && line.state === "ready").length,
    inspectLines: lineStatuses.filter((line) => line.line.optional !== true && line.state === "inspect-first").length,
    missingLines: lineStatuses.filter((line) => line.line.optional !== true && ["missing", "partial"].includes(line.state)).length,
    optionalLines: lineStatuses.filter((line) => line.line.optional === true).length,
    readyDecisionLines: lineStatuses.filter((line) => line.line.optional !== true && line.decision === "ready").length,
    checkLines: lineStatuses.filter((line) => line.line.optional !== true && line.decision === "check").length,
    decideLines: lineStatuses.filter((line) => line.line.optional !== true && line.decision === "decide").length,
    sourceLines: project.readinessUnavailable === true ? 0 : lineStatuses.filter((line) => line.line.optional !== true && line.decision === "source").length,
    partialLines: lineStatuses.filter((line) => line.line.optional !== true && line.state === "partial").length,
    readinessUnavailable: project.readinessUnavailable === true,
    lineStatuses
  };
}

export function getLineLabel(state: BomLineStatus["state"]): { label: string; tone: StockLabelTone } {
  switch (state) {
    case "ready":
      return { label: "Ready to use", tone: "good" };
    case "inspect-first":
      return { label: "Check quantity", tone: "warn" };
    case "specify-first":
      return { label: "Specify first", tone: "warn" };
    case "partial":
      return { label: "Partly covered", tone: "warn" };
    case "missing":
      return { label: "Need to buy", tone: "bad" };
    case "optional":
      return { label: "Optional", tone: "muted" };
  }
}

export function countByState(items: InventoryItem[]): Record<StockState, number> {
  return items.reduce<Record<StockState, number>>(
    (counts, item) => ({ ...counts, [item.state]: (counts[item.state] ?? 0) + 1 }),
    { available: 0, "inspect-first": 0, "ordered-unverified": 0, reserved: 0, depleted: 0 }
  );
}

export const railSteps = ["Idea", "Setup", "BOM", "Reuse / inspect / buy", "Files", "Validate"] as const;
