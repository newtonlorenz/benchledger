import { createHash } from "node:crypto";
import { createOfferSnapshot, createSupplier, DomainError } from "@benchledger/domain";
import type { OfferSnapshot, Supplier } from "@benchledger/domain";
import type { CreateOffer, Offer as ApiOffer } from "@benchledger/api-contract";
import type { OfferPort, Page, RequestContext } from "@benchledger/application";
import { InventoryRepository, ProcurementRepository } from "@benchledger/database";
import type { BenchDatabase } from "@benchledger/database";
import { RuntimeState } from "./persistence.js";
import { apiOfferFromNative, mapApiUnitToDomain } from "./mappers.js";
import { attempt, page, nowIso } from "./utils.js";

const ENTITY = "offer";

function offerUnit(itemUnit: string): "each" | "gram" | "millimetre" | "millilitre" | "metre" | "set" {
  switch (itemUnit) {
    case "gram": return "gram";
    case "millimetre": return "millimetre";
    case "millilitre": return "millilitre";
    case "meter":
    case "metre": return "metre";
    case "set": return "set";
    default: return "each";
  }
}

export class ProductionOfferAdapter implements OfferPort {
  constructor(
    private readonly database: BenchDatabase,
    private readonly repository: ProcurementRepository,
    private readonly inventory: InventoryRepository,
    private readonly state: RuntimeState
  ) {}

  async listOffers(itemId: string | undefined, limit: number, cursor?: string): Promise<Page<ApiOffer>> {
    return attempt(() => {
      const normalizedCursor = validatedOfferCursor(cursor);
      const offers = this.repository.listOffers(itemId).map((offer) => this.toApi(offer));
      return page(offers, limit, normalizedCursor);
    });
  }

  async createOffer(input: CreateOffer, _ctx: RequestContext): Promise<ApiOffer> {
    return attempt(() => {
      if (input.itemId === undefined) throw new DomainError("invalid_offer_reference", "production offers require an itemId");
      const item = this.inventory.get(input.itemId);
      if (item === undefined) throw new DomainError("inventory_not_found", `inventory item ${input.itemId} was not found`);
      const supplierName = input.supplier.trim();
      const supplierId = `supplier-${createHash("sha256").update(supplierName.toLocaleLowerCase()).digest("hex").slice(0, 24)}`;
      const existingSupplier = this.repository.getSupplier(supplierId);
      const supplier: Supplier = existingSupplier ?? createSupplier({ id: supplierId, name: supplierName, createdAt: nowIso() });
      const offer: OfferSnapshot = createOfferSnapshot({
        ...(input.id === undefined ? {} : { id: input.id }),
        itemId: input.itemId,
        supplierId: supplier.id,
        url: input.url,
        title: input.name,
        packageQuantity: input.packageQuantity ?? 1,
        packageUnit: mapApiUnitToDomain(offerUnit(item.unit)),
        priceMinor: input.priceMinor,
        currency: input.currency,
        ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
        ...(input.notes === undefined ? {} : { notes: input.notes })
      });
      const created = this.database.transaction(() => {
        if (existingSupplier === undefined) this.repository.createSupplier(supplier);
        return this.repository.createOffer(offer);
      });
      this.state.setInitialVersion(ENTITY, created.id);
      this.state.setMetadata(ENTITY, created.id, { supplier: supplier.name, name: input.name, ...(input.shippingMinor === undefined ? {} : { shippingMinor: input.shippingMinor }), staleAfterDays: input.staleAfterDays ?? 30 });
      return this.toApi(created, 1, supplier);
    });
  }

  private toApi(offer: OfferSnapshot, version = this.state.getVersion(ENTITY, offer.id), knownSupplier?: Supplier): ApiOffer {
    const supplier = knownSupplier ?? this.repository.getSupplier(offer.supplierId);
    const metadata = this.state.getMetadata(ENTITY, offer.id);
    return apiOfferFromNative(offer, supplier, {
      ...(typeof metadata.supplier === "string" ? { supplier: metadata.supplier } : {}),
      ...(typeof metadata.name === "string" ? { name: metadata.name } : {}),
      ...(typeof metadata.shippingMinor === "number" ? { shippingMinor: metadata.shippingMinor } : {}),
      ...(typeof metadata.staleAfterDays === "number" ? { staleAfterDays: metadata.staleAfterDays } : {})
    }, version);
  }
}

function validatedOfferCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (!/^\d+$/u.test(cursor)) throw new DomainError("invalid_cursor", "offer cursor is invalid");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new DomainError("invalid_cursor", "offer cursor is invalid");
  return String(offset);
}
