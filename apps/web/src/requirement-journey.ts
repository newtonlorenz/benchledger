import type { BomLineStatus, InventoryItem, ProjectSummary } from "./domain";
import { formatQuantity } from "./domain";
import { webInventoryAssessment } from "./inventory-workspace-state";

export function projectNextAction(summary: Pick<ProjectSummary, "totalLines" | "readinessUnavailable" | "decideLines" | "inspectLines" | "sourceLines">, archived: boolean, routeUndecided: boolean, printerNeeded: boolean) {
  if (archived) return "restore";
  if (summary.totalLines === 0) return "requirements";
  if (summary.readinessUnavailable) return "refresh";
  if (summary.decideLines) return "decide";
  if (summary.inspectLines) return "check";
  if (summary.sourceLines) return "source";
  if (routeUndecided) return "approach";
  if (printerNeeded) return "printer";
  return "ready";
}

export function requirementStockReason(line: BomLineStatus): string {
  if (line.item?.unitStatus === "needs_correction") return "The stock unit needs correcting before this item can be used.";
  // The service owns readiness. Its reason remains visible in the beginner UI.
  if (line.gap?.reasons.length) return line.gap.reasons[0]!;
  if (line.line.optional) return "Optional: this requirement does not block the plan.";
  if (line.decision === "decide") return "Some specifications still need a decision before stock can be checked.";
  if (line.decision === "check") return "Check the stock quantity or compatibility before relying on this item.";
  if (line.decision === "ready") return "Confirmed stock covers this requirement. Design validation is separate.";
  return line.item ? "Confirmed stock does not cover the required quantity." : "No usable stock match is recorded. Review owned items before sourcing.";
}

export function requirementCandidateStock(item: InventoryItem): string {
  const assessment = webInventoryAssessment(item);
  if (item.tags.some((tag) => tag.toLowerCase() === "retired")) return "Retired item";
  if (assessment.unitNeedsCorrection) return "Stock unit needs correcting";
  if (assessment.needsRepair) return "Needs repair before use";
  const evidence = assessment.confirmed ? (item.evidence === "commissioned" ? "Commissioned" : "Physically counted") : "Needs a physical check";
  if (!assessment.confirmed || item.availableQuantity === undefined) return `${evidence} · ${formatQuantity(item.quantity, item.unit)} recorded; usable quantity unconfirmed`;
  return `${evidence} · ${formatQuantity(assessment.availableQuantity, item.unit)} available`;
}
