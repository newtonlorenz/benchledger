import { describe, expect, it } from "vitest";
import type { InventoryItem, InventoryCategory, StockEvent, BomLine, Reservation, Project, Offer, Artifact, UploadSession, ProjectRevision, WorkItem, WorkItemRevision, ReconciliationLine, ProjectTombstone, ProjectSetupProposal, ProjectSetupPreview, ProjectSetupCommitResult } from "@benchledger/api-contract";
import { ApplicationError } from "./errors.js";
import { ApplicationService, matchesBomConstraints, unsupportedBomConstraintKeys } from "./service.js";
import { buildReconciliationDocument, type ReconciliationSourceSnapshot } from "./reconciliation.js";
import type { ApplicationPorts, AuditEvent, AuditInput, EventBusEvent, InventoryCategoryPort, InventoryListOptions, Page, RequestContext, StockMutation, UpdateInventoryInput } from "./ports.js";

const context: RequestContext = { actor: "test", source: "api", correlationId: "corr-1", scopes: new Set(["read", "write"]) };
const item = (overrides: Partial<InventoryItem> = {}): InventoryItem => ({
  id: "item-1", name: "PETG", kind: "filament", quantity: 1000, availableQuantity: 1000, unit: "gram",
  tags: [], links: [], evidence: { state: "physically_counted" }, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1, ...overrides
});

function fakePorts(seed = item()): ApplicationPorts {
  const events: EventBusEvent[] = [];
  let inventory = seed;
  let project: Project = { id: "project-1", name: "Lamp", status: "planned", createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1 };
  let auditCount = 0;
  let setupPreview: ProjectSetupPreview | undefined;
  const bom: BomLine[] = [];
  const reservations: Reservation[] = [];
  const audit = async (input: AuditInput): Promise<AuditEvent> => ({ id: `audit-${++auditCount}`, action: input.action, actor: input.actor, source: input.source, correlationId: input.correlationId, entityType: input.entityType, entityId: input.entityId, ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }), ...(input.version === undefined ? {} : { version: input.version }), createdAt: "2026-08-30T00:00:00.000Z" });
  return {
    inventory: {
      listItems: async () => ({ data: [inventory], limit: 200 }),
      getItem: async (id) => id === inventory.id ? inventory : null,
      createItem: async (input) => ({ ...item(), ...input, id: input.id ?? "new-item", tags: [...input.tags], links: [...input.links], availableQuantity: input.evidence.state === "physically_counted" ? input.quantity : 0, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1 }),
      updateItem: async (_id, input: UpdateInventoryInput) => { inventory = { ...inventory, ...input, ...(input.tags ? { tags: [...input.tags] } : {}), ...(input.links ? { links: [...input.links] } : {}), ...(input.dimensions ? { dimensions: input.dimensions } : {}), updatedAt: "2026-08-30T00:00:00.000Z", version: inventory.version + 1 } as InventoryItem; return inventory; },
      bulkUpdateItems: async (input) => {
        const updated = { ...inventory, ...(input.changes.location === undefined ? {} : { location: input.changes.location }), ...(input.changes.condition === undefined ? {} : { condition: input.changes.condition }), updatedAt: "2026-08-30T00:00:00.000Z", version: inventory.version + 1 };
        inventory = updated;
        return { updated: [updated], unchanged: [] };
      },
      recordStockEvent: async (input) => { const event: StockEvent = { ...input, id: "event-1", actor: "test", source: "api", createdAt: "2026-08-30T00:00:00.000Z", itemVersion: inventory.version + 1 }; inventory = { ...inventory, quantity: inventory.quantity + input.quantity, availableQuantity: inventory.availableQuantity + input.quantity, version: inventory.version + 1 }; return { event, item: inventory }; },
      listStockEvents: async () => ({ data: [], limit: 50 })
    },
    projects: {
      listProjects: async () => ({ data: [project], limit: 50 }), getProject: async (id) => id === project.id ? project : null,
      createProject: async (input) => ({ id: input.id ?? "project-2", name: input.name, status: input.status, ...(input.description === undefined ? {} : { description: input.description }), createdAt: project.createdAt, updatedAt: project.updatedAt, version: 1 }), updateProject: async (_id, input) => { project = { ...project, ...input, ...(input.description === undefined ? {} : { description: input.description }), version: project.version + 1 } as Project; return project; },
      createWorkItem: async (_id, input) => ({ id: input.id ?? "work-1", projectId: project.id, name: input.name, kind: input.kind, createdAt: project.createdAt, updatedAt: project.updatedAt, version: 1 }), getWorkItem: async (id) => id === "work-1" ? { id: "work-1", projectId: project.id, name: "Enclosure", kind: "part", createdAt: project.createdAt, updatedAt: project.updatedAt, version: 1 } : null, listWorkItems: async () => [],
      createProjectRevision: async (_id, input) => ({ id: input.id ?? "rev-1", projectId: project.id, number: 1, name: input.name, status: input.status, ...(input.notes ? { notes: input.notes } : {}), createdAt: project.createdAt, version: 1 }), getProjectRevision: async () => ({ id: "rev-1", projectId: project.id, number: 1, name: "r1", status: "concept", createdAt: project.createdAt, version: 1 }),
      createWorkItemRevision: async (_id, input) => ({ id: input.id ?? "wir-1", workItemId: "work-1", projectId: project.id, number: 1, name: input.name, status: input.status, ...(input.notes ? { notes: input.notes } : {}), createdAt: project.createdAt, version: 1 }), getWorkItemRevision: async () => null,
      listBomLines: async (_id, options) => options?.includeRetired === true ? bom : bom.filter((line) => line.retiredAt === undefined), getBomLine: async (id) => bom.find((line) => line.id === id) ?? null, createBomLine: async (_id, input) => { const line = { ...input, id: input.id ?? "bom-1", revisionId: "rev-1", alternatives: input.alternatives ?? [], constraints: input.constraints ?? {}, createdAt: project.createdAt, updatedAt: project.updatedAt, version: 1 }; bom.push(line); return line; }, updateBomLine: async () => bom[0]!, retireBomLine: async (id) => { const index = bom.findIndex((line) => line.id === id); const retired = { ...bom[index]!, retiredAt: "2026-08-30T01:00:00.000Z", updatedAt: "2026-08-30T01:00:00.000Z", version: bom[index]!.version + 1 }; bom[index] = retired; return retired; }, restoreBomLine: async (id) => { const index = bom.findIndex((line) => line.id === id); const { retiredAt: _retiredAt, ...active } = bom[index]!; const restored = { ...active, updatedAt: "2026-08-30T02:00:00.000Z", version: active.version + 1 }; bom[index] = restored; return restored; },
      createReservation: async (_id, input) => { const reservation = { ...input, id: input.id ?? "reservation-1", status: "active" as const, createdAt: project.createdAt, updatedAt: project.updatedAt, version: 1 }; reservations.push(reservation); return reservation; }, releaseReservation: async () => reservations[0]!, listReservations: async () => reservations, getReservationDetails: async (id) => { const reservation = reservations.find((candidate) => candidate.id === id); const line = reservation === undefined ? undefined : bom.find((candidate) => candidate.id === reservation.lineId); return reservation === undefined || line === undefined ? null : { reservation, projectId: project.id, projectRevisionId: line.revisionId, bomLine: line }; },
      recordUsage: async () => { throw new Error("not implemented"); }
    },
    projectSetups: {
      savePreview: async (preview) => { setupPreview = preview; return preview; },
      getPreview: async () => setupPreview ?? null,
      commitPreview: async ({ preview }) => ({
        project: { id: preview.proposal.project.id as string, name: preview.proposal.project.name, status: preview.proposal.project.status, createdAt: preview.createdAt, updatedAt: preview.createdAt, version: 1 },
        revision: { id: preview.proposal.revision.id as string, projectId: preview.proposal.project.id as string, number: 1, name: preview.proposal.revision.name, status: preview.proposal.revision.status, createdAt: preview.createdAt, version: 1 },
        workItems: [], workItemRevisions: [],
        bomLines: preview.proposal.bomLines.map((line) => ({ id: line.id as string, revisionId: preview.proposal.revision.id as string, name: line.name, requiredQuantity: line.requiredQuantity, unit: line.unit, optional: line.optional, ...(line.itemId === undefined ? {} : { itemId: line.itemId }), constraints: line.constraints, alternatives: line.alternatives, createdAt: preview.createdAt, updatedAt: preview.createdAt, version: 1 })),
        reservations: [], auditIds: [], context: { previewId: preview.id, contentSha256: preview.contentSha256 }, gaps: preview.gaps, nextAction: "Review setup"
      } as ProjectSetupCommitResult)
    },
    offers: { listOffers: async () => ({ data: [], limit: 50 }), createOffer: async (input) => ({ ...input, id: input.id ?? "offer-1", observedAt: input.observedAt, currency: input.currency, priceMinor: input.priceMinor, name: input.name, supplier: input.supplier, url: input.url, version: 1 }) as Offer },
    artifacts: {
      listArtifacts: async () => [], getArtifact: async () => null, getUploadSessionDetails: async (id) => id === "session-1" ? { session: { id: "session-1", artifactId: "artifact-1", expiresAt: "2026-08-30T01:00:00.000Z", maxBytes: 1, uploadUrl: "/uploads/session-1", status: "pending" }, projectId: "project-1", revisionId: "rev-1" } : null,
      beginUpload: async (input) => ({ id: "session-1", artifactId: "artifact-1", expiresAt: "2026-08-30T01:00:00.000Z", maxBytes: input.byteSize, uploadUrl: "/uploads/session-1", status: "pending" }) as UploadSession,
      writeUpload: async () => ({ receivedBytes: 0 }), finalizeUpload: async () => ({ id: "artifact-1" } as Artifact), readArtifact: async () => { throw new Error("not implemented"); }, retireArtifact: async () => ({ id: "artifact-1" } as Artifact)
    },
    audit: { append: audit, list: async () => ({ data: [], limit: 50 }) },
    events: { publish: (event) => { events.push(event); }, subscribe: (listener) => { for (const event of events) listener(event); return () => undefined; } },
    idempotency: { get: async () => null, set: async () => undefined },
    unitOfWork: {
      run: async (operation) => operation(),
      transactional: async (operation) => operation(),
      exclusive: async (operation) => operation()
    }
  };
}

const setupProposal = (overrides: Partial<ProjectSetupProposal> = {}): ProjectSetupProposal => ({
  project: { id: "setup-project", name: "Setup project", status: "planned" },
  revision: { id: "setup-revision", name: "Initial", status: "concept" },
  workItems: [],
  bomLines: [{ localRef: "line", id: "setup-line", name: "PETG", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, constraints: {}, alternatives: [] }],
  reservations: [],
  ...overrides
});

const setupCommitInput = (preview: ProjectSetupPreview): { previewId: string; expectedPreviewVersion: number; contentSha256: string; confirmReservations: boolean } => ({
  previewId: preview.id,
  expectedPreviewVersion: preview.version,
  contentSha256: preview.contentSha256,
  confirmReservations: false
});

describe("ApplicationService", () => {
  it("removes a project only with exact-name confirmation and returns released reservation evidence", async () => {
    const ports = fakePorts();
    const tombstone: ProjectTombstone = {
      id: "project-1",
      name: "Lamp",
      removedAt: "2026-09-02T00:00:00.000Z",
      removedBy: "test",
      lastLifecycleStatus: "planned",
      releasedReservationIds: ["reservation-1"],
      version: 2,
    };
    ports.projects.removeProject = async (_id, _expectedVersion, _name, _ctx) => tombstone;
    const service = new ApplicationService(ports);

    await expect(service.removeProject("project-1", 1, "Wrong", context)).rejects.toMatchObject({ code: "conflict" });
    await expect(service.removeProject("project-1", 1, "Lamp", context)).resolves.toMatchObject({ data: { releasedReservationIds: ["reservation-1"], auditId: "audit-1" } });
  });

  it("compensates project removal when its audit cannot commit", async () => {
    const ports = fakePorts();
    let removed = false;
    let rolledBack = false;
    ports.projects.removeProject = async () => {
      removed = true;
      return { id: "project-1", name: "Lamp", removedAt: "2026-09-02T00:00:00.000Z", removedBy: "test", lastLifecycleStatus: "planned", releasedReservationIds: [], version: 2 };
    };
    ports.projects.rollbackProjectRemoval = async () => { removed = false; rolledBack = true; };
    ports.audit.append = async () => { throw new Error("audit unavailable"); };

    await expect(new ApplicationService(ports).removeProject("project-1", 1, "Lamp", context)).rejects.toThrow("audit unavailable");
    expect({ removed, rolledBack }).toEqual({ removed: false, rolledBack: true });
  });

  it("matches every supported BOM constraint and fails closed for unknown or malformed keys", () => {
    const candidate = item({
      kind: "electronic",
      manufacturer: "Maker Co",
      model: "ESP32-S3",
      sku: "DEV-32",
      name: "ESP32 development board",
      tags: ["controller", "WiFi"]
    });

    expect(unsupportedBomConstraintKeys(undefined)).toEqual([]);
    expect(unsupportedBomConstraintKeys({ kind: "electronic", unknown: "value" })).toEqual(["unknown"]);
    expect(matchesBomConstraints(candidate, undefined)).toBe(true);
    expect(matchesBomConstraints(candidate, {
      kind: "electronic",
      manufacturer: "maker co",
      model: "esp32-s3",
      sku: "dev-32",
      tag: "wifi",
      nameIncludes: "DEVELOPMENT"
    })).toBe(true);
    expect(matchesBomConstraints(candidate, { kind: "filament" })).toBe(false);
    expect(matchesBomConstraints(candidate, { manufacturer: "Other Co" })).toBe(false);
    expect(matchesBomConstraints(candidate, { model: "ESP32-C3" })).toBe(false);
    expect(matchesBomConstraints(candidate, { sku: "OTHER" })).toBe(false);
    expect(matchesBomConstraints(candidate, { tag: "missing" })).toBe(false);
    expect(matchesBomConstraints(candidate, { nameIncludes: "filament" })).toBe(false);
    expect(matchesBomConstraints(candidate, { unknown: "value" })).toBe(false);
    expect(matchesBomConstraints(candidate, { kind: 42 } as unknown as Record<string, string>)).toBe(false);
  });

  it("serves inventory reads, not-found responses, and bounded stock-event pages", async () => {
    const ports = fakePorts();
    let inventoryQuery: unknown;
    let stockEventLimit = 0;
    let stockEventCursor: string | undefined;
    ports.inventory.listItems = async (query) => {
      inventoryQuery = query;
      return { data: [item()], limit: query.limit, nextCursor: "next-item" };
    };
    ports.inventory.listStockEvents = async (_id, limit, cursor) => {
      stockEventLimit = limit;
      stockEventCursor = cursor;
      return { data: [], limit, nextCursor: "next-event" };
    };
    const service = new ApplicationService(ports, "test-version");

    expect(service.getVersion()).toBe("test-version");
    await expect(service.listInventory({ q: "PET", kind: "filament", evidence: "physically_counted", available: true, limit: 25, cursor: "0" })).resolves.toMatchObject({ nextCursor: "next-item" });
    expect(inventoryQuery).toEqual({ q: "PET", kind: "filament", evidence: "physically_counted", available: true, limit: 25, cursor: "0" });
    await expect(service.listInventory({ limit: 25, cursor: "-1" })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(service.getInventoryItem("item-1")).resolves.toMatchObject({ id: "item-1" });
    await expect(service.listStockEvents("item-1", 0, "event-cursor")).resolves.toMatchObject({ limit: 1 });
    expect(stockEventLimit).toBe(1);
    expect(stockEventCursor).toBe("event-cursor");
    await expect(service.listStockEvents("item-1", 500)).resolves.toMatchObject({ limit: 200 });
    expect(stockEventLimit).toBe(200);
    await expect(service.listInventory({ limit: 0 })).rejects.toThrow();
    await expect(service.getInventoryItem("missing-item")).rejects.toMatchObject({ code: "not_found" });
    await expect(service.getInventoryItem("bad/id")).rejects.toMatchObject({ code: "validation" });
    await expect(service.listStockEvents("bad/id")).rejects.toMatchObject({ code: "validation" });
  });

  it("audits category CRUD, preserves immutable parentage, and validates inventory assignments", async () => {
    const ports = fakePorts();
    const categories = new Map<string, InventoryCategory>();
    const top: InventoryCategory = { id: "category-tools", name: "Tools", sortOrder: 0, archived: false, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1 };
    categories.set(top.id, top);
    const categoryPort: InventoryCategoryPort = {
      listCategories: async () => ({ data: [...categories.values()], limit: 50 }),
      getCategory: async (id) => categories.get(id) ?? null,
      createCategory: async (input) => {
        const created: InventoryCategory = { id: input.id ?? `category-generated-${categories.size}`, name: input.name, ...(input.parentId === undefined ? {} : { parentId: input.parentId }), sortOrder: input.sortOrder ?? 0, archived: false, createdAt: top.createdAt, updatedAt: top.updatedAt, version: 1 };
        categories.set(created.id, created);
        return created;
      },
      updateCategory: async (id, input, expectedVersion) => {
        const current = categories.get(id)!;
        if (expectedVersion !== undefined && expectedVersion !== current.version) throw new ApplicationError("conflict", "stale category");
        const updated = { ...current, ...(input.name === undefined ? {} : { name: input.name }), ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }), version: current.version + 1 };
        categories.set(id, updated);
        return updated;
      },
      archiveCategory: async (id, expectedVersion) => {
        const current = categories.get(id)!;
        if (expectedVersion !== undefined && expectedVersion !== current.version) throw new ApplicationError("conflict", "stale category");
        const updated = { ...current, archived: true, version: current.version + 1 };
        categories.set(id, updated);
        return updated;
      },
    };
    Object.assign(ports, { inventoryCategories: categoryPort });
    const storedCommands = new Map<string, unknown>();
    Object.assign(ports, {
      idempotency: {
        get: async (_actor: string, key: string) => storedCommands.get(key) ?? null,
        set: async (_actor: string, key: string, value: unknown) => { storedCommands.set(key, value); },
      },
    });
    const service = new ApplicationService(ports);
    const created = await service.createInventoryCategory({ id: "category-child", name: "Printer parts", parentId: top.id, sortOrder: 0 }, context);
    expect(created).toMatchObject({ data: { id: "category-child", parentId: "category-tools" }, audit: { action: "inventory.category.create", entityType: "inventory_category" } });
    const renamed = await service.updateInventoryCategory("category-child", { name: "Parts" }, 1, context);
    expect(renamed.data).toMatchObject({ name: "Parts", parentId: "category-tools", version: 2 });
    await expect(service.updateInventoryCategory("category-child", { name: "Stale" }, 1, context)).rejects.toMatchObject({ code: "conflict" });
    await expect(service.updateInventoryCategory("category-child", { name: "Missing version" }, undefined as unknown as number, context)).rejects.toMatchObject({ code: "validation" });
    await expect(service.archiveInventoryCategory("category-child", undefined as unknown as number, context)).rejects.toMatchObject({ code: "validation" });
    const createdItem = await service.createInventoryItem({ id: "category-item", name: "Hex key", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], categoryNodeId: "category-child", evidence: { state: "physically_counted" } }, context);
    expect(createdItem.data).toMatchObject({ categoryNodeId: "category-child", version: 1 });
    categories.set("category-child", { ...categories.get("category-child")!, archived: true });
    await expect(service.createInventoryItem({ id: "bad-item", name: "Bad", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], categoryNodeId: "category-child", evidence: { state: "unknown" } }, context)).rejects.toMatchObject({ code: "validation" });
    const replayContext = { ...context, idempotencyKey: "category-replay-1" };
    const first = await service.createInventoryItem({ id: "category-replay-item", name: "Replayable tool", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], categoryNodeId: "category-tools", evidence: { state: "unknown" } }, replayContext);
    categories.delete("category-tools");
    const replay = await service.createInventoryItem({ id: "category-replay-item", name: "Replayable tool", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], categoryNodeId: "category-tools", evidence: { state: "unknown" } }, replayContext);
    expect(first.data.id).toBe(replay.data.id);
    expect(replay.replayed).toBe(true);
    const invalidContext = { ...context, idempotencyKey: "category-invalid-1" };
    await expect(service.createInventoryItem({ id: "invalid-category-item", name: "Invalid", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], categoryNodeId: "missing-category", evidence: { state: "unknown" } }, invalidContext)).rejects.toMatchObject({ code: "not_found" });
    expect(storedCommands.has("category-invalid-1")).toBe(false);

    const autoCreateContext = { ...context, idempotencyKey: "category-auto-create" };
    const autoCreated = await service.createInventoryCategory({ name: "Auto category", sortOrder: 100 }, autoCreateContext);
    expect(await service.createInventoryCategory({ name: "Auto category", sortOrder: 100 }, autoCreateContext)).toMatchObject({ replayed: true, data: autoCreated.data });
    await expect(service.createInventoryCategory({ name: "Different auto category", sortOrder: 100 }, autoCreateContext)).rejects.toMatchObject({ code: "idempotency_conflict" });

    const updateContext = { ...context, idempotencyKey: "category-update-fingerprint" };
    const fingerprinted = await service.updateInventoryCategory("category-child", { name: "Fingerprint one" }, 2, updateContext);
    expect(await service.updateInventoryCategory("category-child", { name: "Fingerprint one" }, 2, updateContext)).toMatchObject({ replayed: true, data: fingerprinted.data });
    await expect(service.updateInventoryCategory("category-child", { name: "Fingerprint two" }, 2, updateContext)).rejects.toMatchObject({ code: "idempotency_conflict" });

    const archiveContext = { ...context, idempotencyKey: "category-archive-fingerprint" };
    const archived = await service.archiveInventoryCategory("category-child", 3, archiveContext);
    expect(await service.archiveInventoryCategory("category-child", 3, archiveContext)).toMatchObject({ replayed: true, data: archived.data });
    await expect(service.archiveInventoryCategory("category-child", 4, archiveContext)).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("audits inventory create/update commands and supports both physical-count adapters", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    const created = await service.createInventoryItem({
      id: "board-new",
      name: "ESP32 board",
      kind: "electronic",
      quantity: 4,
      unit: "each",
      tags: ["controller"],
      links: [],
      evidence: { state: "ordered_unverified", source: "order-1" }
    }, context);
    expect(created).toMatchObject({ data: { id: "board-new", availableQuantity: 0 }, audit: { action: "inventory.item.create", entityType: "inventory_item" } });

    const updated = await service.updateInventoryItem("item-1", { name: "PETG HF", tags: ["orange"], dimensions: { measured: true, diameterMm: 1.75 } }, 1, context);
    expect(updated).toMatchObject({ data: { name: "PETG HF", tags: ["orange"] }, audit: { action: "inventory.item.update", version: 2 } });
    await expect(service.updateInventoryItem("bad/id", {}, undefined, context)).rejects.toMatchObject({ code: "validation" });

    const fallbackCount = await service.recordPhysicalCount("item-1", 740, context, "gram", "weighed spool");
    expect(fallbackCount.data.item).toMatchObject({ quantity: 740, evidence: { state: "physically_counted" } });

    let directNote: string | undefined;
    ports.inventory.recordPhysicalCount = async (itemId, quantity, _ctx, note): Promise<StockMutation> => {
      directNote = note;
      return {
        event: { id: "count-direct", itemId, type: "count", quantity, unit: "gram", actor: "test", source: "api", createdAt: "2026-08-30T00:00:00.000Z", itemVersion: 3, ...(note === undefined ? {} : { note }) },
        item: item({ quantity, availableQuantity: quantity, evidence: { state: "physically_counted" }, version: 3 })
      };
    };
    const directCount = await service.recordStockEvent({ itemId: "item-1", type: "count", quantity: 500, unit: "gram", note: "direct adapter" }, context);
    expect(directCount.data.item.quantity).toBe(500);
    expect(directNote).toBe("direct adapter");
    await expect(service.recordPhysicalCount("item-1", -1, context)).rejects.toMatchObject({ code: "validation" });
    await expect(service.recordPhysicalCount("item-1", 1, context, "each")).rejects.toMatchObject({ code: "validation" });
    ports.inventory.getItem = async () => null;
    await expect(service.recordPhysicalCount("item-1", 1, context)).rejects.toMatchObject({ code: "not_found" });
  });

  it("bulk-updates explicit inventory targets with per-item audits and canonical replay", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    const records = new Map<string, unknown>();
    ports.idempotency.get = async (_actor, key) => records.get(key) ?? null;
    ports.idempotency.set = async (_actor, key, value) => { records.set(key, value); };
    const published: EventBusEvent[] = [];
    ports.events.publish = (event) => { published.push(event); };
    const command = {
      targets: [{ itemId: "item-1", expectedVersion: 1 }],
      changes: { location: "  Shelf A  ", tags: { add: ["PETG", "petg"] } },
    };
    const firstContext = { ...context, idempotencyKey: "bulk-metadata-1", fingerprint: "caller-fingerprint-that-must-not-win" };
    const first = await service.bulkUpdateInventoryItems(command, firstContext);
    expect(first).toMatchObject({
      data: { updated: [{ id: "item-1", version: 2 }], unchanged: [] },
      audits: [{ action: "inventory.item.bulk_update", entityId: "item-1", version: 2, idempotencyKey: expect.stringMatching(/^bulk:[a-f0-9]{64}$/) }],
      replayed: false,
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: "inventory.item.bulk_update", entityId: "item-1", version: 2 });

    const replay = await service.bulkUpdateInventoryItems(command, { ...firstContext, fingerprint: "a-different-caller-fingerprint" });
    expect(replay).toMatchObject({ replayed: true, data: first.data, audits: first.audits });
    expect(published).toHaveLength(1);
  });

  it("does not audit or publish when every bulk target is unchanged", async () => {
    const ports = fakePorts();
    ports.inventory.bulkUpdateItems = async () => ({ updated: [], unchanged: [item()] });
    const service = new ApplicationService(ports);
    const command = { targets: [{ itemId: "item-1", expectedVersion: 1 }], changes: { location: "same" } };
    const result = await service.bulkUpdateInventoryItems(command, { ...context, idempotencyKey: "bulk-noop-1" });
    expect(result).toMatchObject({ data: { updated: [], unchanged: [{ id: "item-1" }] }, audits: [], replayed: false });
    expect((ports.audit as { readonly events?: readonly AuditEvent[] }).events ?? []).toHaveLength(0);
  });

  it("bulk-updates unverified inventory without fabricating an allocation", async () => {
    const ports = fakePorts();
    const delivered = item({ quantity: 2, availableQuantity: 0, allocatedQuantity: 0, evidence: { state: "delivered_uncounted" }, version: 2 });
    ports.inventory.bulkUpdateItems = async () => ({ updated: [delivered], unchanged: [] });
    const service = new ApplicationService(ports);

    const result = await service.bulkUpdateInventoryItems({ targets: [{ itemId: delivered.id, expectedVersion: 1 }], changes: { location: "intake" } }, { ...context, idempotencyKey: "bulk-unverified" });

    expect(result.data.updated).toEqual([expect.objectContaining({ id: delivered.id, quantity: 2, availableQuantity: 0, allocatedQuantity: 0, evidence: { state: "delivered_uncounted" } })]);
  });

  it("covers project, work-item, revision, and BOM command/query flows", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    await expect(service.listProjects({ q: "lamp", status: "planned", limit: 10, cursor: "project-cursor" })).resolves.toMatchObject({ data: [{ id: "project-1" }] });
    await expect(service.getProject("project-1")).resolves.toMatchObject({ name: "Lamp" });
    await expect(service.getProject("missing-project")).rejects.toMatchObject({ code: "not_found" });

    const project = await service.createProject({ id: "project-new", name: "Enclosure", description: "A printed enclosure", status: "idea" }, context);
    expect(project).toMatchObject({ data: { id: "project-new", status: "idea" }, audit: { action: "project.create" } });
    const projectUpdate = await service.updateProject("project-1", { status: "building", description: "Updated plan" }, 1, context);
    expect(projectUpdate).toMatchObject({ data: { status: "building" }, audit: { action: "project.update", version: 2 } });

    await expect(service.listWorkItems("project-1")).resolves.toEqual([]);
    await expect(service.getWorkItem("work-1")).resolves.toMatchObject({ id: "work-1" });
    await expect(service.getWorkItem("missing-work")).rejects.toMatchObject({ code: "not_found" });
    const workItem = await service.createWorkItem("project-1", { id: "work-new", name: "Controller housing", kind: "part", description: "Printed shell" }, context);
    expect(workItem).toMatchObject({ data: { id: "work-new", projectId: "project-1" }, audit: { action: "project.work_item.create" } });

    const projectRevision = await service.createProjectRevision("project-1", { id: "revision-new", name: "r02", status: "CAD complete", notes: "First CAD pass" }, context);
    expect(projectRevision).toMatchObject({ data: { id: "revision-new", status: "CAD complete" }, audit: { action: "project.revision.create" } });
    await expect(service.getProjectRevision("rev-1")).resolves.toMatchObject({ id: "rev-1" });
    ports.projects.getProjectRevision = async (id) => id === "rev-1" ? { id: "rev-1", projectId: "project-1", number: 1, name: "r1", status: "concept", createdAt: "2026-08-30T00:00:00.000Z", version: 1 } : null;
    await expect(service.getProjectRevision("missing-revision")).rejects.toMatchObject({ code: "not_found" });

    const workRevision = await service.createWorkItemRevision("work-1", { id: "work-revision-new", name: "r02", status: "DFAM reviewed" }, context);
    expect(workRevision).toMatchObject({ data: { id: "work-revision-new", workItemId: "work-1" }, audit: { action: "project.work_item_revision.create" } });
    const durableWorkRevision: WorkItemRevision = { id: "wir-1", workItemId: "work-1", projectId: "project-1", number: 1, name: "r01", status: "concept", createdAt: "2026-08-30T00:00:00.000Z", version: 1 };
    ports.projects.getWorkItemRevision = async (id) => id === durableWorkRevision.id ? durableWorkRevision : null;
    await expect(service.getWorkItemRevision("wir-1")).resolves.toMatchObject({ id: "wir-1", workItemId: "work-1" });
    await expect(service.getWorkItemRevision("missing-work-revision")).rejects.toMatchObject({ code: "not_found" });

    await expect(service.listBomLines("rev-1")).resolves.toEqual([]);
    const line = await service.createBomLine("rev-1", { id: "bom-flow", name: "M3 screw", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: {}, notes: "Use stainless" }, context);
    expect(line).toMatchObject({ data: { id: "bom-flow", revisionId: "rev-1" }, audit: { action: "project.bom_line.create" } });
    await expect(service.getBomLine("bom-flow")).resolves.toMatchObject({ id: "bom-flow" });
    await expect(service.getBomLine("missing-bom")).rejects.toMatchObject({ code: "not_found" });
    const updatedLine = await service.updateBomLine("bom-flow", { notes: "Updated note", requiredQuantity: 2 }, 1, context);
    expect(updatedLine).toMatchObject({ audit: { action: "project.bom_line.update" } });
    const retiredLine = await service.retireBomLine("bom-flow", 1, context);
    expect(retiredLine).toMatchObject({ data: { retiredAt: "2026-08-30T01:00:00.000Z", notes: "Use stainless", optional: false }, audit: { action: "project.bom_line.retire" } });
    await expect(service.listBomLines("rev-1")).resolves.toEqual([]);
    await expect(service.listBomLines("rev-1", { includeRetired: true })).resolves.toEqual([expect.objectContaining({ id: "bom-flow", retiredAt: "2026-08-30T01:00:00.000Z" })]);
    await expect(service.evaluateBomGaps("rev-1")).resolves.toMatchObject({ lines: [], totals: { suppliedLines: 0, inspectFirstLines: 0, partialLines: 0, missingLines: 0, optionalLines: 0 } });
    const restoredLine = await service.restoreBomLine("bom-flow", 2, context);
    expect(restoredLine).toMatchObject({ data: { id: "bom-flow", notes: "Use stainless", optional: false, version: 3 }, audit: { action: "project.bom_line.restore" } });
    expect(restoredLine.data).not.toHaveProperty("retiredAt");
    await expect(service.listBomLines("rev-1")).resolves.toEqual([expect.objectContaining({ id: "bom-flow" })]);
    await expect(service.listBomLines("bad/id")).rejects.toMatchObject({ code: "validation" });
    await expect(service.createProject({ name: "", status: "idea" }, context)).rejects.toThrow();
  });

  it("blocks ordinary descendant reads when the owning project is removed", async () => {
    const ports = fakePorts();
    const removed: Project = {
      id: "project-1", name: "Lamp", status: "planned", removedAt: "2026-09-02T00:00:00.000Z", removedBy: "test", lastLifecycleStatus: "planned",
      createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", version: 2
    };
    const workRevision: WorkItemRevision = { id: "work-revision-removed", workItemId: "work-1", projectId: "project-1", number: 1, name: "r1", status: "concept", createdAt: removed.createdAt, version: 1 };
    const line: BomLine = { id: "bom-removed", revisionId: "rev-1", name: "part", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: {}, createdAt: removed.createdAt, updatedAt: removed.updatedAt, version: 1 };
    const artifact: Artifact = { id: "artifact-removed", projectId: "project-1", revisionId: "rev-1", role: "step", filename: "part.step", mediaType: "model/step", byteSize: 1, sha256: "a".repeat(64), currentCandidate: true, retired: false, createdAt: removed.createdAt, version: 1 };
    ports.projects.getProject = async () => removed;
    ports.projects.getWorkItemRevision = async (id) => id === workRevision.id ? workRevision : null;
    ports.projects.getBomLine = async (id) => id === line.id ? line : null;
    ports.projects.getReservationDetails = async () => ({ reservation: { id: "reservation-removed", lineId: line.id, itemId: "item-1", quantity: 1, status: "active", createdAt: removed.createdAt, updatedAt: removed.updatedAt, version: 1 }, projectId: "project-1", projectRevisionId: "rev-1", bomLine: line });
    ports.artifacts.getArtifact = async (id) => id === artifact.id ? artifact : null;
    const service = new ApplicationService(ports);

    await expect(service.listWorkItems("project-1")).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.getWorkItem("work-1")).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.getProjectRevision("rev-1")).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.getWorkItemRevision(workRevision.id)).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.listBomLines("rev-1")).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.getBomLine(line.id)).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.listReservations("rev-1")).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.getReservationDetails("reservation-removed")).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.listArtifacts("project-1")).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.getArtifact(artifact.id)).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.readArtifact(artifact.id)).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.getReconciliation("rev-1")).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.evaluateBomGaps("rev-1")).rejects.toMatchObject({ code: "project_removed" });
  });

  it("fails closed when atomic project archiving is unavailable", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    await expect(service.archiveProject("project-1", 1, context)).rejects.toMatchObject({ code: "integrity_error" });
  });

  it("reports optional and partially supplied BOM lines with useful quantities", async () => {
    const ports = fakePorts(item({ quantity: 1, availableQuantity: 1, unit: "each", name: "Small switch" }));
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { id: "bom-partial", name: "Switches", itemId: "item-1", requiredQuantity: 2, unit: "each", optional: false, alternatives: [], constraints: {} }, context);
    await service.createBomLine("rev-1", { id: "bom-optional", name: "Optional knob", requiredQuantity: 1, unit: "each", optional: true, alternatives: [], constraints: { nameIncludes: "not present" } }, context);
    const result = await service.evaluateBomGaps("rev-1");
    expect(result.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineId: "bom-partial", status: "partially_supplied", suppliedQuantity: 1, inspectQuantity: 0, missingQuantity: 1 }),
      expect.objectContaining({ lineId: "bom-optional", status: "optional", suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1 })
    ]));
    expect(result.totals).toEqual({
      requiredLines: 1,
      suppliedLines: 0,
      inspectFirstLines: 0,
      partialLines: 1,
      missingLines: 0,
      optionalLines: 1,
      readyLines: 0,
      checkLines: 0,
      decideLines: 0,
      sourceLines: 1,
    });
  });

  it("returns a concrete specify-first decision for an under-specified power supply", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      id: "bom-power-supply",
      name: "12 V power supply",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [],
      constraints: { specification: { status: "insufficient", decisions: { current_or_load: "5 A" }, missingDecisions: ["voltage"] } },
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({
      status: "specify_first",
      decision: "decide",
      missingDecisions: ["voltage", "connector"],
      suppliedQuantity: 0,
      inspectQuantity: 0,
      missingQuantity: 1,
    });
    expect(result.lines[0]?.reasons.join(" ")).toMatch(/specif|current|connector/i);
    expect(result.totals).toMatchObject({ requiredLines: 1, decideLines: 1, sourceLines: 0, missingLines: 0 });
  });

  it("canonicalizes new LED resistor writes and keeps exact identities behind Decide", async () => {
    const ports = fakePorts(item({ id: "resistor-stock", name: "330 ohm resistor", kind: "electronic", unit: "each", quantity: 1, availableQuantity: 1 }));
    const service = new ApplicationService(ports);
    const created = await service.createBomLine("rev-1", {
      id: "bom-led-resistor",
      name: "LED-current-limiting resistor",
      itemId: "resistor-stock",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [],
      constraints: {},
    }, context);

    expect(created.data.constraints).toMatchObject({ specification: { status: "insufficient", missingDecisions: ["resistance", "power_rating"] } });
    const result = await service.evaluateBomGaps("rev-1");
    expect(result.lines[0]).toMatchObject({
      status: "specify_first",
      decision: "decide",
      missingDecisions: ["resistance", "power_rating"],
      suppliedQuantity: 0,
      inspectQuantity: 0,
      missingQuantity: 1,
    });
    expect(result.totals).toMatchObject({ decideLines: 1, sourceLines: 0 });
  });

  it("lets uncertain LED resistor stock take Check precedence over Decide", async () => {
    const ports = fakePorts(item({ id: "resistor-delivery", name: "LED resistor", kind: "electronic", unit: "each", quantity: 1, availableQuantity: 0, evidence: { state: "delivered_uncounted" } }));
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      id: "bom-led-resistor-check",
      name: "LED resistor",
      itemId: "resistor-delivery",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [],
      constraints: {},
    }, context);

    const result = await service.evaluateBomGaps("rev-1");
    expect(result.lines[0]).toMatchObject({ status: "inspect_first", decision: "check", missingDecisions: ["resistance", "power_rating"] });
    expect(result.totals).toMatchObject({ checkLines: 1, decideLines: 0, sourceLines: 0 });
  });

  it("sources a fully specified resistor only after the specification is complete", async () => {
    const service = new ApplicationService(fakePorts());
    await service.createBomLine("rev-1", {
      id: "bom-led-resistor-source",
      name: "LED resistor",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [],
      constraints: { specification: { status: "sufficient", decisions: { resistance: "330 ohm", power_rating: "0.25 W" } } },
    }, context);

    const result = await service.evaluateBomGaps("rev-1");
    expect(result.lines[0]).toMatchObject({ status: "missing", decision: "source", missingQuantity: 1 });
    expect(result.totals).toMatchObject({ sourceLines: 1, decideLines: 0 });
  });

  it("rejects a sufficient LED resistor claim without both electrical decisions", async () => {
    const service = new ApplicationService(fakePorts());
    await expect(service.createBomLine("rev-1", {
      id: "bom-led-resistor-incomplete",
      name: "LED series resistor",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [],
      constraints: { specification: { status: "sufficient", decisions: { resistance: "330 ohm" } } },
    }, context)).rejects.toMatchObject({ code: "validation" });
  });

  it.each(["LED board", "resistor bracket", "LED board resistor bracket", "resistor bracket for LED", "delivered resistor"])("does not classify unrelated requirement %s as an LED resistor", async (name) => {
    const service = new ApplicationService(fakePorts());
    const created = await service.createBomLine("rev-1", { id: `bom-${name.replaceAll(" ", "-")}`, name, requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context);
    expect(created.data.constraints).toEqual({});
    const result = await service.evaluateBomGaps("rev-1");
    expect(result.lines[0]).toMatchObject({ status: "missing", decision: "source" });
  });

  it("does not allocate confirmed stock while an explicit specification blocker remains", async () => {
    const ports = fakePorts(item({ id: "power-supply", name: "12 V supply", quantity: 1, availableQuantity: 1, unit: "each" }));
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      id: "bom-power-supply-confirmed",
      name: "Power supply",
      itemId: "power-supply",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [],
      constraints: { specification: { status: "insufficient", missingDecisions: ["current_or_load", "connector"] } },
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "specify_first", decision: "decide", suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1 });
    expect(result.lines[0]?.candidates[0]).toMatchObject({ itemId: "power-supply", suppliedQuantity: 0, availableQuantity: 1 });
  });

  it("keeps optional specification blockers separate from required readiness totals", async () => {
    const service = new ApplicationService(fakePorts());
    await service.createBomLine("rev-1", {
      id: "bom-optional-power",
      name: "Optional power supply",
      requiredQuantity: 1,
      unit: "each",
      optional: true,
      alternatives: [],
      constraints: { specification: { status: "insufficient", missingDecisions: ["current_or_load", "connector"] } },
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ optional: true, status: "optional", decision: "decide", missingDecisions: ["current_or_load", "connector"] });
    expect(result.totals).toMatchObject({ requiredLines: 0, optionalLines: 1, decideLines: 0, sourceLines: 0 });
  });

  it.each([
    ["exact item", { itemId: "item-1" }],
    ["SKU", { constraints: { sku: "PSU-12V-5A" } }],
    ["exact model", { constraints: { manufacturer: "Acme", model: "PSU-1205" } }],
  ])("allows a sufficiently identified %s requirement to be sourced when stock is absent", async (_label, identity) => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      name: "Controller",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [],
      ...identity,
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "missing", decision: "source", missingQuantity: 1 });
    expect(result.totals).toMatchObject({ sourceLines: 1, decideLines: 0, missingLines: 1 });
  });

  it("keeps an optional supplied line out of every required total", async () => {
    const ports = fakePorts(item({ quantity: 2, availableQuantity: 2, unit: "each", name: "Optional display" }));
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { id: "bom-optional-supplied", name: "Optional display", itemId: "item-1", requiredQuantity: 1, unit: "each", optional: true, alternatives: [], constraints: {} }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines).toEqual([expect.objectContaining({ lineId: "bom-optional-supplied", optional: true, status: "supplied", suppliedQuantity: 1 })]);
    expect(result.totals).toEqual({ requiredLines: 0, suppliedLines: 0, inspectFirstLines: 0, partialLines: 0, missingLines: 0, optionalLines: 1, readyLines: 0, checkLines: 0, decideLines: 0, sourceLines: 0 });
  });

  it("uses the authoritative allocator for setup preview and commit", async () => {
    const ports = fakePorts(item({ id: "setup-source-item", name: "Setup source", quantity: 2, availableQuantity: 2, unit: "gram" }));
    ports.projects.getProjectRevision = async () => null;
    const service = new ApplicationService(ports);
    const proposal = {
      project: { id: "setup-source-project", name: "Setup source", status: "planned" as const },
      revision: { id: "setup-source-revision", name: "Initial", status: "concept" as const },
      workItems: [],
      bomLines: [{ localRef: "source", id: "setup-source-line", name: "Setup source", itemId: "setup-source-item", requiredQuantity: 1, unit: "gram" as const, optional: false, constraints: {}, alternatives: [] }],
      reservations: []
    };
    const preview = await service.previewProjectSetup(proposal, context);
    expect(preview.gaps.totals).toMatchObject({ requiredLines: 1, suppliedLines: 1, readyLines: 1, checkLines: 0, decideLines: 0, sourceLines: 0, optionalLines: 0 });
    const committed = await service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: false }, { ...context, idempotencyKey: "setup-source-key" });
    expect(committed.data.gaps).toEqual(preview.gaps);
  });

  it("canonicalizes LED resistor specifications in setup preview and durable commit", async () => {
    const ports = fakePorts(item({ id: "setup-resistor", name: "330 ohm resistor", kind: "electronic", unit: "each", quantity: 1, availableQuantity: 1 }));
    ports.projects.getProjectRevision = async () => null;
    const service = new ApplicationService(ports);
    const proposal = setupProposal({
      project: { id: "setup-led-project", name: "LED setup", status: "planned" },
      revision: { id: "setup-led-revision", name: "Initial", status: "concept" },
      bomLines: [{ localRef: "led-line", id: "setup-led-line", name: "LED limiting resistor", itemId: "setup-resistor", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
    });

    const preview = await service.previewProjectSetup(proposal, context);
    expect(preview.proposal.bomLines[0]?.constraints).toMatchObject({ specification: { status: "insufficient", missingDecisions: ["resistance", "power_rating"] } });
    expect(preview.unresolvedSpecifications).toEqual([{ bomLineLocalRef: "led-line", missingDecisions: ["resistance", "power_rating"] }]);

    const committed = await service.commitProjectSetup(setupCommitInput(preview), { ...context, idempotencyKey: "setup-led-key" });
    expect(committed.data.bomLines[0]?.constraints).toMatchObject({ specification: { status: "insufficient", missingDecisions: ["resistance", "power_rating"] } });
  });

  it("enforces workspace scope and runtime guards before previewing setup", async () => {
    const proposal = setupProposal();
    const service = new ApplicationService(fakePorts());
    await expect(service.previewProjectSetup(proposal, { ...context, scopes: new Set() })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.previewProjectSetup(proposal, { ...context, scopes: new Set(["projects:write"]) })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.previewProjectSetup(proposal, { ...context, scopes: new Set(["bom:write"]) })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.previewProjectSetup(proposal, { ...context, projectId: "project-1" })).rejects.toMatchObject({ code: "forbidden" });

    const unavailable = fakePorts();
    Object.assign(unavailable, { projectSetups: undefined });
    await expect(new ApplicationService(unavailable).previewProjectSetup(proposal, context)).rejects.toMatchObject({ code: "integrity_error" });
  });

  it("enforces commit caller scope, workspace ownership, idempotency, and runtime guards", async () => {
    const input = { previewId: "setup-preview", expectedPreviewVersion: 1, contentSha256: "a".repeat(64), confirmReservations: false };
    const service = new ApplicationService(fakePorts());
    await expect(service.commitProjectSetup(input, { ...context, scopes: new Set(), idempotencyKey: "setup-guard-key" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.commitProjectSetup(input, { ...context, scopes: new Set(["projects:write"]), idempotencyKey: "setup-guard-key" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.commitProjectSetup(input, { ...context, scopes: new Set(["bom:write"]), idempotencyKey: "setup-guard-key" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.commitProjectSetup(input, { ...context, projectId: "project-1", idempotencyKey: "setup-guard-key" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.commitProjectSetup(input, context)).rejects.toMatchObject({ code: "validation" });
    await expect(service.commitProjectSetup(input, { ...context, idempotencyKey: "short" })).rejects.toMatchObject({ code: "validation" });
    await expect(service.commitProjectSetup(input, { ...context, idempotencyKey: "x".repeat(201) })).rejects.toMatchObject({ code: "validation" });

    const unavailable = fakePorts();
    Object.assign(unavailable, { projectSetups: undefined });
    await expect(new ApplicationService(unavailable).commitProjectSetup(input, { ...context, idempotencyKey: "setup-guard-key" })).rejects.toMatchObject({ code: "integrity_error" });
  });

  it("rejects setup commits for missing, inactive, expired, stale, or unconfirmed previews", async () => {
    const reservationProposal = setupProposal({
      reservations: [{ localRef: "reservation", bomLineLocalRef: "line", id: "setup-reservation", itemId: "item-1", quantity: 1, unit: "gram" }]
    });
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    const preview = await service.previewProjectSetup(reservationProposal, context);
    const originalGetPreview = ports.projectSetups!.getPreview;
    const commit = (key: string, input = setupCommitInput(preview)) => service.commitProjectSetup(input, { ...context, idempotencyKey: key });

    ports.projectSetups!.getPreview = async () => null;
    await expect(commit("setup-missing-preview")).rejects.toMatchObject({ code: "conflict", details: { reason: "preview_ownership" } });
    ports.projectSetups!.getPreview = async () => ({ ...preview, status: "committed" });
    await expect(commit("setup-committed-preview")).rejects.toMatchObject({ code: "conflict", details: { reason: "already_committed" } });
    ports.projectSetups!.getPreview = async () => ({ ...preview, status: "expired" });
    await expect(commit("setup-inactive-preview")).rejects.toMatchObject({ code: "conflict", details: { reason: "preview_expired" } });
    ports.projectSetups!.getPreview = async () => ({ ...preview, expiresAt: "2020-01-01T00:00:00.000Z" });
    await expect(commit("setup-expired-preview")).rejects.toMatchObject({ code: "conflict", details: { reason: "preview_expired" } });
    ports.projectSetups!.getPreview = originalGetPreview;
    await expect(commit("setup-stale-version", { ...setupCommitInput(preview), expectedPreviewVersion: preview.version + 1 })).rejects.toMatchObject({ code: "conflict", details: { reason: "stale_preview" } });
    await expect(commit("setup-stale-hash", { ...setupCommitInput(preview), contentSha256: "b".repeat(64) })).rejects.toMatchObject({ code: "conflict", details: { reason: "stale_preview" } });
    await expect(commit("setup-unconfirmed-reservations")).rejects.toMatchObject({ code: "validation" });
  });

  it("allocates one shared confirmed item to only one BOM line in stable line-id order", async () => {
    const ports = fakePorts(item({ id: "shared-part", name: "Shared part", kind: "electronic", quantity: 1, availableQuantity: 1, unit: "each" }));
    const line = (id: string): BomLine => ({
      id,
      revisionId: "revision-shared",
      name: `Line ${id}`,
      itemId: "shared-part",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      constraints: {},
      alternatives: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      version: 1
    });
    const lines = [line("bom-b"), line("bom-a")];
    ports.projects.listBomLines = async () => lines;
    ports.projects.listReservations = async () => [];
    const service = new ApplicationService(ports);

    const first = await service.evaluateBomGaps("revision-shared");
    ports.projects.listBomLines = async () => [...lines].reverse();
    const second = await service.evaluateBomGaps("revision-shared");
    const statuses = (result: Awaited<ReturnType<ApplicationService["evaluateBomGaps"]>>) => new Map(result.lines.map((gap) => [gap.lineId, gap]));

    expect(statuses(first).get("bom-a")).toMatchObject({ status: "supplied", suppliedQuantity: 1, missingQuantity: 0 });
    expect(statuses(first).get("bom-b")).toMatchObject({ status: "missing", suppliedQuantity: 0, missingQuantity: 1 });
    expect(statuses(first).get("bom-a")?.candidates).toEqual([expect.objectContaining({ itemId: "shared-part", availableQuantity: 1, suppliedQuantity: 1, inspectQuantity: 0 })]);
    expect(statuses(first).get("bom-b")?.candidates).toEqual([expect.objectContaining({ itemId: "shared-part", availableQuantity: 0, suppliedQuantity: 0, inspectQuantity: 0 })]);
    expect(statuses(second).get("bom-a")).toMatchObject({ status: "supplied", suppliedQuantity: 1, missingQuantity: 0 });
    expect(statuses(second).get("bom-b")).toMatchObject({ status: "missing", suppliedQuantity: 0, missingQuantity: 1 });
  });

  it("restores only a line's own active reservation when allocating shared stock", async () => {
    const ports = fakePorts(item({ id: "reserved-part", name: "Reserved part", kind: "electronic", quantity: 1, availableQuantity: 0, unit: "each" }));
    const line = (id: string): BomLine => ({
      id,
      revisionId: "revision-reserved-shared",
      name: `Line ${id}`,
      itemId: "reserved-part",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      constraints: {},
      alternatives: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      version: 1
    });
    const lines = [line("bom-a"), line("bom-b")];
    ports.projects.listBomLines = async () => [...lines].reverse();
    ports.projects.listReservations = async () => [{
      id: "reservation-b",
      lineId: "bom-b",
      itemId: "reserved-part",
      quantity: 1,
      status: "active",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      version: 1
    }];
    const service = new ApplicationService(ports);

    const result = await service.evaluateBomGaps("revision-reserved-shared");
    const byId = new Map(result.lines.map((gap) => [gap.lineId, gap]));
    expect(byId.get("bom-a")).toMatchObject({ status: "missing", suppliedQuantity: 0, missingQuantity: 1 });
    expect(byId.get("bom-b")).toMatchObject({ status: "supplied", suppliedQuantity: 1, missingQuantity: 0 });
  });

  it("does not let inspect-first candidates consume another line's reservation", async () => {
    const ports = fakePorts(item({ id: "reserved-inspect-part", name: "Reserved inspect part", kind: "electronic", quantity: 1, availableQuantity: 0, unit: "each" }));
    const lines: BomLine[] = [
      {
        id: "bom-inspect-a", revisionId: "revision-reserved-inspect", name: "Possible board", requiredQuantity: 1, unit: "each", optional: false,
        constraints: { kind: "electronic" }, alternatives: [], createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1
      },
      {
        id: "bom-inspect-b", revisionId: "revision-reserved-inspect", name: "Unspecified board", itemId: "reserved-inspect-part", requiredQuantity: 1, unit: "each", optional: false,
        constraints: { specification: { status: "insufficient", missingDecisions: ["compatibility"] } }, alternatives: [], createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1
      }
    ];
    ports.projects.listBomLines = async () => lines;
    ports.projects.listReservations = async () => [{ id: "reservation-inspect-b", lineId: "bom-inspect-b", itemId: "reserved-inspect-part", quantity: 1, status: "active", createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1 }];
    const result = await new ApplicationService(ports).evaluateBomGaps("revision-reserved-inspect");
    const byId = new Map(result.lines.map((gap) => [gap.lineId, gap]));
    expect(byId.get("bom-inspect-a")).toMatchObject({ status: "missing", suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1 });
    expect(byId.get("bom-inspect-b")).toMatchObject({ status: "specify_first", suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1 });
  });

  it("scans every inventory page and keeps shared-capacity allocation deterministic", async () => {
    const records = Array.from({ length: 200 }, (_, index) => item({
      id: `noise-${index.toString().padStart(3, "0")}`,
      name: `Noise ${index}`,
      kind: "other",
      unit: "each",
      quantity: 1,
      availableQuantity: 1
    })).concat(item({ id: "tail-part", name: "Tail part", kind: "electronic", unit: "each", quantity: 1, availableQuantity: 1 }));
    const ports = fakePorts(records[0]);
    const inventoryRequests: InventoryListOptions[] = [];
    ports.inventory.listItems = async (query) => {
      inventoryRequests.push(query);
      const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
      const data = records.slice(offset, offset + query.limit);
      const nextCursor = offset + data.length < records.length ? String(offset + data.length) : undefined;
      return { data, limit: query.limit, total: records.length, ...(nextCursor === undefined ? {} : { nextCursor }) };
    };
    const line = (id: string): BomLine => ({
      id,
      revisionId: "revision-paged",
      name: `Line ${id}`,
      itemId: "tail-part",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      constraints: {},
      alternatives: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      version: 1
    });
    const lines = [line("bom-b"), line("bom-a")];
    ports.projects.listBomLines = async () => lines;
    ports.projects.listReservations = async () => [];
    const service = new ApplicationService(ports);

    const result = await service.evaluateBomGaps("revision-paged");
    const byId = new Map(result.lines.map((gap) => [gap.lineId, gap]));

    expect(inventoryRequests).toEqual([
      { limit: 200 },
      { limit: 200, cursor: "200" }
    ]);
    expect(byId.get("bom-a")).toMatchObject({ status: "supplied", suppliedQuantity: 1, missingQuantity: 0, matchedItemIds: ["tail-part"] });
    expect(byId.get("bom-b")).toMatchObject({ status: "missing", suppliedQuantity: 0, missingQuantity: 1, matchedItemIds: ["tail-part"] });
  });

  it("rejects reservation requests that do not satisfy the BOM and stock invariants", async () => {
    const undecidedPorts = fakePorts(item({ id: "item-1", name: "12 V power supply", quantity: 1, availableQuantity: 1, unit: "gram" }));
    const undecidedService = new ApplicationService(undecidedPorts);
    await undecidedService.createBomLine("rev-1", { id: "bom-undecided", name: "12 V power supply", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: { specification: { status: "insufficient", missingDecisions: ["current_or_load", "connector"] } } }, context);
    await expect(undecidedService.createReservation("rev-1", { lineId: "bom-undecided", itemId: "item-1", quantity: 1 }, context)).rejects.toMatchObject({ code: "validation" });

    const unsupportedPorts = fakePorts();
    const unsupportedService = new ApplicationService(unsupportedPorts);
    await unsupportedService.createBomLine("rev-1", { id: "bom-unsupported", name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: { unsupported: "value" } }, context);
    await expect(unsupportedService.createReservation("rev-1", { lineId: "bom-unsupported", itemId: "item-1", quantity: 1 }, context)).rejects.toMatchObject({ code: "validation" });

    const missingLineService = new ApplicationService(fakePorts());
    await expect(missingLineService.createReservation("rev-1", { lineId: "missing-line", itemId: "item-1", quantity: 1 }, context)).rejects.toMatchObject({ code: "not_found" });

    const missingItemPorts = fakePorts();
    const missingItemService = new ApplicationService(missingItemPorts);
    await missingItemService.createBomLine("rev-1", { id: "bom-missing-item", name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: {} }, context);
    missingItemPorts.inventory.getItem = async () => null;
    await expect(missingItemService.createReservation("rev-1", { lineId: "bom-missing-item", itemId: "item-1", quantity: 1 }, context)).rejects.toMatchObject({ code: "not_found" });

    const unitPorts = fakePorts(item({ unit: "each" }));
    const unitService = new ApplicationService(unitPorts);
    await unitService.createBomLine("rev-1", { id: "bom-unit", name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: {} }, context);
    await expect(unitService.createReservation("rev-1", { lineId: "bom-unit", itemId: "item-1", quantity: 1 }, context)).rejects.toMatchObject({ code: "validation" });

    const constraintPorts = fakePorts(item({ manufacturer: "Maker Co", unit: "gram" }));
    const constraintService = new ApplicationService(constraintPorts);
    await constraintService.createBomLine("rev-1", { id: "bom-constraint", name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: { manufacturer: "Other Co" } }, context);
    await expect(constraintService.createReservation("rev-1", { lineId: "bom-constraint", itemId: "item-1", quantity: 1 }, context)).rejects.toMatchObject({ code: "validation" });

    const uncertainPorts = fakePorts(item({ evidence: { state: "delivered_uncounted" }, availableQuantity: 0, unit: "gram" }));
    const uncertainService = new ApplicationService(uncertainPorts);
    await uncertainService.createBomLine("rev-1", { id: "bom-uncertain", name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: {} }, context);
    await expect(uncertainService.createReservation("rev-1", { lineId: "bom-uncertain", itemId: "item-1", quantity: 1 }, context)).rejects.toMatchObject({ code: "conflict" });

    const overReservedPorts = fakePorts(item({ quantity: 2, availableQuantity: 2, unit: "gram" }));
    const overReservedService = new ApplicationService(overReservedPorts);
    await overReservedService.createBomLine("rev-1", { id: "bom-over", name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: {} }, context);
    await overReservedPorts.projects.createReservation("rev-1", { id: "existing-reservation", lineId: "bom-over", itemId: "item-1", quantity: 1 }, context);
    await expect(overReservedService.createReservation("rev-1", { lineId: "bom-over", itemId: "item-1", quantity: 1 }, context)).rejects.toMatchObject({ code: "conflict" });

    const unavailablePorts = fakePorts(item({ quantity: 1, availableQuantity: 0, unit: "gram" }));
    const unavailableService = new ApplicationService(unavailablePorts);
    await unavailableService.createBomLine("rev-1", { id: "bom-unavailable", name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: {} }, context);
    await expect(unavailableService.createReservation("rev-1", { lineId: "bom-unavailable", itemId: "item-1", quantity: 1 }, context)).rejects.toMatchObject({ code: "conflict" });
  });

  it("audits reservation release/list/details and forwards validated usage", async () => {
    const ports = fakePorts(item({ unit: "gram" }));
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { id: "bom-reservation-flow", name: "Filament", itemId: "item-1", requiredQuantity: 10, unit: "gram", optional: false, alternatives: [], constraints: {} }, context);
    const reservation = await service.createReservation("rev-1", { id: "reservation-flow", lineId: "bom-reservation-flow", itemId: "item-1", quantity: 2 }, context);
    expect(reservation.data).toMatchObject({ id: "reservation-flow", status: "active" });
    await expect(service.listReservations("rev-1")).resolves.toMatchObject([{ id: "reservation-flow" }]);
    await expect(service.getReservationDetails("reservation-flow")).resolves.toMatchObject({ reservation: { id: "reservation-flow" }, projectId: "project-1" });
    const released = await service.releaseReservation("reservation-flow", 1, context);
    expect(released).toMatchObject({ data: { id: "reservation-flow" }, audit: { action: "project.reservation.release" } });
    await expect(service.listReservations("bad/id")).rejects.toMatchObject({ code: "validation" });

    let usageInput: unknown;
    ports.projects.recordUsage = async (input): Promise<StockMutation> => {
      usageInput = input;
      return {
        event: { id: "usage-event", itemId: input.itemId, type: "consume", quantity: input.quantity, unit: input.unit, actor: "test", source: "api", createdAt: "2026-08-30T00:00:00.000Z", itemVersion: 2 },
        item: item({ quantity: 998, availableQuantity: 998, version: 2 })
      };
    };
    const usage = await service.recordUsage({ reservationId: "reservation-flow", projectId: "project-1", itemId: "item-1", quantity: 2, unit: "gram", note: "used on prototype" }, context);
    expect(usage).toMatchObject({ data: { event: { type: "consume" }, item: { quantity: 998 } }, audit: { action: "project.usage.record" } });
    expect(usageInput).toEqual({ reservationId: "reservation-flow", projectId: "project-1", itemId: "item-1", quantity: 2, unit: "gram", note: "used on prototype" });

    await expect(service.recordUsage({ projectId: "bad/id", itemId: "item-1", quantity: 1, unit: "gram" }, context)).rejects.toMatchObject({ code: "validation" });
    await expect(service.recordUsage({ projectId: "project-1", itemId: "missing-item", quantity: 1, unit: "gram" }, context)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.recordUsage({ projectId: "project-1", itemId: "item-1", quantity: 1, unit: "each" }, context)).rejects.toMatchObject({ code: "validation" });
    await expect(service.getReservationDetails("missing-reservation")).rejects.toMatchObject({ code: "not_found" });
  });

  it("lists and creates supplier offers with bounded limits", async () => {
    const ports = fakePorts();
    let offerItemId: string | undefined;
    let offerLimit = 0;
    let offerCursor: string | undefined;
    ports.offers.listOffers = async (itemId, limit, cursor) => {
      offerItemId = itemId;
      offerLimit = limit;
      offerCursor = cursor;
      return { data: [], limit, nextCursor: "offers-next" };
    };
    const service = new ApplicationService(ports);
    await expect(service.listOffers(undefined, 0)).resolves.toMatchObject({ limit: 1 });
    expect(offerItemId).toBeUndefined();
    await expect(service.listOffers("item-1", 999, "offer-cursor")).resolves.toMatchObject({ limit: 200 });
    expect(offerItemId).toBe("item-1");
    expect(offerLimit).toBe(200);
    expect(offerCursor).toBe("offer-cursor");
    await expect(service.listOffers("bad/id")).rejects.toMatchObject({ code: "validation" });

    const created = await service.createOffer({
      id: "offer-flow",
      itemId: "item-1",
      name: "PETG refill",
      supplier: "Maker Shop",
      url: "https://example.test/petg",
      priceMinor: 2499,
      currency: "EUR",
      packageQuantity: 1000,
      shippingMinor: 499,
      staleAfterDays: 14,
      observedAt: "2026-08-30T00:00:00.000Z",
      notes: "Use for orange enclosure"
    }, context);
    expect(created).toMatchObject({ data: { id: "offer-flow", supplier: "Maker Shop" }, audit: { action: "offer.create" } });
  });

  it("covers artifact listing, reading, retirement, writes, and upload validation", async () => {
    const ports = fakePorts();
    const artifact: Artifact = {
      id: "artifact-flow",
      projectId: "project-1",
      revisionId: "rev-1",
      role: "step",
      filename: "enclosure.step",
      mediaType: "model/step",
      byteSize: 4,
      sha256: "a".repeat(64),
      currentCandidate: true,
      retired: false,
      createdAt: "2026-08-30T00:00:00.000Z",
      version: 1
    };
    let listedArgs: unknown[] = [];
    let begunFilename = "";
    ports.artifacts.listArtifacts = async (...args) => {
      listedArgs = args;
      return [artifact];
    };
    ports.artifacts.getArtifact = async (id) => id === artifact.id ? artifact : null;
    ports.artifacts.beginUpload = async (input) => {
      begunFilename = input.filename;
      return { id: "session-flow", artifactId: artifact.id, expiresAt: "2026-08-30T01:00:00.000Z", maxBytes: input.byteSize, uploadUrl: "/uploads/session-flow", status: "pending" };
    };
    let wrote: { sessionId: string; bytes: number } | undefined;
    ports.artifacts.writeUpload = async (sessionId, body) => {
      wrote = { sessionId, bytes: body.byteLength };
      return { receivedBytes: body.byteLength };
    };
    ports.artifacts.readArtifact = async (id) => ({ artifact: { ...artifact, id }, body: new Uint8Array([1, 2, 3, 4]) });
    ports.artifacts.retireArtifact = async (id, _version, _ctx) => ({ ...artifact, id, retired: true, currentCandidate: false, version: 2 });
    const service = new ApplicationService(ports);

    await expect(service.listArtifacts("project-1", "work-1", "rev-1")).resolves.toEqual([artifact]);
    expect(listedArgs).toEqual(["project-1", "work-1", "rev-1"]);
    await expect(service.getArtifact(artifact.id)).resolves.toEqual(artifact);
    await expect(service.getArtifact("missing-artifact")).rejects.toMatchObject({ code: "not_found" });
    await expect(service.getArtifact("bad/id")).rejects.toMatchObject({ code: "validation" });

    const upload = await service.beginArtifactUpload({ projectId: "project-1", role: "text", filename: "  notes.txt  ", mediaType: "text/plain", byteSize: 4, sha256: "b".repeat(64) }, context);
    expect(upload.data).toMatchObject({ id: "session-flow", status: "pending" });
    expect(begunFilename).toBe("notes.txt");
    await expect(service.writeArtifactUpload("session-flow", new Uint8Array([1, 2, 3]))).resolves.toEqual({ receivedBytes: 3 });
    expect(wrote).toEqual({ sessionId: "session-flow", bytes: 3 });
    await expect(service.writeArtifactUpload("bad/id", new Uint8Array())).rejects.toMatchObject({ code: "validation" });
    await expect(service.writeArtifactUpload("session-flow", { byteLength: 100 * 1024 * 1024 + 1 } as unknown as Uint8Array)).rejects.toMatchObject({ code: "quota_exceeded" });

    await expect(service.readArtifact(artifact.id)).resolves.toMatchObject({ artifact, body: new Uint8Array([1, 2, 3, 4]) });
    const retired = await service.retireArtifact(artifact.id, 1, context);
    expect(retired).toMatchObject({ data: { retired: true }, audit: { action: "artifact.retire" } });
    await expect(service.listArtifacts("bad/id")).rejects.toMatchObject({ code: "validation" });
    await expect(service.beginArtifactUpload({ projectId: "project-1", role: "other", filename: "archive.svg", mediaType: "image/svg+xml", byteSize: 1, sha256: "c".repeat(64) }, context)).rejects.toMatchObject({ code: "unsupported_media" });
    await expect(service.beginArtifactUpload({ projectId: "project-1", role: "other", filename: "archive.zip", mediaType: "application/octet-stream", byteSize: 1, sha256: "c".repeat(64) }, context)).rejects.toMatchObject({ code: "unsupported_media" });
    await expect(service.beginArtifactUpload({ projectId: "project-1", role: "other", filename: "part.step", mediaType: "model/step", byteSize: 0, sha256: "c".repeat(64) }, context)).rejects.toMatchObject({ code: "quota_exceeded" });
    await expect(service.beginArtifactUpload({ projectId: "project-1", role: "other", filename: "part.step", mediaType: "model/step", byteSize: 100 * 1024 * 1024 + 1, sha256: "c".repeat(64) }, context)).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  it("resolves valid project and work-item upload ancestry before creating a session", async () => {
    const ports = fakePorts();
    const projectRevision: ProjectRevision = { id: "project-only-rev", projectId: "project-1", number: 1, name: "Project revision", status: "concept", createdAt: "2026-08-30T00:00:00.000Z", version: 1 };
    const workItem: WorkItem = { id: "work-valid", projectId: "project-1", name: "Housing", kind: "part", createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1 };
    const workRevision: WorkItemRevision = { id: "work-valid-rev", workItemId: workItem.id, projectId: workItem.projectId, number: 1, name: "Housing revision", status: "concept", createdAt: "2026-08-30T00:00:00.000Z", version: 1 };
    ports.projects.getProjectRevision = async (id) => id === projectRevision.id ? projectRevision : null;
    ports.projects.getWorkItem = async (id) => id === workItem.id ? workItem : null;
    ports.projects.getWorkItemRevision = async (id) => id === workRevision.id ? workRevision : null;
    const service = new ApplicationService(ports);
    const base = { role: "step" as const, filename: "housing.step", mediaType: "model/step", byteSize: 1, sha256: "d".repeat(64) };

    await expect(service.beginArtifactUpload({ ...base, projectId: "project-1" }, context)).resolves.toMatchObject({ data: { id: "session-1" } });
    await expect(service.beginArtifactUpload({ ...base, projectId: "project-1", revisionId: projectRevision.id }, context)).resolves.toMatchObject({ data: { id: "session-1" } });
    await expect(service.beginArtifactUpload({ ...base, projectId: "project-1", workItemId: workItem.id }, context)).resolves.toMatchObject({ data: { id: "session-1" } });
    await expect(service.beginArtifactUpload({ ...base, projectId: "project-1", workItemId: workItem.id, revisionId: workRevision.id }, context)).resolves.toMatchObject({ data: { id: "session-1" } });
    await expect(service.beginArtifactUpload({ ...base, projectId: "project-1", filename: "housing.bin", mediaType: "application/x-private-format" }, context)).rejects.toMatchObject({ code: "unsupported_media" });
  });

  it("surfaces missing upload-session details and health degradation", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports, "health-version");
    await expect(service.getUploadSessionDetails("missing-session")).rejects.toMatchObject({ code: "not_found" });
    await expect(service.getUploadSessionDetails("bad/id")).rejects.toMatchObject({ code: "validation" });
    await expect(service.health()).resolves.toMatchObject({ status: "ok", service: "benchledger", version: "health-version", demo: false, checks: { database: "ok", artifacts: "ok" } });
    const degradedService = new ApplicationService({ ...ports, health: { check: async () => ({ database: "ok", artifacts: "degraded" }) } }, "health-version");
    await expect(degradedService.health()).resolves.toMatchObject({ status: "degraded", checks: { database: "ok", artifacts: "degraded" } });

    const received: EventBusEvent[] = [];
    ports.events.subscribe = (listener) => {
      const event: EventBusEvent = { id: "event-subscribe", type: "test", entityType: "item", entityId: "item-1", correlationId: "corr-1", at: "2026-08-30T00:00:00.000Z" };
      listener(event);
      return () => undefined;
    };
    const unsubscribe = service.subscribe((event) => received.push(event));
    unsubscribe();
    expect(received).toEqual([expect.objectContaining({ id: "event-subscribe" })]);
  });

  it("records a mutation with audit, correlation and state event", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    const result = await service.recordStockEvent({ itemId: "item-1", type: "receipt", quantity: 250, unit: "gram" }, context);
    expect(result.data.item.quantity).toBe(1250);
    expect(result.audit.correlationId).toBe("corr-1");
    expect(result.replayed).toBe(false);
  });

  it("treats uncounted matching stock as inspect-first", async () => {
    const ports = fakePorts(item({ evidence: { state: "delivered_uncounted" }, availableQuantity: 0, quantity: 2, unit: "each", name: "ESP32" }));
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context);
    const result = await service.evaluateBomGaps("rev-1");
    expect(result.lines[0]?.status).toBe("inspect_first");
    expect(result.lines[0]?.missingQuantity).toBe(0);
  });

  it("fails closed when a BOM contains an unsupported constraint", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { name: "Board", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: { mysteryProperty: "anything" } }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "missing", matchedItemIds: [] });
  });

  it("does not treat unrelated same-unit stock as a match for an unconstrained BOM line", async () => {
    const ports = fakePorts();
    const unrelated = item({ id: "unrelated-board", name: "Different board", kind: "electronic", unit: "each" });
    ports.inventory.listItems = async () => ({ data: [unrelated], limit: 200 });
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { name: "Requested board", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({
      status: "missing",
      suppliedQuantity: 0,
      inspectQuantity: 0,
      missingQuantity: 1,
      matchedItemIds: []
    });
  });

  it("keeps a constraints-only candidate inspect-first so evaluation agrees with reservation", async () => {
    const ports = fakePorts();
    const candidate = item({ id: "constraint-board", name: "ESP32 board", kind: "electronic", unit: "each" });
    ports.inventory.listItems = async () => ({ data: [candidate], limit: 200 });
    ports.inventory.getItem = async (id) => id === candidate.id ? candidate : null;
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { name: "Any electronics board", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: { kind: "electronic" } }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "inspect_first", suppliedQuantity: 0, inspectQuantity: 1, missingQuantity: 0, matchedItemIds: [candidate.id] });
    await expect(service.createReservation("rev-1", { lineId: "bom-1", itemId: candidate.id, quantity: 1 }, context)).rejects.toMatchObject({ code: "validation" });
  });

  it.each(["conditional", "unknown"] as const)("keeps %s alternatives inspect-first and never reserves them", async (compatibility) => {
    const ports = fakePorts();
    const alternative = item({ id: `alternative-${compatibility}`, name: "Possible board", kind: "electronic", unit: "each" });
    ports.inventory.listItems = async () => ({ data: [alternative], limit: 200 });
    ports.inventory.getItem = async (id) => id === alternative.id ? alternative : null;
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      name: "Requested board",
      itemId: "item-1",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [{ itemId: alternative.id, compatible: compatibility }],
      constraints: {}
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "inspect_first", suppliedQuantity: 0, inspectQuantity: 1, missingQuantity: 0, matchedItemIds: [alternative.id] });
    await expect(service.createReservation("rev-1", { lineId: "bom-1", itemId: alternative.id, quantity: 1 }, context)).rejects.toMatchObject({ code: "validation" });
  });

  it("does not let an exact item ID override a conditional compatibility decision", async () => {
    const ports = fakePorts(item({ id: "item-1", name: "Possible board", kind: "electronic", unit: "each" }));
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      name: "Requested board",
      itemId: "item-1",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [{ itemId: "item-1", compatible: "conditional", reason: "verify voltage" }],
      constraints: {},
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "inspect_first", suppliedQuantity: 0, inspectQuantity: 1, missingQuantity: 0 });
    expect(result.lines[0]?.candidates[0]).toMatchObject({ relationship: "uncertain_alternative", compatibility: "conditional" });
    await expect(service.createReservation("rev-1", { lineId: "bom-1", itemId: "item-1", quantity: 1 }, context)).rejects.toMatchObject({ code: "validation" });
  });

  it("keeps a partial shortfall in Check while an inspect-first candidate may cover it", async () => {
    const confirmed = item({ id: "confirmed-part", name: "Controller", quantity: 1, availableQuantity: 1, unit: "each" });
    const uncertain = item({ id: "uncertain-part", name: "Possible controller", quantity: 1, availableQuantity: 0, unit: "each", evidence: { state: "delivered_uncounted" } });
    const ports = fakePorts(confirmed);
    ports.inventory.listItems = async () => ({ data: [confirmed, uncertain], limit: 200 });
    ports.inventory.getItem = async (id) => [confirmed, uncertain].find((candidate) => candidate.id === id) ?? null;
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      name: "Controller",
      itemId: confirmed.id,
      requiredQuantity: 3,
      unit: "each",
      optional: false,
      alternatives: [{ itemId: uncertain.id, compatible: "confirmed" }],
      constraints: {},
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "partially_supplied", decision: "check", suppliedQuantity: 1, inspectQuantity: 1, missingQuantity: 1 });
    expect(result.totals).toMatchObject({ partialLines: 1, checkLines: 1, sourceLines: 0 });
  });

  it("counts a confirmed alternative as supplied", async () => {
    const ports = fakePorts();
    const alternative = item({ id: "confirmed-alternative", name: "Compatible board", kind: "electronic", unit: "each", quantity: 1, availableQuantity: 1 });
    ports.inventory.listItems = async () => ({ data: [alternative], limit: 200 });
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      name: "Requested board",
      itemId: "item-1",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [{ itemId: alternative.id, compatible: "confirmed" }],
      constraints: {}
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "supplied", suppliedQuantity: 1, inspectQuantity: 0, missingQuantity: 0, matchedItemIds: [alternative.id] });
    expect(result.lines[0]?.candidates).toEqual([expect.objectContaining({
      itemId: alternative.id,
      relationship: "confirmed_alternative",
      compatibility: "confirmed",
      availableQuantity: 1,
      suppliedQuantity: 1,
      inspectQuantity: 0,
    })]);
  });

  it("reports exact, zero-stock confirmed, and uncertain candidate facts without aggregate inference", async () => {
    const exact = item({ id: "exact-board", kind: "electronic", name: "Exact board", quantity: 1, availableQuantity: 1, unit: "each" });
    const zeroStockAlternative = item({ id: "zero-stock-alternative", kind: "electronic", name: "Confirmed alternative", quantity: 0, availableQuantity: 0, unit: "each" });
    const uncertainAlternative = item({ id: "uncertain-alternative", kind: "electronic", name: "Uncertain alternative", quantity: 2, availableQuantity: 0, unit: "each", evidence: { state: "delivered_uncounted" } });
    const ports = fakePorts(exact);
    ports.inventory.listItems = async () => ({ data: [exact, zeroStockAlternative, uncertainAlternative], limit: 200, total: 3 });
    ports.inventory.getItem = async (id) => [exact, zeroStockAlternative, uncertainAlternative].find((candidate) => candidate.id === id) ?? null;
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      name: "Controller",
      itemId: exact.id,
      requiredQuantity: 2,
      unit: "each",
      optional: false,
      alternatives: [
        { itemId: zeroStockAlternative.id, compatible: "confirmed", reason: "same pinout" },
        { itemId: uncertainAlternative.id, compatible: "conditional", reason: "verify voltage" },
      ],
      constraints: {},
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "inspect_first", suppliedQuantity: 1, inspectQuantity: 1, missingQuantity: 0 });
    expect(result.lines[0]?.candidates).toEqual([
      expect.objectContaining({ itemId: exact.id, relationship: "exact", compatibility: "confirmed", availableQuantity: 1, suppliedQuantity: 1, inspectQuantity: 0 }),
      expect.objectContaining({ itemId: zeroStockAlternative.id, relationship: "confirmed_alternative", compatibility: "confirmed", availableQuantity: 0, suppliedQuantity: 0, inspectQuantity: 0 }),
      expect.objectContaining({ itemId: uncertainAlternative.id, relationship: "uncertain_alternative", compatibility: "conditional", availableQuantity: 2, suppliedQuantity: 0, inspectQuantity: 1 }),
    ]);
  });

  it("accepts reservations only for the exact item or an approved alternative", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "each", optional: false, alternatives: [{ itemId: "item-2", compatible: "conditional" }], constraints: {} }, context);

    await expect(service.createReservation("rev-1", { lineId: "bom-1", itemId: "item-2", quantity: 1 }, context)).rejects.toMatchObject({ code: "not_found" });
  });

  it("allows an approved alternative when its unit, evidence and constraints match", async () => {
    const ports = fakePorts();
    const alternate = item({ id: "item-2", name: "Alternate board", unit: "gram", manufacturer: "Maker Co" });
    ports.inventory.getItem = async (id) => id === alternate.id ? alternate : id === "item-1" ? item() : null;
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [{ itemId: alternate.id, compatible: "confirmed" }], constraints: { manufacturer: "maker co" } }, context);

    const result = await service.createReservation("rev-1", { lineId: "bom-1", itemId: alternate.id, quantity: 1 }, context);

    expect(result.data).toMatchObject({ itemId: alternate.id, quantity: 1, status: "active" });
  });

  it("counts an active reservation back into its own BOM gap evaluation", async () => {
    const ports = fakePorts(item({ quantity: 2, availableQuantity: 0, unit: "each" }));
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context);

    await ports.projects.createReservation("rev-1", { id: "reservation-owned", lineId: "bom-1", itemId: "item-1", quantity: 1 }, context);
    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "supplied", suppliedQuantity: 1, missingQuantity: 0 });
  });

  it("allocates a confirmed whole-set alternative into each-unit gap quantities", async () => {
    const setItem = item({ id: "led-set", name: "LED set", kind: "electronic", quantity: 2, availableQuantity: 2, unit: "set" });
    const conversion = {
      inventory: { quantity: 1, unit: "set" as const },
      requirement: { quantity: 10, unit: "each" as const },
      evidence: { basis: "package_label" as const, observedAt: "2026-09-02T10:00:00.000Z", source: "set label" },
    } as const;
    const ports = fakePorts(setItem);
    ports.inventory.listItems = async () => ({ data: [setItem], limit: 200 });
    ports.inventory.getItem = async (id) => id === setItem.id ? setItem : null;
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      name: "LEDs",
      itemId: "missing-led",
      requiredQuantity: 15,
      unit: "each",
      optional: false,
      alternatives: [{ itemId: setItem.id, compatible: "confirmed", quantityConversion: conversion }],
      constraints: {},
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "supplied", decision: "ready", requiredQuantity: 15, suppliedQuantity: 15, inspectQuantity: 0, missingQuantity: 0, unit: "each", matchedItemIds: [setItem.id] });
    expect(result.lines[0]?.candidates).toEqual([expect.objectContaining({
      itemId: setItem.id,
      relationship: "confirmed_alternative",
      compatibility: "confirmed",
      availableQuantity: 20,
      suppliedQuantity: 15,
      inspectQuantity: 0,
      reason: expect.stringMatching(/1 set = 10 each|5 each overage/),
    })]);
  });

  it("keeps an explicit cross-unit alternative inspect-first with a full each-unit gap when conversion is absent", async () => {
    const setItem = item({ id: "led-set", name: "LED set", kind: "electronic", quantity: 2, availableQuantity: 2, unit: "set" });
    const ports = fakePorts(setItem);
    ports.inventory.listItems = async () => ({ data: [setItem], limit: 200 });
    ports.inventory.getItem = async (id) => id === setItem.id ? setItem : null;
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      name: "LEDs",
      itemId: "missing-led",
      requiredQuantity: 15,
      unit: "each",
      optional: false,
      alternatives: [{ itemId: setItem.id, compatible: "confirmed" }],
      constraints: {},
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "inspect_first", decision: "check", requiredQuantity: 15, suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 15, unit: "each", matchedItemIds: [setItem.id] });
    expect(result.lines[0]?.candidates).toEqual([expect.objectContaining({ itemId: setItem.id, availableQuantity: 0, suppliedQuantity: 0, inspectQuantity: 0, reason: expect.stringMatching(/no valid.*conversion/i) })]);
    await expect(service.createReservation("rev-1", { lineId: "bom-1", itemId: setItem.id, quantity: 1 }, context)).rejects.toMatchObject({ code: "validation" });
  });

  it.each(["conditional", "unknown"] as const)("keeps a %s converted alternative in Check even when its set stock is physically confirmed", async (compatibility) => {
    const setItem = item({ id: `led-set-${compatibility}`, name: "LED set", kind: "electronic", quantity: 2, availableQuantity: 2, unit: "set" });
    const conversion = {
      inventory: { quantity: 1, unit: "set" as const },
      requirement: { quantity: 10, unit: "each" as const },
      evidence: { basis: "package_label" as const, observedAt: "2026-09-02T10:00:00.000Z" },
    } as const;
    const ports = fakePorts(setItem);
    ports.inventory.listItems = async () => ({ data: [setItem], limit: 200 });
    ports.inventory.getItem = async (id) => id === setItem.id ? setItem : null;
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      name: "LEDs",
      itemId: "missing-led",
      requiredQuantity: 15,
      unit: "each",
      optional: false,
      alternatives: [{ itemId: setItem.id, compatible: compatibility, quantityConversion: conversion }],
      constraints: {},
    }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "inspect_first", decision: "check", suppliedQuantity: 0, inspectQuantity: 15, missingQuantity: 0 });
    expect(result.lines[0]?.candidates[0]).toMatchObject({ availableQuantity: 20, suppliedQuantity: 0, inspectQuantity: 15, compatibility });
    await expect(service.createReservation("rev-1", { lineId: "bom-1", itemId: setItem.id, quantity: 1 }, context)).rejects.toMatchObject({ code: "validation" });
  });

  it("reserves whole sets for a converted each-unit requirement and permits deterministic set overage", async () => {
    const setItem = item({ id: "led-set", name: "LED set", kind: "electronic", quantity: 3, availableQuantity: 3, unit: "set" });
    const conversion = {
      inventory: { quantity: 1, unit: "set" as const },
      requirement: { quantity: 10, unit: "each" as const },
      evidence: { basis: "package_label" as const, observedAt: "2026-09-02T10:00:00.000Z" },
    } as const;
    const ports = fakePorts(setItem);
    ports.inventory.listItems = async () => ({ data: [setItem], limit: 200 });
    ports.inventory.getItem = async (id) => id === setItem.id ? setItem : null;
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      name: "LEDs",
      itemId: "missing-led",
      requiredQuantity: 15,
      unit: "each",
      optional: false,
      alternatives: [{ itemId: setItem.id, compatible: "confirmed", quantityConversion: conversion }],
      constraints: {},
    }, context);

    const reservation = await service.createReservation("rev-1", { lineId: "bom-1", itemId: setItem.id, quantity: 2 }, context);

    expect(reservation.data).toMatchObject({ itemId: setItem.id, quantity: 2, status: "active" });
    await expect(service.createReservation("rev-1", { lineId: "bom-1", itemId: setItem.id, quantity: 1 }, context)).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects fractional quantities for converted set reservations", async () => {
    const setItem = item({ id: "fractional-led-set", name: "LED set", kind: "electronic", quantity: 2, availableQuantity: 2, unit: "set" });
    const ports = fakePorts(setItem);
    ports.inventory.listItems = async () => ({ data: [setItem], limit: 200 });
    ports.inventory.getItem = async (id) => id === setItem.id ? setItem : null;
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      name: "LEDs",
      itemId: "missing-led",
      requiredQuantity: 15,
      unit: "each",
      optional: false,
      alternatives: [{ itemId: setItem.id, compatible: "confirmed", quantityConversion: {
        inventory: { quantity: 1, unit: "set" },
        requirement: { quantity: 10, unit: "each" },
        evidence: { basis: "package_label", observedAt: "2026-09-02T10:00:00.000Z" }
      } }],
      constraints: {},
    }, context);

    await expect(service.createReservation("rev-1", { lineId: "bom-1", itemId: setItem.id, quantity: 1.5 }, context))
      .rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/whole number of sets/i) });
  });

  it("reports converted whole-set reservations that exceed each-unit requirement", async () => {
    const setItem = item({ id: "overage-led-set", name: "LED set", kind: "electronic", quantity: 3, availableQuantity: 3, unit: "set" });
    const ports = fakePorts(setItem);
    ports.projects.getProjectRevision = async () => null;
    const service = new ApplicationService(ports);
    const preview = await service.previewProjectSetup({
      project: { id: "setup-overage-project", name: "Converted setup", status: "planned" },
      revision: { id: "setup-overage-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "led-line", id: "setup-overage-line", name: "LEDs", itemId: "missing-led", requiredQuantity: 15, unit: "each", optional: false, constraints: {}, alternatives: [{ itemId: setItem.id, compatible: "confirmed", quantityConversion: {
        inventory: { quantity: 1, unit: "set" },
        requirement: { quantity: 10, unit: "each" },
        evidence: { basis: "package_label", observedAt: "2026-09-02T10:00:00.000Z" }
      } }] }],
      reservations: [{ localRef: "led-reservation", bomLineLocalRef: "led-line", id: "setup-overage-reservation", itemId: setItem.id, quantity: 3, unit: "set" }],
    }, context);

    expect(preview.fieldErrors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "requirement_exceeded" })]));
    expect(preview.plannedReservations[0]).toMatchObject({ quantity: 3, unit: "set", itemId: setItem.id });
    expect(preview.gaps.lines[0]).toMatchObject({ requiredQuantity: 15, suppliedQuantity: 15, unit: "each" });
  });

  it("keeps setup diagnostics for a cross-unit reservation without a valid conversion", async () => {
    const setItem = item({ id: "invalid-conversion-set", name: "LED set", kind: "electronic", quantity: 2, availableQuantity: 2, unit: "set" });
    const ports = fakePorts(setItem);
    ports.projects.getProjectRevision = async () => null;
    const service = new ApplicationService(ports);
    const preview = await service.previewProjectSetup({
      project: { id: "setup-invalid-conversion-project", name: "Invalid conversion setup", status: "planned" },
      revision: { id: "setup-invalid-conversion-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "led-line", id: "setup-invalid-conversion-line", name: "LEDs", itemId: "missing-led", requiredQuantity: 10, unit: "each", optional: false, constraints: {}, alternatives: [{ itemId: setItem.id, compatible: "confirmed" }] }],
      reservations: [{ localRef: "led-reservation", bomLineLocalRef: "led-line", id: "setup-invalid-conversion-reservation", itemId: setItem.id, quantity: 1, unit: "each" }],
    }, context);

    expect(preview.fieldErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unit_mismatch" }),
      expect.objectContaining({ code: "invalid_quantity_conversion" }),
    ]));
  });

  it("keeps specification, constraint, and evidence blockers on converted setup reservations", async () => {
    const setItem = item({ id: "blocked-conversion-set", name: "LED set", kind: "electronic", quantity: 2, availableQuantity: 0, unit: "set", manufacturer: "Observed maker", evidence: { state: "delivered_uncounted" } });
    const ports = fakePorts(setItem);
    ports.projects.getProjectRevision = async () => null;
    const service = new ApplicationService(ports);
    const preview = await service.previewProjectSetup({
      project: { id: "setup-blocked-conversion-project", name: "Blocked conversion setup", status: "planned" },
      revision: { id: "setup-blocked-conversion-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "led-line", id: "setup-blocked-conversion-line", name: "LEDs", itemId: "missing-led", requiredQuantity: 10, unit: "each", optional: false, constraints: { manufacturer: "Required maker", specification: { status: "insufficient", missingDecisions: ["voltage"] } }, alternatives: [{ itemId: setItem.id, compatible: "confirmed", quantityConversion: {
        inventory: { quantity: 1, unit: "set" },
        requirement: { quantity: 10, unit: "each" },
        evidence: { basis: "package_label", observedAt: "2026-09-02T10:00:00.000Z" }
      } }] }],
      reservations: [{ localRef: "led-reservation", bomLineLocalRef: "led-line", id: "setup-blocked-conversion-reservation", itemId: setItem.id, quantity: 1, unit: "set" }],
    }, context);

    expect(preview.fieldErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unresolved_specification" }),
      expect.objectContaining({ code: "constraint_mismatch" }),
      expect.objectContaining({ code: "insufficient_evidence" }),
    ]));
  });

  it("shows set reservations and converted each coverage in an atomic setup preview", async () => {
    const setItem = item({ id: "led-set", name: "LED set", kind: "electronic", quantity: 2, availableQuantity: 2, unit: "set" });
    const conversion = {
      inventory: { quantity: 1, unit: "set" as const },
      requirement: { quantity: 10, unit: "each" as const },
      evidence: { basis: "package_label" as const, observedAt: "2026-09-02T10:00:00.000Z" },
    } as const;
    const ports = fakePorts(setItem);
    ports.projects.getProjectRevision = async () => null;
    const service = new ApplicationService(ports);
    const preview = await service.previewProjectSetup({
      project: { id: "setup-conversion-project", name: "Converted setup", status: "planned" },
      revision: { id: "setup-conversion-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "led-line", id: "setup-conversion-line", name: "LEDs", itemId: "missing-led", requiredQuantity: 15, unit: "each", optional: false, constraints: {}, alternatives: [{ itemId: setItem.id, compatible: "confirmed", quantityConversion: conversion }] }],
      reservations: [{ localRef: "led-reservation", bomLineLocalRef: "led-line", id: "setup-conversion-reservation", itemId: setItem.id, quantity: 2, unit: "set" }],
    }, context);

    expect(preview.fieldErrors).toEqual([]);
    expect(preview.plannedReservations).toEqual([expect.objectContaining({ quantity: 2, unit: "set", itemId: setItem.id })]);
    expect(preview.gaps.lines[0]).toMatchObject({ requiredQuantity: 15, suppliedQuantity: 15, inspectQuantity: 0, missingQuantity: 0, unit: "each" });
    expect(preview.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a setup commit when a reserved conversion item loses physical confirmation", async () => {
    const setItem = item({ id: "led-set", name: "LED set", kind: "electronic", quantity: 2, availableQuantity: 2, unit: "set" });
    const conversion = {
      inventory: { quantity: 1, unit: "set" as const },
      requirement: { quantity: 10, unit: "each" as const },
      evidence: { basis: "package_label" as const, observedAt: "2026-09-02T10:00:00.000Z" },
    } as const;
    const ports = fakePorts(setItem);
    ports.projects.getProjectRevision = async () => null;
    const service = new ApplicationService(ports);
    const preview = await service.previewProjectSetup({
      project: { id: "setup-commit-project", name: "Converted setup", status: "planned" },
      revision: { id: "setup-commit-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "led-line", id: "setup-commit-line", name: "LEDs", itemId: "missing-led", requiredQuantity: 15, unit: "each", optional: false, constraints: {}, alternatives: [{ itemId: setItem.id, compatible: "confirmed", quantityConversion: conversion }] }],
      reservations: [{ localRef: "led-reservation", bomLineLocalRef: "led-line", id: "setup-commit-reservation", itemId: setItem.id, quantity: 2, unit: "set" }],
    }, context);
    const unconfirmed = { ...setItem, evidence: { state: "delivered_uncounted" as const } };
    ports.inventory.listItems = async () => ({ data: [unconfirmed], limit: 200 });
    ports.inventory.getItem = async (id) => id === unconfirmed.id ? unconfirmed : null;

    await expect(service.commitProjectSetup({ ...setupCommitInput(preview), confirmReservations: true }, { ...context, idempotencyKey: "setup-conversion-commit" })).rejects.toMatchObject({ code: "conflict", details: { reason: "stale_basis" } });
  });

  it("does not describe fully allocated stock as available to an unrelated BOM line", async () => {
    const ports = fakePorts(item({ quantity: 2, availableQuantity: 0, unit: "each" }));
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { id: "bom-blocked-by-allocation", name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context);

    const result = await service.evaluateBomGaps("rev-1");

    expect(result.lines[0]).toMatchObject({ status: "missing", suppliedQuantity: 0, candidates: [expect.objectContaining({ availableQuantity: 0 })] });
    expect(result.lines[0]?.reasons.join(" ")).not.toContain("Physically confirmed stock covers");
  });

  it("validates usage input before delegating to a project adapter", async () => {
    const service = new ApplicationService(fakePorts());

    await expect(service.recordUsage({ projectId: "project-1", itemId: "item-1", quantity: 0, unit: "each" }, context)).rejects.toMatchObject({ code: "validation" });
    await expect(service.recordUsage({ projectId: "project-1", itemId: "item-1", quantity: 1, unit: "each" }, context)).rejects.toMatchObject({ code: "validation" });
  });

  it("rejects unsafe artifact filenames before reaching the artifact port", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    await expect(service.beginArtifactUpload({ projectId: "project-1", role: "cad_source", filename: "../secret.step", mediaType: "model/step", byteSize: 5, sha256: "a".repeat(64) }, context)).rejects.toMatchObject({ code: "validation" });
  });

  it("validates project, work-item, and revision ancestry before opening an upload", async () => {
    const ports = fakePorts();
    const projectRevision: ProjectRevision = { id: "project-revision-1", projectId: "project-1", number: 1, name: "Project r01", status: "concept", createdAt: "2026-08-30T00:00:00.000Z", version: 1 };
    const workItem: WorkItem = { id: "work-item-1", projectId: "project-1", name: "Enclosure", kind: "part", createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1 };
    const workItemRevision: WorkItemRevision = { id: "work-revision-1", workItemId: workItem.id, projectId: workItem.projectId, number: 1, name: "Enclosure r01", status: "concept", createdAt: "2026-08-30T00:00:00.000Z", version: 1 };
    ports.projects.getProjectRevision = async (id) => id === projectRevision.id ? projectRevision : null;
    ports.projects.getWorkItemRevision = async (id) => id === workItemRevision.id ? workItemRevision : null;
    ports.projects.getWorkItem = async (id) => id === workItem.id ? workItem : null;
    const service = new ApplicationService(ports);
    const input = { role: "step" as const, filename: "enclosure.step", mediaType: "model/step", byteSize: 1, sha256: "a".repeat(64) };

    await expect(service.beginArtifactUpload({ ...input, projectId: "missing-project", revisionId: projectRevision.id }, context)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.beginArtifactUpload({ ...input, projectId: "project-1", workItemId: "missing-work-item", revisionId: workItemRevision.id }, context)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.beginArtifactUpload({ ...input, projectId: "project-1", revisionId: "missing-revision" }, context)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.beginArtifactUpload({ ...input, projectId: "project-1", workItemId: workItem.id, revisionId: projectRevision.id }, context)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.beginArtifactUpload({ ...input, projectId: "project-1", revisionId: workItemRevision.id }, context)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.beginArtifactUpload({ ...input, projectId: "project-1", workItemId: workItem.id, revisionId: workItemRevision.id }, context)).resolves.toMatchObject({ data: { id: "session-1" } });
  });

  it("exposes direct durable lookups for indirect MCP identifiers", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", { id: "bom-direct", name: "Board", itemId: "item-1", requiredQuantity: 1, unit: "gram", optional: false, alternatives: [], constraints: {} }, context);
    await ports.projects.createReservation("rev-1", { id: "reservation-direct", lineId: "bom-direct", itemId: "item-1", quantity: 1 }, context);

    await expect(service.getWorkItem("work-1")).resolves.toMatchObject({ id: "work-1", projectId: "project-1" });
    await expect(service.getBomLine("bom-direct")).resolves.toMatchObject({ id: "bom-direct", revisionId: "rev-1" });
    await expect(service.getReservationDetails("reservation-direct")).resolves.toMatchObject({
      projectId: "project-1",
      projectRevisionId: "rev-1",
      reservation: { id: "reservation-direct" },
      bomLine: { id: "bom-direct", unit: "gram" }
    });
    await expect(service.getUploadSessionDetails("session-1")).resolves.toMatchObject({ projectId: "project-1", revisionId: "rev-1" });
  });

  it("compensates a filesystem finalization when its audit commit fails", async () => {
    const ports = fakePorts();
    const rollbackCalls: Array<{ readonly sessionId: string; readonly artifactId: string }> = [];
    ports.artifacts.rollbackFinalization = async (sessionId, artifactId) => { rollbackCalls.push({ sessionId, artifactId }); };
    ports.artifacts.finalizeUpload = async () => ({ id: "artifact-finalized", projectId: "project-1", role: "step", filename: "part.step", mediaType: "model/step", byteSize: 1, sha256: "a".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-08-30T00:00:00.000Z", version: 1 });
    ports.audit.append = async () => { throw new Error("audit store unavailable"); };
    const service = new ApplicationService(ports);

    await expect(service.finalizeArtifactUpload("session-1", context)).rejects.toThrow("audit store unavailable");
    expect(rollbackCalls).toEqual([{ sessionId: "session-1", artifactId: "artifact-finalized" }]);
  });

  it("aborts an opened upload when the audited begin mutation cannot commit", async () => {
    const ports = fakePorts();
    let filesystemSessionVisible = false;
    const abortCalls: string[] = [];
    ports.artifacts.beginUpload = async (input) => {
      filesystemSessionVisible = true;
      return { id: "session-1", artifactId: "artifact-1", expiresAt: "2026-08-30T01:00:00.000Z", maxBytes: input.byteSize, uploadUrl: "/uploads/session-1", status: "pending" } as UploadSession;
    };
    ports.artifacts.abortUpload = async (sessionId) => {
      abortCalls.push(sessionId);
      filesystemSessionVisible = false;
    };
    ports.audit.append = async () => { throw new Error("audit store unavailable"); };
    const service = new ApplicationService(ports);

    await expect(service.beginArtifactUpload({ projectId: "project-1", role: "step", filename: "part.step", mediaType: "model/step", byteSize: 1, sha256: "a".repeat(64) }, context)).rejects.toThrow("audit store unavailable");
    expect(abortCalls).toEqual(["session-1"]);
    expect(filesystemSessionVisible).toBe(false);
  });

  it.each([
    { name: "idempotency persistence", idempotency: true },
    { name: "unit-of-work commit", idempotency: false }
  ])("aborts an opened upload after $name fails", async ({ idempotency }) => {
    const ports = fakePorts();
    let filesystemSessionVisible = false;
    let abortCalls = 0;
    ports.artifacts.beginUpload = async (input) => {
      filesystemSessionVisible = true;
      return { id: "session-1", artifactId: "artifact-1", expiresAt: "2026-08-30T01:00:00.000Z", maxBytes: input.byteSize, uploadUrl: "/uploads/session-1", status: "pending" } as UploadSession;
    };
    ports.artifacts.abortUpload = async () => {
      abortCalls += 1;
      filesystemSessionVisible = false;
    };
    const failureContext = idempotency ? { ...context, idempotencyKey: "begin-upload-retry" } : context;
    if (idempotency) {
      ports.idempotency.set = async () => { throw new Error("idempotency store unavailable"); };
    } else {
      ports.unitOfWork.run = async function<T>(operation: () => T | PromiseLike<T>): Promise<T> {
        await operation();
        throw new Error("unit-of-work commit unavailable");
      };
    }
    const service = new ApplicationService(ports);

    await expect(service.beginArtifactUpload({ projectId: "project-1", role: "step", filename: "part.step", mediaType: "model/step", byteSize: 1, sha256: "a".repeat(64) }, failureContext)).rejects.toThrow(/unavailable/u);
    expect(abortCalls).toBe(1);
    expect(filesystemSessionVisible).toBe(false);
  });

  it("creates a project and initial revision as one audited mutation", async () => {
    const ports = fakePorts();
    let atomicCalls = 0;
    ports.projects.createProjectWithInitialRevision = async (input) => {
      atomicCalls += 1;
      const project: Project = {
        id: input.project.id ?? "project-2",
        name: input.project.name,
        ...(input.project.description === undefined ? {} : { description: input.project.description }),
        status: input.project.status,
        currentRevisionId: input.revision.id ?? "rev-2",
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
        version: 1
      };
      const revision: ProjectRevision = {
        id: input.revision.id ?? "rev-2",
        projectId: project.id,
        number: 1,
        name: input.revision.name,
        ...(input.revision.notes === undefined ? {} : { notes: input.revision.notes }),
        status: input.revision.status,
        createdAt: project.createdAt,
        version: 1
      };
      return { project, revision };
    };
    const service = new ApplicationService(ports);

    const result = await service.createProjectWithInitialRevision({
      project: { id: "project-atomic", name: "Atomic lamp", status: "planned" },
      revision: { id: "revision-atomic", name: "Initial", status: "concept" }
    }, { ...context, idempotencyKey: "atomic-service-1" });

    expect(atomicCalls).toBe(1);
    expect(result.data).toMatchObject({ project: { id: "project-atomic", currentRevisionId: "revision-atomic" }, revision: { id: "revision-atomic", projectId: "project-atomic", number: 1 } });
    expect(result.audit).toMatchObject({ action: "project.create_with_initial_revision", entityType: "project", entityId: "project-atomic", idempotencyKey: "atomic-service-1" });
  });

  it("replays idempotent mutations, rejects fingerprint conflicts, and supports legacy records", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    const records = new Map<string, unknown>();
    let createCalls = 0;
    let publishCalls = 0;
    ports.idempotency.get = async (_actor, key) => records.get(key) ?? null;
    ports.idempotency.set = async (_actor, key, value) => { records.set(key, value); };
    ports.projects.createProject = async (input) => {
      createCalls += 1;
      return { id: input.id ?? "created-project", name: input.name, status: input.status, ...(input.description === undefined ? {} : { description: input.description }), createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1 };
    };
    ports.events.publish = () => { publishCalls += 1; };
    const idempotentContext = { ...context, idempotencyKey: "project-idempotency", fingerprint: "payload-a" };
    const first = await service.createProject({ id: "idempotent-project", name: "Idempotent project", status: "planned" }, idempotentContext);
    const replay = await service.createProject({ id: "idempotent-project", name: "Idempotent project", status: "planned" }, idempotentContext);
    expect(createCalls).toBe(1);
    expect(publishCalls).toBe(1);
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, data: first.data, audit: first.audit });
    await expect(service.createProject({ id: "idempotent-project", name: "Different project", status: "planned" }, { ...idempotentContext, fingerprint: "payload-b" })).rejects.toMatchObject({ code: "idempotency_conflict" });

    const legacyKey = "legacy-idempotency";
    records.set(legacyKey, first);
    const legacyReplay = await service.createProject({ id: "legacy-project", name: "Ignored by replay", status: "idea" }, { ...context, idempotencyKey: legacyKey });
    expect(legacyReplay).toMatchObject({ replayed: true, data: first.data, audit: first.audit });
  });

  it("keeps committed mutations successful when an event listener throws", async () => {
    const ports = fakePorts();
    let audited = 0;
    ports.audit.append = async (input) => {
      audited += 1;
      return { id: `audit-event-${audited}`, action: input.action, actor: input.actor, source: input.source, correlationId: input.correlationId, entityType: input.entityType, entityId: input.entityId, createdAt: "2026-08-30T00:00:00.000Z", ...(input.version === undefined ? {} : { version: input.version }) };
    };
    ports.events.publish = () => { throw new Error("subscriber failed"); };
    const service = new ApplicationService(ports);
    await expect(service.createProject({ id: "event-project", name: "Event-safe project", status: "idea" }, context)).resolves.toMatchObject({ data: { id: "event-project" }, replayed: false });
    expect(audited).toBe(1);
  });

  it("commits successful artifact finalization and retries closure on a replay", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    const records = new Map<string, unknown>();
    ports.idempotency.get = async (_actor, key) => records.get(key) ?? null;
    ports.idempotency.set = async (_actor, key, value) => { records.set(key, value); };
    let commitCalls = 0;
    ports.artifacts.finalizeUpload = async () => ({ id: "artifact-commit", projectId: "project-1", role: "step", filename: "part.step", mediaType: "model/step", byteSize: 1, sha256: "e".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-08-30T00:00:00.000Z", version: 1 });
    ports.artifacts.commitFinalization = async (sessionId, artifactId) => {
      expect(sessionId).toBe("session-1");
      expect(artifactId).toBe("artifact-commit");
      commitCalls += 1;
    };
    const idempotentContext = { ...context, idempotencyKey: "finalize-idempotency", fingerprint: "finalize-a" };
    await expect(service.finalizeArtifactUpload("session-1", idempotentContext)).resolves.toMatchObject({ data: { id: "artifact-commit" } });
    await expect(service.finalizeArtifactUpload("session-1", idempotentContext)).resolves.toMatchObject({ replayed: true, data: { id: "artifact-commit" } });
    expect(commitCalls).toBe(2);
  });

  it("retries receipt closure on the same-key replay after the database commit", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    const records = new Map<string, unknown>();
    ports.idempotency.get = async (_actor, key) => records.get(key) ?? null;
    ports.idempotency.set = async (_actor, key, value) => { records.set(key, value); };

    const artifact: Artifact = { id: "artifact-post-commit", projectId: "project-1", role: "step", filename: "part.step", mediaType: "model/step", byteSize: 1, sha256: "c".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-08-30T00:00:00.000Z", version: 1 };
    let uploadStatus: UploadSession["status"] = "pending";
    let filesystemArtifactVisible = false;
    let rollbackCalls = 0;
    let commitCalls = 0;
    ports.artifacts.getUploadSessionDetails = async () => ({ session: { id: "session-post-commit", artifactId: artifact.id, expiresAt: "2026-08-30T01:00:00.000Z", maxBytes: 1, uploadUrl: "/uploads/session-post-commit", status: uploadStatus }, projectId: artifact.projectId, revisionId: "rev-1" });
    ports.artifacts.finalizeUpload = async () => {
      uploadStatus = "finalized";
      filesystemArtifactVisible = true;
      return artifact;
    };
    ports.artifacts.commitFinalization = async () => {
      commitCalls += 1;
      if (commitCalls === 1) throw new Error("post-commit cleanup unavailable");
    };
    ports.artifacts.rollbackFinalization = async () => {
      rollbackCalls += 1;
      filesystemArtifactVisible = false;
    };
    const idempotentContext = { ...context, idempotencyKey: "post-commit-replay", fingerprint: "finalize-post-commit" };

    await expect(service.finalizeArtifactUpload("session-post-commit", idempotentContext)).rejects.toThrow("post-commit cleanup unavailable");
    expect(records.has(idempotentContext.idempotencyKey!)).toBe(true);
    expect(filesystemArtifactVisible).toBe(true);

    const replay = await service.finalizeArtifactUpload("session-post-commit", idempotentContext);
    expect(replay).toMatchObject({ replayed: true, data: artifact });
    expect(commitCalls).toBe(2);
    expect(rollbackCalls).toBe(0);
    expect(filesystemArtifactVisible).toBe(true);
  });

  it("does not compensate a committed artifact on a fresh-key retry of a finalized session", async () => {
    const ports = fakePorts();
    const service = new ApplicationService(ports);
    const records = new Map<string, unknown>();
    ports.idempotency.get = async (_actor, key) => records.get(key) ?? null;
    ports.idempotency.set = async (_actor, key, value) => { records.set(key, value); };

    const artifact: Artifact = { id: "artifact-fresh-retry", projectId: "project-1", role: "step", filename: "part.step", mediaType: "model/step", byteSize: 1, sha256: "d".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-08-30T00:00:00.000Z", version: 1 };
    let uploadStatus: UploadSession["status"] = "pending";
    let filesystemArtifactVisible = false;
    let rollbackCalls = 0;
    ports.artifacts.getUploadSessionDetails = async () => ({ session: { id: "session-fresh-retry", artifactId: artifact.id, expiresAt: "2026-08-30T01:00:00.000Z", maxBytes: 1, uploadUrl: "/uploads/session-fresh-retry", status: uploadStatus }, projectId: artifact.projectId, revisionId: "rev-1" });
    ports.artifacts.finalizeUpload = async () => {
      uploadStatus = "finalized";
      filesystemArtifactVisible = true;
      return artifact;
    };
    ports.artifacts.commitFinalization = async () => { throw new Error("post-commit cleanup unavailable"); };
    ports.artifacts.rollbackFinalization = async () => {
      rollbackCalls += 1;
      filesystemArtifactVisible = false;
    };
    const firstContext = { ...context, idempotencyKey: "fresh-retry-first", fingerprint: "finalize-first" };
    await expect(service.finalizeArtifactUpload("session-fresh-retry", firstContext)).rejects.toThrow("post-commit cleanup unavailable");
    expect(records.has(firstContext.idempotencyKey!)).toBe(true);
    expect(filesystemArtifactVisible).toBe(true);

    ports.audit.append = async () => { throw new Error("audit unavailable on fresh retry"); };
    await expect(service.finalizeArtifactUpload("session-fresh-retry", { ...context, idempotencyKey: "fresh-retry-second", fingerprint: "finalize-second" })).rejects.toThrow("audit unavailable on fresh retry");
    expect(rollbackCalls).toBe(0);
    expect(filesystemArtifactVisible).toBe(true);
  });

  it("reports integrity failure if a failed mutation cannot compensate artifact state", async () => {
    const ports = fakePorts();
    ports.artifacts.finalizeUpload = async () => ({ id: "artifact-uncompensated", projectId: "project-1", role: "step", filename: "part.step", mediaType: "model/step", byteSize: 1, sha256: "f".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-08-30T00:00:00.000Z", version: 1 });
    ports.artifacts.rollbackFinalization = async () => { throw new Error("rollback unavailable"); };
    ports.audit.append = async () => { throw new Error("audit unavailable"); };
    const service = new ApplicationService(ports);
    await expect(service.finalizeArtifactUpload("session-1", context)).rejects.toMatchObject({ code: "integrity_error" });
  });

  it("allows reviewed_no_change only as the sole outcome on an unreserved line", () => {
    const line: BomLine = {
      id: "bom-reconcile", revisionId: "rev-1", name: "Unused filament", requiredQuantity: 100, unit: "gram", optional: false,
      constraints: {}, alternatives: [], createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1
    };
    const noChange: ReconciliationLine = {
      bomLineId: line.id, outcomes: [{ kind: "reviewed_no_change", quantity: 0, unit: "gram", evidence: { state: "physically_counted" } }]
    };
    const source: ReconciliationSourceSnapshot = { projectId: "project-1", projectRevisionId: "rev-1", lines: [line], reservations: [], items: [item()] };
    expect(buildReconciliationDocument(source, [noChange], true).preview.stockChanges).toEqual([]);

    const active = { id: "reservation-reconcile", lineId: line.id, itemId: "item-1", quantity: 100, status: "active" as const, unit: "gram" as const, version: 1 };
    const reservedSource = { ...source, reservations: [active] };
    expect(() => buildReconciliationDocument(reservedSource, [noChange], false)).toThrow(/sole outcome.*zero active reserved quantity/i);
    const consumed = { kind: "consumed" as const, reservationId: active.id, itemId: active.itemId, quantity: 100, unit: "gram" as const, evidence: { state: "consumed" as const } };
    expect(() => buildReconciliationDocument(reservedSource, [{ ...noChange, outcomes: [noChange.outcomes[0]!, consumed] }], false)).toThrow(/sole outcome.*zero active reserved quantity/i);
  });

  it("labels reconciliation preview totals in the active reservation unit and fails closed on mixed units", () => {
    const line: BomLine = {
      id: "bom-reconcile-units", revisionId: "rev-1", name: "LED package", requiredQuantity: 10, unit: "each", optional: false,
      constraints: {}, alternatives: [], createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", version: 1
    };
    const eachItem = item({ id: "reconcile-each", unit: "each", quantity: 10, availableQuantity: 0 });
    const setItem = item({ id: "reconcile-set", unit: "set", quantity: 2, availableQuantity: 0 });
    const setReservation = { id: "reconcile-set-reservation", lineId: line.id, itemId: setItem.id, quantity: 2, status: "active" as const, unit: "set" as const, version: 1 };
    const eachReservation = { id: "reconcile-each-reservation", lineId: line.id, itemId: eachItem.id, quantity: 1, status: "active" as const, unit: "each" as const, version: 1 };
    const source: ReconciliationSourceSnapshot = { projectId: "project-1", projectRevisionId: "rev-1", lines: [line], reservations: [setReservation], items: [eachItem, setItem] };
    const preview = buildReconciliationDocument(source, [], false).preview;
    expect(preview.lines[0]).toMatchObject({ reservedQuantity: 2, accountedQuantity: 0, unaccountedQuantity: 2, unit: "set" });

    const unreserved = buildReconciliationDocument({ ...source, reservations: [] }, [], false).preview;
    expect(unreserved.lines[0]).toMatchObject({ reservedQuantity: 0, accountedQuantity: 0, unaccountedQuantity: 0, unit: "each" });
    expect(() => buildReconciliationDocument({ ...source, reservations: [setReservation, eachReservation] }, [], false)).toThrow(/mixed.*reservation.*unit/i);
  });

  it("rejects a direct reservation that would mix active reservation units on one BOM line", async () => {
    const eachItem = item({ id: "reservation-each", unit: "each", quantity: 20, availableQuantity: 20 });
    const setItem = item({ id: "reservation-set", unit: "set", quantity: 2, availableQuantity: 2 });
    const ports = fakePorts(eachItem);
    ports.inventory.listItems = async () => ({ data: [eachItem, setItem], limit: 200 });
    ports.inventory.getItem = async (id) => id === eachItem.id ? eachItem : id === setItem.id ? setItem : null;
    ports.projects.listReservations = async () => [{ id: "existing-set-reservation", lineId: "bom-mixed-reservation", itemId: setItem.id, quantity: 1, status: "active", createdAt: eachItem.createdAt, updatedAt: eachItem.updatedAt, version: 1 }];
    const service = new ApplicationService(ports);
    await service.createBomLine("rev-1", {
      id: "bom-mixed-reservation", name: "LED package", itemId: eachItem.id, requiredQuantity: 20, unit: "each", optional: false, constraints: {},
      alternatives: [{ itemId: setItem.id, compatible: "confirmed", quantityConversion: { inventory: { quantity: 1, unit: "set" }, requirement: { quantity: 10, unit: "each" }, evidence: { basis: "package_label", observedAt: "2026-09-02T00:00:00.000Z" } } }]
    }, context);

    await expect(service.createReservation("rev-1", { lineId: "bom-mixed-reservation", itemId: eachItem.id, quantity: 1 }, context)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/mixed.*reservation.*unit/i) });
  });

  it("reports mixed active reservation units as a setup preview validation error", async () => {
    const eachItem = item({ id: "setup-each", unit: "each", quantity: 20, availableQuantity: 20 });
    const setItem = item({ id: "setup-set", unit: "set", quantity: 2, availableQuantity: 2 });
    const ports = fakePorts(eachItem);
    ports.inventory.listItems = async () => ({ data: [eachItem, setItem], limit: 200 });
    ports.inventory.getItem = async (id) => id === eachItem.id ? eachItem : id === setItem.id ? setItem : null;
    ports.projects.getProjectRevision = async () => null;
    const service = new ApplicationService(ports);
    const preview = await service.previewProjectSetup({
      project: { id: "setup-mixed-project", name: "Mixed setup", status: "planned" },
      revision: { id: "setup-mixed-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "mixed-line", id: "setup-mixed-line", name: "LED package", itemId: eachItem.id, requiredQuantity: 20, unit: "each", optional: false, constraints: {}, alternatives: [{ itemId: setItem.id, compatible: "confirmed", quantityConversion: { inventory: { quantity: 1, unit: "set" }, requirement: { quantity: 10, unit: "each" }, evidence: { basis: "package_label", observedAt: "2026-09-02T00:00:00.000Z" } } }] }],
      reservations: [
        { localRef: "each-reservation", bomLineLocalRef: "mixed-line", id: "setup-each-reservation", itemId: eachItem.id, quantity: 1, unit: "each" },
        { localRef: "set-reservation", bomLineLocalRef: "mixed-line", id: "setup-set-reservation", itemId: setItem.id, quantity: 1, unit: "set" }
      ]
    }, context);

    expect(preview.fieldErrors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unit_mismatch", message: expect.stringMatching(/mixed.*reservation.*unit/i) })]));
  });
});
