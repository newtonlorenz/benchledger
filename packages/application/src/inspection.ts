import { createHash } from "node:crypto";
import {
  inspectionActionSchema,
  quantityConversionSchema,
  type BomGap,
  type BomLine,
  type InspectionAction,
  type InventoryItem,
} from "@benchledger/api-contract";

const CONFIRMED_EVIDENCE = new Set(["physically_counted", "commissioned"]);
const PHYSICAL_COMPATIBILITY_CONSTRAINT_KEYS = new Set([
  "kind", "manufacturer", "model", "sku", "tag", "nameIncludes", "specification",
]);

function physicalCompatibilityConstraints(constraints: BomLine["constraints"]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(constraints ?? {})
    .filter(([key]) => PHYSICAL_COMPATIBILITY_CONSTRAINT_KEYS.has(key)));
}

/** Canonical JSON used for action identity and for predicates shown to callers. */
export function canonicalizeInspectionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeInspectionValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeInspectionValue(child)]));
  }
  return value;
}

export function normalizeInspectionPredicate(value: unknown): string {
  return JSON.stringify(canonicalizeInspectionValue(value));
}

export function hashInspectionBasis(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeInspectionValue(value))).digest("hex");
}

/**
 * The ID intentionally excludes line IDs and versions. Identical questions
 * over shared stock therefore become one action with an aggregated line basis.
 */
export function inspectionActionId(
  projectRevisionId: string,
  itemId: string,
  kind: InspectionAction["kind"],
  normalizedPredicate: string,
): string {
  return createHash("sha256")
    .update(`${projectRevisionId}\u0000${itemId}\u0000${kind}\u0000${normalizedPredicate}`)
    .digest("hex");
}

interface ActionDraft {
  readonly id: string;
  readonly projectRevisionId: string;
  readonly itemId: string;
  readonly itemVersion: number;
  readonly kind: InspectionAction["kind"];
  readonly normalizedPredicate: string;
  readonly question: string;
  readonly itemUnit: InspectionAction["itemUnit"];
  readonly expectedUnit: InspectionAction["expectedUnit"];
  compatibility: InspectionAction["compatibility"];
  readonly lineIds: Set<string>;
  readonly lineVersions: Map<string, number>;
  readonly lineRequirements: Map<string, { readonly quantity: number; readonly unit: BomLine["unit"] }>;
  readonly candidate: InventoryItem;
  expectedQuantity: number;
  version: number;
}

function addDraft(
  drafts: Map<string, ActionDraft>,
  revisionId: string,
  item: InventoryItem,
  line: BomLine,
  kind: InspectionAction["kind"],
  predicateInput: unknown,
  compatibility: InspectionAction["compatibility"],
  question: string,
): void {
  const normalizedPredicate = normalizeInspectionPredicate(predicateInput);
  const id = inspectionActionId(revisionId, item.id, kind, normalizedPredicate);
  const prior = drafts.get(id);
  if (prior !== undefined) {
    prior.lineIds.add(line.id);
    prior.lineVersions.set(line.id, line.version);
    prior.lineRequirements.set(line.id, { quantity: line.requiredQuantity, unit: line.unit });
    // A deduplicated action represents one physical question over shared
    // stock. Keep each requirement separately, while making the aggregate
    // expected quantity additive rather than accidentally choosing the
    // largest label/quantity-bearing line.
    prior.expectedQuantity += line.requiredQuantity;
    if (prior.compatibility !== compatibility) {
      prior.compatibility = prior.compatibility === "unknown" || compatibility === "unknown" ? "unknown" : "conditional";
    }
    prior.version = Math.max(prior.version, line.version, item.version);
    return;
  }
  drafts.set(id, {
    id,
    projectRevisionId: revisionId,
    itemId: item.id,
    itemVersion: item.version,
    kind,
    normalizedPredicate,
    question,
    itemUnit: item.unit,
    expectedUnit: kind === "physical_quantity" ? item.unit : line.unit,
    compatibility,
    lineIds: new Set([line.id]),
    lineVersions: new Map([[line.id, line.version]]),
    lineRequirements: new Map([[line.id, { quantity: line.requiredQuantity, unit: line.unit }]]),
    candidate: item,
    expectedQuantity: line.requiredQuantity,
    version: Math.max(item.version, line.version),
  });
}

/**
 * Derive the inspection queue exclusively from evaluated Check gaps. Decide,
 * Source, and Ready lines cannot create actions, and no action row is stored.
 */
export function deriveInspectionActions(
  projectRevisionId: string,
  gaps: readonly BomGap[],
  lines: readonly BomLine[],
  inventory: readonly InventoryItem[],
): readonly InspectionAction[] {
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const itemById = new Map(inventory.map((item) => [item.id, item]));
  const drafts = new Map<string, ActionDraft>();

  for (const gap of gaps) {
    // `decision` is the canonical beginner-facing state. Never derive an
    // inspection from a missing/legacy decision or from a Decide line.
    if (gap.decision !== "check") continue;
    const line = lineById.get(gap.lineId);
    if (line === undefined || line.retiredAt !== undefined) continue;
    for (const candidate of gap.candidates) {
      const item = itemById.get(candidate.itemId);
      if (item === undefined || item.retiredAt !== undefined) continue;
      const crossUnit = item.unit !== line.unit;
      const uncertainQuantity = !CONFIRMED_EVIDENCE.has(item.evidence.state);

      if (uncertainQuantity && candidate.inspectQuantity > 0) {
        addDraft(
          drafts,
          projectRevisionId,
          item,
          line,
          "physical_quantity",
          { kind: "physical_quantity", itemUnit: item.unit },
          candidate.compatibility,
          `Count ${item.name} in ${item.unit}.`,
        );
      }

      // A compatibility question is distinct from a count. It is only
      // actionable for an explicitly uncertain candidate and never invents a
      // tolerance or a missing specification decision.
      // A compatibility completion targets an existing alternative when one
      // is present. For a constraint-only candidate the confirmed observation
      // is the explicit human act that creates that alternative.
      if (candidate.compatibility !== "confirmed" && candidate.inspectQuantity > 0) {
        addDraft(
          drafts,
          projectRevisionId,
          item,
          line,
          "compatibility",
          // Identity is a physical predicate only. Labels, quantities,
          // candidate state, and line IDs are aggregated outside the key.
          {
            kind: "compatibility",
            itemUnit: item.unit,
            requirementUnit: line.unit,
            constraints: physicalCompatibilityConstraints(line.constraints),
          },
          candidate.compatibility,
          `Confirm that ${item.name} is compatible with ${line.name}.`,
        );
      }

      // The evaluator retains explicit cross-unit candidates as Check even
      // when no conversion is recorded. This action asks for that conversion
      // evidence; it does not assume a factor or alter the BOM.
      const conversionQuantities = line.alternatives.flatMap((alternative) => {
        if (alternative.itemId !== item.id) return [];
        const parsed = quantityConversionSchema.safeParse(alternative.quantityConversion);
        return parsed.success && parsed.data.inventory.unit === item.unit && parsed.data.requirement.unit === line.unit ? [parsed.data.requirement.quantity] : [];
      });
      const hasValidConversion = conversionQuantities.length > 0 && new Set(conversionQuantities).size === 1;
      if (crossUnit && !hasValidConversion) {
        addDraft(
          drafts,
          projectRevisionId,
          item,
          line,
          "unit_conversion",
          { kind: "unit_conversion", itemUnit: item.unit, requirementUnit: line.unit },
          candidate.compatibility,
          `Confirm the conversion from ${item.unit} to ${line.unit} for ${item.name}.`,
        );
      }
    }
  }

  return [...drafts.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((draft) => inspectionActionSchema.parse({
      id: draft.id,
      projectRevisionId: draft.projectRevisionId,
      itemId: draft.itemId,
      itemVersion: draft.itemVersion,
      kind: draft.kind,
      normalizedPredicate: draft.normalizedPredicate,
      question: draft.question,
      itemUnit: draft.itemUnit,
      expectedUnit: draft.expectedUnit,
      compatibility: draft.compatibility,
      lineIds: [...draft.lineIds].sort(),
      lineVersions: [...draft.lineVersions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([lineId, version]) => ({ lineId, version })),
      version: draft.version,
      candidate: {
        id: draft.candidate.id,
        version: draft.candidate.version,
        name: draft.candidate.name,
        unit: draft.candidate.unit,
        evidence: draft.candidate.evidence,
      },
      expected: {
        quantity: draft.expectedQuantity,
        unit: draft.kind === "physical_quantity" ? draft.itemUnit : draft.expectedUnit,
        lineIds: [...draft.lineIds].sort(),
        lineRequirements: [...draft.lineRequirements.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([lineId, requirement]) => ({ lineId, ...requirement })),
      },
      // Only a quantity count can authorize a stock projection. Compatibility
      // and conversion observations remain append-only evidence and therefore
      // expose the safe inconclusive outcome only.
      possibleResults: ["confirmed", "inconclusive"],
      effects: [{
        kind: draft.kind,
        description: draft.kind === "physical_quantity"
          ? "A confirmed observation may update the append-only physical quantity evidence and stock balance."
          : draft.kind === "compatibility"
            ? "A confirmed observation updates every affected explicit alternative to compatible=confirmed and appends evidence."
            : "A confirmed observation applies the explicit evidence-backed quantity conversion to every affected alternative and appends evidence.",
      }],
      basis: {
        itemVersion: draft.itemVersion,
        lineVersions: [...draft.lineVersions.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([lineId, version]) => ({ lineId, version })),
      },
      requiresHumanConfirmation: true,
    }));
}

export function pageInspectionActions(
  actions: readonly InspectionAction[],
  limit: number,
  cursor?: string,
): { readonly data: readonly InspectionAction[]; readonly nextCursor?: string; readonly limit: number; readonly total: number } {
  const start = cursor === undefined ? 0 : actions.findIndex((action) => action.id > cursor);
  if (cursor !== undefined && start < 0) return { data: [], limit, total: actions.length };
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const page = actions.slice(start, start + boundedLimit);
  const last = page.at(-1);
  return {
    data: page,
    ...(last !== undefined && start + page.length < actions.length ? { nextCursor: last.id } : {}),
    limit: boundedLimit,
    total: actions.length,
  };
}
