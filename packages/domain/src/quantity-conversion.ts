import { DomainError } from "./errors.js";
import type {
  BomAlternativeQuantityConversion,
  BomAlternativeQuantityConversionEvidence,
  BomAlternativeQuantityConversionEvidenceBasis,
  QuantityUnit,
} from "./types.js";

export const BOM_ALTERNATIVE_QUANTITY_CONVERSION_EVIDENCE_BASES = [
  "package_label",
  "manufacturer_spec",
  "physical_count",
  "user_assertion",
] as const satisfies readonly BomAlternativeQuantityConversionEvidenceBasis[];

const quantityConversionKeys = ["inventory", "requirement", "evidence"] as const;
const quantityConversionInventoryKeys = ["quantity", "unit"] as const;
const quantityConversionRequirementKeys = ["quantity", "unit"] as const;
const quantityConversionEvidenceKeys = ["basis", "observedAt", "source", "sourceId", "note"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function isEvidenceBasis(value: unknown): value is BomAlternativeQuantityConversionEvidenceBasis {
  return typeof value === "string" && (BOM_ALTERNATIVE_QUANTITY_CONVERSION_EVIDENCE_BASES as readonly string[]).includes(value);
}

function isOptionalEvidenceText(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

/** Runtime guard for values loaded from persistence or another untyped boundary. */
export function isBomAlternativeQuantityConversion(value: unknown): value is BomAlternativeQuantityConversion {
  if (!isRecord(value) || !hasOnlyKeys(value, quantityConversionKeys)) return false;
  const inventory = value.inventory;
  const requirement = value.requirement;
  const evidence = value.evidence;
  if (!isRecord(inventory) || !hasOnlyKeys(inventory, quantityConversionInventoryKeys) || inventory.quantity !== 1 || inventory.unit !== "set") return false;
  if (!isRecord(requirement) || !hasOnlyKeys(requirement, quantityConversionRequirementKeys) || requirement.quantity === undefined || requirement.unit !== "piece") return false;
  if (typeof requirement.quantity !== "number" || !Number.isSafeInteger(requirement.quantity) || requirement.quantity <= 0) return false;
  if (!isRecord(evidence) || !hasOnlyKeys(evidence, quantityConversionEvidenceKeys)) return false;
  if (!isEvidenceBasis(evidence.basis) || !isIsoTimestamp(evidence.observedAt)) return false;
  return isOptionalEvidenceText(evidence.source, 500)
    && isOptionalEvidenceText(evidence.sourceId, 500)
    && isOptionalEvidenceText(evidence.note, 1000);
}

/** Fail closed at the domain boundary with one stable error code. */
export function assertBomAlternativeQuantityConversion(value: unknown): asserts value is BomAlternativeQuantityConversion {
  if (!isBomAlternativeQuantityConversion(value)) {
    throw new DomainError("invalid_quantity_conversion", "quantity conversion must be an evidence-backed one-set to whole-piece conversion");
  }
}

export function cloneBomAlternativeQuantityConversion(
  value: BomAlternativeQuantityConversion,
): BomAlternativeQuantityConversion {
  assertBomAlternativeQuantityConversion(value);
  return {
    inventory: { ...value.inventory },
    requirement: { ...value.requirement },
    evidence: { ...value.evidence },
  };
}

export interface ResolveBomAlternativeQuantityInput {
  readonly inventoryQuantity: number;
  readonly inventoryUnit: QuantityUnit;
  readonly requirementUnit: QuantityUnit;
  readonly conversion?: BomAlternativeQuantityConversion | undefined;
}

/**
 * Resolve a candidate quantity into a BOM line's unit without inference.
 * Set inventory is converted only with an evidence-backed whole-piece rule;
 * undefined means the units cannot be reconciled.
 */
export function resolveBomAlternativeQuantity(input: ResolveBomAlternativeQuantityInput): number | undefined {
  const { inventoryQuantity, inventoryUnit, requirementUnit, conversion } = input;
  if (!Number.isFinite(inventoryQuantity) || inventoryQuantity < 0) return undefined;
  if (inventoryUnit === requirementUnit) return inventoryQuantity;
  if (conversion === undefined || !isBomAlternativeQuantityConversion(conversion)) return undefined;
  if (inventoryUnit !== conversion.inventory.unit || requirementUnit !== conversion.requirement.unit) return undefined;
  if (!Number.isSafeInteger(inventoryQuantity)) return undefined;
  const converted = inventoryQuantity * conversion.requirement.quantity;
  return Number.isSafeInteger(converted) ? converted : undefined;
}

export const resolveQuantityConversion = resolveBomAlternativeQuantity;

export type { BomAlternativeQuantityConversionEvidence, BomAlternativeQuantityConversionEvidenceBasis };
