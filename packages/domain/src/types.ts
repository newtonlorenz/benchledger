/** Stable, human-readable categories. Unknown categories are allowed so an
 * imported item can be retained without silently reclassifying it. */
export type ItemCategory =
  | "printer"
  | "printer_accessory"
  | "printer_part"
  | "filament"
  | "tool"
  | "workshop"
  | "fastener"
  | "adhesive"
  | "finish"
  | "lighting"
  | "electronics"
  | "electrical"
  | "consumable"
  | "other"
  | (string & {});

export type ReusePolicy = "available" | "inspect_first" | "machine_specific";

export type InventorySourceStatus =
  | "commissioned_available"
  | "physically_confirmed"
  | "delivered_uncounted"
  | "shipped_available_baseline"
  | "ordered_unverified"
  | (string & {});

export type StockConfidence = "confirmed" | "inspect_first" | "ordered" | "unknown";

export type AvailabilityClass = "available" | "inspect-first" | "specify-first" | "partial" | "missing" | "optional";

/** Decisions that must be resolved before a BOM line can move through the
 * reuse/source workflow. These values are deliberately shared with the API
 * and MCP surfaces so an agent and the web UI cannot silently disagree. */
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

export type BomDecision = "ready" | "check" | "decide" | "source";
export type BomCompatibility = "confirmed" | "conditional" | "unknown";

export type QuantityUnit =
  | "piece"
  | "printer"
  | "unit"
  | "bundle"
  | "kit"
  | "pack"
  | "spool"
  | "plate"
  | "dryer"
  | "bench"
  | "box"
  | "tube"
  | "jar"
  | "bottle"
  | "meter"
  | "bit"
  | "station"
  | "adapter"
  | "module"
  | "board"
  | "set"
  | "pair"
  | "roll"
  | "sheet"
  | "pack"
  | "gram"
  | "millimetre"
  | (string & {});

export type MeasurementKind = "nominal" | "measured" | "estimated";

export interface Dimensions {
  width?: number;
  height?: number;
  depth?: number;
  diameter?: number;
  unit: "mm" | "cm" | "m";
  kind: MeasurementKind;
  uncertainty?: number;
  source?: string;
}

export interface InventoryProvenance {
  vendor?: string;
  order?: string;
  orders?: readonly string[];
  ordered?: string;
  emailId?: string;
  emailIds?: readonly string[];
  deliveryEmailId?: string;
  deliveryEmailIds?: readonly string[];
  unitPriceMinor?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface InventoryItem {
  id: string;
  name: string;
  category: ItemCategory;
  /** Optional managed taxonomy assignment; legacy category text remains intact. */
  categoryNodeId?: string;
  variant?: string;
  purchasedQuantity: number;
  unit: QuantityUnit;
  sourceStatus: InventorySourceStatus;
  reusePolicy: ReusePolicy;
  confidence: StockConfidence;
  reportedQuantity?: number;
  manufacturer?: string;
  model?: string;
  dimensions?: Dimensions;
  source?: InventoryProvenance;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  retiredAt?: string;
}

export type StockEventKind =
  | "receipt"
  | "count"
  | "allocate"
  | "release"
  | "consume"
  | "loss"
  | "return"
  | "adjustment"
  | "evidence";

export type StockEventSemantics = "delta" | "absolute_count" | "informational";

export interface StockEvent {
  id: string;
  itemId: string;
  kind: StockEventKind;
  semantics: StockEventSemantics;
  /** Delta for a delta event; absolute on-hand value for a count event. */
  quantity: number;
  unit: QuantityUnit;
  reason: string;
  actor?: AuditActor;
  source?: string;
  evidence?: Record<string, unknown>;
  correlationId?: string;
  idempotencyKey?: string;
  occurredAt: string;
  createdAt: string;
}

export interface StockBalance {
  itemId: string;
  onHand: number;
  allocated: number;
  available: number;
  reported?: number;
  confidence: StockConfidence;
  lastCountAt?: string;
}

export interface AvailabilityInput {
  required: number;
  available: number;
  confidence: StockConfidence;
  reported?: number;
  candidate?: boolean;
}

export interface AvailabilityResult {
  status: AvailabilityClass;
  required: number;
  supplied: number;
  shortfall: number;
  explanation: string;
  needsInspection: boolean;
}

export type RevisionStatus =
  | "concept"
  | "CAD complete"
  | "DFAM reviewed"
  | "mesh validated"
  | "slicer validated"
  | "test printed"
  | "fit/function verified"
  | "production approved";

export type ProjectStatus = "active" | "on_hold" | "complete" | "retired";

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  status: ProjectStatus;
  visibility: "private" | "public_candidate";
  createdAt: string;
  updatedAt: string;
  retiredAt?: string;
}

export type WorkItemKind = "part" | "assembly" | "electronics" | "firmware" | "document" | "other";

export interface WorkItem {
  id: string;
  projectId: string;
  name: string;
  kind: WorkItemKind;
  description?: string;
  createdAt: string;
  updatedAt: string;
  retiredAt?: string;
}

export interface ProjectRevision {
  id: string;
  projectId: string;
  number: number;
  label: string;
  status: RevisionStatus;
  machineId?: string;
  material?: string;
  notes?: string;
  createdAt: string;
  supersedesRevisionId?: string;
}

export interface WorkItemRevision {
  id: string;
  workItemId: string;
  number: number;
  label: string;
  status: RevisionStatus;
  sourcePath?: string;
  createdAt: string;
  supersedesRevisionId?: string;
}

export interface BomConstraints {
  category?: ItemCategory;
  manufacturer?: string;
  model?: string;
  variantIncludes?: string;
  machineId?: string;
  dimensions?: Partial<Dimensions>;
  tags?: readonly string[];
  /** Requirement-level decisions are not inventory matching constraints. */
  specification?: BomSpecification;
}

export interface BomLine {
  id: string;
  revisionId: string;
  name: string;
  quantity: number;
  unit: QuantityUnit;
  required: boolean;
  optional?: boolean;
  itemId?: string;
  alternativeItemIds?: readonly string[];
  alternatives?: readonly BomAlternative[];
  constraints?: BomConstraints;
  notes?: string;
  /** A retired requirement remains inspectable but is excluded from active planning. */
  retiredAt?: string;
}

export interface BomAlternative {
  id: string;
  bomLineId: string;
  itemId?: string;
  label: string;
  compatible?: BomCompatibility;
  constraints?: BomConstraints;
}

export interface BomCandidate {
  item: InventoryItem;
  balance: StockBalance;
  reason: string;
  compatibility?: BomCompatibility;
}

export interface BomLineEvaluation {
  line: BomLine;
  status: AvailabilityClass;
  decision: BomDecision;
  missingDecisions?: readonly BomSpecificationDecision[];
  supplied: number;
  shortfall: number;
  candidates: readonly BomCandidate[];
  selected?: BomCandidate;
  explanation: string;
}

export interface BomSummary {
  totalLines: number;
  availableLines: number;
  inspectFirstLines: number;
  partialLines: number;
  missingLines: number;
  optionalMissingLines: number;
  optionalLines: number;
  readyLines: number;
  checkLines: number;
  decideLines: number;
  sourceLines: number;
  estimatedMissingCostMinor?: number;
}

export interface BomEvaluation {
  revisionId: string;
  lines: readonly BomLineEvaluation[];
  summary: BomSummary;
  shoppingList: readonly ShoppingListLine[];
}

export interface ShoppingListLine {
  bomLineId: string;
  name: string;
  quantity: number;
  unit: QuantityUnit;
  reason: "required" | "optional" | "inspect-first" | "partial";
  candidateItemIds: readonly string[];
}

/** `settled` is the terminal state used by the post-project reconciliation
 * aggregate. `released` and `consumed` remain for the public one-step APIs. */
export type ReservationStatus = "active" | "released" | "consumed" | "settled";

export interface Reservation {
  id: string;
  projectRevisionId: string;
  bomLineId: string;
  itemId: string;
  quantity: number;
  status: ReservationStatus;
  createdAt: string;
  releasedAt?: string;
}

export interface Supplier {
  id: string;
  name: string;
  website?: string;
  createdAt: string;
}

export interface OfferSnapshot {
  id: string;
  itemId: string;
  supplierId: string;
  url: string;
  title?: string;
  packageQuantity: number;
  packageUnit: QuantityUnit;
  priceMinor: number;
  currency: string;
  observedAt: string;
  availability?: "in_stock" | "back_order" | "unknown";
  notes?: string;
}

export interface AuditActor {
  type: "human" | "agent" | "system" | "import";
  id: string;
  label?: string;
}

export interface AuditRecord {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actor: AuditActor;
  sourceSurface: "ui" | "api" | "mcp" | "import" | "system";
  occurredAt: string;
  correlationId: string;
  beforeVersion?: number;
  afterVersion?: number;
  metadata?: Record<string, unknown>;
}
