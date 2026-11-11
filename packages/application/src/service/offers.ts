import type { Mutation, Page, RequestContext } from "../ports.js";
import { boundedCursor, requireId } from "./shared.js";
import { createOfferSchema } from "@benchledger/api-contract";
import type { CreateOffer, Offer } from "@benchledger/api-contract";
import { ServiceModule } from "./module.js";

/** Supplier offer snapshots (observations only; never purchase authority). */
export class OfferModule extends ServiceModule {
  async listOffers(itemId: string | undefined, limit = 50, cursor?: string): Promise<Page<Offer>> {
    const normalizedCursor = boundedCursor(cursor);
    return this.ports.unitOfWork.exclusive(() => this.ports.offers.listOffers(itemId ? requireId(itemId, "item id") : undefined, Math.min(Math.max(limit, 1), 200), normalizedCursor));
  }

  async createOffer(input: CreateOffer, ctx: RequestContext): Promise<Mutation<Offer>> {
    const parsed = createOfferSchema.parse(input);
    return this.mutate(ctx, "offer.create", "offer", parsed.id ?? "pending", async () => {
      const offer = await this.ports.offers.createOffer(parsed, ctx);
      return { value: offer, entityId: offer.id, version: offer.version };
    });
  }
}
