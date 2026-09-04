import { createId, nowIso, slugify } from "./ids.js";
import { DomainError, assertNonNegativeQuantity, assertPositiveQuantity } from "./errors.js";
import { classifyAvailability } from "./stock.js";
import { isLedResistorRequirement, resolveBomSpecification, type ResolvedBomSpecification } from "./specification.js";
import { cloneBomAlternativeQuantityConversion, resolveBomAlternativeQuantity } from "./quantity-conversion.js";
import { isFabricationRoute, type FabricationRoute } from "./fabrication-route.js";
import type {
  AvailabilityClass,
  BomCandidate,
  BomCompatibility,
  BomConstraints,
  BomDecision,
  BomAlternative,
  BomLine,
  BomLineEvaluation,
  BomEvaluation,
  BomSummary,
  InventoryItem,
  Project,
  ProjectStatus,
  ProjectRevision,
  Reservation,
  RevisionStatus,
  ShoppingListLine,
  StockBalance,
  WorkItem,
  WorkItemKind,
  WorkItemRevision
} from "./types.js";

export interface NewProject {
  id?: string;
  name: string;
  slug?: string;
  description?: string;
  status?: ProjectStatus;
  visibility?: Project["visibility"];
  createdAt?: string;
  updatedAt?: string;
}

export function createProject(input: NewProject): Project {
  if (!input.name.trim()) throw new DomainError("invalid_project_name", "project name is required");
  const createdAt = input.createdAt ?? nowIso();
  return {
    id: input.id ?? createId("project"),
    name: input.name.trim(),
    slug: input.slug ?? slugify(input.name),
    ...(input.description === undefined ? {} : { description: input.description }),
    status: input.status ?? "idea",
    visibility: input.visibility ?? "private",
    createdAt,
    updatedAt: input.updatedAt ?? createdAt
  };
}

export interface NewWorkItem {
  id?: string;
  projectId: string;
  name: string;
  kind: WorkItemKind;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function createWorkItem(input: NewWorkItem): WorkItem {
  if (!input.projectId.trim()) throw new DomainError("invalid_project_id", "work item projectId is required");
  if (!input.name.trim()) throw new DomainError("invalid_work_item_name", "work item name is required");
  const createdAt = input.createdAt ?? nowIso();
  return {
    id: input.id ?? createId("work"),
    projectId: input.projectId,
    name: input.name.trim(),
    kind: input.kind,
    ...(input.description === undefined ? {} : { description: input.description }),
    createdAt,
    updatedAt: input.updatedAt ?? createdAt
  };
}

export interface NewProjectRevision {
  id?: string;
  projectId: string;
  number: number;
  label?: string;
  status?: RevisionStatus;
  fabricationRoute?: FabricationRoute;
  /** Null deliberately clears an inherited printer assignment. */
  intendedPrinterItemId?: string | null;
  machineId?: string;
  material?: string;
  notes?: string;
  createdAt?: string;
  supersedesRevisionId?: string;
}

export function createProjectRevision(input: NewProjectRevision): ProjectRevision {
  if (!input.projectId.trim()) throw new DomainError("invalid_project_id", "revision projectId is required");
  if (!Number.isInteger(input.number) || input.number < 1) throw new DomainError("invalid_revision_number", "revision number must be a positive integer");
  if (input.fabricationRoute !== undefined && !isFabricationRoute(input.fabricationRoute)) throw new DomainError("invalid_fabrication_route", "fabrication route is not supported");
  if (input.intendedPrinterItemId !== undefined && input.intendedPrinterItemId !== null && (input.fabricationRoute ?? "undecided") !== "printed") throw new DomainError("invalid_printer_route", "an intended printer requires the printed fabrication route");
  if (input.intendedPrinterItemId !== undefined && input.intendedPrinterItemId !== null && !input.intendedPrinterItemId.trim()) throw new DomainError("invalid_printer_item_id", "intended printer item ID cannot be empty");
  const createdAt = input.createdAt ?? nowIso();
  return {
    id: input.id ?? createId("project-revision"),
    projectId: input.projectId,
    number: input.number,
    label: input.label ?? `r${String(input.number).padStart(2, "0")}`,
    status: input.status ?? "concept",
    fabricationRoute: input.fabricationRoute ?? "undecided",
    intendedPrinterItemId: input.intendedPrinterItemId ?? null,
    ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
    ...(input.material === undefined ? {} : { material: input.material }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    createdAt,
    ...(input.supersedesRevisionId === undefined ? {} : { supersedesRevisionId: input.supersedesRevisionId })
  };
}

export interface NewWorkItemRevision {
  id?: string;
  workItemId: string;
  number: number;
  label?: string;
  status?: RevisionStatus;
  sourcePath?: string;
  createdAt?: string;
  supersedesRevisionId?: string;
}

export function createWorkItemRevision(input: NewWorkItemRevision): WorkItemRevision {
  if (!input.workItemId.trim()) throw new DomainError("invalid_work_item_id", "work item revision workItemId is required");
  if (!Number.isInteger(input.number) || input.number < 1) throw new DomainError("invalid_revision_number", "revision number must be a positive integer");
  const createdAt = input.createdAt ?? nowIso();
  return {
    id: input.id ?? createId("work-revision"),
    workItemId: input.workItemId,
    number: input.number,
    label: input.label ?? `r${String(input.number).padStart(2, "0")}`,
    status: input.status ?? "concept",
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
    createdAt,
    ...(input.supersedesRevisionId === undefined ? {} : { supersedesRevisionId: input.supersedesRevisionId })
  };
}

export function nextRevisionNumber(revisions: readonly { number: number }[]): number {
  return revisions.reduce((highest, revision) => Math.max(highest, revision.number), 0) + 1;
}

export interface NewBomLine {
  id?: string;
  revisionId: string;
  name: string;
  quantity: number;
  unit: BomLine["unit"];
  role?: BomLine["role"];
  required?: boolean;
  optional?: boolean;
  itemId?: string;
  alternativeItemIds?: readonly string[];
  alternatives?: readonly BomAlternative[];
  constraints?: BomConstraints;
  notes?: string;
}

export function createBomLine(input: NewBomLine): BomLine {
  if (!input.revisionId.trim()) throw new DomainError("invalid_revision_id", "BOM line revisionId is required");
  if (!input.name.trim()) throw new DomainError("invalid_bom_name", "BOM line name is required");
  assertPositiveQuantity(input.quantity, "BOM line quantity");
  if (input.constraints?.category === "printer") {
    throw new DomainError("printer_requirement_not_allowed", "Printers are selected through build configuration, not BOM requirements");
  }
  const rawSpecification = input.constraints?.specification;
  const resolvedSpecification = resolveBomSpecification({ name: input.name, constraints: input.constraints });
  if (isLedResistorRequirement(input.name) && rawSpecification?.status === "sufficient" && !resolvedSpecification.sufficient) {
    throw new DomainError("invalid_bom_specification", "A sufficient LED resistor requirement must resolve resistance and power_rating.");
  }
  const writtenConstraints = isLedResistorRequirement(input.name) && rawSpecification === undefined
    ? { ...(input.constraints ?? {}), specification: { status: "insufficient" as const, missingDecisions: [...resolvedSpecification.missingDecisions] } }
    : input.constraints;
  return {
    id: input.id ?? createId("bom"),
    revisionId: input.revisionId,
    name: input.name.trim(),
    quantity: input.quantity,
    unit: input.unit,
    ...(input.role === undefined ? {} : { role: input.role }),
    required: input.required ?? !input.optional,
    ...(input.optional === undefined ? {} : { optional: input.optional }),
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
    ...(input.alternativeItemIds === undefined ? {} : { alternativeItemIds: input.alternativeItemIds.slice() }),
    ...(input.alternatives === undefined ? {} : { alternatives: input.alternatives.map((alternative) => ({
      ...alternative,
      ...(alternative.quantityConversion === undefined ? {} : { quantityConversion: cloneBomAlternativeQuantityConversion(alternative.quantityConversion) }),
      ...(alternative.constraints === undefined ? {} : { constraints: { ...alternative.constraints, ...(alternative.constraints.tags === undefined ? {} : { tags: alternative.constraints.tags.slice() }) } })
    })) }),
    ...(writtenConstraints === undefined ? {} : { constraints: { ...writtenConstraints, ...(writtenConstraints.tags === undefined ? {} : { tags: writtenConstraints.tags.slice() }) } }),
    ...(input.notes === undefined ? {} : { notes: input.notes })
  };
}

export interface InventorySnapshot {
  item: InventoryItem;
  balance: StockBalance;
}

function textIncludes(value: string | undefined, expected: string): boolean {
  return value?.toLocaleLowerCase().includes(expected.toLocaleLowerCase()) ?? false;
}

const SUPPORTED_BOM_CONSTRAINT_KEYS = new Set(["category", "manufacturer", "model", "variantIncludes", "machineId", "dimensions", "tags", "specification"]);
const SUPPORTED_DIMENSION_CONSTRAINT_KEYS = new Set(["width", "height", "depth", "diameter", "unit", "kind", "uncertainty", "source"]);

export function matchesConstraints(item: InventoryItem, constraints: BomConstraints | undefined): boolean {
  if (constraints === undefined) return true;
  if (constraints === null || typeof constraints !== "object" || Array.isArray(constraints)) return false;
  if (Object.keys(constraints).some((key) => !SUPPORTED_BOM_CONSTRAINT_KEYS.has(key))) return false;
  // Specification decisions describe the requirement and are intentionally
  // not treated as evidence that an inventory item matches it.
  if (constraints.category !== undefined && item.category !== constraints.category) return false;
  if (constraints.manufacturer !== undefined && !textIncludes(item.manufacturer, constraints.manufacturer)) return false;
  if (constraints.model !== undefined && !textIncludes(item.model, constraints.model)) return false;
  if (constraints.variantIncludes !== undefined && !textIncludes(item.variant, constraints.variantIncludes)) return false;
  if (constraints.machineId !== undefined && !textIncludes(item.notes, constraints.machineId)) return false;
  if (constraints.tags !== undefined && constraints.tags.length > 0 && !constraints.tags.every((tag) => textIncludes(item.notes, tag) || textIncludes(item.variant, tag))) return false;
  if (constraints.dimensions !== undefined && item.dimensions !== undefined) {
    const expected = constraints.dimensions;
    const actual = item.dimensions;
    if (expected === null || typeof expected !== "object" || Array.isArray(expected)) return false;
    if (Object.keys(expected).some((key) => !SUPPORTED_DIMENSION_CONSTRAINT_KEYS.has(key))) return false;
    if (expected.width !== undefined && actual.width !== expected.width) return false;
    if (expected.height !== undefined && actual.height !== expected.height) return false;
    if (expected.depth !== undefined && actual.depth !== expected.depth) return false;
    if (expected.diameter !== undefined && actual.diameter !== expected.diameter) return false;
    if (expected.unit !== undefined && actual.unit !== expected.unit) return false;
    if (expected.kind !== undefined && actual.kind !== expected.kind) return false;
    if (expected.uncertainty !== undefined && actual.uncertainty !== expected.uncertainty) return false;
    if (expected.source !== undefined && actual.source !== expected.source) return false;
  } else if (constraints.dimensions !== undefined) {
    return false;
  }
  return true;
}

function candidateReason(line: BomLine, item: InventoryItem): string {
  if (line.itemId === item.id) return "Exact inventory item requested by the BOM.";
  if (line.alternativeItemIds?.includes(item.id) === true || line.alternatives?.some((alternative) => alternative.itemId === item.id) === true) return "Explicit BOM alternative matches this inventory item.";
  return "Name/category and declared constraints match the BOM requirement.";
}

function candidateCompatibility(line: BomLine, itemId: string): BomCompatibility | undefined {
  const alternatives = line.alternatives?.filter((alternative) => alternative.itemId === itemId) ?? [];
  if (alternatives.some((alternative) => alternative.compatible === "conditional" || alternative.compatible === "unknown")) return "conditional";
  return alternatives.some((alternative) => alternative.compatible === "confirmed") ? "confirmed" : undefined;
}

function candidateQuantity(line: BomLine, candidate: BomCandidate): number | undefined {
  const alternatives = line.alternatives?.filter((alternative) => alternative.itemId === candidate.item.id) ?? [];
  if (candidate.item.unit === line.unit) return candidate.balance.available;
  for (const alternative of alternatives) {
    const quantity = resolveBomAlternativeQuantity({
      inventoryQuantity: candidate.balance.available,
      inventoryUnit: candidate.item.unit,
      requirementUnit: line.unit,
      conversion: alternative.quantityConversion
    });
    if (quantity !== undefined) return quantity;
  }
  return undefined;
}

function candidatesForLine(line: BomLine, inventory: readonly InventorySnapshot[]): BomCandidate[] {
  // An explicit item ID is an identity constraint, not a hint. Pooling another
  // similarly named SKU into that line can make a partial/inspect-first
  // requirement appear fully supplied. Descriptive matching is reserved for
  // BOM lines that intentionally specify only a name/category constraint.
  const explicitItemIds = new Set<string>([
    ...(line.itemId === undefined ? [] : [line.itemId]),
    ...(line.alternativeItemIds ?? []),
    ...(line.alternatives ?? []).flatMap((alternative) => alternative.itemId === undefined ? [] : [alternative.itemId])
  ]);
  const hasExplicitItemIds = explicitItemIds.size > 0;
  return inventory
    .filter(({ item }) => {
      const explicitlyListed = explicitItemIds.has(item.id);
      const descriptiveMatch = textIncludes(item.name, line.name) || textIncludes(line.name, item.name) || (line.constraints?.category !== undefined && item.category === line.constraints.category);
      return (hasExplicitItemIds ? explicitlyListed : descriptiveMatch) && matchesConstraints(item, line.constraints);
    })
    .map(({ item, balance }): BomCandidate => {
      const compatibility = candidateCompatibility(line, item.id);
      return {
        item,
        balance,
        reason: candidateReason(line, item),
        ...(compatibility === undefined ? {} : { compatibility })
      };
    });
}

function chooseCandidate(line: BomLine, candidates: readonly BomCandidate[]): BomCandidate | undefined {
  return candidates
    .slice()
    .sort((a, b) => {
      const aExact = line.itemId === a.item.id ? 0 : 1;
      const bExact = line.itemId === b.item.id ? 0 : 1;
      return aExact - bExact || b.balance.available - a.balance.available || a.item.id.localeCompare(b.item.id);
    })[0];
}

function candidateIsConfirmed(line: BomLine, candidate: BomCandidate): boolean {
  return candidate.balance.confidence === "confirmed"
    && (candidate.compatibility === undefined || candidate.compatibility === "confirmed")
    && candidateQuantity(line, candidate) !== undefined;
}

function evaluateCandidates(line: BomLine, candidates: readonly BomCandidate[]): Pick<BomLineEvaluation, "status" | "supplied" | "shortfall" | "explanation" | "selected"> {
  const confirmed = candidates.filter((candidate) => candidateIsConfirmed(line, candidate));
  const uncertain = candidates.filter((candidate) => !candidateIsConfirmed(line, candidate));
  const confirmedQuantity = confirmed.reduce((total, candidate) => total + (candidateQuantity(line, candidate) ?? 0), 0);
  const reportedUncertain = uncertain.reduce((total, candidate) => total + (candidate.balance.reported ?? candidate.balance.available), 0);
  const selected = chooseCandidate(line, candidates);
  const shortfall = Math.max(0, line.quantity - Math.min(line.quantity, confirmedQuantity));
  if (confirmedQuantity >= line.quantity) {
    return {
      status: "available",
      supplied: line.quantity,
      shortfall: 0,
      ...(selected === undefined ? {} : { selected }),
      explanation: "Physically confirmed stock across the matching candidates covers the requirement."
    };
  }
  if (confirmedQuantity > 0) {
    return {
      status: "partial",
      supplied: confirmedQuantity,
      shortfall,
      ...(selected === undefined ? {} : { selected }),
      explanation: `Only ${confirmedQuantity} confirmed unit(s) remain across the matching candidates; ${shortfall} more are needed.`
    };
  }
  if (reportedUncertain > 0 || uncertain.length > 0) {
    return {
      status: "inspect-first",
      supplied: 0,
      shortfall: line.quantity,
      ...(selected === undefined ? {} : { selected }),
      explanation: "Matching order or delivery evidence exists, but current quantity or condition needs a physical check."
    };
  }
  return {
    status: "missing",
    supplied: 0,
    shortfall: line.quantity,
    explanation: "No confirmed stock remains."
  };
}

function specificationForLine(line: BomLine): ResolvedBomSpecification {
  return resolveBomSpecification(line);
}

function decisionForLine(line: BomLine, status: BomLineEvaluation["status"], sufficient: boolean, needsCheck: boolean): BomDecision {
  if (status === "available") return "ready";
  if (status === "inspect-first") return "check";
  if (status === "partial") return needsCheck ? "check" : "source";
  if (status === "specify-first") return "decide";
  return sufficient ? "source" : "decide";
}

function shoppingLine(line: BomLineEvaluation): ShoppingListLine | undefined {
  if (line.line.optional === true || line.line.required === false || line.decision !== "source") return undefined;
  if (line.status === "missing") {
    return {
      bomLineId: line.line.id,
      name: line.line.name,
      quantity: line.line.quantity,
      unit: line.line.unit,
      reason: "required",
      candidateItemIds: line.candidates.map((candidate) => candidate.item.id)
    };
  }
  if (line.status === "partial") {
    return {
      bomLineId: line.line.id,
      name: line.line.name,
      quantity: line.shortfall,
      unit: line.line.unit,
      reason: "partial",
      candidateItemIds: line.candidates.map((candidate) => candidate.item.id)
    };
  }
  return undefined;
}

export function evaluateBom(
  lines: readonly BomLine[],
  inventory: readonly InventorySnapshot[],
  estimatedMissingCostMinor?: ReadonlyMap<string, number>
): BomEvaluation {
  const evaluations = lines.map((line): BomLineEvaluation => {
    const candidates = candidatesForLine(line, inventory);
    const selected = chooseCandidate(line, candidates);
    const specification = specificationForLine(line);
    const availability: Pick<BomLineEvaluation, "status" | "supplied" | "shortfall" | "explanation" | "selected"> = selected === undefined
      ? (() => {
          const missing = classifyAvailability({ required: line.quantity, available: 0, confidence: "unknown", candidate: false });
          return { status: missing.status, supplied: missing.supplied, shortfall: missing.shortfall, explanation: missing.explanation };
        })()
      : evaluateCandidates(line, candidates);
    const uncertainCandidate = candidates.some((candidate) => !candidateIsConfirmed(line, candidate));
    const gatedAvailability = !specification.sufficient
      ? uncertainCandidate
        ? {
            status: "inspect-first" as const,
            supplied: 0,
            shortfall: line.quantity,
            ...(selected === undefined ? {} : { selected }),
            explanation: "A matching item needs a physical or compatibility check before the requirement can proceed."
          }
        : {
            status: "specify-first" as const,
            supplied: 0,
            shortfall: line.quantity,
            ...(selected === undefined ? {} : { selected }),
            explanation: "Resolve the requirement decisions before sourcing or reserving an item."
          }
      : availability;
    const isOptional = line.optional === true || line.required === false;
    const status = isOptional && (gatedAvailability.status === "missing" || gatedAvailability.status === "specify-first")
      ? "optional" as const
      : gatedAvailability.status;
    return {
      line,
      status,
      decision: decisionForLine(line, status, specification.sufficient, uncertainCandidate),
      ...(specification.missingDecisions.length === 0 ? {} : { missingDecisions: specification.missingDecisions.slice() }),
      supplied: status === "optional" ? availability.supplied : gatedAvailability.supplied,
      shortfall: status === "optional" ? availability.shortfall : gatedAvailability.shortfall,
      candidates,
      ...(gatedAvailability.selected === undefined ? {} : { selected: gatedAvailability.selected }),
      explanation: gatedAvailability.selected === undefined ? gatedAvailability.explanation : `${gatedAvailability.explanation} ${gatedAvailability.selected.reason}`
    };
  });
  const summary: BomSummary = {
    totalLines: evaluations.length,
    availableLines: evaluations.filter((line) => line.status === "available" && line.line.optional !== true && line.line.required !== false).length,
    inspectFirstLines: evaluations.filter((line) => line.status === "inspect-first" && line.line.optional !== true && line.line.required !== false).length,
    partialLines: evaluations.filter((line) => line.status === "partial" && line.line.optional !== true && line.line.required !== false).length,
    missingLines: evaluations.filter((line) => line.status === "missing" && line.line.optional !== true && line.line.required !== false).length,
    optionalMissingLines: evaluations.filter((line) => line.status === "optional" && line.supplied < line.line.quantity).length,
    optionalLines: evaluations.filter((line) => line.line.optional === true || line.line.required === false).length,
    readyLines: evaluations.filter((line) => line.line.optional !== true && line.line.required !== false && line.decision === "ready").length,
    checkLines: evaluations.filter((line) => line.line.optional !== true && line.line.required !== false && line.decision === "check").length,
    decideLines: evaluations.filter((line) => line.line.optional !== true && line.line.required !== false && line.decision === "decide").length,
    sourceLines: evaluations.filter((line) => line.decision === "source" && line.line.optional !== true && line.line.required !== false).length,
    ...(estimatedMissingCostMinor === undefined ? {} : { estimatedMissingCostMinor: evaluations.reduce((total, line) => total + (line.line.optional === true || line.line.required === false ? 0 : (estimatedMissingCostMinor.get(line.line.id) ?? 0)), 0) })
  };
  return {
    revisionId: lines[0]?.revisionId ?? "",
    lines: evaluations,
    summary,
    shoppingList: evaluations.flatMap((line) => {
      const shopping = shoppingLine(line);
      return shopping === undefined ? [] : [shopping];
    })
  };
}

export interface ReserveStockInput {
  id?: string;
  projectRevisionId: string;
  bomLineId: string;
  itemId: string;
  quantity: number;
  createdAt?: string;
}

export function activeReservedQuantity(reservations: readonly Reservation[], itemId: string): number {
  return reservations
    .filter((reservation) => reservation.itemId === itemId && reservation.status === "active")
    .reduce((total, reservation) => total + reservation.quantity, 0);
}

export function createReservation(
  input: ReserveStockInput,
  balance: StockBalance,
  existingReservations: readonly Reservation[] = []
): Reservation {
  if (!input.projectRevisionId.trim() || !input.bomLineId.trim() || !input.itemId.trim()) throw new DomainError("invalid_reservation_reference", "reservation references are required");
  assertPositiveQuantity(input.quantity, "reservation quantity");
  const alreadyReserved = activeReservedQuantity(existingReservations, input.itemId);
  if (alreadyReserved + input.quantity > balance.onHand) {
    throw new DomainError("insufficient_stock", `cannot reserve ${input.quantity}; only ${Math.max(0, balance.onHand - alreadyReserved)} unallocated unit(s) remain`);
  }
  const createdAt = input.createdAt ?? nowIso();
  return {
    id: input.id ?? createId("reservation"),
    projectRevisionId: input.projectRevisionId,
    bomLineId: input.bomLineId,
    itemId: input.itemId,
    quantity: input.quantity,
    status: "active",
    createdAt
  };
}

export function releaseReservation(reservation: Reservation, releasedAt = nowIso()): Reservation {
  if (reservation.status !== "active") throw new DomainError("reservation_not_active", "only an active reservation can be released");
  return { ...reservation, status: "released", releasedAt };
}

export function consumeReservation(reservation: Reservation): Reservation {
  if (reservation.status !== "active") throw new DomainError("reservation_not_active", "only an active reservation can be consumed");
  return { ...reservation, status: "consumed" };
}

/** Settle a reservation as part of the review-first close-out aggregate. */
export function settleReservation(reservation: Reservation, settledAt = nowIso()): Reservation {
  if (reservation.status !== "active") throw new DomainError("reservation_not_active", "only an active reservation can be settled");
  return { ...reservation, status: "settled", releasedAt: settledAt };
}
