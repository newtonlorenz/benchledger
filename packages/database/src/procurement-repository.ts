import { DomainError } from "@benchledger/domain";
import type { OfferSnapshot, Supplier } from "@benchledger/domain";
import { offerFromRow, supplierFromRow } from "./serializers.js";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";

export class ProcurementRepository {
  constructor(private readonly database: BenchDatabase) {}

  createSupplier(supplier: Supplier): Supplier {
    this.database.run("INSERT INTO suppliers (id, name, website, created_at) VALUES (?, ?, ?, ?)", [supplier.id, supplier.name, supplier.website ?? null, supplier.createdAt]);
    return supplier;
  }

  getSupplier(id: string): Supplier | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM suppliers WHERE id = ?", [id]);
    return row === undefined ? undefined : supplierFromRow(row);
  }

  listSuppliers(): readonly Supplier[] {
    return this.database.all<SqliteRow>("SELECT * FROM suppliers ORDER BY name, id", []).map(supplierFromRow);
  }

  createOffer(offer: OfferSnapshot): OfferSnapshot {
    if (this.getSupplier(offer.supplierId) === undefined) throw new DomainError("supplier_not_found", `supplier ${offer.supplierId} does not exist`);
    this.database.run("INSERT INTO offer_snapshots (id, item_id, supplier_id, url, title, package_quantity, package_unit, price_minor, currency, observed_at, availability, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [offer.id, offer.itemId, offer.supplierId, offer.url, offer.title ?? null, offer.packageQuantity, offer.packageUnit, offer.priceMinor, offer.currency, offer.observedAt, offer.availability ?? null, offer.notes ?? null]);
    return offer;
  }

  listOffers(itemId?: string): readonly OfferSnapshot[] {
    const rows = itemId === undefined
      ? this.database.all<SqliteRow>("SELECT * FROM offer_snapshots ORDER BY observed_at DESC, id", [])
      : this.database.all<SqliteRow>("SELECT * FROM offer_snapshots WHERE item_id = ? ORDER BY observed_at DESC, id", [itemId]);
    return rows.map(offerFromRow);
  }
}
