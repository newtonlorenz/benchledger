import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createSampleWorkspaceAdapter, createWorkspaceAdapter, mapInventoryItem } from "./api";
import { loadAllInventoryCategories } from "./App";
import type { Artifact, InventoryItem, Project } from "./domain";

type ServerInventoryItem = Parameters<typeof mapInventoryItem>[0];

const serverItem = (overrides: Partial<ServerInventoryItem> = {}): ServerInventoryItem => ({
  id: "item-1",
  name: "Maker item",
  kind: "accessory",
  quantity: 1,
  availableQuantity: 1,
  unit: "each",
  tags: [],
  links: [],
  evidence: { state: "physically_counted" },
  createdAt: "2026-08-30T10:00:00.000Z",
  updatedAt: "2026-08-30T10:00:00.000Z",
  version: 1,
  ...overrides
});

const serverArtifact = (overrides: Record<string, unknown> = {}) => ({
  id: "artifact-1",
  projectId: "project-1",
  revisionId: "revision-1",
  role: "step",
  filename: "model.step",
  mediaType: "model/step",
  byteSize: 1,
  sha256: "a".repeat(64),
  currentCandidate: false,
  retired: false,
  createdAt: "2026-08-30T10:00:00.000Z",
  version: 1,
  ...overrides
});

const serverProject = (overrides: Record<string, unknown> = {}) => ({
  id: "project-1",
  name: "Maker project",
  description: "A useful printed thing",
  status: "planning",
  currentRevisionId: "revision-1",
  createdAt: "2026-08-30T10:00:00.000Z",
  updatedAt: "2026-08-30T10:00:00.000Z",
  version: 1,
  ...overrides
});

const serverRevision = (overrides: Record<string, unknown> = {}) => ({
  id: "revision-1",
  projectId: "project-1",
  number: 1,
  name: "Initial concept",
  status: "concept",
  createdAt: "2026-08-30T10:00:00.000Z",
  version: 1,
  ...overrides
});

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("authenticated BenchLedger API adapter", () => {
  it("follows opaque cursors when loading all managed categories", async () => {
    const calls: Array<{ limit?: number; cursor?: string }> = [];
    const categories = [
      { id: "category-tools", name: "Tools", sortOrder: 0, archived: false, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 },
      { id: "category-electronics", name: "Electronics", sortOrder: 1, archived: false, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }
    ] as const;
    const adapter = {
      listInventoryCategories: async (options: { limit?: number; cursor?: string } = {}) => {
        calls.push(options);
        return options.cursor === undefined
          ? { data: categories.slice(0, 1), limit: 1, total: 2, nextCursor: "opaque-next" }
          : { data: categories.slice(1), limit: 1, total: 2 };
      }
    };

    await expect(loadAllInventoryCategories(adapter, 1)).resolves.toEqual(categories);
    expect(calls).toEqual([{ limit: 1 }, { limit: 1, cursor: "opaque-next" }]);
  });

  it("keeps quick-create identity separate while retrying the same category assignment", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-quick-category" });
    const requestBodies: string[] = [];
    const requestKeys: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return Promise.reject(new TypeError("response lost after commit"));
      })
      .mockImplementationOnce(async (_input, init) => {
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return jsonResponse({ data: serverItem({ id: "quick-tool", kind: "tool", categoryNodeId: "category-tools", name: "Hex driver" }) });
      });

    const adapter = createWorkspaceAdapter();
    const input = { name: "Hex driver", category: "Accessories" as const, kind: "tool", categoryNodeId: "category-tools", quantity: 1, unit: "each" as const };
    await expect(adapter.createInventoryItem(input)).rejects.toMatchObject({ kind: "offline" });
    await expect(adapter.createInventoryItem(input)).resolves.toMatchObject({ id: "quick-tool", kind: "tool", categoryNodeId: "category-tools" });
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(JSON.parse(requestBodies[0]!)).toMatchObject({ name: "Hex driver", kind: "tool", categoryNodeId: "category-tools", quantity: 1, unit: "each" });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-csrf-token")).toBe("csrf-quick-category");
  });

  it("sends CSRF, idempotency, and optimistic versions for category mutations", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-category-mutation" });
    const category = { id: "category-tools", name: "Tools", sortOrder: 0, archived: false, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: category }))
      .mockResolvedValueOnce(jsonResponse({ data: { ...category, name: "Bench tools", sortOrder: 2, version: 2 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { ...category, name: "Bench tools", sortOrder: 2, archived: true, version: 3 } }));
    const adapter = createWorkspaceAdapter();

    await adapter.createInventoryCategory({ name: "Tools", sortOrder: 0 });
    await adapter.updateInventoryCategory("category-tools", { name: "Bench tools", sortOrder: 2 }, 1);
    await adapter.archiveInventoryCategory("category-tools", 2);

    const createInit = fetchMock.mock.calls[0]?.[1];
    const updateInit = fetchMock.mock.calls[1]?.[1];
    const archiveInit = fetchMock.mock.calls[2]?.[1];
    expect(new Headers(createInit?.headers).get("x-csrf-token")).toBe("csrf-category-mutation");
    expect(new Headers(createInit?.headers).get("idempotency-key")).toMatch(/^web-inventory-category-/);
    expect(new Headers(updateInit?.headers).get("if-match")).toBe("1");
    expect(new Headers(updateInit?.headers).get("idempotency-key")).toMatch(/^web-inventory-category-update-/);
    expect(JSON.parse(String(updateInit?.body))).toEqual({ name: "Bench tools", sortOrder: 2 });
    expect(new Headers(archiveInit?.headers).get("if-match")).toBe("2");
    expect(new Headers(archiveInit?.headers).get("idempotency-key")).toMatch(/^web-inventory-category-archive-/);
  });

  it("reuses a category mutation key after an ambiguous response", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-category-retry" });
    const category = { id: "category-tools", name: "Bench tools", sortOrder: 2, archived: false, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 2 };
    const requestKeys: string[] = [];
    const requestBodies: string[] = [];
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        requestBodies.push(String(init?.body));
        return Promise.reject(new TypeError("response lost after commit"));
      })
      .mockImplementationOnce(async (_input, init) => {
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        requestBodies.push(String(init?.body));
        return jsonResponse({ data: category });
      })
      .mockImplementationOnce(async (_input, init) => {
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        requestBodies.push(String(init?.body));
        return jsonResponse({ data: { ...category, version: 3 } });
      });

    const adapter = createWorkspaceAdapter();
    const input = { name: "Bench tools", sortOrder: 2 };
    await expect(adapter.updateInventoryCategory("category-tools", input, 1)).rejects.toMatchObject({ kind: "offline" });
    await expect(adapter.updateInventoryCategory("category-tools", input, 1)).resolves.toMatchObject(category);
    await expect(adapter.updateInventoryCategory("category-tools", input, 1)).resolves.toMatchObject({ version: 3 });
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(requestKeys[0]).toMatch(/^web-inventory-category-update-/);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(requestKeys[2]).not.toBe(requestKeys[1]);
    expect(requestBodies[2]).toBe(requestBodies[1]);
  });

  it("reuses a category create key after a lost response", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-category-create-retry" });
    const category = { id: "category-new", name: "New category", sortOrder: 4, archived: false, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 };
    const requestKeys: string[] = [];
    const requestBodies: string[] = [];
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        requestBodies.push(String(init?.body));
        return Promise.reject(new TypeError("response lost after commit"));
      })
      .mockImplementationOnce(async (_input, init) => {
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        requestBodies.push(String(init?.body));
        return jsonResponse({ data: category });
      });

    const adapter = createWorkspaceAdapter();
    const input = { name: "New category", sortOrder: 4 };
    await expect(adapter.createInventoryCategory(input)).rejects.toMatchObject({ kind: "offline" });
    await expect(adapter.createInventoryCategory(input)).resolves.toMatchObject(category);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(JSON.parse(requestBodies[0]!)).toEqual({ name: "New category", sortOrder: 4 });
  });

  it("reuses an archive key after a lost response and refreshes it after success", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-category-archive-retry" });
    const category = { id: "category-tools", name: "Tools", sortOrder: 0, archived: true, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 2 };
    const requestKeys: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return Promise.reject(new TypeError("response lost after commit"));
      })
      .mockImplementationOnce(async (_input, init) => {
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return jsonResponse({ data: category });
      })
      .mockImplementationOnce(async (_input, init) => {
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return jsonResponse({ data: { ...category, version: 3 } });
      });

    const adapter = createWorkspaceAdapter();
    await expect(adapter.archiveInventoryCategory("category-tools", 1)).rejects.toMatchObject({ kind: "offline" });
    await expect(adapter.archiveInventoryCategory("category-tools", 1)).resolves.toMatchObject(category);
    await expect(adapter.archiveInventoryCategory("category-tools", 1)).resolves.toMatchObject({ version: 3 });
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(requestKeys[0]).toMatch(/^web-inventory-category-archive-/);
    expect(requestKeys[2]).not.toBe(requestKeys[1]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-csrf-token")).toBe("csrf-category-archive-retry");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("if-match")).toBe("1");
  });

  it("keeps sample category rename validation aligned with the managed API", async () => {
    const adapter = createSampleWorkspaceAdapter();
    await expect(adapter.updateInventoryCategory("category-tools", { name: "Filament" }, 1)).rejects.toMatchObject({ status: 409, message: "A category with this name already exists beside it." });
  });

  it("filters sample inventory by managed assignment before paginating", async () => {
    const adapter = createSampleWorkspaceAdapter();
    const assigned = await adapter.createInventoryItem({ name: "Assigned driver", category: "Accessories", categoryNodeId: "category-tools", kind: "tool", quantity: 1, unit: "each" });
    const categoryPage = await adapter.listInventory({ categoryNodeId: "category-tools", limit: 1 });
    expect(categoryPage).toMatchObject({ items: [{ id: assigned.id }], total: 1 });
    const unassignedPage = await adapter.listInventory({ unassigned: true, limit: 200 });
    expect(unassignedPage.items.some((item) => item.id === assigned.id)).toBe(false);
  });

  it("keeps sample inventory pagination bounds aligned with the REST contract", async () => {
    const adapter = createSampleWorkspaceAdapter();
    await expect(adapter.listInventory({ q: "x".repeat(201), limit: 25 })).rejects.toMatchObject({ kind: "validation", status: 400 });
    await expect(adapter.listInventory({ limit: 201 })).rejects.toMatchObject({ kind: "validation", status: 400 });
    await expect(adapter.listInventory({ cursor: "1".repeat(201), limit: 25 })).rejects.toMatchObject({ kind: "validation", status: 400, code: "invalid_cursor" });
    await expect(adapter.listInventory({ categoryNodeId: "category-tools", unassigned: true, limit: 25 })).rejects.toMatchObject({ kind: "validation", status: 400 });
  });

  it("requests inventory pages from the server and maps pagination without slicing a workspace snapshot", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      data: [serverItem({ id: "item-page", name: "Paged item" })], limit: 10, total: 21, nextCursor: "10"
    }));
    const adapter = createWorkspaceAdapter();
    const result = await adapter.listInventory({ q: "  ESP32 ", kind: "electronic", evidence: "physically_counted", available: true, categoryNodeId: "category-electronics", limit: 10, cursor: "20" });
    expect(result).toMatchObject({ items: [{ id: "item-page", name: "Paged item" }], limit: 10, total: 21, nextCursor: "10" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/v1/inventory?");
    expect(new URL(String(url), "http://localhost").search).toBe("?q=ESP32&kind=electronic&evidence=physically_counted&available=true&categoryNodeId=category-electronics&limit=10&cursor=20");
  });

  it("bounds an overlong inventory search before sending it to the server", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: [], limit: 25, total: 0 }));
    const adapter = createWorkspaceAdapter();

    await adapter.listInventory({ q: `${"x".repeat(201)}  `, limit: 25 });

    const [url] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url), "http://localhost").searchParams.get("q")).toBe("x".repeat(200));
  });

  it("surfaces an authentication boundary instead of silently showing synthetic data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "0.1.0", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "unauthenticated", message: "Authentication is required" } }, 401));

    const adapter = createWorkspaceAdapter();
    await expect(adapter.loadWorkspace()).rejects.toMatchObject({ kind: "unauthenticated" });
    await expect(adapter.loadWorkspace()).rejects.toBeInstanceOf(ApiError);
  });

  it("logs in with a session and sends the CSRF token on a real physical count", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf-from-login", expiresAt: "2026-08-31T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ data: { event: { id: "event-1" }, item: { id: "item-1", name: "ESP32", quantity: 4, availableQuantity: 4, unit: "each", kind: "electronic", tags: [], links: [], evidence: { state: "physically_counted" }, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 2 } }, audit: {}, correlationId: "corr-1", replayed: false }));

    const adapter = createWorkspaceAdapter();
    await adapter.login("correct-password");
    const result = await adapter.recordCount("item-1", 4);
    expect(result.id).toBe("item-1");
    const [, countRequest] = fetchMock.mock.calls;
    expect(countRequest?.[1]).toMatchObject({ credentials: "include", method: "POST" });
    const init = countRequest?.[1] as RequestInit;
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-from-login");
    expect(new Headers(init.headers).get("idempotency-key")).toMatch(/^web-count-/);
    expect(countRequest?.[0]).toContain("/api/v1/inventory/item-1/count");
    expect(JSON.parse(String(init.body))).toMatchObject({ quantity: 4 });
  });

  it("commissions uncertain stock with provenance, version, and idempotency headers", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=commission-token" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      data: { event: { id: "event-commission-1" }, item: serverItem({ quantity: 3, availableQuantity: 3, evidence: { state: "commissioned", source: "bench check", observedAt: "2026-08-30T12:00:00.000Z" }, version: 2 }) }
    }));

    const adapter = createWorkspaceAdapter();
    const result = await adapter.commissionInventoryItem("item-1", {
      quantity: 3,
      source: "bench check",
      sourceId: "check-1",
      observedAt: "2026-08-30T12:00:00.000Z",
      note: "Counted in drawer 2"
    }, 1);

    expect(result).toMatchObject({ id: "item-1", evidence: "commissioned", quantity: 3 });
    const [url, rawInit] = fetchMock.mock.calls[0]!;
    const init = rawInit as RequestInit;
    expect(url).toContain("/api/v1/inventory/item-1/commission");
    expect(init).toMatchObject({ credentials: "include", method: "POST" });
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBe("commission-token");
    expect(headers.get("if-match")).toBe("1");
    expect(headers.get("idempotency-key")).toMatch(/^web-commission-/);
    expect(JSON.parse(String(init.body))).toEqual({
      quantity: 3,
      unit: "each",
      evidence: { state: "commissioned", source: "bench check", sourceId: "check-1", observedAt: "2026-08-30T12:00:00.000Z", note: "Counted in drawer 2" }
    });
  });

  it("patches editable inventory fields with the current item version", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=edit-token" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      data: serverItem({
        name: "ESP32-S3 development board",
        description: "Controller board for bench prototypes.",
        manufacturer: "Espressif",
        model: "DevKitC-1",
        sku: "ESP32-S3-DEVKITC-1",
        location: "Electronics drawer 2",
        tags: ["esp32", "controller"],
        version: 4
      })
    }));

    const adapter = createWorkspaceAdapter();
    const result = await adapter.updateInventoryItem("item-1", {
      name: "ESP32-S3 development board",
      description: "Controller board for bench prototypes.",
      model: "DevKitC-1",
      manufacturer: "Espressif",
      sku: "ESP32-S3-DEVKITC-1",
      location: "Electronics drawer 2",
      tags: ["esp32", "controller"]
    }, 3);

    expect(result).toMatchObject({ name: "ESP32-S3 development board", variant: "DevKitC-1", version: 4 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/v1/inventory/item-1");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe("edit-token");
    expect(new Headers(init?.headers).get("if-match")).toBe("3");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "ESP32-S3 development board",
      description: "Controller board for bench prototypes.",
      model: "DevKitC-1",
      manufacturer: "Espressif",
      sku: "ESP32-S3-DEVKITC-1",
      location: "Electronics drawer 2",
      tags: ["esp32", "controller"]
    });
  });

  it("maps the real page payloads into the UI models and never turns a failed write into a local write", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-from-session" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "0.1.0", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [{ id: "printer-h2d", name: "Bambu Lab H2D", kind: "printer", quantity: 1, availableQuantity: 1, unit: "each", tags: ["3d-printing"], links: [], evidence: { state: "commissioned" }, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }], projects: [{ id: "project-1", name: "Desk light", description: "A small light", status: "planning", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1, workItems: [{ id: "work-1", projectId: "project-1", name: "Enclosure", kind: "part", description: "Printed enclosure", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }], bom: [], artifacts: [], currentRevision: { id: "revision-1", projectId: "project-1", number: 2, name: "Fit pass", status: "CAD complete", notes: "Check the USB cutout", createdAt: "2026-08-30T10:00:00.000Z", version: 1, bom: [{ id: "bom-1", revisionId: "revision-1", name: "ESP32 board", itemId: "board-esp32", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }], artifacts: [{ id: "artifact-1", projectId: "project-1", revisionId: "revision-1", role: "step", filename: "enclosure.step", mediaType: "model/step", byteSize: 2048, sha256: "a".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-08-30T10:00:00.000Z", version: 1 }] } }], offers: [] }));

    const adapter = createWorkspaceAdapter();
    const snapshot = await adapter.loadWorkspace();
    expect(snapshot.source).toBe("api");
    expect(snapshot.inventory[0]).toMatchObject({ id: "printer-h2d", category: "Printers", unit: "each", state: "available" });
    expect(snapshot.projects[0]).toMatchObject({ id: "project-1", name: "Desk light", status: "In progress", workItem: "Enclosure", currentRevision: "r02", serverRevisionId: "revision-1" });
    expect(snapshot.projects[0]?.bom[0]).toMatchObject({ label: "ESP32 board", itemId: "board-esp32", required: 1 });
    expect(snapshot.projects[0]?.artifacts[0]).toMatchObject({ name: "enclosure.step", role: "STEP", revision: "r02", size: "2 KB" });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    await expect(adapter.createProject({ name: "No local fallback", description: "must fail" })).rejects.toMatchObject({ kind: "offline" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rehydrates exact product IDs and persisted setup for a fresh workspace load", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-reload" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "0.1.0", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({
        source: "api",
        fetchedAt: "2026-08-30T10:00:00.000Z",
        inventory: [{
          id: "printer-1", name: "H2D", kind: "printer", quantity: 1, availableQuantity: 1, unit: "each", tags: ["printer"], links: [],
          evidence: { state: "commissioned" }, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1,
          catalogProduct: { id: "catalog-printer-h2d", kind: "printer", manufacturer: "Bambu Lab", exactModel: "H2D", technology: "fff", buildVolumeMm: { x: 325, y: 320, z: 325 }, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 },
          productProfile: { id: "profile-printer-1", itemId: "printer-1", catalogProductId: "catalog-printer-h2d", profileType: "printer_asset", linkState: "confirmed", details: { assetLabel: "H2D-01" }, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }
        }],
        projects: [{
          id: "project-reload", name: "Reload test", status: "planning", currentRevisionId: "revision-reload", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1,
          workItems: [], bom: [], artifacts: [], currentRevision: {
            id: "revision-reload", projectId: "project-reload", number: 2, name: "Setup", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1, bom: [], artifacts: [],
            buildConfigSnapshot: {
              id: "build-config-reload", projectRevisionId: "revision-reload",
              printerItemSnapshot: { itemId: "printer-1", catalogProductId: "catalog-printer-h2d", profileId: "profile-printer-1", linkState: "confirmed", manufacturer: "Bambu Lab", exactModel: "H2D" },
              filamentSelections: [], activeHotend: "left", nozzle: "Not recorded", plate: "Textured PEI", accessories: [], firmware: "01.08", slicer: "Bambu Studio", profile: "0.20 mm", calibration: "checked", explicitUnknowns: [], contentSha256: "a".repeat(64), createdAt: "2026-08-30T10:00:00.000Z"
            }
          }
        }],
        offers: []
      }));

    const snapshot = await createWorkspaceAdapter().loadWorkspace();
    expect(snapshot.inventory[0]).toMatchObject({
      catalogProduct: { id: "catalog-printer-h2d", exactModel: "H2D" },
      productProfile: { id: "profile-printer-1", catalogProductId: "catalog-printer-h2d", linkState: "confirmed" }
    });
    expect(snapshot.projects[0]?.buildConfigSnapshot).toMatchObject({
      id: "build-config-reload",
      revisionId: "revision-reload",
      printerItemId: "printer-1",
      printerProductId: "catalog-printer-h2d",
      printerProfileId: "profile-printer-1"
    });
  });

  it("keeps the project vertical slice on real endpoints", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-project" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf-project", expiresAt: "2026-08-31T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        project: { id: "project-new", name: "Desk enclosure", description: "A small enclosure", status: "idea", currentRevisionId: "revision-new", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 },
        revision: { id: "revision-new", projectId: "project-new", number: 1, name: "Initial concept", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 }
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "revision-next", projectId: "project-new", number: 2, name: "Fit pass", status: "CAD complete", createdAt: "2026-08-30T10:00:00.000Z", version: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "bom-new", revisionId: "revision-next", name: "ESP32 board", itemId: "board-esp32", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 } }));

    const adapter = createWorkspaceAdapter();
    await adapter.login("correct-password");
    const created = await adapter.createProject({ name: "Desk enclosure", description: "A small enclosure" });
    expect(created).toMatchObject({ id: "project-new", currentRevision: "r01", serverRevisionId: "revision-new" });
    const revised = await adapter.createRevision(created.id, { name: "Fit pass", status: "CAD complete" });
    expect(revised).toMatchObject({ currentRevision: "r02", serverRevisionId: "revision-next", bom: [] });
    const withBom = await adapter.createBomLine(created.id, { name: "ESP32 board", requiredQuantity: 1, unit: "each", itemId: "board-esp32" });
    expect(withBom.bom[0]).toMatchObject({ label: "ESP32 board", itemId: "board-esp32" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/v1/auth/login",
      "/api/v1/projects/with-initial-revision",
      "/api/v1/projects/project-new/revisions",
      "/api/v1/project-revisions/revision-next/bom"
    ]);
    for (const [, init] of fetchMock.mock.calls.slice(1)) expect(new Headers(init?.headers).get("x-csrf-token")).toBe("csrf-project");
  });

  it("reuses a project command key after an ambiguous response, then releases it for a later identical create", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-project-retry" });
    const requestBodies: string[] = [];
    const requestKeys: string[] = [];
    let writeCount = 0;
    const responseFor = (id: string) => jsonResponse({ data: {
      project: serverProject({ id, name: "Retry project", description: "A safely retried project", currentRevisionId: `revision-${id}` }),
      revision: serverRevision({ id: `revision-${id}`, projectId: id })
    } });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        writeCount += 1;
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        // The server has committed before the response is lost. A retry must
        // replay the same atomic project + initial revision command.
        return Promise.reject(new TypeError("response lost after commit"));
      })
      .mockImplementationOnce(async (_input, init) => {
        writeCount += 1;
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return responseFor("project-changed");
      })
      .mockImplementationOnce(async (_input, init) => {
        writeCount += 1;
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return responseFor("project-replayed");
      })
      .mockImplementationOnce(async (_input, init) => {
        writeCount += 1;
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return responseFor("project-new");
      });

    const adapter = createWorkspaceAdapter();
    const input = { name: "Retry project", description: "A safely retried project" };
    await expect(adapter.createProject(input)).rejects.toMatchObject({ kind: "offline" });

    const changed = await adapter.createProject({ ...input, description: "A changed project" });
    expect(changed).toMatchObject({ id: "project-changed" });
    expect(writeCount).toBe(2);
    expect(requestKeys[1]).not.toBe(requestKeys[0]);
    expect(requestBodies[1]).not.toBe(requestBodies[0]);

    const replayed = await adapter.createProject(input);
    expect(replayed).toMatchObject({ id: "project-replayed", currentRevision: "r01", serverRevisionId: "revision-project-replayed" });
    expect(writeCount).toBe(3);
    expect(requestBodies[2]).toBe(requestBodies[0]);
    expect(requestKeys[2]).toBe(requestKeys[0]);
    expect(requestKeys[0]).toMatch(/^web-project-/);
    expect(JSON.parse(requestBodies[0]!)).toEqual({
      project: { name: "Retry project", description: "A safely retried project", status: "idea" },
      revision: { name: "Initial concept", status: "concept" }
    });

    // Once replay succeeds, a later intentional identical create gets a fresh
    // command identity rather than inheriting the resolved retry key.
    await adapter.createProject(input);
    expect(writeCount).toBe(4);
    expect(requestKeys[3]).not.toBe(requestKeys[0]);
    expect(requestBodies[3]).toBe(requestBodies[0]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reuses a revision command key after an ambiguous response, then releases it for a later revision", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-revision-retry" });
    const committedRevision = serverRevision({ id: "revision-replayed", number: 2, name: "Fit pass", status: "CAD complete" });
    const requestBodies: string[] = [];
    const requestKeys: string[] = [];
    let revisionWriteCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "0.1.0", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [], projects: [{ ...serverProject(), currentRevision: serverRevision({ id: "revision-1", number: 1 }) }], offers: [] }))
      .mockImplementationOnce(async (_input, init) => {
        revisionWriteCount += 1;
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        // The server has committed before the response is lost. A retry must
        // replay this same command instead of creating a second revision.
        return Promise.reject(new TypeError("response lost after commit"));
      })
      .mockImplementationOnce(async (_input, init) => {
        revisionWriteCount += 1;
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return jsonResponse({ data: committedRevision });
      });

    const adapter = createWorkspaceAdapter();
    await adapter.loadWorkspace();
    await expect(adapter.createRevision("project-1", { name: "Fit pass", status: "CAD complete" })).rejects.toMatchObject({ kind: "offline" });

    const replayed = await adapter.createRevision("project-1", { name: "Fit pass", status: "CAD complete" });
    expect(replayed).toMatchObject({ serverRevisionId: "revision-replayed", currentRevision: "r02" });
    expect(revisionWriteCount).toBe(2);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(requestKeys[0]).toMatch(/^web-revision-/);

    // Once the replay succeeds, an intentional later revision gets a fresh
    // command identity even when its fields happen to be identical.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: serverRevision({ id: "revision-new", number: 3, name: "Fit pass", status: "CAD complete" }) }));
    await adapter.createRevision("project-1", { name: "Fit pass", status: "CAD complete" });
    expect(requestKeys).toHaveLength(2);
    const newRequest = fetchMock.mock.calls.at(-1)?.[1];
    expect(new Headers(newRequest?.headers).get("idempotency-key")).not.toBe(requestKeys[0]);
  });

  it("reuses an exact-inventory command key after an ambiguous response, then releases it for a later identical create", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-exact-inventory-retry" });
    const product = {
      id: "catalog-filament-petg",
      kind: "filament" as const,
      manufacturer: "Bambu Lab",
      family: "PETG",
      model: "PETG HF",
      variant: "HF",
      colour: "Black",
      productCode: "PETG-HF-BLK",
      diameterMm: 1.75,
      netMassG: 1000
    };
    const input = {
      category: "Filament" as const,
      product,
      quantity: 1000,
      linkState: "reported" as const,
      filament: { lotBatch: "LOT-1", state: "opened" as const, openedAt: "2026-08-30", tareMassG: 164, placement: "AMS slot 1" }
    };
    const requestBodies: string[] = [];
    const requestKeys: string[] = [];
    let writeCount = 0;
    const committedItem = (id: string) => serverItem({ id, name: "Bambu Lab PETG HF Black", kind: "filament", quantity: 1000, availableQuantity: 0, unit: "gram", manufacturer: "Bambu Lab", sku: "PETG-HF-BLK", evidence: { state: "unknown" } });
    const committedProfile = (itemId: string) => ({ id: `profile-${itemId}`, itemId, catalogProductId: product.id, profileType: "filament_spool", linkState: "reported", details: { lot: "LOT-1", openedState: "open", openedAt: "2026-08-30T00:00:00.000Z", tareMassG: 164, currentPlacement: "AMS slot 1" } });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        writeCount += 1;
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        // The server has committed before the response is lost. A retry must
        // replay this same compound command instead of creating a duplicate item/profile pair.
        return Promise.reject(new TypeError("response lost after commit"));
      })
      .mockImplementationOnce(async (_input, init) => {
        writeCount += 1;
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return jsonResponse({ data: { item: committedItem("spool-replayed"), profile: committedProfile("spool-replayed") } });
      })
      .mockImplementationOnce(async (_input, init) => {
        writeCount += 1;
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return jsonResponse({ data: { item: committedItem("spool-new"), profile: committedProfile("spool-new") } });
      });

    const adapter = createWorkspaceAdapter();
    await expect(adapter.createExactInventoryItem(input)).rejects.toMatchObject({ kind: "offline" });

    const replayed = await adapter.createExactInventoryItem(input);
    expect(replayed).toMatchObject({ id: "spool-replayed", catalogProduct: { id: product.id }, productProfile: { id: "profile-spool-replayed" } });
    expect(writeCount).toBe(2);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(requestKeys[0]).toMatch(/^web-exact-inventory-/);

    // Once the replay succeeds, an intentional later identical create gets a fresh command identity.
    await adapter.createExactInventoryItem(input);
    expect(writeCount).toBe(3);
    expect(requestKeys[2]).not.toBe(requestKeys[0]);
    expect(requestBodies[2]).toBe(requestBodies[0]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses canonical catalog fields and a separate product-profile write for exact inventory", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-catalog" });
    const canonicalProduct = {
      id: "catalog-filament-petg",
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
      sku: "PETG-HF-BLK",
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
      version: 1
    } as const;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: [canonicalProduct], limit: 50, total: 1 }))
      .mockResolvedValueOnce(jsonResponse({ data: canonicalProduct }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        item: serverItem({ id: "spool-1", name: "PETG HF", kind: "filament", quantity: 1000, availableQuantity: 0, unit: "gram", evidence: { state: "unknown" } }),
        profile: {
          id: "profile-spool-1", itemId: "spool-1", catalogProductId: canonicalProduct.id, profileType: "filament_spool", linkState: "reported",
          details: { lot: "LOT-1", openedState: "open", openedAt: "2026-08-30T00:00:00.000Z", tareMassG: 164, currentPlacement: "AMS slot 1" },
          createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1
        }
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        id: "catalog-printer-h2d", kind: "printer", manufacturer: "Bambu Lab", exactModel: "H2D", exactVariant: "AMS Combo", technology: "fff", buildVolumeMm: { x: 325, y: 320, z: 325 },
        createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1
      } }));

    const adapter = createWorkspaceAdapter();
    const search = await adapter.searchCatalogProducts("filament", "PETG");
    expect(search[0]).toMatchObject({ id: canonicalProduct.id, family: "PETG", model: "PETG HF", colour: "Black", netMassG: 1000, sku: "PETG-HF-BLK" });
    const createdProduct = await adapter.createCatalogProduct({ kind: "filament", manufacturer: "Bambu Lab", family: "PETG", model: "PETG HF", variant: "HF", colour: "Black", colourCode: "BK", diameterMm: 1.75, netMassG: 1000 });
    expect(createdProduct).toMatchObject({ id: canonicalProduct.id, materialFamily: "PETG" });
    const exact = await adapter.createExactInventoryItem({ category: "Filament", categoryNodeId: "category-filament", product: createdProduct, quantity: 1000, linkState: "reported", filament: { lotBatch: "LOT-1", state: "opened", openedAt: "2026-08-30", tareMassG: 164, placement: "AMS slot 1" } });
    expect(exact).toMatchObject({ id: "spool-1", catalogProduct: { id: canonicalProduct.id }, productProfile: { linkState: "reported", filament: { lotBatch: "LOT-1", state: "opened" } } });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/catalog/products?kind=filament&q=PETG");
    const productBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(productBody).toEqual({ kind: "filament", manufacturer: "Bambu Lab", productName: "PETG HF", materialFamily: "PETG", materialSubtype: "HF", colourName: "Black", colourCode: "BK", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" });
    const compoundBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    const inventoryBody = compoundBody.item;
    expect(inventoryBody).not.toHaveProperty("catalogProductId");
    expect(inventoryBody).not.toHaveProperty("productProfile");
    expect(inventoryBody).not.toHaveProperty("linkState");
    expect(inventoryBody).toMatchObject({ kind: "filament", categoryNodeId: "category-filament", unit: "gram", manufacturer: "Bambu Lab", sku: "PETG-HF-BLK" });
    const profileBody = compoundBody.profile;
    expect(profileBody).toEqual({ catalogProductId: canonicalProduct.id, profileType: "filament_spool", linkState: "reported", details: { lot: "LOT-1", openedState: "open", openedAt: "2026-08-30T00:00:00.000Z", tareMassG: 164, currentPlacement: "AMS slot 1" } });
    expect(profileBody).not.toHaveProperty("itemId");
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("idempotency-key")).toMatch(/^web-exact-inventory-/);
    const createdPrinter = await adapter.createCatalogProduct({ kind: "printer", manufacturer: "Bambu Lab", model: "H2D", variant: "AMS Combo", buildVolumeMm: { x: 325, y: 320, z: 325 } });
    expect(createdPrinter).toMatchObject({ id: "catalog-printer-h2d", exactModel: "H2D", buildVolumeMm: { x: 325, y: 320, z: 325 } });
    const printerBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(printerBody).toEqual({ kind: "printer", manufacturer: "Bambu Lab", exactModel: "H2D", exactVariant: "AMS Combo", technology: "fff", buildVolumeMm: { x: 325, y: 320, z: 325 } });
  });

  it("posts the strict immutable build-configuration create shape", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-build" });
    const snapshot = {
      id: "build-config-1", projectRevisionId: "revision-build", printerItemSnapshot: { itemId: "printer-1", catalogProductId: "printer-product-1", profileId: "printer-profile-1" }, filamentSelections: [{ itemId: "filament-1", catalogProductId: "filament-product-1", profileId: "filament-profile-1" }], activeHotend: { side: "left" }, nozzle: { diameterMm: 0.4, material: "hardened_steel" }, plate: { name: "Textured PEI" }, accessories: [{ name: "AMS 2 Pro" }], firmware: { version: "01.08" }, slicer: { name: "Bambu Studio", version: "1.10" }, profile: { name: "0.20 mm Standard" }, calibration: { state: "checked" }, explicitUnknowns: ["first-layer coupon"], contentSha256: "a".repeat(64), createdAt: "2026-08-30T10:00:00.000Z"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: { project: { id: "project-build", name: "Build", description: "A build", status: "idea", currentRevisionId: "revision-build", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }, revision: { id: "revision-build", projectId: "project-build", number: 1, name: "Initial", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 } } }))
      .mockResolvedValueOnce(jsonResponse({ data: snapshot }));
    const adapter = createWorkspaceAdapter();
    const project = await adapter.createProject({ name: "Build", description: "A build" });
    const created = await adapter.createBuildConfigSnapshot(project.id, "revision-build", {
      printerItemId: "printer-1", printerProductId: "printer-product-1", printerProfileId: "printer-profile-1", filamentItemId: "filament-1", filamentProductId: "filament-product-1", filamentProfileId: "filament-profile-1", hotendSide: "left", nozzleDiameterMm: 0.4, nozzleMaterial: "hardened_steel", buildPlate: "Textured PEI", accessories: ["AMS 2 Pro"], firmware: "01.08", slicer: "Bambu Studio", slicerVersion: "1.10", profile: "0.20 mm Standard", calibration: "checked", unknowns: ["first-layer coupon"]
    });
    expect(created).toMatchObject({ id: "build-config-1", revisionId: "revision-build", contentHash: "a".repeat(64), printerItemId: "printer-1", filamentItemId: "filament-1" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/v1/project-revisions/revision-build/build-configurations");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body).toEqual({ projectRevisionId: "revision-build", printerItemSnapshot: { itemId: "printer-1", catalogProductId: "printer-product-1", profileId: "printer-profile-1" }, filamentSelections: [{ itemId: "filament-1", catalogProductId: "filament-product-1", profileId: "filament-profile-1" }], activeHotend: "left", nozzle: { diameterMm: 0.4, material: "hardened_steel" }, plate: "Textured PEI", accessories: ["AMS 2 Pro"], firmware: "01.08", slicer: { name: "Bambu Studio", version: "1.10" }, profile: "0.20 mm Standard", calibration: "checked", explicitUnknowns: ["first-layer coupon"] });
    expect(body).not.toHaveProperty("projectId");
    expect(body).not.toHaveProperty("revisionId");
  });

  it("rejects an incomplete exact identity before posting to the catalog", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-required" });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const adapter = createWorkspaceAdapter();
    await expect(adapter.createCatalogProduct({ kind: "printer", manufacturer: "Bambu Lab", model: "H2D" })).rejects.toMatchObject({ kind: "validation" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads an artifact with a browser hash and finalizes the server candidate", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-upload" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf-upload", expiresAt: "2026-08-31T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        project: { id: "project-upload", name: "Lamp", description: "A lamp", status: "idea", currentRevisionId: "revision-upload", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 },
        revision: {
          id: "revision-upload", projectId: "project-upload", number: 1, name: "Initial concept", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1,
          buildConfigSnapshot: {
            id: "build-config-upload", projectRevisionId: "revision-upload",
            printerItemSnapshot: { itemId: "printer-1", catalogProductId: "printer-product-1", profileId: "printer-profile-1", linkState: "confirmed", manufacturer: "Bambu Lab", exactModel: "H2D" },
            filamentSelections: [], activeHotend: "left", nozzle: "Not recorded", plate: "Textured PEI", accessories: [], firmware: "01.08", slicer: "Bambu Studio", profile: "0.20 mm", calibration: "checked", explicitUnknowns: [], contentSha256: "a".repeat(64), createdAt: "2026-08-30T10:00:00.000Z"
          }
        }
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "upload-1", artifactId: "artifact-1", expiresAt: "2026-08-30T11:00:00.000Z", maxBytes: 5, uploadUrl: "/api/v1/artifacts/uploads/upload-1", status: "pending" } }))
      .mockResolvedValueOnce(jsonResponse({ receivedBytes: 5 }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "artifact-1", projectId: "project-upload", revisionId: "revision-upload", role: "step", filename: "body.step", mediaType: "model/step", byteSize: 5, sha256: "b".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-08-30T10:00:00.000Z", version: 1 } }));

    const adapter = createWorkspaceAdapter();
    await adapter.login("correct-password");
    const project = await adapter.createProject({ name: "Lamp", description: "A lamp" });
    const file = new File(["solid"], "body.step", { type: "model/step" });
    const updated = await adapter.uploadArtifact(project.id, file, "STEP");
    expect(updated.artifacts[0]).toMatchObject({ name: "body.step", role: "STEP", size: "5 B" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/v1/auth/login",
      "/api/v1/projects/with-initial-revision",
      "/api/v1/artifacts/uploads",
      "/api/v1/artifacts/uploads/upload-1",
      "/api/v1/artifacts/uploads/upload-1/finalize"
    ]);
    const beginBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(beginBody).toMatchObject({ projectId: "project-upload", revisionId: "revision-upload", role: "step", filename: "body.step", byteSize: 5, mediaType: "model/step" });
    expect(beginBody).toMatchObject({ buildConfigurationSnapshotId: "build-config-upload" });
    expect(beginBody.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: "PUT", credentials: "include" });
  });
});

describe("web data mappers", () => {
  it("maps every inventory kind, unit, evidence state, and measured dimension", () => {
    const cases: Array<{ kind: string; category: InventoryItem["category"]; accent: InventoryItem["accent"] }> = [
      { kind: "printer", category: "Printers", accent: "teal" },
      { kind: "filament", category: "Filament", accent: "slate" },
      { kind: "tool", category: "Tools", accent: "blue" },
      { kind: "accessory", category: "Accessories", accent: "yellow" },
      { kind: "electronic", category: "Electronics", accent: "teal" },
      { kind: "fastener", category: "Fasteners", accent: "slate" },
      { kind: "wire", category: "Wire & cable", accent: "orange" },
      { kind: "something-new", category: "Accessories", accent: "yellow" }
    ];

    for (const [index, expected] of cases.entries()) {
      const mapped = mapInventoryItem(serverItem({
        id: `item-${index}`,
        kind: expected.kind,
        ...(index === 0 ? { model: "Model variant" } : {}),
        ...(index === 1 ? { sku: "SKU variant" } : {}),
        ...(index === 2 ? {} : { description: `Description ${index}` }),
        ...(index === 3 ? {} : { location: `Location ${index}` }),
        ...(index === 4 ? { manufacturer: "Maker" } : {}),
        quantity: 4,
        availableQuantity: index === 5 ? 0 : 2,
        unit: index % 3 === 0 ? "gram" : index % 3 === 1 ? "metre" : "unknown",
        tags: [`tag-${index}`],
        ...(index === 6 ? { dimensions: { lengthMm: 10, widthMm: 20, heightMm: 30, diameterMm: 4, measured: true, uncertaintyMm: 0.1 } } : {}),
        evidence: {
          state: index === 0 ? "commissioned" : index === 1 ? "ordered_unverified" : index === 2 || index === 5 ? "physically_counted" : index === 3 ? "delivered" : "new",
          ...(index === 7 ? {} : { observedAt: "2026-08-30T12:34:56.000Z" })
        }
      }));
      expect(mapped).toMatchObject({
        id: `item-${index}`,
        category: expected.category,
        accent: expected.accent,
        variant: index === 0 ? "Model variant" : index === 1 ? "SKU variant" : expected.kind,
        unit: index % 3 === 0 ? "g" : index % 3 === 1 ? "m" : "each",
        description: index === 2 ? "No description recorded." : `Description ${index}`,
        location: index === 3 ? "Unassigned" : `Location ${index}`,
        tags: [`tag-${index}`],
        compatibility: []
      });
      expect(mapped.tags).not.toBe((serverItem({ tags: [`tag-${index}`] })).tags);
      if (index === 0) expect(mapped.state).toBe("available");
      if (index === 1) expect(mapped.state).toBe("ordered-unverified");
      if (index === 2) expect(mapped.state).toBe("available");
      if (index === 3) expect(mapped.state).toBe("inspect-first");
      if (index === 5) expect(mapped.state).toBe("reserved");
      if (index === 6) expect(mapped.dimensions).toEqual({ length: 10, width: 20, height: 30, diameter: 4, unit: "mm" });
      if (index === 7) expect(mapped.lastCounted).toBeUndefined();
    }

    expect(mapInventoryItem(serverItem({ quantity: 2, availableQuantity: 5, evidence: { state: "physically_counted" } }))).toMatchObject({ reserved: 0, state: "available" });
    expect(mapInventoryItem(serverItem({ quantity: 2, availableQuantity: 0, evidence: { state: "commissioned" } }))).toMatchObject({ reserved: 2, state: "reserved", evidence: "commissioned" });
    expect(mapInventoryItem(serverItem({ quantity: 0, availableQuantity: 0, evidence: { state: "physically_counted" } }))).toMatchObject({ reserved: 0, state: "depleted" });
    expect(mapInventoryItem(serverItem({
      kind: "electronic",
      availableQuantity: 2,
      evidence: { state: "physically_counted", source: "bench-count", sourceId: "count-42", observedAt: "2026-08-30T12:34:56.000Z", note: "Counted in drawer 2" },
      version: 7
    }))).toMatchObject({
      kind: "electronic",
      availableQuantity: 2,
      version: 7,
      provenance: { source: "bench-count", sourceId: "count-42", observedAt: "2026-08-30T12:34:56.000Z", note: "Counted in drawer 2" }
    });
  });

  it("maps project fallback fields, revision rails, artifact roles, and offer currency", async () => {
    const statuses = ["concept", "CAD complete", "DFAM reviewed", "mesh validated", "slicer validated", "test printed", "fit/function verified", "production approved", "unrecognised"];
    const projects = statuses.map((status, index) => serverProject({
      id: `project-${index}`,
      name: `Project ${index}`,
      status: index === 7 ? "complete" : "planning",
      ...(index === 8 ? { description: undefined } : { description: `Description ${index}` }),
      currentRevision: serverRevision({ id: `revision-${index}`, projectId: `project-${index}`, number: index + 1, status, notes: index === 0 ? "Record a measurement" : undefined }),
      currentRevisionId: `revision-${index}`,
      ...(index === 1 ? { workItems: [{ id: "work-1", projectId: `project-${index}`, name: "Body", kind: "part", description: "Body work item", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }] } : {}),
      ...(index === 8 ? { bom: [{ id: "fallback-bom", revisionId: "revision-8", name: "Fallback requirement", requiredQuantity: 2, unit: "gram", optional: true, notes: "Use black PETG" }] } : {}),
      ...(index === 8 ? { artifacts: [serverArtifact({ id: "fallback-artifact", revisionId: undefined, role: "other", filename: "notes.txt", byteSize: 0 })] } : {}),
      ...(index === 0 ? { currentRevision: serverRevision({ id: "revision-0", projectId: "project-0", number: 1, status, notes: "Record a measurement", bom: [{ id: "bom-0", revisionId: "revision-0", name: "Insert", requiredQuantity: 1, unit: "each", optional: false, notes: "M3" }], artifacts: [
        serverArtifact({ id: "artifact-step", revisionId: "revision-0", role: "step", filename: "model.step", byteSize: 2048 }),
        serverArtifact({ id: "artifact-stl", role: "stl", filename: "model.stl", byteSize: 1023 }),
        serverArtifact({ id: "artifact-3mf", role: "three_mf", filename: "plate.3mf", byteSize: 1024, machineBinding: { machine: "H2D", material: "PETG" }, currentCandidate: true }),
        serverArtifact({ id: "artifact-slicer", role: "slicer_project", filename: "plate.bambu", byteSize: 1024 * 1024 }),
        serverArtifact({ id: "artifact-gcode", role: "gcode", filename: "plate.gcode", byteSize: 1024 * 1024 + 1 }),
        serverArtifact({ id: "artifact-cad", role: "cad_source", filename: "model.scad", machineBinding: { printer: "Ender" }, retired: true }),
        serverArtifact({ id: "artifact-text", role: "text", filename: "notes.md", byteSize: 0 }),
        serverArtifact({ id: "artifact-brief", role: "brief", filename: "brief.md" }),
        serverArtifact({ id: "artifact-other", role: "other", filename: "validation.json" })
      ] }) } : {})
    }));
    projects.push(serverProject({ id: "project-idea", name: "Idea", status: "idea", currentRevision: serverRevision({ id: "revision-idea", projectId: "project-idea", number: 3, status: "unknown" }) }));
    projects.push(serverProject({ id: "project-no-revision", name: "No revision", status: "planning", currentRevisionId: undefined, currentRevision: undefined }));

    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-mapping" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", scopes: ["read"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "", inventory: [], projects, offers: [
        { id: "offer-eur", itemId: "item-1", name: "EUR offer", supplier: "Supplier", url: "https://example.test/eur", priceMinor: 123, currency: "EUR", packageQuantity: 0, observedAt: "2026-08-30T00:00:00.000Z", version: 1 },
        { id: "offer-usd", name: "USD offer", supplier: "Supplier", url: "https://example.test/usd", priceMinor: 456, currency: "USD", packageQuantity: 2, observedAt: "2026-08-29T00:00:00.000Z", version: 1 },
        { id: "offer-other", name: "Other offer", supplier: "Supplier", url: "https://example.test/other", priceMinor: 789, currency: "GBP", observedAt: "2026-08-28T00:00:00.000Z", version: 1 }
      ] }));

    const snapshot = await createWorkspaceAdapter().loadWorkspace();
    expect(snapshot.fetchedAt).toMatch(/2026|T/);
    expect(snapshot.projects[0]?.railStep).toBe(0);
    expect(snapshot.projects.find((project) => project.id === "project-1")).toMatchObject({ subtitle: "Body work item", workItem: "Body", currentRevision: "r02" });
    expect(snapshot.projects.find((project) => project.id === "project-8")).toMatchObject({ currentRevision: "r09", workItem: "Project setup", description: "Add a project goal to define the next task." });
    expect(snapshot.projects.find((project) => project.id === "project-no-revision")).toMatchObject({ currentRevision: "No revision", railStep: 2, workItem: "Project setup" });
    expect(snapshot.projects.find((project) => project.id === "project-idea")).toMatchObject({ status: "Idea", railStep: 0, accent: "orange" });
    expect(snapshot.projects.find((project) => project.id === "project-7")).toMatchObject({ status: "Complete", railStep: 5, accent: "blue" });

    const first = snapshot.projects[0]!;
    expect(first.bom[0]).toMatchObject({ label: "Insert", required: 1, note: "M3" });
    expect(first.artifacts.map((artifact) => artifact.role)).toEqual(["STEP", "STL", "Build plate", "Build plate", "Build plate", "Editable CAD", "Notes", "Notes", "Validation"]);
    expect(first.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "artifact-step", size: "2 KB", revision: "r01" }),
      expect.objectContaining({ id: "artifact-stl", size: "1023 B" }),
      expect.objectContaining({ id: "artifact-3mf", size: "1 KB", machine: "H2D", material: "PETG", status: "candidate" }),
      expect.objectContaining({ id: "artifact-gcode", size: "1.0 MB" }),
      expect.objectContaining({ id: "artifact-cad", status: "superseded", machine: "Ender" })
    ]));
    expect(snapshot.offers).toEqual([
      expect.objectContaining({ id: "offer-eur", itemId: "item-1", currency: "EUR", pack: "Package size not recorded" }),
      expect.objectContaining({ id: "offer-usd", itemId: "", currency: "USD", pack: "2 pieces" }),
      expect.objectContaining({ id: "offer-other", currency: "GBP" })
    ]);
  });
});

describe("API boundaries and mutation guards", () => {
  it("classifies HTTP failures, preserves correlation metadata, and handles offline fetches", async () => {
    const failures: Array<{ status: number; code?: string; kind: string }> = [
      { status: 401, kind: "unauthenticated" },
      { status: 403, code: "csrf", kind: "csrf" },
      { status: 403, kind: "forbidden" },
      { status: 400, kind: "validation" },
      { status: 409, kind: "validation" },
      { status: 413, kind: "validation" },
      { status: 415, kind: "validation" },
      { status: 422, kind: "server" },
      { status: 500, kind: "server" }
    ];

    for (const failure of failures) {
      const body = failure.code
        ? { error: { code: failure.code, message: "A CSRF token is required", correlationId: "envelope-correlation" } }
        : { error: { message: `status-${failure.status}` } };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body, failure.status));
      const error = await createWorkspaceAdapter().checkHealth().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ kind: failure.kind, status: failure.status });
      vi.restoreAllMocks();
    }

    const headerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 418, headers: { "x-correlation-id": "header-correlation" } }));
    const headerError = await createWorkspaceAdapter().checkHealth().catch((caught: unknown) => caught);
    expect(headerError).toMatchObject({ kind: "server", status: 418, correlationId: "header-correlation", message: "BenchLedger returned HTTP 418" });
    expect(headerFetch).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce("not-an-error-object");
    await expect(createWorkspaceAdapter().checkHealth()).rejects.toMatchObject({ kind: "offline", message: "The BenchLedger service could not be reached" });
  });

  it("supports cookie-backed login, direct session/health/logout, and missing CSRF protection", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=cookie-token; other=value" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "degraded", service: "benchledger", version: "test", demo: true, now: "now" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", source: "cookie", scopes: ["read"], projectIds: ["p1"] }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", csrfToken: "", expiresAt: "later" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }));
    const adapter = createWorkspaceAdapter();
    await expect(adapter.checkHealth()).resolves.toMatchObject({ status: "degraded", demo: true });
    await expect(adapter.session()).resolves.toMatchObject({ actor: "admin", projectIds: ["p1"] });
    await expect(adapter.login("password")).resolves.toMatchObject({ csrfToken: "" });
    await expect(adapter.logout()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls).toHaveLength(4);
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get("x-csrf-token")).toBe("cookie-token");

    vi.restoreAllMocks();
    vi.stubGlobal("document", { cookie: "" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", csrfToken: "", expiresAt: "later" }));
    await expect(createWorkspaceAdapter().login("password")).rejects.toMatchObject({ kind: "csrf", status: 403 });

    vi.restoreAllMocks();
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("document", { cookie: "forge_csrf=fallback-token" });
    const fallbackFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ authenticated: false }));
    await expect(createWorkspaceAdapter().logout()).resolves.toBeUndefined();
    expect(new Headers(fallbackFetch.mock.calls[0]?.[1]?.headers).get("idempotency-key")).toMatch(/^web-logout-/);
  });

  it("rejects incomplete mutation payloads and guards uncached projects", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=mutation-token" });
    const adapter = createWorkspaceAdapter();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: { event: {} } }));
    await expect(adapter.recordCount("missing-item", 1)).rejects.toMatchObject({ kind: "server", status: 502, message: "The service returned an incomplete count" });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({}));
    await expect(adapter.createInventoryItem({ name: "New", category: "Accessories", quantity: 1, unit: "each" })).rejects.toMatchObject({ kind: "server", status: 502, message: "The service returned an incomplete mutation" });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({}));
    await expect(adapter.createProject({ name: "New project", description: "Description" })).rejects.toMatchObject({ kind: "server", status: 502 });

    vi.restoreAllMocks();
    const uncachedRevisionFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: { id: "unknown-revision", projectId: "unknown", number: 2, name: "No cache", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 } }));
    await expect(adapter.createRevision("not-loaded", { name: "No cache" })).rejects.toMatchObject({ kind: "validation", status: 409 });
    expect(uncachedRevisionFetch).not.toHaveBeenCalled();

    await expect(adapter.createBomLine("not-loaded", { name: "No revision", requiredQuantity: 1, unit: "each" })).rejects.toMatchObject({ kind: "validation", status: 409, message: "Create a project revision before adding a requirement" });
    await expect(adapter.uploadArtifact("not-loaded", new File(["data"], "data.stl"), "STL")).rejects.toMatchObject({ kind: "validation", status: 409, message: "Create a project revision before uploading a file" });

  });
});

describe("sample workspace adapter", () => {
  it("keeps demo pagination server-shaped and rejects malformed cursors", async () => {
    const adapter = createSampleWorkspaceAdapter();
    const first = await adapter.listInventory({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    await expect(adapter.listInventory({ limit: 1, cursor: first.nextCursor! })).resolves.toMatchObject({ items: expect.any(Array) });
    await expect(adapter.listInventory({ limit: 1, cursor: "-1" })).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    await expect(adapter.listInventory({ limit: 1, cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
  });

  it("keeps a complete local vertical slice for demos without pretending it is counted stock", async () => {
    const adapter = createSampleWorkspaceAdapter();
    await expect(adapter.checkHealth()).resolves.toMatchObject({ status: "ok", demo: true, version: "sample" });
    await expect(adapter.session()).resolves.toMatchObject({ authenticated: true, actor: "sample", source: "demo" });
    await expect(adapter.login("anything")).resolves.toMatchObject({ authenticated: true, actor: "sample", csrfToken: "sample" });
    await expect(adapter.logout()).resolves.toBeUndefined();

    const initial = await adapter.loadWorkspace();
    const initialInventoryCount = initial.inventory.length;
    const initialProjectCount = initial.projects.length;
    const counted = await adapter.recordCount("fast-m3-inserts", 7);
    expect(counted).toMatchObject({ id: "fast-m3-inserts", quantity: 7, state: "available", evidence: "counted" });
    await expect(adapter.recordCount("not-real", 1)).rejects.toMatchObject({ kind: "validation", status: 404 });

    const edited = await adapter.updateInventoryItem("fast-m3-inserts", { name: "M3 heat-set inserts", location: "Fastener drawer", tags: ["m3", "insert"] }, 1);
    expect(edited).toMatchObject({ name: "M3 heat-set inserts", location: "Fastener drawer", tags: ["m3", "insert"] });
    await expect(adapter.updateInventoryItem("not-real", { name: "Missing" }, 1)).rejects.toMatchObject({ kind: "validation", status: 404 });

    const createdItem = await adapter.createInventoryItem({ name: "JST connector", category: "Electronics", quantity: 10, unit: "each" });
    expect(createdItem).toMatchObject({ name: "JST connector", state: "inspect-first", evidence: "delivered", accent: "teal", location: "Unassigned" });
    const createdProject = await adapter.createProject({ name: "Sample project", description: "A demo project" });
    expect(createdProject).toMatchObject({ name: "Sample project", status: "Idea", currentRevision: "r01", railStep: 0 });
    const revised = await adapter.createRevision(createdProject.id, { name: "r02 concept", notes: "Measure first", status: "CAD complete" });
    expect(revised).toMatchObject({ currentRevision: "r02 concept", railStep: 0, notes: ["Measure first"], bom: [], artifacts: [] });
    const withBom = await adapter.createBomLine(createdProject.id, { name: "JST connector", requiredQuantity: 2, unit: "each", itemId: createdItem.id, note: "One per panel" });
    expect(withBom.bom[0]).toMatchObject({ label: "JST connector", required: 2, optional: false, note: "One per panel" });
    const file = new File(["solid"], "sample.step", { type: "model/step" });
    for (const [role, expected] of [["STEP", "STEP"], ["STL", "STL"], ["Build plate", "Build plate"], ["Editable CAD", "Editable CAD"], ["Notes", "Notes"], ["Validation", "Validation"]] as const) {
      const updated = await adapter.uploadArtifact(createdProject.id, file, role);
      expect(updated.artifacts[0]).toMatchObject({ name: "sample.step", role: expected, status: "candidate", hash: "sample-hash" });
    }
    await expect(adapter.createRevision("not-real", { name: "No project" })).rejects.toMatchObject({ kind: "validation", status: 404 });
    await expect(adapter.createBomLine("not-real", { name: "No project", requiredQuantity: 1, unit: "each" })).rejects.toMatchObject({ kind: "validation", status: 404 });
    await expect(adapter.uploadArtifact("not-real", file, "STL")).rejects.toMatchObject({ kind: "validation", status: 404 });

    const after = await adapter.loadWorkspace();
    expect(after.inventory).toHaveLength(initialInventoryCount + 1);
    expect(after.projects).toHaveLength(initialProjectCount + 1);
    expect(after.projects.find((project) => project.id === createdProject.id)?.artifacts).toHaveLength(6);
  });
});
