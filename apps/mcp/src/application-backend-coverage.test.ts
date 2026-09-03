import { describe, expect, it, vi } from "vitest";
import { ApplicationError, type ApplicationService } from "@benchledger/application";
import { McpAdapter } from "./adapter.js";
import { createApplicationBackend } from "./application-backend.js";
import type { McpRequestContext } from "./types.js";

const date = "2026-08-30T10:00:00.000Z";
const context: McpRequestContext = {
  actorId: "coverage-agent",
  correlationId: "coverage-correlation",
  idempotencyKey: "coverage-key",
  fingerprint: "coverage-fingerprint",
  scopes: [
    "inventory:read", "inventory:write", "projects:read", "projects:write",
    "bom:read", "bom:write", "artifacts:read", "artifacts:write",
    "offers:read", "offers:write", "context:read",
  ],
};

function audit(entityId = "entity-1", version = 2) {
  return { id: `audit-${entityId}`, action: "test", actor: "coverage-agent", source: "mcp" as const, correlationId: context.correlationId!, entityType: "test", entityId, version, createdAt: date };
}

function mutation<T>(data: T, entityId = "entity-1", version = 2) {
  return { data, audit: audit(entityId, version), correlationId: context.correlationId!, replayed: false };
}

function apiItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "filament-petg", name: "PETG HF Black", kind: "filament", description: "High-flow material", manufacturer: "Bambu Lab", model: "PETG HF", sku: "PETG-HF-BLK", quantity: 1000, availableQuantity: 900, unit: "gram", location: "filament cabinet", condition: "good", dimensions: { lengthMm: 210, widthMm: 210, heightMm: 70, diameterMm: 1.75, measured: true, uncertaintyMm: 0.1 }, tags: ["petg", "black"], links: [{ supplier: "Bambu", url: "https://maker.example/petg", label: "Product", currentPriceMinor: 2200, currency: "EUR", observedAt: date, packageQuantity: 1000 }], evidence: { state: "physically_counted", source: "scale", observedAt: date, note: "weighed after print" }, createdAt: date, updatedAt: date, version: 2, ...overrides,
  };
}

function apiProject(overrides: Record<string, unknown> = {}) {
  return { id: "project-1", name: "Lamp", description: "A maker project", status: "building", currentRevisionId: "revision-1", createdAt: date, updatedAt: date, version: 2, ...overrides };
}

function apiRevision(overrides: Record<string, unknown> = {}) {
  return { id: "revision-1", projectId: "project-1", number: 1, name: "Initial", status: "concept", createdAt: date, version: 1, ...overrides };
}

function apiArtifact(overrides: Record<string, unknown> = {}) {
  return { id: "artifact-1", projectId: "project-1", revisionId: "revision-1", role: "step", filename: "part.step", mediaType: "model/step", byteSize: 100, sha256: "a".repeat(64), currentCandidate: true, retired: false, createdAt: date, version: 1, ...overrides };
}

function apiLine(overrides: Record<string, unknown> = {}) {
  return { id: "bom-1", revisionId: "revision-1", name: "M3 screw", itemId: "screw-m3", requiredQuantity: 4, unit: "each", optional: false, constraints: { sku: "M3-12" }, alternatives: [{ itemId: "screw-m3-alt", compatible: "confirmed", reason: "same fit" }], notes: "button head", createdAt: date, updatedAt: date, version: 1, ...overrides };
}

function apiOffer(overrides: Record<string, unknown> = {}) {
  return { id: "offer-1", itemId: "screw-m3", name: "M3 screw pack", supplier: "Amazon", url: "https://shop.example/m3", priceMinor: 499, currency: "EUR", packageQuantity: 100, shippingMinor: 0, observedAt: date, staleAfterDays: 30, notes: "Prime", version: 1, ...overrides };
}

function apiReservation(overrides: Record<string, unknown> = {}) {
  return { id: "reservation-1", lineId: "bom-1", itemId: "screw-m3", quantity: 2, status: "active", createdAt: date, updatedAt: date, version: 1, ...overrides };
}

function serviceFixture(): ApplicationService & Record<string, any> {
  const service = {
    listInventory: vi.fn(async () => ({ data: [apiItem()], limit: 25, nextCursor: "next" })),
    getInventoryItem: vi.fn(async () => apiItem()),
    createInventoryItem: vi.fn(async (input: unknown) => mutation(apiItem({ ...(input as object), id: "created-item", version: 3 }), "created-item", 3)),
    updateInventoryItem: vi.fn(async (id: string, input: unknown) => mutation(apiItem({ ...(input as object), id, version: 4 }), id, 4)),
    recordStockEvent: vi.fn(async (input: any) => mutation({ event: { id: "event-1", itemId: input.itemId, type: input.type, quantity: input.quantity, unit: input.unit, actor: "coverage-agent", source: "mcp", createdAt: date, itemVersion: 5 }, item: apiItem({ id: input.itemId, availableQuantity: 800, version: 5 }) }, input.itemId, 5)),
    listStockEvents: vi.fn(async () => ({ data: [
      { id: "event-receipt", itemId: "filament-petg", type: "receipt", quantity: 1, unit: "gram", actor: "a", source: "mcp", createdAt: date, itemVersion: 1 },
      { id: "event-count", itemId: "filament-petg", type: "count", quantity: 2, unit: "gram", actor: "a", source: "mcp", createdAt: date, itemVersion: 2 },
      { id: "event-correction", itemId: "filament-petg", type: "correction", quantity: 3, unit: "gram", actor: "a", source: "mcp", createdAt: date, itemVersion: 3 },
      { id: "event-allocate", itemId: "filament-petg", type: "allocate", quantity: 4, unit: "gram", actor: "a", source: "mcp", createdAt: date, itemVersion: 4 },
      { id: "event-consume", itemId: "filament-petg", type: "consume", quantity: 5, unit: "gram", actor: "a", source: "mcp", createdAt: date, itemVersion: 5 },
      { id: "event-dispose", itemId: "filament-petg", type: "dispose", quantity: 6, unit: "gram", actor: "a", source: "mcp", createdAt: date, itemVersion: 6 },
      { id: "event-loss", itemId: "filament-petg", type: "loss", quantity: 7, unit: "gram", actor: "a", source: "mcp", createdAt: date, itemVersion: 7 },
      { id: "event-return", itemId: "filament-petg", type: "return", quantity: 8, unit: "gram", actor: "a", source: "mcp", createdAt: date, itemVersion: 8 },
    ], limit: 50 })),
    listProjects: vi.fn(async () => ({ data: [apiProject()], limit: 25, nextCursor: "next" })),
    getProject: vi.fn(async () => apiProject()),
    createProject: vi.fn(async (input: unknown) => mutation(apiProject({ ...(input as object), id: "created-project" }), "created-project", 1)),
    createProjectWithInitialRevision: vi.fn(async (input: any) => mutation({ project: apiProject({ id: input.project?.id ?? "created-project", currentRevisionId: "created-revision" }), revision: apiRevision({ id: input.revision?.id ?? "created-revision" }) }, "created-project", 1)),
    updateProject: vi.fn(async (id: string, input: unknown) => mutation(apiProject({ ...(input as object), id, version: 3 }), id, 3)),
    archiveProject: vi.fn(async (id: string) => mutation(apiProject({ id, status: "archived", version: 3 }), id, 3)),
    createWorkItem: vi.fn(async (projectId: string, input: unknown) => mutation({ id: "work-1", projectId, ...(input as object), version: 1 }, "work-1", 1)),
    getWorkItem: vi.fn(async () => ({ id: "work-1", projectId: "project-1", name: "Base", kind: "part", description: "base", currentRevisionId: "work-revision-1", createdAt: date, updatedAt: date, version: 1 })),
    createProjectRevision: vi.fn(async (projectId: string, input: unknown) => mutation(apiRevision({ id: "revision-2", projectId, ...(input as object), status: "concept" }), "revision-2", 1)),
    getProjectRevision: vi.fn(async () => apiRevision()),
    createWorkItemRevision: vi.fn(async (workItemId: string, input: unknown) => mutation({ ...apiRevision({ id: "work-revision-1", workItemId }), ...(input as object) }, "work-revision-1", 1)),
    getWorkItemRevision: vi.fn(async () => ({ ...apiRevision({ id: "work-revision-1", workItemId: "work-1" }) })),
    listWorkItems: vi.fn(async () => [{ id: "work-1", projectId: "project-1", name: "Base", kind: "part" }]),
    getBomLine: vi.fn(async () => apiLine()),
    listBomLines: vi.fn(async () => [apiLine()]),
    createBomLine: vi.fn(async (_revisionId: string, input: unknown) => mutation(apiLine({ ...(input as object), id: "bom-created" }), "bom-created", 1)),
    updateBomLine: vi.fn(async (id: string, input: unknown) => mutation(apiLine({ ...(input as object), id, version: 2 }), id, 2)),
    retireBomLine: vi.fn(async (id: string) => mutation(apiLine({ id, version: 2 }), id, 2)),
    restoreBomLine: vi.fn(async (id: string) => mutation(apiLine({ id, version: 3 }), id, 3)),
    evaluateBomGaps: vi.fn(async () => ({ revisionId: "revision-1", lines: [{ lineId: "bom-1", name: "M3 screw", optional: false, status: "supplied", requiredQuantity: 4, suppliedQuantity: 4, inspectQuantity: 0, missingQuantity: 0, unit: "each", matchedItemIds: ["screw-m3"], reasons: ["confirmed"], alternatives: [], candidates: [{ itemId: "screw-m3", relationship: "exact", compatibility: "confirmed", availableQuantity: 4, suppliedQuantity: 4, inspectQuantity: 0, reason: "confirmed" }] }], totals: { requiredLines: 1, suppliedLines: 1, inspectFirstLines: 0, partialLines: 0, missingLines: 0, optionalLines: 0 } })),
    createReservation: vi.fn(async (_revisionId: string, input: unknown) => mutation(apiReservation({ ...(input as object) }), "reservation-1", 1)),
    releaseReservation: vi.fn(async (id: string) => mutation(apiReservation({ id, status: "released", version: 2 }), id, 2)),
    listReservations: vi.fn(async () => [apiReservation()]),
    getReservationDetails: vi.fn(async () => ({ reservation: apiReservation(), projectId: "project-1", projectRevisionId: "revision-1", bomLine: apiLine() })),
    recordUsage: vi.fn(async (input: any) => mutation({ event: { id: "usage-1" }, item: apiItem({ id: input.itemId, availableQuantity: 898, version: 3 }) }, input.itemId, 3)),
    listArtifacts: vi.fn(async () => [
      apiArtifact({ role: "brief" }), apiArtifact({ id: "artifact-design", role: "design_record" }), apiArtifact({ id: "artifact-cad", role: "cad_source" }), apiArtifact({ id: "artifact-3mf", role: "three_mf" }), apiArtifact({ id: "artifact-other", role: "other", currentCandidate: false }),
    ]),
    getArtifact: vi.fn(async () => apiArtifact()),
    beginArtifactUpload: vi.fn(async () => mutation({ id: "upload-1", artifactId: "artifact-1", expiresAt: "2026-08-30T10:15:00.000Z", maxBytes: 1000, uploadUrl: "/uploads/upload-1", status: "pending" }, "upload-1", 1)),
    finalizeArtifactUpload: vi.fn(async () => mutation(apiArtifact({ id: "artifact-final" }), "artifact-final", 2)),
    retireArtifact: vi.fn(async (id: string) => mutation(apiArtifact({ id, retired: true, currentCandidate: false, version: 2 }), id, 2)),
    getUploadSessionDetails: vi.fn(async () => ({ session: { id: "upload-1", artifactId: "artifact-1", expiresAt: "2026-08-30T10:15:00.000Z", maxBytes: 1000, uploadUrl: "/uploads/upload-1", status: "pending" }, projectId: "project-1", revisionId: "revision-1" })),
    listOffers: vi.fn(async () => ({ data: [apiOffer(), apiOffer({ id: "offer-2", supplier: "Mouser", name: "ESP32 board", notes: undefined, packageQuantity: undefined, shippingMinor: undefined })], limit: 200 })),
    createOffer: vi.fn(async (input: unknown) => mutation(apiOffer({ ...(input as object), id: "offer-created" }), "offer-created", 1)),
  };
  return service as ApplicationService & Record<string, any>;
}

const transferProvider = {
  issueUpload: vi.fn(() => ({ uploadUrl: "https://maker.example/api/v1/transfers/uploads/upload-1", uploadHeaders: { "x-bench-transfer-token": "upload" }, finalizeUrl: "https://maker.example/api/v1/transfers/uploads/upload-1/finalize", finalizeHeaders: { "x-bench-transfer-token": "finalize" }, expiresAt: "2026-08-30T10:15:00.000Z" })),
  issueDownload: vi.fn(() => ({ downloadUrl: "https://maker.example/api/v1/transfers/artifacts/artifact-1/download", requiredHeaders: { "x-bench-transfer-token": "download" }, expiresAt: "2026-08-30T10:15:00.000Z" })),
};

describe("createApplicationBackend translation coverage", () => {
  it("maps inventory filters, evidence states, dimensions, links, and stock history", async () => {
    const service = serviceFixture();
    service.listInventory.mockResolvedValue({ data: [
      apiItem(),
      apiItem({ id: "commissioned-printer", kind: "printer", evidence: { state: "commissioned", source: "setup", observedAt: date }, availableQuantity: 1, condition: "new" }),
      apiItem({ id: "delivered", evidence: { state: "delivered_uncounted", source: "email", observedAt: date }, condition: "worn" }),
      apiItem({ id: "ordered", evidence: { state: "ordered_unverified", source: "email", observedAt: date }, condition: "needs_repair" }),
      apiItem({ id: "allocated", evidence: { state: "allocated", source: "reservation", observedAt: date }, condition: "unknown" }),
      apiItem({ id: "consumed", evidence: { state: "consumed", source: "usage", observedAt: date }, availableQuantity: 0 }),
      apiItem({ id: "unknown", evidence: { state: "unknown", source: "legacy", observedAt: undefined }, availableQuantity: 2, dimensions: undefined, links: [] }),
    ], limit: 200 });
    const backend = createApplicationBackend(service);
    const filtered = await backend.inventory.list({ limit: 2, query: "petg", category: "electronics", availability: "ordered_unverified", location: "filament cabinet" }, context);
    expect(service.listInventory).toHaveBeenCalledWith(expect.objectContaining({ q: "petg", kind: "electronic", limit: 200 }));
    expect(filtered.items).toEqual([expect.objectContaining({ id: "ordered", availability: "ordered_unverified" })]);
    expect(filtered.nextCursor).toBeNull();
    service.listInventory.mockResolvedValueOnce({ data: [
      apiItem(),
      apiItem({ id: "commissioned-printer", kind: "printer", evidence: { state: "commissioned", source: "setup", observedAt: date }, availableQuantity: 1, condition: "new" }),
      apiItem({ id: "delivered", evidence: { state: "delivered_uncounted", source: "email", observedAt: date }, condition: "worn" }),
      apiItem({ id: "ordered", evidence: { state: "ordered_unverified", source: "email", observedAt: date }, condition: "needs_repair" }),
      apiItem({ id: "allocated", evidence: { state: "allocated", source: "reservation", observedAt: date }, condition: "unknown" }),
      apiItem({ id: "consumed", evidence: { state: "consumed", source: "usage", observedAt: date }, availableQuantity: 0 }),
      apiItem({ id: "unknown", evidence: { state: "unknown", source: "legacy", observedAt: undefined }, availableQuantity: 2, dimensions: undefined, links: [] }),
    ], limit: 200 });
    const summary = await backend.inventory.summary({ limit: 50 }, context);
    expect(summary.counts).toEqual({ totalItems: 7, confirmedItems: 0, confirmedEvidenceItems: 2, availableConfirmedItems: 2, inspectFirstItems: 1, allocatedItems: 3, allocatedQuantities: [{ unit: "gram", value: 1099 }], depletedItems: 1, unverifiedItems: 2, retiredItems: 0, missingItems: 0 });
    const created = await backend.inventory.create({ name: "wire", category: "electronics", quantity: { value: 2, unit: "piece" }, evidence: { state: "delivery", source: "email", recordedAt: date }, dimensions: { length: 1, unit: "metre", source: "manufacturer", uncertainty: 0.01 }, condition: "opened", links: [{ label: "Shop", url: "https://shop.example/wire" }] }, context);
    expect(service.createInventoryItem).toHaveBeenCalledWith(expect.objectContaining({ kind: "electronic", unit: "each", evidence: expect.objectContaining({ state: "delivered_uncounted" }), dimensions: expect.objectContaining({ lengthMm: 1000, measured: false, uncertaintyMm: 10 }), condition: "worn" }), expect.objectContaining({ actor: context.actorId, source: "mcp", correlationId: context.correlationId, idempotencyKey: context.idempotencyKey, fingerprint: context.fingerprint }));
    expect(created.item).toMatchObject({ category: "electronic" });
    await backend.inventory.update({ itemId: "filament-petg", expectedVersion: 2, category: "printer_part", dimensions: { diameter: 0.4, unit: "millimetre", source: "measured" } }, context);
    expect(service.updateInventoryItem).toHaveBeenCalledWith("filament-petg", expect.objectContaining({ kind: "accessory", dimensions: { diameterMm: 0.4, measured: true } }), 2, expect.anything());
    const events = await backend.inventory.listStockEvents({ itemId: "filament-petg", limit: 20 }, context);
    expect(events.items.map((event) => event.kind)).toEqual(["receipt", "count_correction", "count_correction", "allocation", "use", "disposal", "loss", "return"]);
  });

  it("distinguishes fully allocated confirmed stock from genuinely depleted stock", async () => {
    const service = serviceFixture();
    service.listInventory.mockResolvedValueOnce({ data: [
      apiItem({ id: "fully-allocated", quantity: 5, availableQuantity: 0, allocatedQuantity: 5, evidence: { state: "physically_counted", source: "count", observedAt: date } }),
      apiItem({ id: "partially-allocated", quantity: 5, availableQuantity: 2, allocatedQuantity: 3, evidence: { state: "physically_counted", source: "count", observedAt: date } }),
      apiItem({ id: "depleted", quantity: 0, availableQuantity: 0, allocatedQuantity: 0, evidence: { state: "physically_counted", source: "count", observedAt: date } }),
    ], limit: 25 });
    const backend = createApplicationBackend(service);

    const result = await backend.inventory.list({ limit: 25 }, context);

    expect(result.items).toEqual([
      expect.objectContaining({ id: "fully-allocated", availability: "allocated", quantity: { value: 5, unit: "gram" }, availableQuantity: { value: 0, unit: "gram" }, allocatedQuantity: { value: 5, unit: "gram" } }),
      expect.objectContaining({ id: "partially-allocated", availability: "allocated", availableQuantity: { value: 2, unit: "gram" }, allocatedQuantity: { value: 3, unit: "gram" } }),
      expect.objectContaining({ id: "depleted", availability: "depleted", quantity: { value: 0, unit: "gram" }, allocatedQuantity: { value: 0, unit: "gram" } }),
    ]);

    service.listInventory.mockResolvedValueOnce({ data: [
      apiItem({ id: "fully-allocated", quantity: 5, availableQuantity: 0, allocatedQuantity: 5, evidence: { state: "physically_counted", source: "count", observedAt: date } }),
      apiItem({ id: "partially-allocated", quantity: 5, availableQuantity: 2, allocatedQuantity: 3, evidence: { state: "physically_counted", source: "count", observedAt: date } }),
      apiItem({ id: "depleted", quantity: 0, availableQuantity: 0, allocatedQuantity: 0, evidence: { state: "physically_counted", source: "count", observedAt: date } }),
      apiItem({ id: "commissioned", kind: "printer", quantity: 1, availableQuantity: 1, allocatedQuantity: 0, evidence: { state: "commissioned", source: "setup", observedAt: date } }),
    ], limit: 200 });
    await expect(backend.inventory.list({ availability: "allocated", limit: 25 }, context)).resolves.toMatchObject({
      items: [
        expect.objectContaining({ id: "fully-allocated", availability: "allocated" }),
        expect.objectContaining({ id: "partially-allocated", availability: "allocated", availableQuantity: { value: 2, unit: "gram" } }),
      ],
    });
    expect(service.listInventory).toHaveBeenLastCalledWith({ limit: 200 });
  });

  it("keeps retired inventory distinct from current stock states", async () => {
    const service = serviceFixture();
    service.listInventory.mockResolvedValue({ data: [
      apiItem({ id: "retired-item", retiredAt: "2026-08-31T09:00:00.000Z", quantity: 4, availableQuantity: 0, allocatedQuantity: 4 }),
    ], limit: 25 });
    const backend = createApplicationBackend(service);

    await expect(backend.inventory.list({ availability: "retired", limit: 25 }, context)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "retired-item", availability: "retired" })],
    });
    expect(service.listInventory).toHaveBeenLastCalledWith({ limit: 200, includeRetired: true });
    await expect(backend.inventory.summary({ limit: 25 }, context)).resolves.toMatchObject({
      counts: { totalItems: 1, confirmedItems: 0, confirmedEvidenceItems: 1, availableConfirmedItems: 0, inspectFirstItems: 0, allocatedItems: 0, allocatedQuantities: [], depletedItems: 0, unverifiedItems: 0, retiredItems: 1, missingItems: 0 },
    });
  });

  it("exhausts inventory pages before calculating summary totals", async () => {
    const service = serviceFixture();
    const items = Array.from({ length: 53 }, (_, index) => apiItem({
      id: `inventory-${index}`,
      name: `Inventory item ${index}`,
      kind: index % 2 === 0 ? "filament" : "electronic",
      availableQuantity: index < 40 ? 1 : 0,
      evidence: index < 40
        ? { state: "physically_counted", source: "physical-count", observedAt: date }
        : { state: "unknown", source: "legacy-import", observedAt: date },
    }));
    service.listInventory.mockImplementation(async ({ cursor }: { cursor?: string }) => cursor === undefined
      ? { data: items.slice(0, 50), limit: 50, nextCursor: "50" }
      : { data: items.slice(50), limit: 50 });

    const backend = createApplicationBackend(service);
    const summary = await backend.inventory.summary({ limit: 50 }, context);

    expect(summary.counts).toEqual({ totalItems: 53, confirmedItems: 0, confirmedEvidenceItems: 40, availableConfirmedItems: 40, inspectFirstItems: 13, allocatedItems: 40, allocatedQuantities: [{ unit: "gram", value: 39960 }], depletedItems: 0, unverifiedItems: 0, retiredItems: 0, missingItems: 0 });
    expect(summary.categories).toEqual([
      { category: "filament", itemCount: 27 },
      { category: "electronic", itemCount: 26 },
    ]);
    expect(service.listInventory).toHaveBeenNthCalledWith(1, { limit: 50, includeRetired: true });
    expect(service.listInventory).toHaveBeenNthCalledWith(2, { limit: 50, includeRetired: true, cursor: "50" });
  });

  it("fails closed when an inventory summary cursor repeats", async () => {
    const service = serviceFixture();
    service.listInventory.mockImplementation(async ({ cursor }: { cursor?: string }) => ({ data: [apiItem()], limit: 1, nextCursor: cursor ?? "0" }));
    const backend = createApplicationBackend(service);

    await expect(backend.inventory.summary({ limit: 1 }, context)).rejects.toMatchObject({ code: "BACKEND_ERROR" });
    expect(service.listInventory).toHaveBeenCalledTimes(2);
  });

  it("continues location-filtered inventory across bounded application pages", async () => {
    const service = serviceFixture();
    const items = Array.from({ length: 205 }, (_, index) => apiItem({
      id: `inventory-${index}`,
      location: index >= 200 ? "late cabinet" : "other cabinet",
    }));
    service.listInventory.mockImplementation(async ({ cursor }: { cursor?: string }) => cursor === undefined
      ? { data: items.slice(0, 200), limit: 200, nextCursor: "200" }
      : cursor === "200"
        ? { data: items.slice(200), limit: 200 }
        : { data: [], limit: 200 });

    const backend = createApplicationBackend(service);
    const first = await backend.inventory.list({ location: "late cabinet", limit: 2 }, context);
    expect(first.items.map((item) => item.id)).toEqual(["inventory-200", "inventory-201"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await backend.inventory.list({ location: "late cabinet", limit: 2, cursor: first.nextCursor! }, context);
    expect(second.items.map((item) => item.id)).toEqual(["inventory-202", "inventory-203"]);
    expect(second.nextCursor).not.toBeNull();
    const final = await backend.inventory.list({ location: "late cabinet", limit: 2, cursor: second.nextCursor! }, context);
    expect(final.items.map((item) => item.id)).toEqual(["inventory-204"]);
    expect(final.nextCursor).toBeNull();
    expect(service.listInventory).toHaveBeenNthCalledWith(1, { limit: 200 });
    expect(service.listInventory).toHaveBeenNthCalledWith(2, { limit: 200, cursor: "200" });
    expect(service.listInventory).toHaveBeenNthCalledWith(3, { limit: 200, cursor: "200" });
    expect(service.listInventory).toHaveBeenNthCalledWith(4, { limit: 200, cursor: "200" });
  });

  it("rejects malformed and stalled filtered inventory cursors", async () => {
    const service = serviceFixture();
    service.listInventory.mockImplementation(async ({ cursor }: { cursor?: string }) => ({
      data: [apiItem({ location: "late cabinet" })],
      limit: 200,
      nextCursor: cursor ?? "0",
    }));
    const backend = createApplicationBackend(service);

    await expect(backend.inventory.list({ location: "late cabinet", cursor: "not-a-filtered-cursor" }, context)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const first = await backend.inventory.list({ location: "late cabinet", limit: 1 }, context);
    await expect(backend.inventory.list({ location: "late cabinet", limit: 1, cursor: first.nextCursor! }, context)).rejects.toMatchObject({ code: "BACKEND_ERROR" });
  });

  it("accepts long filtered inventory and offer cursors emitted by the application backend", async () => {
    const service = serviceFixture();
    const sourceCursor = "s".repeat(200);
    service.listInventory.mockImplementation(async ({ cursor }: { cursor?: string }) => cursor === undefined
      ? { data: [apiItem({ id: "inventory-first", location: "late cabinet" })], limit: 200, nextCursor: sourceCursor }
      : { data: [apiItem({ id: "inventory-second", location: "late cabinet" })], limit: 200 });
    service.listOffers.mockImplementation(async (_itemId: string | undefined, _limit: number, cursor?: string) => cursor === undefined
      ? { data: [apiOffer({ id: "offer-first", supplier: "Late supplier" })], limit: 200, nextCursor: sourceCursor }
      : { data: [apiOffer({ id: "offer-second", supplier: "Late supplier" })], limit: 200 });

    const adapter = new McpAdapter(createApplicationBackend(service));
    const firstInventory = await adapter.callTool("list_inventory", { location: "late cabinet", limit: 1 }, context);
    expect(firstInventory.isError).toBe(false);
    const inventoryCursor = (firstInventory.structuredContent as { nextCursor: string }).nextCursor;
    expect(inventoryCursor.length).toBeGreaterThan(200);
    await expect(adapter.callTool("list_inventory", { location: "late cabinet", limit: 1, cursor: inventoryCursor }, context)).resolves.toMatchObject({ isError: false, structuredContent: { items: [{ id: "inventory-second" }], nextCursor: null, hasMore: false } });

    const firstOffers = await adapter.callTool("list_offers", { query: "late", limit: 1 }, context);
    expect(firstOffers.isError).toBe(false);
    const offerCursor = (firstOffers.structuredContent as { nextCursor: string }).nextCursor;
    expect(offerCursor.length).toBeGreaterThan(200);
    await expect(adapter.callTool("list_offers", { query: "late", limit: 1, cursor: offerCursor }, context)).resolves.toMatchObject({ isError: false, structuredContent: { items: [{ id: "offer-second" }], nextCursor: null, hasMore: false } });
  });

  it("preserves candidate-level BOM compatibility and omits ambiguous quantities", async () => {
    const service = serviceFixture();
    service.evaluateBomGaps.mockResolvedValueOnce({
      revisionId: "revision-1",
      lines: [{
        lineId: "bom-1",
        name: "Controller",
        status: "partially_supplied",
        requiredQuantity: 4,
        suppliedQuantity: 2,
        inspectQuantity: 0,
        missingQuantity: 2,
        unit: "each",
        matchedItemIds: ["board-confirmed", "board-conditional", "board-unknown"],
        reasons: ["candidate evidence"],
        alternatives: [
          { itemId: "board-confirmed", compatible: "confirmed", reason: "same pinout" },
          { itemId: "board-conditional", compatible: "conditional", reason: "check voltage" },
          { itemId: "board-unknown", compatible: "unknown", reason: "needs review" },
        ],
        candidates: [
          { itemId: "board-confirmed", relationship: "confirmed_alternative", compatibility: "confirmed", availableQuantity: 2, suppliedQuantity: 2, inspectQuantity: 0, reason: "same pinout" },
          { itemId: "board-conditional", relationship: "uncertain_alternative", compatibility: "conditional", availableQuantity: 1, suppliedQuantity: 0, inspectQuantity: 0, reason: "check voltage" },
          { itemId: "board-unknown", relationship: "uncertain_alternative", compatibility: "unknown", availableQuantity: 0, suppliedQuantity: 0, inspectQuantity: 0, reason: "needs review" },
        ],
      }],
      totals: { requiredLines: 1, suppliedLines: 0, inspectFirstLines: 0, partialLines: 1, missingLines: 0, optionalLines: 0 },
    });

    const backend = createApplicationBackend(service);
    const evaluation = await backend.bom.evaluate({ projectRevisionId: "revision-1" }, context);
    const matches = evaluation.lines[0]!.matches;

    expect(matches).toEqual([
      { itemId: "board-confirmed", availableQuantity: { value: 2, unit: "piece" }, suppliedQuantity: { value: 2, unit: "piece" }, inspectQuantity: { value: 0, unit: "piece" }, quantity: { value: 2, unit: "piece" }, availability: "confirmed", compatible: "confirmed", reason: "same pinout" },
      { itemId: "board-conditional", availableQuantity: { value: 1, unit: "piece" }, suppliedQuantity: { value: 0, unit: "piece" }, inspectQuantity: { value: 0, unit: "piece" }, availability: "inspect_first", compatible: "conditional", reason: "check voltage" },
      { itemId: "board-unknown", availableQuantity: { value: 0, unit: "piece" }, suppliedQuantity: { value: 0, unit: "piece" }, inspectQuantity: { value: 0, unit: "piece" }, availability: "depleted", compatible: "unknown", reason: "needs review" },
    ]);
    expect(matches[0]?.quantity).toEqual({ value: 2, unit: "piece" });
    expect(matches[1]?.quantity).toBeUndefined();
    expect(matches[2]?.quantity).toBeUndefined();
  });

  it("does not attribute an aggregate supplied status to every unmatched candidate", async () => {
    const service = serviceFixture();
    service.evaluateBomGaps.mockResolvedValueOnce({
      revisionId: "revision-1",
      lines: [{
        lineId: "bom-1",
        name: "Controller",
        status: "supplied",
        requiredQuantity: 1,
        suppliedQuantity: 1,
        inspectQuantity: 0,
        missingQuantity: 0,
        unit: "each",
        matchedItemIds: ["board-a", "board-b"],
        reasons: ["aggregate application result"],
        alternatives: [],
        candidates: [
          { itemId: "board-a", relationship: "constraint_match", compatibility: "unknown", availableQuantity: 0, suppliedQuantity: 0, inspectQuantity: 0, reason: "No explicit compatibility decision." },
          { itemId: "board-b", relationship: "constraint_match", compatibility: "unknown", availableQuantity: 0, suppliedQuantity: 0, inspectQuantity: 0, reason: "No explicit compatibility decision." },
        ],
      }],
      totals: { requiredLines: 1, suppliedLines: 1, inspectFirstLines: 0, partialLines: 0, missingLines: 0, optionalLines: 0 },
    });

    const backend = createApplicationBackend(service);
    const matches = (await backend.bom.evaluate({ projectRevisionId: "revision-1" }, context)).lines[0]!.matches;

    expect(matches).toEqual([
      { itemId: "board-a", availableQuantity: { value: 0, unit: "piece" }, suppliedQuantity: { value: 0, unit: "piece" }, inspectQuantity: { value: 0, unit: "piece" }, availability: "depleted", compatible: "unknown", reason: "No explicit compatibility decision." },
      { itemId: "board-b", availableQuantity: { value: 0, unit: "piece" }, suppliedQuantity: { value: 0, unit: "piece" }, inspectQuantity: { value: 0, unit: "piece" }, availability: "depleted", compatible: "unknown", reason: "No explicit compatibility decision." },
    ]);
  });

  it("maps specify-first gaps to Decide and never recommends buying them", async () => {
    const service = serviceFixture();
    service.evaluateBomGaps.mockResolvedValueOnce({
      revisionId: "revision-1",
      lines: [{
        lineId: "bom-power-supply",
        name: "12 V power supply",
        optional: false,
        status: "specify_first",
        decision: "decide",
        missingDecisions: ["current_or_load", "connector"],
        requiredQuantity: 1,
        suppliedQuantity: 0,
        inspectQuantity: 0,
        missingQuantity: 1,
        unit: "each",
        matchedItemIds: [],
        reasons: ["Specify load/current and connector before sourcing."],
        alternatives: [],
        candidates: [],
      }],
      totals: { requiredLines: 1, suppliedLines: 0, inspectFirstLines: 0, partialLines: 0, missingLines: 0, optionalLines: 0, decideLines: 1, sourceLines: 0 },
    });

    const evaluation = await createApplicationBackend(service).bom.evaluate({ projectRevisionId: "revision-1" }, context);

    expect(evaluation.lines[0]).toMatchObject({ state: "specify_first", decision: "decide", recommendedAction: "specify", missingDecisions: ["current_or_load", "connector"] });
    expect(evaluation.totals).toMatchObject({ decide: 1, source: 0 });
  });

  it("preserves the resistor decision vocabulary through MCP evaluation", async () => {
    const service = serviceFixture();
    service.evaluateBomGaps.mockResolvedValueOnce({
      revisionId: "revision-1",
      lines: [{
        lineId: "bom-led-resistor",
        name: "LED resistor",
        optional: false,
        status: "specify_first",
        decision: "decide",
        missingDecisions: ["resistance", "power_rating"],
        requiredQuantity: 1,
        suppliedQuantity: 0,
        inspectQuantity: 0,
        missingQuantity: 1,
        unit: "each",
        matchedItemIds: [],
        reasons: ["Specify resistance and power rating before sourcing."],
        alternatives: [],
        candidates: [],
      }],
      totals: { requiredLines: 1, suppliedLines: 0, inspectFirstLines: 0, partialLines: 0, missingLines: 0, optionalLines: 0, decideLines: 1, sourceLines: 0 },
    });

    const evaluation = await createApplicationBackend(service).bom.evaluate({ projectRevisionId: "revision-1" }, context);

    expect(evaluation.lines[0]).toMatchObject({ state: "specify_first", decision: "decide", recommendedAction: "specify", missingDecisions: ["resistance", "power_rating"] });
    expect(evaluation.totals).toMatchObject({ decide: 1, source: 0 });
  });

  it("maps project, revision, BOM, reservations, usage, and context branches", async () => {
    const service = serviceFixture();
    const backend = createApplicationBackend(service);
    const normalPage = await backend.projects.list({ query: "lamp", status: "validating", limit: 5 }, context);
    expect(service.listProjects).toHaveBeenCalledWith(expect.objectContaining({ q: "lamp", status: "validating", limit: 5 }));
    expect(normalPage.items[0]).toMatchObject({ id: "project-1", status: "building", visibility: "private" });
    const scopedPage = await backend.projects.list({ limit: 1 }, { ...context, projectIds: ["project-1", "missing"] });
    expect(scopedPage.items).toHaveLength(1);
    service.getProject.mockResolvedValueOnce(apiProject({ status: "complete" }));
    expect(await backend.projects.get({ projectId: "project-1" }, context)).toMatchObject({ status: "complete" });
    expect(await backend.projects.create({ name: "Lamp", description: "x" }, context)).toMatchObject({ id: "created-project", project: { visibility: "private" } });
    expect(await backend.projects.createWithInitialRevision({ name: "Lamp", projectId: "fixed", revisionId: "fixed-r", revisionSummary: "Plan" }, context)).toMatchObject({ id: "fixed", revision: { status: "concept" } });
    expect(service.createProjectWithInitialRevision).toHaveBeenCalledWith(expect.objectContaining({ project: expect.objectContaining({ id: "fixed", status: "idea" }), revision: expect.objectContaining({ id: "fixed-r", name: "Plan", notes: "Plan" }) }), expect.anything());
    await backend.projects.update({ projectId: "project-1", expectedVersion: 2, status: "ready", name: "Ready lamp" }, context);
    await backend.projects.retire({ projectId: "project-1", expectedVersion: 3 }, context);
    await backend.projects.createWorkItem({ projectId: "project-1", name: "Base", kind: "part", description: "base" }, context);
    await backend.projects.getWorkItem({ workItemId: "work-1" }, context);
    await backend.projects.createProjectRevision({ projectId: "project-1", summary: "r2" }, context);
    await backend.projects.createWorkItemRevision({ workItemId: "work-1", summary: "fit" }, context);
    for (const status of ["concept", "CAD complete", "DFAM reviewed", "mesh validated", "slicer validated", "test printed", "fit/function verified", "production approved", "unknown"] as const) {
      service.getProjectRevision.mockResolvedValueOnce(apiRevision({ id: `rev-${status}`, status }));
      const revision = await backend.projects.getProjectRevision({ revisionId: `rev-${status}` }, context);
      expect(revision.status).toBe(status === "CAD complete" ? "cad_complete" : status === "DFAM reviewed" ? "dfam_reviewed" : status === "mesh validated" ? "mesh_validated" : status === "slicer validated" ? "slicer_validated" : status === "test printed" ? "test_printed" : status === "fit/function verified" ? "fit_function_verified" : status === "production approved" ? "production_approved" : "concept");
    }
    const richSummary = "Fit review:\nKeep the 0.15 mm clearance and recheck the captive nut after the first test print. 🛠️";
    service.getProjectRevision.mockResolvedValueOnce(apiRevision({ notes: richSummary }));
    await expect(backend.projects.getProjectRevision({ revisionId: "revision-1" }, context)).resolves.toMatchObject({ summary: richSummary });
    service.getProjectRevision.mockResolvedValueOnce(apiRevision({ notes: richSummary }));
    const contextResult = await backend.projects.context({ projectId: "project-1" }, context);
    expect(contextResult.text).toContain("Work items: Base (part)");
    expect(contextResult.text).toContain("Needs attention: 0 required items.");
    expect(contextResult.text).toContain(`Revision summary: ${richSummary}`);
    expect(contextResult).toMatchObject({ status: "building", blocked: { blocked: false, reasons: [] }, currentRevision: { id: "revision-1", summary: richSummary } });
    service.evaluateBomGaps.mockResolvedValueOnce({
      revisionId: "revision-1",
      lines: [
        { lineId: "bom-blocked", name: "M3 inserts", optional: false, status: "missing", decision: "source", requiredQuantity: 4, suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 4, unit: "each", matchedItemIds: [], reasons: ["No confirmed stock covers the remaining quantity.", "Supplier evidence is stale."], alternatives: [], candidates: [] },
        { lineId: "bom-check", name: "Controller", optional: false, status: "inspect_first", decision: "check", requiredQuantity: 1, suppliedQuantity: 0, inspectQuantity: 1, missingQuantity: 0, unit: "each", matchedItemIds: [], reasons: ["Physical count is needed.", "Compatibility needs review."], alternatives: [], candidates: [] },
        { lineId: "bom-decide", name: "Power supply", optional: false, status: "specify_first", decision: "decide", missingDecisions: ["current_or_load", "connector"], requiredQuantity: 1, suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, unit: "each", matchedItemIds: [], reasons: [], alternatives: [], candidates: [] },
        { lineId: "bom-optional", name: "Optional cover", optional: true, status: "missing", decision: "source", requiredQuantity: 1, suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, unit: "each", matchedItemIds: [], reasons: ["Optional only."], alternatives: [], candidates: [] },
      ],
      totals: { requiredLines: 3, suppliedLines: 0, inspectFirstLines: 1, partialLines: 0, missingLines: 1, optionalLines: 1, readyLines: 0, checkLines: 1, decideLines: 1, sourceLines: 1 },
    });
    const blockedContext = await backend.projects.context({ projectId: "project-1" }, context);
    expect(blockedContext.text).toContain("Needs attention: 3 required items (1 Check, 1 Decide, 1 Source).");
    expect(blockedContext.text).not.toContain("Blockers:");
    expect(blockedContext.blocked).toEqual({ blocked: true, reasons: [
      { source: "bom", projectRevisionId: "revision-1", bomLineId: "bom-blocked", decision: "source", reason: "No confirmed stock covers the remaining quantity." },
      { source: "bom", projectRevisionId: "revision-1", bomLineId: "bom-blocked", decision: "source", reason: "Supplier evidence is stale." },
      { source: "bom", projectRevisionId: "revision-1", bomLineId: "bom-check", decision: "check", reason: "Physical count is needed." },
      { source: "bom", projectRevisionId: "revision-1", bomLineId: "bom-check", decision: "check", reason: "Compatibility needs review." },
      { source: "bom", projectRevisionId: "revision-1", bomLineId: "bom-decide", decision: "decide", reason: "Resolve: current_or_load, connector." },
    ] });
    service.getProject.mockResolvedValueOnce(apiProject({ currentRevisionId: undefined }));
    const noRevisionContext = await backend.projects.context({ projectId: "project-1" }, context);
    expect(noRevisionContext.text).toContain("Current revision: not selected");
    expect(noRevisionContext).toMatchObject({ status: "building", blocked: { blocked: false, reasons: [] } });
    const line = await backend.bom.createLine({ projectRevisionId: "revision-1", description: "M3", quantity: 4, unit: "piece", requirement: "optional", compatibleItemIds: ["alt"], constraints: { model: "M3" }, notes: "note" }, context);
    expect(line.line).toMatchObject({ requirement: "optional", description: "M3", compatibleItemIds: ["alt"] });
    const structuredLine = await backend.bom.createLine({ projectRevisionId: "revision-1", description: "Controller", quantity: 1, unit: "piece", alternatives: [{ itemId: "board-alt", compatible: "confirmed", reason: "same pinout" }] }, context);
    expect(structuredLine.line).toMatchObject({ alternatives: [{ itemId: "board-alt", compatible: "confirmed", reason: "same pinout" }], compatibleItemIds: ["board-alt"] });
    expect(service.createBomLine).toHaveBeenCalledWith("revision-1", expect.objectContaining({ alternatives: [{ itemId: "board-alt", compatible: "confirmed", reason: "same pinout" }] }), expect.anything());
    await backend.bom.updateLine({ bomLineId: "bom-1", expectedVersion: 1, description: "M4", unit: "set", requirement: "optional", compatibleItemIds: ["alt"] }, context);
    await backend.bom.retireLine({ bomLineId: "bom-1", expectedVersion: 2 }, context);
    await backend.bom.restoreLine({ bomLineId: "bom-1", expectedVersion: 3 }, context);
    const evaluation = await backend.bom.evaluate({ projectRevisionId: "revision-1" }, context);
    expect(evaluation).toMatchObject({ projectRevisionId: "revision-1", lines: [{ state: "supplied", recommendedAction: "reuse" }], totals: { required: 1, supplied: 1 } });
    const reservation = await backend.bom.reserve({ projectRevisionId: "revision-1", bomLineId: "bom-1", itemId: "screw-m3", quantity: { value: 2, unit: "piece" } }, context);
    expect(reservation).toMatchObject({ projectRevisionId: "revision-1", quantity: { value: 2, unit: "piece" } });
    const released = await backend.bom.release({ reservationId: "reservation-1", expectedVersion: 1 }, context);
    expect(released).toMatchObject({ projectRevisionId: "revision-1", bomLineId: "bom-1", status: "released" });
    const used = await backend.bom.recordUsage({ projectRevisionId: "revision-1", reservationId: "reservation-1", itemId: "screw-m3", quantity: { value: 1, unit: "piece" }, note: "installed" }, context);
    expect(used).toMatchObject({ usageEventId: "usage-1", resultingQuantity: { value: 898, unit: "gram" } });
    expect(service.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", reservationId: "reservation-1", note: "installed", unit: "each" }), expect.anything());
  });

  it("maps structured package conversions across BOM writes and candidate diagnostics", async () => {
    const service = serviceFixture();
    const conversion = {
      inventory: { quantity: 1, unit: "set" as const },
      requirement: { quantity: 10, unit: "piece" as const },
      evidence: { basis: "package_label" as const, observedAt: date, source: "packaging" },
    };
    const backend = createApplicationBackend(service);

    const created = await backend.bom.createLine({
      projectRevisionId: "revision-1",
      description: "Fasteners",
      quantity: 10,
      unit: "piece",
      alternatives: [{ itemId: "fastener-set", compatible: "confirmed", reason: "ten per set", quantityConversion: conversion }],
    }, context);
    expect(service.createBomLine).toHaveBeenCalledWith("revision-1", expect.objectContaining({
      alternatives: [{ itemId: "fastener-set", compatible: "confirmed", reason: "ten per set", quantityConversion: { ...conversion, requirement: { quantity: 10, unit: "each" } } }],
    }), expect.anything());
    expect(created.line).toMatchObject({ alternatives: [{ itemId: "fastener-set", reason: "ten per set", quantityConversion: conversion }] });

    service.evaluateBomGaps.mockResolvedValueOnce({
      revisionId: "revision-1",
      lines: [{
        lineId: "bom-1", name: "Fasteners", optional: false, status: "supplied", decision: "ready",
        requiredQuantity: 10, suppliedQuantity: 10, inspectQuantity: 0, missingQuantity: 0, unit: "each",
        matchedItemIds: ["fastener-set"], reasons: ["converted capacity"],
        alternatives: [{ itemId: "fastener-set", compatible: "confirmed", reason: "ten per set", quantityConversion: { ...conversion, requirement: { quantity: 10, unit: "each" } } }],
        candidates: [{ itemId: "fastener-set", relationship: "confirmed_alternative", compatibility: "confirmed", availableQuantity: 20, suppliedQuantity: 10, inspectQuantity: 0, reason: "ten per set. Capacity: 2 set(s) = 20 each. Allocation: 1 set = 10 each, 0 each overage." }],
      }],
      totals: { requiredLines: 1, suppliedLines: 1, inspectFirstLines: 0, partialLines: 0, missingLines: 0, optionalLines: 0 },
    });
    const evaluation = await backend.bom.evaluate({ projectRevisionId: "revision-1" }, context);
    expect(evaluation.lines[0]?.matches[0]).toMatchObject({
      availableQuantity: { value: 20, unit: "piece" },
      suppliedQuantity: { value: 10, unit: "piece" },
      inspectQuantity: { value: 0, unit: "piece" },
      reason: "ten per set. Capacity: 2 set(s) = 20 each. Allocation: 1 set = 10 each, 0 each overage.",
      quantityConversion: { inventory: { quantity: 1, unit: "set" }, requirement: { quantity: 10, unit: "piece" } },
    });
  });

  it("reads converted reservations in the inventory set unit", async () => {
    const service = serviceFixture();
    service.getInventoryItem.mockResolvedValue(apiItem({ id: "fastener-set", quantity: 2, availableQuantity: 1, unit: "set" }));
    service.listReservations.mockResolvedValue([apiReservation({ itemId: "fastener-set", quantity: 1 })]);
    service.getReservationDetails.mockResolvedValue({
      reservation: apiReservation({ itemId: "fastener-set", quantity: 1 }),
      projectId: "project-1",
      projectRevisionId: "revision-1",
      bomLine: apiLine({ unit: "each", alternatives: [{ itemId: "fastener-set", compatible: "confirmed", reason: "ten per set", quantityConversion: { inventory: { quantity: 1, unit: "set" }, requirement: { quantity: 10, unit: "each" }, evidence: { basis: "package_label", observedAt: date } } }] }),
    });
    const backend = createApplicationBackend(service);
    await expect(backend.bom.getReservation?.({ reservationId: "reservation-1" }, context)).resolves.toMatchObject({ quantity: { value: 1, unit: "set" } });
    const listed = await backend.bom.listReservations?.({ projectRevisionId: "revision-1", limit: 1 }, context);
    expect(listed?.items[0]?.quantity).toEqual({ value: 1, unit: "set" });
  });

  it("deep-maps inspection preview and commit units and conversion evidence at the MCP boundary", async () => {
    const service = serviceFixture() as ApplicationService & Record<string, any>;
    const conversion = {
      inventory: { quantity: 1, unit: "set" as const },
      requirement: { quantity: 10, unit: "each" as const },
      evidence: { basis: "package_label" as const, observedAt: date, source: "package label" },
    };
    const item = apiItem({ id: "fastener-set", kind: "fastener", quantity: 2, availableQuantity: 1, unit: "set" });
    const gap = {
      lineId: "bom-1", name: "M3 screw", optional: false, status: "inspect_first", decision: "check",
      requiredQuantity: 10, suppliedQuantity: 0, inspectQuantity: 10, missingQuantity: 0, unit: "each",
      matchedItemIds: ["fastener-set"], reasons: ["inspect conversion"],
      alternatives: [{ itemId: "fastener-set", compatible: "conditional", reason: "ten per set", quantityConversion: conversion }],
      candidates: [{ itemId: "fastener-set", relationship: "uncertain_alternative", compatibility: "conditional", availableQuantity: 10, suppliedQuantity: 0, inspectQuantity: 10, reason: "inspect conversion" }],
    };
    const line = apiLine({ id: "bom-1", itemId: "fastener-set", requiredQuantity: 10, unit: "each", alternatives: [{ itemId: "fastener-set", compatible: "conditional", reason: "ten per set", quantityConversion: conversion }] });
    const action = {
      id: "inspection-conversion", projectRevisionId: "revision-1", itemId: "fastener-set", itemVersion: 2,
      kind: "unit_conversion", normalizedPredicate: '{"expectedUnit":"each","itemUnit":"set"}',
      question: "Confirm package conversion.", itemUnit: "set", expectedUnit: "each", compatibility: "conditional",
      lineIds: ["bom-1"], lineVersions: [{ lineId: "bom-1", version: 1 }], version: 2,
      candidate: { id: "fastener-set", version: 2, name: "Fastener set", unit: "set", evidence: { state: "delivered_uncounted", source: "package label" } },
      expected: { quantity: 10, unit: "each", lineIds: ["bom-1"], lineRequirements: [{ lineId: "bom-1", quantity: 10, unit: "each" }] },
      possibleResults: ["inconclusive"], effects: [{ kind: "unit_conversion", description: "Records conversion evidence." }],
      basis: { itemVersion: 2, lineVersions: [{ lineId: "bom-1", version: 1 }] }, requiresHumanConfirmation: true,
    };
    const preview = {
      id: "inspection-preview", version: 1, projectRevisionId: "revision-1", actionId: action.id, actor: "coverage-agent",
      createdAt: date, expiresAt: "2026-08-30T10:30:00.000Z", contentSha256: "b".repeat(64), action,
      observation: { result: "inconclusive", source: "package label", observedAt: date, conversion },
      basis: { actionId: action.id, actionVersion: 2, itemVersion: 2, lineVersions: [{ lineId: "bom-1", version: 1 }], hash: "c".repeat(64) },
      before: { item, gaps: [gap], lines: [line] }, after: { item, gaps: [gap], lines: [line] },
      affectedLines: [{ lineId: "bom-1", version: 1, beforeDecision: "check", afterDecision: "check" }],
      reevaluatedGaps: { revisionId: "revision-1", lines: [gap], totals: { checkLines: 1 } }, requiresHumanConfirmation: true,
    };
    const commit = {
      id: "inspection-commit", status: "committed", projectRevisionId: "revision-1", actionId: action.id, previewId: preview.id,
      evidence: { id: "inspection-evidence", projectRevisionId: "revision-1", actionId: action.id, itemId: "fastener-set", kind: "unit_conversion", result: "inconclusive", source: "package label", observedAt: date, recordedAt: date, conversion },
      item, gaps: { revisionId: "revision-1", lines: [gap], totals: { checkLines: 1 } },
      inspections: { revisionId: "revision-1", data: [action], limit: 200, total: 1 }, committedAt: date,
    };
    service.listInspections = vi.fn(async () => ({ data: [action], limit: 25 }));
    service.getInspection = vi.fn(async () => action);
    service.previewInspectionCompletion = vi.fn(async (_revisionId: string, input: any) => {
      expect(input.observation.conversion).toEqual({ ...conversion, requirement: { quantity: 10, unit: "each" } });
      return preview;
    });
    service.commitInspectionCompletion = vi.fn(async () => mutation(commit, "inspection-commit", 2));
    const backend = createApplicationBackend(service);
    const inputConversion = { ...conversion, requirement: { quantity: 10, unit: "piece" as const } };
    const mappedPreview = await backend.inspections!.preview({ projectRevisionId: "revision-1", inspectionId: action.id, observation: { result: "inconclusive", source: "package label", observedAt: date, conversion: inputConversion } }, context);
    expect(mappedPreview.observation.conversion?.requirement).toEqual({ quantity: 10, unit: "piece" });
    expect(mappedPreview.before.item.quantity).toEqual({ value: 2, unit: "set" });
    expect(mappedPreview.before.lines[0]?.unit).toBe("piece");
    expect(mappedPreview.after.lines[0]?.alternatives[0]?.quantityConversion?.requirement.unit).toBe("piece");
    expect(mappedPreview.before.gaps[0]?.unit).toBe("piece");
    expect(mappedPreview.before.gaps[0]?.candidates[0]?.availableQuantity).toEqual({ value: 10, unit: "piece" });
    expect(mappedPreview.before.gaps[0]?.alternatives[0]?.quantityConversion?.requirement.unit).toBe("piece");
    expect(mappedPreview.reevaluatedGaps.lines[0]?.alternatives[0]?.quantityConversion?.requirement.unit).toBe("piece");

    const mappedCommit = await backend.inspections!.commit({ projectRevisionId: "revision-1", inspectionId: action.id, previewId: preview.id, expectedPreviewVersion: 1, contentSha256: preview.contentSha256, confirmed: true }, context);
    expect(mappedCommit.commit.evidence.unit).toBeUndefined();
    expect(mappedCommit.commit.evidence.conversion?.requirement.unit).toBe("piece");
    expect(mappedCommit.commit.item?.quantity).toEqual({ value: 2, unit: "set" });
    expect(mappedCommit.commit.gaps.lines[0]?.unit).toBe("piece");
    expect(mappedCommit.commit.inspections.data[0]?.expected.unit).toBe("piece");
    expect(mappedCommit.commit.inspections.data[0]?.candidate.unit).toBe("set");
  });

  it("maps artifact roles, transfer unavailability, offers, and empty current revisions", async () => {
    const service = serviceFixture();
    const backend = createApplicationBackend(service, { publicBaseUrl: "https://maker.example", artifactTransfer: transferProvider });
    const artifacts = await backend.artifacts.list({ projectId: "project-1", role: "design_record", limit: 10 }, context);
    expect(artifacts.items).toHaveLength(1);
    expect(artifacts.items[0]).toMatchObject({ role: "design_record", status: "candidate", projectRevisionId: "revision-1" });
    service.listArtifacts.mockResolvedValueOnce([
      apiArtifact({ role: "brief", workItemId: "work-1", revisionId: "work-revision-1" }),
      apiArtifact({ id: "artifact-design", role: "design_record", workItemId: "work-1", revisionId: "work-revision-1" }),
      apiArtifact({ id: "artifact-cad", role: "cad_source", workItemId: "work-1", revisionId: "work-revision-1" }),
      apiArtifact({ id: "artifact-3mf", role: "three_mf", workItemId: "work-1", revisionId: "work-revision-1" }),
      apiArtifact({ id: "artifact-other", role: "other", currentCandidate: false, workItemId: "work-1", revisionId: "work-revision-1" }),
    ]);
    const workItemArtifacts = await backend.artifacts.list({ projectId: "project-1", workItemId: "work-1", workItemRevisionId: "work-revision-1", limit: 10 }, context);
    expect(service.listArtifacts).toHaveBeenLastCalledWith("project-1", { workItemId: "work-1", workItemRevisionId: "work-revision-1" });
    expect(workItemArtifacts.items).toHaveLength(5);
    expect(workItemArtifacts.items[0]).toMatchObject({ workItemId: "work-1", workItemRevisionId: "work-revision-1" });
    expect(await backend.artifacts.getMetadata({ artifactId: "artifact-1" }, context)).toMatchObject({ role: "step", byteLength: 100 });
    service.getArtifact.mockResolvedValueOnce(apiArtifact({ role: "brief", revisionId: undefined, currentCandidate: false }));
    expect(await backend.artifacts.getMetadata({ artifactId: "artifact-1" }, context)).toMatchObject({ role: "brief", status: "frozen" });
    service.getArtifact.mockResolvedValueOnce(apiArtifact({ workItemId: "work-1", revisionId: "work-revision-1", retired: true, createdAt: undefined }));
    expect(await backend.artifacts.getMetadata({ artifactId: "artifact-1" }, context)).toMatchObject({ workItemId: "work-1", workItemRevisionId: "work-revision-1", status: "retired" });
    await expect(backend.artifacts.finalizeUpload({ uploadId: "upload-1" }, context)).rejects.toMatchObject({ code: "HOST_TRANSFER_UNAVAILABLE" });
    await expect(backend.artifacts.beginUpload({ projectId: "project-1", projectRevisionId: "revision-1", filename: "part.step", role: "source", mediaType: "model/step", byteLength: 100, sha256: "A".repeat(64) }, context)).rejects.toMatchObject({ code: "HOST_TRANSFER_UNAVAILABLE" });
    await expect(backend.artifacts.downloadMetadata({ artifactId: "artifact-1", revisionId: "revision-1" }, context)).rejects.toMatchObject({ code: "HOST_TRANSFER_UNAVAILABLE" });
    expect(service.beginArtifactUpload).not.toHaveBeenCalled();
    expect(service.getArtifact).toHaveBeenCalledTimes(3);
    expect(await backend.artifacts.retire({ artifactId: "artifact-1", expectedVersion: 1 }, context)).toMatchObject({ artifact: { status: "retired" } });
    const offers = await backend.offers.list({ itemId: "screw-m3", query: "amazon", supplier: "amazon", limit: 1 }, context);
    expect(offers.items).toHaveLength(1);
    expect(offers.items[0]).toMatchObject({ description: "M3 screw pack", packageQuantity: { unit: "piece" }, evidence: { state: "user_reported" } });
    service.listOffers.mockResolvedValueOnce({ data: [apiOffer({ itemId: undefined, notes: undefined, packageQuantity: undefined, shippingMinor: undefined })], limit: 1 });
    const minimalOffer = (await backend.offers.list({ limit: 1 }, context)).items[0]!;
    expect(minimalOffer).not.toHaveProperty("itemId");
    expect(minimalOffer).not.toHaveProperty("packageQuantity");
    expect(minimalOffer).not.toHaveProperty("shippingMinor");
    expect(minimalOffer).not.toHaveProperty("evidence");
    expect(await backend.offers.recordSnapshot({ itemId: "screw-m3", description: "M3", supplier: "Amazon", url: "https://shop.example/m3", packageQuantity: { value: 100, unit: "piece" }, price: { minor: 499, currency: "EUR" }, shippingMinor: 0, observedAt: date }, context)).toMatchObject({ offer: { price: { minor: 499, currency: "EUR" } } });
    await backend.offers.recordSnapshot({ supplier: "Local shop", url: "https://shop.example/part", price: { minor: 250, currency: "EUR" } }, context);
    expect(service.createOffer).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Supplier offer" }), expect.anything());
    expect(await backend.context.refresh({ projectId: "project 1", includeInventory: false, maxAgeSeconds: 0 }, context)).toMatchObject({ projectUris: ["benchledger://projects/project%201/context", "benchledger://projects/project%201/bom", "benchledger://projects/project%201/artifacts"], note: "Inventory summary was not refreshed by request." });
    service.getProject.mockResolvedValueOnce(apiProject({ currentRevisionId: undefined }));
    expect(await backend.bom.listProjectLines({ projectId: "project-1", limit: 5 }, context)).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it("continues offer filters across bounded application pages", async () => {
    const service = serviceFixture();
    const offers = Array.from({ length: 205 }, (_, index) => apiOffer({
      id: `offer-${index}`,
      supplier: index >= 200 ? "Late supplier" : "Other supplier",
      name: index >= 200 ? `Late board ${index}` : `Other board ${index}`,
    }));
    service.listOffers.mockImplementation(async (_itemId: string | undefined, _limit: number, cursor?: string) => {
      const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      const data = offers.slice(offset, offset + 200);
      return { data, limit: 200, ...(offset + data.length < offers.length ? { nextCursor: String(offset + data.length) } : {}) };
    });

    const backend = createApplicationBackend(service);
    const first = await backend.offers.list({ query: "late", limit: 2 }, context);
    expect(first.items.map((offer) => offer.id)).toEqual(["offer-200", "offer-201"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await backend.offers.list({ query: "late", limit: 2, cursor: first.nextCursor! }, context);
    expect(second.items.map((offer) => offer.id)).toEqual(["offer-202", "offer-203"]);
    expect(second.nextCursor).not.toBeNull();
    const final = await backend.offers.list({ query: "late", limit: 2, cursor: second.nextCursor! }, context);
    expect(final.items.map((offer) => offer.id)).toEqual(["offer-204"]);
    expect(final.nextCursor).toBeNull();
    expect(service.listOffers).toHaveBeenNthCalledWith(1, undefined, 200);
    expect(service.listOffers).toHaveBeenNthCalledWith(2, undefined, 200, "200");
    expect(service.listOffers).toHaveBeenNthCalledWith(3, undefined, 200, "200");
    expect(service.listOffers).toHaveBeenNthCalledWith(4, undefined, 200, "200");
  });

  it("fails closed when durable ancestry is missing and maps application not-found", async () => {
    const service = serviceFixture();
    service.getReservationDetails.mockRejectedValueOnce(new ApplicationError("not_found", "missing"));
    const backend = createApplicationBackend(service);
    await expect(backend.projectScope?.projectForReservation?.("missing")).resolves.toBeNull();
    service.getProjectRevision.mockRejectedValueOnce(new ApplicationError("not_found", "missing"));
    await expect(backend.projectScope?.projectForProjectRevision?.("missing")).resolves.toBeNull();
    service.getWorkItemRevision.mockRejectedValueOnce(new ApplicationError("not_found", "missing"));
    await expect(backend.projectScope?.projectForWorkItemRevision?.("missing")).resolves.toBeNull();
    service.getBomLine.mockRejectedValueOnce(new ApplicationError("not_found", "missing"));
    await expect(backend.projectScope?.projectForBomLine?.("missing")).resolves.toBeNull();
    service.getArtifact.mockRejectedValueOnce(new ApplicationError("not_found", "missing"));
    await expect(backend.projectScope?.projectForArtifact?.("missing")).resolves.toBeNull();
    service.getUploadSessionDetails.mockRejectedValueOnce(new ApplicationError("not_found", "missing"));
    await expect(backend.projectScope?.projectForUpload?.("missing")).resolves.toBeNull();
    service.getReservationDetails.mockResolvedValueOnce(null);
    await expect(backend.projectScope?.reservationDetails?.("missing")).resolves.toBeNull();
    await expect(backend.artifacts.beginUpload({ projectId: "project-1", projectRevisionId: "revision-1", filename: "part.step", role: "step", mediaType: "model/step", byteLength: 1, sha256: "a".repeat(64) }, context)).rejects.toMatchObject({ code: "HOST_TRANSFER_UNAVAILABLE" });
    const noTransfer = createApplicationBackend(service);
    await expect(noTransfer.artifacts.downloadMetadata({ artifactId: "artifact-1" }, context)).rejects.toMatchObject({ code: "HOST_TRANSFER_UNAVAILABLE" });
    service.getArtifact.mockResolvedValueOnce(apiArtifact({ revisionId: "other-revision" }));
    await expect(backend.artifacts.getMetadata({ artifactId: "artifact-1", revisionId: "revision-1" }, context)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
