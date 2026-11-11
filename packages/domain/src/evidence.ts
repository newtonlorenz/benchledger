/**
 * Evidence-to-availability classification for inventory records.
 *
 * This is the single rule that decides whether recorded stock counts as
 * in stock (available, reservable, eligible to supply a BOM line) or must be
 * received/inspected first. The application service, gap evaluation,
 * reservations, project setup, inspection queue and the SQLite runtime's stock
 * projection all call it with the workspace's stock receiving policy as an
 * explicit argument. The policy never rewrites stored evidence; it only
 * changes what that evidence is trusted to mean.
 */

/** Every evidence state an inventory item can carry (mirrors the API contract). */
export const INVENTORY_EVIDENCE_STATES = [
  "physically_counted",
  "commissioned",
  "delivered_uncounted",
  "ordered_unverified",
  "allocated",
  "consumed",
  "unknown"
] as const;

export type InventoryEvidenceState = typeof INVENTORY_EVIDENCE_STATES[number];

/**
 * When does recorded stock count as in stock?
 *
 * - `on_purchase`: when it is bought. Ordered and delivered stock count.
 * - `on_delivery`: when it is delivered. Delivered stock counts; ordered stock
 *   that has not arrived does not.
 * - `on_receipt`: when it has been received and checked. Ordered and delivered
 *   stock stay pending until a receiving count or commissioning confirms them.
 */
export const STOCK_RECEIVING_POLICIES = ["on_purchase", "on_delivery", "on_receipt"] as const;

export type StockReceivingPolicy = typeof STOCK_RECEIVING_POLICIES[number];

/** The historical, most conservative behaviour. */
export const DEFAULT_STOCK_RECEIVING_POLICY: StockReceivingPolicy = "on_receipt";

export function isStockReceivingPolicy(value: unknown): value is StockReceivingPolicy {
  return typeof value === "string" && (STOCK_RECEIVING_POLICIES as readonly string[]).includes(value);
}

/**
 * - `confirmed`: physically verified (counted or commissioned); in stock under every policy.
 * - `assumed`: not verified, but the workspace receiving policy counts it as in stock.
 * - `inspect_first`: physically recorded, but a count is needed before use.
 * - `ordered`: purchased, not yet known to be on hand.
 * - `unknown`: no usable evidence.
 */
export type EvidenceAvailability = "confirmed" | "assumed" | "inspect_first" | "ordered" | "unknown";

export function classifyEvidenceAvailability(state: InventoryEvidenceState, policy: StockReceivingPolicy): EvidenceAvailability {
  switch (state) {
    case "physically_counted":
    case "commissioned":
      return "confirmed";
    case "delivered_uncounted":
      return policy === "on_receipt" ? "inspect_first" : "assumed";
    case "ordered_unverified":
      return policy === "on_purchase" ? "assumed" : "ordered";
    case "allocated":
    case "consumed":
      return "inspect_first";
    case "unknown":
      return "unknown";
  }
}

/** True when the stored evidence counts as in stock under the given policy. */
export function countsAsInStock(state: InventoryEvidenceState, policy: StockReceivingPolicy): boolean {
  const availability = classifyEvidenceAvailability(state, policy);
  return availability === "confirmed" || availability === "assumed";
}

/** True only for physically verified evidence, independent of any policy. */
export function isConfirmedEvidence(state: InventoryEvidenceState): boolean {
  return state === "physically_counted" || state === "commissioned";
}

/**
 * Uncertain arrivals that a receiving count or commissioning may confirm.
 * Their ledger starts from the recorded (claimed) quantity; see
 * `deriveStockBalance`.
 */
export function isCommissionableEvidence(state: InventoryEvidenceState): boolean {
  return state === "delivered_uncounted" || state === "ordered_unverified";
}

/** Stock that counts only because the policy trusts unverified evidence. */
export function isAssumedByPolicy(state: InventoryEvidenceState, policy: StockReceivingPolicy): boolean {
  return classifyEvidenceAvailability(state, policy) === "assumed";
}
