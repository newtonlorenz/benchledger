import type { BomIntakeUnit } from "@benchledger/domain/bom-intake";
import type { QuantityDisplayUnit } from "./domain";

export const requirementUnits: readonly BomIntakeUnit[] = ["each", "gram", "metre", "millimetre", "millilitre", "set"];
const labels: Record<BomIntakeUnit, readonly [string, string]> = {
  each: ["piece", "pieces"], gram: ["gram", "grams"], metre: ["metre", "metres"],
  millimetre: ["millimetre", "millimetres"], millilitre: ["millilitre", "millilitres"], set: ["set", "sets"]
};
/** Change only the unit's API/display spelling; this never converts a quantity. */
export function requirementUnit(unit: BomIntakeUnit | QuantityDisplayUnit): BomIntakeUnit {
  return unit === "g" ? "gram" : unit === "m" ? "metre" : unit;
}
export function displayUnit(unit: BomIntakeUnit): QuantityDisplayUnit {
  return unit === "gram" ? "g" : unit === "metre" ? "m" : unit;
}
export function quantityUnitLabel(unit: BomIntakeUnit | QuantityDisplayUnit, quantity?: number): string {
  return labels[requirementUnit(unit)][quantity === 1 ? 0 : 1];
}
