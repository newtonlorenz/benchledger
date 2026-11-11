import { createId, nowIso } from "./ids.js";
import { DomainError, assertNonNegativeQuantity, assertPositiveQuantity } from "./errors.js";
import { quantitiesEqual, quantityExceeds, roundQuantity } from "./quantity-compare.js";
import type {
  AuditActor,
  InventoryItem,
  StockBalance,
  StockConfidence,
  StockEvent,
  StockEventKind,
  StockEventSemantics,
  QuantityUnit
} from "./types.js";

export interface NewStockEvent {
  itemId: string;
  kind: StockEventKind;
  quantity: number;
  unit: QuantityUnit;
  reason: string;
  semantics?: StockEventSemantics;
  actor?: AuditActor;
  source?: string;
  evidence?: Record<string, unknown>;
  correlationId?: string;
  idempotencyKey?: string;
  occurredAt?: string;
  createdAt?: string;
  id?: string;
}

export interface StockLedgerState {
  readonly events: readonly StockEvent[];
}

function defaultSemantics(kind: StockEventKind): StockEventSemantics {
  if (kind === "count") return "absolute_count";
  if (kind === "evidence") return "informational";
  return "delta";
}

function validateEvent(event: StockEvent): void {
  if (!event.itemId.trim()) throw new DomainError("invalid_item_id", "stock event itemId is required");
  if (!event.reason.trim()) throw new DomainError("invalid_reason", "stock event reason is required");
  if (!Number.isFinite(event.quantity)) throw new DomainError("invalid_quantity", "stock event quantity must be finite");
  if (event.semantics === "absolute_count") assertNonNegativeQuantity(event.quantity, "counted quantity");
  if (event.kind === "allocate" || event.kind === "release" || event.kind === "consume" || event.kind === "loss" || event.kind === "receipt" || event.kind === "return") {
    assertPositiveQuantity(event.quantity);
  }
}

export function createStockEvent(input: NewStockEvent): StockEvent {
  const createdAt = input.createdAt ?? nowIso();
  const event: StockEvent = {
    id: input.id ?? createId("stock"),
    itemId: input.itemId,
    kind: input.kind,
    semantics: input.semantics ?? defaultSemantics(input.kind),
    quantity: input.quantity,
    unit: input.unit,
    reason: input.reason,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.evidence === undefined ? {} : { evidence: { ...input.evidence } }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    occurredAt: input.occurredAt ?? createdAt,
    createdAt
  };
  validateEvent(event);
  return event;
}

/**
 * An idempotency key may only replay the command that first used it. A stored
 * event with the same key but a different item, movement shape or actor is a
 * different command, and returning it as a replay would silently drop the new
 * stock movement.
 */
export function isSameStockCommand(existing: StockEvent, candidate: StockEvent): boolean {
  if (existing.itemId !== candidate.itemId) return false;
  if (existing.kind !== candidate.kind || existing.semantics !== candidate.semantics) return false;
  if (existing.unit !== candidate.unit || !quantitiesEqual(existing.quantity, candidate.quantity)) return false;
  if (existing.actor !== undefined && candidate.actor !== undefined && existing.actor.id !== candidate.actor.id) return false;
  return true;
}

export function assertStockCommandReplay(existing: StockEvent, candidate: StockEvent): void {
  if (!isSameStockCommand(existing, candidate)) {
    throw new DomainError("idempotency_conflict", "The idempotency key was already used for a different stock movement");
  }
}

const UNCOUNTED_SOURCE_STATUSES: ReadonlySet<string> = new Set(["delivered_uncounted", "shipped_available_baseline", "ordered_unverified"]);

/**
 * Recorded (claimed, not counted) quantity of a delivered or ordered row.
 *
 * The ledger starts such a row from this quantity so that, when the workspace
 * receiving policy trusts delivery or purchase evidence, reservations and
 * usage have a balance to draw from. It is not counted evidence: whether the
 * quantity is *available* is decided separately by `countsAsInStock` with the
 * policy, and an absolute receiving count replaces the baseline.
 */
export function uncountedBaselineQuantity(item: InventoryItem): number | undefined {
  if (!UNCOUNTED_SOURCE_STATUSES.has(item.sourceStatus)) return undefined;
  const quantity = item.reportedQuantity ?? item.purchasedQuantity;
  return Number.isFinite(quantity) && quantity > 0 ? roundQuantity(quantity) : 0;
}

/**
 * A receiving count that replaced a claimed quantity records that claim as
 * `evidence.claimedBaseline`. Reservations or usage recorded before the count
 * drew on the claim, so replaying them needs the same starting point.
 */
function claimedBaselineFromReceipt(ordered: readonly StockEvent[]): number | undefined {
  const firstCount = ordered.find((event) => event.kind !== "evidence" && event.semantics === "absolute_count");
  const claimed = firstCount?.evidence?.claimedBaseline;
  return typeof claimed === "number" && Number.isFinite(claimed) && claimed >= 0 ? roundQuantity(claimed) : undefined;
}

function initialBalance(item: InventoryItem, ordered: readonly StockEvent[]): StockBalance {
  const baseline = uncountedBaselineQuantity(item) ?? claimedBaselineFromReceipt(ordered) ?? 0;
  return {
    itemId: item.id,
    onHand: baseline,
    allocated: 0,
    available: baseline,
    ...(item.reportedQuantity === undefined ? {} : { reported: item.reportedQuantity }),
    confidence: item.confidence
  };
}

function applyEvent(balance: StockBalance, event: StockEvent): StockBalance {
  if (event.kind === "evidence") return balance;
  let onHand = balance.onHand;
  let allocated = balance.allocated;
  let lastCountAt = balance.lastCountAt;

  if (event.semantics === "absolute_count") {
    onHand = event.quantity;
    lastCountAt = event.occurredAt;
  } else if (event.kind === "receipt" || event.kind === "return" || event.kind === "adjustment") {
    onHand += event.quantity;
  } else if (event.kind === "consume" || event.kind === "loss") {
    onHand -= event.quantity;
  } else if (event.kind === "allocate") {
    allocated += event.quantity;
  } else if (event.kind === "release") {
    allocated -= event.quantity;
  }

  // Decimal quantities accumulate binary rounding error; compare and store
  // them within the shared quantity tolerance.
  onHand = roundQuantity(onHand);
  allocated = roundQuantity(allocated);
  if (quantityExceeds(0, onHand)) throw new DomainError("negative_stock", `event ${event.id} would make on-hand stock negative`);
  if (quantityExceeds(0, allocated)) throw new DomainError("negative_allocation", `event ${event.id} would make allocation negative`);
  if (quantityExceeds(allocated, onHand)) throw new DomainError("over_allocation", `event ${event.id} would allocate more stock than is on hand`);
  return {
    ...balance,
    onHand,
    allocated,
    available: Math.max(0, roundQuantity(onHand - allocated)),
    ...(lastCountAt === undefined ? {} : { lastCountAt })
  };
}

/**
 * Chronological, locale-independent timestamp order. Equal instants (or
 * unparseable values that compare equal) fall through to the caller's stable
 * tiebreak: createdAt, then input order, which repositories supply as
 * insertion (rowid) order.
 */
function compareTimestamps(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deriveStockBalance(item: InventoryItem, events: readonly StockEvent[]): StockBalance {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.itemId === item.id)
    .sort((a, b) => compareTimestamps(a.event.occurredAt, b.event.occurredAt) || compareTimestamps(a.event.createdAt, b.event.createdAt) || a.index - b.index)
    .map(({ event }) => event);
  return ordered.reduce(applyEvent, initialBalance(item, ordered));
}

export class StockLedger {
  readonly events: readonly StockEvent[];

  constructor(events: readonly StockEvent[] = []) {
    const seenIds = new Set<string>();
    const seenIdempotency = new Set<string>();
    for (const event of events) {
      validateEvent(event);
      if (seenIds.has(event.id)) throw new DomainError("duplicate_event", `duplicate stock event ${event.id}`);
      if (event.idempotencyKey !== undefined && seenIdempotency.has(event.idempotencyKey)) {
        throw new DomainError("duplicate_idempotency_key", `duplicate stock event idempotency key ${event.idempotencyKey}`);
      }
      seenIds.add(event.id);
      if (event.idempotencyKey !== undefined) seenIdempotency.add(event.idempotencyKey);
    }
    this.events = events.slice();
  }

  append(input: NewStockEvent): StockLedger {
    const event = createStockEvent(input);
    if (this.events.some((candidate) => candidate.id === event.id)) {
      throw new DomainError("duplicate_event", `duplicate stock event ${event.id}`);
    }
    if (event.idempotencyKey !== undefined && this.events.some((candidate) => candidate.idempotencyKey === event.idempotencyKey)) {
      throw new DomainError("duplicate_idempotency_key", `duplicate stock event idempotency key ${event.idempotencyKey}`);
    }
    const next = this.events.concat(event);
    // Apply once to fail before returning a ledger containing an invalid state.
    const itemStub: InventoryItem = {
      id: event.itemId,
      name: event.itemId,
      category: "other",
      purchasedQuantity: 0,
      unit: event.unit,
      sourceStatus: "unknown",
      reusePolicy: "inspect_first",
      confidence: "unknown",
      createdAt: event.createdAt,
      updatedAt: event.createdAt
    };
    deriveStockBalance(itemStub, next);
    return new StockLedger(next);
  }

  balance(item: InventoryItem): StockBalance {
    return deriveStockBalance(item, this.events);
  }
}

export function confidenceFromSourceStatus(status: string): StockConfidence {
  if (status === "commissioned_available" || status === "physically_confirmed") return "confirmed";
  if (status === "delivered_uncounted" || status === "shipped_available_baseline") return "inspect_first";
  if (status === "ordered_unverified") return "ordered";
  return "unknown";
}

