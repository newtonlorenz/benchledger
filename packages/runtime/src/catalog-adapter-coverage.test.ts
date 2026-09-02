import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationError, ApplicationService } from "@benchledger/application";
import type { RequestContext } from "@benchledger/application";
import type { CatalogProduct } from "@benchledger/api-contract";
import { createProductionRuntime, type ProductionRuntime } from "./index.js";

const time = "2026-08-30T12:00:00.000Z";
const context: RequestContext = {
  actor: "catalog-coverage",
  source: "api",
  correlationId: "catalog-coverage-correlation",
  scopes: new Set(["read", "write", "catalog:read", "catalog:write", "projects:read", "projects:write"])
};

const filament: CatalogProduct = {
  id: "runtime-filament",
  kind: "filament",
  manufacturer: "Example Materials",
  productName: "PLA Black",
  materialFamily: "PLA",
  colourName: "Black",
  diameterMm: 1.75,
  nominalNetMassG: 1000,
  lengthBasis: "unknown",
  createdAt: time,
  updatedAt: time,
  version: 1
};

const printer: CatalogProduct = {
  id: "runtime-printer",
  kind: "printer",
  manufacturer: "Bambu Lab",
  exactModel: "H2D",
  technology: "fff",
  buildVolumeMm: { x: 325, y: 320, z: 325 },
  createdAt: time,
  updatedAt: time,
  version: 1
};

const filamentCreate = {
  kind: "filament" as const,
  manufacturer: filament.manufacturer,
  productName: filament.productName,
  materialFamily: filament.materialFamily,
  colourName: filament.colourName,
  diameterMm: filament.diameterMm,
  nominalNetMassG: filament.nominalNetMassG,
  lengthBasis: filament.lengthBasis
};

const printerCreate = {
  kind: "printer" as const,
  manufacturer: printer.manufacturer,
  exactModel: printer.exactModel,
  technology: printer.technology,
  buildVolumeMm: printer.buildVolumeMm
};

const runtimes: ProductionRuntime[] = [];
const directories: string[] = [];

async function makeRuntime(): Promise<ProductionRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), "benchledger-catalog-adapter-"));
  directories.push(dataDir);
  const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production catalog adapter", () => {
  it("creates, searches, clones, and updates canonical products", async () => {
    const runtime = await makeRuntime();
    const catalog = runtime.ports.catalog!;
    const created = await catalog.createProduct(filamentCreate, context);
    expect(created).toMatchObject({ kind: "filament", manufacturer: filament.manufacturer, version: 1 });
    const listed = await catalog.listProducts({ limit: 200, q: "pla" });
    expect(listed.data.some((product) => product.id === created.id)).toBe(true);
    expect(listed.total).toBeGreaterThan(1);
    const noMatch = await catalog.listProducts({ limit: 10, q: "not-found" });
    expect(noMatch.data).toEqual([]);
    expect(await catalog.getProduct("missing-product")).toBeNull();
    const changed = await catalog.updateProduct(created.id, { colourName: "Graphite" }, 1, context);
    expect(changed).toMatchObject({ colourName: "Graphite", version: 2 });
    await expect(catalog.updateProduct("missing-product", { colourName: "Red" }, undefined, context)).rejects.toBeInstanceOf(ApplicationError);
    await expect(catalog.updateProduct(created.id, { colourName: "Red" }, 1, context)).rejects.toMatchObject({ code: "conflict" });
    const copy = await catalog.getProduct(created.id);
    expect(copy).not.toBe(created);
    expect(copy).toMatchObject({ colourName: "Graphite" });
  });

  it("creates and updates physical profiles while preserving kind and version checks", async () => {
    const runtime = await makeRuntime();
    const catalog = runtime.ports.catalog!;
    const item = await runtime.ports.inventory.createItem({ id: "runtime-spool", name: "PLA spool", kind: "filament", quantity: 1000, unit: "gram", tags: [], links: [], evidence: { state: "physically_counted" } }, context);
    const product = await catalog.createProduct(filamentCreate, context);
    const profile = await catalog.putInventoryProductProfile(item.id, { catalogProductId: product.id, profileType: "filament_spool", linkState: "reported", details: { lot: "LOT-1" } }, undefined, context);
    expect(profile).toMatchObject({ itemId: item.id, catalogProductId: product.id, version: 1 });
    expect(await catalog.getInventoryProductProfile(item.id)).toMatchObject({ id: profile.id });
    await expect(catalog.putInventoryProductProfile(item.id, { linkState: "confirmed", details: {} }, 99, context)).rejects.toMatchObject({ code: "conflict" });
    const updated = await catalog.putInventoryProductProfile(item.id, { linkState: "confirmed", details: { lot: "LOT-2" } }, profile.version, context);
    expect(updated).toMatchObject({ linkState: "confirmed", version: 2 });
    expect(await catalog.getInventoryProductProfile("missing-item")).toBeNull();
  });
});

describe("production build configuration adapter", () => {
  it("lists, clones, and reads immutable snapshots through the runtime port", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const project = await service.createProject({ id: "runtime-config-project", name: "Runtime config", status: "planned" }, context);
    const revision = await service.createProjectRevision(project.data.id, { id: "runtime-config-revision", name: "Initial", status: "concept" }, context);
    const printerItem = await service.createInventoryItem({ id: "runtime-config-printer", name: "H2D", kind: "printer", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "commissioned" } }, context);
    const filamentItem = await service.createInventoryItem({ id: "runtime-config-filament", name: "PLA", kind: "filament", quantity: 1000, unit: "gram", tags: [], links: [], evidence: { state: "physically_counted" } }, context);
    const printerProduct = await service.createCatalogProduct(printerCreate, context);
    const filamentProduct = await service.createCatalogProduct(filamentCreate, context);
    const printerProfile = await service.putInventoryProductProfile(printerItem.data.id, { catalogProductId: printerProduct.data.id, profileType: "printer_asset", linkState: "confirmed", details: {} }, undefined, context);
    const filamentProfile = await service.putInventoryProductProfile(filamentItem.data.id, { catalogProductId: filamentProduct.data.id, profileType: "filament_spool", linkState: "confirmed", details: {} }, undefined, context);
    const snapshot = await service.createBuildConfiguration(revision.data.id, {
      printerItemSnapshot: { itemId: printerItem.data.id, catalogProductId: printerProduct.data.id, profileId: printerProfile.data.id },
      filamentSelections: [{ itemId: filamentItem.data.id, catalogProductId: filamentProduct.data.id, profileId: filamentProfile.data.id }],
      activeHotend: "left", nozzle: { diameterMm: 0.4 }, plate: "Textured PEI", accessories: [], firmware: "01", slicer: "Bambu Studio", profile: "Standard", calibration: "checked", explicitUnknowns: []
    }, context);
    const adapter = runtime.ports.buildConfigurations!;
    expect(await adapter.getBuildConfiguration("missing-snapshot")).toBeNull();
    expect(await adapter.listBuildConfigurations(revision.data.id, { limit: 10 })).toMatchObject({ data: [expect.objectContaining({ id: snapshot.data.id })], total: 1 });
    expect(await adapter.getLatestBuildConfiguration(revision.data.id)).toEqual(snapshot.data);
    expect(await adapter.getBuildConfiguration(snapshot.data.id)).toEqual(snapshot.data);
    const { id: _snapshotId, ...snapshotDraft } = snapshot.data;
    const recreated = await adapter.createBuildConfiguration(snapshotDraft as never, context);
    expect(recreated).toMatchObject({ projectRevisionId: revision.data.id, contentSha256: snapshot.data.contentSha256 });
  });

  it("round-trips physical-only filament evidence across restart without rehydrating inventory", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const project = await service.createProject({ id: "runtime-physical-project", name: "Physical snapshot", status: "planned" }, context);
    const revision = await service.createProjectRevision(project.data.id, { id: "runtime-physical-revision", name: "Initial", status: "concept" }, context);
    const printerItem = await service.createInventoryItem({ id: "runtime-physical-printer", name: "H2D", kind: "printer", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "commissioned" } }, context);
    const filamentItem = await service.createInventoryItem({
      id: "runtime-physical-filament",
      name: "Unidentified PETG spool",
      kind: "filament",
      quantity: 760,
      unit: "gram",
      tags: [],
      links: [],
      evidence: { state: "physically_counted", source: "synthetic bench count", observedAt: time, note: "Synthetic physical-only filament fixture" },
    }, context);
    const printerProduct = await service.createCatalogProduct(printerCreate, context);
    const printerProfile = await service.putInventoryProductProfile(printerItem.data.id, { catalogProductId: printerProduct.data.id, profileType: "printer_asset", linkState: "confirmed", details: {} }, undefined, context);
    const counts = () => Object.fromEntries(["inventory_items", "stock_events", "catalog_products", "inventory_product_profiles", "reservations", "build_configuration_snapshots"].map((table) => [table, runtime.database.get<{ readonly count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count]));
    const before = counts();

    const snapshot = await service.createBuildConfiguration(revision.data.id, {
      printerItemSnapshot: { itemId: printerItem.data.id, catalogProductId: printerProduct.data.id, profileId: printerProfile.data.id },
      filamentSelections: [{ itemId: filamentItem.data.id, catalogIdentityState: "unknown", role: "model", quantity: 320 }],
      activeHotend: "left", nozzle: { diameterMm: 0.4 }, plate: "Textured PEI", accessories: [], firmware: "01", slicer: "Bambu Studio", profile: "Standard", calibration: "checked", explicitUnknowns: [],
    }, context);
    expect(snapshot.data.filamentSelections).toEqual([{
      itemId: filamentItem.data.id,
      catalogIdentityState: "unknown",
      physicalLabel: "Unidentified PETG spool",
      physicalEvidence: filamentItem.data.evidence,
      role: "model",
      quantity: 320,
    }]);
    expect(counts()).toEqual({ ...before, build_configuration_snapshots: (before.build_configuration_snapshots ?? 0) + 1 });

    // A later inventory correction must not change the immutable snapshot.
    runtime.database.run("UPDATE inventory_items SET name = ? WHERE id = ?", ["Corrected mutable inventory label", filamentItem.data.id]);
    const dataDir = runtime.dataDir;
    await runtime.close();
    const reopened = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(reopened);
    const adapter = reopened.ports.buildConfigurations!;
    await expect(adapter.getBuildConfiguration(snapshot.data.id)).resolves.toEqual(snapshot.data);
    await expect(adapter.getLatestBuildConfiguration(revision.data.id)).resolves.toEqual(snapshot.data);
    await expect(adapter.listBuildConfigurations(revision.data.id, { limit: 10 })).resolves.toMatchObject({ data: [snapshot.data], total: 1 });

    const row = reopened.database.get<{ readonly payload_json: string }>("SELECT payload_json FROM build_configuration_snapshots WHERE id = ?", [snapshot.data.id]);
    if (row === undefined) throw new Error("expected durable physical-only snapshot");
    const tamperedPayload = JSON.parse(row.payload_json) as Record<string, unknown>;
    tamperedPayload.filamentSelections = [{ ...snapshot.data.filamentSelections[0], physicalLabel: "Tampered label" }];
    reopened.database.run("UPDATE build_configuration_snapshots SET payload_json = ? WHERE id = ?", [JSON.stringify(tamperedPayload), snapshot.data.id]);
    await expect(adapter.getBuildConfiguration(snapshot.data.id)).rejects.toMatchObject({ code: "integrity_error" });
    await expect(adapter.getLatestBuildConfiguration(revision.data.id)).rejects.toMatchObject({ code: "integrity_error" });
    await expect(adapter.listBuildConfigurations(revision.data.id, { limit: 10 })).rejects.toMatchObject({ code: "integrity_error" });
  });
});
