import { ApplicationError, notFound } from "../errors.js";
import { isConfirmedEvidence } from "@benchledger/domain";
import type { ApplicationPorts, CatalogProductListOptions, Mutation, Page, RequestContext } from "../ports.js";
import { boundedCursor, boundedLimit, requireId } from "./shared.js";
import { FILAMENT_CATALOG_IDENTITY_UNKNOWN_BLOCKER, catalogProductSchema, createCatalogProductSchema, createInventoryProductProfileSchema, inventoryProductProfileSchema, updateCatalogProductSchema, updateInventoryProductProfileSchema } from "@benchledger/api-contract";
import type { CatalogProduct, CreateCatalogProduct, CreateInventoryProductProfile, InventoryProductProfile, UpdateCatalogProduct, UpdateInventoryProductProfile } from "@benchledger/api-contract";
import { ServiceModule } from "./module.js";

/** Stable blocker recorded when a physical filament has no catalog identity. */
export const FILAMENT_CATALOG_IDENTITY_UNKNOWN = FILAMENT_CATALOG_IDENTITY_UNKNOWN_BLOCKER;

export function catalogPort(ports: Pick<ApplicationPorts, "catalog">): NonNullable<ApplicationPorts["catalog"]> {
  if (ports.catalog === undefined) throw new ApplicationError("integrity_error", "This runtime does not support the product catalog");
  return ports.catalog;
}

/**
 * Resolve an intended printer through the owned inventory item and its exact
 * product profile. A bare item kind is not enough ancestry to make a printer
 * assignment trustworthy.
 */
export async function assertOwnedPrinter(ports: Pick<ApplicationPorts, "inventory" | "catalog">, itemId: string): Promise<void> {
  const item = await ports.inventory.getItem(itemId);
  if (item === null) throw notFound("Inventory item", itemId);
  if (item.kind !== "printer") throw new ApplicationError("validation", "The intended printer must be an owned printer inventory item");
  if (item.retiredAt !== undefined) throw new ApplicationError("validation", "The intended printer inventory item is retired");
  if (item.unit !== "each" || item.unitStatus === "needs_correction") {
    throw new ApplicationError("validation", "The intended printer must use a compatible each unit");
  }
  if (!isConfirmedEvidence(item.evidence.state) || item.quantity <= 0 || item.availableQuantity <= 0) {
    throw new ApplicationError("validation", "The intended printer must have positive available stock with physically counted or commissioned evidence");
  }
  const profile = await catalogPort(ports).getInventoryProductProfile(itemId);
  if (profile === null || profile.itemId !== itemId || profile.profileType !== "printer_asset" || profile.linkState !== "confirmed") {
    throw new ApplicationError("validation", "The intended printer must have an exact printer product profile");
  }
  const product = await catalogPort(ports).getProduct(profile.catalogProductId);
  if (product === null) throw notFound("Catalog product", profile.catalogProductId);
  if (product.kind !== "printer") throw new ApplicationError("validation", "The intended printer profile must point to a printer catalog product");
}

export function catalogListOptions(query: Partial<CatalogProductListOptions> | undefined): CatalogProductListOptions {
  const q = query?.q;
  if (q !== undefined && (q.length > 200 || q.trim().length === 0)) {
    throw new ApplicationError("validation", "q must be a non-empty search string of at most 200 characters");
  }
  const kind = query?.kind;
  if (kind !== undefined && kind !== "filament" && kind !== "printer") {
    throw new ApplicationError("validation", "kind must be filament or printer");
  }
  const cursor = boundedCursor(query?.cursor);
  return {
    ...(q === undefined ? {} : { q: q.trim() }),
    ...(kind === undefined ? {} : { kind }),
    limit: boundedLimit(query?.limit, 50, "limit"),
    ...(cursor === undefined ? {} : { cursor })
  };
}

/** Exact-product catalog entries and the inventory product profiles that link to them. */
export class CatalogModule extends ServiceModule {
  async listCatalogProducts(query: Partial<CatalogProductListOptions> = {}): Promise<Page<CatalogProduct>> {
    const options = catalogListOptions(query);
    return this.ports.unitOfWork.exclusive(() => catalogPort(this.ports).listProducts(options));
  }

  async getCatalogProduct(id: string): Promise<CatalogProduct> {
    const productId = requireId(id, "catalog product id");
    return this.ports.unitOfWork.exclusive(async () => {
      const product = await catalogPort(this.ports).getProduct(productId);
      if (product === null) throw notFound("Catalog product", productId);
      return catalogProductSchema.parse(product);
    });
  }

  async createCatalogProduct(input: CreateCatalogProduct, ctx: RequestContext): Promise<Mutation<CatalogProduct>> {
    const parsed = createCatalogProductSchema.parse(input);
    return this.mutate(ctx, "catalog.product.create", "catalog_product", "pending", async () => {
      const product = catalogProductSchema.parse(await catalogPort(this.ports).createProduct(parsed, ctx));
      return { value: product, entityId: product.id, version: product.version };
    });
  }

  async updateCatalogProduct(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<CatalogProduct>> {
    const productId = requireId(id, "catalog product id");
    const parsed = updateCatalogProductSchema.parse(input) as UpdateCatalogProduct;
    return this.mutate(ctx, "catalog.product.update", "catalog_product", productId, async () => {
      const product = catalogProductSchema.parse(await catalogPort(this.ports).updateProduct(productId, parsed, expectedVersion, ctx));
      return { value: product, entityId: product.id, version: product.version };
    });
  }

  async getInventoryProductProfile(itemId: string): Promise<InventoryProductProfile> {
    const parsedItemId = requireId(itemId, "inventory item id");
    return this.ports.unitOfWork.exclusive(async () => {
      const profile = await catalogPort(this.ports).getInventoryProductProfile(parsedItemId);
      if (profile === null) throw notFound("Inventory product profile", parsedItemId);
      return inventoryProductProfileSchema.parse(profile);
    });
  }

  async putInventoryProductProfile(itemId: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<InventoryProductProfile>> {
    const parsedItemId = requireId(itemId, "inventory item id");
    const current = await this.ports.unitOfWork.exclusive(() => catalogPort(this.ports).getInventoryProductProfile(parsedItemId));
    const inventoryItem = await this.ports.inventory.getItem(parsedItemId);
    if (inventoryItem === null) throw notFound("Inventory item", parsedItemId);
    if (inventoryItem.kind !== "printer" && inventoryItem.kind !== "filament") {
      throw new ApplicationError("validation", "Only printer and filament inventory items can have product profiles");
    }
    const raw = input !== null && typeof input === "object" ? { ...(input as Record<string, unknown>), itemId: parsedItemId } : input;
    const parsed = current === null
      ? createInventoryProductProfileSchema.parse(raw)
      : updateInventoryProductProfileSchema.parse(raw);
    const profileProductId = "catalogProductId" in parsed && parsed.catalogProductId !== undefined
      ? parsed.catalogProductId
      : current?.catalogProductId;
    if (profileProductId === undefined) throw new ApplicationError("validation", "catalogProductId is required");
    const product = await catalogPort(this.ports).getProduct(profileProductId);
    if (product === null) throw notFound("Catalog product", profileProductId);
    if (product.kind !== inventoryItem.kind) {
      throw new ApplicationError("validation", `Catalog product kind '${product.kind}' does not match inventory item kind '${inventoryItem.kind}'`);
    }
    if ("itemId" in parsed && parsed.itemId !== undefined && parsed.itemId !== parsedItemId) {
      throw new ApplicationError("validation", "Profile itemId must match the inventory path");
    }
    if (current !== null && "profileType" in parsed && parsed.profileType !== undefined && parsed.profileType !== current.profileType) {
      throw new ApplicationError("validation", "Profile type cannot change after creation");
    }
    const normalized = {
      ...parsed,
      itemId: parsedItemId,
      catalogProductId: profileProductId,
      profileType: "profileType" in parsed && parsed.profileType !== undefined
        ? parsed.profileType
        : current?.profileType ?? (inventoryItem.kind === "filament" ? "filament_spool" : "printer_asset")
    } as CreateInventoryProductProfile | UpdateInventoryProductProfile;
    return this.mutate(ctx, "inventory.product_profile.put", "inventory_product_profile", current?.id ?? parsedItemId, async () => {
      const profile = inventoryProductProfileSchema.parse(await catalogPort(this.ports).putInventoryProductProfile(parsedItemId, normalized, expectedVersion, ctx));
      return { value: profile, entityId: profile.id, version: profile.version };
    });
  }
}
