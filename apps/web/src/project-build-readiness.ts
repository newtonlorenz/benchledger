import { isExactProductIdentityComplete } from "./domain";
import type { FabricationRoute, Project, InventoryItem } from "./domain";

export function projectFabricationRoute(project: Project): FabricationRoute {
  if (project.fabricationRoute) return project.fabricationRoute;
  if (project.intendedPrinterItemId !== undefined) return project.intendedPrinterItemId ? "printed" : "undecided";
  return project.buildConfigSnapshot?.printerItemId ? "printed" : "undecided";
}

export function projectIntendedPrinterId(project: Project): string | undefined {
  if (project.intendedPrinterItemId !== undefined) return project.intendedPrinterItemId ?? undefined;
  return project.fabricationRoute === undefined ? project.buildConfigSnapshot?.printerItemId : undefined;
}

/** Shared UI eligibility for choosing an owned printer, not physical build validation. */
export function isUsableOwnedPrinter(item: InventoryItem): boolean {
  const evidence = item.serverEvidence ?? item.evidence;
  const retired = (item as InventoryItem & { retired?: boolean }).retired === true || item.tags.some((tag) => tag.toLocaleLowerCase() === "retired");
  const availableQuantity = item.availableQuantity ?? Math.max(item.quantity - item.reserved, 0);
  const profileMatchesItem = item.productProfile?.inventoryItemId === item.id
    && item.productProfile.catalogProductId === item.catalogProduct?.id
    && item.productProfile.linkState === "confirmed"
    && (item.productProfile.profileType === "printer_asset" || item.productProfile.printer !== undefined);
  return item.category === "Printers" && !retired && item.unit === "each" && item.unitStatus !== "needs_correction"
    && item.quantity > 0 && availableQuantity > 0 && (evidence === "physically_counted" || evidence === "commissioned")
    && item.catalogProduct?.kind === "printer" && isExactProductIdentityComplete(item) && profileMatchesItem;
}
