/**
 * Inventory quantities are decimal amounts (grams, metres, millilitres) held
 * in binary floating point, so 0.1 + 0.2 is not exactly 0.3. Every coverage,
 * reservation and replay comparison uses this tolerance so a quantity that is
 * equal in decimal terms is never rejected as an over-reservation.
 *
 * The tolerance is relative (with an absolute floor of one billionth of a
 * unit) so it stays meaningful for both small and large magnitudes, while
 * remaining far below any quantity a maker can physically measure.
 */
export const QUANTITY_TOLERANCE = 1e-9;

function tolerance(left: number, right: number): number {
  return QUANTITY_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right));
}

/** True when two finite quantities are equal within decimal rounding error. */
export function quantitiesEqual(left: number, right: number): boolean {
  if (left === right) return true;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= tolerance(left, right);
}

/** True when `quantity` is greater than `limit` by more than rounding error. */
export function quantityExceeds(quantity: number, limit: number): boolean {
  if (!Number.isFinite(quantity) || !Number.isFinite(limit)) return quantity > limit;
  return quantity - limit > tolerance(quantity, limit);
}

/** Remove binary rounding noise from a computed quantity (9 decimal places). */
export function roundQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return quantity;
  const rounded = Math.round(quantity * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * The single over-reservation rule for a BOM line, shared by every runtime.
 *
 * - Same unit as the line: the new reservation may fill the remaining
 *   requirement exactly, never beyond it (within decimal rounding).
 * - Converted (whole sets of `setCoverage` line units each): the new
 *   reservation may round the remaining requirement up to whole sets, since a
 *   set cannot be split, but never adds a set once coverage is reached.
 *
 * `reservedCoverage` is the active coverage already reserved, in line units.
 */
export function exceedsReservableQuantity(quantity: number, requiredQuantity: number, reservedCoverage: number, setCoverage?: number): boolean {
  if (setCoverage === undefined) return quantityExceeds(reservedCoverage + quantity, requiredQuantity);
  const remaining = Math.max(0, roundQuantity(requiredQuantity - reservedCoverage));
  const maximumSets = Math.ceil(roundQuantity(remaining / setCoverage));
  return quantity > maximumSets;
}
