import { describe, expect, it } from "vitest";
import {
  ArtifactBuildConfigurationBindingRepository,
  CATALOG_SCHEMA_VERSION,
  BuildConfigurationSnapshotRepository,
  CatalogProductRepository,
  BenchDatabase,
  InventoryProductProfileRepository,
  ProjectRepository,
  computeBuildConfigurationContentSha256,
  migrateCatalogSchema,
} from "./index.js";
import type {
  BuildConfigurationSnapshot,
  CatalogProduct,
  InventoryProductProfile,
} from "@benchledger/api-contract";
import { createProject, createProjectRevision } from "@benchledger/domain";

const time = "2026-08-30T12:00:00.000Z";

const filament: CatalogProduct = {
  id: "catalog-filament-1",
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
  version: 1,
};

const printer: CatalogProduct = {
  id: "catalog-printer-1",
  kind: "printer",
  manufacturer: "Bambu Lab",
  exactModel: "H2D",
  technology: "fff",
  buildVolumeMm: { x: 325, y: 320, z: 325 },
  createdAt: time,
  updatedAt: time,
  version: 1,
};

describe("catalog migration", () => {
  it("is additive, idempotent, and refuses a newer recorded schema", () => {
    const database = new BenchDatabase(":memory:");
    migrateCatalogSchema(database);
    migrateCatalogSchema(database);
    expect(database.get("SELECT value FROM forge_meta WHERE key = ?", ["catalog_schema_version"])).toEqual({ value: String(CATALOG_SCHEMA_VERSION) });
    expect(database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", ["inventory_items"])).toBeDefined();
    expect(database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", ["catalog_products"])).toBeDefined();
    expect(database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", ["catalog_product_history"])).toBeDefined();
    database.run("UPDATE forge_meta SET value = ? WHERE key = ?", [String(CATALOG_SCHEMA_VERSION + 1), "catalog_schema_version"]);
    expect(() => migrateCatalogSchema(database)).toThrow(/newer than supported/i);
    database.close();
  });
});

function spoolProfile(id = "profile-spool-1"): InventoryProductProfile {
  return {
    id,
    itemId: "legacy-filament-1",
    catalogProductId: filament.id,
    profileType: "filament_spool",
    linkState: "reported",
    details: { lot: "LOT-1", openedState: "sealed" },
    createdAt: time,
    updatedAt: time,
    version: 1,
  };
}

function snapshotWithoutHash(projectRevisionId: string, id = "build-config-1"): Omit<BuildConfigurationSnapshot, "contentSha256" | "createdAt"> {
  return {
    id,
    projectRevisionId,
    printerItemSnapshot: {
      itemId: "legacy-printer-1",
      catalogProductId: printer.id,
      linkState: "confirmed",
      manufacturer: "Bambu Lab",
      exactModel: "H2D",
      technology: "fff",
      buildVolumeMm: { x: 325, y: 320, z: 325 },
    },
    filamentSelections: [{
      itemId: "legacy-filament-1",
      catalogProductId: filament.id,
      linkState: "reported",
      manufacturer: "Example Materials",
      lot: "LOT-1",
      materialFamily: "PLA",
      colourName: "Black",
      diameterMm: 1.75,
    }],
    activeHotend: { side: "left", model: "stock" },
    nozzle: { diameterMm: 0.4, material: "hardened_steel" },
    plate: { name: "Cool Plate", surface: "smooth" },
    accessories: [],
    firmware: { version: "1.0" },
    slicer: { name: "Bambu Studio", version: "1.0" },
    profile: { name: "0.20 Standard", version: "1" },
    calibration: { state: "current", recordedAt: time },
    explicitUnknowns: ["lot mass not measured"],
  };
}

function seedLegacyRows(database: BenchDatabase): void {
  const projects = new ProjectRepository(database);
  projects.create(createProject({ id: "project-1", name: "Catalog test" }));
  projects.createRevision(createProjectRevision({ id: "revision-1", projectId: "project-1", number: 1 }));
  database.run(
    `INSERT INTO inventory_items
      (id, name, category, variant, purchased_quantity, unit, source_status, reuse_policy, confidence,
       reported_quantity, manufacturer, model, dimensions_json, source_json, notes, created_at, updated_at, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["legacy-filament-1", "Legacy PLA", "filament", null, 1, "spool", "delivered_uncounted", "inspect_first", "unknown", null, null, null, null, null, "preserve me", time, time, null]
  );
  database.run(
    `INSERT INTO inventory_items
      (id, name, category, variant, purchased_quantity, unit, source_status, reuse_policy, confidence,
       reported_quantity, manufacturer, model, dimensions_json, source_json, notes, created_at, updated_at, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["legacy-printer-1", "Legacy printer", "printer", null, 1, "printer", "commissioned_available", "machine_specific", "confirmed", null, null, null, null, null, "preserve me", time, time, null]
  );
}

describe("v2 catalog and physical profile repositories", () => {
  it("adds exact products without rewriting legacy inventory and pages deterministically", () => {
    const database = new BenchDatabase(":memory:");
    seedLegacyRows(database);
    const legacyBefore = database.get("SELECT name, notes, purchased_quantity FROM inventory_items WHERE id = ?", ["legacy-filament-1"]);
    const products = new CatalogProductRepository(database);
    products.create(printer);
    products.create(filament);
    products.create({ ...filament, id: "catalog-filament-2", colourName: "White" });

    const first = products.list({ kind: "filament", limit: 2 });
    expect(first.data.map((value) => value.id)).toEqual(["catalog-filament-1", "catalog-filament-2"]);
    expect(first.total).toBe(2);
    expect(first.nextCursor).toBeUndefined();
    const all = products.list({ limit: 2 });
    expect(all.data.map((value) => value.id)).toEqual(["catalog-filament-1", "catalog-filament-2"]);
    expect(all.nextCursor).toBeDefined();
    if (all.nextCursor === undefined) throw new Error("expected a second page");
    expect(products.list({ limit: 2, cursor: all.nextCursor }).data.map((value) => value.id)).toEqual(["catalog-printer-1"]);
    expect(database.get("SELECT name, notes, purchased_quantity FROM inventory_items WHERE id = ?", ["legacy-filament-1"])).toEqual(legacyBefore);
    database.close();
  });

  it("uses optimistic versions for catalog products and profiles", () => {
    const database = new BenchDatabase(":memory:");
    seedLegacyRows(database);
    const products = new CatalogProductRepository(database);
    products.create(filament);
    const changed = products.update(filament.id, { colourName: "Graphite" }, 1);
    expect(changed).toMatchObject({ id: filament.id, colourName: "Graphite", version: 2 });
    expect(() => products.update(filament.id, { colourName: "Stale" }, 1)).toThrow(/version|conflict/i);

    const sourced = {
      ...filament,
      id: "catalog-sourced-filament",
      provenance: {
        sourceUrl: "https://materials.example.test/pla",
        sourceLabel: "Example manufacturer product page",
        verifiedAt: time,
      },
    } satisfies CatalogProduct;
    products.create(sourced);
    const noOp = products.update(sourced.id, { colourName: sourced.colourName }, 1);
    expect(noOp.provenance).toEqual(sourced.provenance);
    const corrected = products.update(sourced.id, { colourName: "Graphite" }, 2);
    expect(corrected.provenance).toBeUndefined();
    const history = database.all<{ readonly catalog_product_id: string; readonly superseded_version: number; readonly payload_json: string }>(
      "SELECT catalog_product_id, superseded_version, payload_json FROM catalog_product_history WHERE catalog_product_id = ? ORDER BY superseded_version",
      [sourced.id],
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ catalog_product_id: sourced.id, superseded_version: 2 });
    expect(JSON.parse(history[0]!.payload_json)).toMatchObject({
      id: sourced.id,
      kind: sourced.kind,
      manufacturer: sourced.manufacturer,
      productName: sourced.productName,
      materialFamily: sourced.materialFamily,
      diameterMm: sourced.diameterMm,
      nominalNetMassG: sourced.nominalNetMassG,
      lengthBasis: sourced.lengthBasis,
      version: 2,
      colourName: sourced.colourName,
      provenance: sourced.provenance,
    });

    const correctedAgain = products.update(sourced.id, { colourName: "Slate" }, 3);
    expect(correctedAgain.provenance).toBeUndefined();
    const historyAfterSecondCorrection = database.all<{ readonly superseded_version: number; readonly payload_json: string }>(
      "SELECT superseded_version, payload_json FROM catalog_product_history WHERE catalog_product_id = ? ORDER BY superseded_version",
      [sourced.id],
    );
    expect(historyAfterSecondCorrection.map((entry) => entry.superseded_version)).toEqual([2, 3]);
    expect(JSON.parse(historyAfterSecondCorrection[1]!.payload_json)).toMatchObject({ colourName: "Graphite", version: 3 });

    const specificationChanged = products.update(sourced.id, { nominalNetMassG: 750 }, 4);
    expect(specificationChanged).toMatchObject({ nominalNetMassG: 750, version: 5 });
    expect(specificationChanged.provenance).toBeUndefined();
    const specificationHistory = database.all<{ readonly superseded_version: number; readonly payload_json: string }>(
      "SELECT superseded_version, payload_json FROM catalog_product_history WHERE catalog_product_id = ? ORDER BY superseded_version",
      [sourced.id],
    );
    expect(specificationHistory.map((entry) => entry.superseded_version)).toEqual([2, 3, 4]);
    expect(JSON.parse(specificationHistory[2]!.payload_json)).toMatchObject({ colourName: "Slate", nominalNetMassG: 1000, version: 4 });

    const provenanceOnly = {
      ...filament,
      id: "catalog-provenance-only",
      provenance: {
        sourceUrl: "https://materials.example.test/old-product",
        sourceLabel: "Old manufacturer product page",
        verifiedAt: time,
      },
    } satisfies CatalogProduct;
    products.create(provenanceOnly);
    const provenanceUpdated = products.update(provenanceOnly.id, {
      provenance: {
        sourceUrl: "https://materials.example.test/new-product",
        sourceLabel: "New manufacturer product page",
        verifiedAt: "2026-08-31T12:00:00.000Z",
      },
    }, 1);
    expect(provenanceUpdated).toMatchObject({ version: 2, provenance: { sourceUrl: "https://materials.example.test/new-product" } });
    const provenanceHistory = database.get<{ readonly superseded_version: number; readonly payload_json: string }>(
      "SELECT superseded_version, payload_json FROM catalog_product_history WHERE catalog_product_id = ?",
      [provenanceOnly.id],
    );
    expect(provenanceHistory?.superseded_version).toBe(1);
    expect(JSON.parse(provenanceHistory!.payload_json)).toMatchObject({
      id: provenanceOnly.id,
      version: 1,
      provenance: provenanceOnly.provenance,
    });

    const profiles = new InventoryProductProfileRepository(database);
    profiles.create(spoolProfile());
    const promoted = profiles.update("profile-spool-1", { linkState: "confirmed" }, 1);
    expect(promoted).toMatchObject({ linkState: "confirmed", version: 2 });
    expect(() => profiles.update("profile-spool-1", { linkState: "suggested" }, 1)).toThrow(/version|conflict/i);
    expect(() => profiles.update("profile-spool-1", { itemId: "legacy-printer-1" }, 2)).toThrow(/itemId|change/i);
    database.close();
  });
});

describe("immutable build configuration snapshots", () => {
  it("returns the true latest snapshot without relying on the first bounded page", () => {
    const database = new BenchDatabase(":memory:");
    seedLegacyRows(database);
    const snapshots = new BuildConfigurationSnapshotRepository(database, {
      clock: (() => {
        let ordinal = 0;
        return () => new Date(Date.parse(time) + (++ordinal * 1000)).toISOString();
      })(),
    });

    for (let ordinal = 1; ordinal <= 201; ordinal += 1) {
      snapshots.create(snapshotWithoutHash("revision-1", `build-config-${String(ordinal).padStart(3, "0")}`));
    }

    const firstPage = snapshots.list({ projectRevisionId: "revision-1", limit: 200 });
    expect(firstPage.data).toHaveLength(200);
    expect(firstPage.nextCursor).toBeDefined();
    expect(firstPage.data.at(-1)?.id).toBe("build-config-200");
    expect(snapshots.latest("revision-1")?.id).toBe("build-config-201");
    database.close();
  });

  it("computes a deterministic hash, preserves ancestry, and exposes no mutation path", () => {
    const database = new BenchDatabase(":memory:");
    seedLegacyRows(database);
    const products = new CatalogProductRepository(database);
    products.create(filament);
    products.create(printer);
    const profiles = new InventoryProductProfileRepository(database);
    profiles.create(spoolProfile());
    const snapshots = new BuildConfigurationSnapshotRepository(database);
    const input = snapshotWithoutHash("revision-1");
    expect(computeBuildConfigurationContentSha256(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeBuildConfigurationContentSha256({
      ...input,
      supersedesSnapshotId: "previous-snapshot",
      capturedAt: time,
      createdBy: "agent",
      contentSha256: "f".repeat(64),
    })).toBe(computeBuildConfigurationContentSha256(input));
    const first = snapshots.create(input);
    expect(first.contentSha256).toBe(computeBuildConfigurationContentSha256(first));
    expect(snapshots.get(first.id)).toEqual(first);
    expect(() => snapshots.update(first.id, {})).toThrow(/immutable|snapshot/i);
    expect(() => snapshots.delete(first.id)).toThrow(/immutable|snapshot/i);

    const replacement = snapshots.create({ ...snapshotWithoutHash("revision-1", "build-config-2"), supersedesSnapshotId: first.id });
    expect(replacement.supersedesSnapshotId).toBe(first.id);
    expect(replacement.contentSha256).toBe(first.contentSha256);
    expect(() => snapshots.create({ ...snapshotWithoutHash("revision-other", "build-config-3"), supersedesSnapshotId: first.id })).toThrow(/revision|ancestry/i);
    database.close();
  });

  it("keeps content identity stable across revisions while retaining ancestry", () => {
    const database = new BenchDatabase(":memory:");
    seedLegacyRows(database);
    const projects = new ProjectRepository(database);
    projects.createRevision(createProjectRevision({ id: "revision-other", projectId: "project-1", number: 2 }));
    const products = new CatalogProductRepository(database);
    products.create(filament);
    products.create(printer);
    const snapshots = new BuildConfigurationSnapshotRepository(database);
    const first = snapshots.create(snapshotWithoutHash("revision-1", "build-config-cross-revision-1"));
    const second = snapshots.create(snapshotWithoutHash("revision-other", "build-config-cross-revision-2"));

    expect(first.projectRevisionId).toBe("revision-1");
    expect(second.projectRevisionId).toBe("revision-other");
    expect(second.contentSha256).toBe(first.contentSha256);
    expect(() => snapshots.create({
      ...snapshotWithoutHash("revision-other", "build-config-cross-revision-3"),
      supersedesSnapshotId: first.id,
    })).toThrow(/revision|ancestry/i);
    database.close();
  });
});

describe("artifact build configuration bindings", () => {
  it("requires binding revision ancestry and pages stable bindings", () => {
    const database = new BenchDatabase(":memory:");
    seedLegacyRows(database);
    const snapshots = new BuildConfigurationSnapshotRepository(database);
    const snapshot = snapshots.create(snapshotWithoutHash("revision-1"));
    const bindings = new ArtifactBuildConfigurationBindingRepository(database, snapshots);
    const created = bindings.create({
      id: "binding-1",
      artifactId: "artifact-1",
      buildConfigurationSnapshotId: snapshot.id,
      projectRevisionId: "revision-1",
      createdAt: time,
    });
    expect(created).toMatchObject({ artifactId: "artifact-1", buildConfigurationSnapshotId: snapshot.id });
    expect(bindings.list({ limit: 10 }).data).toHaveLength(1);
    expect(() => bindings.create({
      id: "binding-2",
      artifactId: "artifact-2",
      buildConfigurationSnapshotId: snapshot.id,
      projectRevisionId: "revision-other",
      createdAt: time,
    })).toThrow(/revision|ancestry/i);
    database.close();
  });
});
