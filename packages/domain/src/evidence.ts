/**
 * Evidence-to-availability classification for inventory records.
 *
 * This is the single rule that decides whether recorded stock counts as
 * usable (in stock, reservable, eligible to supply a BOM line) or must be
 * inspected first. The application service, gap evaluation, reservations,
 * project setup, inspection queue and the SQLite runtime's stock projection
 * all call it, so a workspace-level receiving policy only needs to change
 * here (for example by adding a policy parameter).
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
 * - `confirmed`: physically verified; counts as available, reservable stock.
 * - `inspect_first`: physically recorded, but a count is needed before use.
 * - `ordered`: purchased, not yet known to be on hand.
 * - `unknown`: no usable evidence.
 */
export type EvidenceAvailability = "confirmed" | "inspect_first" | "ordered" | "unknown";

export function classifyEvidenceAvailability(state: InventoryEvidenceState): EvidenceAvailability {
  switch (state) {
    case "physically_counted":
    case "commissioned":
      return "confirmed";
    case "delivered_uncounted":
    case "allocated":
    case "consumed":
      return "inspect_first";
    case "ordered_unverified":
      return "ordered";
    case "unknown":
      return "unknown";
  }
}

/** True only for evidence whose quantity counts as available stock. */
export function isConfirmedEvidence(state: InventoryEvidenceState): boolean {
  return classifyEvidenceAvailability(state) === "confirmed";
}

/** Uncertain arrivals that a deliberate physical count may commission. */
export function isCommissionableEvidence(state: InventoryEvidenceState): boolean {
  return state === "delivered_uncounted" || state === "ordered_unverified";
}
