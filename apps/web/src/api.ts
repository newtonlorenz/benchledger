import { catalogProducts as fallbackCatalogProducts, inventory as fallbackInventory, offers as fallbackOffers, projects as fallbackProjects } from "./mock-data";
import type {
  Artifact,
  BomLine,
  BuildConfigInput,
  BuildConfigSnapshot,
  CatalogKind,
  CatalogProduct,
  CurrencyCode,
  InventoryItem,
  InventoryProductProfile,
  Offer,
  Project,
  SnapshotDescriptor
} from "./domain";
import type {
  ReconciliationEvidenceState,
  ReconciliationEvidenceViewModel,
  ReconciliationItemKind,
  ReconciliationLineViewModel,
  ReconciliationOutcomeKind,
  ReconciliationOutcomeViewModel,
  ReconciliationPreviewViewModel,
  ReconciliationReservationStatus,
  ReconciliationReservationViewModel,
  ReconciliationViewModel
} from "./reconciliation-ui";

type ServerHealth = { status: "ok" | "degraded"; service: string; version: string; demo: boolean; now: string };
type ServerInventoryItem = {
  id: string; name: string; kind: string; description?: string; manufacturer?: string; model?: string; sku?: string;
  quantity: number; availableQuantity: number; unit: string; location?: string;
  dimensions?: { lengthMm?: number; widthMm?: number; heightMm?: number; diameterMm?: number; measured?: boolean; uncertaintyMm?: number };
  tags: string[];
  links: Array<{ supplier: string; url: string; label?: string; currentPriceMinor?: number; currency?: string; observedAt?: string; packageQuantity?: number }>;
  evidence: { state: string; source?: string; sourceId?: string; observedAt?: string; note?: string };
  catalogProduct?: unknown;
  product?: unknown;
  productProfile?: unknown;
  catalogProductId?: string;
  linkState?: string;
  createdAt: string; updatedAt: string; version: number;
};
type ServerWorkItem = { id: string; projectId: string; name: string; kind: string; description?: string; currentRevisionId?: string; createdAt: string; updatedAt: string; version: number };
type ServerBomLine = { id: string; revisionId: string; name: string; itemId?: string; requiredQuantity: number; unit: string; optional: boolean; constraints?: Record<string, string>; alternatives?: Array<{ itemId: string; reason?: string; compatible?: string }>; notes?: string; createdAt: string; updatedAt: string; version: number };
type ServerArtifact = { id: string; projectId: string; workItemId?: string; revisionId?: string; role: string; filename: string; mediaType: string; byteSize: number; sha256: string; author?: string; source?: string; machineBinding?: Record<string, string>; currentCandidate: boolean; retired: boolean; createdAt: string; version: number };
type ServerRevision = { id: string; projectId: string; number: number; name: string; notes?: string; status: string; createdAt: string; version: number; bom?: ServerBomLine[]; artifacts?: ServerArtifact[]; buildConfigSnapshot?: unknown; buildConfiguration?: unknown };
type ServerProject = { id: string; name: string; description?: string; status: string; currentRevisionId?: string; createdAt: string; updatedAt: string; version: number; workItems?: ServerWorkItem[]; bom?: ServerBomLine[]; artifacts?: ServerArtifact[]; currentRevision?: ServerRevision };
type ServerOffer = { id: string; itemId?: string; name: string; supplier: string; url: string; priceMinor: number; currency: CurrencyCode; packageQuantity?: number; observedAt: string; staleAfterDays?: number; version: number };
type ServerWorkspace = { inventory: ServerInventoryItem[]; projects: ServerProject[]; offers: ServerOffer[]; source: "api"; fetchedAt: string };
type ServerUploadSession = { id: string; artifactId: string; expiresAt: string; maxBytes: number; uploadUrl: string; status: "pending" | "finalized" | "expired" };
type ServerReconciliationEvidence = { state: string; source?: string; sourceId?: string; observedAt?: string; note?: string; condition?: string; uncertainty?: number };
type ServerReconciliationConvertedAsset = { id?: string; name: string; kind: string; quantity: number; unit: string; location?: string; tags?: string[]; links?: unknown[]; evidence?: ServerReconciliationEvidence };
type ServerReconciliationOutcome = { reservationId?: string; itemId?: string; kind: string; quantity: number; unit: string; evidence: ServerReconciliationEvidence; convertedAsset?: ServerReconciliationConvertedAsset };
type ServerReconciliationLine = { bomLineId: string; outcomes: ServerReconciliationOutcome[] };
type ServerReconciliationBasisBomLine = { bomLineId: string; version: number; requiredQuantity: number; unit: string };
type ServerReconciliationBasisReservation = { reservationId: string; lineId: string; itemId: string; quantity: number; unit: string; status: string; version: number };
type ServerReconciliationBasisItem = { itemId: string; version: number; onHand: number; allocated: number; available: number; unit: string };
type ServerReconciliationBasis = { hash: string; bomLines: ServerReconciliationBasisBomLine[]; reservations: ServerReconciliationBasisReservation[]; items: ServerReconciliationBasisItem[] };
type ServerReconciliationPreviewLine = { bomLineId: string; reservedQuantity: number; accountedQuantity: number; unaccountedQuantity: number; outcomeCount: number; unit?: string };
type ServerReconciliationPreviewReservationChange = { reservationId: string; fromStatus: string; toStatus: string; quantity: number; unit: string };
type ServerReconciliationPreviewStockChange = { itemId: string; kind: string; quantity: number; unit: string; beforeOnHand: number; afterOnHand: number; beforeAllocated: number; afterAllocated: number; beforeAvailable: number; afterAvailable: number; eventKey: string; eventId?: string };
type ServerReconciliationPreviewAsset = { itemId: string; name: string; kind: string; quantity: number; unit: string };
type ServerReconciliationPreview = { lines: ServerReconciliationPreviewLine[]; reservationChanges: ServerReconciliationPreviewReservationChange[]; stockChanges: ServerReconciliationPreviewStockChange[]; createdAssets: ServerReconciliationPreviewAsset[] };
type ServerReconciliationDraft = { id: string; projectId: string; projectRevisionId: string; status: "draft" | "committed"; version: number; lines: ServerReconciliationLine[]; basis: ServerReconciliationBasis; preview: ServerReconciliationPreview; createdAt: string; updatedAt: string; committedAt?: string; commitId?: string; auditId?: string };
type ServerReconciliationCommit = { id: string; projectId: string; projectRevisionId: string; draftId: string; status: "committed"; basis: ServerReconciliationBasis; lines: ServerReconciliationLine[]; stockChanges: Array<ServerReconciliationPreviewStockChange & { eventId: string }>; reservationChanges: Array<ServerReconciliationPreviewReservationChange & { version: number }>; createdAssets: ServerInventoryItem[]; committedAt: string; auditId?: string };
type ServerReservation = { id: string; lineId: string; itemId: string; quantity: number; status: string; version: number; unit?: string };
export type RevisionInput = { name: string; notes?: string; status?: string; buildConfig?: BuildConfigInput };
export type BomInput = { name: string; requiredQuantity: number; unit: BomLine["unit"]; itemId?: string; optional?: boolean; note?: string };
export type InventoryUpdateInput = Pick<InventoryItem, "name" | "description" | "manufacturer" | "location" | "sku" | "tags"> & { model: string };

export type CatalogProductDraft = {
  kind: CatalogKind;
  manufacturer: string;
  family?: string;
  model?: string;
  variant?: string;
  colour?: string;
  colourCode?: string;
  diameterMm?: number;
  netMassG?: number;
  productCode?: string;
  buildVolumeMm?: { x: number; y: number; z: number };
};

export type ExactInventoryInput = {
  category: "Filament" | "Printers";
  product: CatalogProduct;
  quantity: number;
  linkState: InventoryProductProfile["linkState"];
  filament?: InventoryProductProfile["filament"];
  printer?: InventoryProductProfile["printer"];
};

export type ApiErrorKind = "unauthenticated" | "forbidden" | "csrf" | "offline" | "server" | "validation";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string | undefined;
  readonly correlationId: string | undefined;
  readonly demo: boolean | undefined;

  constructor(message: string, options: { kind: ApiErrorKind; status?: number; code?: string; correlationId?: string; demo?: boolean }) {
    super(message);
    this.name = "ApiError";
    this.kind = options.kind;
    this.status = options.status ?? 0;
    this.code = options.code;
    this.correlationId = options.correlationId;
    this.demo = options.demo;
  }
}

export interface LoginResult { authenticated: true; actor: string; csrfToken: string; expiresAt: string }
export interface SessionResult { authenticated: true; actor: string; source?: string; scopes: string[]; projectIds?: string[] }
export interface WorkspaceSnapshot { inventory: InventoryItem[]; projects: Project[]; offers: Offer[]; source: "api" | "synthetic"; fetchedAt: string; health?: ServerHealth }
export interface WorkspaceAdapter {
  checkHealth(): Promise<ServerHealth>;
  session(): Promise<SessionResult>;
  login(password: string): Promise<LoginResult>;
  logout(): Promise<void>;
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  recordCount(itemId: string, quantity: number): Promise<InventoryItem>;
  updateInventoryItem(itemId: string, input: Partial<InventoryUpdateInput>, expectedVersion?: number): Promise<InventoryItem>;
  createInventoryItem(input: { name: string; category: InventoryItem["category"]; quantity: number; unit: InventoryItem["unit"] }): Promise<InventoryItem>;
  searchCatalogProducts(kind: CatalogKind, query?: string): Promise<CatalogProduct[]>;
  createCatalogProduct(input: CatalogProductDraft): Promise<CatalogProduct>;
  createExactInventoryItem(input: ExactInventoryInput): Promise<InventoryItem>;
  createProject(input: Pick<Project, "name" | "description">): Promise<Project>;
  createRevision(projectId: string, input: RevisionInput): Promise<Project>;
  createBuildConfigSnapshot(projectId: string, revisionId: string, input: BuildConfigInput): Promise<BuildConfigSnapshot>;
  createBomLine(projectId: string, input: BomInput): Promise<Project>;
  uploadArtifact(projectId: string, file: File, role: string): Promise<Project>;
  readReconciliation(projectId: string, revisionId: string): Promise<ReconciliationViewModel>;
  saveReconciliationDraft(projectId: string, revisionId: string, model: ReconciliationViewModel): Promise<ReconciliationViewModel>;
  commitReconciliation(projectId: string, revisionId: string, model: ReconciliationViewModel): Promise<ReconciliationViewModel>;
}

function apiRoot(): string {
  const configured = import.meta.env.VITE_BENCHLEDGER_API_URL as string | undefined;
  return configured?.replace(/\/$/u, "") || "/api/v1";
}

function cookieValue(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const prefix = `${name}=`;
  return document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
}

function errorKind(status: number, code?: string): ApiErrorKind {
  if (status === 401) return "unauthenticated";
  if (status === 403 && code === "csrf") return "csrf";
  if (status === 403) return "forbidden";
  if ([400, 409, 413, 415].includes(status)) return "validation";
  return "server";
}

async function request<T>(path: string, init: RequestInit = {}, csrfToken?: string, options: { json?: boolean } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiRoot()}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.body === undefined || options.json === false ? {} : { "Content-Type": "application/json" }),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        ...(init.headers ?? {})
      }
    });
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "The BenchLedger service could not be reached", { kind: "offline" });
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!response.ok) {
    const envelope = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    const detail = envelope && typeof envelope === "object" && "message" in envelope && typeof envelope.message === "string" ? envelope.message : `BenchLedger returned HTTP ${response.status}`;
    const code = envelope && typeof envelope === "object" && "code" in envelope && typeof envelope.code === "string" ? envelope.code : undefined;
    const correlationId = envelope && typeof envelope === "object" && "correlationId" in envelope && typeof envelope.correlationId === "string" ? envelope.correlationId : response.headers.get("x-correlation-id") ?? undefined;
    throw new ApiError(detail, { kind: errorKind(response.status, code), status: response.status, ...(code ? { code } : {}), ...(correlationId ? { correlationId } : {}) });
  }
  return payload as T;
}

function mapCategory(kind: string): InventoryItem["category"] {
  switch (kind) {
    case "printer": return "Printers";
    case "filament": return "Filament";
    case "tool": return "Tools";
    case "accessory": return "Accessories";
    case "electronic": return "Electronics";
    case "fastener": return "Fasteners";
    case "wire": return "Wire & cable";
    default: return "Accessories";
  }
}

function mapUnit(unit: string): InventoryItem["unit"] {
  if (unit === "gram") return "g";
  if (unit === "metre") return "m";
  return "each";
}

function mapEvidence(state: string): InventoryItem["evidence"] {
  if (state === "physically_counted") return "counted";
  if (state === "commissioned") return "commissioned";
  if (state === "ordered_unverified") return "ordered";
  return "delivered";
}

function mapStockState(item: ServerInventoryItem): InventoryItem["state"] {
  if (item.evidence.state === "ordered_unverified") return "ordered-unverified";
  if (item.evidence.state === "physically_counted" || item.evidence.state === "commissioned") {
    if (item.availableQuantity > 0) return "available";
    return item.quantity > 0 ? "reserved" : "depleted";
  }
  return "inspect-first";
}

function mapAccent(category: InventoryItem["category"]): InventoryItem["accent"] {
  if (category === "Printers" || category === "Electronics") return "teal";
  if (category === "Filament" || category === "Fasteners") return "slate";
  if (category === "Tools") return "blue";
  if (category === "Accessories") return "yellow";
  return "orange";
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(record: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstNumber(record: UnknownRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function mapCatalogKind(value: unknown): CatalogKind | undefined {
  return value === "filament" || value === "printer" ? value : undefined;
}

export function mapCatalogProduct(value: unknown, fallbackKind?: CatalogKind): CatalogProduct | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kind = mapCatalogKind(record.kind ?? record.type) ?? fallbackKind;
  const id = firstString(record, "id", "productId", "catalogProductId");
  const manufacturer = firstString(record, "manufacturer", "maker", "brand");
  if (!kind || !id || !manufacturer) return undefined;
  const productName = firstString(record, "productName");
  const materialFamily = firstString(record, "materialFamily");
  const materialSubtype = firstString(record, "materialSubtype");
  const family = firstString(record, "family", "productFamily", "familyName") ?? materialFamily;
  const model = firstString(record, "model", "modelName") ?? productName ?? firstString(record, "exactModel");
  const variant = firstString(record, "variant", "variantName") ?? materialSubtype ?? firstString(record, "exactVariant");
  const exactModel = firstString(record, "exactModel") ?? (kind === "printer" ? model : undefined);
  const exactVariant = firstString(record, "exactVariant") ?? (kind === "printer" ? variant : undefined);
  const rawColour = firstString(record, "colour", "color", "colourName");
  const rawColourCode = firstString(record, "colourCode", "colorCode", "colour_code", "color_code");
  const diameterMm = firstNumber(record, "diameterMm", "diameter", "filamentDiameterMm");
  const netMassG = firstNumber(record, "netMassG", "netMass", "netMassGrams", "massG", "nominalNetMassG");
  const nominalLengthM = firstNumber(record, "nominalLengthM", "lengthM");
  const densityGcm3 = firstNumber(record, "densityGcm3", "density");
  const productCode = firstString(record, "productCode", "sku", "code");
  const version = numberValue(record.version);
  const evidence = firstString(record, "evidence", "evidenceState");
  const contentHash = firstString(record, "contentHash", "hash", "sha256");
  const buildVolume = asRecord(record.buildVolumeMm);
  const buildVolumeMm = buildVolume
    && firstNumber(buildVolume, "x") !== undefined
    && firstNumber(buildVolume, "y") !== undefined
    && firstNumber(buildVolume, "z") !== undefined
    ? { x: firstNumber(buildVolume, "x")!, y: firstNumber(buildVolume, "y")!, z: firstNumber(buildVolume, "z")! }
    : undefined;
  return {
    id,
    kind,
    manufacturer,
    ...(productName ? { productName } : {}),
    ...(materialFamily ? { materialFamily } : {}),
    ...(materialSubtype ? { materialSubtype } : {}),
    ...(rawColour ? { colourName: rawColour } : {}),
    ...(netMassG !== undefined ? { nominalNetMassG: netMassG } : {}),
    ...(nominalLengthM !== undefined ? { nominalLengthM } : {}),
    ...(firstString(record, "lengthBasis") === "manufacturer_declared" || firstString(record, "lengthBasis") === "calculated" || firstString(record, "lengthBasis") === "unknown" ? { lengthBasis: firstString(record, "lengthBasis") as "manufacturer_declared" | "calculated" | "unknown" } : {}),
    ...(densityGcm3 !== undefined ? { densityGcm3 } : {}),
    ...(exactModel ? { exactModel } : {}),
    ...(exactVariant ? { exactVariant } : {}),
    ...(record.technology === "fff" ? { technology: "fff" as const } : {}),
    ...(buildVolumeMm ? { buildVolumeMm } : {}),
    ...(family ? { family } : {}),
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
    ...(rawColour ? { colour: rawColour, color: rawColour } : {}),
    ...(rawColourCode ? { colourCode: rawColourCode, colorCode: rawColourCode } : {}),
    ...(diameterMm !== undefined ? { diameterMm } : {}),
    ...(netMassG !== undefined ? { netMassG } : {}),
    ...(productCode ? { productCode, sku: productCode } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(evidence ? { evidence } : {}),
    ...(contentHash ? { contentHash } : {})
  };
}

function mapLinkState(value: unknown): InventoryProductProfile["linkState"] {
  return value === "confirmed" || value === "suggested" ? value : "reported";
}

export function mapInventoryProductProfile(value: unknown, fallbackItemId?: string): InventoryProductProfile | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const catalogProductId = firstString(record, "catalogProductId", "productId", "catalog_id");
  const linkState = mapLinkState(record.linkState ?? record.link_state ?? record.state);
  const details = asRecord(record.details);
  const filamentRecord = asRecord(record.filament) ?? (record.profileType === "filament_spool" ? details : undefined) ?? record;
  const printerRecord = asRecord(record.printer) ?? (record.profileType === "printer_asset" ? details : undefined) ?? record;
  const lotBatch = firstString(filamentRecord, "lotBatch", "lot", "batch");
  const filamentState = (filamentRecord.state === "opened" || filamentRecord.opened === true)
    ? "opened" as const
    : (filamentRecord.state === "sealed" || filamentRecord.opened === false || filamentRecord.openedState === "sealed") ? "sealed" as const
      : filamentRecord.openedState === "open" ? "opened" as const : undefined;
  const openedAt = firstString(filamentRecord, "openedAt", "openedDate");
  const tareMassG = firstNumber(filamentRecord, "tareMassG", "tareMass", "tareGrams");
  const filamentPlacement = firstString(filamentRecord, "placement", "currentPlacement", "location", "amsSlot");
  const lot = firstString(filamentRecord, "lot");
  const batch = firstString(filamentRecord, "batch");
  const lotCode = firstString(filamentRecord, "lotCode");
  const openedState = filamentRecord.openedState === "sealed" || filamentRecord.openedState === "open" || filamentRecord.openedState === "unknown" ? filamentRecord.openedState : undefined;
  const filament: NonNullable<InventoryProductProfile["filament"]> = {
    ...(lotBatch ? { lotBatch } : {}),
    ...(lot ? { lot } : {}),
    ...(batch ? { batch } : {}),
    ...(lotCode ? { lotCode } : {}),
    ...(filamentState ? { state: filamentState } : {}),
    ...(openedState ? { openedState } : {}),
    ...(openedAt ? { openedAt } : {}),
    ...(tareMassG !== undefined ? { tareMassG } : {}),
    ...(filamentPlacement ? { placement: filamentPlacement, currentPlacement: filamentPlacement } : {})
  };
  const assetLabel = firstString(printerRecord, "assetLabel", "asset", "label");
  const commissionedAt = firstString(printerRecord, "commissionedAt", "commissionedDate");
  const printerPlacement = firstString(printerRecord, "placement", "location");
  const printer: NonNullable<InventoryProductProfile["printer"]> = {
    ...(assetLabel ? { assetLabel } : {}),
    ...(commissionedAt ? { commissionedAt } : {}),
    ...(printerPlacement ? { placement: printerPlacement, location: printerPlacement } : {}),
    ...(printerRecord.condition === "new" || printerRecord.condition === "good" || printerRecord.condition === "worn" || printerRecord.condition === "needs_repair" || printerRecord.condition === "unknown" ? { condition: printerRecord.condition } : {})
  };
  const hasFilament = Object.keys(filament).length > 0;
  const hasPrinter = Object.keys(printer).length > 0;
  const profileId = firstString(record, "id", "profileId");
  const inventoryItemId = firstString(record, "inventoryItemId", "itemId") ?? fallbackItemId;
  const evidence = firstString(record, "evidence", "evidenceState");
  const version = numberValue(record.version);
  const contentHash = firstString(record, "contentHash", "hash", "sha256");
  return {
    ...(profileId ? { id: profileId } : {}),
    ...(inventoryItemId ? { inventoryItemId } : {}),
    ...(catalogProductId ? { catalogProductId } : {}),
    linkState,
    ...(hasFilament ? { filament } : {}),
    ...(hasPrinter ? { printer } : {}),
    ...(evidence ? { evidence } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(contentHash ? { contentHash } : {})
  };
}

function responseList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["data", "products", "items", "results"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
    const nestedRecord = asRecord(nested);
    if (nestedRecord && Array.isArray(nestedRecord.data)) return nestedRecord.data;
  }
  return [];
}

function responseValue<T>(value: unknown): T | undefined {
  const record = asRecord(value);
  if (!record) return value as T;
  const nested = record.data ?? record.product ?? record.item ?? record.snapshot;
  return nested === undefined ? value as T : nested as T;
}

function descriptorText(value: unknown, ...keys: string[]): string | undefined {
  const direct = stringValue(value);
  if (direct) return direct;
  const record = asRecord(value);
  return record ? firstString(record, ...keys) : undefined;
}

function descriptorNumber(value: unknown, ...keys: string[]): number | undefined {
  const record = asRecord(value);
  return record ? firstNumber(record, ...keys) : undefined;
}

function mapBuildConfigSnapshot(value: unknown, projectId: string, revisionId: string, fallback: BuildConfigInput): BuildConfigSnapshot {
  const record = asRecord(value) ?? {};
  const stringArray = (candidate: unknown): string[] => Array.isArray(candidate) ? candidate.filter((entry): entry is string => typeof entry === "string") : [];
  const printerSnapshot = asRecord(record.printerItemSnapshot);
  const filamentSnapshots = Array.isArray(record.filamentSelections)
    ? record.filamentSelections.filter((entry): entry is UnknownRecord => asRecord(entry) !== undefined).map((entry) => asRecord(entry)!)
    : [];
  const firstFilament = filamentSnapshots[0];
  const printerItemId = firstString(printerSnapshot ?? {}, "itemId") ?? firstString(record, "printerItemId", "printerInventoryItemId") ?? fallback.printerItemId;
  const printerProfileId = firstString(printerSnapshot ?? {}, "profileId") ?? fallback.printerProfileId;
  const printerProductId = firstString(printerSnapshot ?? {}, "catalogProductId") ?? firstString(record, "printerProductId") ?? fallback.printerProductId;
  const filamentItemId = firstString(firstFilament ?? {}, "itemId") ?? firstString(record, "filamentItemId", "filamentInventoryItemId") ?? fallback.filamentItemId;
  const filamentProfileId = firstString(firstFilament ?? {}, "profileId") ?? fallback.filamentProfileId;
  const filamentProductId = firstString(firstFilament ?? {}, "catalogProductId") ?? firstString(record, "filamentProductId") ?? fallback.filamentProductId;
  const hotendSide = descriptorText(record.activeHotend, "side", "name", "model") ?? firstString(record, "hotendSide") ?? fallback.hotendSide;
  const nozzleDiameterMm = descriptorNumber(record.nozzle, "diameterMm") ?? firstNumber(record, "nozzleDiameterMm", "nozzleDiameter") ?? fallback.nozzleDiameterMm;
  const nozzleMaterial = descriptorText(record.nozzle, "material", "nozzleMaterial") ?? firstString(record, "nozzleMaterial") ?? fallback.nozzleMaterial;
  const buildPlate = descriptorText(record.plate, "name", "surface", "model") ?? firstString(record, "buildPlate") ?? fallback.buildPlate;
  const accessoryDescriptors: SnapshotDescriptor[] = Array.isArray(record.accessories)
    ? record.accessories.filter((entry): entry is SnapshotDescriptor => typeof entry === "string" || asRecord(entry) !== undefined).map((entry) => typeof entry === "string" ? entry : entry as SnapshotDescriptor)
    : [];
  const accessories = accessoryDescriptors.map((entry) => descriptorText(entry, "name", "type", "model") ?? "Unlabelled accessory");
  const firmware = descriptorText(record.firmware, "version", "name") ?? firstString(record, "firmware", "firmwareVersion") ?? fallback.firmware;
  const slicer = descriptorText(record.slicer, "name") ?? firstString(record, "slicer") ?? fallback.slicer;
  const slicerVersion = descriptorText(record.slicer, "version") ?? firstString(record, "slicerVersion") ?? fallback.slicerVersion;
  const profile = descriptorText(record.profile, "name", "model") ?? firstString(record, "profile", "slicerProfile") ?? fallback.profile;
  const calibration = descriptorText(record.calibration, "state", "name") ?? firstString(record, "calibration", "calibrationState") ?? fallback.calibration;
  const unknowns = stringArray(record.explicitUnknowns).length ? stringArray(record.explicitUnknowns) : stringArray(record.unknowns).length ? stringArray(record.unknowns) : [...fallback.unknowns];
  const input: BuildConfigInput = {
    ...(printerItemId ? { printerItemId } : {}),
    ...(printerProfileId ? { printerProfileId } : {}),
    ...(filamentItemId ? { filamentItemId } : {}),
    ...(filamentProfileId ? { filamentProfileId } : {}),
    ...(printerProductId ? { printerProductId } : {}),
    ...(filamentProductId ? { filamentProductId } : {}),
    ...(hotendSide ? { hotendSide } : {}),
    ...(nozzleDiameterMm !== undefined ? { nozzleDiameterMm } : {}),
    ...(nozzleMaterial ? { nozzleMaterial } : {}),
    ...(buildPlate ? { buildPlate } : {}),
    accessories: accessories.length ? accessories : [...fallback.accessories],
    ...(firmware ? { firmware } : {}),
    ...(slicer ? { slicer } : {}),
    ...(slicerVersion ? { slicerVersion } : {}),
    ...(profile ? { profile } : {}),
    ...(calibration ? { calibration } : {}),
    unknowns
  };
  const snapshotId = firstString(record, "id", "snapshotId") ?? `build-config-${projectId}-${revisionId}`;
  const snapshotProjectId = firstString(record, "projectId") ?? projectId;
  const snapshotRevisionId = firstString(record, "projectRevisionId", "revisionId") ?? revisionId;
  const createdAt = firstString(record, "createdAt", "capturedAt") ?? new Date().toISOString();
  const version = firstNumber(record, "version") ?? 1;
  const contentSha256 = firstString(record, "contentSha256");
  const contentHash = contentSha256 ?? firstString(record, "contentHash", "hash", "sha256");
  const evidence = firstString(record, "evidence", "evidenceState");
  return {
    ...input,
    id: snapshotId,
    projectId: snapshotProjectId,
    revisionId: snapshotRevisionId,
    createdAt,
    version,
    ...(contentHash ? { contentHash } : {}),
    ...(evidence ? { evidence } : {}),
    projectRevisionId: snapshotRevisionId,
    ...(printerSnapshot ? { printerItemSnapshot: { ...printerSnapshot } } : {}),
    ...(filamentSnapshots.length ? { filamentSelections: filamentSnapshots.map((entry) => ({ ...entry })) } : {}),
    ...(record.activeHotend !== undefined ? { activeHotend: record.activeHotend as SnapshotDescriptor } : {}),
    ...(record.nozzle !== undefined ? { nozzle: record.nozzle as SnapshotDescriptor } : {}),
    ...(record.plate !== undefined ? { plate: record.plate as SnapshotDescriptor } : {}),
    ...(accessoryDescriptors.length ? { accessoryDescriptors } : {}),
    ...(record.firmware !== undefined ? { firmwareDescriptor: record.firmware as SnapshotDescriptor } : {}),
    ...(record.slicer !== undefined ? { slicerDescriptor: record.slicer as SnapshotDescriptor } : {}),
    ...(record.profile !== undefined ? { profileDescriptor: record.profile as SnapshotDescriptor } : {}),
    ...(record.calibration !== undefined ? { calibrationDescriptor: record.calibration as SnapshotDescriptor } : {}),
    explicitUnknowns: [...unknowns],
    ...(contentSha256 ? { contentSha256 } : {})
  };
}

function canonicalCatalogProductBody(input: CatalogProductDraft): UnknownRecord {
  const requiredText = (value: string | undefined, label: string): string => {
    const normalized = value?.trim();
    if (!normalized) throw new ApiError(`${label} is required for an exact catalog product`, { kind: "validation", status: 400 });
    return normalized;
  };
  const requiredPositive = (value: number | undefined, label: string): number => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) throw new ApiError(`${label} must be greater than zero for an exact catalog product`, { kind: "validation", status: 400 });
    return value;
  };
  const manufacturer = requiredText(input.manufacturer, "Manufacturer");
  if (input.kind === "filament") {
    const materialFamily = requiredText(input.family, "Material family");
    const colourName = requiredText(input.colour, "Colour");
    const diameterMm = requiredPositive(input.diameterMm, "Diameter");
    const nominalNetMassG = requiredPositive(input.netMassG, "Net mass");
    return {
      kind: "filament",
      manufacturer,
      ...(input.model ? { productName: input.model } : {}),
      ...(input.productCode ? { sku: input.productCode } : {}),
      materialFamily,
      ...(input.variant ? { materialSubtype: input.variant } : {}),
      colourName,
      ...(input.colourCode ? { colourCode: input.colourCode } : {}),
      diameterMm,
      nominalNetMassG,
      lengthBasis: "unknown"
    };
  }
  const exactModel = requiredText(input.model, "Exact model");
  const buildVolumeMm = input.buildVolumeMm;
  if (!buildVolumeMm) throw new ApiError("Build volume X, Y, and Z are required for an exact printer product", { kind: "validation", status: 400 });
  const dimensions = { x: requiredPositive(buildVolumeMm.x, "Build volume X"), y: requiredPositive(buildVolumeMm.y, "Build volume Y"), z: requiredPositive(buildVolumeMm.z, "Build volume Z") };
  return {
    kind: "printer",
    manufacturer,
    exactModel,
    ...(input.variant ? { exactVariant: input.variant } : {}),
    technology: "fff",
    buildVolumeMm: dimensions
  };
}

function isoDateValue(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000Z` : value;
}

function exactInventoryBody(input: ExactInventoryInput): UnknownRecord {
  const product = input.product;
  const placement = input.filament?.placement ?? input.printer?.placement;
  const dimensions = input.category === "Filament" && product.diameterMm !== undefined
    ? { diameterMm: product.diameterMm, measured: false }
    : undefined;
  return {
    name: catalogProductDisplayName(product),
    kind: input.category === "Filament" ? "filament" : "printer",
    quantity: input.quantity,
    unit: input.category === "Filament" ? "gram" : "each",
    manufacturer: product.manufacturer,
    ...(product.model ? { model: product.model } : {}),
    ...((product.productCode ?? product.sku) ? { sku: product.productCode ?? product.sku } : {}),
    ...(placement ? { location: placement } : {}),
    ...(dimensions ? { dimensions } : {}),
    tags: [input.category.toLowerCase(), "exact-product"],
    links: [],
    evidence: { state: input.category === "Printers" ? "commissioned" : "unknown", source: "ui" }
  };
}

function exactInventoryProfileBody(input: ExactInventoryInput): UnknownRecord {
  const product = input.product;
  const details = input.category === "Filament"
    ? {
        ...(input.filament?.lotBatch ? { lot: input.filament.lotBatch } : {}),
        ...(input.filament?.lot ? { lot: input.filament.lot } : {}),
        ...(input.filament?.batch ? { batch: input.filament.batch } : {}),
        ...(input.filament?.lotCode ? { lotCode: input.filament.lotCode } : {}),
        ...(input.filament?.state ? { openedState: input.filament.state === "opened" ? "open" : "sealed" } : {}),
        ...(input.filament?.openedAt ? { openedAt: isoDateValue(input.filament.openedAt) } : {}),
        ...(input.filament?.tareMassG !== undefined ? { tareMassG: input.filament.tareMassG } : {}),
        ...(input.filament?.placement ? { currentPlacement: input.filament.placement } : {})
      }
    : {
        ...(input.printer?.assetLabel ? { assetLabel: input.printer.assetLabel } : {}),
        ...(input.printer?.commissionedAt ? { commissionedAt: isoDateValue(input.printer.commissionedAt) } : {}),
        ...(input.printer?.placement ? { location: input.printer.placement } : {})
      };
  return {
    catalogProductId: product.id,
    profileType: input.category === "Filament" ? "filament_spool" : "printer_asset",
    linkState: input.linkState,
    details
  };
}

function exactInventoryCompoundBody(input: ExactInventoryInput): UnknownRecord {
  return {
    item: exactInventoryBody(input),
    profile: exactInventoryProfileBody(input)
  };
}

function canonicalBuildConfigurationBody(revisionId: string, input: BuildConfigInput): UnknownRecord {
  if (!input.printerItemId || !input.printerProductId) {
    throw new ApiError("Choose an exact owned printer before saving build setup", { kind: "validation", status: 400 });
  }
  const descriptor = (value: string | undefined, fallback: string): string => value?.trim() || fallback;
  const filamentSelections = input.filamentItemId && input.filamentProductId
    ? [{ itemId: input.filamentItemId, catalogProductId: input.filamentProductId, ...(input.filamentProfileId ? { profileId: input.filamentProfileId } : {}) }]
    : [];
  const activeHotend = descriptor(input.hotendSide, "Not recorded");
  const nozzle = input.nozzleDiameterMm !== undefined || input.nozzleMaterial
    ? { ...(input.nozzleDiameterMm !== undefined ? { diameterMm: input.nozzleDiameterMm } : {}), ...(input.nozzleMaterial ? { material: input.nozzleMaterial } : {}) }
    : "Not recorded";
  const plate = descriptor(input.buildPlate, "Not recorded");
  const firmware = descriptor(input.firmware, "Not recorded");
  const slicer = input.slicer || input.slicerVersion
    ? { ...(input.slicer ? { name: input.slicer } : {}), ...(input.slicerVersion ? { version: input.slicerVersion } : {}) }
    : "Not recorded";
  const profile = descriptor(input.profile, "Not recorded");
  const calibration = descriptor(input.calibration, "Not recorded");
  return {
    projectRevisionId: revisionId,
    printerItemSnapshot: { itemId: input.printerItemId, catalogProductId: input.printerProductId, ...(input.printerProfileId ? { profileId: input.printerProfileId } : {}) },
    filamentSelections,
    activeHotend,
    nozzle,
    plate,
    accessories: input.accessories.map((name) => name),
    firmware,
    slicer,
    profile,
    calibration,
    explicitUnknowns: [...input.unknowns]
  };
}

function catalogProductDisplayName(product: CatalogProduct): string {
  return [product.manufacturer, product.family, product.model, product.variant, product.colour ?? product.color]
    .filter((part): part is string => Boolean(part?.trim())).join(" ") || (product.productCode ?? product.sku ?? product.id);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function mapInventoryItem(item: ServerInventoryItem): InventoryItem {
  const category = mapCategory(item.kind);
  const state = mapStockState(item);
  const confirmed = item.evidence.state === "physically_counted" || item.evidence.state === "commissioned";
  const catalogProduct = mapCatalogProduct(item.catalogProduct ?? item.product, category === "Filament" ? "filament" : category === "Printers" ? "printer" : undefined);
  const mappedProfile = mapInventoryProductProfile(item.productProfile, item.id);
  const productProfile = mappedProfile ?? (item.catalogProductId || item.linkState
    ? { inventoryItemId: item.id, ...(item.catalogProductId ? { catalogProductId: item.catalogProductId } : {}), linkState: mapLinkState(item.linkState) }
    : undefined);
  const dimensions = item.dimensions ? {
    ...(item.dimensions.lengthMm === undefined ? {} : { length: item.dimensions.lengthMm }),
    ...(item.dimensions.widthMm === undefined ? {} : { width: item.dimensions.widthMm }),
    ...(item.dimensions.heightMm === undefined ? {} : { height: item.dimensions.heightMm }),
    ...(item.dimensions.diameterMm === undefined ? {} : { diameter: item.dimensions.diameterMm }),
    unit: "mm" as const
  } : undefined;
  return {
    id: item.id, name: item.name, kind: item.kind, category,
    variant: item.model ?? item.sku ?? item.kind,
    ...(item.model ? { model: item.model } : {}),
    description: item.description?.trim() || "No description recorded.", quantity: item.quantity, availableQuantity: item.availableQuantity, unit: mapUnit(item.unit),
    reserved: confirmed ? Math.max(item.quantity - item.availableQuantity, 0) : 0,
    state, evidence: mapEvidence(item.evidence.state), location: item.location?.trim() || "Unassigned",
    ...(dimensions ? { dimensions } : {}), ...(item.manufacturer ? { manufacturer: item.manufacturer } : {}), ...(item.sku ? { sku: item.sku } : {}),
    tags: [...item.tags], compatibility: [],
    provenance: {
      ...(item.evidence.source ? { source: item.evidence.source } : {}),
      ...(item.evidence.sourceId ? { sourceId: item.evidence.sourceId } : {}),
      ...(item.evidence.observedAt ? { observedAt: item.evidence.observedAt } : {}),
      ...(item.evidence.note ? { note: item.evidence.note } : {})
    },
    version: item.version,
    ...(item.evidence.observedAt ? { lastCounted: item.evidence.observedAt.slice(0, 10) } : {}), accent: mapAccent(category), serverUnit: item.unit,
    ...(catalogProduct ? { catalogProduct } : {}), ...(productProfile ? { productProfile } : {})
  };
}

function mapBomLine(line: ServerBomLine): BomLine {
  return {
    id: line.id,
    label: line.name,
    ...(line.itemId ? { itemId: line.itemId } : {}),
    required: line.requiredQuantity,
    unit: mapUnit(line.unit),
    optional: line.optional,
    ...(line.notes ? { note: line.notes } : {})
  };
}

function mapArtifact(artifact: ServerArtifact, revision?: ServerRevision): Artifact {
  const role: Artifact["role"] = artifact.role === "step" ? "STEP" : artifact.role === "stl" ? "STL" : artifact.role === "three_mf" || artifact.role === "slicer_project" || artifact.role === "gcode" ? "Build plate" : artifact.role === "cad_source" ? "Editable CAD" : artifact.role === "text" || artifact.role === "brief" ? "Notes" : "Validation";
  const revisionLabel = revision && artifact.revisionId === revision.id ? `r${String(revision.number).padStart(2, "0")}` : artifact.revisionId ?? "Unbound";
  const machine = artifact.machineBinding?.machine ?? artifact.machineBinding?.printer;
  const material = artifact.machineBinding?.material;
  return {
    id: artifact.id,
    name: artifact.filename,
    role,
    revision: revisionLabel,
    size: formatBytes(artifact.byteSize),
    hash: artifact.sha256,
    updated: artifact.createdAt.slice(0, 10),
    status: artifact.retired ? "superseded" : artifact.currentCandidate ? "candidate" : "validated",
    ...(machine ? { machine } : {}),
    ...(material ? { material } : {})
  };
}

function railStepFor(status: string | undefined, projectStatus: string): number {
  if (status === "concept" || projectStatus === "idea") return 0;
  if (status === "CAD complete") return 1;
  if (status === "DFAM reviewed") return 2;
  if (status === "mesh validated") return 3;
  if (status === "slicer validated") return 4;
  if (status === "test printed" || status === "fit/function verified" || status === "production approved" || projectStatus === "complete") return 5;
  return projectStatus === "planning" ? 2 : 3;
}

function mapProject(project: ServerProject): Project {
  const status: Project["status"] = project.status === "complete" ? "Complete" : project.status === "idea" ? "Idea" : "In progress";
  const revision = project.currentRevision;
  const workItem = project.workItems?.[0];
  const bom = revision?.bom ?? project.bom ?? [];
  const artifacts = revision?.artifacts ?? project.artifacts ?? [];
  const currentRevision = revision ? `r${String(revision.number).padStart(2, "0")}` : project.currentRevisionId ?? "No revision";
  const rawBuildConfig = revision?.buildConfigSnapshot ?? revision?.buildConfiguration;
  const buildConfigSnapshot = revision && rawBuildConfig !== undefined
    ? mapBuildConfigSnapshot(responseValue(rawBuildConfig), project.id, revision.id, { accessories: [], unknowns: [] })
    : undefined;
  return {
    id: project.id,
    name: project.name,
    subtitle: workItem?.description ?? project.description ?? "A maker project in the workspace",
    description: project.description ?? "Add a project goal to define the next task.",
    status,
    updated: project.updatedAt.slice(0, 10),
    currentRevision,
    workItem: workItem?.name ?? "Project setup",
    railStep: railStepFor(revision?.status, project.status),
    bom: bom.map(mapBomLine),
    artifacts: artifacts.map((artifact) => mapArtifact(artifact, revision)),
    notes: revision?.notes ? [revision.notes] : [],
    accent: status === "Complete" ? "blue" : "orange",
    ...(revision?.id ?? project.currentRevisionId ? { serverRevisionId: revision?.id ?? project.currentRevisionId } : {}),
    ...(buildConfigSnapshot ? { buildConfigSnapshot } : {})
  };
}

function mapOffer(offer: ServerOffer): Offer {
  return { id: offer.id, itemId: offer.itemId ?? "", supplier: offer.supplier, title: offer.name, priceMinor: offer.priceMinor, currency: offer.currency, pack: offer.packageQuantity ? `${offer.packageQuantity} pieces` : "Package size not recorded", eta: "Check supplier", url: offer.url, observed: offer.observedAt.slice(0, 10) };
}

function mutationData<T>(payload: { data?: T }): T {
  if (payload.data === undefined) throw new ApiError("The service returned an incomplete mutation", { kind: "server", status: 502 });
  return payload.data;
}

function serverUnitFor(item: InventoryItem): string {
  if (item.serverUnit) return item.serverUnit;
  if (item.unit === "g") return "gram";
  if (item.unit === "m") return "metre";
  return "each";
}

function idempotencyKey(prefix: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `web-${prefix}-${random}`;
}

type RevisionRequestBody = {
  readonly name: string;
  readonly notes?: string;
  readonly status: string;
};

type ProjectRequestBody = {
  readonly project: { readonly name: string; readonly description: string; readonly status: "idea" };
  readonly revision: { readonly name: "Initial concept"; readonly status: "concept" };
};

type PendingProjectCommand = {
  readonly key: string;
  readonly body: ProjectRequestBody;
};

type PendingRevisionCommand = {
  readonly key: string;
  readonly body: RevisionRequestBody;
};

type ExactInventoryRequestBody = ReturnType<typeof exactInventoryCompoundBody>;
type PendingExactInventoryCommand = {
  readonly key: string;
  readonly body: ExactInventoryRequestBody;
};
type ReconciliationDraftRequestBody = ReturnType<typeof reconciliationDraftBody>;
type ReconciliationCommitRequestBody = ReturnType<typeof reconciliationCommitBody>;
type PendingReconciliationCommand<TBody> = {
  readonly key: string;
  readonly body: TBody;
};

function revisionRequestBody(input: RevisionInput): RevisionRequestBody {
  return {
    name: input.name,
    ...(input.notes ? { notes: input.notes } : {}),
    status: input.status ?? "concept"
  };
}

function projectRequestBody(input: Pick<Project, "name" | "description">): ProjectRequestBody {
  return {
    project: { name: input.name, description: input.description, status: "idea" },
    revision: { name: "Initial concept", status: "concept" }
  };
}

function projectCommandId(body: ProjectRequestBody): string {
  // Keep retries tied to the exact atomic project + initial revision command,
  // while allowing a later intentional identical create to receive a fresh key.
  return JSON.stringify(body);
}

function revisionCommandId(projectId: string, body: RevisionRequestBody): string {
  // The command identity is scoped to this adapter instance and the exact
  // project/body pair. It is intentionally not derived from the project
  // alone, so a later revision cannot inherit an earlier key.
  return `${projectId}\u0000${JSON.stringify(body)}`;
}

function exactInventoryCommandId(body: ExactInventoryRequestBody): string {
  // The canonical compound body is the logical command identity. It keeps a
  // retry tied to the exact item/profile pair while allowing a later
  // intentional identical create to receive a fresh idempotency key.
  return JSON.stringify(body);
}

function reconciliationCommandId(projectId: string, revisionId: string, body: ReconciliationDraftRequestBody | ReconciliationCommitRequestBody): string {
  return `${projectId}\u0000${revisionId}\u0000${JSON.stringify(body)}`;
}

function mutationFailureIsAmbiguous(error: unknown): boolean {
  // An offline/server failure can occur after the server committed but before
  // the browser received its response. Keep the key for an explicit retry.
  // Validation/auth/CSRF failures have a known outcome and can release it.
  return !(error instanceof ApiError && ["validation", "forbidden", "unauthenticated", "csrf"].includes(error.kind));
}

async function sha256Hex(file: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new ApiError("This browser cannot verify an artifact upload", { kind: "server", status: 501 });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function serverArtifactRole(role: string): string {
  switch (role) {
    case "Editable CAD": return "cad_source";
    case "STEP": return "step";
    case "STL": return "stl";
    case "Build plate": return "three_mf";
    case "Notes": return "text";
    case "Validation": return "validation";
    default: return "other";
  }
}

function serverItemKind(category: InventoryItem["category"]): string {
  switch (category) {
    case "Printers": return "printer";
    case "Filament": return "filament";
    case "Tools": return "tool";
    case "Electronics": return "electronic";
    case "Fasteners": return "fastener";
    case "Wire & cable": return "wire";
    default: return "accessory";
  }
}

function serverQuantityUnit(unit: InventoryItem["unit"]): string {
  if (unit === "g") return "gram";
  if (unit === "m") return "metre";
  return "each";
}

function reconciliationUnit(unit: string): string {
  if (unit === "gram" || unit === "g") return "g";
  if (unit === "metre" || unit === "m") return "m";
  return unit;
}

function serverReconciliationUnit(unit: string): string {
  if (unit === "g") return "gram";
  if (unit === "m") return "metre";
  return unit;
}

function reconciliationKind(value: string): ReconciliationOutcomeKind | undefined {
  return value === "consumed" || value === "returned" || value === "damaged_lost" || value === "usable_leftover" || value === "converted_asset" || value === "reviewed_no_change" ? value : undefined;
}

function reconciliationEvidenceState(value: string): ReconciliationEvidenceState {
  return value === "physically_counted" || value === "commissioned" || value === "delivered_uncounted" || value === "ordered_unverified" || value === "allocated" || value === "consumed" || value === "unknown" ? value : "unknown";
}

function reconciliationItemKind(value: string): ReconciliationItemKind {
  return value;
}

function reconciliationReservationStatus(value: string): ReconciliationReservationStatus {
  return value === "released" || value === "consumed" || value === "settled" ? value : "active";
}

function reconciliationItemKindForCategory(category: InventoryItem["category"]): ReconciliationItemKind {
  switch (category) {
    case "Printers": return "printer";
    case "Filament": return "filament";
    case "Tools": return "tool";
    case "Accessories": return "accessory";
    case "Electronics": return "electronic";
    case "Fasteners": return "fastener";
    case "Wire & cable": return "wire";
    default: return "other";
  }
}

function normalizeObservedAt(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError("Observed time must be a valid date", { kind: "validation", status: 400 });
  return date.toISOString();
}

function mapReconciliationEvidence(value: ServerReconciliationEvidence): ReconciliationEvidenceViewModel {
  const condition = value.condition === "new" || value.condition === "good" || value.condition === "worn" || value.condition === "needs_repair" || value.condition === "unknown" ? value.condition : undefined;
  return {
    state: reconciliationEvidenceState(value.state),
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.sourceId === undefined ? {} : { sourceId: value.sourceId }),
    ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }),
    ...(value.note === undefined ? {} : { note: value.note }),
    ...(condition === undefined ? {} : { condition }),
    ...(value.uncertainty === undefined ? {} : { uncertainty: value.uncertainty })
  };
}

function mapReconciliationAsset(value: ServerReconciliationConvertedAsset | ServerInventoryItem): ReconciliationOutcomeViewModel["convertedAsset"] {
  return {
    ...(value.name ? { name: value.name } : {}),
    ...(value.kind ? { kind: reconciliationItemKind(value.kind) } : {}),
    ...(typeof value.quantity === "number" ? { quantity: value.quantity } : {}),
    ...(value.unit ? { unit: reconciliationUnit(value.unit) } : {}),
    ...(value.location ? { location: value.location } : {})
  };
}

function mapReconciliationOutcome(value: ServerReconciliationOutcome, id: string): ReconciliationOutcomeViewModel {
  const kind = reconciliationKind(value.kind);
  const convertedAsset = value.convertedAsset === undefined ? undefined : mapReconciliationAsset(value.convertedAsset);
  return {
    id,
    ...(value.reservationId === undefined ? {} : { reservationId: value.reservationId }),
    ...(value.itemId === undefined ? {} : { itemId: value.itemId }),
    ...(kind === undefined ? {} : { kind }),
    quantity: value.quantity,
    unit: reconciliationUnit(value.unit),
    evidence: mapReconciliationEvidence(value.evidence),
    ...(convertedAsset === undefined ? {} : { convertedAsset })
  };
}

function mapReconciliationReservation(value: ServerReconciliationBasisReservation | ServerReservation, inventory: ReadonlyMap<string, InventoryItem>): ReconciliationReservationViewModel {
  const item = inventory.get(value.itemId);
  return {
    id: "reservationId" in value ? value.reservationId : value.id,
    itemId: value.itemId,
    quantity: value.quantity,
    unit: reconciliationUnit(value.unit ?? item?.serverUnit ?? serverQuantityUnit(item?.unit ?? "each")),
    status: reconciliationReservationStatus(value.status),
    version: value.version,
    ...(item ? { itemLabel: item.name } : {})
  };
}

function reconciliationLineFromParts(
  bomLine: { id: string; label: string; required: number; unit: string; itemId?: string },
  reservations: readonly ReconciliationReservationViewModel[],
  outcomes: readonly ReconciliationOutcomeViewModel[],
  version?: number,
  reservedQuantityOverride?: number,
  inventory?: ReadonlyMap<string, InventoryItem>
): ReconciliationLineViewModel {
  const activeReservations = reservations.filter((reservation) => reservation.status === undefined || reservation.status === "active");
  const firstReservation = activeReservations[0];
  const itemId = bomLine.itemId ?? firstReservation?.itemId;
  return {
    id: bomLine.id,
    bomLineId: bomLine.id,
    name: bomLine.label,
    itemLabel: itemId ? reservations.find((reservation) => reservation.itemId === itemId)?.itemLabel ?? inventory?.get(itemId)?.name ?? itemId : "No exact item selected",
    ...(itemId && inventory?.get(itemId) ? { itemKind: reconciliationItemKindForCategory(inventory.get(itemId)!.category) } : {}),
    plannedQuantity: bomLine.required,
    reservedQuantity: reservedQuantityOverride ?? activeReservations.reduce((total, reservation) => total + reservation.quantity, 0),
    unit: reconciliationUnit(bomLine.unit),
    ...(reservations.length ? { reservations } : {}),
    ...(version === undefined ? {} : { version }),
    outcomes
  };
}

function mapReconciliationDraft(value: ServerReconciliationDraft, project: Project, inventory: ReadonlyMap<string, InventoryItem>): ReconciliationViewModel {
  const bomById = new Map(project.bom.map((line) => [line.id, line]));
  const basisById = new Map(value.basis.bomLines.map((line) => [line.bomLineId, line]));
  const previewById = new Map(value.preview.lines.map((line) => [line.bomLineId, line]));
  const submittedById = new Map(value.lines.map((line) => [line.bomLineId, line]));
  const lineIds = [...new Set([...value.basis.bomLines.map((line) => line.bomLineId), ...project.bom.map((line) => line.id)])];
  const lines = lineIds.map((lineId) => {
    const bom = bomById.get(lineId);
    const basis = basisById.get(lineId);
    const submitted = submittedById.get(lineId);
    const preview = previewById.get(lineId);
    const reservations = value.basis.reservations.filter((reservation) => reservation.lineId === lineId).map((reservation) => mapReconciliationReservation(reservation, inventory));
    return reconciliationLineFromParts(
      { id: lineId, label: bom?.label ?? lineId, required: basis?.requiredQuantity ?? bom?.required ?? 0, unit: basis?.unit ?? bom?.unit ?? "each", ...(bom?.itemId ? { itemId: bom.itemId } : {}) },
      reservations,
      submitted?.outcomes.map((outcome, index) => mapReconciliationOutcome(outcome, `${lineId}-outcome-${index + 1}`)) ?? [],
      basis?.version,
      preview?.reservedQuantity,
      inventory
    );
  });
  return {
    projectId: value.projectId,
    projectName: project.name,
    projectRevisionId: value.projectRevisionId,
    status: value.status,
    version: value.version,
    lines,
    preview: mapReconciliationPreview(value.preview, value.basis.hash, value.updatedAt, inventory),
    trace: { draftId: value.id, draftVersion: value.version, basisHash: value.basis.hash, ...(value.auditId ? { auditId: value.auditId } : {}) },
    ...(value.committedAt ? { committedAt: value.committedAt } : {})
  };
}

function mapReconciliationPreview(value: ServerReconciliationPreview, basisHash: string | undefined, generatedAt: string | undefined, inventory: ReadonlyMap<string, InventoryItem>): ReconciliationPreviewViewModel {
  return {
    ...(basisHash === undefined ? {} : { basisHash }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    lines: value.lines.map((line) => ({ ...line, ...(line.unit ? { unit: reconciliationUnit(line.unit) } : {}) })),
    reservationChanges: value.reservationChanges.map((change) => ({ ...change, fromStatus: reconciliationReservationStatus(change.fromStatus), toStatus: reconciliationReservationStatus(change.toStatus), unit: reconciliationUnit(change.unit) })),
    stockChanges: value.stockChanges.map((change) => ({
      ...change,
      kind: change.kind === "loss" || change.kind === "release" ? change.kind : "consume",
      unit: reconciliationUnit(change.unit),
      ...(inventory.get(change.itemId) ? { itemLabel: inventory.get(change.itemId)!.name } : {})
    })),
    createdAssets: value.createdAssets.map((asset) => ({ ...asset, kind: reconciliationItemKind(asset.kind), unit: reconciliationUnit(asset.unit) }))
  };
}

function mapReconciliationCommit(value: ServerReconciliationCommit, project: Project, inventory: ReadonlyMap<string, InventoryItem>, replayed = false): ReconciliationViewModel {
  const preview: ServerReconciliationPreview = {
    lines: value.basis.bomLines.map((line) => {
      const submitted = value.lines.find((candidate) => candidate.bomLineId === line.bomLineId);
      const activeReservations = value.basis.reservations.filter((reservation) => reservation.lineId === line.bomLineId && reservation.status === "active");
      const reservedQuantity = activeReservations.reduce((total, reservation) => total + reservation.quantity, 0);
      const accountedQuantity = submitted?.outcomes.filter((outcome) => outcome.kind !== "reviewed_no_change").reduce((total, outcome) => total + outcome.quantity, 0) ?? 0;
      return { bomLineId: line.bomLineId, reservedQuantity, accountedQuantity, unaccountedQuantity: Math.max(reservedQuantity - accountedQuantity, 0), outcomeCount: submitted?.outcomes.length ?? 0, unit: line.unit };
    }),
    reservationChanges: value.reservationChanges,
    stockChanges: value.stockChanges,
    createdAssets: value.createdAssets.map((asset) => ({ itemId: asset.id, name: asset.name, kind: asset.kind, quantity: asset.quantity, unit: asset.unit }))
  };
  const mapped = mapReconciliationDraft({
    id: value.draftId,
    projectId: value.projectId,
    projectRevisionId: value.projectRevisionId,
    status: "committed",
    version: 1,
    lines: value.lines,
    basis: value.basis,
    preview,
    createdAt: value.committedAt,
    updatedAt: value.committedAt,
    committedAt: value.committedAt,
    commitId: value.id,
    ...(value.auditId ? { auditId: value.auditId } : {})
  }, project, inventory);
  return {
    ...mapped,
    trace: {
      ...mapped.trace,
      draftId: value.draftId,
      basisHash: value.basis.hash,
      deterministicEventIds: value.stockChanges.map((change) => change.eventId),
      ...(value.auditId ? { auditId: value.auditId } : {}),
      replayed
    }
  };
}

function reconciliationEvidenceBody(evidence: ReconciliationEvidenceViewModel): UnknownRecord {
  if (!evidence.state) throw new ApiError("Choose evidence for every reconciliation outcome", { kind: "validation", status: 400 });
  return {
    state: evidence.state,
    ...(evidence.source?.trim() ? { source: evidence.source.trim() } : {}),
    ...(evidence.sourceId?.trim() ? { sourceId: evidence.sourceId.trim() } : {}),
    ...(normalizeObservedAt(evidence.observedAt) ? { observedAt: normalizeObservedAt(evidence.observedAt) } : {}),
    ...(evidence.note?.trim() ? { note: evidence.note.trim() } : {}),
    ...(evidence.condition ? { condition: evidence.condition } : {}),
    ...(evidence.uncertainty === undefined ? {} : { uncertainty: evidence.uncertainty })
  };
}

function reconciliationConvertedAssetBody(asset: NonNullable<ReconciliationOutcomeViewModel["convertedAsset"]>, evidence: ReconciliationEvidenceViewModel, lineUnit: string): UnknownRecord {
  if (!asset.name?.trim() || !asset.kind || asset.quantity === undefined || !Number.isFinite(asset.quantity) || asset.quantity <= 0) {
    throw new ApiError("Give every reusable asset a name, kind, and positive quantity", { kind: "validation", status: 400 });
  }
  return {
    name: asset.name.trim(),
    kind: asset.kind,
    quantity: asset.quantity,
    unit: serverReconciliationUnit(asset.unit ?? lineUnit),
    ...(asset.location?.trim() ? { location: asset.location.trim() } : {}),
    tags: ["reconciliation-asset"],
    links: [],
    evidence: reconciliationEvidenceBody(evidence)
  };
}

function reconciliationDraftBody(model: ReconciliationViewModel, revisionId: string): UnknownRecord {
  return {
    projectRevisionId: revisionId,
    ...(model.trace?.draftId ? { draftId: model.trace.draftId } : {}),
    ...(model.version === undefined ? {} : { expectedVersion: model.version }),
    lines: model.lines.map((line) => ({
      bomLineId: line.bomLineId,
      outcomes: line.outcomes.map((outcome) => ({
        ...(outcome.reservationId ? { reservationId: outcome.reservationId } : {}),
        ...(outcome.itemId ? { itemId: outcome.itemId } : {}),
        kind: outcome.kind,
        quantity: outcome.quantity,
        unit: serverReconciliationUnit(outcome.unit || line.unit),
        evidence: reconciliationEvidenceBody(outcome.evidence),
        ...(outcome.convertedAsset === undefined ? {} : { convertedAsset: reconciliationConvertedAssetBody(outcome.convertedAsset, outcome.evidence, line.unit) })
      }))
    }))
  };
}

function reconciliationCommitBody(model: ReconciliationViewModel): UnknownRecord {
  if (!model.trace?.draftId) throw new ApiError("Save the close-out review before committing it", { kind: "validation", status: 409 });
  return {
    draftId: model.trace.draftId,
    ...(model.version === undefined ? {} : { expectedVersion: model.version })
  };
}

function reconciliationInitialModel(project: Project, reservations: readonly ServerReservation[], inventory: ReadonlyMap<string, InventoryItem>): ReconciliationViewModel {
  const reservationsByLine = new Map<string, ReconciliationReservationViewModel[]>();
  for (const reservation of reservations) {
    const mapped = mapReconciliationReservation(reservation, inventory);
    const current = reservationsByLine.get(reservation.lineId) ?? [];
    reservationsByLine.set(reservation.lineId, [...current, mapped]);
  }
  return {
    projectId: project.id,
    projectName: project.name,
    projectRevisionId: project.serverRevisionId ?? "",
    status: "draft",
    lines: project.bom.map((line) => reconciliationLineFromParts({ id: line.id, label: line.label, required: line.required, unit: line.unit, ...(line.itemId ? { itemId: line.itemId } : {}) }, reservationsByLine.get(line.id) ?? [], [], undefined, undefined, inventory))
  };
}

async function binaryRequest<T>(url: string, body: ArrayBuffer, csrfToken: string): Promise<T> {
  const configuredRoot = apiRoot();
  const target = url.startsWith("http")
    ? url
    : url.startsWith("/api/v1") && configuredRoot.startsWith("http")
      ? new URL(url, configuredRoot).toString()
      : url.startsWith("/api/v1")
        ? url
        : `${configuredRoot}${url.startsWith("/") ? url : `/${url}`}`;
  let response: Response;
  try {
    response = await fetch(target, { method: "PUT", body, credentials: "include", headers: { "Accept": "application/json", "Content-Type": "application/octet-stream", "X-CSRF-Token": csrfToken } });
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "The BenchLedger service could not be reached", { kind: "offline" });
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!response.ok) {
    const envelope = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    const code = envelope && typeof envelope === "object" && "code" in envelope && typeof envelope.code === "string" ? envelope.code : undefined;
    const detail = envelope && typeof envelope === "object" && "message" in envelope && typeof envelope.message === "string" ? envelope.message : `BenchLedger returned HTTP ${response.status}`;
    throw new ApiError(detail, { kind: errorKind(response.status, code), status: response.status, ...(code ? { code } : {}) });
  }
  return payload as T;
}

function syntheticSnapshot(): WorkspaceSnapshot {
  return { inventory: structuredClone(fallbackInventory), projects: structuredClone(fallbackProjects), offers: structuredClone(fallbackOffers), source: "synthetic", fetchedAt: new Date().toISOString() };
}

/** Explicit sample-only adapter. The UI enables it only after the service reports demo mode. */
export function createSampleWorkspaceAdapter(): WorkspaceAdapter {
  const state = syntheticSnapshot();
  const catalogState = structuredClone(fallbackCatalogProducts);
  const buildConfigs = new Map<string, BuildConfigSnapshot>();
  const nextRevision = (project: Project, input: RevisionInput): Project => ({
    ...project,
    currentRevision: input.name,
    railStep: railStepFor(input.status ?? "concept", project.status === "Idea" ? "idea" : "planning"),
    bom: [],
    artifacts: [],
    notes: input.notes ? [input.notes] : [],
    serverRevisionId: `sample-revision-${Date.now()}`
  });
  return {
    async checkHealth() { return { status: "ok", service: "benchledger", version: "sample", demo: true, now: new Date().toISOString() }; },
    async session() { return { authenticated: true, actor: "sample", source: "demo", scopes: ["read", "write"] }; },
    async login() { return { authenticated: true, actor: "sample", csrfToken: "sample", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }; },
    async logout() {},
    async loadWorkspace() { return state; },
    async recordCount(itemId, quantity) {
      const item = state.inventory.find((candidate) => candidate.id === itemId);
      if (!item) throw new ApiError("Inventory item not found", { kind: "validation", status: 404 });
      const observedAt = new Date().toISOString();
      const updated = { ...item, quantity, availableQuantity: quantity, state: "available" as const, evidence: "counted" as const, provenance: { source: "sample physical count", observedAt }, lastCounted: observedAt.slice(0, 10) };
      state.inventory = state.inventory.map((candidate) => candidate.id === itemId ? updated : candidate);
      return updated;
    },
    async updateInventoryItem(itemId, input) {
      const item = state.inventory.find((candidate) => candidate.id === itemId);
      if (!item) throw new ApiError("Inventory item not found", { kind: "validation", status: 404 });
      const updated: InventoryItem = {
        ...item,
        ...input,
        ...(input.model === undefined ? {} : { variant: input.model }),
        tags: input.tags ? [...input.tags] : item.tags,
        version: (item.version ?? 0) + 1
      };
      state.inventory = state.inventory.map((candidate) => candidate.id === itemId ? updated : candidate);
      return updated;
    },
    async createInventoryItem(input) {
      const item: InventoryItem = { id: `sample-item-${Date.now()}`, name: input.name, kind: serverItemKind(input.category), category: input.category, variant: "Variant not recorded", description: "Sample inventory item.", quantity: input.quantity, availableQuantity: 0, unit: input.unit, reserved: 0, state: "inspect-first", evidence: "delivered", provenance: { source: "sample workspace" }, location: "Unassigned", tags: [input.category.toLowerCase()], compatibility: [], accent: mapAccent(input.category), version: 1 };
      state.inventory = [item, ...state.inventory];
      return item;
    },
    async searchCatalogProducts(kind, query = "") {
      const needle = query.trim().toLocaleLowerCase();
      return catalogState.filter((product) => product.kind === kind && (!needle || [product.manufacturer, product.family, product.model, product.variant, product.colour, product.color, product.colourCode, product.colorCode, product.productCode].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle))).map((product) => ({ ...product }));
    },
    async createCatalogProduct(input) {
      const product: CatalogProduct = { ...input, id: `sample-catalog-${Date.now()}`, version: 1, evidence: "user" };
      catalogState.unshift(product);
      return { ...product };
    },
    async createExactInventoryItem(input) {
      const id = `sample-item-${Date.now()}`;
      const item: InventoryItem = {
        id,
        name: catalogProductDisplayName(input.product),
        kind: input.category === "Filament" ? "filament" : "printer",
        category: input.category,
        variant: [input.product.family, input.product.model, input.product.variant].filter(Boolean).join(" · ") || "Exact product",
        description: input.category === "Filament" ? "Exact filament product with a physical spool profile." : "Exact printer product with an owned asset profile.",
        quantity: input.quantity,
        availableQuantity: 0,
        unit: input.category === "Filament" ? "g" : "each",
        reserved: 0,
        state: "inspect-first",
        evidence: "delivered",
        provenance: { source: "sample workspace" },
        location: input.filament?.placement ?? input.printer?.placement ?? "Unassigned",
        ...(input.product.diameterMm === undefined ? {} : { dimensions: { diameter: input.product.diameterMm, unit: "mm" as const } }),
        manufacturer: input.product.manufacturer,
        ...(input.product.productCode ? { sku: input.product.productCode } : {}),
        tags: [input.category.toLowerCase(), "exact-product"],
        compatibility: [],
        accent: mapAccent(input.category),
        version: 1,
        catalogProduct: { ...input.product },
        productProfile: {
          inventoryItemId: id,
          catalogProductId: input.product.id,
          linkState: input.linkState,
          ...(input.filament ? { filament: { ...input.filament } } : {}),
          ...(input.printer ? { printer: { ...input.printer } } : {})
        }
      };
      state.inventory = [item, ...state.inventory];
      return { ...item, ...(item.productProfile ? { productProfile: { ...item.productProfile } } : {}) };
    },
    async createProject(input) {
      const project: Project = { id: `sample-project-${Date.now()}`, name: input.name, description: input.description, subtitle: "A new maker project", status: "Idea", updated: "Just now", currentRevision: "r01", workItem: "First work item", railStep: 0, bom: [], artifacts: [], notes: [], accent: "orange", serverRevisionId: `sample-revision-${Date.now()}` };
      state.projects = [project, ...state.projects];
      return project;
    },
    async createRevision(projectId, input) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new ApiError("Project not found", { kind: "validation", status: 404 });
      const updated = nextRevision(project, input);
      state.projects = state.projects.map((candidate) => candidate.id === projectId ? updated : candidate);
      return updated;
    },
    async createBuildConfigSnapshot(projectId, revisionId, input) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project || project.serverRevisionId !== revisionId) throw new ApiError("Revision not found", { kind: "validation", status: 404 });
      const snapshot: BuildConfigSnapshot = { ...input, id: `sample-build-config-${Date.now()}`, projectId, revisionId, createdAt: new Date().toISOString(), version: 1, contentHash: "sample-build-config-hash", evidence: "sample" };
      buildConfigs.set(`${projectId}:${revisionId}`, snapshot);
      return { ...snapshot, accessories: [...snapshot.accessories], unknowns: [...snapshot.unknowns] };
    },
    async createBomLine(projectId, input) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new ApiError("Project not found", { kind: "validation", status: 404 });
      const line: BomLine = { id: `sample-bom-${Date.now()}`, label: input.name, required: input.requiredQuantity, unit: input.unit, optional: input.optional ?? false, ...(input.itemId ? { itemId: input.itemId } : {}), ...(input.note ? { note: input.note } : {}) };
      const updated = { ...project, bom: [...project.bom, line] };
      state.projects = state.projects.map((candidate) => candidate.id === projectId ? updated : candidate);
      return updated;
    },
    async uploadArtifact(projectId, file, role) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new ApiError("Project not found", { kind: "validation", status: 404 });
      const artifact: Artifact = { id: `sample-artifact-${Date.now()}`, name: file.name, role: role === "STEP" ? "STEP" : role === "STL" ? "STL" : role === "Build plate" ? "Build plate" : role === "Editable CAD" ? "Editable CAD" : role === "Notes" ? "Notes" : "Validation", revision: project.currentRevision, size: formatBytes(file.size), hash: "sample-hash", updated: "Just now", status: "candidate" };
      const updated = { ...project, artifacts: [artifact, ...project.artifacts] };
      state.projects = state.projects.map((candidate) => candidate.id === projectId ? updated : candidate);
      return updated;
    },
    async readReconciliation() {
      throw new ApiError("Close out is available only for a connected server revision. Sample data is synthetic and not reconciled.", { kind: "validation", status: 409 });
    },
    async saveReconciliationDraft() {
      throw new ApiError("Close out is available only for a connected server revision. Sample data is synthetic and not reconciled.", { kind: "validation", status: 409 });
    },
    async commitReconciliation() {
      throw new ApiError("Close out is available only for a connected server revision. Sample data is synthetic and not reconciled.", { kind: "validation", status: 409 });
    }
  };
}

export function createWorkspaceAdapter(): WorkspaceAdapter {
  let csrfToken = cookieValue("forge_csrf");
  let health: ServerHealth | undefined;
  const serverUnits = new Map<string, string>();
  const inventoryCache = new Map<string, InventoryItem>();
  const projectCache = new Map<string, Project>();
  const pendingRevisionCommands = new Map<string, PendingRevisionCommand>();
  const pendingProjectCommands = new Map<string, PendingProjectCommand>();
  const pendingExactInventoryCommands = new Map<string, PendingExactInventoryCommand>();
  const pendingReconciliationDraftCommands = new Map<string, PendingReconciliationCommand<ReconciliationDraftRequestBody>>();
  const pendingReconciliationCommitCommands = new Map<string, PendingReconciliationCommand<ReconciliationCommitRequestBody>>();
  const adapter: WorkspaceAdapter = {
    async checkHealth() { health = await request<ServerHealth>("/health"); return health; },
    async session() { return request<SessionResult>("/auth/session"); },
    async login(password) {
      const result = await request<LoginResult>("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      csrfToken = result.csrfToken || cookieValue("forge_csrf");
      if (!csrfToken) throw new ApiError("The service did not provide a CSRF token", { kind: "csrf", status: 403 });
      return result;
    },
    async logout() {
      await request<{ authenticated: false }>("/auth/logout", { method: "POST", headers: { "Idempotency-Key": idempotencyKey("logout") } }, csrfToken);
      csrfToken = undefined;
    },
    async loadWorkspace() {
      const currentHealth = health ?? await adapter.checkHealth();
      let currentSession: SessionResult;
      try { currentSession = await adapter.session(); }
      catch (error) {
        if (error instanceof ApiError && error.kind === "unauthenticated") {
          throw new ApiError("Sign in to open your private workspace", { kind: "unauthenticated", status: error.status, ...(error.code ? { code: error.code } : {}), ...(error.correlationId ? { correlationId: error.correlationId } : {}), demo: currentHealth.demo });
        }
        throw error;
      }
      if (!csrfToken) csrfToken = cookieValue("forge_csrf");
      const workspace = await request<ServerWorkspace>("/workspace");
      inventoryCache.clear();
      const mappedInventory = workspace.inventory.map((item) => { const mapped = mapInventoryItem(item); serverUnits.set(item.id, item.unit); inventoryCache.set(item.id, mapped); return mapped; });
      const mappedProjects = workspace.projects.map(mapProject);
      projectCache.clear();
      mappedProjects.forEach((project) => projectCache.set(project.id, project));
      return { inventory: mappedInventory, projects: mappedProjects, offers: workspace.offers.map(mapOffer), source: "api", fetchedAt: workspace.fetchedAt || new Date().toISOString(), health: currentHealth };
    },
    async recordCount(itemId, quantity) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Your session needs a fresh CSRF token before changing stock", { kind: "csrf", status: 403 });
      const payload = await request<{ data: { event: unknown; item: ServerInventoryItem } }>(`/inventory/${encodeURIComponent(itemId)}/count`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey("count") }, body: JSON.stringify({ quantity }) }, token);
      const item = payload.data?.item;
      if (!item) throw new ApiError("The service returned an incomplete count", { kind: "server", status: 502 });
      serverUnits.set(item.id, item.unit);
      const mapped = mapInventoryItem(item);
      inventoryCache.set(mapped.id, mapped);
      return mapped;
    },
    async updateInventoryItem(itemId, input, expectedVersion) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Sign in again before you edit inventory", { kind: "csrf", status: 403 });
      const body = {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.manufacturer === undefined ? {} : { manufacturer: input.manufacturer }),
        ...(input.sku === undefined ? {} : { sku: input.sku }),
        ...(input.location === undefined ? {} : { location: input.location }),
        ...(input.tags === undefined ? {} : { tags: [...input.tags] })
      };
      const payload = await request<{ data?: ServerInventoryItem }>(`/inventory/${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        headers: expectedVersion === undefined ? {} : { "If-Match": String(expectedVersion) },
        body: JSON.stringify(body)
      }, token);
      const item = mutationData(payload);
      serverUnits.set(item.id, item.unit);
      const mapped = mapInventoryItem(item);
      inventoryCache.set(mapped.id, mapped);
      return mapped;
    },
    async createInventoryItem(input) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Your session needs a fresh CSRF token before adding inventory", { kind: "csrf", status: 403 });
      const payload = await request<{ data: ServerInventoryItem }>("/inventory", { method: "POST", headers: { "Idempotency-Key": idempotencyKey("inventory") }, body: JSON.stringify({ name: input.name, kind: serverItemKind(input.category), quantity: input.quantity, unit: serverQuantityUnit(input.unit), tags: [input.category.toLowerCase()], links: [], evidence: { state: "unknown", source: "ui" } }) }, token);
      const item = mutationData(payload);
      serverUnits.set(item.id, item.unit);
      const mapped = mapInventoryItem(item);
      inventoryCache.set(mapped.id, mapped);
      return mapped;
    },
    async searchCatalogProducts(kind, query = "") {
      const params = new URLSearchParams({ kind });
      if (query.trim()) params.set("q", query.trim());
      const payload = await request<unknown>(`/catalog/products?${params.toString()}`);
      return responseList(payload).map((product) => mapCatalogProduct(product, kind)).filter((product): product is CatalogProduct => product !== undefined);
    },
    async createCatalogProduct(input) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Your session needs a fresh CSRF token before adding a catalog product", { kind: "csrf", status: 403 });
      const payload = await request<unknown>("/catalog/products", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey("catalog-product") },
        body: JSON.stringify(canonicalCatalogProductBody(input))
      }, token);
      const product = mapCatalogProduct(responseValue(payload), input.kind);
      if (!product) throw new ApiError("The service returned an incomplete catalog product", { kind: "server", status: 502 });
      return product;
    },
    async createExactInventoryItem(input) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Your session needs a fresh CSRF token before adding exact inventory", { kind: "csrf", status: 403 });
      const body = exactInventoryCompoundBody(input);
      const commandId = exactInventoryCommandId(body);
      const pending = pendingExactInventoryCommands.get(commandId);
      const command = pending ?? { key: idempotencyKey("exact-inventory"), body };
      if (pending === undefined) pendingExactInventoryCommands.set(commandId, command);
      try {
        const payload = await request<{ data?: unknown }>("/inventory/with-product-profile", {
          method: "POST",
          headers: { "Idempotency-Key": command.key },
          body: JSON.stringify(command.body)
        }, token);
        const mutation = asRecord(mutationData(payload));
        const item = asRecord(mutation?.item);
        if (!item || typeof item.id !== "string") throw new ApiError("The service returned an incomplete exact inventory item", { kind: "server", status: 502 });
        const mapped = mapInventoryItem(item as ServerInventoryItem);
        serverUnits.set(mapped.id, typeof item.unit === "string" ? item.unit : input.category === "Filament" ? "gram" : "each");
        const profile = mapInventoryProductProfile(mutation?.profile, mapped.id);
        if (!profile) throw new ApiError("The service returned an incomplete exact product profile", { kind: "server", status: 502 });
        if (pendingExactInventoryCommands.get(commandId)?.key === command.key) pendingExactInventoryCommands.delete(commandId);
        const result = { ...mapped, catalogProduct: { ...input.product }, productProfile: profile };
        inventoryCache.set(result.id, result);
        return result;
      } catch (error: unknown) {
        if (!mutationFailureIsAmbiguous(error) && pendingExactInventoryCommands.get(commandId)?.key === command.key) pendingExactInventoryCommands.delete(commandId);
        throw error;
      }
    },
    async createProject(input) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Your session needs a fresh CSRF token before creating a project", { kind: "csrf", status: 403 });
      const body = projectRequestBody(input);
      const commandId = projectCommandId(body);
      const pending = pendingProjectCommands.get(commandId);
      const command = pending ?? { key: idempotencyKey("project"), body };
      if (pending === undefined) pendingProjectCommands.set(commandId, command);
      try {
        const payload = await request<{ data: { project: ServerProject; revision: ServerRevision } }>("/projects/with-initial-revision", {
          method: "POST",
          headers: { "Idempotency-Key": command.key },
          body: JSON.stringify(command.body)
        }, token);
        const created = mutationData(payload);
        const project = mapProject({
          ...created.project,
          currentRevisionId: created.revision.id,
          currentRevision: { ...created.revision, bom: [], artifacts: [] }
        });
        projectCache.set(project.id, project);
        // A successful response resolves this logical command. The next
        // intentional project gets a new key, even if its fields match.
        if (pendingProjectCommands.get(commandId)?.key === command.key) pendingProjectCommands.delete(commandId);
        return project;
      } catch (error: unknown) {
        if (!mutationFailureIsAmbiguous(error) && pendingProjectCommands.get(commandId)?.key === command.key) pendingProjectCommands.delete(commandId);
        throw error;
      }
    },
    async createRevision(projectId, input) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Your session needs a fresh CSRF token before creating a revision", { kind: "csrf", status: 403 });
      // A revision write is durable before the browser can update its cache.
      // Refuse an uncached project before making the request so a stale or
      // partially-loaded UI cannot create a revision that it then hides and
      // retries as a duplicate.
      const current = projectCache.get(projectId);
      if (!current) throw new ApiError("The project is not available in this workspace snapshot", { kind: "validation", status: 409 });
      const body = revisionRequestBody(input);
      const commandId = revisionCommandId(projectId, body);
      const pending = pendingRevisionCommands.get(commandId);
      const command = pending ?? { key: idempotencyKey("revision"), body };
      if (pending === undefined) pendingRevisionCommands.set(commandId, command);
      try {
        const payload = await request<{ data: ServerRevision }>(`/projects/${encodeURIComponent(projectId)}/revisions`, { method: "POST", headers: { "Idempotency-Key": command.key }, body: JSON.stringify(command.body) }, token);
        const revision = mutationData(payload);
        const project = { ...current, currentRevision: `r${String(revision.number).padStart(2, "0")}`, serverRevisionId: revision.id, railStep: railStepFor(revision.status, current.status === "Idea" ? "idea" : "planning"), bom: [], artifacts: [], notes: revision.notes ? [revision.notes] : [] };
        projectCache.set(projectId, project);
        // A successful response resolves this logical command. The next
        // intentional revision receives a new key, even if its fields match.
        if (pendingRevisionCommands.get(commandId)?.key === command.key) pendingRevisionCommands.delete(commandId);
        return project;
      } catch (error: unknown) {
        if (!mutationFailureIsAmbiguous(error) && pendingRevisionCommands.get(commandId)?.key === command.key) pendingRevisionCommands.delete(commandId);
        throw error;
      }
    },
    async readReconciliation(projectId, revisionId) {
      const current = projectCache.get(projectId);
      if (!current || current.serverRevisionId !== revisionId) throw new ApiError("Create or reload the project revision before opening close-out", { kind: "validation", status: 409 });
      const payload = await request<unknown>(`/project-revisions/${encodeURIComponent(revisionId)}/reconciliation`);
      const raw = responseValue<ServerReconciliationDraft | null>(payload);
      if (raw === null) {
        const reservationsPayload = await request<unknown>(`/project-revisions/${encodeURIComponent(revisionId)}/reservations`);
        const reservations = responseList(reservationsPayload).filter((entry): entry is ServerReservation => {
          const record = asRecord(entry);
          return record !== undefined && typeof record.id === "string" && typeof record.lineId === "string" && typeof record.itemId === "string" && typeof record.quantity === "number" && typeof record.status === "string" && typeof record.version === "number";
        });
        return reconciliationInitialModel(current, reservations, inventoryCache);
      }
      const rawRecord = asRecord(raw);
      if (!rawRecord || !rawRecord.basis || !rawRecord.preview) throw new ApiError("The service returned an incomplete reconciliation draft", { kind: "server", status: 502 });
      return mapReconciliationDraft(raw as ServerReconciliationDraft, current, inventoryCache);
    },
    async saveReconciliationDraft(projectId, revisionId, model) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Your session needs a fresh CSRF token before saving close-out", { kind: "csrf", status: 403 });
      const current = projectCache.get(projectId);
      if (!current || current.serverRevisionId !== revisionId) throw new ApiError("Create or reload the project revision before saving close-out", { kind: "validation", status: 409 });
      const body = reconciliationDraftBody(model, revisionId) as ReconciliationDraftRequestBody;
      const commandId = reconciliationCommandId(projectId, revisionId, body);
      const pending = pendingReconciliationDraftCommands.get(commandId);
      const command = pending ?? { key: idempotencyKey("reconciliation-draft"), body };
      if (pending === undefined) pendingReconciliationDraftCommands.set(commandId, command);
      try {
        const payload = await request<{ data?: unknown; replayed?: boolean }>(`/project-revisions/${encodeURIComponent(revisionId)}/reconciliation`, {
          method: "PUT",
          headers: { "Idempotency-Key": command.key },
          body: JSON.stringify(command.body)
        }, token);
        const raw = asRecord(mutationData(payload));
        if (!raw || !raw.basis || !raw.preview) throw new ApiError("The service returned an incomplete reconciliation draft", { kind: "server", status: 502 });
        const mapped = mapReconciliationDraft(raw as unknown as ServerReconciliationDraft, current, inventoryCache);
        const result = payload.replayed === undefined ? mapped : { ...mapped, trace: { ...mapped.trace, replayed: payload.replayed } };
        if (pendingReconciliationDraftCommands.get(commandId)?.key === command.key) pendingReconciliationDraftCommands.delete(commandId);
        return result;
      } catch (error: unknown) {
        if (!mutationFailureIsAmbiguous(error) && pendingReconciliationDraftCommands.get(commandId)?.key === command.key) pendingReconciliationDraftCommands.delete(commandId);
        throw error;
      }
    },
    async commitReconciliation(projectId, revisionId, model) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Your session needs a fresh CSRF token before committing close-out", { kind: "csrf", status: 403 });
      const current = projectCache.get(projectId);
      if (!current || current.serverRevisionId !== revisionId) throw new ApiError("Create or reload the project revision before committing close-out", { kind: "validation", status: 409 });
      const body = reconciliationCommitBody(model) as ReconciliationCommitRequestBody;
      const commandId = reconciliationCommandId(projectId, revisionId, body);
      const pending = pendingReconciliationCommitCommands.get(commandId);
      const command = pending ?? { key: idempotencyKey("reconciliation-commit"), body };
      if (pending === undefined) pendingReconciliationCommitCommands.set(commandId, command);
      try {
        const payload = await request<{ data?: unknown; replayed?: boolean }>(`/project-revisions/${encodeURIComponent(revisionId)}/reconciliation/commit`, {
          method: "POST",
          headers: { "Idempotency-Key": command.key },
          body: JSON.stringify(command.body)
        }, token);
        const raw = asRecord(mutationData(payload));
        if (!raw || !raw.basis || !Array.isArray(raw.stockChanges) || !Array.isArray(raw.reservationChanges)) throw new ApiError("The service returned an incomplete reconciliation commit", { kind: "server", status: 502 });
        const result = mapReconciliationCommit(raw as unknown as ServerReconciliationCommit, current, inventoryCache, payload.replayed === true);
        if (pendingReconciliationCommitCommands.get(commandId)?.key === command.key) pendingReconciliationCommitCommands.delete(commandId);
        return result;
      } catch (error: unknown) {
        if (!mutationFailureIsAmbiguous(error) && pendingReconciliationCommitCommands.get(commandId)?.key === command.key) pendingReconciliationCommitCommands.delete(commandId);
        throw error;
      }
    },
    async createBuildConfigSnapshot(projectId, revisionId, input) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Your session needs a fresh CSRF token before saving build setup", { kind: "csrf", status: 403 });
      const current = projectCache.get(projectId);
      if (!current || current.serverRevisionId !== revisionId) throw new ApiError("Create or reload the project revision before saving build setup", { kind: "validation", status: 409 });
      const payload = await request<unknown>(`/project-revisions/${encodeURIComponent(revisionId)}/build-configurations`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey("build-config") },
        body: JSON.stringify(canonicalBuildConfigurationBody(revisionId, input))
      }, token);
      const snapshot = mapBuildConfigSnapshot(responseValue(payload), projectId, revisionId, input);
      const updated = { ...current, buildConfigSnapshot: snapshot };
      projectCache.set(projectId, updated);
      return snapshot;
    },
    async createBomLine(projectId, input) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Your session needs a fresh CSRF token before adding a requirement", { kind: "csrf", status: 403 });
      const current = projectCache.get(projectId);
      const revisionId = current?.serverRevisionId;
      if (!revisionId) throw new ApiError("Create a project revision before adding a requirement", { kind: "validation", status: 409 });
      const payload = await request<{ data: ServerBomLine }>(`/project-revisions/${encodeURIComponent(revisionId)}/bom`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey("bom") }, body: JSON.stringify({ name: input.name, requiredQuantity: input.requiredQuantity, unit: input.unit === "g" ? "gram" : input.unit === "m" ? "metre" : "each", ...(input.itemId ? { itemId: input.itemId } : {}), optional: input.optional ?? false, constraints: {}, alternatives: [], ...(input.note ? { notes: input.note } : {}) }) }, token);
      const line = mutationData(payload);
      if (!current) throw new ApiError("The project is not available in this workspace snapshot", { kind: "validation", status: 409 });
      const project = { ...current, bom: [...current.bom, mapBomLine(line)] };
      projectCache.set(projectId, project);
      return project;
    },
    async uploadArtifact(projectId, file, role) {
      const token = csrfToken ?? cookieValue("forge_csrf");
      if (!token) throw new ApiError("Your session needs a fresh CSRF token before uploading a file", { kind: "csrf", status: 403 });
      const current = projectCache.get(projectId);
      const revisionId = current?.serverRevisionId;
      if (!revisionId) throw new ApiError("Create a project revision before uploading a file", { kind: "validation", status: 409 });
      const bytes = await file.arrayBuffer();
      const sha256 = await sha256Hex(file);
      const buildConfigurationSnapshotId = current.buildConfigSnapshot
        && (current.buildConfigSnapshot.revisionId === revisionId || current.buildConfigSnapshot.projectRevisionId === revisionId)
        ? current.buildConfigSnapshot.id
        : undefined;
      const beginPayload = await request<{ data: ServerUploadSession }>("/artifacts/uploads", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey("upload-begin") },
        body: JSON.stringify({
          projectId,
          revisionId,
          role: serverArtifactRole(role),
          filename: file.name,
          mediaType: file.type || "application/octet-stream",
          byteSize: file.size,
          sha256,
          source: "web",
          ...(buildConfigurationSnapshotId === undefined ? {} : { buildConfigurationSnapshotId })
        })
      }, token);
      const session = mutationData(beginPayload);
      const uploadUrl = session.uploadUrl.startsWith("http") ? session.uploadUrl : session.uploadUrl.startsWith("/api/v1") ? session.uploadUrl : `${apiRoot()}${session.uploadUrl.startsWith("/") ? session.uploadUrl : `/${session.uploadUrl}`}`;
      await binaryRequest(uploadUrl, bytes, token);
      const finalizePayload = await request<{ data: ServerArtifact }>(`/artifacts/uploads/${encodeURIComponent(session.id)}/finalize`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey("upload-finalize") } }, token);
      const artifact = mutationData(finalizePayload);
      if (!current) throw new ApiError("The project is not available in this workspace snapshot", { kind: "validation", status: 409 });
      const project = { ...current, artifacts: [mapArtifact(artifact, { id: revisionId, projectId, number: Number.parseInt(current.currentRevision.replace(/\D/gu, ""), 10) || 1, name: current.currentRevision, status: "concept", createdAt: new Date().toISOString(), version: 1 }), ...current.artifacts] };
      projectCache.set(projectId, project);
      return project;
    }
  };
  return adapter;
}
