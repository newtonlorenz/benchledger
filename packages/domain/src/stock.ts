import { createId, nowIso } from "./ids.js";
import { DomainError, assertNonNegativeQuantity, assertPositiveQuantity } from "./errors.js";
import type {
  AvailabilityClass,
  AvailabilityInput,
  AvailabilityResult,
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

function initialBalance(item: InventoryItem): StockBalance {
  return {
    itemId: item.id,
    onHand: 0,
    allocated: 0,
    available: 0,
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

  if (onHand < 0) throw new DomainError("negative_stock", `event ${event.id} would make on-hand stock negative`);
  if (allocated < 0) throw new DomainError("negative_allocation", `event ${event.id} would make allocation negative`);
  if (allocated > onHand) throw new DomainError("over_allocation", `event ${event.id} would allocate more stock than is on hand`);
  return {
    ...balance,
    onHand,
    allocated,
    available: onHand - allocated,
    ...(lastCountAt === undefined ? {} : { lastCountAt })
  };
}

export function deriveStockBalance(item: InventoryItem, events: readonly StockEvent[]): StockBalance {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.itemId === item.id)
    .sort((a, b) => a.event.occurredAt.localeCompare(b.event.occurredAt) || a.event.createdAt.localeCompare(b.event.createdAt) || a.index - b.index)
    .map(({ event }) => event);
  return ordered.reduce(applyEvent, initialBalance(item));
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

export function classifyAvailability(input: AvailabilityInput): AvailabilityResult {
  assertNonNegativeQuantity(input.required, "required quantity");
  assertNonNegativeQuantity(input.available, "available quantity");
  if (input.reported !== undefined) assertNonNegativeQuantity(input.reported, "reported quantity");
  const candidate = input.candidate ?? true;
  const reported = input.reported ?? input.available;
  const supplied = Math.min(input.required, input.available);
  const shortfall = Math.max(0, input.required - supplied);
  if (input.required === 0) {
    return { status: "available", required: 0, supplied: 0, shortfall: 0, explanation: "No stock is required.", needsInspection: false };
  }
  if (!candidate && input.available === 0) {
    return { status: "missing", required: input.required, supplied: 0, shortfall: input.required, explanation: "No matching inventory item was found.", needsInspection: false };
  }
  if (input.confidence === "confirmed") {
    if (input.available >= input.required) {
      return { status: "available", required: input.required, supplied: supplied, shortfall: 0, explanation: "A physically confirmed balance covers the requirement.", needsInspection: false };
    }
    if (input.available > 0) {
      return { status: "partial", required: input.required, supplied, shortfall, explanation: `Only ${input.available} confirmed unit(s) remain; ${shortfall} more are needed.`, needsInspection: false };
    }
    return { status: "missing", required: input.required, supplied: 0, shortfall, explanation: "No confirmed stock remains.", needsInspection: false };
  }
  if (reported > 0 || input.available > 0 || input.confidence === "inspect_first" || input.confidence === "ordered") {
    return {
      status: "inspect-first",
      required: input.required,
      supplied,
      shortfall,
      explanation: "Order or delivery evidence exists, but current quantity or condition needs a physical check.",
      needsInspection: true
    };
  }
  return { status: "missing", required: input.required, supplied: 0, shortfall, explanation: "No current stock evidence is recorded.", needsInspection: false };
}
