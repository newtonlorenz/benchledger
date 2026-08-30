import { describe, expect, it } from "vitest";
import {
  ArtifactBuildConfigurationBindingRepository,
  BuildConfigurationSnapshotRepository,
  CatalogProductRepository,
  BenchDatabase,
  InventoryProductProfileRepository,
  ProjectRepository,
  computeBuildConfigurationContentSha256,
  deterministicJson
} from "./index.js";
import type { BuildConfigurationSnapshot, CatalogProduct, InventoryProductProfile } from "@benchledger/api-contract";
import { createProject, createProjectRevision } from "@benchledger/domain";

const time = "2026-08-30T12:00:00.000Z";

const printer: Extract<CatalogProduct, { readonly kind: "printer" }> = {
  id: "coverage-printer",
  kind: "printer",
  manufacturer: "Bambu Lab",
  exactModel: "H2D",
  exactVariant: "AMS Combo",
  technology: "fff",
  buildVolumeMm: { x: 325, y: 320, z: 325 },
  createdAt: time,
  updatedAt: time,
  version: 1
};

const filament: Extract<CatalogProduct, { readonly kind: "filament" }> = {
  id: "coverage-filament",
  kind: "filament",
  manufacturer: "Example Materials",
  productName: "PLA Black",
  materialFamily: "PLA",
  materialSubtype: "Standard",
  colourName: "Black",
  diameterMm: 1.75,
  nominalNetMassG: 1000,
  lengthBasis: "unknown",
  createdAt: time,
  updatedAt: time,
  version: 1
};

function seed(database: BenchDatabase): void {
  const projects = new ProjectRepository(database);
  projects.create(createProject({ id: "coverage-project", name: "Coverage project" }));
  projects.createRevision(createProjectRevision({ id: "coverage-revision", projectId: "coverage-project", number: 1 }));
  database.run(
    `INSERT INTO inventory_items
      (id, name, category, variant, purchased_quantity, unit, source_status, reuse_policy, confidence,
       reported_quantity, manufacturer, model, dimensions_json, source_json, notes, created_at, updated_at, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["coverage-spool", "Coverage spool", "filament", null, 1, "spool", "physically_counted", "inspect_first", "confirmed", 1000, "Example Materials", "PLA Black", null, null, null, time, time, null]
  );
  database.run(
    `INSERT INTO inventory_items
      (id, name, category, variant, purchased_quantity, unit, source_status, reuse_policy, confidence,
       reported_quantity, manufacturer, model, dimensions_json, source_json, notes, created_at, updated_at, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["coverage-printer-item", "Coverage printer", "printer", null, 1, "printer", "commissioned_available", "machine_specific", "confirmed", null, "Bambu Lab", "H2D", null, null, null, time, time, null]
  );
}

function snapshotInput(overrides: Partial<BuildConfigurationSnapshot> = {}): Omit<BuildConfigurationSnapshot, "contentSha256" | "createdAt"> {
  return {
    id: "coverage-snapshot",
    projectRevisionId: "coverage-revision",
    printerItemSnapshot: {
      itemId: "coverage-printer-item",
      catalogProductId: printer.id,
      linkState: "confirmed",
      manufacturer: printer.manufacturer,
      exactModel: printer.exactModel,
      technology: "fff",
      buildVolumeMm: printer.buildVolumeMm
    },
    filamentSelections: [{
      itemId: "coverage-spool",
      catalogProductId: filament.id,
      linkState: "reported",
      manufacturer: filament.manufacturer,
      materialFamily: filament.materialFamily,
      colourName: filament.colourName,
      diameterMm: filament.diameterMm
    }],
    activeHotend: { side: "left" },
    nozzle: { diameterMm: 0.4, material: "hardened_steel" },
    plate: { name: "Cool Plate" },
    accessories: [],
    firmware: { version: "1.0" },
    slicer: { name: "Bambu Studio", version: "1.0" },
    profile: { name: "Standard" },
    calibration: { state: "current" },
    explicitUnknowns: [],
    ...overrides
  };
}

describe("catalog repository validation and pagination edges", () => {
  it("rejects invalid pages/cursors and keeps missing products and all-pages reads explicit", () => {
    const database = new BenchDatabase(":memory:");
    const products = new CatalogProductRepository(database);
    products.create(printer);
    products.create(filament);

    expect(products.get("does-not-exist")).toBeUndefined();
    expect(() => products.list({ limit: 0 })).toThrow(/limit/i);
    expect(() => products.list({ limit: 201 })).toThrow(/limit/i);
    expect(() => products.list({ cursor: "not-base64-json" })).toThrow(/cursor/i);
    expect(products.list({ kind: "printer", limit: 10 }).data).toHaveLength(1);
    expect(products.listAll({ kind: "filament" })).toHaveLength(1);
    database.close();
  });

  it("enforces product identity/version invariants across update overloads", () => {
    const database = new BenchDatabase(":memory:");
    const products = new CatalogProductRepository(database);
    products.create(filament);

    expect(products.update(filament.id, 1, { colourName: "Graphite" })).toMatchObject({ colourName: "Graphite", version: 2 });
    expect(products.update(filament.id, { colourName: "White" }, 2)).toMatchObject({ colourName: "White", version: 3 });
    expect(() => products.update("does-not-exist", { colourName: "Red" }, 1)).toThrow(/does not exist/i);
    expect(() => products.update(filament.id, { id: "other" }, 3)).toThrow(/cannot change/i);
    expect(() => products.update(filament.id, { kind: "printer" }, 3)).toThrow(/cannot change/i);
    expect(() => products.update(filament.id, undefined as never, 3)).toThrow(/changes|required|invalid/i);
    expect(() => products.update(filament.id, { colourName: "Stale" }, 2)).toThrow(/version|changed/i);
    expect(() => products.create({ ...filament, id: "coverage-invalid-version", version: 2 })).toThrow(/version/i);
    database.close();
  });
});

describe("physical product profile repository edges", () => {
  it("validates references and pages by every supported profile filter", () => {
    const database = new BenchDatabase(":memory:");
    seed(database);
    const products = new CatalogProductRepository(database);
    products.create(printer);
    products.create(filament);
    const profiles = new InventoryProductProfileRepository(database, products);
    const profile: InventoryProductProfile = {
      id: "coverage-profile",
      itemId: "coverage-spool",
      catalogProductId: filament.id,
      profileType: "filament_spool",
      linkState: "reported",
      details: { lot: "LOT-1" },
      createdAt: time,
      updatedAt: time,
      version: 1
    };
    profiles.create(profile);

    expect(profiles.get("missing-profile")).toBeUndefined();
    expect(profiles.list({ itemId: profile.itemId, catalogProductId: filament.id, profileType: "filament_spool", linkState: "reported", limit: 10 }).data).toHaveLength(1);
    expect(profiles.listAll({ catalogProductId: filament.id })).toHaveLength(1);
    expect(() => profiles.list({ cursor: "broken" })).toThrow(/cursor/i);
    expect(() => profiles.create({ ...profile, id: "bad-item", itemId: "no-item" })).toThrow(/inventory item/i);
    expect(() => profiles.create({ ...profile, id: "bad-product", catalogProductId: "no-product" })).toThrow(/catalog product/i);
    expect(() => profiles.create({ ...profile, id: "wrong-product", catalogProductId: printer.id })).toThrow(/requires a filament/i);
    expect(() => profiles.create({ ...profile, id: "bad-version", version: 2 })).toThrow(/version/i);
    database.close();
  });

  it("protects immutable identity fields and checks optimistic updates", () => {
    const database = new BenchDatabase(":memory:");
    seed(database);
    const products = new CatalogProductRepository(database);
    products.create(printer);
    products.create(filament);
    const profiles = new InventoryProductProfileRepository(database, products);
    profiles.create({ id: "coverage-profile", itemId: "coverage-spool", catalogProductId: filament.id, profileType: "filament_spool", linkState: "reported", details: {}, createdAt: time, updatedAt: time, version: 1 });

    expect(profiles.update("coverage-profile", 1, { linkState: "confirmed" })).toMatchObject({ linkState: "confirmed", version: 2 });
    expect(profiles.update("coverage-profile", { details: { lot: "LOT-2" } }, 2)).toMatchObject({ version: 3 });
    expect(() => profiles.update("missing-profile", {}, 1)).toThrow(/does not exist/i);
    expect(() => profiles.update("coverage-profile", { id: "other" }, 3)).toThrow(/cannot change/i);
    expect(() => profiles.update("coverage-profile", { itemId: "coverage-printer-item" }, 3)).toThrow(/cannot change/i);
    expect(() => profiles.update("coverage-profile", { profileType: "printer_asset" }, 3)).toThrow(/cannot change/i);
    expect(() => profiles.update("coverage-profile", { catalogProductId: printer.id }, 3)).toThrow(/requires a filament/i);
    expect(() => profiles.update("coverage-profile", undefined as never, 3)).toThrow(/changes|required|invalid/i);
    expect(() => profiles.update("coverage-profile", { linkState: "suggested" }, 2)).toThrow(/version|changed/i);
    database.close();
  });
});

describe("immutable build snapshots and binding edges", () => {
  it("rejects server-owned metadata, invalid clocks, ancestry gaps, and malformed content", () => {
    const database = new BenchDatabase(":memory:");
    seed(database);
    const products = new CatalogProductRepository(database);
    products.create(printer);
    products.create(filament);
    const snapshots = new BuildConfigurationSnapshotRepository(database, { clock: () => time });

    expect(() => snapshots.create({ ...snapshotInput(), contentSha256: "x".repeat(64) } as never)).toThrow(/server-owned/i);
    expect(() => snapshots.create({ ...snapshotInput(), createdAt: time } as never)).toThrow(/server-owned/i);
    expect(() => snapshots.create(snapshotInput({ projectRevisionId: "missing-revision" }))).toThrow(/revision/i);
    expect(() => snapshots.create(snapshotInput({ supersedesSnapshotId: "missing-snapshot" }))).toThrow(/superseded snapshot/i);
    const first = snapshots.create(snapshotInput());
    expect(() => snapshots.create(snapshotInput({ id: first.id, supersedesSnapshotId: first.id }))).toThrow(/itself|ancestry/i);
    expect(() => snapshots.create(snapshotInput({ id: "wrong-ancestor", projectRevisionId: "other-revision", supersedesSnapshotId: first.id }))).toThrow(/revision|ancestry/i);
    expect(() => new BuildConfigurationSnapshotRepository(database, { clock: () => "not-a-date" }).create(snapshotInput({ id: "bad-clock" }))).toThrow(/timestamp/i);
    expect(snapshots.get("missing-snapshot")).toBeUndefined();
    expect(snapshots.list({ projectRevisionId: "coverage-revision", limit: 10 }).data).toHaveLength(1);
    expect(() => snapshots.list({ cursor: "bad-cursor" })).toThrow(/cursor/i);
    expect(() => computeBuildConfigurationContentSha256({ accessories: [Number.NaN] } as never)).toThrow(/finite/i);
    expect(() => deterministicJson(Symbol("unsupported"))).toThrow(/unsupported/i);
    database.close();
  });

  it("pages bindings, accepts omitted revision ancestry, and keeps bindings immutable", () => {
    const database = new BenchDatabase(":memory:");
    seed(database);
    const products = new CatalogProductRepository(database);
    products.create(printer);
    products.create(filament);
    const snapshots = new BuildConfigurationSnapshotRepository(database, { clock: () => time });
    const snapshot = snapshots.create(snapshotInput());
    const bindings = new ArtifactBuildConfigurationBindingRepository(database, snapshots, { clock: () => time });
    const created = bindings.create({ id: "coverage-binding", artifactId: "artifact-1", buildConfigurationSnapshotId: snapshot.id });
    expect(created).toMatchObject({ projectRevisionId: "coverage-revision", createdAt: time });
    expect(bindings.get(created.id)).toEqual(created);
    expect(bindings.get("missing-binding")).toBeUndefined();
    expect(bindings.list({ artifactId: "artifact-1", buildConfigurationSnapshotId: snapshot.id, projectRevisionId: "coverage-revision", limit: 10 }).data).toHaveLength(1);
    expect(() => bindings.create({ id: "missing-snapshot-binding", artifactId: "artifact-2", buildConfigurationSnapshotId: "missing-snapshot" })).toThrow(/snapshot/i);
    expect(() => bindings.create({ id: "wrong-revision-binding", artifactId: "artifact-3", buildConfigurationSnapshotId: snapshot.id, projectRevisionId: "other-revision" })).toThrow(/revision/i);
    expect(() => bindings.list({ cursor: "bad-cursor" })).toThrow(/cursor/i);
    expect(() => bindings.delete(created.id)).toThrow(/cannot be deleted/i);
    database.close();
  });
});
