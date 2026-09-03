/**
 * Semantic inventory quantity policy.
 *
 * These are deliberately small, physical units.  The policy describes how a
 * newly-created item is normally measured; it is not applied retroactively to
 * reject records that were imported before the policy existed.
 */
export const ITEM_KINDS = [
  "printer",
  "tool",
  "accessory",
  "consumable",
  "electronic",
  "fastener",
  "filament",
  "wire",
  "adhesive",
  "other",
] as const;

export const QUANTITY_UNITS = [
  "each",
  "gram",
  "millimetre",
  "millilitre",
  "metre",
  "set",
] as const;

export type ItemKind = typeof ITEM_KINDS[number];
export type QuantityUnit = typeof QUANTITY_UNITS[number];

export interface ItemKindUnitRule {
  readonly defaultUnit: QuantityUnit;
  readonly validUnits: readonly QuantityUnit[];
}

/**
 * Sets are retained for packaged electronics/fasteners and wire assortments:
 * those are physical package identities, not a conversion claim.  A package
 * only contributes to another requirement through an explicit conversion
 * observation.  `other` and `consumable` remain intentionally flexible for
 * imported maker materials that do not fit a narrower semantic kind.
 */
export const ITEM_KIND_UNIT_RULES: Readonly<Record<ItemKind, ItemKindUnitRule>> = {
  printer: { defaultUnit: "each", validUnits: ["each"] },
  tool: { defaultUnit: "each", validUnits: ["each", "set"] },
  accessory: { defaultUnit: "each", validUnits: ["each", "set"] },
  consumable: { defaultUnit: "each", validUnits: [...QUANTITY_UNITS] },
  electronic: { defaultUnit: "each", validUnits: ["each", "set"] },
  fastener: { defaultUnit: "each", validUnits: ["each", "set"] },
  filament: { defaultUnit: "gram", validUnits: ["gram", "metre", "each"] },
  wire: { defaultUnit: "metre", validUnits: ["millimetre", "metre", "each", "set"] },
  adhesive: { defaultUnit: "millilitre", validUnits: ["millilitre", "gram", "each"] },
  other: { defaultUnit: "each", validUnits: [...QUANTITY_UNITS] },
};

export function defaultUnitForItemKind(kind: ItemKind): QuantityUnit {
  return ITEM_KIND_UNIT_RULES[kind].defaultUnit;
}

export function validUnitsForItemKind(kind: ItemKind): readonly QuantityUnit[] {
  return ITEM_KIND_UNIT_RULES[kind].validUnits;
}

export function isUnitCompatibleWithItemKind(kind: string, unit: string): boolean {
  const rule = ITEM_KIND_UNIT_RULES[kind as ItemKind];
  return rule !== undefined && rule.validUnits.includes(unit as QuantityUnit);
}

export function unitCorrectionReason(kind: string, unit: string): string | undefined {
  const rule = ITEM_KIND_UNIT_RULES[kind as ItemKind];
  if (rule === undefined || rule.validUnits.includes(unit as QuantityUnit)) return undefined;
  return `${kind} items use ${rule.validUnits.join(", ")}; this record uses ${unit}.`;
}
