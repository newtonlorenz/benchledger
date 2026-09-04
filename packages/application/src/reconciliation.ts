import { createHash } from "node:crypto";
import type {
  BomLine,
  InventoryItem,
  ReconciliationBasis,
  ReconciliationDraft,
  ReconciliationLine,
  ReconciliationPreview,
  ReconciliationPreviewStockChange,
  ReconciliationOutcome
} from "@benchledger/api-contract";
import { isUnitCompatibleWithItemKind, unitCorrectionReason } from "@benchledger/api-contract";
import { ApplicationError } from "./errors.js";

export interface ReconciliationSourceSnapshot {
  readonly projectId: string;
  readonly projectRevisionId: string;
  readonly lines: readonly BomLine[];
  readonly reservations: readonly ReconciliationReservationSource[];
  readonly items: readonly InventoryItem[];
}

export interface ReconciliationReservationSource {
  readonly id: string;
  readonly lineId: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly status: "active" | "released" | "consumed" | "settled";
  readonly unit: InventoryItem["unit"];
  readonly version: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new ApplicationError("validation", `${label} must be greater than zero`);
}

function nonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new ApplicationError("validation", `${label} must be zero or greater`);
}

function assertReconciliationRole(line: Pick<BomLine, "id" | "role">, kind: ReconciliationOutcome["kind"]): void {
  const destructive = kind === "consumed" || kind === "damaged_lost" || kind === "converted_asset";
  if (!destructive) return;
  if (line.role === undefined || line.role === null) {
    throw new ApplicationError("validation", `BOM line '${line.id}' has no requirement role; review it as consumed or reusable before reconciliation`);
  }
  if (line.role === "reusable") {
    throw new ApplicationError("validation", `Reusable BOM line '${line.id}' cannot be consumed or lost during reconciliation; return the owned item instead`);
  }
}

function itemMap(snapshot: ReconciliationSourceSnapshot): Map<string, InventoryItem> {
  const result = new Map<string, InventoryItem>();
  for (const item of snapshot.items) {
    if (result.has(item.id)) throw new ApplicationError("integrity_error", `Inventory source returned duplicate item ${item.id}`);
    nonNegative(item.quantity, `Inventory item ${item.id} quantity`);
    nonNegative(item.availableQuantity, `Inventory item ${item.id} available quantity`);
    if (item.availableQuantity > item.quantity) throw new ApplicationError("integrity_error", `Inventory item ${item.id} available quantity exceeds on-hand quantity`);
    result.set(item.id, item);
  }
  return result;
}

function reservationMap(snapshot: ReconciliationSourceSnapshot): Map<string, ReconciliationReservationSource> {
  const result = new Map<string, ReconciliationReservationSource>();
  for (const reservation of snapshot.reservations) {
    if (result.has(reservation.id)) throw new ApplicationError("integrity_error", `Reservation source returned duplicate reservation ${reservation.id}`);
    positive(reservation.quantity, `Reservation ${reservation.id} quantity`);
    result.set(reservation.id, reservation);
  }
  return result;
}

function linesMap(snapshot: ReconciliationSourceSnapshot): Map<string, BomLine> {
  const result = new Map<string, BomLine>();
  for (const line of snapshot.lines) {
    if (result.has(line.id)) throw new ApplicationError("integrity_error", `BOM source returned duplicate line ${line.id}`);
    result.set(line.id, line);
  }
  return result;
}

/**
 * A reconciliation line can only have one scalar reservation unit. The
 * quantity fields in its preview are summed without conversion, so a mixed
 * active reservation set is malformed state and must never be presented as a
 * meaningful total.
 */
function activeReservationUnit(
  line: Pick<BomLine, "id" | "unit">,
  reservations: readonly ReconciliationReservationSource[]
): InventoryItem["unit"] {
  const units = new Set(reservations.filter((reservation) => reservation.lineId === line.id && reservation.status === "active").map((reservation) => reservation.unit));
  if (units.size > 1) {
    throw new ApplicationError("integrity_error", `BOM line '${line.id}' has mixed active reservation units: ${[...units].sort((left, right) => left.localeCompare(right)).join(", ")}`);
  }
  return [...units][0] ?? line.unit;
}

/** Assign deterministic IDs to newly converted reusable assets. */
export function normalizeReconciliationLines(revisionId: string, lines: readonly ReconciliationLine[]): readonly ReconciliationLine[] {
  return lines.map((line) => ({
    ...line,
    outcomes: line.outcomes.map((outcome, index) => outcome.convertedAsset === undefined || outcome.convertedAsset.id !== undefined
      ? outcome
      : { ...outcome, convertedAsset: { ...outcome.convertedAsset, id: `reconciliation-asset-${hash(`${revisionId}:${line.bomLineId}:${index}`).slice(0, 32)}` } })
  }));
}

/** Opaque, bounded event key suitable for both SQLite idempotency and the API
 * identifier contract even when user-created IDs are long or contain colons. */
export function reconciliationStockEventKey(revisionId: string, reservationId: string, kind: "release" | "consume" | "loss", outcomeIndex?: number): string {
  return `reconciliation-stock-${hash(`${revisionId}:${reservationId}:${kind}:${outcomeIndex ?? "release"}`).slice(0, 48)}`;
}

function stockChangesFor(
  snapshot: ReconciliationSourceSnapshot,
  normalizedLines: readonly ReconciliationLine[],
  reservations: Map<string, ReconciliationReservationSource>,
  items: Map<string, InventoryItem>,
  requireComplete: boolean
): { readonly reservationChanges: ReconciliationPreview["reservationChanges"]; readonly stockChanges: readonly ReconciliationPreviewStockChange[]; readonly createdAssets: ReconciliationPreview["createdAssets"] } {
  const accounted = new Map<string, number>();
  const outcomes: Array<{ readonly outcome: ReconciliationOutcome; readonly reservation: ReconciliationReservationSource; readonly lineId: string; readonly index: number }> = [];
  const createdAssets: ReconciliationPreview["createdAssets"] = [];
  for (const line of normalizedLines) {
    const activeReservedQuantity = [...reservations.values()]
      .filter((reservation) => reservation.lineId === line.bomLineId && reservation.status === "active")
      .reduce((sum, reservation) => sum + reservation.quantity, 0);
    const hasReviewedNoChange = line.outcomes.some((outcome) => outcome.kind === "reviewed_no_change");
    if (hasReviewedNoChange && (line.outcomes.length !== 1 || activeReservedQuantity > 0)) {
      throw new ApplicationError("validation", "reviewed_no_change must be the sole outcome for a BOM line with zero active reserved quantity");
    }
    for (const [index, outcome] of line.outcomes.entries()) {
      if (outcome.kind === "reviewed_no_change") {
        if (outcome.quantity !== 0 || outcome.reservationId !== undefined || outcome.itemId !== undefined || outcome.convertedAsset !== undefined) {
          throw new ApplicationError("validation", "reviewed_no_change must have zero quantity and no reservation, item, or asset");
        }
        const lineRecord = snapshot.lines.find((candidate) => candidate.id === line.bomLineId);
        if (lineRecord !== undefined && outcome.unit !== lineRecord.unit) throw new ApplicationError("validation", `BOM line '${line.bomLineId}' uses ${lineRecord.unit}, outcome uses ${outcome.unit}`);
        continue;
      }
      if (outcome.reservationId === undefined) throw new ApplicationError("validation", `${outcome.kind} requires a reservation`);
      const sourceLine = snapshot.lines.find((candidate) => candidate.id === line.bomLineId);
      if (sourceLine === undefined) throw new ApplicationError("not_found", `BOM line '${line.bomLineId}' was not found`);
      assertReconciliationRole(sourceLine, outcome.kind);
      const reservation = reservations.get(outcome.reservationId);
      if (reservation === undefined) throw new ApplicationError("not_found", `Reservation '${outcome.reservationId}' was not found`);
      if (reservation.lineId !== line.bomLineId) throw new ApplicationError("validation", `Reservation '${reservation.id}' does not belong to BOM line '${line.bomLineId}'`);
      if (reservation.status !== "active") throw new ApplicationError("conflict", `Reservation '${reservation.id}' is no longer active`);
      const item = items.get(reservation.itemId);
      if (item === undefined) throw new ApplicationError("not_found", `Inventory item '${reservation.itemId}' was not found`);
      if (outcome.itemId !== undefined && outcome.itemId !== reservation.itemId) throw new ApplicationError("validation", `Outcome item does not match reservation '${reservation.id}'`);
      if (outcome.unit !== reservation.unit || outcome.unit !== item.unit) throw new ApplicationError("validation", `Unit mismatch for reservation '${reservation.id}'`);
      positive(outcome.quantity, `${outcome.kind} quantity`);
      accounted.set(reservation.id, (accounted.get(reservation.id) ?? 0) + outcome.quantity);
      outcomes.push({ outcome, reservation, lineId: line.bomLineId, index });
      if (outcome.kind === "converted_asset") {
        const asset = outcome.convertedAsset;
        if (asset === undefined) throw new ApplicationError("validation", "converted_asset requires convertedAsset");
        if (asset.id === undefined) throw new ApplicationError("integrity_error", "converted asset ID normalization failed");
        positive(asset.quantity, "converted asset quantity");
        createdAssets.push({ itemId: asset.id!, name: asset.name, kind: asset.kind, quantity: asset.quantity, unit: asset.unit });
      } else if (outcome.convertedAsset !== undefined) {
        throw new ApplicationError("validation", "convertedAsset is only valid for converted_asset");
      }
    }
  }

  const reservationChanges: ReconciliationPreview["reservationChanges"] = [];
  const stockChanges: ReconciliationPreviewStockChange[] = [];
  const current = new Map<string, { onHand: number; allocated: number; available: number }>();
  for (const item of items.values()) current.set(item.id, { onHand: item.quantity, allocated: item.quantity - item.availableQuantity, available: item.availableQuantity });

  const activeReservations = [...reservations.values()].filter((reservation) => reservation.status === "active" && (accounted.get(reservation.id) ?? 0) > 0).sort((a, b) => a.id.localeCompare(b.id));
  for (const reservation of activeReservations) {
    const total = accounted.get(reservation.id) ?? 0;
    if (total > reservation.quantity) throw new ApplicationError("validation", `Reservation '${reservation.id}' is over-accounted`);
    if (total !== reservation.quantity) {
      if (requireComplete) throw new ApplicationError("conflict", `Reservation '${reservation.id}' requires ${reservation.quantity} ${reservation.unit}; ${total} was accounted for`);
      continue;
    }
    const item = items.get(reservation.itemId);
    if (item === undefined) throw new ApplicationError("not_found", `Inventory item '${reservation.itemId}' was not found`);
    const state = current.get(item.id)!;
    if (state.allocated < reservation.quantity) throw new ApplicationError("conflict", `Reservation '${reservation.id}' exceeds current allocation`);
    const before = { ...state };
    state.allocated -= reservation.quantity;
    state.available = state.onHand - state.allocated;
    reservationChanges.push({ reservationId: reservation.id, fromStatus: "active", toStatus: "settled", quantity: reservation.quantity, unit: reservation.unit });
    stockChanges.push({
      itemId: item.id, kind: "release", quantity: reservation.quantity, unit: item.unit,
      beforeOnHand: before.onHand, afterOnHand: state.onHand,
      beforeAllocated: before.allocated, afterAllocated: state.allocated,
      beforeAvailable: before.available, afterAvailable: state.available,
      eventKey: reconciliationStockEventKey(snapshot.projectRevisionId, reservation.id, "release")
    });
  }

  for (const entry of outcomes) {
    const kind = entry.outcome.kind === "damaged_lost" ? "loss" : entry.outcome.kind === "consumed" || entry.outcome.kind === "converted_asset" ? "consume" : undefined;
    if (kind === undefined) continue;
    const item = items.get(entry.reservation.itemId);
    if (item === undefined) throw new ApplicationError("not_found", `Inventory item '${entry.reservation.itemId}' was not found`);
    const state = current.get(item.id)!;
    const before = { ...state };
    state.onHand -= entry.outcome.quantity;
    if (state.onHand < 0) throw new ApplicationError("conflict", `Disposition would make inventory item '${item.id}' negative`);
    state.available = state.onHand - state.allocated;
    stockChanges.push({
      itemId: item.id, kind, quantity: entry.outcome.quantity, unit: item.unit,
      beforeOnHand: before.onHand, afterOnHand: state.onHand,
      beforeAllocated: before.allocated, afterAllocated: state.allocated,
      beforeAvailable: before.available, afterAvailable: state.available,
      eventKey: reconciliationStockEventKey(snapshot.projectRevisionId, entry.reservation.id, kind, entry.index)
    });
  }
  return { reservationChanges, stockChanges, createdAssets };
}

/** Build the server-owned basis and preview for a saved draft or commit. */
export function buildReconciliationDocument(snapshot: ReconciliationSourceSnapshot, lines: readonly ReconciliationLine[], requireComplete: boolean): { readonly lines: readonly ReconciliationLine[]; readonly basis: ReconciliationBasis; readonly preview: ReconciliationPreview } {
  const normalizedLines = normalizeReconciliationLines(snapshot.projectRevisionId, lines);
  const sourceLines = linesMap(snapshot);
  const reservations = reservationMap(snapshot);
  const items = itemMap(snapshot);
  for (const reservation of snapshot.reservations) {
    if (reservation.status !== "active") continue;
    const item = items.get(reservation.itemId);
    if (item !== undefined && !isUnitCompatibleWithItemKind(item.kind, item.unit)) {
      const reason = unitCorrectionReason(item.kind, item.unit) ?? `unit '${item.unit}' is not recognized for kind '${item.kind}'`;
      throw new ApplicationError("validation", `Inventory item ${item.id} needs unit correction before reconciliation: ${reason}`);
    }
  }
  const seenLines = new Set<string>();
  for (const line of normalizedLines) {
    if (seenLines.has(line.bomLineId)) throw new ApplicationError("validation", `BOM line '${line.bomLineId}' was supplied more than once`);
    if (!sourceLines.has(line.bomLineId)) throw new ApplicationError("not_found", `BOM line '${line.bomLineId}' was not found in this revision`);
    seenLines.add(line.bomLineId);
  }
  // Close-out completeness is reservation-focused: zero-reservation BOM lines
  // have no stock state to settle and may remain omitted. The preview still
  // includes every source line (and the basis below still includes every
  // source line, reservation, and item) so a later commit is protected from
  // changes anywhere in the revision. Active reservations are checked below
  // against their exact submitted accounting.
  // Validate every line's active reservation unit before any preview totals or
  // stock effects are calculated. This keeps malformed mixed-unit state from
  // being hidden by an otherwise plausible numeric sum.
  for (const line of snapshot.lines) activeReservationUnit(line, snapshot.reservations);
  const previewLines: ReconciliationPreview["lines"] = snapshot.lines.map((line) => {
    const lineReservations = snapshot.reservations.filter((reservation) => reservation.lineId === line.id && reservation.status === "active");
    const unit = activeReservationUnit(line, snapshot.reservations);
    const reservedQuantity = lineReservations.reduce((sum, reservation) => sum + reservation.quantity, 0);
    const submitted = normalizedLines.find((candidate) => candidate.bomLineId === line.id);
    const accountedQuantity = submitted?.outcomes.filter((outcome) => outcome.kind !== "reviewed_no_change").reduce((sum, outcome) => sum + outcome.quantity, 0) ?? 0;
    if (accountedQuantity > reservedQuantity) throw new ApplicationError("validation", `BOM line '${line.id}' is over-accounted`);
    if (requireComplete && accountedQuantity !== reservedQuantity && reservedQuantity > 0) throw new ApplicationError("conflict", `BOM line '${line.id}' has unaccounted reserved quantity`);
    return { bomLineId: line.id, reservedQuantity, accountedQuantity, unaccountedQuantity: reservedQuantity - accountedQuantity, outcomeCount: submitted?.outcomes.length ?? 0, unit };
  });
  const basisItems = [...items.values()].sort((a, b) => a.id.localeCompare(b.id)).map((item) => ({ itemId: item.id, version: item.version, onHand: item.quantity, allocated: item.quantity - item.availableQuantity, available: item.availableQuantity, unit: item.unit }));
  const basisReservations = [...snapshot.reservations].sort((a, b) => a.id.localeCompare(b.id)).map((reservation) => ({ reservationId: reservation.id, lineId: reservation.lineId, itemId: reservation.itemId, quantity: reservation.quantity, unit: reservation.unit, status: reservation.status, version: reservation.version }));
  const basisBomLines = [...snapshot.lines].sort((a, b) => a.id.localeCompare(b.id)).map((line) => ({ bomLineId: line.id, version: line.version, requiredQuantity: line.requiredQuantity, unit: line.unit, role: line.role ?? null }));
  const basisValue = { bomLines: basisBomLines, reservations: basisReservations, items: basisItems };
  const basis = { hash: hash(basisValue), ...basisValue };
  const changes = stockChangesFor(snapshot, normalizedLines, reservations, items, requireComplete);
  return {
    lines: normalizedLines,
    basis,
    preview: { lines: previewLines, reservationChanges: [...changes.reservationChanges], stockChanges: [...changes.stockChanges], createdAssets: [...changes.createdAssets] }
  };
}

export function reconciliationDraftId(revisionId: string): string {
  return `reconciliation-draft-${hash(revisionId).slice(0, 32)}`;
}

export function reconciliationCommitId(revisionId: string): string {
  return `reconciliation-${hash(revisionId).slice(0, 32)}`;
}
