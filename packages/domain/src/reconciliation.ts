import { DomainError, assertNonNegativeQuantity, assertPositiveQuantity } from "./errors.js";
import { settleReservation } from "./projects.js";
import type { BomLine, InventoryItem, QuantityUnit, Reservation, StockBalance, StockEventKind } from "./types.js";

/** A review outcome is intentionally closed: callers must choose a concrete
 * disposition instead of relying on an implicit "nothing changed" default. */
export type ReconciliationOutcomeKind =
  | "consumed"
  | "returned"
  | "damaged_lost"
  | "usable_leftover"
  | "converted_asset"
  | "reviewed_no_change";

export interface ReconciliationEvidence {
  readonly state: string;
  readonly source?: string;
  readonly sourceId?: string;
  readonly observedAt?: string;
  readonly note?: string;
  readonly condition?: string;
  readonly uncertainty?: number;
}

export interface ReconciliationAssetInput {
  readonly id?: string;
  readonly name: string;
  readonly category: InventoryItem["category"];
  readonly variant?: string;
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly sourceStatus: InventoryItem["sourceStatus"];
  readonly reusePolicy: InventoryItem["reusePolicy"];
  readonly confidence: InventoryItem["confidence"];
  readonly reportedQuantity?: number;
  readonly manufacturer?: string;
  readonly model?: string;
  readonly notes?: string;
}

export interface ReconciliationOutcomeInput {
  readonly reservationId?: string;
  readonly itemId?: string;
  readonly kind: ReconciliationOutcomeKind;
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly evidence: ReconciliationEvidence;
  readonly convertedAsset?: ReconciliationAssetInput;
}

export interface ReconciliationLineInput {
  readonly bomLineId: string;
  readonly outcomes: readonly ReconciliationOutcomeInput[];
}

export interface ReconciliationInventorySnapshot {
  readonly item: InventoryItem;
  readonly balance: StockBalance;
}

export interface ReconciliationSource {
  readonly revisionId: string;
  readonly lines: readonly BomLine[];
  readonly reservations: readonly Reservation[];
  readonly inventory: readonly ReconciliationInventorySnapshot[];
}

export interface ReconciliationStockEventPlan {
  readonly eventKey: string;
  readonly itemId: string;
  readonly kind: Extract<StockEventKind, "release" | "consume" | "loss">;
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly reservationId: string;
  readonly outcomeKind?: ReconciliationOutcomeKind;
  readonly evidence: ReconciliationEvidence;
}

export interface ReconciliationReservationSettlement {
  readonly reservation: Reservation;
  readonly settled: Reservation;
}

export interface ReconciliationPlan {
  readonly lines: readonly ReconciliationLineInput[];
  readonly settlements: readonly ReconciliationReservationSettlement[];
  readonly stockEvents: readonly ReconciliationStockEventPlan[];
  readonly convertedAssets: readonly ReconciliationAssetInput[];
}

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function assertText(value: string | undefined, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) fail("reconciliation_invalid_reference", `${field} is required`);
}

function assertEvidence(evidence: ReconciliationEvidence): void {
  if (evidence === null || typeof evidence !== "object" || typeof evidence.state !== "string" || evidence.state.trim().length === 0) {
    fail("reconciliation_missing_evidence", "every reconciliation outcome needs evidence state");
  }
  if (evidence.uncertainty !== undefined) assertNonNegativeQuantity(evidence.uncertainty, "evidence uncertainty");
}

function outcomeNeedsReservation(kind: ReconciliationOutcomeKind): boolean {
  return kind !== "reviewed_no_change";
}

function outcomeStockKind(kind: ReconciliationOutcomeKind): Extract<StockEventKind, "consume" | "loss"> | undefined {
  if (kind === "consumed" || kind === "converted_asset") return "consume";
  if (kind === "damaged_lost") return "loss";
  return undefined;
}

function assertConsumedRole(line: Pick<BomLine, "id" | "role">): void {
  if (line.role === undefined || line.role === null) {
    fail("reconciliation_role_required", `BOM line ${line.id} has no requirement role; review it as consumed or reusable before reconciliation`);
  }
  if (line.role === "reusable") {
    fail("reconciliation_reusable_consumption", `Reusable BOM line ${line.id} cannot be reconciled; only consumed requirements may be reconciled`);
  }
}

/**
 * Validate and plan a complete close-out without mutating any state. Complete
 * means every active reservation is accounted for; BOM lines with no active
 * reservation may be omitted from the submitted review.
 *
 * The planner is shared by memory and durable adapters conceptually: it
 * treats reservations as the accounting boundary, releases allocation once,
 * then applies destructive stock events. Returned/usable stock therefore
 * never receives an on-hand increment.
 */
export function planReconciliation(
  source: ReconciliationSource,
  inputLines: readonly ReconciliationLineInput[],
  options: { readonly requireComplete?: boolean; readonly settledAt?: string } = {}
): ReconciliationPlan {
  assertText(source.revisionId, "revision id");
  const lineById = new Map(source.lines.map((line) => [line.id, line]));
  const reservationById = new Map(source.reservations.map((reservation) => [reservation.id, reservation]));
  const inventoryById = new Map(source.inventory.map((snapshot) => [snapshot.item.id, snapshot]));
  const seenLines = new Set<string>();
  const outcomesByReservation = new Map<string, number>();
  const outcomesByLine = new Map<string, number>();
  const settlements: ReconciliationReservationSettlement[] = [];
  const stockEvents: ReconciliationStockEventPlan[] = [];
  const convertedAssets: ReconciliationAssetInput[] = [];
  const seenAssetIds = new Set<string>();

  for (const lineInput of inputLines) {
    assertText(lineInput.bomLineId, "BOM line id");
    if (seenLines.has(lineInput.bomLineId)) fail("reconciliation_duplicate_line", `BOM line ${lineInput.bomLineId} was reviewed more than once`);
    seenLines.add(lineInput.bomLineId);
    const line = lineById.get(lineInput.bomLineId);
    if (line === undefined) fail("reconciliation_unknown_line", `BOM line ${lineInput.bomLineId} does not belong to revision ${source.revisionId}`);
    if (lineInput.outcomes.length === 0) fail("reconciliation_no_outcome", `BOM line ${lineInput.bomLineId} has no explicit outcome`);
    assertConsumedRole(line);

    const lineReservations = source.reservations.filter((reservation) => reservation.bomLineId === lineInput.bomLineId);
    const activeReservations = lineReservations.filter((reservation) => reservation.status === "active");
    const lineReservationIds = new Set(lineReservations.map((reservation) => reservation.id));
    const lineAccounted = { value: 0 };
    const lineHasReservedOutcome = { value: false };
    const activeReservedQuantity = activeReservations.reduce((sum, reservation) => sum + reservation.quantity, 0);
    const hasReviewedNoChange = lineInput.outcomes.some((outcome) => outcome.kind === "reviewed_no_change");
    if (hasReviewedNoChange && (lineInput.outcomes.length !== 1 || activeReservedQuantity > 0)) {
      fail("reconciliation_invalid_no_change", "reviewed_no_change must be the sole outcome for a BOM line with zero active reserved quantity");
    }

    for (const [outcomeIndex, outcome] of lineInput.outcomes.entries()) {
      assertEvidence(outcome.evidence);
      assertNonNegativeQuantity(outcome.quantity, "reconciliation outcome quantity");
      if (outcome.kind === "reviewed_no_change") {
        if (outcome.quantity !== 0 || outcome.reservationId !== undefined || outcome.itemId !== undefined) {
          fail("reconciliation_invalid_no_change", "reviewed_no_change must have zero quantity and no reservation or item reference");
        }
        if (outcome.convertedAsset !== undefined) fail("reconciliation_invalid_asset", "reviewed_no_change cannot create an asset");
        if (outcome.unit !== line.unit) fail("reconciliation_unit_mismatch", `BOM line ${line.id} uses ${line.unit}, outcome uses ${outcome.unit}`);
        continue;
      }

      if (!outcomeNeedsReservation(outcome.kind) || outcome.reservationId === undefined) {
        fail("reconciliation_missing_reservation", `${outcome.kind} requires an active reservation`);
      }
      const reservation = reservationById.get(outcome.reservationId);
      if (reservation === undefined || !lineReservationIds.has(reservation.id)) {
        fail("reconciliation_invalid_reservation", `Reservation ${outcome.reservationId} does not belong to BOM line ${line.id}`);
      }
      if (reservation.status !== "active") fail("reconciliation_reservation_not_active", `Reservation ${reservation.id} is already ${reservation.status}`);
      if (outcome.itemId !== undefined && outcome.itemId !== reservation.itemId) fail("reconciliation_invalid_item", `Outcome item does not match reservation ${reservation.id}`);
      const snapshot = inventoryById.get(reservation.itemId);
      if (snapshot === undefined) fail("reconciliation_inventory_not_found", `Inventory item ${reservation.itemId} was not found`);
      if (outcome.unit !== snapshot.item.unit) fail("reconciliation_unit_mismatch", `Inventory item ${reservation.itemId} uses ${snapshot.item.unit}, outcome uses ${outcome.unit}`);
      if (outcome.quantity <= 0) fail("reconciliation_invalid_quantity", `${outcome.kind} quantity must be greater than zero`);
      if (outcome.kind === "converted_asset" && outcome.convertedAsset === undefined) fail("reconciliation_missing_asset", "converted_asset requires a complete convertedAsset record");
      if (outcome.kind !== "converted_asset" && outcome.convertedAsset !== undefined) fail("reconciliation_unexpected_asset", "convertedAsset is only valid for converted_asset outcomes");
      if (outcome.convertedAsset !== undefined) {
        assertText(outcome.convertedAsset.name, "converted asset name");
        assertPositiveQuantity(outcome.convertedAsset.quantity, "converted asset quantity");
        assertText(outcome.convertedAsset.unit, "converted asset unit");
        if (outcome.convertedAsset.id !== undefined) {
          if (seenAssetIds.has(outcome.convertedAsset.id) || reservationById.has(outcome.convertedAsset.id) || inventoryById.has(outcome.convertedAsset.id)) {
            fail("reconciliation_duplicate_asset", `Converted asset id ${outcome.convertedAsset.id} is already in use`);
          }
          seenAssetIds.add(outcome.convertedAsset.id);
        }
        convertedAssets.push(outcome.convertedAsset);
      }
      lineHasReservedOutcome.value = true;
      lineAccounted.value += outcome.quantity;
      outcomesByReservation.set(reservation.id, (outcomesByReservation.get(reservation.id) ?? 0) + outcome.quantity);
      outcomesByLine.set(line.id, (outcomesByLine.get(line.id) ?? 0) + outcome.quantity);
      const destructiveKind = outcomeStockKind(outcome.kind);
      if (destructiveKind !== undefined) {
        stockEvents.push({
          eventKey: `reconciliation:${source.revisionId}:${reservation.id}:${destructiveKind}:${outcomeIndex}`,
          itemId: reservation.itemId,
          kind: destructiveKind,
          quantity: outcome.quantity,
          unit: snapshot.item.unit,
          reservationId: reservation.id,
          outcomeKind: outcome.kind,
          evidence: outcome.evidence
        });
      }
    }

    if (activeReservations.length > 0 && !lineHasReservedOutcome.value && options.requireComplete === true) {
      fail("reconciliation_unaccounted_reservation", `BOM line ${line.id} has active reserved stock with no disposition`);
    }
  }

  for (const reservation of source.reservations.filter((candidate) => candidate.status === "active")) {
    const accounted = outcomesByReservation.get(reservation.id) ?? 0;
    if (options.requireComplete === true && accounted !== reservation.quantity) {
      fail("reconciliation_unaccounted_reservation", `Reservation ${reservation.id} requires ${reservation.quantity} ${reservation.itemId}; ${accounted} was accounted for`);
    }
    if (accounted <= 0) continue;
    const snapshot = inventoryById.get(reservation.itemId);
    if (snapshot === undefined) fail("reconciliation_inventory_not_found", `Inventory item ${reservation.itemId} was not found`);
    if (snapshot.balance.allocated < reservation.quantity) fail("reconciliation_invalid_balance", `Reservation ${reservation.id} exceeds the current allocated balance`);
    if (snapshot.balance.onHand < stockEvents.filter((event) => event.itemId === reservation.itemId && event.reservationId === reservation.id).reduce((total, event) => total + (event.kind === "release" ? 0 : event.quantity), 0)) {
      fail("reconciliation_insufficient_stock", `Disposition would make item ${reservation.itemId} negative`);
    }
    const settledAt = options.settledAt;
    settlements.push({ reservation, settled: settleReservation(reservation, settledAt) });
    stockEvents.unshift({
      eventKey: `reconciliation:${source.revisionId}:${reservation.id}:release`,
      itemId: reservation.itemId,
      kind: "release",
      quantity: reservation.quantity,
      unit: snapshot.item.unit,
      reservationId: reservation.id,
      evidence: { state: "consumed", ...(settledAt === undefined ? {} : { observedAt: settledAt }) }
    });
  }

  return { lines: inputLines.slice(), settlements, stockEvents, convertedAssets };
}
