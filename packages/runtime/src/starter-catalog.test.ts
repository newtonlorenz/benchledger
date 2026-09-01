import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BenchDatabase, CatalogProductRepository, migrateCatalogSchema } from "@benchledger/database";
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
    expect(byId.get("starter-filament-bambu-pla-matte-charcoal")).toMatchObject({
      kind: "filament",
      colourName: "Matte Charcoal",
      colourCode: "11101",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
    });
    expect(byId.get("starter-filament-polymaker-polymax-petg-black")).toMatchObject({
      kind: "filament",
      colourName: "Black",
      sku: "PB02001",
      diameterMm: 1.75,
      nominalNetMassG: 750,
    });
    expect(byId.get("starter-filament-polymaker-polymide-pa6-gf-black")).toMatchObject({
      kind: "filament",
      colourName: "Grey",
      sku: "PG02001",
      diameterMm: 1.75,
      nominalNetMassG: 500,
    });
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
    database.close();
  });
});
