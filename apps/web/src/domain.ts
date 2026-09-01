export type StockState =
  | "available"
  | "inspect-first"
  | "ordered-unverified"
  | "reserved"
  | "depleted";

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

export interface BuildConfigInput {
  printerItemId?: string;
  printerProfileId?: string;
  filamentItemId?: string;
  filamentProfileId?: string;
  printerProductId?: string;
  filamentProductId?: string;
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
  filamentSelections?: readonly Record<string, unknown>[];
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
  unit: "each" | "g" | "m";
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
  label: string;
  itemId?: string;
  required: number;
  unit: "each" | "g" | "m";
  optional?: boolean;
  note?: string;
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
}

export interface Project {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  status: "In progress" | "Idea" | "Complete";
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
  const filamentName = filament?.catalogProduct ? catalogProductLabel(filament.catalogProduct) : filament?.name ?? snapshotIdentity(filamentSnapshot, false) ?? "No filament selected";
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
    input.unknowns.length ? `${input.unknowns.length} setup detail${input.unknowns.length === 1 ? " remains" : "s remain"} to confirm.` : undefined
  ].filter((part): part is string => Boolean(part)).join(" ");
}

export interface BomLineStatus {
  line: BomLine;
  item?: InventoryItem;
  supplied: number;
  remaining: number;
  state: "ready" | "inspect-first" | "partial" | "missing" | "optional";
}

export interface ProjectSummary {
  totalLines: number;
  readyLines: number;
  inspectLines: number;
  missingLines: number;
  optionalLines: number;
  lineStatuses: BomLineStatus[];
}

export function calculateProjectSummary(project: Project, items: InventoryItem[]): ProjectSummary {
  const lineStatuses = project.bom.map((line): BomLineStatus => {
    const item = line.itemId ? items.find((candidate) => candidate.id === line.itemId) : undefined;
    const available = item ? Math.max(item.quantity - item.reserved, 0) : 0;
    const supplied = Math.min(line.required, available);
    const remaining = Math.max(line.required - supplied, 0);

    if (line.optional && !item) {
      return { line, supplied, remaining, state: "optional" };
    }
    if (!item || item.state === "depleted" || item.state === "ordered-unverified") {
      return item
        ? { line, item, supplied, remaining, state: supplied > 0 ? "partial" : "missing" }
        : { line, supplied, remaining, state: supplied > 0 ? "partial" : "missing" };
    }
    if (item.state === "inspect-first") {
      return { line, item, supplied, remaining, state: "inspect-first" };
    }
    if (remaining > 0) return { line, item, supplied, remaining, state: "partial" };
    return { line, item, supplied, remaining, state: "ready" };
  });

  return {
    totalLines: lineStatuses.length,
    readyLines: lineStatuses.filter((line) => line.state === "ready").length,
    inspectLines: lineStatuses.filter((line) => line.state === "inspect-first").length,
    missingLines: lineStatuses.filter((line) => ["missing", "partial"].includes(line.state)).length,
    optionalLines: lineStatuses.filter((line) => line.state === "optional").length,
    lineStatuses
  };
}

export function getLineLabel(state: BomLineStatus["state"]): { label: string; tone: StockLabelTone } {
  switch (state) {
    case "ready":
      return { label: "Ready to use", tone: "good" };
    case "inspect-first":
      return { label: "Check quantity", tone: "warn" };
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
