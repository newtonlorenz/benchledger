import type {
  BuildConfigurationSnapshot, CatalogProduct, CreateBuildConfigurationSnapshot,
  CreateCatalogProduct, CreateInventoryProductProfile, InventoryProductProfile,
  UpdateCatalogProduct, UpdateInventoryProductProfile,
} from "@benchledger/api-contract";
import type {
  BuildConfigurationListOptions, BuildConfigurationPort, CatalogPort, CatalogProductListOptions,
  Page, RequestContext,
} from "@benchledger/application";
import {
  BuildConfigurationSnapshotRepository, CatalogProductRepository,
  InventoryProductProfileRepository,
} from "@benchledger/database";
import type { BenchDatabase } from "@benchledger/database";
import { RuntimeState } from "./persistence.js";
import { attempt, clone, page } from "./utils.js";

const CATALOG_PRODUCT = "catalog_product";
const INVENTORY_PROFILE = "inventory_product_profile";

function searchText(product: CatalogProduct): string {
  // Search only identity/specification fields. Provenance URLs and server
  // metadata are intentionally excluded so a URL fragment cannot make a
  // product appear to match and source changes do not alter search results.
  const fields = product.kind === "filament"
    ? [
      product.id,
      product.kind,
      product.manufacturer,
      product.productName,
      product.sku,
      product.materialFamily,
      product.materialSubtype,
      product.colourName,
      product.colourCode,
      product.diameterMm,
      product.nominalNetMassG,
      product.nominalLengthM,
      product.lengthBasis,
      product.densityGcm3,
    ]
    : [
      product.id,
      product.kind,
      product.manufacturer,
      product.exactModel,
      product.exactVariant,
      product.technology,
      product.buildVolumeMm.x,
      product.buildVolumeMm.y,
      product.buildVolumeMm.z,
    ];
  return fields.filter((value) => value !== undefined).join(" ").toLocaleLowerCase();
}

/** Bridges canonical catalog repositories to the application ports. */
export class ProductionCatalogAdapter implements CatalogPort {
  private readonly products: CatalogProductRepository;
  private readonly profiles: InventoryProductProfileRepository;

  constructor(
    private readonly database: BenchDatabase,
    private readonly state: RuntimeState,
    private readonly unitOfWork: { readonly exclusive: <T>(operation: () => T | PromiseLike<T>) => Promise<T> },
    products?: CatalogProductRepository,
    profiles?: InventoryProductProfileRepository,
  ) {
    this.products = products ?? new CatalogProductRepository(database);
    this.profiles = profiles ?? new InventoryProductProfileRepository(database, this.products);
  }

  async listProducts(options: CatalogProductListOptions): Promise<Page<CatalogProduct>> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const values = this.products.listAll(options.kind === undefined ? {} : { kind: options.kind }).filter((product) => options.q === undefined || searchText(product).includes(options.q.toLocaleLowerCase()));
      return page(values.map(clone), options.limit, options.cursor);
    }));
  }

  async getProduct(id: string): Promise<CatalogProduct | null> {
    return this.unitOfWork.exclusive(() => attempt(() => clone(this.products.get(id) ?? null)));
  }

  async createProduct(input: CreateCatalogProduct, _ctx: RequestContext): Promise<CatalogProduct> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const created = this.database.transaction(() => this.products.create(input));
      this.state.setInitialVersion(CATALOG_PRODUCT, created.id);
      return clone(created);
    }));
  }

  async updateProduct(id: string, input: UpdateCatalogProduct, expectedVersion: number | undefined, _ctx: RequestContext): Promise<CatalogProduct> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const current = this.products.get(id);
      if (current === undefined) throw new Error(`catalog product ${id} does not exist`);
      const expected = expectedVersion ?? current.version;
      const updated = this.database.transaction(() => this.products.update(id, input as never, expected));
      this.state.setVersion(CATALOG_PRODUCT, id, updated.version);
      return clone(updated);
    }));
  }

  async getInventoryProductProfile(itemId: string): Promise<InventoryProductProfile | null> {
    return this.unitOfWork.exclusive(() => attempt(() => clone(this.profiles.list({ itemId, limit: 1 }).data[0] ?? null)));
  }

  async putInventoryProductProfile(
    itemId: string,
    input: CreateInventoryProductProfile | UpdateInventoryProductProfile,
    expectedVersion: number | undefined,
    _ctx: RequestContext,
  ): Promise<InventoryProductProfile> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const current = this.profiles.list({ itemId, limit: 1 }).data[0];
      if (current === undefined) {
        const created = this.database.transaction(() => this.profiles.create({ ...input, itemId } as CreateInventoryProductProfile));
        this.state.setInitialVersion(INVENTORY_PROFILE, created.id);
        return clone(created);
      }
      const expected = expectedVersion ?? current.version;
      const update = { ...input, itemId } as UpdateInventoryProductProfile;
      const updated = this.database.transaction(() => this.profiles.update(current.id, update as never, expected));
      this.state.setVersion(INVENTORY_PROFILE, updated.id, updated.version);
      return clone(updated);
    }));
  }

  /**
   * Remove only the version-1 profile created by the compound inventory
   * command. Profile deletion is intentionally not exposed as a public port.
   */
  async rollbackCreatedProfile(profileId: string, itemId: string): Promise<void> {
    await this.unitOfWork.exclusive(() => attempt(() => {
      const current = this.profiles.get(profileId);
      if (current === undefined) return;
      if (current.itemId !== itemId || current.version !== 1) throw new Error("created inventory profile is no longer compensatable");
      const result = this.database.run("DELETE FROM inventory_product_profiles WHERE id = ? AND item_id = ? AND version = 1", [profileId, itemId]) as { readonly changes?: number | bigint };
      const removed = typeof result.changes === "number" ? result.changes === 1 : typeof result.changes === "bigint" ? result.changes === 1n : this.profiles.get(profileId) === undefined;
      if (!removed) throw new Error("created inventory profile compensation did not remove the profile");
      this.state.deleteMetadata(INVENTORY_PROFILE, profileId);
      this.state.deleteVersion(INVENTORY_PROFILE, profileId);
    }));
  }
}

/** Immutable snapshot adapter. Repository creation owns hash and timestamp. */
export class ProductionBuildConfigurationAdapter implements BuildConfigurationPort {
  constructor(
    private readonly database: BenchDatabase,
    private readonly snapshots = new BuildConfigurationSnapshotRepository(database),
    private readonly unitOfWork: { readonly exclusive: <T>(operation: () => T | PromiseLike<T>) => Promise<T> },
  ) {}

  async listBuildConfigurations(revisionId: string, options: BuildConfigurationListOptions): Promise<Page<BuildConfigurationSnapshot>> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const result = this.snapshots.list({ projectRevisionId: revisionId, limit: options.limit, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
      return { data: result.data.map(clone), limit: result.limit, total: result.total, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) };
    }));
  }

  async getLatestBuildConfiguration(revisionId: string): Promise<BuildConfigurationSnapshot | null> {
    return this.unitOfWork.exclusive(() => attempt(() => clone(this.snapshots.latest(revisionId) ?? null)));
  }

  async getBuildConfiguration(id: string): Promise<BuildConfigurationSnapshot | null> {
    return this.unitOfWork.exclusive(() => attempt(() => clone(this.snapshots.get(id) ?? null)));
  }

  async createBuildConfiguration(input: CreateBuildConfigurationSnapshot, _ctx: RequestContext): Promise<BuildConfigurationSnapshot> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const { contentSha256: _hash, createdAt: _createdAt, ...draft } = input as CreateBuildConfigurationSnapshot & { readonly contentSha256?: string; readonly createdAt?: string };
      const created = this.database.transaction(() => this.snapshots.create(draft as never));
      return clone(created);
    }));
  }
}
