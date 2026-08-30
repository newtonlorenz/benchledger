import { createId, nowIso } from "./ids.js";
import { DomainError, assertPositiveQuantity } from "./errors.js";
import type { InventoryItem, OfferSnapshot, QuantityUnit, Supplier } from "./types.js";

export interface NewSupplier {
  id?: string;
  name: string;
  website?: string;
  createdAt?: string;
}

export function createSupplier(input: NewSupplier): Supplier {
  if (!input.name.trim()) throw new DomainError("invalid_supplier_name", "supplier name is required");
  return {
    id: input.id ?? createId("supplier"),
    name: input.name.trim(),
    ...(input.website === undefined ? {} : { website: input.website }),
    createdAt: input.createdAt ?? nowIso()
  };
}

export interface NewOfferSnapshot {
  id?: string;
  itemId: string;
  supplierId: string;
  url: string;
  title?: string;
  packageQuantity: number;
  packageUnit: QuantityUnit;
  priceMinor: number;
  currency: string;
  observedAt?: string;
  availability?: OfferSnapshot["availability"];
  notes?: string;
}

export function createOfferSnapshot(input: NewOfferSnapshot): OfferSnapshot {
  if (!input.itemId.trim() || !input.supplierId.trim()) throw new DomainError("invalid_offer_reference", "offer itemId and supplierId are required");
  if (!/^https?:\/\//i.test(input.url)) throw new DomainError("invalid_offer_url", "offer URL must use HTTP or HTTPS");
  assertPositiveQuantity(input.packageQuantity, "offer package quantity");
  if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0) throw new DomainError("invalid_offer_price", "offer price must be a non-negative integer in minor currency units");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new DomainError("invalid_currency", "offer currency must be an ISO 4217 code");
  return {
    id: input.id ?? createId("offer"),
    itemId: input.itemId,
    supplierId: input.supplierId,
    url: input.url,
    ...(input.title === undefined ? {} : { title: input.title }),
    packageQuantity: input.packageQuantity,
    packageUnit: input.packageUnit,
    priceMinor: input.priceMinor,
    currency: input.currency,
    observedAt: input.observedAt ?? nowIso(),
    ...(input.availability === undefined ? {} : { availability: input.availability }),
    ...(input.notes === undefined ? {} : { notes: input.notes })
  };
}

export function latestOffer(offers: readonly OfferSnapshot[], itemId: string, supplierId?: string): OfferSnapshot | undefined {
  return offers
    .filter((offer) => offer.itemId === itemId && (supplierId === undefined || offer.supplierId === supplierId))
    .slice()
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id))[0];
}

export interface PurchaseEstimate {
  itemId: string;
  packages: number;
  packageQuantity: number;
  unit: QuantityUnit;
  priceMinor: number;
  currency: string;
  totalMinor: number;
  offerId: string;
}

export function estimatePurchase(item: InventoryItem, requiredQuantity: number, offer: OfferSnapshot): PurchaseEstimate {
  assertPositiveQuantity(requiredQuantity, "required quantity");
  const packages = Math.ceil(requiredQuantity / offer.packageQuantity);
  return {
    itemId: item.id,
    packages,
    packageQuantity: offer.packageQuantity,
    unit: offer.packageUnit,
    priceMinor: offer.priceMinor,
    currency: offer.currency,
    totalMinor: packages * offer.priceMinor,
    offerId: offer.id
  };
}
