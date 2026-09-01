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
  | "dimensions";

export type BomSpecificationDecisions = Readonly<Partial<Record<BomSpecificationDecision, string>>>;

export interface BomSpecification {
  status: "sufficient" | "insufficient";
  decisions?: BomSpecificationDecisions;
  missingDecisions?: readonly BomSpecificationDecision[];
}

export type BomCompatibility = "confirmed" | "conditional" | "unknown";
export type BomDecision = "ready" | "check" | "decide" | "source";

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
  alternatives?: readonly { itemId: string; compatible?: BomCompatibility; reason?: string }[];
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
}

export interface Project {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  /** Canonical project lifecycle; manufacturing revision status is separate. */
  status: "idea" | "planned" | "ready" | "building" | "validating" | "complete" | "archived";
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
  /** Canonical application-service readiness returned by the workspace API. */
  gapEvaluation?: ProjectGapEvaluation;
  /** Connected readiness was invalidated and could not be reloaded. Source
   * recommendations remain disabled until a canonical evaluation returns. */
  readinessUnavailable?: boolean;
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
  state: "ready" | "inspect-first" | "specify-first" | "partial" | "missing" | "optional";
  decision: BomDecision;
  missingDecisions?: readonly BomSpecificationDecision[];
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

const POWER_SUPPLY_NAME = /\b(?:power\s+supply|power\s+adapter|dc\s+adapter|ac\s+adapter|wall\s+adapter|mains\s+adapter)\b/i;
const POWER_SUPPLY_DECISIONS: readonly BomSpecificationDecision[] = ["current_or_load", "connector"];

function specificationForLine(line: BomLine): { sufficient: boolean; missingDecisions: readonly BomSpecificationDecision[] } {
  const specification = line.constraints?.specification;
  if (specification !== undefined) {
    const decisions = specification.decisions ?? {};
    const mandatoryMissing = POWER_SUPPLY_NAME.test(line.label)
      ? POWER_SUPPLY_DECISIONS.filter((decision) => {
        const value = decisions[decision];
        return typeof value !== "string" || value.trim().length === 0;
      })
      : [];
    const missingDecisions = [...new Set([...(specification.missingDecisions ?? []), ...mandatoryMissing])];
    return { sufficient: specification.status === "sufficient" && missingDecisions.length === 0, missingDecisions };
  }
  if (POWER_SUPPLY_NAME.test(line.label)) return { sufficient: false, missingDecisions: POWER_SUPPLY_DECISIONS };
  return { sufficient: true, missingDecisions: [] };
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
    const item = gap.matchedItemIds.map((id) => items.find((candidate) => candidate.id === id)).find((candidate): candidate is InventoryItem => candidate !== undefined);
    return [{
      line,
      ...(item === undefined ? {} : { item }),
      supplied: gap.suppliedQuantity,
      remaining: Math.max(gap.missingQuantity + gap.inspectQuantity, 0),
      state: stateFor(gap),
      decision: gap.decision,
      ...(gap.missingDecisions === undefined ? {} : { missingDecisions: gap.missingDecisions.slice() }),
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
    const needsInspection = (item: InventoryItem): boolean => item.state === "inspect-first"
      || item.state === "ordered-unverified"
      || (line.alternatives ?? []).some((alternative) => alternative.itemId === item.id && alternative.compatible !== undefined && alternative.compatible !== "confirmed");
    const confirmedCandidates = candidates.filter((item) => !needsInspection(item));
    const inspectCandidates = candidates.filter(needsInspection);
    const confirmedAvailable = confirmedCandidates.reduce((total, item) => total + (item.state === "depleted" ? 0 : Math.max(item.availableQuantity ?? item.quantity - item.reserved, 0)), 0);
    const supplied = specification.sufficient ? Math.min(line.required, confirmedAvailable) : 0;
    const inspectAvailable = inspectCandidates.reduce((total, item) => total + Math.max(item.availableQuantity ?? item.quantity - item.reserved, item.quantity - item.reserved, 0), 0);
    const inspectQuantity = Math.min(Math.max(line.required - supplied, 0), inspectAvailable);
    const missingQuantity = Math.max(line.required - supplied - inspectQuantity, 0);
    const item = confirmedCandidates[0] ?? inspectCandidates[0];
    const baseState: BomLineStatus["state"] = missingQuantity === 0 && inspectQuantity === 0
      ? "ready"
      : supplied > 0 && missingQuantity > 0
        ? "partial"
        : inspectQuantity > 0
          ? "inspect-first"
          : "missing";
    const state: BomLineStatus["state"] = line.optional === true && supplied === 0 && inspectQuantity === 0
      ? "optional"
      : !specification.sufficient && inspectQuantity === 0
        ? "specify-first"
        : baseState;
    return {
      line,
      ...(item === undefined ? {} : { item }),
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
