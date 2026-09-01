import { catalogProductSchema, type CatalogProduct } from "@benchledger/api-contract";
import { CatalogProductRepository } from "@benchledger/database";
import type { BenchDatabase } from "@benchledger/database";
import { STARTER_CATALOG_DATASET_VERSION, STARTER_CATALOG_PRODUCTS } from "./starter-catalog-data.js";

export const STARTER_CATALOG_META_KEY = "starter_catalog_dataset_version";

export interface StarterCatalogSeedResult {
  readonly datasetVersion: number;
  readonly inserted: number;
  readonly preserved: number;
}

/** Narrow writer seam keeps the seed transaction failure-injectable in tests. */
export interface StarterCatalogProductWriter {
  create(product: CatalogProduct): CatalogProduct;
}

function readDatasetVersion(database: BenchDatabase): number {
  const row = database.get<{ readonly value: unknown }>("SELECT value FROM forge_meta WHERE key = ?", [STARTER_CATALOG_META_KEY]);
  if (row === undefined) return 0;
  const value = typeof row.value === "number" ? row.value : typeof row.value === "string" ? Number(row.value) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("BenchLedger starter catalog dataset version is invalid");
  return value;
}

function seedProduct(database: BenchDatabase, repository: StarterCatalogProductWriter, product: CatalogProduct): boolean {
  // Do not parse or rewrite a row that happens to share a curated ID. A
  // workspace may have intentionally replaced a starter record with its own
  // metadata; the insert-missing-only rule preserves its exact stored bytes.
  const existing = database.get("SELECT id FROM catalog_products WHERE id = ?", [product.id]);
  if (existing !== undefined) return false;
  repository.create(catalogProductSchema.parse(structuredClone(product)));
  return true;
}

/**
 * Insert the reviewed starter identities once per missing stable ID.
 *
 * The catalog is deliberately not materialized as inventory, profiles, or
 * stock. Existing rows—including custom rows using a curated ID—are never
 * updated. The metadata version is advanced in the same transaction as the
 * inserts so a failed startup cannot advertise a partially seeded dataset.
 */
export function seedStarterCatalog(
  database: BenchDatabase,
  products: StarterCatalogProductWriter = new CatalogProductRepository(database),
): StarterCatalogSeedResult {
  const currentVersion = readDatasetVersion(database);
  if (currentVersion > STARTER_CATALOG_DATASET_VERSION) {
    throw new Error(`BenchLedger starter catalog dataset ${currentVersion} is newer than supported version ${STARTER_CATALOG_DATASET_VERSION}`);
  }
  let inserted = 0;
  let preserved = 0;
  database.transaction(() => {
    for (const product of STARTER_CATALOG_PRODUCTS) {
      if (seedProduct(database, products, product)) inserted += 1;
      else preserved += 1;
    }
    database.run(
      "INSERT INTO forge_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [STARTER_CATALOG_META_KEY, String(STARTER_CATALOG_DATASET_VERSION)],
    );
  });
  return { datasetVersion: STARTER_CATALOG_DATASET_VERSION, inserted, preserved };
}

/** Compatibility alias for callers that use the migration vocabulary. */
export const seedStarterCatalogIfNeeded = seedStarterCatalog;
