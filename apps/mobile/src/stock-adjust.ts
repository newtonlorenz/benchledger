/** A physical count replaces the recorded quantity; a receipt adds to it. */
export type StockKind = "count" | "receipt";

const wholeUnits = new Set(["each", "set"]);
const MAX_QUANTITY = 1_000_000_000;
const round = (value: number) => Math.round(value * 1000) / 1000;

export function stepsFor(unit: string): number[] {
  if (wholeUnits.has(unit)) return [1, 10];
  if (unit === "metre") return [0.1, 1];
  return [1, 10, 100];
}
export function stepQuantity(value: number, step: number): number {
  return Math.max(0, round(value + step));
}
export function adjustmentPreview(kind: StockKind, before: number, quantity: number) {
  const after = kind === "count" ? round(quantity) : round(before + quantity);
  return { before, after, delta: round(after - before) };
}
export function validateAdjustment(kind: StockKind, quantity: number, unit: string): string | undefined {
  if (!Number.isFinite(quantity)) return "Enter a number.";
  if (quantity > MAX_QUANTITY) return "That quantity is too large.";
  if (kind === "count" && quantity < 0) return "A count must be zero or more.";
  if (kind === "receipt" && quantity <= 0) return "Received quantity must be more than zero.";
  if (wholeUnits.has(unit) && !Number.isInteger(quantity)) return "Use a whole number for this unit.";
  return undefined;
}
/** Plain decimal input only; a comma is accepted as the decimal separator. */
export function parseQuantity(text: string): number {
  const value = text.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/u.test(value) ? Number(value) : Number.NaN;
}
