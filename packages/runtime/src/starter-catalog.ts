import { catalogProductSchema, type CatalogProduct } from "@benchledger/api-contract";
import { CatalogProductRepository, deterministicJson } from "@benchledger/database";
import type { BenchDatabase } from "@benchledger/database";
import {
  STARTER_CATALOG_DATASET_VERSION,
  STARTER_CATALOG_PRODUCTS,
  STARTER_CATALOG_V1_CORRECTIONS,
} from "./starter-catalog-data.js";

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
  // metadata; the ordinary insert-missing-only path preserves its exact stored
  // bytes. The separate v1 migration below has its own complete-state gate.
  const existing = database.get("SELECT id FROM catalog_products WHERE id = ?", [product.id]);
  if (existing !== undefined) return false;
  repository.create(catalogProductSchema.parse(structuredClone(product)));
  return true;
}

function exactV1Product(correctionId: string, v2Product: CatalogProduct, v1: Readonly<Record<string, unknown>>): CatalogProduct {
  return catalogProductSchema.parse({ ...structuredClone(v2Product), ...structuredClone(v1), id: correctionId });
}

function correctV1Product(
  repository: CatalogProductRepository,
  correction: (typeof STARTER_CATALOG_V1_CORRECTIONS)[number],
): boolean {
  const v2Product = STARTER_CATALOG_PRODUCTS.find((product) => product.id === correction.id);
  if (v2Product === undefined) throw new Error(`starter catalog correction references unknown product ${correction.id}`);
  const current = repository.get(correction.id);
  if (current === undefined) return false;
  const expectedV1 = exactV1Product(correction.id, v2Product, correction.v1);

  // A complete payload fingerprint makes this migration ownership-safe. Any
  // user edit, replacement, or prior correction causes the row to be left
  // untouched while the dataset metadata can still advance transactionally.
  if (deterministicJson(current) !== deterministicJson(expectedV1)) return false;

  const v2Record = v2Product as unknown as Record<string, unknown>;
  const changes = Object.fromEntries(Object.keys(correction.v1).map((field) => [field, structuredClone(v2Record[field])]));
  repository.update(current.id, changes, current.version);
  return true;
}

/**
 * Insert the reviewed starter identities once per missing stable ID and apply
 * the narrowly gated v1-to-v2 corrections for untouched seeded rows.
 *
 * The catalog is deliberately not materialized as inventory, profiles, or
 * stock. Existing rows—including custom rows using a curated ID—are never
 * rewritten unless their complete payload still matches an explicitly known
 * v1 seed state. The metadata version is advanced in the same transaction as
 * inserts and corrections so a failed startup cannot advertise a partial
 * dataset upgrade.
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
  const catalogRepository = new CatalogProductRepository(database);
  database.transaction(() => {
    if (currentVersion === 1 && STARTER_CATALOG_DATASET_VERSION === 2) {
      for (const correction of STARTER_CATALOG_V1_CORRECTIONS) {
        correctV1Product(catalogRepository, correction);
      }
    }
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
