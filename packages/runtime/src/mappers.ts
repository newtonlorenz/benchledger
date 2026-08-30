import type {
  CreateInventoryItem, InventoryItem as ApiInventoryItem, StockEvent as ApiStockEvent,
  StockEventInput, Project as ApiProject, WorkItem as ApiWorkItem, ProjectRevision as ApiProjectRevision,
  WorkItemRevision as ApiWorkItemRevision, BomLine as ApiBomLine,
  Reservation as ApiReservation, Offer as ApiOffer, Artifact as ApiArtifact, UploadSession as ApiUploadSession
} from "@benchledger/api-contract";
import { createStockEvent } from "@benchledger/domain";
import type {
  AuditActor, BomConstraints, BomLine, Dimensions, InventoryItem, InventoryProvenance,
  OfferSnapshot, Project, ProjectRevision, Reservation, StockEvent, StockConfidence,
  Supplier, WorkItem, WorkItemRevision, QuantityUnit, RevisionStatus
} from "@benchledger/domain";
import type { ArtifactRevision, UploadSession as StoreUploadSession } from "@benchledger/artifacts";
import type { RequestContext } from "@benchledger/application";

const API_KINDS = new Set<ApiInventoryItem["kind"]>([
  "printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"
]);
const EVIDENCE_STATES = new Set<ApiInventoryItem["evidence"]["state"]>([
  "physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"
]);

export interface InventoryApiMetadata {
  readonly kind?: ApiInventoryItem["kind"];
  readonly description?: string;
  readonly sku?: string;
  readonly location?: string;
  readonly condition?: NonNullable<ApiInventoryItem["condition"]>;
  readonly tags?: readonly string[];
  readonly links?: readonly ApiInventoryItem["links"][number][];
  readonly evidence?: ApiInventoryItem["evidence"];
}

export interface BomApiMetadata {
  readonly constraints?: Readonly<Record<string, string>>;
  readonly alternatives?: readonly ApiBomLine["alternatives"][number][];
  readonly retired?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface OfferApiMetadata {
  readonly supplier?: string;
  readonly name?: string;
  readonly shippingMinor?: number;
  readonly staleAfterDays?: number;
}

export interface ArtifactApiMetadata {
  readonly author?: string;
  readonly machineBinding?: Readonly<Record<string, string>>;
  readonly retired?: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function apiKind(value: unknown): ApiInventoryItem["kind"] | undefined {
  return typeof value === "string" && API_KINDS.has(value as ApiInventoryItem["kind"]) ? value as ApiInventoryItem["kind"] : undefined;
}

function evidenceState(value: unknown): ApiInventoryItem["evidence"]["state"] | undefined {
  return typeof value === "string" && EVIDENCE_STATES.has(value as ApiInventoryItem["evidence"]["state"])
    ? value as ApiInventoryItem["evidence"]["state"]
    : undefined;
}

function parseLinks(value: unknown): readonly ApiInventoryItem["links"][number][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const links: ApiInventoryItem["links"][number][] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.supplier !== "string" || typeof candidate.url !== "string") return undefined;
    const link: ApiInventoryItem["links"][number] = {
      supplier: candidate.supplier,
      url: candidate.url,
      ...(stringValue(candidate.label) === undefined ? {} : { label: stringValue(candidate.label) }),
      ...(numberValue(candidate.currentPriceMinor) === undefined ? {} : { currentPriceMinor: numberValue(candidate.currentPriceMinor) }),
      ...(stringValue(candidate.currency) === undefined ? {} : { currency: stringValue(candidate.currency) }),
      ...(stringValue(candidate.observedAt) === undefined ? {} : { observedAt: stringValue(candidate.observedAt) }),
      ...(numberValue(candidate.packageQuantity) === undefined ? {} : { packageQuantity: numberValue(candidate.packageQuantity) })
    };
    links.push(link);
  }
  return links;
}

export function readInventoryMetadata(source: InventoryProvenance | undefined): InventoryApiMetadata {
  const raw = source?.benchLedger;
  if (!isRecord(raw)) return {};
  const tags = Array.isArray(raw.tags) && raw.tags.every((tag): tag is string => typeof tag === "string") ? raw.tags : undefined;
  const links = parseLinks(raw.links);
  const kind = apiKind(raw.kind);
  const description = stringValue(raw.description);
  const sku = stringValue(raw.sku);
  const location = stringValue(raw.location);
  const condition = stringValue(raw.condition);
  const rawEvidenceState = isRecord(raw.evidence) ? evidenceState(raw.evidence.state) : undefined;
  const evidence = isRecord(raw.evidence) && rawEvidenceState !== undefined
    ? {
      state: rawEvidenceState,
      ...(stringValue(raw.evidence.source) === undefined ? {} : { source: stringValue(raw.evidence.source) }),
      ...(stringValue(raw.evidence.sourceId) === undefined ? {} : { sourceId: stringValue(raw.evidence.sourceId) }),
      ...(stringValue(raw.evidence.observedAt) === undefined ? {} : { observedAt: stringValue(raw.evidence.observedAt) }),
      ...(stringValue(raw.evidence.note) === undefined ? {} : { note: stringValue(raw.evidence.note) })
    }
    : undefined;
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(description === undefined ? {} : { description }),
    ...(sku === undefined ? {} : { sku }),
    ...(location === undefined ? {} : { location }),
    ...(["new", "good", "worn", "needs_repair", "unknown"].includes(condition ?? "") ? { condition: condition as NonNullable<ApiInventoryItem["condition"]> } : {}),
    ...(tags === undefined ? {} : { tags }),
    ...(links === undefined ? {} : { links }),
    ...(evidence === undefined ? {} : { evidence })
  };
}

function mapCategoryToKind(category: InventoryItem["category"]): ApiInventoryItem["kind"] {
  switch (category) {
    case "printer": return "printer";
    case "tool": return "tool";
    case "printer_accessory":
    case "printer_part":
    case "workshop": return "accessory";
    case "filament": return "filament";
    case "fastener": return "fastener";
    case "adhesive": return "adhesive";
    case "electronics": return "electronic";
    case "electrical": return "wire";
    case "consumable":
    case "finish": return "consumable";
    default: return "other";
  }
}

export function mapApiKindToCategory(kind: ApiInventoryItem["kind"]): InventoryItem["category"] {
  switch (kind) {
    case "printer": return "printer";
    case "tool": return "tool";
    case "accessory": return "printer_accessory";
    case "consumable": return "consumable";
    case "electronic": return "electronics";
    case "fastener": return "fastener";
    case "filament": return "filament";
    case "wire": return "electrical";
    case "adhesive": return "adhesive";
    case "other": return "other";
  }
}

function mapNativeUnitToApi(unit: QuantityUnit): ApiInventoryItem["unit"] {
  switch (unit) {
    case "gram": return "gram";
    case "millimetre": return "millimetre";
    case "millilitre": return "millilitre";
    case "meter": return "metre";
    case "metre": return "metre";
    case "set": return "set";
    default: return "each";
  }
}

export function mapApiUnitToDomain(unit: ApiInventoryItem["unit"]): QuantityUnit {
  switch (unit) {
    case "gram": return "gram";
    case "millimetre": return "millimetre";
    case "millilitre": return "millilitre";
    case "metre": return "meter";
    case "set": return "set";
    case "each": return "piece";
  }
}

function toMm(value: number, unit: Dimensions["unit"]): number {
  if (unit === "cm") return value * 10;
  if (unit === "m") return value * 1_000;
  return value;
}

function fromMm(value: number, unit: Dimensions["unit"]): number {
  if (unit === "cm") return value / 10;
  if (unit === "m") return value / 1_000;
  return value;
}

export function mapApiDimensionsToDomain(value: NonNullable<ApiInventoryItem["dimensions"]>): Dimensions {
  return {
    // The API calls the front-to-back axis length; the domain calls that axis depth.
    ...(value.lengthMm === undefined ? {} : { depth: value.lengthMm }),
    ...(value.widthMm === undefined ? {} : { width: value.widthMm }),
    ...(value.heightMm === undefined ? {} : { height: value.heightMm }),
    ...(value.diameterMm === undefined ? {} : { diameter: value.diameterMm }),
    unit: "mm",
    kind: value.measured ? "measured" : "nominal",
    ...(value.uncertaintyMm === undefined ? {} : { uncertainty: value.uncertaintyMm }),
    ...(value.note === undefined ? {} : { source: value.note })
  };
}

export function mapDomainDimensionsToApi(value: Dimensions | undefined): ApiInventoryItem["dimensions"] {
  if (value === undefined) return undefined;
  const unit: Dimensions["unit"] = "mm";
  return {
    ...(value.depth === undefined ? {} : { lengthMm: fromMm(toMm(value.depth, value.unit), unit) }),
    ...(value.width === undefined ? {} : { widthMm: fromMm(toMm(value.width, value.unit), unit) }),
    ...(value.height === undefined ? {} : { heightMm: fromMm(toMm(value.height, value.unit), unit) }),
    ...(value.diameter === undefined ? {} : { diameterMm: fromMm(toMm(value.diameter, value.unit), unit) }),
    measured: value.kind === "measured",
    ...(value.uncertainty === undefined ? {} : { uncertaintyMm: fromMm(toMm(value.uncertainty, value.unit), unit) }),
    ...(value.source === undefined ? {} : { note: value.source })
  };
}

function nativeEvidence(state: ApiInventoryItem["evidence"]["state"]): Pick<InventoryItem, "sourceStatus" | "reusePolicy" | "confidence"> {
  switch (state) {
    case "physically_counted": return { sourceStatus: "physically_confirmed", reusePolicy: "available", confidence: "confirmed" };
    case "commissioned": return { sourceStatus: "commissioned_available", reusePolicy: "available", confidence: "confirmed" };
    case "delivered_uncounted": return { sourceStatus: "delivered_uncounted", reusePolicy: "inspect_first", confidence: "inspect_first" };
    case "ordered_unverified": return { sourceStatus: "ordered_unverified", reusePolicy: "inspect_first", confidence: "ordered" };
    case "allocated": return { sourceStatus: "physically_confirmed", reusePolicy: "inspect_first", confidence: "confirmed" };
    case "consumed": return { sourceStatus: "physically_confirmed", reusePolicy: "inspect_first", confidence: "confirmed" };
    case "unknown": return { sourceStatus: "unknown", reusePolicy: "inspect_first", confidence: "unknown" };
  }
}

function fallbackEvidence(item: InventoryItem): ApiInventoryItem["evidence"]["state"] {
  switch (item.sourceStatus) {
    case "commissioned_available": return "commissioned";
    case "physically_confirmed": return "physically_counted";
    case "delivered_uncounted":
    case "shipped_available_baseline": return "delivered_uncounted";
    case "ordered_unverified": return "ordered_unverified";
    default: return "unknown";
  }
}

export function isConfirmedEvidence(state: ApiInventoryItem["evidence"]["state"]): boolean {
  return state === "physically_counted" || state === "commissioned";
}

export function nativeItemFromApi(input: CreateInventoryItem, id: string, now: string, existing?: InventoryItem): InventoryItem {
  const evidence = nativeEvidence(input.evidence.state);
  const metadata: InventoryApiMetadata = {
    kind: input.kind,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.sku === undefined ? {} : { sku: input.sku }),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.condition === undefined ? {} : { condition: input.condition }),
    tags: input.tags.slice(),
    links: input.links.slice(),
    evidence: input.evidence
  };
  return {
    id,
    name: input.name.trim(),
    category: mapApiKindToCategory(input.kind),
    ...(input.model === undefined ? {} : { model: input.model }),
    purchasedQuantity: input.quantity,
    unit: mapApiUnitToDomain(input.unit),
    ...evidence,
    reportedQuantity: input.quantity,
    ...(input.manufacturer === undefined ? {} : { manufacturer: input.manufacturer }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.dimensions === undefined ? {} : { dimensions: mapApiDimensionsToDomain(input.dimensions) }),
    source: { ...(existing?.source ?? {}), benchLedger: metadata },
    ...(input.description === undefined ? {} : { notes: input.description }),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.retiredAt === undefined ? {} : { retiredAt: existing.retiredAt })
  };
}

export function apiInventoryFromNative(item: InventoryItem, balance: { readonly onHand: number; readonly available: number }, version: number): ApiInventoryItem {
  const metadata = readInventoryMetadata(item.source);
  const state = metadata.evidence?.state ?? fallbackEvidence(item);
  const quantity = isConfirmedEvidence(state) ? balance.onHand : (item.reportedQuantity ?? item.purchasedQuantity);
  const availableQuantity = isConfirmedEvidence(state) ? Math.max(0, balance.available) : 0;
  const evidence = metadata.evidence ?? { state };
  return {
    id: item.id,
    name: item.name,
    kind: metadata.kind ?? mapCategoryToKind(item.category),
    ...(metadata.description === undefined && item.notes === undefined ? {} : { description: metadata.description ?? item.notes }),
    ...(item.manufacturer === undefined ? {} : { manufacturer: item.manufacturer }),
    ...(item.model === undefined ? {} : { model: item.model }),
    ...(metadata.sku === undefined ? {} : { sku: metadata.sku }),
    quantity,
    availableQuantity,
    unit: mapNativeUnitToApi(item.unit),
    ...(metadata.location === undefined ? {} : { location: metadata.location }),
    ...(metadata.condition === undefined ? {} : { condition: metadata.condition }),
    ...(mapDomainDimensionsToApi(item.dimensions) === undefined ? {} : { dimensions: mapDomainDimensionsToApi(item.dimensions) }),
    tags: metadata.tags?.slice() ?? [],
    links: metadata.links?.slice() ?? [],
    evidence,
    ...(item.retiredAt === undefined ? {} : { retiredAt: item.retiredAt }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    version
  };
}

function actorForContext(ctx: RequestContext): AuditActor {
  const type: AuditActor["type"] = ctx.source === "mcp" ? "agent" : ctx.source === "import" ? "import" : ctx.source === "system" ? "system" : "human";
  return { type, id: ctx.actor };
}

function stockKind(input: StockEventInput): StockEvent["kind"] {
  switch (input.type) {
    case "receipt": return "receipt";
    case "count": return "count";
    case "correction": return "adjustment";
    case "allocate": return "allocate";
    case "release": return "release";
    case "consume": return "consume";
    case "return": return "return";
    case "loss":
    case "dispose": return "loss";
  }
}

function stockType(kind: StockEvent["kind"]): ApiStockEvent["type"] {
  switch (kind) {
    case "receipt": return "receipt";
    case "count": return "count";
    case "adjustment": return "correction";
    case "allocate": return "allocate";
    case "release": return "release";
    case "consume": return "consume";
    case "return": return "return";
    case "loss": return "loss";
    case "evidence": return "correction";
  }
}

export function nativeStockEventFromApi(input: StockEventInput, ctx: RequestContext, itemUnit: QuantityUnit, itemVersion: number): StockEvent {
  const evidence: Record<string, unknown> = {
    apiItemVersion: itemVersion,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.note === undefined ? {} : { note: input.note })
  };
  return createStockEvent({
    itemId: input.itemId,
    kind: stockKind(input),
    quantity: input.quantity,
    unit: itemUnit,
    reason: input.note ?? `${input.type} via ${ctx.source}`,
    actor: actorForContext(ctx),
    source: ctx.source,
    evidence,
    correlationId: input.correlationId ?? ctx.correlationId,
    ...(input.idempotencyKey ?? ctx.idempotencyKey ? { idempotencyKey: input.idempotencyKey ?? ctx.idempotencyKey } : {})
  });
}

export function apiStockEventFromNative(event: StockEvent, fallbackVersion: number): ApiStockEvent {
  const version = typeof event.evidence?.apiItemVersion === "number" && Number.isInteger(event.evidence.apiItemVersion) ? event.evidence.apiItemVersion : fallbackVersion;
  const visibleEvidence = event.evidence === undefined ? undefined : Object.fromEntries(Object.entries(event.evidence).filter(([key]) => key !== "apiItemVersion" && key !== "bootstrap"));
  const source: ApiStockEvent["source"] = event.source === "mcp" || event.source === "ui" || event.source === "import" ? event.source : "api";
  return {
    id: event.id,
    itemId: event.itemId,
    type: stockType(event.kind),
    quantity: event.quantity,
    unit: mapNativeUnitToApi(event.unit),
    ...(stringValue(event.evidence?.projectId) === undefined ? {} : { projectId: stringValue(event.evidence?.projectId) }),
    ...(stringValue(event.evidence?.note) === undefined ? {} : { note: stringValue(event.evidence?.note) }),
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    ...(event.idempotencyKey === undefined ? {} : { idempotencyKey: event.idempotencyKey }),
    actor: event.actor?.id ?? "system",
    source,
    ...(visibleEvidence !== undefined && Object.keys(visibleEvidence).length > 0 ? { evidence: visibleEvidence } : {}),
    createdAt: event.createdAt,
    itemVersion: version
  };
}

function apiProjectStatus(status: Project["status"], metadata: Readonly<Record<string, unknown>>): ApiProject["status"] {
  const stored = stringValue(metadata.status);
  if (stored === "idea" || stored === "planning" || stored === "in_progress" || stored === "validation" || stored === "complete" || stored === "retired") return stored;
  return status === "complete" ? "complete" : status === "retired" ? "retired" : "in_progress";
}

export function nativeProjectStatus(status: ApiProject["status"]): Project["status"] {
  switch (status) {
    case "complete": return "complete";
    case "retired": return "retired";
    case "idea":
    case "planning":
    case "in_progress":
    case "validation": return "active";
  }
}

export function apiProjectFromNative(project: Project, version: number, metadata: Readonly<Record<string, unknown>>, currentRevisionId: string | undefined): ApiProject {
  return {
    id: project.id,
    name: project.name,
    ...(project.description === undefined ? {} : { description: project.description }),
    status: apiProjectStatus(project.status, metadata),
    ...(currentRevisionId === undefined ? {} : { currentRevisionId }),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    version
  };
}

export function apiWorkItemFromNative(item: WorkItem, version: number, currentRevisionId: string | undefined): ApiWorkItem {
  return {
    id: item.id,
    projectId: item.projectId,
    name: item.name,
    kind: item.kind,
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(currentRevisionId === undefined ? {} : { currentRevisionId }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    version
  };
}

function revisionStatus(status: RevisionStatus): ApiProjectRevision["status"] {
  return status;
}

export function apiProjectRevisionFromNative(revision: ProjectRevision, version: number): ApiProjectRevision {
  return { id: revision.id, projectId: revision.projectId, number: revision.number, name: revision.label, ...(revision.notes === undefined ? {} : { notes: revision.notes }), status: revisionStatus(revision.status), createdAt: revision.createdAt, version };
}

export function apiWorkItemRevisionFromNative(revision: WorkItemRevision, projectId: string, version: number): ApiWorkItemRevision {
  return { id: revision.id, projectId, workItemId: revision.workItemId, number: revision.number, name: revision.label, ...(revision.sourcePath === undefined ? {} : { notes: revision.sourcePath }), status: revision.status, createdAt: revision.createdAt, version };
}

export function apiBomLineFromNative(line: BomLine, metadata: BomApiMetadata, version: number): ApiBomLine {
  const alternatives = metadata.alternatives?.slice() ?? (line.alternativeItemIds ?? []).map((itemId) => ({ itemId, compatible: "conditional" as const }));
  return {
    id: line.id,
    revisionId: line.revisionId,
    name: line.name,
    ...(line.itemId === undefined ? {} : { itemId: line.itemId }),
    requiredQuantity: line.quantity,
    unit: mapNativeUnitToApi(line.unit),
    optional: line.optional === true || line.required === false,
    constraints: metadata.constraints ?? {},
    alternatives,
    ...(line.notes === undefined ? {} : { notes: line.notes }),
    createdAt: metadata.createdAt ?? "1970-01-01T00:00:00.000Z",
    updatedAt: metadata.updatedAt ?? metadata.createdAt ?? "1970-01-01T00:00:00.000Z",
    version
  };
}

export function nativeConstraintsFromApi(constraints: Readonly<Record<string, string | undefined>>): BomConstraints {
  const result: BomConstraints = {};
  const category = constraints.kind;
  if (category !== undefined && ["printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"].includes(category)) {
    result.category = mapApiKindToCategory(category as ApiInventoryItem["kind"]);
  }
  if (constraints.manufacturer !== undefined) result.manufacturer = constraints.manufacturer;
  if (constraints.model !== undefined) result.model = constraints.model;
  if (constraints.variantIncludes !== undefined) result.variantIncludes = constraints.variantIncludes;
  if (constraints.machineId !== undefined) result.machineId = constraints.machineId;
  if (constraints.tag !== undefined) result.tags = [constraints.tag];
  return result;
}

export function apiReservationFromNative(reservation: Reservation, version: number): ApiReservation {
  return { id: reservation.id, lineId: reservation.bomLineId, itemId: reservation.itemId, quantity: reservation.quantity, status: reservation.status, createdAt: reservation.createdAt, updatedAt: reservation.releasedAt ?? reservation.createdAt, version };
}

export function apiOfferFromNative(offer: OfferSnapshot, supplier: Supplier | undefined, metadata: OfferApiMetadata, version: number): ApiOffer {
  return {
    id: offer.id,
    ...(offer.itemId === undefined ? {} : { itemId: offer.itemId }),
    name: metadata.name ?? offer.title ?? "Offer",
    supplier: metadata.supplier ?? supplier?.name ?? offer.supplierId,
    url: offer.url,
    priceMinor: offer.priceMinor,
    currency: offer.currency,
    ...(offer.packageQuantity === undefined ? {} : { packageQuantity: offer.packageQuantity }),
    ...(metadata.shippingMinor === undefined ? {} : { shippingMinor: metadata.shippingMinor }),
    observedAt: offer.observedAt,
    staleAfterDays: metadata.staleAfterDays ?? 30,
    ...(offer.notes === undefined ? {} : { notes: offer.notes }),
    version
  };
}

export function apiArtifactFromStore(artifact: ArtifactRevision, metadata: ArtifactApiMetadata, version: number, retired = false): ApiArtifact {
  const role: ApiArtifact["role"] = artifact.role === "source" || artifact.role === "cad" || artifact.role === "document" || artifact.role === "brief" || artifact.role === "design_record" || artifact.role === "cad_source" || artifact.role === "step" || artifact.role === "stl" || artifact.role === "three_mf" || artifact.role === "slicer_project" || artifact.role === "gcode" || artifact.role === "firmware" || artifact.role === "drawing" || artifact.role === "validation" || artifact.role === "photo" || artifact.role === "text" || artifact.role === "other" ? artifact.role : "other";
  return {
    id: artifact.artifactId,
    projectId: artifact.projectId,
    ...(artifact.workItemId === undefined ? {} : { workItemId: artifact.workItemId }),
    ...(artifact.revisionId === undefined ? {} : { revisionId: artifact.revisionId }),
    role,
    filename: artifact.filename,
    mediaType: artifact.mediaType ?? "application/octet-stream",
    byteSize: artifact.bytes,
    sha256: artifact.sha256,
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    ...(artifact.source === undefined ? {} : { source: artifact.source }),
    ...(metadata.machineBinding === undefined ? {} : { machineBinding: metadata.machineBinding }),
    currentCandidate: !retired,
    retired,
    createdAt: artifact.createdAt,
    version
  };
}

export function apiUploadSessionFromStore(session: StoreUploadSession, maxBytes: number): ApiUploadSession {
  return {
    id: session.sessionId,
    artifactId: session.artifactId,
    expiresAt: session.expiresAt,
    maxBytes,
    uploadUrl: `/api/v1/artifacts/uploads/${session.sessionId}`,
    status: session.status === "finalized" ? "finalized" : session.status === "expired" || session.status === "aborted" ? "expired" : "pending"
  };
}
