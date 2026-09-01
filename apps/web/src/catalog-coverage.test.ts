import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createWorkspaceAdapter,
  mapCatalogProduct,
  mapInventoryProductProfile,
  mapInventoryItem
} from "./api";
import type { CatalogProduct } from "./domain";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

const canonicalFilament: CatalogProduct = {
  id: "filament-canonical",
  kind: "filament",
  manufacturer: "Bambu Lab",
  productName: "PETG HF",
  materialFamily: "PETG",
  materialSubtype: "HF",
  colourName: "Black",
  colourCode: "BK",
  diameterMm: 1.75,
  nominalNetMassG: 1000,
  lengthBasis: "unknown",
  family: "PETG",
  model: "PETG HF",
  variant: "HF",
  colour: "Black",
  color: "Black",
  productCode: "PETG-HF-BLK",
  sku: "PETG-HF-BLK",
  version: 1
};

const serverInventoryItem = (overrides: Record<string, unknown> = {}) => ({
  id: "coverage-item",
  name: "Coverage item",
  kind: "filament",
  quantity: 1000,
  availableQuantity: 1000,
  unit: "gram",
  tags: [],
  links: [],
  evidence: { state: "physically_counted" },
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  version: 1,
  ...overrides
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("catalog mapping edge cases", () => {
  it("rejects non-records and incomplete product identities", () => {
    expect(mapCatalogProduct(null)).toBeUndefined();
    expect(mapCatalogProduct([])).toBeUndefined();
    expect(mapCatalogProduct({ id: "missing-kind", manufacturer: "Maker" })).toBeUndefined();
    expect(mapCatalogProduct({ kind: "filament", id: "missing-maker" })).toBeUndefined();
    expect(mapCatalogProduct({ type: "unknown", productId: "bad-kind", brand: "Maker" }, "printer")).toMatchObject({ kind: "printer", id: "bad-kind", manufacturer: "Maker" });
  });

  it("maps legacy aliases and only keeps a complete printer envelope", () => {
    const printer = mapCatalogProduct({
      type: "printer",
      productId: "printer-alias",
      brand: "Bambu Lab",
      modelName: "H2D",
      variantName: "AMS Combo",
      technology: "fff",
      buildVolumeMm: { x: 325, y: 320, z: 325 },
      version: 2,
      evidenceState: "manufacturer"
    });
    expect(printer).toMatchObject({
      id: "printer-alias",
      kind: "printer",
      manufacturer: "Bambu Lab",
      exactModel: "H2D",
      exactVariant: "AMS Combo",
      model: "H2D",
      variant: "AMS Combo",
      technology: "fff",
      buildVolumeMm: { x: 325, y: 320, z: 325 },
      version: 2,
      evidence: "manufacturer"
    });

    const incompleteEnvelope = mapCatalogProduct({
      kind: "printer",
      id: "printer-no-envelope",
      manufacturer: "Maker",
      exactModel: "Model",
      buildVolumeMm: { x: 325, y: "unknown", z: 325 }
    });
    expect(incompleteEnvelope).toMatchObject({ exactModel: "Model" });
    expect(incompleteEnvelope?.buildVolumeMm).toBeUndefined();
  });

  it("maps canonical filament aliases and preserves unknown optional fields as absent", () => {
    const filament = mapCatalogProduct({
      id: "filament-alias",
      kind: "filament",
      manufacturer: "Maker",
      materialFamily: "PLA",
      materialSubtype: "Silk",
      colourName: "Gold",
      colorCode: "GOLD",
      filamentDiameterMm: 1.75,
      netMassGrams: 750,
      lengthM: 250,
      lengthBasis: "calculated",
      density: 1.24,
      sku: "PLA-SILK-GOLD",
      hash: "b".repeat(64)
    });
    expect(filament).toMatchObject({
      id: "filament-alias",
      family: "PLA",
      variant: "Silk",
      colour: "Gold",
      color: "Gold",
      colourCode: "GOLD",
      colorCode: "GOLD",
      diameterMm: 1.75,
      netMassG: 750,
      nominalLengthM: 250,
      lengthBasis: "calculated",
      densityGcm3: 1.24,
      productCode: "PLA-SILK-GOLD",
      sku: "PLA-SILK-GOLD",
      contentHash: "b".repeat(64)
    });
  });

  it("normalizes filament and printer profile shapes, including unknown link states", () => {
    expect(mapInventoryProductProfile("not-a-profile")).toBeUndefined();

    const opened = mapInventoryProductProfile({
      id: "profile-opened",
      productId: "filament-alias",
      link_state: "unknown",
      profileType: "filament_spool",
      details: {
        lot: "LOT-1",
        batch: "BATCH-1",
        lotCode: "CODE-1",
        opened: true,
        openedDate: "2026-08-30",
        tareGrams: 164,
        amsSlot: "AMS 1"
      },
      evidenceState: "reported",
      version: 3,
      sha256: "c".repeat(64)
    }, "spool-1");
    expect(opened).toMatchObject({
      id: "profile-opened",
      inventoryItemId: "spool-1",
      catalogProductId: "filament-alias",
      linkState: "reported",
      filament: {
        lot: "LOT-1",
        batch: "BATCH-1",
        lotCode: "CODE-1",
        state: "opened",
        openedAt: "2026-08-30",
        tareMassG: 164,
        placement: "AMS 1",
        currentPlacement: "AMS 1"
      },
      evidence: "reported",
      version: 3,
      contentHash: "c".repeat(64)
    });

    const sealed = mapInventoryProductProfile({
      catalogProductId: "filament-alias",
      linkState: "confirmed",
      filament: { state: "sealed", openedState: "sealed", placement: "Shelf" }
    });
    expect(sealed).toMatchObject({ linkState: "confirmed", filament: { state: "sealed", openedState: "sealed", currentPlacement: "Shelf" } });

    const printer = mapInventoryProductProfile({
      profileId: "profile-printer",
      catalog_id: "printer-alias",
      state: "suggested",
      profileType: "printer_asset",
      details: { asset: "H2D-01", commissionedDate: "2026-08-29", location: "Print room", condition: "needs_repair" }
    }, "printer-1");
    expect(printer).toMatchObject({
      id: "profile-printer",
      inventoryItemId: "printer-1",
      catalogProductId: "printer-alias",
      linkState: "suggested",
      printer: { assetLabel: "H2D-01", commissionedAt: "2026-08-29", placement: "Print room", location: "Print room", condition: "needs_repair" }
    });
  });

  it("keeps a legacy catalog id/link state visible when no profile object exists", () => {
    const mapped = mapInventoryItem(serverInventoryItem({ catalogProductId: "legacy-product", linkState: "suggested" }) as never);
    expect(mapped.productProfile).toMatchObject({ inventoryItemId: "coverage-item", catalogProductId: "legacy-product", linkState: "suggested" });
    expect(mapped.catalogProduct).toBeUndefined();
  });
});

describe("exact product API boundary coverage", () => {
  it("rejects every required catalog fact before making a network request", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=coverage-token" });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const adapter = createWorkspaceAdapter();

    await expect(adapter.createCatalogProduct({ kind: "filament", manufacturer: "", family: "PLA", colour: "Black", diameterMm: 1.75, netMassG: 1000 })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.createCatalogProduct({ kind: "filament", manufacturer: "Maker", family: "", colour: "Black", diameterMm: 1.75, netMassG: 1000 })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.createCatalogProduct({ kind: "filament", manufacturer: "Maker", family: "PLA", colour: "", diameterMm: 1.75, netMassG: 1000 })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.createCatalogProduct({ kind: "filament", manufacturer: "Maker", family: "PLA", colour: "Black", diameterMm: 0, netMassG: 1000 })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.createCatalogProduct({ kind: "filament", manufacturer: "Maker", family: "PLA", colour: "Black", diameterMm: 1.75, netMassG: Number.NaN })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.createCatalogProduct({ kind: "printer", manufacturer: "Maker", model: "H2D" })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.createCatalogProduct({ kind: "printer", manufacturer: "Maker", model: "H2D", buildVolumeMm: { x: 0, y: 320, z: 325 } })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.createCatalogProduct({ kind: "printer", manufacturer: "Maker", model: "H2D", buildVolumeMm: { x: 325, y: Number.NaN, z: 325 } })).rejects.toMatchObject({ kind: "validation" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a printer asset with canonical dates and maps the compound response", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=printer-token" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: {
      item: serverInventoryItem({ id: "printer-item", name: "H2D", kind: "printer", unit: "each", quantity: 1, availableQuantity: 0, evidence: { state: "commissioned" } }),
      profile: { id: "printer-profile", itemId: "printer-item", catalogProductId: "printer-product", profileType: "printer_asset", linkState: "confirmed", details: { assetLabel: "H2D-01", commissionedAt: "2026-08-30T00:00:00.000Z", location: "Print room" }, version: 1 }
    } }));
    const adapter = createWorkspaceAdapter();
    const product: CatalogProduct = { id: "printer-product", kind: "printer", manufacturer: "Bambu Lab", exactModel: "H2D", exactVariant: "AMS Combo", technology: "fff", buildVolumeMm: { x: 325, y: 320, z: 325 } };
    const item = await adapter.createExactInventoryItem({ category: "Printers", product, quantity: 1, linkState: "confirmed", printer: { assetLabel: "H2D-01", commissionedAt: "2026-08-30", placement: "Print room" } });
    expect(item).toMatchObject({ id: "printer-item", category: "Printers", unit: "each", productProfile: { linkState: "confirmed", printer: { assetLabel: "H2D-01", commissionedAt: "2026-08-30T00:00:00.000Z" } } });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, Record<string, unknown>>;
    expect(body.item).toMatchObject({ kind: "printer", unit: "each", evidence: { state: "commissioned" } });
    expect(body.item).not.toHaveProperty("dimensions");
    expect(body.profile).toMatchObject({ profileType: "printer_asset", details: { commissionedAt: "2026-08-30T00:00:00.000Z", location: "Print room" } });
  });

  it("keeps the default reported printer path inspect-first until it is explicitly commissioned", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=reported-printer-token" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: {
      item: serverInventoryItem({ id: "reported-printer-item", kind: "printer", quantity: 1, availableQuantity: 0, unit: "each", evidence: { state: "unknown" } }),
      profile: { id: "reported-printer-profile", itemId: "reported-printer-item", catalogProductId: "printer-product", profileType: "printer_asset", linkState: "reported", details: {}, version: 1 }
    } }));
    const adapter = createWorkspaceAdapter();
    const product: CatalogProduct = { id: "printer-product", kind: "printer", manufacturer: "Anycubic", exactModel: "Kobra 2", technology: "fff", buildVolumeMm: { x: 220, y: 220, z: 250 } };

    const item = await adapter.createExactInventoryItem({ category: "Printers", product, quantity: 1, linkState: "reported", printer: {} });

    expect(item).toMatchObject({ id: "reported-printer-item", state: "inspect-first", serverEvidence: "unknown", availableQuantity: 0, productProfile: { linkState: "reported" } });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { item: { evidence: { state: string } }; profile: { linkState: string; details: Record<string, unknown> } };
    expect(body.item.evidence).toMatchObject({ state: "unknown" });
    expect(body.profile).toEqual({ catalogProductId: product.id, profileType: "printer_asset", linkState: "reported", details: {} });
  });

  it("surfaces incomplete compound item/profile responses and preserves CSRF boundaries", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=coverage-token" });
    const product: CatalogProduct = { ...canonicalFilament, id: "compound-product" };
    const adapter = createWorkspaceAdapter();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: { profile: {} } }));
    await expect(adapter.createExactInventoryItem({ category: "Filament", product, quantity: 1000, linkState: "reported" })).rejects.toMatchObject({ kind: "server", status: 502 });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: { item: serverInventoryItem({ id: "item-no-profile" }) } }));
    await expect(adapter.createExactInventoryItem({ category: "Filament", product, quantity: 1000, linkState: "reported" })).rejects.toMatchObject({ kind: "server", status: 502, message: "The service returned an incomplete exact product profile" });

    vi.restoreAllMocks();
    vi.stubGlobal("document", { cookie: "" });
    await expect(createWorkspaceAdapter().createExactInventoryItem({ category: "Filament", product, quantity: 1000, linkState: "reported" })).rejects.toMatchObject({ kind: "csrf" });
  });

  it("accepts all supported catalog search response envelopes", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=coverage-token" });
    const responses = [
      [canonicalFilament],
      { products: [canonicalFilament] },
      { items: { data: [canonicalFilament] } },
      { results: [canonicalFilament] },
      { data: { data: [canonicalFilament] } },
      { data: "not-a-list" },
      null
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch");
    responses.forEach((body) => fetchMock.mockResolvedValueOnce(jsonResponse(body)));
    const adapter = createWorkspaceAdapter();
    for (const [index, expected] of responses.entries()) {
      const result = await adapter.searchCatalogProducts("filament", index === 0 ? "" : "PETG");
      expect(result).toHaveLength(expected === null || (typeof expected === "object" && "data" in (expected as object) && typeof (expected as { data?: unknown }).data === "string") ? 0 : 1);
    }
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/catalog/products?kind=filament");
  });

  it("maps a persisted snapshot with fallback fields and no selected products", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=build-token" });
    const project = {
      project: { id: "project-fallback", name: "Fallback", description: "Build", status: "idea", currentRevisionId: "revision-fallback", createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1 },
      revision: { id: "revision-fallback", projectId: "project-fallback", number: 1, name: "Initial", status: "concept", createdAt: "2026-08-30T00:00:00.000Z", version: 1 }
    };
    const persisted = {
      id: "snapshot-fallback",
      projectRevisionId: "revision-fallback",
      printerItemId: "legacy-printer",
      printerProductId: "legacy-printer-product",
      filamentItemId: "legacy-filament",
      filamentProductId: "legacy-filament-product",
      activeHotend: "left",
      nozzleDiameterMm: 0.4,
      nozzleMaterial: "steel",
      buildPlate: "Textured PEI",
      firmware: "01",
      slicer: "Bambu Studio",
      slicerVersion: "1.0",
      profile: "Standard",
      calibration: "checked",
      unknowns: ["unknown"],
      accessories: ["AMS"],
      contentHash: "d".repeat(64),
      createdAt: "2026-08-30T00:00:00.000Z",
      version: 2
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: project }))
      .mockResolvedValueOnce(jsonResponse({ data: persisted }));
    const adapter = createWorkspaceAdapter();
    const createdProject = await adapter.createProject({ name: "Fallback", description: "Build" });
    const snapshot = await adapter.createBuildConfigSnapshot(createdProject.id, "revision-fallback", {
      printerItemId: "legacy-printer",
      printerProductId: "legacy-printer-product",
      accessories: ["AMS"],
      unknowns: ["unknown"]
    });
    expect(snapshot).toMatchObject({ id: "snapshot-fallback", projectId: "project-fallback", revisionId: "revision-fallback", printerItemId: "legacy-printer", filamentItemId: "legacy-filament", contentHash: "d".repeat(64), version: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("catalog API error type", () => {
  it("retains optional metadata without inventing defaults", () => {
    const error = new ApiError("problem", { kind: "validation" });
    expect(error).toMatchObject({ name: "ApiError", message: "problem", kind: "validation", status: 0 });
    expect(error.code).toBeUndefined();
    expect(error.correlationId).toBeUndefined();
    expect(error.demo).toBeUndefined();
  });
});
