import { describe, expect, it, vi } from "vitest";
import type { ApplicationService } from "@benchledger/application";
import { createApplicationBackend } from "./application-backend.js";
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
  return {
    listInventory: async () => ({ data: [item], limit: 10 }),
    getArtifact: async () => artifact,
    getProjectRevision: async () => ({ id: "revision-1", projectId: "project-1", number: 1, name: "Initial", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 }),
    getReservationDetails: async () => ({ projectId: "project-1", projectRevisionId: "revision-1", reservation: { lineId: "bom-1", itemId: "item-1" }, bomLine: { unit: "each" } }),
    recordUsage: async (input: { itemId: string; quantity: number; unit: string; projectId: string; reservationId?: string }) => ({ data: { event: { id: "usage-event-1" }, item: { id: input.itemId, availableQuantity: 4, unit: input.unit, version: 2 } }, audit: { id: "audit-usage" }, correlationId: "bridge-test", replayed: false }),
    beginArtifactUpload: async () => ({ data: { id: "upload-1", artifactId: "artifact-1", uploadUrl: "/api/v1/artifacts/uploads/upload-1", expiresAt: "2026-08-30T10:15:00.000Z", maxBytes: 100, status: "pending" }, audit: { id: "audit-1", entityId: "upload-1" }, correlationId: "bridge-test", replayed: false }),
    createProjectWithInitialRevision: async () => ({ data: { project: { id: "project-atomic", name: "Atomic project", status: "idea", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", currentRevisionId: "revision-atomic", version: 1 }, revision: { id: "revision-atomic", projectId: "project-atomic", number: 1, name: "Initial", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 } }, audit: { id: "audit-atomic", entityId: "project-atomic", action: "project.create_with_initial_revision", actor: "bridge-test", source: "mcp", correlationId: "bridge-test", entityType: "project", version: 1, createdAt: "2026-08-30T10:00:00.000Z" }, correlationId: "bridge-test", replayed: false }),
  } as unknown as ApplicationService;
}

describe("createApplicationBackend", () => {
  it("maps application inventory into evidence-aware MCP vocabulary", async () => {
    const backend = createApplicationBackend(serviceStub(), { publicBaseUrl: "http://maker.local:8792", artifactTransfer: transferProvider });
    const result = await backend.inventory.list({ limit: 10 }, context);
    expect(result.items[0]).toMatchObject({ id: "filament-petg", category: "filament", availability: "confirmed", quantity: { value: 1000, unit: "gram" } });
  });

  it("returns separate short-lived capabilities for upload and finalize", async () => {
    const backend = createApplicationBackend(serviceStub(), { publicBaseUrl: "http://maker.local:8792", artifactTransfer: transferProvider });
    const result = await backend.artifacts.beginUpload({ projectId: "project-1", filename: "part.step", role: "step", mediaType: "model/step", byteLength: 100, sha256: "a".repeat(64) }, context);
    expect(result.uploadUrl).toBe("http://maker.local:8792/api/v1/transfers/uploads/upload-1");
    expect(result.uploadUrl).not.toContain("?");
    expect(result.requiredHeaders).toEqual({ "x-bench-transfer-token": "upload-token" });
    expect(result.finalizeUrl).toBe("http://maker.local:8792/api/v1/transfers/uploads/upload-1/finalize");
    expect(result.finalizeHeaders).toEqual({ "x-bench-transfer-token": "finalize-token" });
    expect(result.method).toBe("PUT");
  });

  it("returns a header-bound scoped download capability", async () => {
    const backend = createApplicationBackend(serviceStub(), { publicBaseUrl: "http://maker.local:8792", artifactTransfer: transferProvider });
    const result = await backend.artifacts.downloadMetadata({ artifactId: "artifact-1" }, context);
    expect(result.downloadUrl).toBe("http://maker.local:8792/api/v1/transfers/artifacts/artifact-1/download");
    expect(result.downloadUrl).not.toContain("?");
    expect(result.requiredHeaders).toEqual({ "x-bench-transfer-token": "download-token" });
  });

  it("forwards an optional reservation id when recording usage", async () => {
    const backend = createApplicationBackend(serviceStub(), { publicBaseUrl: "http://maker.local:8792", artifactTransfer: transferProvider });
    const result = await backend.bom.recordUsage({ projectRevisionId: "revision-1", reservationId: "reservation-1", itemId: "item-1", quantity: { value: 1, unit: "piece" } }, context);
    expect(result).toMatchObject({ usageEventId: "usage-event-1", itemId: "item-1" });
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
    const backend = createApplicationBackend(serviceStub(), { publicBaseUrl: "http://maker.local:8792", artifactTransfer: transferProvider });
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

  it("forwards a work-item revision and renders released reservations from durable identity", async () => {
    const service = serviceStub() as ApplicationService & {
      beginArtifactUpload: ApplicationService["beginArtifactUpload"];
      releaseReservation: ApplicationService["releaseReservation"];
    };
    let uploadInput: Record<string, unknown> | undefined;
    service.beginArtifactUpload = async (input) => {
      uploadInput = input as unknown as Record<string, unknown>;
      return { data: { id: "upload-1", artifactId: "artifact-1", uploadUrl: "/uploads/upload-1", expiresAt: "2026-08-30T10:15:00.000Z", maxBytes: 100, status: "pending" }, audit: { id: "audit-upload", entityId: "upload-1" }, correlationId: "bridge-test", replayed: false } as never;
    };
    service.releaseReservation = async () => ({ data: { id: "reservation-1", lineId: "bom-older", itemId: "filament-petg", quantity: 42, status: "released", version: 2 }, audit: { id: "audit-reservation", entityId: "reservation-1" }, correlationId: "bridge-test", replayed: false }) as never;
    const backend = createApplicationBackend(service, {
      publicBaseUrl: "http://maker.local:8792",
      artifactTransfer: transferProvider,
      projectScope: {
        reservationDetails: async () => ({ projectId: "project-1", projectRevisionId: "revision-older", bomLineId: "bom-older", itemId: "filament-petg", unit: "gram" }),
      },
    });

    await backend.artifacts.beginUpload({ projectId: "project-1", workItemId: "work-1", workItemRevisionId: "work-revision-1", filename: "part.step", role: "step", mediaType: "model/step", byteLength: 100, sha256: "a".repeat(64) }, context);
    expect(uploadInput).toMatchObject({ projectId: "project-1", workItemId: "work-1", revisionId: "work-revision-1" });

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
    const backend = createApplicationBackend(service, { publicBaseUrl: "http://maker.local:8792", artifactTransfer: transferProvider });

    service.beginArtifactUpload = vi.fn(async () => ({ data: { id: "upload-1", artifactId: "artifact-1", uploadUrl: "/uploads/upload-1", expiresAt: "2026-08-30T10:15:00.000Z", maxBytes: 100, status: "pending" }, audit: { id: "audit-upload", entityId: "upload-1" }, correlationId: "bridge-test", replayed: false }));
    for (const role of roles) {
      await backend.artifacts.beginUpload({ projectId: "project-1", filename: "part.bin", role, mediaType: "application/octet-stream", byteLength: 1, sha256: "a".repeat(64) }, context);
      expect(service.beginArtifactUpload).toHaveBeenLastCalledWith(expect.objectContaining({ role }), expect.anything());
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
