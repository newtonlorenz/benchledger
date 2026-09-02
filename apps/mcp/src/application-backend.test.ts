import { describe, expect, it, vi } from "vitest";
import type { ApplicationService } from "@benchledger/application";
import { McpAdapter } from "./adapter.js";
import { createApplicationBackend } from "./application-backend.js";
import { McpProtocol } from "./protocol.js";
import type { McpRequestContext } from "./types.js";

const context: McpRequestContext = { actorId: "bridge-test", scopes: ["inventory:read", "inventory:write", "artifacts:read", "artifacts:write"] };

const transferProvider = {
  issueUpload: () => ({
    uploadUrl: "http://maker.local:8792/api/v1/transfers/uploads/upload-1",
    uploadHeaders: { "x-bench-transfer-token": "upload-token" },
    finalizeUrl: "http://maker.local:8792/api/v1/transfers/uploads/upload-1/finalize",
    finalizeHeaders: { "x-bench-transfer-token": "finalize-token" },
    expiresAt: "2026-08-30T10:15:00.000Z",
  }),
  issueDownload: () => ({
    downloadUrl: "http://maker.local:8792/api/v1/transfers/artifacts/artifact-1/download",
    requiredHeaders: { "x-bench-transfer-token": "download-token" },
    expiresAt: "2026-08-30T10:15:00.000Z",
  }),
};

function serviceStub(): ApplicationService {
  const item = {
    id: "filament-petg",
    name: "PETG HF",
    kind: "filament",
    quantity: 1000,
    availableQuantity: 1000,
    unit: "gram",
    tags: ["petg"],
    links: [],
    evidence: { state: "physically_counted", source: "test", observedAt: "2026-08-30T10:00:00.000Z" },
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    version: 1,
  };
  const artifact = {
    id: "artifact-1",
    projectId: "project-1",
    revisionId: "revision-1",
    role: "step",
    filename: "part.step",
    mediaType: "model/step",
    byteSize: 100,
    sha256: "a".repeat(64),
    currentCandidate: true,
    retired: false,
    createdAt: "2026-08-30T10:00:00.000Z",
    version: 1,
  };
  const category = {
    id: "category-tools",
    name: "Tools",
    sortOrder: 0,
    archived: false,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    version: 1,
  };
  return {
    listInventory: async () => ({ data: [item], limit: 10 }),
    bulkUpdateInventoryItems: vi.fn(async () => ({
      data: { updated: [{ ...item, location: "updated drawer", version: 2 }], unchanged: [] },
      audits: [{ id: "audit-bulk", action: "inventory.item.bulk_update", actor: "bridge-test", source: "mcp", correlationId: "bulk-correlation", entityType: "inventory_item", entityId: item.id, version: 2, createdAt: "2026-08-30T10:01:00.000Z" }],
      correlationId: "bulk-correlation",
      replayed: false,
    })),
    listInventoryCategories: async () => ({ data: [category], limit: 10 }),
    getInventoryCategory: async () => category,
    createInventoryCategory: async (input: { name: string }) => ({ data: { ...category, id: "category-created", name: input.name }, audit: { id: "audit-category", entityId: "category-created", version: 1 }, correlationId: "bridge-test", replayed: false }),
    updateInventoryCategory: async (id: string, input: { name?: string }, _expectedVersion: number) => ({ data: { ...category, id, ...(input.name === undefined ? {} : { name: input.name }), version: 2 }, audit: { id: "audit-category-update", entityId: id, version: 2 }, correlationId: "bridge-test", replayed: false }),
    archiveInventoryCategory: async (id: string, _expectedVersion: number) => ({ data: { ...category, id, archived: true, version: 2 }, audit: { id: "audit-category-archive", entityId: id, version: 2 }, correlationId: "bridge-test", replayed: false }),
    getArtifact: vi.fn(async () => artifact),
    getProjectRevision: async () => ({ id: "revision-1", projectId: "project-1", number: 1, name: "Initial", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 }),
    listReservations: vi.fn(async () => [{ id: "reservation-1", lineId: "bom-1", itemId: "item-1", quantity: 1, status: "active", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }]),
    getReservationDetails: vi.fn(async () => ({ projectId: "project-1", projectRevisionId: "revision-1", reservation: { id: "reservation-1", lineId: "bom-1", itemId: "item-1", quantity: 1, status: "active", version: 1 }, bomLine: { unit: "each" } })),
    recordUsage: async (input: { itemId: string; quantity: number; unit: string; projectId: string; reservationId?: string }) => ({ data: { event: { id: "usage-event-1" }, item: { id: input.itemId, availableQuantity: 4, unit: input.unit, version: 2 } }, audit: { id: "audit-usage" }, correlationId: "bridge-test", replayed: false }),
    commissionInventoryItem: async (itemId: string, input: { quantity: number; unit: string; evidence: { state: string; source: string; sourceId?: string; observedAt: string; note?: string } }, expectedVersion: number) => ({ data: { event: { id: "commission-event-1", itemId, type: "count", quantity: input.quantity, unit: input.unit, evidence: input.evidence }, item: { ...item, id: itemId, quantity: input.quantity, availableQuantity: input.quantity, evidence: input.evidence, version: expectedVersion + 1 } }, audit: { id: "audit-commission" }, correlationId: "bridge-test", replayed: false }),
    beginArtifactUpload: vi.fn(async () => ({ data: { id: "upload-1", artifactId: "artifact-1", uploadUrl: "/api/v1/artifacts/uploads/upload-1", expiresAt: "2026-08-30T10:15:00.000Z", maxBytes: 100, status: "pending" }, audit: { id: "audit-1", entityId: "upload-1" }, correlationId: "bridge-test", replayed: false })),
    createProjectWithInitialRevision: async () => ({ data: { project: { id: "project-atomic", name: "Atomic project", status: "idea", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", currentRevisionId: "revision-atomic", version: 1 }, revision: { id: "revision-atomic", projectId: "project-atomic", number: 1, name: "Initial", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 } }, audit: { id: "audit-atomic", entityId: "project-atomic", action: "project.create_with_initial_revision", actor: "bridge-test", source: "mcp", correlationId: "bridge-test", entityType: "project", version: 1, createdAt: "2026-08-30T10:00:00.000Z" }, correlationId: "bridge-test", replayed: false }),
  } as unknown as ApplicationService;
}

describe("createApplicationBackend", () => {
  it("round-trips physical-only filament labels and evidence without inventing identity", async () => {
    const service = serviceStub() as ApplicationService & Record<string, any>;
    const physicalSelection = {
      itemId: "filament-petg",
      catalogIdentityState: "unknown",
      physicalLabel: "Legacy PETG spool",
      physicalEvidence: { state: "delivery", source: "legacy-import", recordedAt: "2026-08-30T10:00:00.000Z", note: "No catalog match recorded" },
      role: "model",
      quantity: 1,
    };
    const snapshot = {
      id: "build-config-physical-only",
      projectRevisionId: "revision-1",
      printerItemSnapshot: { itemId: "printer-1", catalogProductId: "printer-product-1", linkState: "confirmed", manufacturer: "Bambu Lab", exactModel: "H2D", technology: "fff", buildVolumeMm: { x: 325, y: 320, z: 325 } },
      filamentSelections: [physicalSelection],
      activeHotend: { side: "left" },
      nozzle: { diameterMm: 0.4 },
      plate: "Cool Plate",
      accessories: [],
      firmware: { version: "1" },
      slicer: { name: "Bambu Studio" },
      profile: { name: "0.20mm Standard" },
      calibration: { state: "current" },
      explicitUnknowns: ["Filament catalog identity is unknown; production approval is blocked."],
      contentSha256: "a".repeat(64),
      createdAt: "2026-08-30T10:00:00.000Z",
    };
    service.createBuildConfiguration = vi.fn(async () => ({ data: snapshot, audit: { id: "audit-build", entityId: snapshot.id, version: 1 }, correlationId: "bridge-test", replayed: false }));
    service.getBuildConfiguration = vi.fn(async () => snapshot);
    const backend = createApplicationBackend(service);

    const input = {
      projectRevisionId: "revision-1",
      printerItemSnapshot: { itemId: "printer-1", catalogProductId: "printer-product-1" },
      filamentSelections: [{ itemId: "filament-petg", catalogIdentityState: "unknown", role: "model", quantity: 1 }],
      activeHotend: { side: "left" },
      nozzle: { diameterMm: 0.4 },
      plate: "Cool Plate",
      accessories: [],
      firmware: { version: "1" },
      slicer: { name: "Bambu Studio" },
      profile: { name: "0.20mm Standard" },
      calibration: { state: "current" },
      explicitUnknowns: [],
    };
    const created = await backend.buildConfigurations!.create(input as any, context);
    expect(service.createBuildConfiguration).toHaveBeenCalledWith("revision-1", expect.objectContaining({ filamentSelections: input.filamentSelections }), expect.objectContaining({ source: "mcp" }));
    expect(created).toMatchObject({ buildConfiguration: { filamentSelections: [{ itemId: "filament-petg", catalogIdentityState: "unknown", physicalLabel: "Legacy PETG spool", physicalEvidence: { state: "delivery" } }], explicitUnknowns: expect.arrayContaining([expect.stringMatching(/production approval.*blocked/i)]) } });

    const read = await backend.buildConfigurations!.get({ buildConfigurationId: snapshot.id }, context);
    const readSelection = read.filamentSelections[0] as Record<string, unknown>;
    expect(readSelection).toMatchObject({ physicalLabel: "Legacy PETG spool", physicalEvidence: { source: "legacy-import" } });
    expect(readSelection).not.toHaveProperty("catalogProductId");
    expect(readSelection).not.toHaveProperty("profileId");
    expect(readSelection).not.toHaveProperty("linkState");
    expect(read.filamentSelections).not.toBe(snapshot.filamentSelections);
    expect(readSelection).not.toBe(physicalSelection);
    expect(readSelection.physicalEvidence).not.toBe(physicalSelection.physicalEvidence);
  });

  it("maps application inventory into evidence-aware MCP vocabulary", async () => {
    const backend = createApplicationBackend(serviceStub(), { publicBaseUrl: "http://maker.local:8792", artifactTransfer: transferProvider });
    const result = await backend.inventory.list({ limit: 10 }, context);
    expect(result.items[0]).toMatchObject({ id: "filament-petg", category: "filament", availability: "confirmed", quantity: { value: 1000, unit: "gram" } });
  });

  it("maps bounded reservation reads through durable reservation details", async () => {
    const service = serviceStub();
    const backend = createApplicationBackend(service);
    const list = await backend.bom.listReservations?.({ projectRevisionId: "revision-1", limit: 1 }, context);
    expect(list).toMatchObject({ items: [{ id: "reservation-1", projectRevisionId: "revision-1", bomLineId: "bom-1", itemId: "item-1", quantity: { value: 1, unit: "piece" }, status: "active" }], nextCursor: null, hasMore: false });
    expect(service.listReservations).toHaveBeenCalledWith("revision-1");
    expect(service.getReservationDetails).toHaveBeenCalledWith("reservation-1");

    const read = await backend.bom.getReservation?.({ reservationId: "reservation-1" }, context);
    expect(read).toMatchObject({ id: "reservation-1", projectRevisionId: "revision-1", bomLineId: "bom-1", itemId: "item-1", quantity: { value: 1, unit: "piece" }, status: "active" });
    expect(service.getReservationDetails).toHaveBeenCalledWith("reservation-1");
  });

  it("maps managed categories through the shared application service", async () => {
    const backend = createApplicationBackend(serviceStub());
    await expect(backend.inventoryCategories?.list({ limit: 5 }, context)).resolves.toMatchObject({ items: [{ id: "category-tools" }], nextCursor: null, hasMore: false });
    await expect(backend.inventoryCategories?.create({ name: "Printer parts", sortOrder: 0 }, context)).resolves.toMatchObject({ category: { id: "category-created", name: "Printer parts" }, auditId: "audit-category" });
    await expect(backend.inventoryCategories?.update({ categoryId: "category-tools", expectedVersion: 1, name: "Workshop tools" }, context)).resolves.toMatchObject({ category: { name: "Workshop tools", version: 2 } });
    await expect(backend.inventoryCategories?.archive({ categoryId: "category-tools", expectedVersion: 1 }, context)).resolves.toMatchObject({ category: { archived: true } });
  });

  it("maps the atomic bulk metadata mutation and preserves audit/replay metadata", async () => {
    const service = serviceStub() as ApplicationService & { bulkUpdateInventoryItems: ReturnType<typeof vi.fn> };
    const backend = createApplicationBackend(service);
    const result = await backend.inventory.bulkUpdate({
      targets: [{ itemId: "filament-petg", expectedVersion: 1 }],
      changes: { location: "updated drawer", tags: { add: ["new-tag"] } },
    }, { ...context, idempotencyKey: "bulk-mcp-key" });
    expect(service.bulkUpdateInventoryItems).toHaveBeenCalledWith({
      targets: [{ itemId: "filament-petg", expectedVersion: 1 }],
      changes: { location: "updated drawer", tags: { add: ["new-tag"] } },
    }, expect.objectContaining({ actor: context.actorId, source: "mcp", idempotencyKey: "bulk-mcp-key" }));
    expect(result).toMatchObject({
      updated: [{ itemId: "filament-petg", version: 2 }],
      unchanged: [],
      auditIds: ["audit-bulk"],
      correlationId: "bulk-correlation",
      replayed: false,
    });
  });

  it("fails closed for artifact upload before the legacy URL issuer or service are called", async () => {
    const service = serviceStub();
    const backend = createApplicationBackend(service, { publicBaseUrl: "http://maker.local:8792", artifactTransfer: transferProvider });
    await expect(backend.artifacts.beginUpload({ projectId: "project-1", projectRevisionId: "revision-1", filename: "part.step", role: "step", mediaType: "model/step", byteLength: 100, sha256: "a".repeat(64) }, context)).rejects.toMatchObject({ code: "HOST_TRANSFER_UNAVAILABLE" });
    expect(service.beginArtifactUpload).not.toHaveBeenCalled();
  });

  it("fails closed for artifact download before the legacy URL issuer or service are called", async () => {
    const service = serviceStub();
    const backend = createApplicationBackend(service, { publicBaseUrl: "http://maker.local:8792", artifactTransfer: transferProvider });
    await expect(backend.artifacts.downloadMetadata({ artifactId: "artifact-1" }, context)).rejects.toMatchObject({ code: "HOST_TRANSFER_UNAVAILABLE" });
    expect(service.getArtifact).not.toHaveBeenCalled();
  });

  it("forwards an optional reservation id when recording usage", async () => {
    const backend = createApplicationBackend(serviceStub(), { artifactTransfer: transferProvider });
    const result = await backend.bom.recordUsage({ projectRevisionId: "revision-1", reservationId: "reservation-1", itemId: "item-1", quantity: { value: 1, unit: "piece" } }, context);
    expect(result).toMatchObject({ usageEventId: "usage-event-1", itemId: "item-1" });
  });

  it("forwards commissioning provenance, version, and idempotency context", async () => {
    const service = serviceStub() as ApplicationService & Record<string, any>;
    service.commissionInventoryItem = vi.fn(service.commissionInventoryItem);
    const backend = createApplicationBackend(service);
    const result = await backend.inventory.commission!({
      itemId: "filament-petg",
      expectedVersion: 3,
      quantity: { value: 750, unit: "gram" },
      evidence: { state: "commissioned", source: "bench check", sourceId: "check-3", recordedAt: "2026-08-31T10:00:00Z", note: "Reweighed" },
    }, { ...context, idempotencyKey: "commission-bridge-1" });

    expect(service.commissionInventoryItem).toHaveBeenCalledWith("filament-petg", {
      quantity: 750,
      unit: "gram",
      evidence: { state: "commissioned", source: "bench check", sourceId: "check-3", observedAt: "2026-08-31T10:00:00Z", note: "Reweighed" },
    }, 3, expect.objectContaining({ source: "mcp", idempotencyKey: "commission-bridge-1" }));
    expect(result).toMatchObject({ id: "filament-petg", version: 4, eventId: "commission-event-1", auditId: "audit-commission" });
  });

  it("rejects usage when a reservation belongs to another project revision", async () => {
    const service = serviceStub() as ApplicationService & Record<string, any>;
    service.recordUsage = vi.fn(service.recordUsage);
    const backend = createApplicationBackend(service, {
      projectScope: {
        reservationDetails: async () => ({ projectId: "project-1", projectRevisionId: "revision-other", bomLineId: "bom-1", itemId: "item-1", unit: "piece" }),
      },
    });

    await expect(backend.bom.recordUsage({ projectRevisionId: "revision-1", reservationId: "reservation-1", itemId: "item-1", quantity: { value: 1, unit: "piece" } }, context)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(service.recordUsage).not.toHaveBeenCalled();
  });

  it("maps the atomic project-and-revision application command", async () => {
    const backend = createApplicationBackend(serviceStub());
    const result = await backend.projects.createWithInitialRevision({ name: "Atomic project", revisionSummary: "Initial plan" }, context);
    expect(result).toMatchObject({ id: "project-atomic", project: { id: "project-atomic" }, revision: { id: "revision-atomic", projectId: "project-atomic" }, auditId: "audit-atomic", replayed: false });
  });

  it("maps the atomic inventory/profile application command with one mutation", async () => {
    const service = serviceStub() as ApplicationService & Record<string, any>;
    service.createInventoryWithProductProfile = vi.fn(async (input: Record<string, any>) => ({
      data: {
        item: { ...serviceStubItem(), id: "created-item", name: input.item.name },
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
      },
      audit: { id: "audit-compound", entityId: "created-item", version: 1 },
      correlationId: "bridge-test",
      replayed: false,
    }));
    const backend = createApplicationBackend(service);
    const result = await backend.inventory.createWithProductProfile!({
      item: { name: "PETG HF", category: "filament", quantity: { value: 1000, unit: "gram" }, evidence: { state: "delivery", source: "order-1", recordedAt: "2026-08-30" } },
      profile: { catalogProductId: "catalog-filament-1", profileType: "filament_spool", linkState: "reported", details: { openedState: "sealed" } },
    }, { ...context, idempotencyKey: "compound-key-1" });

    expect(service.createInventoryWithProductProfile).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({ name: "PETG HF", kind: "filament", quantity: 1000, unit: "gram" }),
      profile: expect.objectContaining({ catalogProductId: "catalog-filament-1", profileType: "filament_spool" }),
    }), expect.objectContaining({ source: "mcp", idempotencyKey: "compound-key-1" }));
    expect(result).toMatchObject({ id: "created-item", item: { id: "created-item" }, profile: { id: "created-profile", itemId: "created-item" }, auditId: "audit-compound" });
  });

  it("renders released reservations from durable identity", async () => {
    const service = serviceStub() as ApplicationService & { releaseReservation: ApplicationService["releaseReservation"] };
    service.releaseReservation = async () => ({ data: { id: "reservation-1", lineId: "bom-older", itemId: "filament-petg", quantity: 42, status: "released", version: 2 }, audit: { id: "audit-reservation", entityId: "reservation-1" }, correlationId: "bridge-test", replayed: false }) as never;
    const backend = createApplicationBackend(service, {
      publicBaseUrl: "http://maker.local:8792",
      artifactTransfer: transferProvider,
      projectScope: {
        reservationDetails: async () => ({ projectId: "project-1", projectRevisionId: "revision-older", bomLineId: "bom-older", itemId: "filament-petg", unit: "gram" }),
      },
    });

    const released = await backend.bom.release({ reservationId: "reservation-1" }, context);
    expect(released).toMatchObject({ id: "reservation-1", projectRevisionId: "revision-older", bomLineId: "bom-older", itemId: "filament-petg", quantity: { value: 42, unit: "gram" }, status: "released", version: 2 });
  });

  it("uses direct service ancestry lookups instead of enumerating current projects", async () => {
    const service = serviceStub();
    service.listProjects = async () => { throw new Error("project enumeration is not a resolver"); };
    service.getWorkItem = async () => ({ id: "work-1", projectId: "project-1", name: "Part", kind: "part" }) as never;
    service.getBomLine = async () => ({ id: "bom-old", revisionId: "revision-old", name: "Board", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }) as never;
    service.getReservationDetails = async () => ({ reservation: { id: "reservation-old", lineId: "bom-old", itemId: "filament-petg", quantity: 1, status: "active", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }, projectId: "project-1", projectRevisionId: "revision-old", bomLine: { id: "bom-old", revisionId: "revision-old", name: "Filament", requiredQuantity: 1, unit: "gram", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 } }) as never;
    service.getUploadSessionDetails = async () => ({ session: { id: "upload-old", artifactId: "artifact-old", expiresAt: "2026-08-30T10:15:00.000Z", maxBytes: 10, uploadUrl: "/uploads/upload-old", status: "pending" }, projectId: "project-1", revisionId: "revision-old" }) as never;
    const backend = createApplicationBackend(service);

    await expect(backend.projectScope?.projectForWorkItem?.("work-1")).resolves.toBe("project-1");
    await expect(backend.projectScope?.projectForBomLine?.("bom-old")).resolves.toBe("project-1");
    await expect(backend.projectScope?.projectForReservation?.("reservation-old")).resolves.toBe("project-1");
    await expect(backend.projectScope?.projectForUpload?.("upload-old")).resolves.toBe("project-1");
    await expect(backend.projectScope?.reservationDetails?.("reservation-old")).resolves.toMatchObject({ projectRevisionId: "revision-old", unit: "gram" });
  });

  it("round-trips every advertised artifact role without alias coercion", async () => {
    const roles = ["source", "cad", "cad_source", "step", "stl", "three_mf", "slicer_project", "gcode", "drawing", "validation", "document", "brief", "design_record", "firmware", "photo", "text", "other"] as const;
    const service = serviceStub() as ApplicationService & Record<string, any>;
    const backend = createApplicationBackend(service, { artifactTransfer: transferProvider });
    for (const role of roles) {
      service.getArtifact = async () => ({ ...serviceStubArtifact(), role });
      await expect(backend.artifacts.getMetadata({ artifactId: "artifact-1" }, context)).resolves.toMatchObject({ role });
    }
  });
});

function serviceStubArtifact() {
  return {
    id: "artifact-1",
    projectId: "project-1",
    revisionId: "revision-1",
    role: "step",
    filename: "part.step",
    mediaType: "model/step",
    byteSize: 100,
    sha256: "a".repeat(64),
    currentCandidate: true,
    retired: false,
    createdAt: "2026-08-30T10:00:00.000Z",
    version: 1,
  };
}

function serviceStubItem() {
  return {
    id: "filament-petg",
    name: "PETG HF",
    kind: "filament",
    quantity: 1000,
    availableQuantity: 1000,
    unit: "gram",
    tags: [],
    links: [],
    evidence: { state: "physically_counted", source: "test", observedAt: "2026-08-30T10:00:00.000Z" },
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    version: 1,
  };
}
