import type { InventoryItem } from "@benchledger/api-contract";

type Availability = NonNullable<InventoryItem["availability"]>;
type EvidenceState = InventoryItem["evidence"]["state"];
/** `availability` is absent on servers older than the stock receiving policy. */
type AvailabilitySummary = { evidence: { state: EvidenceState }; availability?: Availability | undefined };
type EvidenceSummary = Pick<InventoryItem, "unitStatus"> & AvailabilitySummary;
type StockFigures = Pick<InventoryItem, "quantity" | "availableQuantity" | "unit">;
const evidenceNames: Record<InventoryItem["evidence"]["state"], string> = {
  physically_counted: "Physically counted", commissioned: "Commissioned", delivered_uncounted: "Delivered · count needed",
  ordered_unverified: "Ordered · unverified", allocated: "Allocated", consumed: "Consumed", unknown: "Evidence unknown"
};

/**
 * Stock that counts as in stock only because the workspace receiving policy
 * trusts its delivery or order (the web app's wording). The stored evidence
 * is unchanged, so the label keeps saying it has not been counted.
 */
export function assumedStockLabel(item: AvailabilitySummary): string | undefined {
  if (item.availability !== "assumed") return undefined;
  return item.evidence.state === "ordered_unverified" ? "In stock · ordered, not yet delivered" : "In stock · delivered, not counted";
}

export function evidenceLabel(item: EvidenceSummary): string {
  if (item.unitStatus === "needs_correction") return "Unit needs correction";
  return assumedStockLabel(item) ?? evidenceNames[item.evidence.state];
}

/** Delivered or ordered stock that a receiving count confirms. */
const receivable = (state: EvidenceState) => state === "delivered_uncounted" || state === "ordered_unverified";

/**
 * Item stock actions. Counting delivered or ordered stock is how it is
 * received, so the primary action says so (as the web app does). Servers that
 * report `availability` refuse receipt events on such stock until it has been
 * counted, so the separate receipt action is only offered where it can work.
 */
export function stockActions(item: AvailabilitySummary): { primary: string; allowReceipt: boolean; assumed: boolean } {
  const receiving = receivable(item.evidence.state);
  return {
    primary: receiving ? "Receive and count" : "Count stock",
    allowReceipt: !(receiving && item.availability !== undefined),
    assumed: item.availability === "assumed"
  };
}

export type StockReceivingPolicy = "on_purchase" | "on_delivery" | "on_receipt";
const policyText: Record<StockReceivingPolicy, { label: string; explanation: string }> = {
  on_purchase: { label: "When it's bought", explanation: "Ordered and delivered stock counts as in stock right away, even if it has not arrived yet." },
  on_delivery: { label: "When it's delivered", explanation: "Delivered stock counts without a count. Ordered stock that has not arrived does not." },
  on_receipt: { label: "When I've received and checked it", explanation: "Ordered and delivered stock waits until you count it." }
};
/** The workspace stock receiving policy, worded as in the web app's settings. */
export function stockReceivingPolicyText(policy: StockReceivingPolicy) { return policyText[policy]; }

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
