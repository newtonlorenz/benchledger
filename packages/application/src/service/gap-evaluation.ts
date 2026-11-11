import { ApplicationError } from "../errors.js";
import { classifyEvidenceAvailability, countsAsInStock } from "@benchledger/domain";
import type { GapEvaluation } from "../ports.js";
import { bomSpecification, matchesBomConstraints } from "./bom-rules.js";
import { bomGapSchema, isUnitCompatibleWithItemKind, quantityConversionSchema } from "@benchledger/api-contract";
import type { BomGap, BomGapCandidate, BomLine, InventoryItem, Reservation, StockReceivingPolicy } from "@benchledger/api-contract";

export type BomCandidateKind = "exact" | "confirmed_alternative" | "uncertain_alternative";

export interface BomCandidate {
  readonly item: InventoryItem;
  readonly kind: BomCandidateKind;
}

export type BomQuantityConversion = NonNullable<BomLine["alternatives"][number]["quantityConversion"]>;

export function bomCandidateRelationship(kind: BomCandidateKind): BomGapCandidate["relationship"] {
  return kind;
}

export function bomCandidateAlternative(line: BomLine, itemId: string): BomLine["alternatives"][number] | undefined {
  return line.alternatives.find((alternative) => alternative.itemId === itemId);
}

/**
 * Resolve a persisted conversion only when its orientation matches the
 * inventory row and BOM line. Boundary schemas validate new writes, but live
 * gap reads also need to fail closed for older or hand-written records.
 * Conflicting conversion factors are ambiguous and therefore unusable.
 */
export function bomCandidateQuantityConversion(line: BomLine, item: InventoryItem): BomQuantityConversion | undefined {
  if (item.unit === line.unit) return undefined;
  const conversions = line.alternatives
    .filter((alternative) => alternative.itemId === item.id)
    .map((alternative) => {
      const parsed = quantityConversionSchema.safeParse(alternative.quantityConversion);
      return parsed.success && parsed.data.inventory.unit === item.unit && parsed.data.requirement.unit === line.unit
        ? parsed.data
        : undefined;
    })
    .filter((conversion): conversion is BomQuantityConversion => conversion !== undefined);
  const quantities = new Set(conversions.map((conversion) => conversion.requirement.quantity));
  if (quantities.size !== 1) return undefined;
  return conversions[0];
}

export function bomCandidateQuantityFactor(line: BomLine, item: InventoryItem): number | undefined {
  if (!isUnitCompatibleWithItemKind(item.kind, item.unit)) return undefined;
  if (item.unit === line.unit) return 1;
  return bomCandidateQuantityConversion(line, item)?.requirement.quantity;
}

export function bomCandidateHasResolvableQuantity(line: BomLine, candidate: BomCandidate): boolean {
  return bomCandidateQuantityFactor(line, candidate.item) !== undefined;
}

export function bomCandidateUsesWholeSets(line: BomLine, item: InventoryItem): boolean {
  return item.unit !== line.unit && bomCandidateQuantityConversion(line, item) !== undefined;
}

export function bomCandidateCompatibility(line: BomLine, candidate: BomCandidate): BomGapCandidate["compatibility"] {
  if (candidate.kind === "exact") return "confirmed";
  return bomCandidateAlternative(line, candidate.item.id)?.compatible ?? "unknown";
}

export function bomCandidateReason(line: BomLine, candidate: BomCandidate): string {
  const alternative = bomCandidateAlternative(line, candidate.item.id);
  const base = alternative?.reason
    ?? (candidate.kind === "exact" ? "Exact inventory item declared by the BOM."
      : candidate.kind === "confirmed_alternative" ? "Explicitly confirmed BOM alternative."
      : "Alternative compatibility is not explicitly confirmed.");
  if (!isUnitCompatibleWithItemKind(candidate.item.kind, candidate.item.unit)) {
    return `${base} Unit needs correction before this stock can be matched or reserved.`;
  }
  if (candidate.item.unit === line.unit) return base;
  const conversion = bomCandidateQuantityConversion(line, candidate.item);
  if (conversion === undefined) return `${base} No valid one-set conversion from ${candidate.item.unit} to ${line.unit} is recorded; inspect before use.`;
  return `${base} Conversion: 1 set = ${conversion.requirement.quantity} each.`;
}

/**
 * Resolve a stock row to the relationship explicitly declared by the BOM.
 * An item that merely happens to satisfy a descriptive constraint is not a
 * candidate: discovery requires an explicit item identity or alternative.
 */
export function bomCandidateKind(line: BomLine, item: InventoryItem): BomCandidateKind | undefined {
  const alternatives = line.alternatives.filter((alternative) => alternative.itemId === item.id);
  if (line.itemId === item.id) {
    // A contradictory conditional/unknown alternative must not be silently
    // upgraded to an exact, reservable match just because the same ID is also
    // present in itemId. Keep the relationship inspect-first until a human
    // resolves the compatibility decision.
    if (alternatives.some((alternative) => alternative.compatible !== "confirmed")) return "uncertain_alternative";
    return "exact";
  }
  if (alternatives.some((alternative) => alternative.compatible === "confirmed")) return "confirmed_alternative";
  if (alternatives.length > 0) return "uncertain_alternative";
  return undefined;
}

export function canSupplyBomCandidate(candidate: BomCandidate): boolean {
  return candidate.kind === "exact" || candidate.kind === "confirmed_alternative";
}

export function canReserveBomItem(line: BomLine, item: InventoryItem): boolean {
  const kind = bomCandidateKind(line, item);
  return (kind === "exact" || kind === "confirmed_alternative")
    && bomCandidateHasResolvableQuantity(line, { item, kind });
}

export function bomDecision(line: BomLine, status: BomGap["status"], sufficient: boolean, inspectQuantity: number): BomGap["decision"] {
  if (status === "supplied") return "ready";
  if (status === "inspect_first") return "check";
  if (status === "partially_supplied") return inspectQuantity > 0 ? "check" : "source";
  if (status === "specify_first") return "decide";
  if (status === "optional") return sufficient ? "source" : "decide";
  return sufficient ? "source" : "decide";
}

export function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * BOM evaluation is an allocation report, so a line must have a stable place
 * in the allocation order even when an adapter returns rows in a different
 * order. Exact references take precedence over approved alternatives; IDs then
 * provide the deterministic tie-breaker.
 */
export function bomLineAllocationPriority(line: BomLine): number {
  if (line.itemId !== undefined) return 0;
  if (line.alternatives.some((alternative) => alternative.compatible === "confirmed")) return 1;
  if (line.alternatives.length > 0) return 2;
  if (Object.keys(line.constraints ?? {}).length > 0) return 3;
  return 4;
}

export function compareBomLinesForAllocation(left: BomLine, right: BomLine): number {
  return bomLineAllocationPriority(left) - bomLineAllocationPriority(right) || compareStableId(left.id, right.id);
}

export function compareBomCandidates(left: BomCandidate, right: BomCandidate): number {
  const priority = (kind: BomCandidateKind): number => kind === "exact" ? 0 : kind === "confirmed_alternative" ? 1 : 2;
  return priority(left.kind) - priority(right.kind) || compareStableId(left.item.id, right.item.id);
}

export interface BomLineAllocation {
  readonly suppliedQuantity: number;
  readonly inspectQuantity: number;
}

/**
 * Evaluate one already-loaded snapshot. Project setup previews use this same
 * allocator with their proposed reservations, so preview and live BOM reads
 * cannot drift in candidate ordering, shared-stock allocation, or totals.
 */
export function evaluateBomGapsFromData(id: string, lines: readonly BomLine[], active: readonly InventoryItem[], reservations: readonly Reservation[], policy: StockReceivingPolicy): GapEvaluation {
  // The receiving policy decides which stored evidence counts as in stock.
  // It never changes the evidence reported on each candidate.
  const inStock = (candidate: BomCandidate): boolean => countsAsInStock(candidate.item.evidence.state, policy);
  const evidenceFacts = (candidate: BomCandidate): Pick<BomGapCandidate, "evidenceState" | "availability"> => ({
    evidenceState: candidate.item.evidence.state,
    availability: classifyEvidenceAvailability(candidate.item.evidence.state, policy),
  });
  const ownedReservations = new Map<string, number>();
  const reservedByItem = new Map<string, number>();
  for (const reservation of reservations) {
    if (reservation.status !== "active") continue;
    const key = `${reservation.lineId}\u0000${reservation.itemId}`;
    ownedReservations.set(key, (ownedReservations.get(key) ?? 0) + reservation.quantity);
    reservedByItem.set(reservation.itemId, (reservedByItem.get(reservation.itemId) ?? 0) + reservation.quantity);
  }
  const candidatesByLine = new Map<BomLine, readonly BomCandidate[]>();
  for (const line of lines) {
    const candidates = active
      // Explicit identities are retained across units so the gap can explain
      // why an alternative is blocked. Constraint-only matches are not
      // candidates: there is no discovery opt-in in the current BOM contract.
      .filter((item) => matchesBomConstraints(item, line.constraints))
      .flatMap((item): readonly BomCandidate[] => {
        const kind = bomCandidateKind(line, item);
        if (kind === undefined || (item.unit !== line.unit && line.alternatives.every((alternative) => alternative.itemId !== item.id))) return [];
        return [{ item, kind }];
      });
    candidatesByLine.set(line, candidates);
  }

  // `availableQuantity` is the unreserved quantity across all projects.
  // Keep three local ledgers so a candidate can be allocated at most once
  // across this evaluation while this revision's own reservations remain
  // available to their declaring line. The physical and reservation caps
  // also make malformed adapter data fail closed rather than count an item
  // twice.
  const remainingPhysical = new Map(active.map((item) => [item.id, Math.max(0, item.quantity)]));
  const remainingFree = new Map(active.map((item) => [item.id, Math.min(Math.max(0, item.quantity), Math.max(0, item.availableQuantity))]));
  const remainingReserved = new Map(active.map((item) => [item.id, Math.min(Math.max(0, item.quantity), Math.max(0, reservedByItem.get(item.id) ?? 0))]));
  const allocations = new Map<BomLine, BomLineAllocation>();
  const candidateFacts = new Map<string, BomGapCandidate>();
  const candidateInventoryAllocations = new Map<string, number>();
  const allocationLines = [...lines].sort(compareBomLinesForAllocation);

  const candidateCapacity = (line: BomLine, candidate: BomCandidate, mode: "confirmed" | "inspect"): number => {
    const itemId = candidate.item.id;
    const physical = remainingPhysical.get(itemId) ?? 0;
    const free = remainingFree.get(itemId) ?? 0;
    const reserved = remainingReserved.get(itemId) ?? 0;
    const own = Math.min(reserved, Math.max(0, ownedReservations.get(`${line.id}\u0000${itemId}`) ?? 0));
    // Uncounted stock may still be an inspect-first candidate even when its
    // free balance is zero, but an active reservation belongs exclusively to
    // its declaring line. Exclude reservations owned by other lines while
    // retaining the historical inspect-first treatment of otherwise
    // unavailable, unreserved physical stock.
    const inventoryCapacity = mode === "inspect"
      ? Math.min(physical, Math.max(0, physical - (reserved - own)))
      : Math.min(physical, free + own);
    const factor = bomCandidateQuantityFactor(line, candidate.item);
    if (factor === undefined) return 0;
    // A converted package is indivisible for planning/reservation purposes.
    // Fractional set rows therefore cannot create phantom individual parts.
    const wholeInventoryCapacity = bomCandidateUsesWholeSets(line, candidate.item)
      ? Math.floor(inventoryCapacity)
      : inventoryCapacity;
    return wholeInventoryCapacity * factor;
  };

  const recordCandidateFacts = (line: BomLine, candidates: readonly BomCandidate[], mode: "confirmed" | "inspect"): void => {
    for (const candidate of candidates) {
      const factKey = `${line.id}\u0000${candidate.item.id}`;
      const prior = candidateFacts.get(factKey);
      candidateFacts.set(factKey, {
        itemId: candidate.item.id,
        relationship: bomCandidateRelationship(candidate.kind),
        compatibility: bomCandidateCompatibility(line, candidate),
        availableQuantity: Math.max(prior?.availableQuantity ?? 0, candidateCapacity(line, candidate, mode)),
        suppliedQuantity: prior?.suppliedQuantity ?? 0,
        inspectQuantity: prior?.inspectQuantity ?? 0,
        reason: bomCandidateReason(line, candidate),
        ...evidenceFacts(candidate),
      });
    }
  };

  const allocate = (line: BomLine, candidates: readonly BomCandidate[], requested: number, mode: "confirmed" | "inspect"): number => {
    let remaining = requested;
    for (const candidate of [...candidates].sort(compareBomCandidates)) {
      if (remaining <= 0) break;
      const itemId = candidate.item.id;
      const physical = remainingPhysical.get(itemId) ?? 0;
      const capacity = candidateCapacity(line, candidate, mode);
      const factor = bomCandidateQuantityFactor(line, candidate.item);
      if (factor === undefined) {
        recordCandidateFacts(line, [candidate], mode);
        continue;
      }
      const free = mode === "confirmed" ? remainingFree.get(itemId) ?? 0 : 0;
      const own = mode === "confirmed"
        ? Math.min(remainingReserved.get(itemId) ?? 0, Math.max(0, ownedReservations.get(`${line.id}\u0000${itemId}`) ?? 0))
        : 0;
      const inventoryCapacity = mode === "inspect"
        ? Math.min(physical, Math.max(0, physical - (remainingReserved.get(itemId) ?? 0) + own))
        : Math.min(physical, free + own);
      const wholeInventoryCapacity = bomCandidateUsesWholeSets(line, candidate.item)
        ? Math.floor(inventoryCapacity)
        : inventoryCapacity;
      const factKey = `${line.id}\u0000${itemId}`;
      const prior = candidateFacts.get(factKey);
      const taken = Math.min(remaining, capacity);
      const requestedInventory = bomCandidateUsesWholeSets(line, candidate.item) ? Math.ceil(taken / factor) : taken;
      const takenInventory = Math.min(wholeInventoryCapacity, requestedInventory);
      const covered = Math.min(remaining, takenInventory * factor);
      candidateFacts.set(factKey, {
        itemId,
        relationship: bomCandidateRelationship(candidate.kind),
        compatibility: bomCandidateCompatibility(line, candidate),
        availableQuantity: Math.max(prior?.availableQuantity ?? 0, capacity),
        suppliedQuantity: (prior?.suppliedQuantity ?? 0) + (mode === "confirmed" ? taken : 0),
        inspectQuantity: (prior?.inspectQuantity ?? 0) + (mode === "inspect" ? covered : 0),
        reason: bomCandidateReason(line, candidate),
        ...evidenceFacts(candidate),
      });
      if (takenInventory <= 0 || covered <= 0) continue;
      if (mode === "confirmed") {
        // Consume a line's own reservation first; unreserved stock is then
        // consumed from the shared free pool for later lines.
        const fromReservation = Math.min(own, takenInventory);
        const fromFree = takenInventory - fromReservation;
        remainingReserved.set(itemId, Math.max(0, (remainingReserved.get(itemId) ?? 0) - fromReservation));
        remainingFree.set(itemId, Math.max(0, free - fromFree));
      }
      remainingPhysical.set(itemId, Math.max(0, physical - takenInventory));
      candidateInventoryAllocations.set(factKey, (candidateInventoryAllocations.get(factKey) ?? 0) + takenInventory);
      remaining -= covered;
    }
    return requested - remaining;
  };

  // Confirmed supply is allocated first, so a line that only has an
  // inspect-first relationship cannot consume capacity needed by an exact or
  // approved-alternative line later in the stable ordering.
  for (const line of allocationLines) {
    const candidates = candidatesByLine.get(line) ?? [];
    const confirmed = candidates.filter((candidate) => canSupplyBomCandidate(candidate) && inStock(candidate) && bomCandidateHasResolvableQuantity(line, candidate));
    recordCandidateFacts(line, confirmed, "confirmed");
    const suppliedQuantity = bomSpecification(line).sufficient ? allocate(line, confirmed, line.requiredQuantity, "confirmed") : 0;
    allocations.set(line, { suppliedQuantity, inspectQuantity: 0 });
  }
  for (const line of allocationLines) {
    const candidates = candidatesByLine.get(line) ?? [];
    const uncertain = candidates.filter((candidate) => !canSupplyBomCandidate(candidate) || !inStock(candidate) || !bomCandidateHasResolvableQuantity(line, candidate));
    recordCandidateFacts(line, uncertain, "inspect");
    const suppliedQuantity = allocations.get(line)?.suppliedQuantity ?? 0;
    const inspectQuantity = allocate(line, uncertain, Math.max(line.requiredQuantity - suppliedQuantity, 0), "inspect");
    allocations.set(line, { suppliedQuantity, inspectQuantity });
  }

  const gaps: BomGap[] = lines.map((line) => {
    const candidates = candidatesByLine.get(line) ?? [];
    const uncertain = candidates.filter((candidate) => !canSupplyBomCandidate(candidate) || !inStock(candidate) || !bomCandidateHasResolvableQuantity(line, candidate));
    const suppliedQuantity = allocations.get(line)?.suppliedQuantity ?? 0;
    const inspectQuantity = allocations.get(line)?.inspectQuantity ?? 0;
    const missingQuantity = Math.max(line.requiredQuantity - suppliedQuantity - inspectQuantity, 0);
    const specification = bomSpecification(line);
    // Preserve Source for an identified same-unit item with no stock. A
    // cross-unit explicit alternative is different: even with no conversion
    // capacity it remains visible as Check so the maker can resolve it.
    const uncoveredQuantity = Math.max(line.requiredQuantity - suppliedQuantity, 0);
    const inspectFirstCandidate = inspectQuantity > 0 || (uncoveredQuantity > 0 && uncertain.some((candidate) =>
      candidate.item.unit !== line.unit || !isUnitCompatibleWithItemKind(candidate.item.kind, candidate.item.unit)
    ));
    let status: BomGap["status"];
    if (line.optional && suppliedQuantity === 0 && inspectQuantity === 0) status = "optional";
    else if (inspectFirstCandidate && inspectQuantity === 0) status = "inspect_first";
    else if (!specification.sufficient && inspectQuantity === 0) status = "specify_first";
    else if (missingQuantity === 0 && inspectQuantity === 0) status = "supplied";
    else if (suppliedQuantity > 0 && missingQuantity > 0) status = "partially_supplied";
    else if (inspectQuantity > 0) status = "inspect_first";
    else status = "missing";
    const roleNeedsReview = line.role === undefined || line.role === null;
    const decision = roleNeedsReview ? "check" : bomDecision(line, status, specification.sufficient, inspectQuantity);
    const candidateResults = candidates.map((candidate) => {
      const fact = candidateFacts.get(`${line.id}\u0000${candidate.item.id}`);
      if (fact === undefined) throw new ApplicationError("integrity_error", "BOM candidate facts were not recorded");
      const conversion = bomCandidateQuantityConversion(line, candidate.item);
      if (conversion === undefined || candidate.item.unit === line.unit) return fact;
      const allocatedInventory = candidateInventoryAllocations.get(`${line.id}\u0000${candidate.item.id}`) ?? 0;
      const availableSets = Math.floor(fact.availableQuantity / conversion.requirement.quantity);
      const allocatedCoverage = allocatedInventory * conversion.requirement.quantity;
      const overage = allocatedCoverage > fact.suppliedQuantity ? allocatedCoverage - fact.suppliedQuantity : 0;
      return {
        ...fact,
        reason: `${fact.reason} Capacity: ${availableSets} set(s) = ${fact.availableQuantity} each.${allocatedInventory > 0 ? ` Allocation: ${allocatedInventory} set(s) = ${allocatedCoverage} each${overage > 0 ? `, ${overage} each overage` : ""}.` : ""}`,
      };
    });
    const reasons = [
      ...(suppliedQuantity > 0 ? [suppliedReason(line, candidates, candidateFacts, policy)] : []),
      ...(uncertain.some((candidate) => !canSupplyBomCandidate(candidate)) ? ["Some matching stock needs an explicit compatibility decision before use."] : []),
      ...(uncertain.some((candidate) => canSupplyBomCandidate(candidate) && !inStock(candidate)) ? [notInStockReason(policy)] : []),
      ...(uncertain.some((candidate) => isUnitCompatibleWithItemKind(candidate.item.kind, candidate.item.unit) && !bomCandidateHasResolvableQuantity(line, candidate)) ? ["A cross-unit alternative has no valid evidence-backed conversion; inspect before use."] : []),
      ...(uncertain.some((candidate) => !isUnitCompatibleWithItemKind(candidate.item.kind, candidate.item.unit)) ? ["Matching stock has a unit that needs correction before use."] : []),
      ...(decision === "decide" ? [`Specify ${specification.missingDecisions.join(" and ")} before sourcing this requirement.`] : []),
      ...(roleNeedsReview ? ["Requirement role is not recorded; review whether this item is consumed or reusable before reserving or closing out."] : []),
      ...(decision !== "decide" && missingQuantity > 0 ? [policy === "on_receipt" ? "No confirmed stock covers the remaining quantity." : "No in-stock quantity covers the remaining quantity."] : []),
      ...(decision !== "decide" && candidates.length === 0 ? ["No matching inventory item was found for this line."] : []),
    ];
    return bomGapSchema.parse({
      lineId: line.id,
      name: line.name,
      optional: line.optional,
      status,
      decision,
      ...(specification.missingDecisions.length === 0 ? {} : { missingDecisions: [...specification.missingDecisions] }),
      requiredQuantity: line.requiredQuantity,
      suppliedQuantity,
      inspectQuantity,
      missingQuantity,
      unit: line.unit,
      matchedItemIds: candidates.map((candidate) => candidate.item.id),
      reasons,
      alternatives: line.alternatives,
      candidates: candidateResults
    });
  });
  return {
    revisionId: id,
    lines: gaps,
    totals: {
      requiredLines: gaps.filter((gap) => gap.optional !== true).length,
      suppliedLines: gaps.filter((gap) => gap.optional !== true && gap.status === "supplied").length,
      inspectFirstLines: gaps.filter((gap) => gap.optional !== true && gap.status === "inspect_first").length,
      partialLines: gaps.filter((gap) => gap.optional !== true && gap.status === "partially_supplied").length,
      missingLines: gaps.filter((gap) => gap.optional !== true && gap.status === "missing").length,
      optionalLines: gaps.filter((gap) => gap.optional === true).length,
      readyLines: gaps.filter((gap) => gap.optional !== true && gap.decision === "ready").length,
      checkLines: gaps.filter((gap) => gap.optional !== true && gap.decision === "check").length,
      decideLines: gaps.filter((gap) => gap.optional !== true && gap.decision === "decide").length,
      sourceLines: gaps.filter((gap) => gap.optional !== true && gap.decision === "source").length,
    }
  };
}

/**
 * Explain supply honestly: stock that counts only because the receiving
 * policy trusts its delivery or purchase evidence is named as such.
 */
function suppliedReason(line: BomLine, candidates: readonly BomCandidate[], facts: ReadonlyMap<string, BomGapCandidate>, policy: StockReceivingPolicy): string {
  const assumed = candidates.some((candidate) => classifyEvidenceAvailability(candidate.item.evidence.state, policy) === "assumed"
    && (facts.get(`${line.id}\u0000${candidate.item.id}`)?.suppliedQuantity ?? 0) > 0);
  if (!assumed) return "Physically confirmed stock covers part or all of this requirement.";
  return policy === "on_purchase"
    ? "In-stock quantity covers part or all of this requirement; some of it is bought or delivered but not yet counted (receiving policy: when bought)."
    : "In-stock quantity covers part or all of this requirement; some of it is delivered but not yet counted (receiving policy: when delivered).";
}

/** Why recorded stock is not yet usable under the current policy. */
export function notInStockReason(policy: StockReceivingPolicy): string {
  return policy === "on_receipt"
    ? "Some matching stock is recorded but needs a physical count before use."
    : policy === "on_delivery"
      ? "Some matching stock is ordered but not delivered, or needs a physical count before use."
      : "Some matching stock needs a physical count before use.";
}
