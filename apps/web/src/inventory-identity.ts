import type { InventoryItem } from "./domain";

export function inventoryDiscriminator(item: InventoryItem, expert = false): string {
  const filament = item.productProfile?.filament;
  const printer = item.productProfile?.printer;
  const colour = item.catalogProduct?.colourName ?? item.catalogProduct?.colour ?? item.catalogProduct?.color;
  const catalogVariant = item.catalogProduct?.exactVariant ?? item.catalogProduct?.variant;
  const lot = filament?.lotBatch ?? filament?.lot ?? filament?.batch ?? filament?.lotCode;
  const asset = printer?.assetLabel ?? printer?.placement ?? printer?.location;
  const location = item.location?.trim() && item.location.trim().toLocaleLowerCase() !== "unassigned" ? item.location.trim() : undefined;
  const generic = new Set([item.name, item.kind, item.category].filter(Boolean).map((value) => String(value).toLocaleLowerCase()));
  const variant = item.variant?.trim() && !generic.has(item.variant.trim().toLocaleLowerCase()) ? item.variant.trim() : undefined;
  const parts = [colour, catalogVariant, lot, asset, location, item.sku?.trim(), item.catalogProduct?.productCode, variant, expert ? item.provenance?.source?.trim() : undefined]
    .filter((part): part is string => Boolean(part));
  return [...new Set(parts)].slice(0, 2).join(" · ") || (expert ? item.id : "Physical item");
}

export function inventoryCandidateLabel(item: InventoryItem, items: readonly InventoryItem[], expert = false): { name: string; discriminator?: string } {
  const duplicates = items.filter((candidate) => candidate.name.trim().toLocaleLowerCase() === item.name.trim().toLocaleLowerCase()).sort((left, right) => left.id.localeCompare(right.id));
  if (duplicates.length < 2) return { name: item.name };
  const evidence = inventoryDiscriminator(item, expert);
  const sameEvidence = duplicates.filter((candidate) => inventoryDiscriminator(candidate, expert) === evidence);
  if (sameEvidence.length === 1) return { name: item.name, discriminator: evidence };
  if (expert) return { name: item.name, discriminator: `${evidence} · ${item.id}` };
  const ordinal = Math.max(duplicates.findIndex((candidate) => candidate.id === item.id), 0) + 1;
  const fallback = `Physical item ${ordinal} of ${duplicates.length}`;
  return { name: item.name, discriminator: evidence === "Physical item" ? fallback : `${evidence} · ${fallback}` };
}

export function inventoryCandidateText(item: InventoryItem, items: readonly InventoryItem[], expert = false): string {
  const label = inventoryCandidateLabel(item, items, expert);
  return label.discriminator ? `${label.name} · ${label.discriminator}` : label.name;
}
