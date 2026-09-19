/** Stock views describe evidence and balances, never project compatibility. */
export const inventoryStockViews = ["available", "check", "reserved", "depleted"] as const;
export type InventoryStockView = typeof inventoryStockViews[number];
export const inventorySortOrders = ["name", "name_desc", "location"] as const;
export type InventorySortOrder = typeof inventorySortOrders[number];

export interface InventoryStockRecord {
  quantity: number;
  availableQuantity?: number | undefined;
  allocatedQuantity?: number | undefined;
  evidence: { state: string };
  unitStatus?: string | undefined;
  condition?: string | undefined;
  retiredAt?: string | undefined;
}

export function inventoryStockAssessment(item: InventoryStockRecord) {
  const confirmed = ["physically_counted", "commissioned"].includes(item.evidence.state);
  const unitNeedsCorrection = item.unitStatus === "needs_correction";
  const needsRepair = item.condition === "needs_repair";
  const retired = item.retiredAt !== undefined;
  const availableQuantity = Math.max(0, Math.min(item.quantity, item.availableQuantity ?? 0));
  const allocatedQuantity = item.allocatedQuantity ?? (confirmed && item.availableQuantity !== undefined ? Math.max(0, item.quantity - availableQuantity) : 0);
  const depleted = item.quantity === 0 && (confirmed || item.evidence.state === "consumed");
  return {
    confirmed,
    available: !retired && confirmed && !unitNeedsCorrection && !needsRepair && availableQuantity > 0,
    check: !retired && (unitNeedsCorrection || needsRepair || (confirmed && item.availableQuantity === undefined) || (!confirmed && !depleted)),
    reserved: !retired && allocatedQuantity > 0,
    depleted: !retired && depleted,
    availableQuantity,
    allocatedQuantity,
    unitNeedsCorrection,
    needsRepair,
  };
}

export function matchesInventoryStockView(item: InventoryStockRecord, view?: InventoryStockView): boolean {
  return view === undefined || inventoryStockAssessment(item)[view];
}

export function compareInventoryRecords(
  left: { id: string; name: string; location?: string | undefined },
  right: { id: string; name: string; location?: string | undefined },
  order: InventorySortOrder = "name",
): number {
  const compareText = (a: string, b: string) => a.trim().toLocaleLowerCase().localeCompare(b.trim().toLocaleLowerCase()) || a.localeCompare(b);
  const name = compareText(left.name, right.name) || left.id.localeCompare(right.id);
  if (order === "location") return compareText(left.location ?? "", right.location ?? "") || name;
  return order === "name_desc" ? -name : name;
}
