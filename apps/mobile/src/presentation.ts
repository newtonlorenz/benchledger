import type { InventoryItem } from "@benchledger/api-contract";

type EvidenceSummary = Pick<InventoryItem, "unitStatus"> & { evidence: Pick<InventoryItem["evidence"], "state"> };
type StockFigures = Pick<InventoryItem, "quantity" | "availableQuantity" | "unit">;
const evidenceNames: Record<InventoryItem["evidence"]["state"], string> = {
  physically_counted: "Physically counted", commissioned: "Commissioned", delivered_uncounted: "Delivered · count needed",
  ordered_unverified: "Ordered · unverified", allocated: "Allocated", consumed: "Consumed", unknown: "Evidence unknown"
};

export function evidenceLabel(item: EvidenceSummary): string {
  return item.unitStatus === "needs_correction" ? "Unit needs correction" : evidenceNames[item.evidence.state];
}

// One formatter for every row; constructing Intl formatters per render is costly on Hermes.
const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
export const formatNumber = (value: number) => numbers.format(value);
const symbols: Partial<Record<InventoryItem["unit"], string>> = { gram: "g", metre: "m", millimetre: "mm", millilitre: "ml" };
const counted: Partial<Record<InventoryItem["unit"], [string, string]>> = { each: ["piece", "pieces"], set: ["set", "sets"] };

/** Matches the web workspace: measured units use symbols, counted units are pluralised. */
export function formatQuantity(value: number, unit: InventoryItem["unit"]): string {
  const symbol = symbols[unit];
  if (symbol) return `${formatNumber(value)} ${symbol}`;
  const [one, many] = counted[unit] ?? [unit, unit];
  return `${formatNumber(value)} ${value === 1 ? one : many}`;
}

/** Recorded stock is not the same as usable stock; surface availability when they differ. */
export function stockSummary(item: StockFigures): string {
  const total = formatQuantity(item.quantity, item.unit);
  if (item.availableQuantity === item.quantity) return total;
  if (item.availableQuantity === 0) return `None available of ${total}`;
  return `Available ${formatNumber(item.availableQuantity)} of ${total}`;
}

// Explicit row labels keep decorative icon-font glyphs out of VoiceOver.
// They retain uncertainty and location, not just the prominent item name.
export function inventoryAccessibilityLabel(item: EvidenceSummary & StockFigures & Pick<InventoryItem, "name" | "location">): string {
  return [item.name, stockSummary(item), item.location, evidenceLabel(item)].filter(Boolean).join(", ");
}

/** "Last synced 09:05" today, otherwise with the date, for the offline banner. */
export function syncedLabel(at: Date | undefined, now = new Date(), locale?: string): string {
  if (!at) return "Nothing saved on this device yet";
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at);
  if (at.toDateString() === now.toDateString()) return `Last synced ${time}`;
  return `Last synced ${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(at)}, ${time}`;
}
