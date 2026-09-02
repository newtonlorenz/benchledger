import { describe, expect, it } from "vitest";
import { ApplicationError } from "./errors.js";
import { ApplicationService } from "./service.js";
import type {
  BuildConfigurationSnapshot, CatalogProduct, CatalogProductFilament, CatalogProductPrinter,
  InventoryItem, InventoryProductProfile,
} from "@benchledger/api-contract";
import type { ApplicationPorts as ServicePorts, AuditEvent, AuditInput, EventBusEvent, RequestContext } from "./ports.js";

const context: RequestContext = {
  actor: "tester",
  source: "api",
  correlationId: "catalog-corr",
  scopes: new Set(["catalog:read", "catalog:write", "projects:read", "projects:write"]),
};

const timestamp = "2026-08-30T00:00:00.000Z";

function makeFilament(overrides: Partial<CatalogProductFilament> = {}): CatalogProductFilament {
  return {
    id: "product-petg-hf",
    kind: "filament",
    manufacturer: "Bambu Lab",
    sku: "PETG-HF-BLK-1KG",
    materialFamily: "PETG",
    colourName: "Black",
    diameterMm: 1.75,
    nominalNetMassG: 1000,
    nominalLengthM: 330,
    lengthBasis: "manufacturer_declared",
    densityGcm3: 1.27,
    ...overrides,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: overrides.version ?? 1,
  };
}

function makePrinter(overrides: Partial<CatalogProductPrinter> = {}): CatalogProductPrinter {
  return {
    id: "product-h2d",
    kind: "printer",
    manufacturer: "Bambu Lab",
    exactModel: "H2D",
    technology: "fff",
    buildVolumeMm: { x: 325, y: 320, z: 325 },
    ...overrides,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: overrides.version ?? 1,
  };
}

function makeProfile(overrides: Partial<InventoryProductProfile> = {}): InventoryProductProfile {
  const profile = {
    id: "profile-filament-1",
    itemId: "filament-1",
    catalogProductId: "product-petg-hf",
    profileType: "filament_spool",
    linkState: "confirmed",
    details: { openedState: "sealed" },
    createdAt: timestamp,
    updatedAt: timestamp,
    version: overrides.version ?? 1,
    ...overrides,
  } as InventoryProductProfile;
  return profile;
}

function makePorts(): ServicePorts & {
  catalogStore: { products: Map<string, CatalogProduct>; profiles: Map<string, InventoryProductProfile>; configurations: Map<string, BuildConfigurationSnapshot> };
} {
  const products = new Map<string, CatalogProduct>([
    ["product-petg-hf", makeFilament()],
    ["product-h2d", makePrinter()],
  ]);
  const profiles = new Map<string, InventoryProductProfile>([
    ["filament-1", makeProfile()],
  ]);
  const configurations = new Map<string, BuildConfigurationSnapshot>();
  const inventoryItems = new Map<string, { id: string; kind: "filament" | "printer"; name: string }>([
    ["filament-1", { id: "filament-1", kind: "filament", name: "PETG spool" }],
    ["printer-1", { id: "printer-1", kind: "printer", name: "H2D bench" }],
  ]);
  const revision = { id: "revision-1", projectId: "project-1", number: 1, name: "Initial", status: "concept", createdAt: timestamp, version: 1 } as const;
  const secondRevision = { id: "revision-2", projectId: "project-1", number: 2, name: "Second", status: "concept", createdAt: timestamp, version: 1 } as const;
  const project = { id: "project-1", name: "Catalog fixture", status: "planned", createdAt: timestamp, updatedAt: timestamp, version: 1 } as const;
  const events: EventBusEvent[] = [];
  let auditNumber = 0;
  const audit = async (input: AuditInput): Promise<AuditEvent> => ({
    id: `audit-${++auditNumber}`,
    action: input.action,
    actor: input.actor,
    source: input.source,
    correlationId: input.correlationId,
    entityType: input.entityType,
    entityId: input.entityId,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    ...(input.version === undefined ? {} : { version: input.version }),
    createdAt: timestamp,
  });

  const base = {
    inventory: {
      listItems: async () => ({ data: [], limit: 200 }),
      getItem: async (id: string) => {
        const item = inventoryItems.get(id);
        return item === undefined ? null : ({ id: item.id, name: item.name, kind: item.kind } as never);
      },
      createItem: async () => { throw new Error("not implemented"); },
      updateItem: async () => { throw new Error("not implemented"); },
      recordStockEvent: async () => { throw new Error("not implemented"); },
      listStockEvents: async () => ({ data: [], limit: 50 }),
    },
    projects: {
      listProjects: async () => ({ data: [project], limit: 50 }),
      getProject: async (id: string) => id === project.id ? project : null,
      createProject: async () => { throw new Error("not implemented"); },
      updateProject: async () => { throw new Error("not implemented"); },
      createWorkItem: async () => { throw new Error("not implemented"); },
      getWorkItem: async () => null,
      listWorkItems: async () => [],
      createProjectRevision: async () => { throw new Error("not implemented"); },
      getProjectRevision: async (id: string) => id === revision.id ? revision : id === secondRevision.id ? secondRevision : null,
      createWorkItemRevision: async () => { throw new Error("not implemented"); },
      getWorkItemRevision: async () => null,
      listBomLines: async () => [],
      getBomLine: async () => null,
      createBomLine: async () => { throw new Error("not implemented"); },
      updateBomLine: async () => { throw new Error("not implemented"); },
      retireBomLine: async () => { throw new Error("not implemented"); },
      restoreBomLine: async () => { throw new Error("not implemented"); },
      createReservation: async () => { throw new Error("not implemented"); },
      releaseReservation: async () => { throw new Error("not implemented"); },
      listReservations: async () => [],
      getReservationDetails: async () => null,
      recordUsage: async () => { throw new Error("not implemented"); },
    },
    offers: { listOffers: async () => ({ data: [], limit: 50 }), createOffer: async () => { throw new Error("not implemented"); } },
    artifacts: {
      listArtifacts: async () => [], getArtifact: async () => null, getUploadSessionDetails: async () => null,
      beginUpload: async () => { throw new Error("not implemented"); }, writeUpload: async () => ({ receivedBytes: 0 }),
      finalizeUpload: async () => { throw new Error("not implemented"); }, readArtifact: async () => { throw new Error("not implemented"); },
      retireArtifact: async () => { throw new Error("not implemented"); },
    },
    audit: { append: audit, list: async () => ({ data: [], limit: 50 }) },
    events: { publish: (event: EventBusEvent) => events.push(event), subscribe: () => () => undefined },
    idempotency: { get: async () => null, set: async () => undefined },
    unitOfWork: { run: async <T>(operation: () => T) => operation(), transactional: async <T>(operation: () => T) => operation(), exclusive: async <T>(operation: () => T) => operation() },
  } as unknown as ServicePorts;

  const catalog = {
    listProducts: async ({ limit, cursor, q, kind }: { limit: number; cursor?: string; q?: string; kind?: "filament" | "printer" }) => {
      const normalized = q?.toLowerCase();
      const values = [...products.values()].filter((product) => (kind === undefined || product.kind === kind) && (normalized === undefined || JSON.stringify(product).toLowerCase().includes(normalized)));
      const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      const selected = values.slice(offset, offset + limit);
      return { data: selected, limit, total: values.length, ...(offset + selected.length < values.length ? { nextCursor: String(offset + selected.length) } : {}) };
    },
    getProduct: async (id: string) => products.get(id) ?? null,
    createProduct: async (input: CatalogProduct) => {
      const product = { ...input, id: input.id ?? `product-${products.size + 1}`, createdAt: timestamp, updatedAt: timestamp, version: 1 } as CatalogProduct;
      products.set(product.id, product);
      return product;
    },
    updateProduct: async (id: string, input: Partial<CatalogProduct>, expectedVersion?: number) => {
      const current = products.get(id);
      if (current === undefined) throw new ApplicationError("not_found", "product missing");
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw new ApplicationError("conflict", "version changed");
      const product = { ...current, ...input, id, updatedAt: timestamp, version: current.version + 1 } as CatalogProduct;
      products.set(id, product);
      return product;
    },
    getInventoryProductProfile: async (itemId: string) => profiles.get(itemId) ?? null,
    putInventoryProductProfile: async (itemId: string, input: Partial<InventoryProductProfile>, expectedVersion?: number) => {
      const current = profiles.get(itemId);
      if (current !== undefined && expectedVersion !== undefined && expectedVersion !== current.version) throw new ApplicationError("conflict", "version changed");
      const profile = { ...(current ?? makeProfile({ id: `profile-${itemId}`, itemId, version: 0, catalogProductId: "product-h2d", profileType: "printer_asset", details: {} })), ...input, itemId, updatedAt: timestamp, version: current === undefined ? 1 : current.version + 1 } as InventoryProductProfile;
      profiles.set(itemId, profile);
      return profile;
    },
  };
  const buildConfigurations = {
    listBuildConfigurations: async (revisionId: string, { limit, cursor }: { limit: number; cursor?: string }) => {
      const values = [...configurations.values()].filter((value) => value.projectRevisionId === revisionId);
      const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      return { data: values.slice(offset, offset + limit), limit, total: values.length, ...(offset + limit < values.length ? { nextCursor: String(offset + limit) } : {}) };
    },
    getBuildConfiguration: async (id: string) => configurations.get(id) ?? null,
    getLatestBuildConfiguration: async (revisionId: string) => [...configurations.values()]
      .filter((value) => value.projectRevisionId === revisionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .at(-1) ?? null,
    createBuildConfiguration: async (input: BuildConfigurationSnapshot) => { configurations.set(input.id, input); return input; },
  };
  return { ...base, catalog, buildConfigurations, catalogStore: { products, profiles, configurations } } as ServicePorts & typeof base & { catalogStore: { products: Map<string, CatalogProduct>; profiles: Map<string, InventoryProductProfile>; configurations: Map<string, BuildConfigurationSnapshot> } };
}

const buildInput = {
  printerItemSnapshot: { itemId: "printer-1", catalogProductId: "product-h2d" },
  filamentSelections: [{ itemId: "filament-1", catalogProductId: "product-petg-hf", role: "model", quantity: 1 }],
  activeHotend: { side: "left", model: "H2D stock hotend" },
  nozzle: { diameterMm: 0.4, material: "hardened_steel" },
  plate: { name: "Cool Plate", surface: "smooth" },
  accessories: [],
  firmware: { version: "01.08.00.00" },
  slicer: { name: "Bambu Studio", version: "1.10.0" },
  profile: { name: "0.20mm Standard", version: "1" },
  calibration: { state: "current", recordedAt: timestamp },
  explicitUnknowns: ["ambient temperature"],
} as const;

describe("catalog and build configuration application services", () => {
  it("uses bounded pages and wraps catalog writes in audit/idempotency mutation results", async () => {
    const service = new ApplicationService(makePorts());
    const page = await service.listCatalogProducts({ limit: 1 });
    expect(page.data).toHaveLength(1);
    const mutation = await service.createCatalogProduct({ kind: "filament", manufacturer: "Acme", materialFamily: "PLA", colourName: "White", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown", productName: "PLA" }, context);
    expect(mutation.data).toMatchObject({ kind: "filament", productName: "PLA" });
    expect(mutation.audit.action).toBe("catalog.product.create");
  });

  it("rejects a profile whose catalog product kind disagrees with the linked inventory item", async () => {
    const service = new ApplicationService(makePorts());
    await expect(service.putInventoryProductProfile("filament-1", { itemId: "filament-1", catalogProductId: "product-h2d", profileType: "filament_spool", linkState: "confirmed", details: {} }, undefined, context)).rejects.toMatchObject({ code: "validation" });
  });

  it("atomically rolls back the exact inventory item when profile creation fails", async () => {
    const ports = makePorts();
    const catalog = ports.catalog!;
    let itemPresent = false;
    const createdItem: InventoryItem = {
      id: "compound-item",
      name: "PETG spool",
      kind: "filament",
      quantity: 1000,
      availableQuantity: 0,
      unit: "gram",
      tags: [],
      links: [],
      evidence: { state: "delivered_uncounted" },
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    };
    ports.inventory.createItem = async () => {
      itemPresent = true;
      return createdItem;
    };
    ports.inventory.rollbackCreatedItem = async () => {
      itemPresent = false;
    };
    catalog.rollbackCreatedProfile = async () => undefined;
    catalog.putInventoryProductProfile = async () => {
      throw new Error("forced profile-write failure");
    };
    Object.assign(ports, {
      inventoryCategories: {
        getCategory: async (id: string) => id === "category-compound" ? {
          id,
          name: "Compound category",
          sortOrder: 0,
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          version: 1,
        } : null,
      },
    });

    await expect(serviceFor(ports).createInventoryWithProductProfile({
      item: { id: createdItem.id, name: createdItem.name, kind: createdItem.kind, quantity: createdItem.quantity, unit: createdItem.unit, tags: [], links: [], categoryNodeId: "category-compound", evidence: createdItem.evidence },
      profile: { catalogProductId: "product-petg-hf", profileType: "filament_spool", linkState: "confirmed", details: { openedState: "sealed" } },
    }, context)).rejects.toThrow("forced profile-write failure");
    expect(itemPresent).toBe(false);
  });

  it("accepts reported quantity with zero available stock in the compound inventory command", async () => {
    const ports = makePorts();
    const createdItem: InventoryItem = {
      id: "delivered-compound-item",
      name: "Delivered PETG spool",
      kind: "filament",
      quantity: 1000,
      availableQuantity: 0,
      allocatedQuantity: 0,
      unit: "gram",
      tags: [],
      links: [],
      evidence: { state: "delivered_uncounted" },
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    };
    ports.inventory.createItem = async () => createdItem;
    ports.inventory.rollbackCreatedItem = async () => undefined;
    ports.catalog!.rollbackCreatedProfile = async () => undefined;

    const result = await serviceFor(ports).createInventoryWithProductProfile({
      item: { id: createdItem.id, name: createdItem.name, kind: createdItem.kind, quantity: createdItem.quantity, unit: createdItem.unit, tags: [], links: [], evidence: createdItem.evidence },
      profile: { catalogProductId: "product-petg-hf", profileType: "filament_spool", linkState: "reported", details: { openedState: "sealed" } },
    }, context);

    expect(result.data.item).toMatchObject({ quantity: 1000, availableQuantity: 0, allocatedQuantity: 0, evidence: { state: "delivered_uncounted" } });
  });

  it("keeps reported and suggested links non-confirming and snapshots exact owned facts", async () => {
    const ports = makePorts();
    const service = new ApplicationService(ports);
    const profile = await service.putInventoryProductProfile("printer-1", { itemId: "printer-1", catalogProductId: "product-h2d", profileType: "printer_asset", linkState: "suggested", details: { assetLabel: "H2D bench" } }, undefined, context);
    expect(profile.data.linkState).toBe("suggested");
    const created = await service.createBuildConfiguration("revision-1", buildInput, context);
    expect(created.data).toMatchObject({ projectRevisionId: "revision-1", contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/), explicitUnknowns: expect.arrayContaining(["ambient temperature"]) });
    expect(created.data.printerItemSnapshot).toMatchObject({ itemId: "printer-1", catalogProductId: "product-h2d", profileId: profile.data.id, exactModel: "H2D" });
    expect(created.data.filamentSelections[0]).toMatchObject({
      itemId: "filament-1",
      catalogProductId: "product-petg-hf",
      profileId: "profile-filament-1",
      sku: "PETG-HF-BLK-1KG",
      materialFamily: "PETG",
      nominalLengthM: 330,
      lengthBasis: "manufacturer_declared",
      densityGcm3: 1.27,
      role: "model",
      quantity: 1,
    });
    expect(created.data.explicitUnknowns.some((value) => value.includes("non-confirmed"))).toBe(true);
    const same = await service.createBuildConfiguration("revision-1", buildInput, context);
    expect(same.data.contentSha256).toBe(created.data.contentSha256);
    const superseding = await service.createBuildConfiguration("revision-1", { ...buildInput, supersedesSnapshotId: created.data.id }, context);
    expect(superseding.data.contentSha256).toBe(created.data.contentSha256);
  });

  it("uses a dedicated latest query and keeps content identity stable across revisions", async () => {
    const ports = makePorts();
    const service = new ApplicationService(ports);
    const first = await service.createBuildConfiguration("revision-1", buildInput, context);
    const second = await service.createBuildConfiguration("revision-2", buildInput, context);

    expect(second.data.projectRevisionId).toBe("revision-2");
    expect(second.data.contentSha256).toBe(first.data.contentSha256);
    await expect(service.getLatestBuildConfiguration("revision-1")).resolves.toMatchObject({ id: first.data.id });
  });

  it("does not allow snapshot update or delete paths", () => {
    const service = new ApplicationService(makePorts());
    expect((service as unknown as Record<string, unknown>).updateBuildConfiguration).toBeUndefined();
    expect((service as unknown as Record<string, unknown>).deleteBuildConfiguration).toBeUndefined();
  });
});

function serviceFor(ports: ServicePorts): ApplicationService {
  return new ApplicationService(ports);
}
