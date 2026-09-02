import { describe, expect, it } from "vitest";
import {
  artifactBuildConfigurationBindingSchema,
  beginUploadSchema,
  buildConfigurationSnapshotSchema,
  createBuildConfigurationSnapshotSchema,
  createCatalogProductSchema,
  createInventoryWithProductProfileSchema,
  catalogProductSchema,
  updateCatalogProductSchema,
  inventoryProductProfileSchema,
} from "./schemas.js";

const timestamps = {
  createdAt: "2026-08-30T12:00:00.000Z",
  updatedAt: "2026-08-30T12:00:00.000Z",
};

const filament = {
  id: "catalog-filament-pla-black",
  kind: "filament" as const,
  materialFamily: "PLA",
  materialSubtype: "PLA-CF",
  colourName: "Black",
  colourCode: "BK",
  diameterMm: 1.75,
  nominalNetMassG: 1000,
  nominalLengthM: 335,
  lengthBasis: "manufacturer_declared" as const,
  densityGcm3: 1.24,
  manufacturer: "Example Materials",
  productName: "Engineering PLA-CF",
  ...timestamps,
  version: 1,
};

const printer = {
  id: "catalog-printer-h2d",
  kind: "printer" as const,
  technology: "fff" as const,
  exactModel: "H2D",
  exactVariant: "AMS Combo",
  buildVolumeMm: { x: 325, y: 320, z: 325 },
  manufacturer: "Bambu Lab",
  ...timestamps,
  version: 1,
};

describe("v2 canonical catalog schemas", () => {
  it("accepts exact filament and printer products", () => {
    expect(catalogProductSchema.parse(filament)).toEqual(filament);
    expect(catalogProductSchema.parse(printer)).toEqual(printer);
  });

  it("rejects unknown fields and fields from the other product kind", () => {
    expect(() => catalogProductSchema.parse({ ...filament, unsupported: true })).toThrow();
    expect(() => catalogProductSchema.parse({ ...filament, technology: "fff" })).toThrow();
    expect(() => catalogProductSchema.parse({ ...printer, materialFamily: "PLA" })).toThrow();
    expect(() => catalogProductSchema.parse({ ...printer, buildVolumeMm: { x: 325, y: 320, z: 325, width: 1 } })).toThrow();
    expect(() => catalogProductSchema.parse({ ...filament, manufacturer: undefined })).toThrow();
    expect(() => catalogProductSchema.parse({ ...printer, manufacturer: undefined })).toThrow();
  });

  it("keeps curated provenance read-only at the public mutation boundary", () => {
    const sourced = {
      ...filament,
      provenance: {
        sourceUrl: "https://example.com/products/pla-cf",
        sourceLabel: "Manufacturer product page",
        verifiedAt: timestamps.updatedAt,
      },
    };
    const createInput = {
      kind: filament.kind,
      manufacturer: filament.manufacturer,
      productName: filament.productName,
      materialFamily: filament.materialFamily,
      materialSubtype: filament.materialSubtype,
      colourName: filament.colourName,
      colourCode: filament.colourCode,
      diameterMm: filament.diameterMm,
      nominalNetMassG: filament.nominalNetMassG,
      nominalLengthM: filament.nominalLengthM,
      lengthBasis: filament.lengthBasis,
      densityGcm3: filament.densityGcm3,
    };
    expect(createCatalogProductSchema.parse(createInput)).toEqual(createInput);
    expect(catalogProductSchema.parse(sourced)).toMatchObject({ provenance: sourced.provenance });
    expect(() => createCatalogProductSchema.parse({ ...createInput, provenance: sourced.provenance })).toThrow();
    expect(() => updateCatalogProductSchema.parse({ provenance: sourced.provenance })).toThrow();
  });
});

describe("v2 inventory product profile schemas", () => {
  it("keeps filament-spool and printer-asset details discriminated", () => {
    const spool = inventoryProductProfileSchema.parse({
      id: "profile-spool-1",
      itemId: "legacy-filament-1",
      catalogProductId: filament.id,
      profileType: "filament_spool",
      linkState: "confirmed",
      details: {
        lot: "LOT-1",
        openedState: "open",
        tareMassG: 164,
        currentPlacement: "AMS 2 Pro slot 1",
      },
      ...timestamps,
      version: 1,
    });
    const asset = inventoryProductProfileSchema.parse({
      id: "profile-printer-1",
      itemId: "legacy-printer-1",
      catalogProductId: printer.id,
      profileType: "printer_asset",
      linkState: "confirmed",
      details: {
        assetLabel: "H2D bench",
        commissionedAt: "2026-08-29T12:00:00.000Z",
      },
      ...timestamps,
      version: 1,
    });

    expect(spool.profileType).toBe("filament_spool");
    expect(asset.profileType).toBe("printer_asset");
  });

  it("rejects profile detail mixing and unknown fields", () => {
    const base = {
      id: "profile-1",
      itemId: "item-1",
      catalogProductId: "catalog-1",
      linkState: "reported" as const,
      ...timestamps,
      version: 1,
    };
    expect(() => inventoryProductProfileSchema.parse({
      ...base,
      profileType: "filament_spool",
      details: { commissionedAt: "2026-08-30T12:00:00.000Z" },
    })).toThrow();
    expect(() => inventoryProductProfileSchema.parse({
      ...base,
      profileType: "printer_asset",
      details: { tareMassG: 164 },
    })).toThrow();
    expect(() => inventoryProductProfileSchema.parse({
      ...base,
      profileType: "printer_asset",
      details: {},
      extra: true,
    })).toThrow();
  });
});

describe("v2 compound inventory/profile schema", () => {
  it("accepts exactly an item plus a profile without itemId", () => {
    const request = {
      item: {
        id: "new-spool",
        name: "PETG HF spool",
        kind: "filament" as const,
        quantity: 1000,
        unit: "gram" as const,
        tags: [],
        links: [],
        evidence: { state: "delivered_uncounted" as const },
      },
      profile: {
        catalogProductId: filament.id,
        profileType: "filament_spool" as const,
        linkState: "reported" as const,
        details: { openedState: "sealed" as const },
      },
    };

    expect(createInventoryWithProductProfileSchema.parse(request)).toEqual(request);
    expect(() => createInventoryWithProductProfileSchema.parse({
      ...request,
      profile: { ...request.profile, itemId: "new-spool" },
    })).toThrow();
    expect(() => createInventoryWithProductProfileSchema.parse({
      ...request,
      extra: true,
    })).toThrow();
  });
});

describe("artifact upload contract", () => {
  it("accepts an optional build configuration binding on begin", () => {
    expect(beginUploadSchema.parse({
      projectId: "project-1",
      revisionId: "revision-1",
      buildConfigurationSnapshotId: "build-config-1",
      role: "step",
      filename: "part.step",
      mediaType: "model/step",
      byteSize: 1,
      sha256: "a".repeat(64),
    })).toMatchObject({ buildConfigurationSnapshotId: "build-config-1" });
  });
});

describe("v2 build configuration and artifact binding schemas", () => {
  const snapshot = {
    id: "build-config-1",
    projectRevisionId: "project-revision-1",
    printerItemSnapshot: {
      itemId: "legacy-printer-1",
      catalogProductId: printer.id,
      profileId: "profile-printer-1",
      linkState: "confirmed" as const,
      manufacturer: "Bambu Lab",
      exactModel: "H2D",
      exactVariant: "AMS Combo",
      technology: "fff" as const,
      buildVolumeMm: { x: 325, y: 320, z: 325 },
    },
    filamentSelections: [{
      itemId: "legacy-filament-1",
      catalogProductId: filament.id,
      profileId: "profile-spool-1",
      linkState: "confirmed" as const,
      manufacturer: "Example Materials",
      lot: "LOT-1",
      materialFamily: "PLA",
      colourName: "Black",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
      nominalLengthM: 335,
      lengthBasis: "manufacturer_declared" as const,
      densityGcm3: 1.24,
    }],
    activeHotend: { side: "left", model: "H2D stock hotend" },
    nozzle: { diameterMm: 0.4, material: "hardened_steel" },
    plate: { name: "Cool Plate", surface: "smooth" },
    accessories: [{ name: "AMS 2 Pro", quantity: 1 }],
    firmware: { version: "01.08.00.00" },
    slicer: { name: "Bambu Studio", version: "1.10.0" },
    profile: { name: "0.20mm Standard", version: "1" },
    calibration: { state: "current", recordedAt: "2026-08-29T12:00:00.000Z" },
    explicitUnknowns: ["actual filament lot was not weighed"],
    contentSha256: "a".repeat(64),
    createdAt: "2026-08-30T12:00:00.000Z",
  };

  it("accepts a complete immutable snapshot and binding", () => {
    expect(buildConfigurationSnapshotSchema.parse(snapshot)).toMatchObject({
      id: snapshot.id,
      projectRevisionId: snapshot.projectRevisionId,
    });
    expect(artifactBuildConfigurationBindingSchema.parse({
      id: "binding-1",
      artifactId: "artifact-1",
      buildConfigurationSnapshotId: snapshot.id,
      projectRevisionId: snapshot.projectRevisionId,
      createdAt: snapshot.createdAt,
    })).toMatchObject({ artifactId: "artifact-1" });
  });

  it("rejects snapshot unknowns and malformed content hashes", () => {
    expect(() => buildConfigurationSnapshotSchema.parse({ ...snapshot, untracked: true })).toThrow();
    expect(() => buildConfigurationSnapshotSchema.parse({ ...snapshot, contentSha256: "not-a-sha" })).toThrow();
    expect(() => artifactBuildConfigurationBindingSchema.parse({
      id: "binding-1",
      artifactId: "artifact-1",
      buildConfigurationSnapshotId: snapshot.id,
      createdAt: snapshot.createdAt,
      unsupported: true,
    })).toThrow();
    const clientSnapshot = {
      projectRevisionId: snapshot.projectRevisionId,
      printerItemSnapshot: {
        itemId: snapshot.printerItemSnapshot.itemId,
        catalogProductId: snapshot.printerItemSnapshot.catalogProductId,
        profileId: snapshot.printerItemSnapshot.profileId,
      },
      filamentSelections: [{
        itemId: snapshot.filamentSelections[0]!.itemId,
        catalogProductId: snapshot.filamentSelections[0]!.catalogProductId,
        profileId: snapshot.filamentSelections[0]!.profileId,
        role: "model",
        quantity: 1,
      }],
      activeHotend: snapshot.activeHotend,
      nozzle: snapshot.nozzle,
      plate: snapshot.plate,
      accessories: snapshot.accessories,
      firmware: snapshot.firmware,
      slicer: snapshot.slicer,
      profile: snapshot.profile,
      calibration: snapshot.calibration,
      explicitUnknowns: snapshot.explicitUnknowns,
    };
    expect(createBuildConfigurationSnapshotSchema.parse(clientSnapshot)).toBeDefined();
    expect(() => createBuildConfigurationSnapshotSchema.parse({
      ...clientSnapshot,
      printerItemSnapshot: { ...clientSnapshot.printerItemSnapshot, linkState: "confirmed" },
    })).toThrow();
    expect(() => createBuildConfigurationSnapshotSchema.parse(snapshot)).toThrow();
  });

  it("accepts an explicitly unlinked physical filament in create and response contracts", () => {
    const physicalOnly = {
      itemId: "physical-filament-1",
      catalogIdentityState: "unknown" as const,
      role: "model",
      quantity: 320,
    };
    const responsePhysicalOnly = {
      ...physicalOnly,
      physicalLabel: "Unidentified PETG spool",
      physicalEvidence: {
        state: "physically_counted" as const,
        source: "bench count",
        observedAt: timestamps.updatedAt,
      },
    };
    const createBase = {
      projectRevisionId: snapshot.projectRevisionId,
      printerItemSnapshot: { itemId: "legacy-printer-1", catalogProductId: printer.id },
      filamentSelections: [physicalOnly],
      activeHotend: snapshot.activeHotend,
      nozzle: snapshot.nozzle,
      plate: snapshot.plate,
      accessories: snapshot.accessories,
      firmware: snapshot.firmware,
      slicer: snapshot.slicer,
      profile: snapshot.profile,
      calibration: snapshot.calibration,
      explicitUnknowns: snapshot.explicitUnknowns,
    };

    expect(createBuildConfigurationSnapshotSchema.parse(createBase)).toMatchObject({ filamentSelections: [physicalOnly] });
    expect(buildConfigurationSnapshotSchema.parse({
      ...snapshot,
      filamentSelections: [responsePhysicalOnly],
    })).toMatchObject({ filamentSelections: [responsePhysicalOnly] });
  });

  it("does not treat a missing catalog product as an unlinked physical selection", () => {
    const ambiguous = {
      itemId: "physical-filament-1",
      role: "model",
      quantity: 320,
    };
    const createBase = {
      projectRevisionId: snapshot.projectRevisionId,
      printerItemSnapshot: { itemId: "legacy-printer-1", catalogProductId: printer.id },
      filamentSelections: [],
      activeHotend: snapshot.activeHotend,
      nozzle: snapshot.nozzle,
      plate: snapshot.plate,
      accessories: snapshot.accessories,
      firmware: snapshot.firmware,
      slicer: snapshot.slicer,
      profile: snapshot.profile,
      calibration: snapshot.calibration,
      explicitUnknowns: snapshot.explicitUnknowns,
    };
    expect(() => createBuildConfigurationSnapshotSchema.parse({
      ...createBase,
      filamentSelections: [ambiguous],
    })).toThrow();
  });
});
