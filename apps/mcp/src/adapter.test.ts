import { describe, expect, it } from "vitest";
import { ApplicationError } from "@benchledger/application";
import { McpAdapter } from "./adapter.js";
import type {
  BuildConfigurationSnapshot,
  CatalogProduct,
  BenchLedgerBackend,
  McpRequestContext,
  Page,
  InventoryItem,
  InventoryCategory,
} from "./types.js";

const context: McpRequestContext = {
  actorId: "test-agent",
  scopes: [
    "inventory:read",
    "inventory:write",
    "catalog:read",
    "catalog:write",
    "projects:read",
    "projects:write",
    "bom:read",
    "bom:write",
    "artifacts:read",
    "artifacts:write",
    "offers:read",
    "offers:write",
    "context:read",
  ],
};

function page<T>(items: T[]): Page<T> {
  return { items, nextCursor: null, hasMore: false };
}

function backend(): BenchLedgerBackend {
  const catalogProduct: CatalogProduct = {
    id: "catalog-filament-1",
    kind: "filament",
    manufacturer: "Bambu Lab",
    productName: "PETG HF",
    materialFamily: "PETG",
    colourName: "Black",
    diameterMm: 1.75,
    nominalNetMassG: 1000,
    lengthBasis: "unknown",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    version: 1,
  };
  const buildConfiguration: BuildConfigurationSnapshot = {
    id: "build-config-1",
    projectRevisionId: "project-revision-1",
    printerItemSnapshot: {
      itemId: "printer-1",
      catalogProductId: "catalog-printer-1",
      linkState: "confirmed",
      manufacturer: "Bambu Lab",
      exactModel: "H2D",
      technology: "fff",
      buildVolumeMm: { x: 325, y: 320, z: 325 },
    },
    filamentSelections: [{
      itemId: "item-esp32",
      catalogProductId: "catalog-filament-1",
      linkState: "reported",
      manufacturer: "Bambu Lab",
      materialFamily: "PETG",
      colourName: "Black",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
    }],
    activeHotend: { side: "left", model: "stock" },
    nozzle: { diameterMm: 0.4, material: "hardened_steel" },
    plate: { name: "Cool Plate", surface: "smooth" },
    accessories: [],
    firmware: { version: "01.08.00.00" },
    slicer: { name: "Bambu Studio", version: "1.10.0" },
    profile: { name: "0.20mm Standard", version: "1" },
    calibration: { state: "current" },
    explicitUnknowns: ["lot mass not measured"],
    contentSha256: "a".repeat(64),
    createdAt: "2026-08-30T10:00:00.000Z",
  };
  const inventoryItem: InventoryItem = {
    id: "item-esp32",
    version: 1,
    name: "ESP32 development board",
    category: "electronics",
    quantity: { value: 2, unit: "piece" },
    availability: "confirmed",
    evidence: {
      state: "counted",
      source: "physical_count",
      recordedAt: "2026-08-30T10:00:00.000Z",
    },
    links: [],
  };
  const inventoryCategory: InventoryCategory = {
    id: "category-tools",
    name: "Tools",
    sortOrder: 0,
    archived: false,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    version: 1,
  };

  return {
    inventory: {
      summary: async () => ({
        generatedAt: "2026-08-30T10:00:00.000Z",
        counts: { totalItems: 1, confirmedItems: 1, confirmedEvidenceItems: 1, availableConfirmedItems: 1, inspectFirstItems: 0, allocatedItems: 0, allocatedQuantities: [], depletedItems: 0, unverifiedItems: 0, retiredItems: 0, missingItems: 0 },
        categories: [{ category: "electronics", itemCount: 1 }],
      }),
      list: async () => page([inventoryItem]),
      get: async () => inventoryItem,
      create: async (input) => ({ id: "created-item", version: 1, item: { ...inventoryItem, name: input.name } }),
      update: async () => ({ id: inventoryItem.id, version: 2, item: inventoryItem }),
      bulkUpdate: async () => ({ updated: [], unchanged: [{ itemId: inventoryItem.id, version: inventoryItem.version }], auditIds: [], correlationId: "bulk-correlation", replayed: false }),
      commission: async (input) => ({ id: input.itemId, version: 2, item: { ...inventoryItem, evidence: { ...inventoryItem.evidence, state: "commissioned" }, availability: "confirmed" } }),
      recordStockEvent: async (input) => ({
        eventId: "event-1",
        itemId: input.itemId,
        resultingQuantity: { value: 3, unit: "piece" },
        version: 4,
      }),
      listStockEvents: async () => page([]),
      createWithProductProfile: async (input) => ({
        id: "created-item",
        version: 1,
        item: { ...inventoryItem, id: "created-item", name: input.item.name, category: input.item.category },
        profile: {
          id: "created-profile",
          itemId: "created-item",
          catalogProductId: input.profile.catalogProductId,
          profileType: input.profile.profileType,
          linkState: input.profile.linkState,
          details: input.profile.details,
          createdAt: "2026-08-30T10:00:00.000Z",
          updatedAt: "2026-08-30T10:00:00.000Z",
          version: 1,
        },
      }),
    },
    inventoryCategories: {
      list: async () => page([inventoryCategory]),
      get: async () => inventoryCategory,
      create: async (input) => ({ id: inventoryCategory.id, version: 1, category: { ...inventoryCategory, name: input.name } }),
      update: async (input) => ({ id: input.categoryId, version: 2, category: { ...inventoryCategory, id: input.categoryId, ...(input.name === undefined ? {} : { name: input.name }), version: 2 } }),
      archive: async (input) => ({ id: input.categoryId, version: 2, category: { ...inventoryCategory, id: input.categoryId, archived: true, version: 2 } }),
    },
    projects: {
      list: async () => page([]),
      get: async () => ({ id: "project-1", name: "Reference project", status: "active", visibility: "private", version: 1 }),
      create: async () => ({ id: "project-1", version: 1, project: { id: "project-1", name: "Reference project", status: "active", visibility: "private", version: 1 } }),
      createWithInitialRevision: async () => ({ id: "project-1", version: 1, project: { id: "project-1", name: "Reference project", status: "active", visibility: "private", version: 1 }, revision: { id: "project-revision-1", projectId: "project-1", number: 1, status: "concept" } }),
      update: async () => ({ id: "project-1", version: 2, project: { id: "project-1", name: "Reference project", status: "active", visibility: "private", version: 2 } }),
      retire: async () => ({ id: "project-1", version: 3, retired: true }),
      createWorkItem: async () => ({ id: "work-1", version: 1, workItem: { id: "work-1", projectId: "project-1", name: "Enclosure", kind: "part" } }),
      getWorkItem: async () => ({ id: "work-1", projectId: "project-1", name: "Enclosure", kind: "part" }),
      createProjectRevision: async () => ({ id: "project-revision-1", version: 1, revision: { id: "project-revision-1", projectId: "project-1", number: 1, status: "draft" } }),
      getProjectRevision: async () => ({ id: "project-revision-1", projectId: "project-1", number: 1, status: "draft" }),
      createWorkItemRevision: async () => ({ id: "work-revision-1", version: 1, revision: { id: "work-revision-1", workItemId: "work-1", number: 1, status: "concept" } }),
      getWorkItemRevision: async () => ({ id: "work-revision-1", workItemId: "work-1", number: 1, status: "concept" }),
      context: async () => ({ projectId: "project-1", generatedAt: "2026-08-30T10:00:00.000Z", text: "Reference project context" }),
    },
    bom: {
      listLines: async () => page([]),
      createLine: async () => ({ id: "bom-1", version: 1, line: { id: "bom-1", projectRevisionId: "project-revision-1", description: "ESP32 board", quantity: 1, unit: "piece", requirement: "required" } }),
      updateLine: async () => ({ id: "bom-1", version: 2, line: { id: "bom-1", projectRevisionId: "project-revision-1", description: "ESP32 board", quantity: 1, unit: "piece", requirement: "required" } }),
      retireLine: async () => ({ id: "bom-1", version: 3, retired: true }),
      restoreLine: async () => ({ id: "bom-1", version: 4, restored: true }),
      evaluate: async () => ({ projectRevisionId: "project-revision-1", lines: [], totals: { required: 0, supplied: 0, inspectFirst: 0, missing: 0 }, generatedAt: "2026-08-30T10:00:00.000Z" }),
      reserve: async (input) => ({ reservationId: "reservation-1", projectRevisionId: input.projectRevisionId, itemId: input.itemId, quantity: input.quantity, status: "active", version: 1 }),
      release: async () => ({ reservationId: "reservation-1", status: "released", version: 2 }),
      recordUsage: async (input) => ({ usageEventId: "usage-1", itemId: input.itemId, quantity: input.quantity, version: 5 }),
    },
    catalog: {
      search: async () => page([catalogProduct]),
      get: async () => catalogProduct,
      create: async (input) => ({ ...catalogProduct, ...input, id: "catalog-created-1", version: 1 }),
      update: async (input) => ({ ...catalogProduct, ...input, version: 2 }),
      readProfile: async (input) => ({
        id: "profile-1",
        itemId: input.itemId,
        catalogProductId: "catalog-filament-1",
        profileType: "filament_spool",
        linkState: "reported",
        details: { openedState: "sealed" },
        createdAt: "2026-08-30T10:00:00.000Z",
        updatedAt: "2026-08-30T10:00:00.000Z",
        version: 1,
      }),
      linkProfile: async (input) => ({
        id: "profile-1",
        itemId: input.itemId,
        catalogProductId: input.catalogProductId,
        profileType: input.profileType ?? "filament_spool",
        linkState: input.linkState ?? "reported",
        details: input.details ?? { openedState: "sealed" },
        createdAt: "2026-08-30T10:00:00.000Z",
        updatedAt: "2026-08-30T10:00:00.000Z",
        version: input.expectedVersion === undefined ? 1 : input.expectedVersion + 1,
      }),
    },
    buildConfigurations: {
      create: async (input) => ({ ...buildConfiguration, ...input, id: input.id ?? buildConfiguration.id, contentSha256: "b".repeat(64), createdAt: "2026-08-30T10:01:00.000Z" }),
      list: async () => page([buildConfiguration]),
      get: async () => buildConfiguration,
    },
    artifacts: {
      list: async () => page([]),
      getMetadata: async () => ({ id: "artifact-1", filename: "source.step", mediaType: "model/step", byteLength: 12, sha256: "a".repeat(64), revision: 1, status: "candidate" }),
      beginUpload: async () => ({ uploadId: "upload-1", uploadUrl: "https://benchledger.test/api/v1/artifacts/uploads/upload-1", expiresAt: "2026-08-30T10:15:00.000Z", maxBytes: 1000000, method: "PUT" }),
      finalizeUpload: async () => ({ artifactId: "artifact-1", revisionId: "artifact-revision-1", filename: "source.step", byteLength: 12, sha256: "a".repeat(64), status: "candidate" }),
      downloadMetadata: async () => ({ artifactId: "artifact-1", revisionId: "artifact-revision-1", filename: "source.step", byteLength: 12, sha256: "a".repeat(64), downloadUrl: "https://benchledger.test/api/v1/artifacts/artifact-1/download", expiresAt: "2026-08-30T10:15:00.000Z" }),
      retire: async () => ({ artifactId: "artifact-1", retired: true, version: 2 }),
    },
    offers: {
      list: async () => page([]),
      recordSnapshot: async () => ({ offerId: "offer-1", version: 1, offer: { id: "offer-1", itemId: "item-esp32", supplier: "Example", price: { minor: 500, currency: "EUR" }, observedAt: "2026-08-30T10:00:00.000Z" } }),
    },
    context: {
      refresh: async () => ({ generatedAt: "2026-08-30T10:00:00.000Z", expiresAt: "2026-08-30T10:05:00.000Z", inventorySummaryUri: "benchledger://inventory/summary", projectUris: [] }),
    },
  };
}

describe("McpAdapter", () => {
  it("dispatches a typed inventory read and keeps the response bounded", async () => {
    const adapter = new McpAdapter(backend());
    const result = await adapter.callTool("list_inventory", { limit: 10 }, context);

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ items: [{ id: "item-esp32" }] });
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("maps an application invalid cursor from list_inventory to INVALID_ARGUMENT", async () => {
    const failing = backend();
    failing.inventory.list = async () => { throw new ApplicationError("invalid_cursor", "The inventory pagination cursor is invalid"); };

    const result = await new McpAdapter(failing).callTool("list_inventory", { cursor: "-1" }, context);

    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
  });

  it("requires a write scope for stock events", async () => {
    const adapter = new McpAdapter(backend());
    const readOnly = { actorId: "reader", scopes: ["inventory:read"] as const };
    const result = await adapter.callTool("record_stock_event", { itemId: "item-esp32", quantity: { value: 1, unit: "piece" }, kind: "receipt" }, readOnly);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("dispatches category CRUD with the same bounded scopes and archive command", async () => {
    const adapter = new McpAdapter(backend());
    const listed = await adapter.callTool("list_inventory_categories", { limit: 10 }, context);
    expect(listed).toMatchObject({ isError: false, structuredContent: { items: [{ id: "category-tools" }] } });
    const created = await adapter.callTool("create_inventory_category", { name: "Printer parts" }, context);
    expect(created).toMatchObject({ isError: false, structuredContent: { category: { name: "Printer parts" } } });
    const updated = await adapter.callTool("update_inventory_category", { categoryId: "category-tools", expectedVersion: 1, name: "Workshop tools" }, context);
    expect(updated).toMatchObject({ isError: false, structuredContent: { category: { name: "Workshop tools", version: 2 } } });
    const archived = await adapter.callTool("archive_inventory_category", { categoryId: "category-tools", expectedVersion: 1 }, context);
    expect(archived).toMatchObject({ isError: false, structuredContent: { category: { archived: true } } });
  });

  it("dispatches normalized bounded bulk metadata updates and denies them to scoped tokens", async () => {
    const received: unknown[] = [];
    const unscopedBackend = backend();
    unscopedBackend.inventory.bulkUpdate = async (input) => {
      received.push(input);
      return { updated: [], unchanged: [], auditIds: [], correlationId: "bulk-correlation", replayed: false };
    };
    const result = await new McpAdapter(unscopedBackend).callTool("bulk_update_inventory_items", {
      targets: [{ itemId: "item-esp32", expectedVersion: 1 }],
      changes: { location: " bench ", tags: { add: [" PETG ", "petg"] } },
    }, context);
    expect(result).toMatchObject({ isError: false, structuredContent: { updated: [], unchanged: [], auditIds: [], correlationId: "bulk-correlation", replayed: false } });
    expect(received[0]).toEqual({
      targets: [{ itemId: "item-esp32", expectedVersion: 1 }],
      changes: { location: "bench", tags: { add: ["PETG"] } },
    });
    const scoped = { ...context, projectIds: ["project-1"] as const };
    await expect(new McpAdapter(backend()).callTool("bulk_update_inventory_items", {
      targets: [{ itemId: "item-esp32", expectedVersion: 1 }],
      changes: { location: "bench" },
    }, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
  });

  it("rejects project-scoped category writes while preserving category reads", async () => {
    const adapter = new McpAdapter(backend());
    const scoped = { actorId: "project-agent", scopes: ["inventory:read", "inventory:write"] as const, projectIds: ["project-1"] };
    await expect(adapter.callTool("list_inventory_categories", {}, scoped)).resolves.toMatchObject({ isError: false });
    await expect(adapter.callTool("create_inventory_category", { name: "Not allowed" }, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    await expect(adapter.callTool("archive_inventory_category", { categoryId: "category-tools", expectedVersion: 1 }, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
  });

  it("dispatches commissioning with evidence and blocks it for project-scoped tokens", async () => {
    const adapter = new McpAdapter(backend());
    const result = await adapter.callTool("commission_inventory_item", {
      itemId: "item-esp32",
      expectedVersion: 1,
      quantity: { value: 2, unit: "piece" },
      evidence: { state: "commissioned", source: "bench-check", recordedAt: "2026-08-31T10:00:00Z" }
    }, { ...context, idempotencyKey: "commission-mcp-1" });
    expect(result).toMatchObject({ isError: false, structuredContent: { id: "item-esp32", item: { evidence: { state: "commissioned" } } } });
    await expect(adapter.callTool("commission_inventory_item", {
      itemId: "item-esp32",
      expectedVersion: 1,
      quantity: { value: 2, unit: "piece" },
      evidence: { state: "commissioned", source: "bench-check", recordedAt: "2026-08-31T10:00:00Z" }
    }, { ...context, projectIds: ["project-1"] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    await expect(adapter.callTool("commission_inventory_item", {
      itemId: "item-esp32",
      expectedVersion: 1,
      quantity: { value: 2, unit: "piece" },
      evidence: { state: "commissioned", source: "bench-check", recordedAt: "2026-08-31T10:00:00Z" }
    }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
  });

  it("returns scoped HTTP links for artifacts and rejects inline data URLs", async () => {
    const adapter = new McpAdapter(backend());
    const result = await adapter.callTool("begin_artifact_upload", { projectId: "project-1", filename: "source.step", role: "source", mediaType: "model/step", byteLength: 12, sha256: "a".repeat(64) }, context);

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ uploadUrl: "https://benchledger.test/api/v1/artifacts/uploads/upload-1" });
    expect(JSON.stringify(result.structuredContent)).not.toContain("base64");

    const unsafeBackend = backend();
    unsafeBackend.artifacts.beginUpload = async () => ({ uploadId: "upload-2", uploadUrl: "data:application/octet-stream;base64,AAAA", expiresAt: "2026-08-30T10:15:00.000Z", maxBytes: 100, method: "PUT" });
    const unsafeResult = await new McpAdapter(unsafeBackend).callTool("begin_artifact_upload", { projectId: "project-1", filename: "source.step", role: "source", mediaType: "model/step", byteLength: 12, sha256: "a".repeat(64) }, context);
    expect(unsafeResult.isError).toBe(true);
    expect(unsafeResult.structuredContent).toMatchObject({ error: { code: "UNSAFE_LINK" } });

    const queryBackend = backend();
    queryBackend.artifacts.downloadMetadata = async () => ({ artifactId: "artifact-1", revisionId: "artifact-revision-1", filename: "source.step", byteLength: 12, sha256: "a".repeat(64), downloadUrl: "https://benchledger.test/api/v1/transfers/artifacts/artifact-1/download?token=must-not-be-used", expiresAt: "2026-08-30T10:15:00.000Z" });
    const queryResult = await new McpAdapter(queryBackend).callTool("read_artifact_download_metadata", { artifactId: "artifact-1" }, context);
    expect(queryResult.isError).toBe(true);
    expect(queryResult.structuredContent).toMatchObject({ error: { code: "UNSAFE_LINK" } });
  });

  it("exposes only bounded, model-neutral capabilities", () => {
    const adapter = new McpAdapter(backend());
    const names = adapter.listTools().map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("calculate_bom_gaps");
    expect(names).toContain("refresh_context");
    const categoryUpdate = adapter.listTools().find((tool) => tool.name === "update_inventory_category");
    expect(categoryUpdate?.inputSchema).toMatchObject({ required: expect.arrayContaining(["categoryId", "expectedVersion"]) });
    const categoryArchive = adapter.listTools().find((tool) => tool.name === "archive_inventory_category");
    expect(categoryArchive?.inputSchema).toMatchObject({ required: expect.arrayContaining(["categoryId", "expectedVersion"]) });
    const categoryList = adapter.listTools().find((tool) => tool.name === "list_inventory_categories");
    expect(categoryList?.inputSchema.properties.cursor).toMatchObject({ description: expect.stringContaining("512") });
    const inventoryList = adapter.listTools().find((tool) => tool.name === "list_inventory");
    expect(inventoryList?.inputSchema.properties.cursor).toMatchObject({ description: expect.stringContaining("512") });
    expect(inventoryList?.inputSchema.properties.categoryNodeId).toMatchObject({ type: "string", maxLength: 160 });
    expect(inventoryList?.inputSchema.properties.unassigned).toMatchObject({ type: "boolean" });
    const offerList = adapter.listTools().find((tool) => tool.name === "list_offers");
    expect(offerList?.inputSchema.properties.cursor).toMatchObject({ description: expect.stringContaining("512") });
    const categoryRead = adapter.listTools().find((tool) => tool.name === "read_inventory_category");
    expect(categoryRead?.inputSchema.properties.categoryId).toMatchObject({ type: "string", maxLength: 160 });
    expect(adapter.listTools().find((tool) => tool.name === "create_inventory_category")?.inputSchema.properties.id).toMatchObject({ type: "string", maxLength: 160 });
    const inventoryUpdate = adapter.listTools().find((tool) => tool.name === "update_inventory_item");
    expect(inventoryUpdate?.inputSchema.properties.categoryNodeId).toMatchObject({ oneOf: expect.arrayContaining([expect.objectContaining({ type: "string", maxLength: 160 }), expect.objectContaining({ type: "null" })]) });
    expect(names).not.toContain("retire_inventory_item");
    expect(names).not.toContain("freeze_artifact_revision");
    expect(names).toContain("bulk_update_inventory_items");
    expect(names).not.toEqual(expect.arrayContaining(["run_shell", "execute_sql", "fetch_url", "purchase", "start_print"]));
    expect(adapter.capabilityDocument()).toMatchObject({
      browserAccess: {
        modes: {
          lan_open: expect.stringContaining("trusted LAN"),
          password: expect.stringContaining("workspace password"),
        },
        initialization: expect.stringContaining("durable setting wins"),
        demo: expect.stringContaining("password-protected"),
        sessionInvalidation: expect.stringContaining("invalidates existing browser sessions"),
        mcpBoundary: expect.stringContaining("always requires a scoped bearer token"),
      },
      scopeBehavior: { inventory: expect.stringContaining("shared"), offers: expect.stringContaining("itemId") },
    });

    const reconciliation = adapter.listTools().find((tool) => tool.name === "save_reconciliation_draft");
    expect(reconciliation?.inputSchema).toMatchObject({
      properties: {
        lines: {
          items: {
            properties: {
              outcomes: {
                items: {
                  properties: {
                    convertedAsset: {
                      required: expect.arrayContaining(["name", "kind", "quantity", "unit", "tags", "links", "evidence"])
                    }
                  }
                }
              }
            }
          }
        }
      }
    });
  });

  it("does not advertise unsupported mutation names as callable tools", async () => {
    const adapter = new McpAdapter(backend());
    await expect(adapter.callTool("retire_inventory_item", { itemId: "item-esp32" }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_TOOL" } } });
    await expect(adapter.callTool("freeze_artifact_revision", { artifactId: "artifact-1" }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_TOOL" } } });
  });

  it("rejects advertised-input remnants that the application boundary cannot honor", async () => {
    const adapter = new McpAdapter(backend());
    await expect(adapter.callTool("record_usage", { projectRevisionId: "project-revision-1", bomLineId: "bom-1", expectedVersion: 1, itemId: "item-esp32", quantity: { value: 1, unit: "piece" } }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
    await expect(adapter.callTool("create_project_revision", { projectId: "project-1", summary: "r02", basedOnRevisionId: "project-revision-1" }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
    await expect(adapter.callTool("finalize_artifact_upload", { uploadId: "upload-1", expectedFilename: "renamed.step" }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
    await expect(adapter.callTool("begin_artifact_upload", { projectId: "project-1", workItemRevisionId: "work-revision-1", filename: "source.step", role: "step", mediaType: "model/step", byteLength: 12, sha256: "a".repeat(64) }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
    await expect(adapter.callTool("begin_artifact_upload", { projectId: "project-1", projectRevisionId: "project-revision-1", workItemId: "work-1", filename: "source.step", role: "step", mediaType: "model/step", byteLength: 12, sha256: "a".repeat(64) }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
  });

  it("keeps indirect ancestry available across separate adapter instances", async () => {
    const resolverCalls: string[] = [];
    const projectScope = {
      projectForReservation: async (reservationId: string) => { resolverCalls.push(`reservation:${reservationId}`); return reservationId === "reservation-1" ? "project-1" : null; },
      projectForUpload: async (uploadId: string) => { resolverCalls.push(`upload:${uploadId}`); return uploadId === "upload-1" ? "project-1" : null; },
    };
    const scoped = { ...context, projectIds: ["project-1"] as const };
    const first = backend();
    first.projectScope = projectScope;
    const second = backend();
    second.projectScope = projectScope;

    await expect(new McpAdapter(first).callTool("release_reservation", { reservationId: "reservation-1" }, scoped)).resolves.toMatchObject({ isError: false });
    await expect(new McpAdapter(second).callTool("finalize_artifact_upload", { uploadId: "upload-1" }, scoped)).resolves.toMatchObject({ isError: false });
    expect(resolverCalls).toEqual(["reservation:reservation-1", "upload:upload-1"]);
  });

  it("authorizes project-scoped indirect identifiers before dispatch", async () => {
    const scopedBackend = backend();
    scopedBackend.projects.list = async () => page([
      { id: "project-1", name: "Allowed", status: "active", visibility: "private", version: 1 },
      { id: "project-2", name: "Denied", status: "active", visibility: "private", version: 1 },
    ]);
    scopedBackend.projectScope = {
      projectForProjectRevision: async (revisionId) => revisionId === "project-revision-1" ? "project-1" : "project-2",
      projectForBomLine: async (bomLineId) => bomLineId === "bom-1" ? "project-1" : "project-2",
      projectForReservation: async (reservationId) => reservationId === "reservation-1" ? "project-1" : "project-2",
      projectForArtifact: async (artifactId) => artifactId === "artifact-1" ? "project-1" : "project-2",
    };
    const scoped: McpRequestContext = { ...context, projectIds: ["project-1"] };
    const adapter = new McpAdapter(scopedBackend);

    await expect(adapter.callTool("read_project_revision", { revisionId: "project-revision-1" }, scoped)).resolves.toMatchObject({ isError: false });
    await expect(adapter.callTool("read_project_revision", { revisionId: "other-revision" }, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    await expect(adapter.callTool("update_bom_line", { bomLineId: "other-bom", name: "Nope" }, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    await expect(adapter.callTool("release_reservation", { reservationId: "other-reservation" }, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    await expect(adapter.callTool("read_artifact_metadata", { artifactId: "other-artifact" }, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    await expect(adapter.callTool("read_artifact_metadata", { artifactId: "artifact-1", revisionId: "other-revision" }, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });

    const projects = await adapter.callTool("list_projects", {}, scoped);
    expect(projects.structuredContent).toMatchObject({ items: [{ id: "project-1" }], hasMore: false });
  });

  it("keeps reconciliation on BOM scopes and blocks cross-project dispatch", async () => {
    const scopedBackend = backend();
    let reads = 0;
    let saves = 0;
    scopedBackend.reconciliation = {
      read: async () => { reads += 1; return null; },
      save: async () => { saves += 1; return { id: "draft-1", version: 1 }; },
      commit: async () => ({ id: "commit-1", version: 1 }),
    };
    scopedBackend.projectScope = {
      projectForProjectRevision: async (revisionId) => revisionId === "project-revision-1" ? "project-1" : "project-2",
    };
    const adapter = new McpAdapter(scopedBackend);

    for (const [name, requiredScope] of [
      ["read_reconciliation", "bom:read"],
      ["save_reconciliation_draft", "bom:write"],
      ["commit_reconciliation", "bom:write"],
    ] as const) {
      expect(adapter.listTools().find((tool) => tool.name === name)).toMatchObject({ requiredScope });
    }

    const readContext: McpRequestContext = { actorId: "scoped-reader", scopes: ["bom:read"], projectIds: ["project-1"] };
    await expect(adapter.callTool("read_reconciliation", { projectRevisionId: "project-revision-1" }, readContext)).resolves.toMatchObject({ isError: false, structuredContent: { draft: null } });
    await expect(adapter.callTool("read_reconciliation", { projectRevisionId: "other-revision" }, readContext)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    expect(reads).toBe(1);

    const draft = {
      projectRevisionId: "project-revision-1",
      lines: [{ bomLineId: "bom-1", outcomes: [{ reservationId: "reservation-1", itemId: "item-esp32", kind: "consumed", quantity: 1, unit: "each", evidence: { state: "physically_counted" } }] }],
    };
    const writeContext: McpRequestContext = { actorId: "scoped-writer", scopes: ["bom:write"], projectIds: ["project-1"] };
    await expect(adapter.callTool("save_reconciliation_draft", draft, writeContext)).resolves.toMatchObject({ isError: false, structuredContent: { id: "draft-1" } });
    expect(saves).toBe(1);
  });

  it("fails closed for scoped global mutations and supports the atomic project command", async () => {
    const adapter = new McpAdapter(backend());
    const scoped: McpRequestContext = { ...context, projectIds: ["project-1"] };
    await expect(adapter.callTool("create_project", { name: "Nope" }, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    await expect(adapter.callTool("create_inventory_item", { name: "Nope", category: "tool", quantity: { value: 1, unit: "piece" }, evidence: { state: "unknown", source: "test", recordedAt: "2026-08-30" } }, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    await expect(adapter.callTool("list_offers", {}, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    const created = await adapter.callTool("create_project_with_initial_revision", { name: "Atomic reference", revisionSummary: "Initial plan" }, context);
    expect(created).toMatchObject({ isError: false, structuredContent: { project: { id: "project-1" }, revision: { id: "project-revision-1" } } });
  });

  it("dispatches the atomic inventory/profile command and requires both global write scopes", async () => {
    const adapter = new McpAdapter(backend());
    const input = {
      item: {
        name: "PETG HF",
        category: "filament",
        quantity: { value: 1000, unit: "gram" },
        evidence: { state: "delivery", source: "order-1", recordedAt: "2026-08-30" },
      },
      profile: {
        catalogProductId: "catalog-filament-1",
        profileType: "filament_spool",
        linkState: "reported",
        details: { openedState: "sealed" },
      },
    };
    const result = await adapter.callTool("create_inventory_with_product_profile", input, context);
    expect(result).toMatchObject({
      isError: false,
      structuredContent: { id: "created-item", item: { id: "created-item" }, profile: { id: "created-profile", itemId: "created-item" } },
    });

    const noCatalogWrite = { ...context, scopes: context.scopes.filter((scope) => scope !== "catalog:write") };
    await expect(adapter.callTool("create_inventory_with_product_profile", input, noCatalogWrite)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    await expect(adapter.callTool("create_inventory_with_product_profile", input, { ...context, projectIds: ["project-1"] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
  });

  it("advertises and validates the supported BOM constraint keys", async () => {
    const adapter = new McpAdapter(backend());
    const definition = adapter.listTools().find((tool) => tool.name === "create_bom_line");
    const properties = definition?.inputSchema.properties as Record<string, any>;
    const constraints = properties.constraints as Record<string, any>;
    expect(Object.keys(constraints.properties)).toEqual(["kind", "manufacturer", "model", "sku", "tag", "nameIncludes", "specification"]);
    expect(constraints.additionalProperties).toBe(false);
    expect(constraints.properties.specification).toMatchObject({
      required: ["status"],
      properties: { status: { enum: ["sufficient", "insufficient"] } },
    });

    const result = await adapter.callTool("create_bom_line", {
      projectRevisionId: "project-revision-1",
      description: "Board",
      quantity: 1,
      unit: "piece",
      constraints: { unsupported: "value" },
    }, context);
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
  });

  it("dispatches every supported tool through its validated backend boundary", async () => {
    const adapter = new McpAdapter(backend());
    const calls: Array<[string, unknown]> = [
      ["read_inventory_summary", {}],
      ["list_inventory", { query: "esp", category: "electronics", availability: "confirmed", location: "bench", limit: 5 }],
      ["read_inventory_item", { itemId: "item-esp32" }],
      ["create_inventory_item", { name: "Wire", category: "wire", quantity: { value: 1, unit: "metre" }, evidence: { state: "physical_count", source: "count", recordedAt: "2026-08-30" } }],
      ["create_inventory_with_product_profile", { item: { name: "PETG HF", category: "filament", quantity: { value: 1000, unit: "gram" }, evidence: { state: "delivery", source: "order-1", recordedAt: "2026-08-30" } }, profile: { catalogProductId: "catalog-filament-1", profileType: "filament_spool", linkState: "reported", details: { openedState: "sealed" } } }],
      ["update_inventory_item", { itemId: "item-esp32", name: "ESP32" }],
      ["bulk_update_inventory_items", { targets: [{ itemId: "item-esp32", expectedVersion: 1 }], changes: { condition: "good" } }],
      ["record_stock_event", { itemId: "item-esp32", kind: "receipt", quantity: { value: 1, unit: "piece" } }],
      ["list_stock_events", { itemId: "item-esp32", limit: 5 }],
      ["search_catalog_products", { query: "petg", kind: "filament", limit: 5 }],
      ["read_catalog_product", { productId: "catalog-filament-1" }],
      ["create_catalog_product", { kind: "filament", manufacturer: "Bambu Lab", productName: "PETG HF", materialFamily: "PETG", colourName: "Black", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }],
      ["update_catalog_product", { productId: "catalog-filament-1", colourName: "Graphite" }],
      ["read_inventory_product_profile", { itemId: "item-esp32" }],
      ["link_inventory_product_profile", { itemId: "item-esp32", catalogProductId: "catalog-filament-1", profileType: "filament_spool", linkState: "reported", details: { openedState: "sealed" } }],
      ["list_projects", { query: "reference", status: "active", limit: 5 }],
      ["read_project", { projectId: "project-1" }],
      ["create_project", { name: "New project" }],
      ["create_project_with_initial_revision", { name: "New project", revisionSummary: "plan" }],
      ["update_project", { projectId: "project-1", status: "paused" }],
      ["retire_project", { projectId: "project-1" }],
      ["create_work_item", { projectId: "project-1", name: "Part", kind: "part" }],
      ["read_work_item", { workItemId: "work-1" }],
      ["create_project_revision", { projectId: "project-1", summary: "r2" }],
      ["read_project_revision", { revisionId: "project-revision-1" }],
      ["create_work_item_revision", { workItemId: "work-1", summary: "r2" }],
      ["read_work_item_revision", { revisionId: "work-revision-1" }],
      ["list_bom_lines", { projectRevisionId: "project-revision-1", includeRetired: true, limit: 5 }],
      ["create_bom_line", { projectRevisionId: "project-revision-1", description: "ESP32", quantity: 1, unit: "piece" }],
      ["update_bom_line", { bomLineId: "bom-1", description: "ESP32 v2" }],
      ["retire_bom_line", { bomLineId: "bom-1", expectedVersion: 2 }],
      ["restore_bom_line", { bomLineId: "bom-1", expectedVersion: 3 }],
      ["calculate_bom_gaps", { projectRevisionId: "project-revision-1" }],
      ["create_reservation", { projectRevisionId: "project-revision-1", bomLineId: "bom-1", itemId: "item-esp32", quantity: { value: 1, unit: "piece" } }],
      ["release_reservation", { reservationId: "reservation-1" }],
      ["record_usage", { projectRevisionId: "project-revision-1", itemId: "item-esp32", quantity: { value: 1, unit: "piece" } }],
      ["create_build_configuration", { projectRevisionId: "project-revision-1", printerItemSnapshot: { itemId: "printer-1", catalogProductId: "catalog-printer-1" }, filamentSelections: [{ itemId: "item-esp32", catalogProductId: "catalog-filament-1" }], activeHotend: { side: "left" }, nozzle: { diameterMm: 0.4 }, plate: "Cool Plate", accessories: [], firmware: { version: "01.08.00.00" }, slicer: { name: "Bambu Studio", version: "1.10.0" }, profile: { name: "0.20mm Standard" }, calibration: { state: "current" }, explicitUnknowns: [] }],
      ["list_build_configurations", { projectRevisionId: "project-revision-1", limit: 5 }],
      ["read_build_configuration", { buildConfigurationId: "build-config-1" }],
      ["list_artifacts", { projectId: "project-1", limit: 5 }],
      ["read_artifact_metadata", { artifactId: "artifact-1" }],
      ["begin_artifact_upload", { projectId: "project-1", filename: "source.step", role: "source", mediaType: "model/step", byteLength: 12, sha256: "a".repeat(64) }],
      ["finalize_artifact_upload", { uploadId: "upload-1" }],
      ["read_artifact_download_metadata", { artifactId: "artifact-1" }],
      ["download_artifact", { artifactId: "artifact-1" }],
      ["retire_artifact", { artifactId: "artifact-1" }],
      ["list_offers", { itemId: "item-esp32", supplier: "Example", query: "Example" }],
      ["record_offer_snapshot", { itemId: "item-esp32", supplier: "Example", url: "https://shop.example/esp32", price: { minor: 500, currency: "EUR" } }],
      ["refresh_context", { projectId: "project-1", includeInventory: true, maxAgeSeconds: 120 }],
      ["get_capabilities", null],
    ];
    for (const [name, input] of calls) {
      const result = await adapter.callTool(name, input, context);
      expect(result.isError, `${name} should dispatch successfully`).toBe(false);
    }
    expect(adapter.listResources()).toHaveLength(3);
    expect(adapter.listResourceTemplates()).toHaveLength(11);
    expect(adapter.capabilityDocument()).toMatchObject({ product: "BenchLedger" });
    expect(JSON.stringify(adapter.capabilityDocument()).length).toBeLessThan(48 * 1024);
  });

  it("reads each documented resource, enforces scope, and supports bounded results", async () => {
    const adapter = new McpAdapter(backend());
    const uris = [
      "benchledger://capabilities",
      "benchledger://inventory/summary",
      "benchledger://catalog/products/catalog-filament-1",
      "benchledger://inventory/items/item-esp32/product-profile",
      "benchledger://inventory/items/item-esp32",
      "benchledger://projects/project-1/context",
      "benchledger://projects/project-1/revisions/project-revision-1",
      "benchledger://projects/project-1/revisions/project-revision-1/build-configurations",
      "benchledger://build-configurations/build-config-1",
      "benchledger://projects/project-1/bom",
      "benchledger://projects/project-1/artifacts",
    ];
    for (const uri of uris) {
      const result = await adapter.readResource(uri, context);
      expect(result.contents[0]).toMatchObject({ uri, mimeType: "application/json" });
      expect(result.contents[0]?.text.length).toBeGreaterThan(0);
    }
    await expect(adapter.readResource("benchledger://inventory/items/%E0%A4%A", context)).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    await expect(adapter.readResource("benchledger://unknown", context)).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    await expect(adapter.readResource("benchledger://inventory/summary", context, { maxBytes: 1 })).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
    await expect(adapter.readResource("benchledger://projects/project-1/revisions/project-revision-1", { actorId: "x", scopes: ["inventory:read"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adapter.readResource("benchledger://projects/project-1/context", { actorId: "x", scopes: ["projects:read"], projectIds: ["other"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adapter.readResource("benchledger://inventory/summary", { actorId: "x", scopes: ["projects:read"] })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const mismatched = backend();
    mismatched.projects.getProjectRevision = async () => ({ id: "project-revision-1", projectId: "project-2", number: 1, status: "draft" });
    await expect(new McpAdapter(mismatched).readResource("benchledger://projects/project-1/revisions/project-revision-1", context)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const explicitBom = backend();
    explicitBom.bom.listProjectLines = async () => page([{ id: "bom-1", projectRevisionId: "project-revision-1", description: "line", quantity: 1, unit: "piece", requirement: "required" }]);
    await expect(new McpAdapter(explicitBom).readResource("benchledger://projects/project-1/bom", context)).resolves.toMatchObject({ contents: [{ text: expect.stringContaining("bom-1") }] });
  });

  it("normalizes scoped revision-resource access before reading revisions", async () => {
    const scoped: McpRequestContext = { ...context, projectIds: ["project-1"] };
    const scopedBackend = backend();
    let revisionReads = 0;
    let configurationReads = 0;
    scopedBackend.projectScope = {
      projectForProjectRevision: async (revisionId) => revisionId === "existing-denied-revision" ? "project-2" : null,
    };
    scopedBackend.projects.getProjectRevision = async ({ revisionId }) => {
      revisionReads += 1;
      if (revisionId === "missing-revision") throw Object.assign(new Error("missing"), { statusCode: 404 });
      return { id: revisionId, projectId: "project-2", number: 1, status: "draft" };
    };
    scopedBackend.buildConfigurations!.list = async () => {
      configurationReads += 1;
      return page([]);
    };
    const adapter = new McpAdapter(scopedBackend);
    const resourceUris = [
      (revisionId: string) => `benchledger://projects/project-1/revisions/${revisionId}`,
      (revisionId: string) => `benchledger://projects/project-1/revisions/${revisionId}/build-configurations`,
    ];

    for (const makeUri of resourceUris) {
      const unauthorized = await adapter.readResource(makeUri("existing-denied-revision"), scoped).then(
        () => ({ code: "UNEXPECTED_SUCCESS", message: "" }),
        (error: unknown) => error as { code?: string; message?: string },
      );
      const missing = await adapter.readResource(makeUri("missing-revision"), scoped).then(
        () => ({ code: "UNEXPECTED_SUCCESS", message: "" }),
        (error: unknown) => error as { code?: string; message?: string },
      );

      expect(unauthorized).toMatchObject({ code: "FORBIDDEN" });
      expect(missing).toMatchObject({ code: "FORBIDDEN" });
      expect(unauthorized.message).toBe(missing.message);
    }
    expect(revisionReads).toBe(0);
    expect(configurationReads).toBe(0);
  });

  it("preserves unscoped revision-resource not-found and project-mismatch semantics", async () => {
    const unscopedBackend = backend();
    unscopedBackend.projects.getProjectRevision = async ({ revisionId }) => {
      if (revisionId === "missing-revision") throw Object.assign(new Error("missing"), { statusCode: 404 });
      return { id: revisionId, projectId: "project-2", number: 1, status: "draft" };
    };
    const adapter = new McpAdapter(unscopedBackend);

    await expect(adapter.readResource("benchledger://projects/project-1/revisions/existing-denied-revision", context)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "The requested revision is not part of this project.",
    });
    await expect(adapter.readResource("benchledger://projects/project-1/revisions/missing-revision", context)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "The requested record was not found.",
    });
  });

  it("normalizes scoped artifact revision authorization before artifact dispatch", async () => {
    const scoped: McpRequestContext = { ...context, projectIds: ["project-1"] };
    const scopedBackend = backend();
    let dispatches = 0;
    scopedBackend.projectScope = {
      projectForArtifact: async () => "project-1",
      projectForProjectRevision: async (revisionId) => revisionId === "existing-denied-revision" ? "project-2" : null,
    };
    scopedBackend.artifacts.list = async () => {
      dispatches += 1;
      return page([]);
    };
    scopedBackend.artifacts.getMetadata = async () => {
      dispatches += 1;
      return { id: "artifact-1", filename: "source.step", mediaType: "model/step", byteLength: 12, sha256: "a".repeat(64), revision: 1, status: "candidate" };
    };
    scopedBackend.artifacts.downloadMetadata = async () => {
      dispatches += 1;
      return { artifactId: "artifact-1", revisionId: "existing-denied-revision", filename: "source.step", byteLength: 12, sha256: "a".repeat(64), downloadUrl: "https://benchledger.test/api/v1/artifacts/artifact-1/download", expiresAt: "2026-08-30T10:15:00.000Z" };
    };
    const adapter = new McpAdapter(scopedBackend);
    const requests: Array<[string, unknown, unknown]> = [
      ["list_artifacts", { projectId: "project-1", revisionId: "existing-denied-revision" }, { projectId: "project-1", revisionId: "missing-revision" }],
      ["read_artifact_metadata", { artifactId: "artifact-1", revisionId: "existing-denied-revision" }, { artifactId: "artifact-1", revisionId: "missing-revision" }],
      ["read_artifact_download_metadata", { artifactId: "artifact-1", revisionId: "existing-denied-revision" }, { artifactId: "artifact-1", revisionId: "missing-revision" }],
      ["download_artifact", { artifactId: "artifact-1", revisionId: "existing-denied-revision" }, { artifactId: "artifact-1", revisionId: "missing-revision" }],
    ];

    for (const [name, deniedInput, missingInput] of requests) {
      const unauthorized = await adapter.callTool(name, deniedInput, scoped);
      const missing = await adapter.callTool(name, missingInput, scoped);
      expect(unauthorized).toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
      expect(missing).toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
      expect((unauthorized.structuredContent.error as { message: string }).message).toBe((missing.structuredContent.error as { message: string }).message);
    }
    expect(dispatches).toBe(0);

    const unscopedBackend = backend();
    let unscopedDispatches = 0;
    unscopedBackend.artifacts.getMetadata = async ({ revisionId }) => {
      unscopedDispatches += 1;
      if (revisionId === "missing-revision") throw Object.assign(new Error("missing"), { statusCode: 404 });
      return { id: "artifact-1", filename: "source.step", mediaType: "model/step", byteLength: 12, sha256: "a".repeat(64), revision: 1, status: "candidate" };
    };
    const unscopedAdapter = new McpAdapter(unscopedBackend);
    await expect(unscopedAdapter.callTool("read_artifact_metadata", { artifactId: "artifact-1", revisionId: "existing-denied-revision" }, context)).resolves.toMatchObject({ isError: false });
    await expect(unscopedAdapter.callTool("read_artifact_metadata", { artifactId: "artifact-1", revisionId: "missing-revision" }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "NOT_FOUND" } } });
    expect(unscopedDispatches).toBe(2);
  });

  it("authorizes build-configuration resources before backend reads", async () => {
    const scoped: McpRequestContext = { ...context, projectIds: ["project-1"] };
    const scopedBackend = backend();
    let reads = 0;
    scopedBackend.buildConfigurations!.get = async () => {
      reads += 1;
      return {
        id: "build-config-secret",
        projectRevisionId: "secret-revision",
        printerItemSnapshot: { itemId: "printer-1", catalogProductId: "catalog-printer-1", linkState: "confirmed", manufacturer: "Bambu Lab" },
        filamentSelections: [],
        activeHotend: "secret",
        nozzle: "secret",
        plate: "secret",
        accessories: [],
        firmware: "secret",
        slicer: "secret",
        profile: "secret",
        calibration: "secret",
        explicitUnknowns: [],
        contentSha256: "c".repeat(64),
        createdAt: "2026-08-30T10:00:00.000Z",
      };
    };
    scopedBackend.projectScope = { projectForBuildConfiguration: async () => null };

    await expect(new McpAdapter(scopedBackend).readResource("benchledger://build-configurations/build-config-secret", scoped)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(new McpAdapter(scopedBackend).readResource("benchledger://build-configurations/missing-build-config", scoped)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(reads).toBe(0);

    const noResolver = backend();
    noResolver.buildConfigurations!.get = async () => {
      reads += 1;
      throw new Error("backend must not be reached before build-configuration authorization");
    };
    await expect(new McpAdapter(noResolver).readResource("benchledger://build-configurations/build-config-1", scoped)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(reads).toBe(0);
  });

  it("pre-authorizes every indirect build-configuration identifier without an existence oracle", async () => {
    const scoped: McpRequestContext = { ...context, projectIds: ["project-1"] };
    const scopedBackend = backend();
    let reads = 0;
    let writes = 0;
    scopedBackend.projectScope = {
      projectForProjectRevision: async (revisionId) => revisionId === "project-revision-1" ? "project-1" : "project-1",
      projectForBuildConfiguration: async (configurationId) => {
        if (configurationId === "denied-build-config") return "project-2";
        if (configurationId === "allowed-build-config") return "project-1";
        return null;
      },
    };
    scopedBackend.buildConfigurations!.get = async () => {
      reads += 1;
      throw new Error("build configuration backend must not be reached before authorization");
    };
    scopedBackend.buildConfigurations!.create = async () => {
      writes += 1;
      throw new Error("build configuration write must not be reached before authorization");
    };
    scopedBackend.artifacts.beginUpload = async () => {
      writes += 1;
      throw new Error("artifact backend must not be reached before authorization");
    };
    const adapter = new McpAdapter(scopedBackend);
    const createInput = {
      projectRevisionId: "project-revision-1",
      printerItemSnapshot: { itemId: "printer-1", catalogProductId: "catalog-printer-1" },
      filamentSelections: [{ itemId: "item-esp32", catalogProductId: "catalog-filament-1" }],
      activeHotend: { side: "left" },
      nozzle: { diameterMm: 0.4 },
      plate: "Cool Plate",
      accessories: [],
      firmware: { version: "01.08.00.00" },
      slicer: { name: "Bambu Studio", version: "1.10.0" },
      profile: { name: "0.20mm Standard" },
      calibration: { state: "current" },
      explicitUnknowns: [],
    };
    const uploadInput = {
      projectId: "project-1",
      projectRevisionId: "project-revision-1",
      buildConfigurationSnapshotId: "denied-build-config",
      filename: "source.step",
      role: "step",
      mediaType: "model/step",
      byteLength: 12,
      sha256: "a".repeat(64),
    };
    const assertSameForbidden = async (name: string, deniedInput: unknown, missingInput: unknown): Promise<void> => {
      const denied = await adapter.callTool(name, deniedInput, scoped);
      const missing = await adapter.callTool(name, missingInput, scoped);
      expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
      expect(missing).toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
      expect((denied.structuredContent.error as { message: string }).message).toBe((missing.structuredContent.error as { message: string }).message);
    };

    await assertSameForbidden("read_build_configuration", { buildConfigurationId: "denied-build-config" }, { buildConfigurationId: "missing-build-config" });
    await assertSameForbidden("begin_artifact_upload", uploadInput, { ...uploadInput, buildConfigurationSnapshotId: "missing-build-config" });
    await assertSameForbidden("create_build_configuration", { ...createInput, supersedesSnapshotId: "denied-build-config" }, { ...createInput, supersedesSnapshotId: "missing-build-config" });
    expect(reads).toBe(0);
    expect(writes).toBe(0);

    const unscopedBackend = backend();
    const notFound = () => { throw Object.assign(new Error("missing"), { statusCode: 404 }); };
    unscopedBackend.buildConfigurations!.get = async () => notFound();
    unscopedBackend.buildConfigurations!.create = async () => notFound();
    unscopedBackend.artifacts.beginUpload = async () => notFound();
    const unscopedAdapter = new McpAdapter(unscopedBackend);
    await expect(unscopedAdapter.callTool("read_build_configuration", { buildConfigurationId: "missing-build-config" }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "NOT_FOUND" } } });
    await expect(unscopedAdapter.callTool("begin_artifact_upload", { ...uploadInput, buildConfigurationSnapshotId: "missing-build-config" }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "NOT_FOUND" } } });
    await expect(unscopedAdapter.callTool("create_build_configuration", { ...createInput, supersedesSnapshotId: "missing-build-config" }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "NOT_FOUND" } } });
  });

  it("gives build-configuration resources the same scoped response for missing and unauthorized snapshots", async () => {
    const scoped: McpRequestContext = { ...context, projectIds: ["project-1"] };
    const scopedBackend = backend();
    let reads = 0;
    scopedBackend.projectScope = {
      projectForBuildConfiguration: async (configurationId) => configurationId === "unauthorized-resource" ? "project-2" : null,
    };
    scopedBackend.buildConfigurations!.get = async () => {
      reads += 1;
      throw new Error("resource backend must not be reached before authorization");
    };
    const adapter = new McpAdapter(scopedBackend);
    const unauthorized = await adapter.readResource("benchledger://build-configurations/unauthorized-resource", scoped).catch((error: unknown) => error as { code?: string; message?: string });
    const missing = await adapter.readResource("benchledger://build-configurations/missing-resource", scoped).catch((error: unknown) => error as { code?: string; message?: string });
    expect(unauthorized).toMatchObject({ code: "FORBIDDEN" });
    expect(missing).toMatchObject({ code: "FORBIDDEN" });
    expect((unauthorized as { message: string }).message).toBe((missing as { message: string }).message);
    expect(reads).toBe(0);
  });

  it("fails closed for every indirect project identifier when ancestry cannot be proven", async () => {
    const scoped: McpRequestContext = { ...context, projectIds: ["project-1"] };
    const identifiers: Array<[string, unknown, string]> = [
      ["read_project_revision", { revisionId: "project-revision-1" }, "project-revision-1"],
      ["create_work_item_revision", { workItemId: "work-1", summary: "r2" }, "work-1"],
      ["update_bom_line", { bomLineId: "bom-1", description: "changed" }, "bom-1"],
      ["release_reservation", { reservationId: "reservation-1" }, "reservation-1"],
      ["read_artifact_metadata", { artifactId: "artifact-1" }, "artifact-1"],
      ["finalize_artifact_upload", { uploadId: "upload-1" }, "upload-1"],
      ["read_build_configuration", { buildConfigurationId: "build-config-1" }, "build-config-1"],
    ];
    for (const [name, input] of identifiers) {
      const result = await new McpAdapter(backend()).callTool(name, input, scoped);
      expect(result.structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
    }

    const throwing = backend();
    throwing.projectScope = {
      projectForProjectRevision: async () => { throw new Error("resolver unavailable"); },
      projectForWorkItem: async () => { throw new Error("resolver unavailable"); },
      projectForWorkItemRevision: async () => { throw new Error("resolver unavailable"); },
      projectForBomLine: async () => { throw new Error("resolver unavailable"); },
      projectForReservation: async () => { throw new Error("resolver unavailable"); },
      projectForArtifact: async () => { throw new Error("resolver unavailable"); },
      projectForUpload: async () => { throw new Error("resolver unavailable"); },
      projectForBuildConfiguration: async () => { throw new Error("resolver unavailable"); },
    };
    for (const [name, input] of identifiers.slice(1, -1)) {
      const result = await new McpAdapter(throwing).callTool(name, input, scoped);
      expect(result.structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
    }

    const fallback = backend();
    fallback.projectScope = { projectForProjectRevision: async () => null, projectForWorkItemRevision: async () => "project-1", projectForArtifact: async () => "project-1" };
    await expect(new McpAdapter(fallback).callTool("read_artifact_metadata", { artifactId: "artifact-1", revisionId: "work-revision-1" }, scoped)).resolves.toMatchObject({ isError: false });
    const deniedFallback = backend();
    deniedFallback.projectScope = { projectForProjectRevision: async () => null, projectForWorkItemRevision: async () => "project-2", projectForArtifact: async () => "project-1" };
    await expect(new McpAdapter(deniedFallback).callTool("read_artifact_metadata", { artifactId: "artifact-1", revisionId: "work-revision-1" }, scoped)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
  });

  it("rejects unsafe backend payload shapes and oversized results", async () => {
    const malformedProjects = backend();
    malformedProjects.projects.list = async () => [] as never;
    await expect(new McpAdapter(malformedProjects).callTool("list_projects", {}, { ...context, projectIds: ["project-1"] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "BACKEND_ERROR" } } });
    const large = backend();
    large.inventory.list = async () => ({ items: [{ id: "item-1", huge: "x".repeat(100) }], nextCursor: null, hasMore: false }) as never;
    await expect(new McpAdapter(large, { maxToolResultBytes: 20 }).callTool("list_inventory", {}, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "RESOURCE_TOO_LARGE" } } });
    const nestedUnsafe = backend();
    nestedUnsafe.artifacts.finalizeUpload = async () => ({ artifact: { downloadUrl: "https://maker.example/api/v1/transfers/artifacts/artifact-1/download?token=x" } });
    await expect(new McpAdapter(nestedUnsafe).callTool("finalize_artifact_upload", { uploadId: "upload-1" }, context)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "UNSAFE_LINK" } } });
  });
});
