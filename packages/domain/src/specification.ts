import type { BomSpecificationDecision } from "./types.js";

/**
 * Keep this order stable. It is used when explicit and requirement-derived
 * blockers are combined, so every surface presents the same next decisions.
 */
export const BOM_SPECIFICATION_DECISION_ORDER: readonly BomSpecificationDecision[] = [
  "identity",
  "purpose",
  "voltage",
  "current_or_load",
  "connector",
  "compatibility",
  "dimensions",
  "resistance",
  "power_rating",
];

export const POWER_SUPPLY_SPECIFICATION_DECISIONS: readonly BomSpecificationDecision[] = [
  "current_or_load",
  "connector",
];

export const LED_RESISTOR_SPECIFICATION_DECISIONS: readonly BomSpecificationDecision[] = [
  "resistance",
  "power_rating",
];

export interface BomSpecificationLine {
  readonly name: string;
  readonly constraints?: unknown;
  readonly id?: string | undefined;
  readonly itemId?: string | undefined;
}

export interface ResolvedBomSpecification {
  readonly sufficient: boolean;
  readonly missingDecisions: readonly BomSpecificationDecision[];
}

/**
 * Normalize only punctuation separators. Word boundaries are evaluated after
 * normalization, which supports names such as `power-supply` and
 * `LED-current-limiting resistor` without treating arbitrary prose as a
 * component classification.
 */
function normalizedRequirementName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

export function isPowerSupplyRequirement(name: string): boolean {
  return /\b(?:power supply|power adapter|dc adapter|ac adapter|wall adapter|mains adapter)\b/u.test(normalizedRequirementName(name));
}

/**
 * Match deliberately narrow whole-word LED-resistor phrases. Common BOM
 * wording puts LED before the resistor (including series/current-limiting
 * variants), while supplier notes sometimes say "resistor for LED".
 * Requiring the adjacent phrase keeps unrelated names such as "LED board
 * resistor bracket" out of the gate.
 */
export function isLedResistorRequirement(name: string): boolean {
  const normalized = normalizedRequirementName(name);
  return /\bled(?:(?: current)? limiting| series)? resistors?\b/u.test(normalized)
    || /\bresistors? for led\b/u.test(normalized);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidSpecification(value: Readonly<Record<string, unknown>>): boolean {
  if (value.status !== "sufficient" && value.status !== "insufficient") return false;
  if (value.missingDecisions !== undefined) {
    if (!Array.isArray(value.missingDecisions) || value.missingDecisions.length === 0) return false;
    if (value.missingDecisions.some((decision) => !BOM_SPECIFICATION_DECISION_ORDER.includes(decision as BomSpecificationDecision))) return false;
  }
  if (value.decisions !== undefined) {
    if (!isRecord(value.decisions)) return false;
    for (const [decision, resolved] of Object.entries(value.decisions)) {
      if (!BOM_SPECIFICATION_DECISION_ORDER.includes(decision as BomSpecificationDecision) || !hasText(resolved)) return false;
    }
  }
  if (value.status === "insufficient" && value.missingDecisions === undefined) return false;
  if (value.status === "sufficient" && value.missingDecisions !== undefined) return false;
  if (value.status === "sufficient" && value.decisions === undefined) return false;
  return true;
}

function derivedMissingDecisions(name: string, specification: Readonly<Record<string, unknown>> | undefined): readonly BomSpecificationDecision[] {
  const required: BomSpecificationDecision[] = [];
  if (isPowerSupplyRequirement(name)) required.push(...POWER_SUPPLY_SPECIFICATION_DECISIONS);
  if (isLedResistorRequirement(name)) required.push(...LED_RESISTOR_SPECIFICATION_DECISIONS);
  if (required.length === 0) return [];
  const decisions = isRecord(specification?.decisions) ? specification.decisions : undefined;
  return required.filter((decision) => !hasText(decisions?.[decision]));
}

function stableUnionMissing(
  explicit: readonly BomSpecificationDecision[],
  derived: readonly BomSpecificationDecision[],
): readonly BomSpecificationDecision[] {
  const all = new Set([...explicit, ...derived]);
  return BOM_SPECIFICATION_DECISION_ORDER.filter((decision) => all.has(decision));
}

/**
 * Resolve requirement-level specification blockers without consulting stock.
 * The resolver intentionally keeps legacy records readable: a missing marker
 * remains sufficient for ordinary requirements, while classified requirements
 * fail closed until their mandatory decisions are resolved.
 */
export function resolveBomSpecification(line: BomSpecificationLine): ResolvedBomSpecification {
  const raw = isRecord(line.constraints) ? line.constraints.specification : undefined;
  if (raw !== undefined && !isRecord(raw)) {
    return { sufficient: false, missingDecisions: [] };
  }

  const specification = raw as Readonly<Record<string, unknown>> | undefined;
  if (specification !== undefined && !isValidSpecification(specification)) {
    return { sufficient: false, missingDecisions: [] };
  }
  const explicitMissing = Array.isArray(specification?.missingDecisions)
    ? specification.missingDecisions.filter((value): value is BomSpecificationDecision => BOM_SPECIFICATION_DECISION_ORDER.includes(value as BomSpecificationDecision))
    : [];
  const missingDecisions = stableUnionMissing(explicitMissing, derivedMissingDecisions(line.name, specification));
  const status = specification?.status;
  const sufficient = raw === undefined
    ? missingDecisions.length === 0
    : status === "sufficient" && missingDecisions.length === 0;
  return { sufficient, missingDecisions };
}
