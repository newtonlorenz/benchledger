import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BenchDatabase, CatalogProductRepository, migrateCatalogSchema } from "@benchledger/database";
import type { CatalogProduct } from "@benchledger/api-contract";
import { STARTER_CATALOG_DATASET_VERSION, STARTER_CATALOG_PRODUCTS, STARTER_FILAMENTS, STARTER_PRINTERS } from "./starter-catalog-data.js";
import { createProductionRuntime, type ProductionRuntime } from "./index.js";
import { seedStarterCatalog } from "./starter-catalog.js";

const runtimes: ProductionRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeRuntime(): Promise<{ readonly runtime: ProductionRuntime; readonly dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "benchledger-starter-catalog-"));
  directories.push(dataDir);
  const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
  runtimes.push(runtime);
  return { runtime, dataDir };
}

const V1_CORRECTION_OVERRIDES: Readonly<Record<string, Partial<CatalogProduct>>> = {
  "starter-printer-anycubic-kobra-2": { buildVolumeMm: { x: 250, y: 220, z: 220 } },
  "starter-printer-anycubic-kobra-2-pro": { buildVolumeMm: { x: 250, y: 220, z: 220 } },
  "starter-printer-anycubic-kobra-s1": { buildVolumeMm: { x: 250, y: 250, z: 270 } },
  "starter-filament-prusament-asa-jet-black": { nominalNetMassG: 850 },
  "starter-filament-prusament-pc-blend-black": { nominalNetMassG: 970 },
};

function v1Product(product: CatalogProduct): CatalogProduct {
  const override = V1_CORRECTION_OVERRIDES[product.id];
  return override === undefined ? structuredClone(product) : { ...structuredClone(product), ...structuredClone(override) } as CatalogProduct;
}

function seedV1Catalog(database: BenchDatabase): void {
  const repository = new CatalogProductRepository(database);
  for (const product of STARTER_CATALOG_PRODUCTS) repository.create(v1Product(product));
  database.run(
    "INSERT INTO forge_meta (key, value) VALUES (?, ?)",
    ["starter_catalog_dataset_version", "1"],
  );
}

describe("reviewed starter catalog", () => {
  it("seeds 24+ exact FFF printers and 24+ exact filament products without stock", async () => {
    const { runtime } = await makeRuntime();
    const products = await runtime.ports.catalog!.listProducts({ limit: 200 });
    expect(STARTER_PRINTERS.length).toBeGreaterThanOrEqual(24);
    expect(STARTER_FILAMENTS.length).toBeGreaterThanOrEqual(24);
    expect(STARTER_PRINTERS.length).toBeLessThan(50);
    expect(STARTER_FILAMENTS.length).toBeLessThan(50);
    expect(products.data).toHaveLength(STARTER_CATALOG_PRODUCTS.length);
    expect(products.data.filter((product) => product.kind === "printer")).toHaveLength(STARTER_PRINTERS.length);
    expect(products.data.filter((product) => product.kind === "filament")).toHaveLength(STARTER_FILAMENTS.length);
    expect(new Set(products.data.map((product) => product.id)).size).toBe(products.data.length);
    expect(products.data.every((product) => product.provenance?.sourceUrl.startsWith("https://"))).toBe(true);
    expect(products.data.every((product) => !product.provenance?.sourceUrl.includes("/collections/"))).toBe(true);
    expect(STARTER_FILAMENTS.every((product) => product.kind !== "filament" || product.nominalLengthM !== undefined || product.lengthBasis === "unknown")).toBe(true);
    const byId = new Map(products.data.map((product) => [product.id, product]));
    expect(byId.get("starter-printer-anycubic-kobra-2")).toMatchObject({
      manufacturer: "Anycubic",
      exactModel: "Kobra 2",
      buildVolumeMm: { x: 220, y: 220, z: 250 },
    });
    expect(byId.get("starter-printer-anycubic-kobra-2-pro")).toMatchObject({
      manufacturer: "Anycubic",
      exactModel: "Kobra 2 Pro",
      buildVolumeMm: { x: 220, y: 220, z: 250 },
    });
    expect(byId.get("starter-printer-anycubic-kobra-s1")).toMatchObject({
      manufacturer: "Anycubic",
      exactModel: "Kobra S1",
      buildVolumeMm: { x: 250, y: 250, z: 250 },
    });
    expect(byId.get("starter-filament-bambu-pla-basic-black")).toMatchObject({
      kind: "filament",
      colourName: "Black",
      colourCode: "10101",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
      provenance: { sourceUrl: "https://us.store.bambulab.com/products/pla-basic-filament?id=43992829952219" },
    });
    expect(byId.get("starter-filament-bambu-pla-matte-charcoal")).toMatchObject({
      kind: "filament",
      colourName: "Charcoal",
      colourCode: "11101",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
      provenance: { sourceUrl: "https://us.store.bambulab.com/products/pla-matte-filament?id=43992833261787" },
    });
    expect(byId.get("starter-filament-bambu-petg-hf-black")).toMatchObject({
      kind: "filament",
      colourName: "Black",
      colourCode: "33102",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
      provenance: { sourceUrl: "https://us.store.bambulab.com/products/petg-hf?id=49068714754396" },
    });
    expect(byId.get("starter-filament-bambu-abs-gf-black")).toMatchObject({
      kind: "filament",
      colourName: "Black",
      colourCode: "41101",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
      provenance: { sourceUrl: "https://us.store.bambulab.com/products/abs-gf?id=48011475911004" },
    });
    expect(byId.get("starter-filament-bambu-asa-black")).toMatchObject({
      kind: "filament",
      colourName: "Black",
      colourCode: "45101",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
      provenance: { sourceUrl: "https://us.store.bambulab.com/products/asa-filament?id=46930444222812" },
    });
    expect(byId.get("starter-filament-bambu-tpu-95a-hf-black")).toMatchObject({
      kind: "filament",
      colourName: "Black",
      colourCode: "51100",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
      provenance: { sourceUrl: "https://eu.store.bambulab.com/products/tpu-95a-hf?id=47305218687324" },
    });
    expect(byId.get("starter-filament-bambu-pla-cf-black")).toMatchObject({
      kind: "filament",
      colourName: "Black",
      colourCode: "14100",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
      provenance: { sourceUrl: "https://us.store.bambulab.com/products/pla-cf?id=43944001994971" },
    });
    expect(byId.get("starter-filament-polymaker-polymax-petg-black")).toMatchObject({
      kind: "filament",
      colourName: "Black",
      sku: "PB02001",
      diameterMm: 1.75,
      nominalNetMassG: 750,
      provenance: { sourceUrl: "https://shop.polymaker.com/products/polymax-petg?variant=39574348169273" },
    });
    expect(byId.get("starter-filament-polymaker-polymide-pa6-gf-grey")).toMatchObject({
      kind: "filament",
      colourName: "Grey",
      sku: "PG02001",
      diameterMm: 1.75,
      nominalNetMassG: 500,
      provenance: { sourceUrl: "https://us-wholesale.polymaker.com/products/polymide-pa6-gf?variant=40556798083174" },
    });
    expect(byId.get("starter-filament-polymaker-polymide-pa6-gf-black")).toBeUndefined();
    expect((await runtime.ports.catalog!.listProducts({ limit: 200, q: "starter-filament-polymaker-polymide-pa6-gf-grey" })).data.map((product) => product.id)).toEqual([
      "starter-filament-polymaker-polymide-pa6-gf-grey",
    ]);
    expect((await runtime.ports.catalog!.listProducts({ limit: 200, q: "starter-filament-polymaker-polymide-pa6-gf-black" })).data).toEqual([]);
    expect(byId.get("starter-filament-prusament-asa-jet-black")).toMatchObject({
      kind: "filament",
      colourName: "Jet Black",
      diameterMm: 1.75,
      nominalNetMassG: 800,
      lengthBasis: "unknown",
      provenance: { sourceUrl: "https://www.prusa3d.com/product/prusament-asa-jet-black-850g/" },
    });
    expect(byId.get("starter-filament-prusament-pc-blend-black")).toMatchObject({
      kind: "filament",
      colourName: "Jet Black",
      diameterMm: 1.75,
      nominalNetMassG: 900,
      lengthBasis: "unknown",
      provenance: { sourceUrl: "https://www.prusa3d.com/product/prusament-pc-blend-jet-black-970g/" },
    });
    expect(byId.get("starter-filament-prusament-pla-jet-black")?.provenance?.sourceUrl).toBe("https://www.prusa3d.com/product/prusament-pla-jet-black-1kg/");
    expect(byId.get("starter-filament-prusament-petg-jet-black")?.provenance?.sourceUrl).toBe("https://www.prusa3d.com/product/prusament-petg-jet-black-1kg/");
    expect(byId.get("starter-filament-prusament-pla-galaxy-black")?.provenance?.sourceUrl).toBe("https://www.prusa3d.com/product/prusament-pla-prusa-galaxy-black-1kg/");
    expect(runtime.database.get("SELECT value FROM forge_meta WHERE key = ?", ["starter_catalog_dataset_version"])).toEqual({ value: String(STARTER_CATALOG_DATASET_VERSION) });
    expect(runtime.database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM inventory_items")?.count).toBe(0);
    expect(runtime.database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM inventory_product_profiles")?.count).toBe(0);
    expect(runtime.database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM stock_events")?.count).toBe(0);
  });

  it("is repeatable, preserves custom bytes, and does not search provenance URLs", async () => {
    const first = await makeRuntime();
    const catalog = first.runtime.ports.catalog!;
    const changed = await catalog.updateProduct("starter-printer-bambu-h2d", { exactVariant: "Local asset note" }, 1, {
      actor: "starter-test",
      source: "api",
      correlationId: "starter-test-change",
      scopes: new Set(["read", "write", "catalog:read", "catalog:write"]),
    });
    expect(changed.provenance).toBeUndefined();
    const superseded = first.runtime.database.get<{ readonly catalog_product_id: string; readonly superseded_version: number; readonly payload_json: string }>(
      "SELECT catalog_product_id, superseded_version, payload_json FROM catalog_product_history WHERE catalog_product_id = ?",
      [changed.id],
    );
    expect(superseded).toMatchObject({ catalog_product_id: changed.id, superseded_version: 1 });
    expect(JSON.parse(superseded!.payload_json)).toMatchObject({
      id: changed.id,
      provenance: { sourceUrl: "https://bambulab.com/en-us/h2d" },
    });
    const before = first.runtime.database.get<{ readonly payload_json: string }>("SELECT payload_json FROM catalog_products WHERE id = ?", [changed.id])?.payload_json;
    first.runtime.database.run("DELETE FROM catalog_products WHERE id = ?", ["starter-filament-overture-pla-black"]);
    await first.runtime.close();
    const second = await createProductionRuntime({ dataDir: first.dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(second);

    expect(second.database.get<{ readonly payload_json: string }>("SELECT payload_json FROM catalog_products WHERE id = ?", [changed.id])?.payload_json).toBe(before);
    expect((await second.ports.catalog!.listProducts({ limit: 200 })).data).toHaveLength(STARTER_CATALOG_PRODUCTS.length);
    expect((await second.ports.catalog!.listProducts({ limit: 200, q: "bambulab.com" })).data).toEqual([]);
    expect((await second.ports.catalog!.listProducts({ limit: 200, q: "official product catalogue" })).data).toEqual([]);
    expect((await second.ports.catalog!.listProducts({ limit: 200, q: "local asset note" })).data.map((product) => product.id)).toEqual([changed.id]);
    expect(second.database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM inventory_items")?.count).toBe(0);
    expect(second.database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM inventory_product_profiles")?.count).toBe(0);
    expect(second.database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM stock_events")?.count).toBe(0);
  });

  it("upgrades an unedited v1 catalog under stable IDs with append-only history", () => {
    const database = new BenchDatabase(":memory:");
    migrateCatalogSchema(database);
    seedV1Catalog(database);

    const result = seedStarterCatalog(database);
    const repository = new CatalogProductRepository(database);
    expect(result).toMatchObject({ datasetVersion: 2, inserted: 0 });
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["starter_catalog_dataset_version"])).toEqual({ value: "2" });

    for (const product of STARTER_CATALOG_PRODUCTS) {
      expect(repository.get(product.id)).toBeDefined();
    }
    expect(repository.get("starter-printer-anycubic-kobra-2")).toMatchObject({ version: 2, buildVolumeMm: { x: 220, y: 220, z: 250 } });
    expect(repository.get("starter-printer-anycubic-kobra-2-pro")).toMatchObject({ version: 2, buildVolumeMm: { x: 220, y: 220, z: 250 } });
    expect(repository.get("starter-printer-anycubic-kobra-s1")).toMatchObject({ version: 2, buildVolumeMm: { x: 250, y: 250, z: 250 } });
    expect(repository.get("starter-filament-prusament-asa-jet-black")).toMatchObject({ version: 2, nominalNetMassG: 800 });
    expect(repository.get("starter-filament-prusament-pc-blend-black")).toMatchObject({ version: 2, nominalNetMassG: 900 });
    for (const id of [
      "starter-printer-anycubic-kobra-2",
      "starter-printer-anycubic-kobra-2-pro",
      "starter-printer-anycubic-kobra-s1",
      "starter-filament-prusament-asa-jet-black",
      "starter-filament-prusament-pc-blend-black",
    ]) expect(repository.get(id)?.provenance).toBeUndefined();

    const history = database.all<{ readonly catalog_product_id: string; readonly superseded_version: number; readonly payload_json: string }>(
      "SELECT catalog_product_id, superseded_version, payload_json FROM catalog_product_history ORDER BY catalog_product_id",
    );
    expect(history).toHaveLength(5);
    expect(history.map((entry) => entry.catalog_product_id)).toEqual([
      "starter-filament-prusament-asa-jet-black",
      "starter-filament-prusament-pc-blend-black",
      "starter-printer-anycubic-kobra-2",
      "starter-printer-anycubic-kobra-2-pro",
      "starter-printer-anycubic-kobra-s1",
    ]);
    expect(JSON.parse(history[0]!.payload_json)).toMatchObject({ version: 1, nominalNetMassG: 850, provenance: { sourceUrl: "https://www.prusa3d.com/product/prusament-asa-jet-black-850g/" } });
    expect(JSON.parse(history[2]!.payload_json)).toMatchObject({ version: 1, buildVolumeMm: { x: 250, y: 220, z: 220 }, provenance: { sourceUrl: "https://store.anycubic.com/products/kobra-2" } });
    expect(database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM inventory_items")?.count).toBe(0);
    expect(database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM inventory_product_profiles")?.count).toBe(0);
    expect(database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM stock_events")?.count).toBe(0);
    database.close();
  });

  it("preserves an edited v1 row and advances metadata without creating stock", () => {
    const database = new BenchDatabase(":memory:");
    migrateCatalogSchema(database);
    seedV1Catalog(database);
    const repository = new CatalogProductRepository(database);
    const edited = repository.update("starter-filament-prusament-asa-jet-black", { nominalNetMassG: 1234 }, 1);
    const before = database.get<{ readonly payload_json: string }>("SELECT payload_json FROM catalog_products WHERE id = ?", [edited.id])?.payload_json;

    const result = seedStarterCatalog(database);

    expect(result).toMatchObject({ datasetVersion: 2, inserted: 0 });
    expect(database.get<{ readonly payload_json: string }>("SELECT payload_json FROM catalog_products WHERE id = ?", [edited.id])?.payload_json).toBe(before);
    expect(repository.get(edited.id)).toMatchObject({ version: 2, nominalNetMassG: 1234 });
    expect(database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM catalog_product_history WHERE catalog_product_id = ?", [edited.id])?.count).toBe(1);
    database.close();
  });

  it("is idempotent after a v1 upgrade", () => {
    const database = new BenchDatabase(":memory:");
    migrateCatalogSchema(database);
    seedV1Catalog(database);
    seedStarterCatalog(database);
    const before = database.all("SELECT catalog_product_id, superseded_version, payload_json, superseded_at FROM catalog_product_history ORDER BY id");
    const productsBefore = database.all("SELECT id, payload_json, version, updated_at FROM catalog_products ORDER BY id");

    const result = seedStarterCatalog(database);

    expect(result).toMatchObject({ datasetVersion: 2, inserted: 0 });
    expect(database.all("SELECT catalog_product_id, superseded_version, payload_json, superseded_at FROM catalog_product_history ORDER BY id")).toEqual(before);
    expect(database.all("SELECT id, payload_json, version, updated_at FROM catalog_products ORDER BY id")).toEqual(productsBefore);
    database.close();
  });

  it("rolls back every insert and forge_meta when a mid-seed writer fails", () => {
    const database = new BenchDatabase(":memory:");
    migrateCatalogSchema(database);
    const repository = new CatalogProductRepository(database);
    let writes = 0;
    const failingWriter = {
      create(product: (typeof STARTER_CATALOG_PRODUCTS)[number]) {
        writes += 1;
        const created = repository.create(product);
        if (writes === 4) throw new Error("injected starter catalog failure");
        return created;
      },
    };

    expect(() => seedStarterCatalog(database, failingWriter)).toThrow("injected starter catalog failure");
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["starter_catalog_dataset_version"])).toBeUndefined();
    expect(database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM catalog_products")?.count).toBe(0);
    expect(database.get<{ readonly count: number }>("SELECT COUNT(*) AS count FROM catalog_product_history")?.count).toBe(0);
    database.close();
  });
});
