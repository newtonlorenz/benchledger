import { describe, expect, it } from "vitest";
import { createOfferSnapshot, createSupplier, estimatePurchase, latestOffer } from "./procurement.js";
import type { InventoryItem } from "./types.js";

const item: InventoryItem = {
  id: "wire",
  name: "Silicone wire",
  category: "electrical",
  purchasedQuantity: 1,
  unit: "set",
  sourceStatus: "physically_confirmed",
  reusePolicy: "available",
  confidence: "confirmed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("procurement snapshots", () => {
  it("keeps supplier prices as immutable observations", () => {
    const supplier = createSupplier({ id: "shop", name: "Maker Shop" });
    const older = createOfferSnapshot({ id: "o1", itemId: item.id, supplierId: supplier.id, url: "https://example.test/wire", packageQuantity: 10, packageUnit: "metre", priceMinor: 999, currency: "EUR", observedAt: "2026-01-01T00:00:00.000Z" });
    const newer = createOfferSnapshot({ id: "o2", itemId: item.id, supplierId: supplier.id, url: "https://example.test/wire", packageQuantity: 10, packageUnit: "metre", priceMinor: 1099, currency: "EUR", observedAt: "2026-01-02T00:00:00.000Z" });
    expect(latestOffer([newer, older], item.id)?.id).toBe("o2");
    expect(estimatePurchase(item, 11, newer)).toMatchObject({ packages: 2, totalMinor: 2198 });
  });
});
