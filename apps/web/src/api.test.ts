import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createSampleWorkspaceAdapter, createWorkspaceAdapter, mapInventoryItem } from "./api";
import type { Artifact, InventoryItem, Project } from "./domain";
import type { ReconciliationViewModel } from "./reconciliation-ui";

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
  status: "planned",
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
  it("reuses a pending inspection completion key for an ambiguous identical retry", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=inspection-csrf" });
    const action = {
      id: "inspection-1", projectRevisionId: "revision-1", itemId: "item-1", itemVersion: 1,
      kind: "physical_quantity", normalizedPredicate: '{"kind":"physical_quantity"}', question: "Count the item.",
      itemUnit: "each", expectedUnit: "each", compatibility: "confirmed", lineIds: ["line-1"], lineVersions: [{ lineId: "line-1", version: 1 }], version: 1,
      candidate: { id: "item-1", version: 1, name: "Maker item", unit: "each", evidence: { state: "delivered_uncounted", source: "label", observedAt: "2026-08-30T10:00:00.000Z" } },
      expected: { quantity: 1, unit: "each", lineIds: ["line-1"], lineRequirements: [{ lineId: "line-1", quantity: 1, unit: "each" }] },
      possibleResults: ["confirmed", "inconclusive"], effects: [{ kind: "physical_quantity", description: "May update quantity." }],
      basis: { itemVersion: 1, lineVersions: [{ lineId: "line-1", version: 1 }] }, requiresHumanConfirmation: true
    };
    const gap = {
      lineId: "line-1", name: "Maker item", optional: false, status: "supplied", decision: "ready",
      requiredQuantity: 1, suppliedQuantity: 1, inspectQuantity: 0, missingQuantity: 0, unit: "each", matchedItemIds: ["item-1"], reasons: ["counted"], alternatives: [],
      candidates: [{ itemId: "item-1", relationship: "exact", compatibility: "confirmed", availableQuantity: 1, suppliedQuantity: 1, inspectQuantity: 0, reason: "counted" }]
    };
    const committed = {
      id: "inspection-commit", status: "committed", projectRevisionId: "revision-1", actionId: action.id, previewId: "preview-1",
      evidence: { id: "evidence-1", projectRevisionId: "revision-1", actionId: action.id, itemId: "item-1", kind: "physical_quantity", result: "confirmed", source: "physical count", observedAt: "2026-08-30T10:00:00.000Z", recordedAt: "2026-08-30T10:00:00.000Z", quantity: 1, unit: "each" },
      gaps: { revisionId: "revision-1", lines: [gap], totals: { requiredLines: 1, readyLines: 1 } },
      inspections: { revisionId: "revision-1", data: [], limit: 200, total: 0 }, committedAt: "2026-08-30T10:00:00.000Z"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: { message: "response lost after commit" } }, 500))
      .mockResolvedValueOnce(jsonResponse({ data: committed }));
    const adapter = createWorkspaceAdapter();
    const input = { previewId: "preview-1", expectedPreviewVersion: 1, contentSha256: "a".repeat(64), confirmed: true as const };
    await expect(adapter.commitInspectionCompletion("revision-1", "inspection-1", input)).rejects.toMatchObject({ kind: "server", status: 500 });
    const firstKey = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("idempotency-key");
    await expect(adapter.commitInspectionCompletion("revision-1", "inspection-1", input)).resolves.toMatchObject({ id: "inspection-commit", inspections: { data: [] } });
    const secondKey = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("idempotency-key");
    expect(firstKey).toMatch(/^web-inspection-completion-/u);
    expect(secondKey).toBe(firstKey);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual(input);
  });

  it("keeps project setup preview and commit calls on the shared API with a caller-owned retry key", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=setup-csrf" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: "setup-preview", version: 1, status: "active" }))
      .mockResolvedValueOnce(jsonResponse({ data: { project: { id: "setup-project" }, auditIds: ["audit-1"] } }));
    const adapter = createWorkspaceAdapter();
    const proposal = { project: { name: "Setup", status: "planned" }, revision: { name: "Initial", status: "concept" }, bomLines: [{ localRef: "line", name: "Requirement", requiredQuantity: 1, unit: "each" }] };
    await expect(adapter.previewProjectSetup(proposal)).resolves.toMatchObject({ id: "setup-preview" });
    await expect(adapter.commitProjectSetup({ previewId: "setup-preview", expectedPreviewVersion: 1, contentSha256: "a".repeat(64), confirmReservations: false, idempotencyKey: "setup-web-retry" })).resolves.toMatchObject({ data: { project: { id: "setup-project" } } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/project-setup/previews");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/project-setup/previews/setup-preview/commit");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("idempotency-key")).toBe("setup-web-retry");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ expectedPreviewVersion: 1, contentSha256: "a".repeat(64), confirmReservations: false });
  });

  it("reads workspace access and explicitly bootstraps a LAN-open session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ mode: "lan_open", demo: false, version: 3 }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", csrfToken: "lan-csrf", expiresAt: "2026-08-31T10:00:00.000Z" }));
    const adapter = createWorkspaceAdapter();
    await expect(adapter.getWorkspaceAccess()).resolves.toEqual({ mode: "lan_open", demo: false, version: 3 });
    await expect(adapter.openLanSession()).resolves.toMatchObject({ authenticated: true, actor: "admin", csrfToken: "lan-csrf" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/auth/access");
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/v1/auth/lan-session");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(new Headers(init?.headers).get("idempotency-key")).toMatch(/^web-lan-session-/);
  });

  it("updates workspace access with an optimistic version, idempotency key, and replacement session", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=access-csrf" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: {
      access: { mode: "password", demo: false, version: 4 },
      session: { authenticated: true, actor: "admin", csrfToken: "replacement-csrf", expiresAt: "2026-08-31T12:00:00.000Z" }
    } }));
    const adapter = createWorkspaceAdapter();
    const result = await adapter.updateWorkspaceAccess({ operation: "enable", newPassword: "a-new-password-please" }, 3);
    expect(result).toMatchObject({ access: { mode: "password", version: 4 }, session: { csrfToken: "replacement-csrf" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/auth/access");
    expect(init).toMatchObject({ method: "PATCH", credentials: "include" });
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe("access-csrf");
    expect(new Headers(init?.headers).get("if-match")).toBe("3");
    expect(new Headers(init?.headers).get("idempotency-key")).toMatch(/^web-workspace-access-/);
    expect(JSON.parse(String(init?.body))).toEqual({ operation: "enable", newPassword: "a-new-password-please", expectedVersion: 3 });
  });

  it("keeps the workspace access retry key when a committed response is malformed", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=access-csrf" });
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); }
    });
    const adapter = createWorkspaceAdapter();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const malformedResponses = [
      { access: { mode: "password", demo: false, version: 4 }, session: { authenticated: true } },
      { access: { mode: "unknown", demo: false, version: 4 }, session: { authenticated: true, actor: "admin", csrfToken: "replacement-csrf", expiresAt: "2026-08-31T12:00:00.000Z" } },
      { access: { mode: "password", demo: false }, session: { authenticated: true, actor: "admin", csrfToken: "replacement-csrf", expiresAt: "2026-08-31T12:00:00.000Z" } }
    ];
    for (const response of malformedResponses) {
      fetchMock.mockResolvedValueOnce(jsonResponse(response));
      await expect(adapter.updateWorkspaceAccess({ operation: "enable", newPassword: "a-new-password-please" }, 3)).rejects.toMatchObject({ status: 502 });
      const key = new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get("idempotency-key");
      expect(adapter.getWorkspaceAccessRetry()).toMatchObject({ key, operation: "enable", expectedVersion: 3 });
      expect([...values.values()].join(" ")).not.toContain("a-new-password-please");
      adapter.clearWorkspaceAccessRetry();
    }
  });

  it("reuses the same idempotency key when a workspace access response is lost", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=access-csrf" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(jsonResponse({ mode: "lan_open", demo: false, version: 5, authenticated: true, actor: "admin", csrfToken: "replacement-csrf", expiresAt: "2026-08-31T12:00:00.000Z" }));
    const adapter = createWorkspaceAdapter();
    const input = { operation: "disable" as const, currentPassword: "a-password" };
    await expect(adapter.updateWorkspaceAccess(input, 4)).rejects.toMatchObject({ kind: "offline" });
    await expect(adapter.updateWorkspaceAccess(input, 4, { retry: true })).resolves.toMatchObject({ access: { mode: "lan_open", version: 5 } });
    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(secondHeaders.get("idempotency-key")).toBe(firstHeaders.get("idempotency-key"));
    expect(secondHeaders.get("if-match")).toBe("4");
  });

  it("keeps only opaque retry metadata in session storage and starts a new key for changed credentials", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=access-csrf" });
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockRejectedValueOnce(new TypeError("response lost again"));
    const adapter = createWorkspaceAdapter();
    await expect(adapter.updateWorkspaceAccess({ operation: "enable", newPassword: "first-password-please" }, 9)).rejects.toMatchObject({ kind: "offline" });
    const firstKey = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("idempotency-key");
    const stored = [...values.values()].join(" ");
    expect(stored).toContain(firstKey!);
    expect(stored).toContain("enable");
    expect(stored).toContain("9");
    expect(stored).not.toContain("first-password-please");

    await expect(adapter.updateWorkspaceAccess({ operation: "enable", newPassword: "different-password" }, 9)).rejects.toMatchObject({ kind: "offline" });
    const secondKey = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("idempotency-key");
    expect(secondKey).not.toBe(firstKey);
    adapter.clearWorkspaceAccessRetry();
    expect(adapter.hasPendingWorkspaceAccessRetry()).toBe(false);
  });

  it("rehydrates an opaque retry key across a fresh adapter for every security operation", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=access-csrf" });
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cases = [
      { input: { operation: "enable" as const, newPassword: "enable-password-please" }, version: 9, response: { mode: "password", version: 10 } },
      { input: { operation: "change_password" as const, currentPassword: "old-password-please", newPassword: "change-password-please" }, version: 10, response: { mode: "password", version: 11 } },
      { input: { operation: "disable" as const, currentPassword: "change-password-please" }, version: 11, response: { mode: "lan_open", version: 12 } }
    ];
    for (const current of cases) {
      fetchMock.mockRejectedValueOnce(new TypeError("response lost"));
      fetchMock.mockResolvedValueOnce(jsonResponse({ access: { ...current.response, demo: false }, session: { authenticated: true, actor: "admin", csrfToken: `csrf-${current.response.version}`, expiresAt: "2026-08-31T12:00:00.000Z" } }));
      const firstAdapter = createWorkspaceAdapter();
      await expect(firstAdapter.updateWorkspaceAccess(current.input, current.version)).rejects.toMatchObject({ kind: "offline" });
      const stored = [...values.values()].join(" ");
      expect(stored).toContain(current.input.operation);
      expect(stored).toContain(String(current.version));
      for (const secret of Object.entries(current.input).filter(([name]) => name !== "operation").map(([, value]) => value)) expect(stored).not.toContain(secret);

      const secondAdapter = createWorkspaceAdapter();
      expect(secondAdapter.getWorkspaceAccessRetry()).toMatchObject({ operation: current.input.operation, expectedVersion: current.version });
      await expect(secondAdapter.updateWorkspaceAccess(current.input, current.version, { retry: true })).resolves.toMatchObject({ access: current.response });
      expect(secondAdapter.hasPendingWorkspaceAccessRetry()).toBe(false);
    }
  });

  it("submits a bounded bulk inventory edit and maps updated, unchanged, and audit metadata", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=bulk-token" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      data: {
        updated: [serverItem({ id: "item-1", name: "Updated item", location: "Drawer B", condition: "good", tags: ["kept", "new"], version: 2 })],
        unchanged: [serverItem({ id: "item-2", name: "Already item", location: "Drawer B", condition: "good", tags: ["kept"], version: 4 })]
      },
      audits: [{ id: "audit-item-1" }],
      correlationId: "bulk-correlation",
      replayed: false
    }));

    const adapter = createWorkspaceAdapter();
    const result = await adapter.bulkUpdateInventory({
      targets: [{ itemId: "item-1", expectedVersion: 1 }, { itemId: "item-2", expectedVersion: 4 }],
      changes: { location: "Drawer B", condition: "good", tags: { add: ["new"], remove: ["old"] } }
    });

    expect(result).toMatchObject({
      updated: [{ id: "item-1", name: "Updated item", location: "Drawer B", condition: "good", tags: ["kept", "new"], version: 2 }],
      unchanged: [{ id: "item-2", name: "Already item", location: "Drawer B", condition: "good", tags: ["kept"], version: 4 }],
      audits: ["audit-item-1"], correlationId: "bulk-correlation", replayed: false
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/inventory/bulk");
    expect(init).toMatchObject({ method: "PATCH", credentials: "include" });
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe("bulk-token");
    expect(new Headers(init?.headers).get("idempotency-key")).toMatch(/^web-inventory-bulk-/);
    expect(JSON.parse(String(init?.body))).toEqual({
      targets: [{ itemId: "item-1", expectedVersion: 1 }, { itemId: "item-2", expectedVersion: 4 }],
      changes: { location: "Drawer B", condition: "good", tags: { add: ["new"], remove: ["old"] } }
    });
  });

  it("rejects empty, oversized, or malformed bulk selections before making a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const adapter = createWorkspaceAdapter();
    const changes = { location: "Drawer B" } as const;
    await expect(adapter.bulkUpdateInventory({ targets: [], changes })).rejects.toMatchObject({ kind: "validation", status: 400, code: "invalid_bulk_targets" });
    await expect(adapter.bulkUpdateInventory({ targets: Array.from({ length: 101 }, (_, index) => ({ itemId: `item-${index}`, expectedVersion: 1 })), changes })).rejects.toMatchObject({ kind: "validation", status: 400, code: "invalid_bulk_targets" });
    await expect(adapter.bulkUpdateInventory({ targets: [{ itemId: "item-1", expectedVersion: 0 }], changes })).rejects.toMatchObject({ kind: "validation", status: 400, code: "invalid_bulk_target" });
    await expect(adapter.bulkUpdateInventory({ targets: [{ itemId: "item-1", expectedVersion: undefined as unknown as number }], changes })).rejects.toMatchObject({ kind: "validation", status: 400, code: "invalid_bulk_target" });
    await expect(adapter.bulkUpdateInventory({ targets: [{ itemId: "item-1", expectedVersion: 1 }], changes: { location: "   " } })).rejects.toMatchObject({ kind: "validation", status: 400, code: "invalid_bulk_changes" });
    await expect(adapter.bulkUpdateInventory({ targets: [{ itemId: "item-1", expectedVersion: 1 }], changes: { tags: { add: ["Label"], remove: ["label"] } } })).rejects.toMatchObject({ kind: "validation", status: 400, code: "invalid_bulk_changes" });
    await expect(adapter.bulkUpdateInventory({ targets: [{ itemId: "item-1", expectedVersion: 1 }], changes: { tags: { add: ["Label", "label"] } } })).rejects.toMatchObject({ kind: "validation", status: 400, code: "invalid_bulk_changes" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests inventory pages from the server and maps pagination without slicing a workspace snapshot", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      data: [serverItem({ id: "item-page", name: "Paged item" })], limit: 10, total: 21, nextCursor: "10"
    }));
    const adapter = createWorkspaceAdapter();
    const result = await adapter.listInventory({ q: "  ESP32 ", kind: "electronic", evidence: "physically_counted", available: true, limit: 10, cursor: "20" });
    expect(result).toMatchObject({ items: [{ id: "item-page", name: "Paged item" }], limit: 10, total: 21, nextCursor: "10" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/v1/inventory?");
    expect(new URL(String(url), "http://localhost").search).toBe("?q=ESP32&kind=electronic&evidence=physically_counted&available=true&limit=10&cursor=20");
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
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [{ id: "printer-h2d", name: "Bambu Lab H2D", kind: "printer", quantity: 1, availableQuantity: 1, unit: "each", tags: ["3d-printing"], links: [], evidence: { state: "commissioned" }, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }], projects: [{ id: "project-1", name: "Desk light", description: "A small light", status: "planned", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1, workItems: [{ id: "work-1", projectId: "project-1", name: "Enclosure", kind: "part", description: "Printed enclosure", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }], bom: [], artifacts: [], currentRevision: { id: "revision-1", projectId: "project-1", number: 2, name: "Fit pass", status: "CAD complete", notes: "Check the USB cutout", createdAt: "2026-08-30T10:00:00.000Z", version: 1, bom: [{ id: "bom-1", revisionId: "revision-1", name: "ESP32 board", itemId: "board-esp32", requiredQuantity: 1, unit: "each", optional: false, constraints: { specification: { status: "insufficient", missingDecisions: ["voltage", "connector"] } }, alternatives: [{ itemId: "board-esp32", compatible: "conditional", reason: "Check logic level" }], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }], artifacts: [{ id: "artifact-1", projectId: "project-1", revisionId: "revision-1", role: "step", filename: "enclosure.step", mediaType: "model/step", byteSize: 2048, sha256: "a".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-08-30T10:00:00.000Z", version: 1 }] } }], offers: [] }));

    const adapter = createWorkspaceAdapter();
    const snapshot = await adapter.loadWorkspace();
    expect(snapshot.source).toBe("api");
    expect(snapshot.inventory[0]).toMatchObject({ id: "printer-h2d", category: "Printers", unit: "each", state: "available" });
    expect(snapshot.projects[0]).toMatchObject({ id: "project-1", name: "Desk light", status: "planned", workItem: "Enclosure", currentRevision: "r02", serverRevisionId: "revision-1" });
    expect(snapshot.projects[0]?.bom[0]).toMatchObject({ label: "ESP32 board", itemId: "board-esp32", required: 1, constraints: { specification: { status: "insufficient", missingDecisions: ["voltage", "connector"] } }, alternatives: [{ itemId: "board-esp32", compatible: "conditional", reason: "Check logic level" }] });
    expect(snapshot.projects[0]?.artifacts[0]).toMatchObject({ name: "enclosure.step", role: "STEP", revision: "r02", size: "2 KB" });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    await expect(adapter.createProject({ name: "No local fallback", description: "must fail" })).rejects.toMatchObject({ kind: "offline" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects source readiness that still carries unresolved specification decisions", async () => {
    const bom = { id: "bom-invalid", revisionId: "revision-1", name: "Controller", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "0.1.0", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({
        source: "api",
        fetchedAt: "2026-08-30T10:00:00.000Z",
        inventory: [],
        projects: [serverProject({ currentRevision: serverRevision({
          bom: [bom],
          gapEvaluation: {
            lines: [{ lineId: "bom-invalid", status: "missing", decision: "source", missingDecisions: ["identity"], suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, matchedItemIds: [], reasons: [] }],
            totals: { requiredLines: 1, optionalLines: 0, readyLines: 0, checkLines: 0, decideLines: 0, sourceLines: 1, partialLines: 0, missingLines: 0 },
          },
        }) })],
        offers: [],
      }));

    await expect(createWorkspaceAdapter().loadWorkspace()).rejects.toMatchObject({ kind: "server", status: 502, code: "invalid_gap_evaluation" });
  });

  it("keeps unresolved cross-unit alternatives in Check even when no quantity can be converted yet", async () => {
    const bom = { id: "bom-wire", revisionId: "revision-1", name: "Hook-up wire", requiredQuantity: 1, unit: "metre", optional: false, constraints: {}, alternatives: [{ itemId: "wire-reel", compatible: "confirmed", reason: "Use the stocked reel after confirming its usable length." }], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "0.1.0", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({
        source: "api",
        fetchedAt: "2026-08-30T10:00:00.000Z",
        inventory: [],
        projects: [serverProject({ currentRevision: serverRevision({
          bom: [bom],
          gapEvaluation: {
            lines: [{ lineId: "bom-wire", status: "inspect_first", decision: "check", missingDecisions: [], suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, matchedItemIds: ["wire-reel"], reasons: ["Confirm a conversion before allocating the stocked reel."] }],
            totals: { requiredLines: 1, optionalLines: 0, readyLines: 0, checkLines: 1, decideLines: 0, sourceLines: 0, partialLines: 0, missingLines: 0 },
          },
        }) })],
        offers: [],
      }));

    const snapshot = await createWorkspaceAdapter().loadWorkspace();

    expect(snapshot.projects[0]?.gapEvaluation).toMatchObject({
      lines: [{ lineId: "bom-wire", status: "inspect_first", decision: "check", inspectQuantity: 0, missingQuantity: 1 }],
      totals: { checkLines: 1, sourceLines: 0 },
    });
  });

  it("loads a supplied migrated null-role BOM line when the service reports Check", async () => {
    const bom = {
      id: "bom-migrated",
      revisionId: "revision-1",
      name: "Legacy requirement",
      itemId: "legacy-item",
      role: null,
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      constraints: {},
      alternatives: [],
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
      version: 1,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "0.1.0", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({
        source: "api",
        fetchedAt: "2026-08-30T10:00:00.000Z",
        inventory: [],
        projects: [serverProject({ currentRevision: serverRevision({
          bom: [bom],
          gapEvaluation: {
            lines: [{
              lineId: "bom-migrated",
              name: "Legacy requirement",
              optional: false,
              status: "supplied",
              decision: "check",
              missingDecisions: [],
              requiredQuantity: 1,
              suppliedQuantity: 1,
              inspectQuantity: 0,
              missingQuantity: 0,
              unit: "each",
              matchedItemIds: ["legacy-item"],
              reasons: ["Stock is available, but the requirement role still needs review."],
              alternatives: [],
              candidates: [],
            }],
            totals: { requiredLines: 1, optionalLines: 0, readyLines: 0, checkLines: 1, decideLines: 0, sourceLines: 0, partialLines: 0, missingLines: 0 },
          },
        }) })],
        offers: [],
      }));

    const snapshot = await createWorkspaceAdapter().loadWorkspace();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/v1/health",
      "/api/v1/auth/session",
      "/api/v1/workspace",
    ]);
    expect(snapshot.projects[0]?.bom[0]).toMatchObject({ id: "bom-migrated", role: null });
    expect(snapshot.projects[0]?.gapEvaluation).toMatchObject({
      lines: [{ lineId: "bom-migrated", decision: "check", status: "supplied", suppliedQuantity: 1, inspectQuantity: 0, missingQuantity: 0 }],
      totals: { checkLines: 1 },
    });
  });

  it("rejects zero-quantity inspection states without a matched candidate", async () => {
    const bom = { id: "bom-wire", revisionId: "revision-1", name: "Hook-up wire", requiredQuantity: 1, unit: "metre", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "0.1.0", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({
        source: "api",
        fetchedAt: "2026-08-30T10:00:00.000Z",
        inventory: [],
        projects: [serverProject({ currentRevision: serverRevision({
          bom: [bom],
          gapEvaluation: {
            lines: [{ lineId: "bom-wire", status: "inspect_first", decision: "check", missingDecisions: [], suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, matchedItemIds: [], reasons: ["Inspect stock."] }],
            totals: { requiredLines: 1, optionalLines: 0, readyLines: 0, checkLines: 1, decideLines: 0, sourceLines: 0, partialLines: 0, missingLines: 0 },
          },
        }) })],
        offers: [],
      }));

    await expect(createWorkspaceAdapter().loadWorkspace()).rejects.toMatchObject({ kind: "server", status: 502, code: "invalid_gap_evaluation" });
  });

  it("preserves LED resistor decisions from canonical connected gaps", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "0.1.0", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({
        source: "api",
        fetchedAt: "2026-08-30T10:00:00.000Z",
        inventory: [],
        projects: [serverProject({ currentRevision: serverRevision({
          bom: [{ id: "bom-resistor", revisionId: "revision-1", name: "LED resistor", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }],
          gapEvaluation: {
            lines: [{ lineId: "bom-resistor", status: "specify_first", decision: "decide", missingDecisions: ["resistance", "power_rating"], suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, matchedItemIds: [], reasons: ["Specify resistance and power rating before sourcing."] }],
            totals: { requiredLines: 1, optionalLines: 0, readyLines: 0, checkLines: 0, decideLines: 1, sourceLines: 0, partialLines: 0, missingLines: 0 },
          },
        }) })],
        offers: [],
      }));

    const snapshot = await createWorkspaceAdapter().loadWorkspace();

    expect(snapshot.projects[0]?.gapEvaluation).toMatchObject({
      lines: [{ decision: "decide", missingDecisions: ["resistance", "power_rating"] }],
      totals: { decideLines: 1, sourceLines: 0 },
    });
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
          id: "project-reload", name: "Reload test", status: "planned", currentRevisionId: "revision-reload", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1,
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
      .mockResolvedValueOnce(jsonResponse({ data: { id: "bom-new", revisionId: "revision-next", name: "ESP32 board", itemId: "board-esp32", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 } }))
      .mockResolvedValueOnce(jsonResponse({
        revisionId: "revision-next",
        lines: [{ lineId: "bom-new", status: "missing", decision: "source", suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, matchedItemIds: [], reasons: ["No confirmed stock covers the remaining quantity."] }],
        totals: { requiredLines: 1, optionalLines: 0, readyLines: 0, checkLines: 0, decideLines: 0, sourceLines: 1, partialLines: 0, missingLines: 1 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        revisionId: "revision-next",
        lines: [{ lineId: "bom-new", status: "supplied", decision: "ready", suppliedQuantity: 1, inspectQuantity: 0, missingQuantity: 0, matchedItemIds: ["board-esp32"], reasons: ["Physically confirmed stock covers this requirement."] }],
        totals: { requiredLines: 1, optionalLines: 0, readyLines: 1, checkLines: 0, decideLines: 0, sourceLines: 0, partialLines: 0, missingLines: 0 },
      }));

    const adapter = createWorkspaceAdapter();
    await adapter.login("correct-password");
    const created = await adapter.createProject({ name: "Desk enclosure", description: "A small enclosure" });
    expect(created).toMatchObject({ id: "project-new", currentRevision: "r01", serverRevisionId: "revision-new" });
    const revised = await adapter.createRevision(created.id, { name: "Fit pass", status: "CAD complete" });
    expect(revised).toMatchObject({ currentRevision: "r02", serverRevisionId: "revision-next", bom: [] });
    const withBom = await adapter.createBomLine(created.id, { name: "ESP32 board", requiredQuantity: 1, unit: "each", itemId: "board-esp32" });
    expect(withBom.bom[0]).toMatchObject({ label: "ESP32 board", itemId: "board-esp32" });
    expect(withBom.gapEvaluation).toMatchObject({ lines: [{ lineId: "bom-new", decision: "source" }], totals: { sourceLines: 1 } });
    await expect(adapter.refreshProjectReadiness()).resolves.toMatchObject([{ id: created.id, gapEvaluation: { lines: [{ lineId: "bom-new", decision: "ready" }], totals: { readyLines: 1, sourceLines: 0 } } }]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/v1/auth/login",
      "/api/v1/projects/with-initial-revision",
      "/api/v1/projects/project-new/revisions",
      "/api/v1/project-revisions/revision-next/bom",
      "/api/v1/project-revisions/revision-next/gaps",
      "/api/v1/project-revisions/revision-next/gaps"
    ]);
    for (const [, init] of fetchMock.mock.calls.slice(1, 4)) expect(new Headers(init?.headers).get("x-csrf-token")).toBe("csrf-project");
    expect(new Headers(fetchMock.mock.calls[4]?.[1]?.headers).get("x-csrf-token")).toBeNull();
  });

  it("clears printed revision state when a ready-made revision becomes current", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-revision-state" });
    const printedRevision = serverRevision({ id: "revision-printed", number: 3, version: 4, fabricationRoute: "printed", intendedPrinterItemId: "printer-1", buildConfigSnapshot: { id: "build-old", projectRevisionId: "revision-printed", accessories: [], explicitUnknowns: [], createdAt: "2026-08-30T10:00:00.000Z", version: 1 } });
    const readyMadeRevision = serverRevision({ id: "revision-ready", number: 4, name: "Ready-made enclosure", status: "production approved", version: 1, fabricationRoute: "ready_made" }); vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [], projects: [ serverProject({ currentRevisionId: printedRevision.id, currentRevision: printedRevision }) ], offers: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: readyMadeRevision }));

    const adapter = createWorkspaceAdapter();
    await adapter.loadWorkspace(); const revised = await adapter.createRevision("project-1", { name: readyMadeRevision.name, status: readyMadeRevision.status }); expect(revised).toMatchObject({ currentRevision: "r04", serverRevisionId: "revision-ready", serverRevisionVersion: 1, fabricationRoute: "ready_made", bom: [], artifacts: [], notes: [] });
    expect(revised).not.toHaveProperty("intendedPrinterItemId");
    expect(revised).not.toHaveProperty("buildConfigSnapshot");
  });

  it("updates an unresolved requirement role and refreshes readiness", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-bom-role" });
    const bomLine = {
      id: "line-1", revisionId: "revision-1", name: "Legacy item", role: null, requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 };
    const fetchMock = vi .spyOn(globalThis, "fetch") .mockResolvedValueOnce( jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }) ) .mockResolvedValueOnce( jsonResponse({ authenticated: true, actor: "admin", scopes: ["read", "write"] }) ) .mockResolvedValueOnce( jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [], projects: [ serverProject({ currentRevision: serverRevision({ bom: [bomLine] }) }) ], offers: [] }) ) .mockResolvedValueOnce( jsonResponse({ data: { ...bomLine, role: "consumed", version: 2 } }) ) .mockResolvedValueOnce( jsonResponse({ revisionId: "revision-1", lines: [ { lineId: "line-1", status: "missing", decision: "source", suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, matchedItemIds: [], reasons: [] } ], totals: { requiredLines: 1, optionalLines: 0, sourceLines: 1, partialLines: 0, missingLines: 1 } }) );
    const adapter = createWorkspaceAdapter(); await adapter.loadWorkspace(); await expect( adapter.updateBomLineRole("project-1", "line-1", "consumed", 1) ).resolves.toMatchObject({ bom: [{ id: "line-1", role: "consumed", version: 2 }], gapEvaluation: { totals: { sourceLines: 1 } } }); expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([ "/api/v1/health", "/api/v1/auth/session", "/api/v1/workspace", "/api/v1/bom-lines/line-1", "/api/v1/project-revisions/revision-1/gaps" ]); expect( new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get("if-match") ).toBe("1"); }); it("keeps a committed role update when readiness cannot refresh", async () => { vi.stubGlobal("document", { cookie: "forge_csrf=csrf-bom-role" }); const bomLine = { id: "line-1", revisionId: "revision-1", name: "Legacy item", role: null, requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }; vi.spyOn(globalThis, "fetch") .mockResolvedValueOnce( jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }) ) .mockResolvedValueOnce( jsonResponse({ authenticated: true, actor: "admin", scopes: ["read", "write"] }) ) .mockResolvedValueOnce( jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [], projects: [ serverProject({ currentRevision: serverRevision({ bom: [bomLine], gapEvaluation: { lines: [ { lineId: "line-1", status: "missing", decision: "check", suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, matchedItemIds: [], reasons: [] } ], totals: { requiredLines: 1, optionalLines: 0, readyLines: 0, checkLines: 1, decideLines: 0, sourceLines: 0, partialLines: 0, missingLines: 1 } } }) }) ], offers: [] }) ) .mockResolvedValueOnce( jsonResponse({ data: { ...bomLine, role: "consumed", version: 2 } }) ) .mockResolvedValueOnce( jsonResponse({ error: { message: "gap service unavailable" } }, 503) ); const adapter = createWorkspaceAdapter(); await adapter.loadWorkspace(); const updated = await adapter.updateBomLineRole( "project-1", "line-1", "consumed", 1 ); expect(updated).toMatchObject({ bom: [{ id: "line-1", role: "consumed", version: 2 }], readinessUnavailable: true }); expect(updated).not.toHaveProperty("gapEvaluation"); }); it("reuses the role update key after an ambiguous PATCH response", async () => { vi.stubGlobal("document", { cookie: "forge_csrf=csrf-bom-role" }); const bomLine = { id: "line-1", revisionId: "revision-1", name: "Legacy item", role: null, requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }; const keys: string[] = []; vi.spyOn(globalThis, "fetch") .mockResolvedValueOnce( jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }) ) .mockResolvedValueOnce( jsonResponse({ authenticated: true, actor: "admin", scopes: ["read", "write"] }) ) .mockResolvedValueOnce( jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [], projects: [ serverProject({ currentRevision: serverRevision({ bom: [bomLine] }) }) ], offers: [] }) ) .mockImplementationOnce(async (_input, init) => { keys.push(new Headers(init?.headers).get("idempotency-key") ?? ""); throw new TypeError("response lost after commit"); }) .mockImplementationOnce(async (_input, init) => { keys.push(new Headers(init?.headers).get("idempotency-key") ?? ""); return jsonResponse({ data: { ...bomLine, role: "consumed", version: 2 } }); }) .mockResolvedValueOnce( jsonResponse({ revisionId: "revision-1", lines: [], totals: { requiredLines: 0, optionalLines: 0, partialLines: 0, missingLines: 0 } }) ); const adapter = createWorkspaceAdapter(); await adapter.loadWorkspace(); await expect( adapter.updateBomLineRole("project-1", "line-1", "consumed", 1) ).rejects.toMatchObject({ kind: "offline" }); await expect( adapter.updateBomLineRole("project-1", "line-1", "consumed", 1) ).resolves.toMatchObject({ bom: [{ role: "consumed", version: 2 }] }); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); }); it("reuses a revision command key after an ambiguous response, then releases it for a later revision", async () => { vi.stubGlobal("document", { cookie: "forge_csrf=csrf-revision-retry" }); const committedRevision = serverRevision({ id: "revision-replayed", number: 2, name: "Fit pass", status: "CAD complete" }); const requestBodies: string[] = []; const requestKeys: string[] = []; let revisionWriteCount = 0; const fetchMock = vi .spyOn(globalThis, "fetch") .mockResolvedValueOnce( jsonResponse({ status: "ok", service: "benchledger", version: "0.1.0", demo: false, now: "2026-08-30T10:00:00.000Z" }) ) .mockResolvedValueOnce( jsonResponse({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }) ) .mockResolvedValueOnce( jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [], projects: [ { ...serverProject(), currentRevision: serverRevision({ id: "revision-1", number: 1 }) } ], offers: [] }) ) .mockImplementationOnce(async (_input, init) => { revisionWriteCount += 1; requestBodies.push(String(init?.body)); requestKeys.push( new Headers(init?.headers).get("idempotency-key") ?? "" ); // The server has committed before the response is lost. A retry must
// replay this same command instead of creating a second revision.
return Promise.reject(new TypeError("response lost after commit")); }) .mockImplementationOnce(async (_input, init) => { revisionWriteCount += 1; requestBodies.push(String(init?.body)); requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "" ); return jsonResponse({ data: committedRevision }); }); const adapter = createWorkspaceAdapter(); await adapter.loadWorkspace(); await expect(adapter.createRevision("project-1", { name: "Fit pass", status: "CAD complete" }) ).rejects.toMatchObject({ kind: "offline" }); const replayed = await adapter.createRevision("project-1", { name: "Fit pass", status: "CAD complete" }); expect(replayed).toMatchObject({ serverRevisionId: "revision-replayed", currentRevision: "r02" }); expect(revisionWriteCount).toBe(2); expect(requestBodies[1]).toBe(requestBodies[0]); expect(requestKeys[1]).toBe(requestKeys[0]); expect(requestKeys[0]).toMatch(/^web-revision-/); // Once the replay succeeds, an intentional later revision gets a fresh
// command identity even when its fields happen to be identical.
fetchMock.mockResolvedValueOnce(jsonResponse({ data: serverRevision({ id: "revision-new", number: 3, name: "Fit pass", status: "CAD complete" }) }) ); await adapter.createRevision("project-1", { name: "Fit pass", status: "CAD complete" }); expect(requestKeys).toHaveLength(2); const newRequest = fetchMock.mock.calls.at(-1)?.[1]; expect(new Headers(newRequest?.headers).get("idempotency-key")).not.toBe(requestKeys[0] ); }); it("reuses an exact-inventory command key after an ambiguous response, then releases it for a later identical create", async () => { vi.stubGlobal("document", { cookie: "forge_csrf=csrf-exact-inventory-retry" }); const product = { id: "catalog-filament-petg", kind: "filament" as const, manufacturer: "Bambu Lab", family: "PETG", model: "PETG HF", variant: "HF", colour: "Black", productCode: "PETG-HF-BLK", diameterMm: 1.75, netMassG: 1000 }; const input = { category: "Filament" as const, product, quantity: 1000, linkState: "reported" as const, filament: { lotBatch: "LOT-1", state: "opened" as const, openedAt: "2026-08-30", tareMassG: 164, placement: "AMS slot 1" } }; const requestBodies: string[] = []; const requestKeys: string[] = []; let writeCount = 0; const committedItem = (id: string) => serverItem({ id, name: "Bambu Lab PETG HF Black", kind: "filament", quantity: 1000, availableQuantity: 0, unit: "gram", manufacturer: "Bambu Lab", sku: "PETG-HF-BLK", evidence: { state: "unknown" } }); const committedProfile = (itemId: string) => ({ id: `profile-${itemId}`, itemId, catalogProductId: product.id, profileType: "filament_spool", linkState: "reported", details: { lot: "LOT-1", openedState: "open", openedAt: "2026-08-30T00:00:00.000Z", tareMassG: 164, currentPlacement: "AMS slot 1" } }); const fetchMock = vi.spyOn(globalThis, "fetch") .mockImplementationOnce(async (_input, init) => { writeCount += 1; requestBodies.push(String(init?.body));
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
        id: "profile-spool-1", itemId: "spool-1", catalogProductId: canonicalProduct.id, profileType: "filament_spool", linkState: "confirmed", details: { lot: "LOT-1", openedState: "open", openedAt: "2026-08-30T00:00:00.000Z", tareMassG: 164, currentPlacement: "AMS slot 1" }, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T11:00:00.000Z", version: 2 } }) ) .mockResolvedValueOnce(jsonResponse({ data: { id: "catalog-printer-h2d", kind: "printer", manufacturer: "Bambu Lab", exactModel: "H2D", exactVariant: "AMS Combo", technology: "fff", buildVolumeMm: { x: 325, y: 320, z: 325 },
        createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1
      } }));

    const adapter = createWorkspaceAdapter();
    const search = await adapter.searchCatalogProducts("filament", "PETG");
    expect(search[0]).toMatchObject({ id: canonicalProduct.id, family: "PETG", model: "PETG HF", colour: "Black", netMassG: 1000, sku: "PETG-HF-BLK" });
    const createdProduct = await adapter.createCatalogProduct({ kind: "filament", manufacturer: "Bambu Lab", family: "PETG", model: "PETG HF", variant: "HF", colour: "Black", colourCode: "BK", diameterMm: 1.75, netMassG: 1000 });
    expect(createdProduct).toMatchObject({ id: canonicalProduct.id, materialFamily: "PETG" });
    const exact = await adapter.createExactInventoryItem({ category: "Filament", product: createdProduct, quantity: 1000, linkState: "reported", filament: { lotBatch: "LOT-1", state: "opened", openedAt: "2026-08-30", tareMassG: 164, placement: "AMS slot 1" } });
    expect(exact).toMatchObject({ id: "spool-1", catalogProduct: { id: canonicalProduct.id }, productProfile: { linkState: "reported", filament: { lotBatch: "LOT-1", state: "opened" } } });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/catalog/products?kind=filament&q=PETG");
    const productBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(productBody).toEqual({ kind: "filament", manufacturer: "Bambu Lab", productName: "PETG HF", materialFamily: "PETG", materialSubtype: "HF", colourName: "Black", colourCode: "BK", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" });
    const compoundBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    const inventoryBody = compoundBody.item;
    expect(inventoryBody).not.toHaveProperty("catalogProductId");
    expect(inventoryBody).not.toHaveProperty("productProfile");
    expect(inventoryBody).not.toHaveProperty("linkState");
    expect(inventoryBody).toMatchObject({ kind: "filament", unit: "gram", manufacturer: "Bambu Lab", sku: "PETG-HF-BLK" });
    const profileBody = compoundBody.profile;
    expect(profileBody).toEqual({ catalogProductId: canonicalProduct.id, profileType: "filament_spool", linkState: "reported", details: { lot: "LOT-1", openedState: "open", openedAt: "2026-08-30T00:00:00.000Z", tareMassG: 164, currentPlacement: "AMS slot 1" } });
    expect(profileBody).not.toHaveProperty("itemId"); expect( new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("idempotency-key") ).toMatch(/^web-exact-inventory-/); const linked = await adapter.linkExactInventoryItem( "spool-1", { category: "Filament", product: createdProduct, quantity: 1000, linkState: "confirmed", filament: { lotBatch: "LOT-1", state: "opened", openedAt: "2026-08-30", tareMassG: 164, placement: "AMS slot 1" } }, 1 ); expect(linked).toMatchObject({ id: "spool-1", serverEvidence: "unknown", productProfile: { linkState: "confirmed", version: 2 } }); expect(linked.evidence).toBe(exact.evidence); expect(String(fetchMock.mock.calls[3]?.[0])).toBe( "/api/v1/inventory/spool-1/product-profile" ); expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("PUT");
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get("if-match")).toBe("1"); expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ ...profileBody, linkState: "confirmed" });
    const createdPrinter = await adapter.createCatalogProduct({ kind: "printer", manufacturer: "Bambu Lab", model: "H2D", variant: "AMS Combo", buildVolumeMm: { x: 325, y: 320, z: 325 } });
    expect(createdPrinter).toMatchObject({ id: "catalog-printer-h2d", exactModel: "H2D", buildVolumeMm: { x: 325, y: 320, z: 325 } });
    const printerBody = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body));
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

  it("reuses a build-setup command key when the response is lost after commit", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-build-retry" });
    const snapshot = {
      id: "build-config-replayed", projectRevisionId: "revision-build-retry",
      printerItemSnapshot: { itemId: "printer-1", catalogProductId: "printer-product-1" },
      filamentSelections: [], activeHotend: "Not recorded", nozzle: "Not recorded", plate: "Not recorded",
      accessories: [], firmware: "Not recorded", slicer: "Not recorded", profile: "Not recorded",
      calibration: "Not recorded", explicitUnknowns: [], contentSha256: "b".repeat(64),
      createdAt: "2026-08-30T10:00:00.000Z"
    };
    const requestBodies: string[] = [];
    const requestKeys: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: {
        project: { id: "project-build-retry", name: "Build", description: "A build", status: "idea", currentRevisionId: "revision-build-retry", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 },
        revision: { id: "revision-build-retry", projectId: "project-build-retry", number: 1, name: "Initial", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 }
      } }))
      .mockImplementationOnce(async (_input, init) => {
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return Promise.reject(new TypeError("response lost after commit"));
      })
      .mockImplementationOnce(async (_input, init) => {
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return jsonResponse({ data: snapshot, replayed: true });
      })
      .mockImplementationOnce(async (_input, init) => {
        requestBodies.push(String(init?.body));
        requestKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return jsonResponse({ data: { ...snapshot, id: "build-config-intentional" } });
      });
    const adapter = createWorkspaceAdapter();
    const project = await adapter.createProject({ name: "Build", description: "A build" });
    const input = { printerItemId: "printer-1", printerProductId: "printer-product-1", accessories: [], unknowns: [] };

    await expect(adapter.createBuildConfigSnapshot(project.id, "revision-build-retry", input)).rejects.toMatchObject({ kind: "offline" });
    await expect(adapter.createBuildConfigSnapshot(project.id, "revision-build-retry", input)).resolves.toMatchObject({ id: "build-config-replayed" });

    await expect(adapter.createBuildConfigSnapshot(project.id, "revision-build-retry", input)).resolves.toMatchObject({ id: "build-config-intentional" });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(requestKeys[0]).toMatch(/^web-build-config-/);
    expect(requestKeys[2]).not.toBe(requestKeys[0]);
  });

  it("releases a build-setup command key after a known rejection", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-build-known" });
    const projectResponse = { data: {
      project: { id: "project-build-known", name: "Build", description: "A build", status: "idea", currentRevisionId: "revision-build-known", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 },
      revision: { id: "revision-build-known", projectId: "project-build-known", number: 1, name: "Initial", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 }
    } };
    const snapshot = {
      id: "build-config-after-known", projectRevisionId: "revision-build-known",
      printerItemSnapshot: { itemId: "printer-1", catalogProductId: "printer-product-1" },
      filamentSelections: [], activeHotend: "Not recorded", nozzle: "Not recorded", plate: "Not recorded",
      accessories: [], firmware: "Not recorded", slicer: "Not recorded", profile: "Not recorded",
      calibration: "Not recorded", explicitUnknowns: [], contentSha256: "c".repeat(64), createdAt: "2026-08-30T10:00:00.000Z"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(projectResponse))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "setup rejected" } }, 400))
      .mockResolvedValueOnce(jsonResponse({ data: snapshot }));
    const adapter = createWorkspaceAdapter();
    const project = await adapter.createProject({ name: "Build", description: "A build" });
    const input = { printerItemId: "printer-1", printerProductId: "printer-product-1", accessories: [], unknowns: [] };

    await expect(adapter.createBuildConfigSnapshot(project.id, "revision-build-known", input)).rejects.toMatchObject({ kind: "validation", status: 400 });
    const rejectedKey = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("idempotency-key");
    await expect(adapter.createBuildConfigSnapshot(project.id, "revision-build-known", input)).resolves.toMatchObject({ id: "build-config-after-known" });
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("idempotency-key")).not.toBe(rejectedKey);
  });

  it("posts an eligible physical filament as an explicit unknown identity", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-build-unknown" });
    const snapshot = {
      id: "build-config-unknown",
      projectRevisionId: "revision-build-unknown",
      printerItemSnapshot: { itemId: "printer-1", catalogProductId: "printer-product-1", profileId: "printer-profile-1" },
      filamentSelections: [{ itemId: "legacy-spool", catalogIdentityState: "unknown", physicalLabel: "Drawer spool label", physicalEvidence: { state: "physically_counted", source: "legacy-import", sourceId: "spool-row-7", observedAt: "2026-08-30T09:00:00.000Z", note: "Counted from the drawer" }, role: "model", quantity: 540 }],
      activeHotend: "left", nozzle: "Not recorded", plate: "Textured PEI", accessories: [], firmware: "Not recorded", slicer: "Not recorded", profile: "Not recorded", calibration: "Not recorded", explicitUnknowns: [], contentSha256: "a".repeat(64), createdAt: "2026-08-30T10:00:00.000Z"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: { project: { id: "project-build-unknown", name: "Build", description: "A build", status: "idea", currentRevisionId: "revision-build-unknown", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }, revision: { id: "revision-build-unknown", projectId: "project-build-unknown", number: 1, name: "Initial", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 } } }))
      .mockResolvedValueOnce(jsonResponse({ data: snapshot }));
    const adapter = createWorkspaceAdapter();
    const project = await adapter.createProject({ name: "Build", description: "A build" });
    const created = await adapter.createBuildConfigSnapshot(project.id, "revision-build-unknown", {
      printerItemId: "printer-1", printerProductId: "printer-product-1", printerProfileId: "printer-profile-1", filamentItemId: "legacy-spool", filamentSelections: [{ itemId: "legacy-spool", catalogIdentityState: "unknown", role: "model", quantity: 540 }], accessories: [], unknowns: []
    });
    expect(created).toMatchObject({ filamentItemId: "legacy-spool", filamentSelections: [{ itemId: "legacy-spool", catalogIdentityState: "unknown", physicalLabel: "Drawer spool label", physicalEvidence: { state: "physically_counted", source: "legacy-import", sourceId: "spool-row-7", observedAt: "2026-08-30T09:00:00.000Z", note: "Counted from the drawer" }, role: "model", quantity: 540 }] });
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.filamentSelections).toEqual([{ itemId: "legacy-spool", catalogIdentityState: "unknown", role: "model", quantity: 540 }]);
    expect(body.filamentSelections).not.toContainEqual(expect.objectContaining({ catalogProductId: expect.anything() }));
  });

  it("rejects an ambiguous legacy filament item-only setup before posting", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-build-ambiguous" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: { project: { id: "project-build-ambiguous", name: "Build", description: "A build", status: "idea", currentRevisionId: "revision-build-ambiguous", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }, revision: { id: "revision-build-ambiguous", projectId: "project-build-ambiguous", number: 1, name: "Initial", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 } } }));
    const adapter = createWorkspaceAdapter();
    const project = await adapter.createProject({ name: "Build", description: "A build" });
    await expect(adapter.createBuildConfigSnapshot(project.id, "revision-build-ambiguous", {
      printerItemId: "printer-1", printerProductId: "printer-product-1", filamentItemId: "legacy-spool", accessories: [], unknowns: []
    })).rejects.toMatchObject({ kind: "validation" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an incomplete exact identity before posting to the catalog", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-required" });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const adapter = createWorkspaceAdapter();
    await expect(adapter.createCatalogProduct({ kind: "printer", manufacturer: "Bambu Lab", model: "H2D" })).rejects.toMatchObject({ kind: "validation" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests a bounded complete-kind catalog page for guided facets", async () => {
    const product = {
      id: "catalog-filament-pla",
      kind: "filament",
      manufacturer: "Acme",
      materialFamily: "PLA",
      colourName: "White",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
      lengthBasis: "unknown",
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
      version: 1
    } as const;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: [product], limit: 100, total: 1 }));
    const adapter = createWorkspaceAdapter();
    await expect(adapter.searchCatalogProducts("filament", "", { limit: 100 })).resolves.toHaveLength(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/catalog/products?kind=filament&limit=100");
  });

  it("retains catalog cursor metadata for bounded facet pagination", async () => {
    const product = {
      id: "catalog-filament-petg",
      kind: "filament",
      manufacturer: "Acme",
      materialFamily: "PETG",
      colourName: "Black",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
      version: 1
    } as const;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: [product], limit: 100, total: 101, nextCursor: "cursor-1" }));
    const adapter = createWorkspaceAdapter();
    await expect(adapter.listCatalogProductPage?.("filament", "", { limit: 100 })).resolves.toMatchObject({
      products: [{ id: product.id, family: "PETG", colour: "Black", netMassG: 1000 }],
      limit: 100,
      total: 101,
      nextCursor: "cursor-1"
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/catalog/products?kind=filament&limit=100");
  });

  it("retains read-only catalog provenance returned by the API mapper", async () => {
    const product = {
      id: "catalog-filament-sourced",
      kind: "filament",
      manufacturer: "Acme",
      materialFamily: "PLA",
      colourName: "White",
      diameterMm: 1.75,
      nominalNetMassG: 1000,
      lengthBasis: "unknown",
      provenance: {
        sourceUrl: "https://example.com/acme/pla-white",
        sourceLabel: "Acme official product page",
        verifiedAt: "2026-09-01T00:00:00.000Z"
      }
    } as const;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: [product], limit: 100, total: 1 }));
    const adapter = createWorkspaceAdapter();
    await expect(adapter.searchCatalogProducts("filament", "PLA", { limit: 100 })).resolves.toMatchObject({
      0: { provenance: product.provenance }
    });
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
    expect(beginBody).toMatchObject({ projectId: "project-upload", projectRevisionId: "revision-upload", role: "step", filename: "body.step", byteSize: 5, mediaType: "model/step" });
    expect(beginBody).not.toHaveProperty("revisionId");
    expect(beginBody).toMatchObject({ buildConfigurationSnapshotId: "build-config-upload" });
    expect(beginBody.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: "PUT", credentials: "include" });
  });

  it("sends only the exact work-item scope when a work-item revision is selected", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-work-item" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf-work-item", expiresAt: "2026-08-31T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [], projects: [{
        ...serverProject({ id: "project-work-item", currentRevisionId: "project-revision-4", workItems: [
          { id: "work-body", projectId: "project-work-item", name: "Body", kind: "part", currentRevisionId: "work-revision-2", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 },
          { id: "work-not-ready", projectId: "project-work-item", name: "Notes", kind: "notes", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }
        ], workItemRevisions: [{ ...serverRevision({ id: "work-revision-2", projectId: "project-work-item", number: 2 }), workItemId: "work-body" }]
        }),
        currentRevision: serverRevision({ id: "project-revision-4", projectId: "project-work-item", number: 4 })
      }], offers: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "upload-work-item", artifactId: "artifact-work-item", expiresAt: "2026-08-30T11:00:00.000Z", maxBytes: 5, uploadUrl: "/api/v1/artifacts/uploads/upload-work-item", status: "pending" } }))
      .mockResolvedValueOnce(jsonResponse({ receivedBytes: 5 }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "artifact-work-item", projectId: "project-work-item", workItemId: "work-body", workItemRevisionId: "work-revision-2", role: "step", filename: "body.step", mediaType: "model/step", byteSize: 5, sha256: "b".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-08-30T10:00:00.000Z", version: 1 } }));

    const adapter = createWorkspaceAdapter();
    await adapter.login("correct-password");
    await adapter.loadWorkspace();
    const file = new File(["solid"], "body.step", { type: "model/step" });
    const updated = await adapter.uploadArtifact("project-work-item", file, "STEP", { kind: "work-item", workItemId: "work-body", workItemRevisionId: "work-revision-2" });
    expect(updated.allArtifacts?.[0]).toMatchObject({ workItemId: "work-body", workItemRevisionId: "work-revision-2" });
    const beginBody = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)) as Record<string, unknown>;
    expect(Object.keys(beginBody).sort()).toEqual(["byteSize", "filename", "mediaType", "projectId", "role", "sha256", "source", "workItemId", "workItemRevisionId"].sort());
    expect(beginBody).toMatchObject({ projectId: "project-work-item", workItemId: "work-body", workItemRevisionId: "work-revision-2", role: "step" });
    expect(beginBody).not.toHaveProperty("projectRevisionId");
    expect(beginBody).not.toHaveProperty("revisionId");
  });

  it("lists exact artifact scopes and leaves All files unscoped for legacy visibility", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: [serverArtifact({ id: "project-artifact", projectRevisionId: "project-revision-1", revisionId: undefined })], limit: 50 }))
      .mockResolvedValueOnce(jsonResponse({ data: [serverArtifact({ id: "work-artifact", workItemId: "work-body", workItemRevisionId: "work-revision-1", revisionId: undefined })], limit: 50 }))
      .mockResolvedValueOnce(jsonResponse({ data: [serverArtifact({ id: "legacy-artifact", revisionId: undefined })], limit: 50 }));
    const adapter = createWorkspaceAdapter();
    await expect(adapter.listArtifacts("project-1", { kind: "project", projectRevisionId: "project-revision-1" })).resolves.toMatchObject([{ id: "project-artifact", projectRevisionId: "project-revision-1" }]);
    await expect(adapter.listArtifacts("project-1", { kind: "work-item", workItemId: "work-body", workItemRevisionId: "work-revision-1" })).resolves.toMatchObject([{ id: "work-artifact", workItemId: "work-body", workItemRevisionId: "work-revision-1" }]);
    await expect(adapter.listArtifacts("project-1")).resolves.toMatchObject([{ id: "legacy-artifact" }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/projects/project-1/artifacts?projectRevisionId=project-revision-1");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/v1/projects/project-1/artifacts?workItemId=work-body&workItemRevisionId=work-revision-1");
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("/api/v1/projects/project-1/artifacts");
  });
});

describe("sample bulk inventory adapter", () => {
  it("prevalidates every target and applies changes atomically with no-op parity", async () => {
    const adapter = createSampleWorkspaceAdapter();
    const page = await adapter.listInventory({ limit: 2 });
    const first = page.items[0]!;
    const second = page.items[1]!;
    const change = { location: "Bulk shelf", condition: "good" as const, tags: { add: ["bulk-tag"], remove: [] } };

    await expect(adapter.bulkUpdateInventory({
      targets: [{ itemId: first.id, expectedVersion: first.version! }, { itemId: second.id, expectedVersion: second.version! + 1 }],
      changes: change
    })).rejects.toMatchObject({ kind: "validation", status: 409, code: "version_conflict" });
    const afterConflict = await adapter.listInventory({ limit: 2 });
    expect(afterConflict.items.map((item) => item.location)).toEqual([first.location, second.location]);
    expect(afterConflict.items.map((item) => item.version)).toEqual([first.version, second.version]);

    const result = await adapter.bulkUpdateInventory({
      targets: [{ itemId: first.id, expectedVersion: first.version! }, { itemId: second.id, expectedVersion: second.version! }],
      changes: change
    });
    expect(result.updated.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(result.unchanged).toEqual([]);
    expect(result.updated.every((item) => item.location === "Bulk shelf" && item.condition === "good" && item.tags.includes("bulk-tag"))).toBe(true);
    expect(result.audits).toHaveLength(2);
    expect(result.correlationId).toMatch(/^sample-bulk-/);
    expect(result.replayed).toBe(false);

    const noOp = await adapter.bulkUpdateInventory({
      targets: result.updated.map((item) => ({ itemId: item.id, expectedVersion: item.version! })),
      changes: change
    });
    expect(noOp.updated).toEqual([]);
    expect(noOp.unchanged.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(noOp.audits).toEqual([]);
  });

  it("rolls back when a later target would exceed the projected tag cap", async () => {
    const adapter = createSampleWorkspaceAdapter();
    const page = await adapter.listInventory({ limit: 2 });
    const first = page.items[0]!;
    const second = page.items[1]!;
    const firstPrepared = await adapter.updateInventoryItem(first.id, { tags: Array.from({ length: 49 }, (_, index) => `first-${index}`) }, first.version);
    const secondPrepared = await adapter.updateInventoryItem(second.id, { tags: Array.from({ length: 50 }, (_, index) => `second-${index}`) }, second.version);

    await expect(adapter.bulkUpdateInventory({
      targets: [{ itemId: first.id, expectedVersion: firstPrepared.version! }, { itemId: second.id, expectedVersion: secondPrepared.version! }],
      changes: { tags: { add: ["new-tag"] } }
    })).rejects.toMatchObject({ kind: "validation", status: 400, code: "invalid_bulk_changes" });

    const after = await adapter.listInventory({ limit: 2 });
    expect(after.items.map((item) => item.tags)).toEqual([firstPrepared.tags, secondPrepared.tags]);
    expect(after.items.map((item) => item.version)).toEqual([firstPrepared.version, secondPrepared.version]);
  });

  it("matches sample tag add and remove operations without regard to case", async () => {
    const adapter = createSampleWorkspaceAdapter();
    const page = await adapter.listInventory({ limit: 1 });
    const item = page.items[0]!;
    const seeded = await adapter.updateInventoryItem(item.id, { tags: ["CaseTag"] }, item.version);
    const duplicate = await adapter.bulkUpdateInventory({
      targets: [{ itemId: seeded.id, expectedVersion: seeded.version! }],
      changes: { tags: { add: ["casetag"] } }
    });
    expect(duplicate.updated).toEqual([]);
    expect(duplicate.unchanged[0]?.tags).toEqual(["CaseTag"]);

    const removed = await adapter.bulkUpdateInventory({
      targets: [{ itemId: seeded.id, expectedVersion: seeded.version! }],
      changes: { tags: { remove: ["CASETAG"] } }
    });
    expect(removed.updated[0]?.tags).toEqual([]);
  });
});

describe("web data mappers", () => {
  it("maps every inventory kind, unit, evidence state, and measured dimension", () => {
    const cases: Array<{ kind: string; category: InventoryItem["category"]; accent: InventoryItem["accent"]; }> = [
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
        variant: index === 0 ? "Model variant" : index === 1 ? "SKU variant" : "",
        unit: index % 3 === 0 ? "g" : index % 3 === 1 ? "m" : "each",
        description: index === 2 ? "No description recorded." : `Description ${index}`,
        location: index === 3 ? "Unassigned" : `Location ${index}`,
        tags: [`tag-${index}`],
        compatibility: []
      });
      expect(mapped.tags).not.toBe(serverItem({ tags: [`tag-${index}`] }).tags);
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
    expect(mapInventoryItem(serverItem({ name: "ESP32", kind: "electronic" }))).toMatchObject({ name: "ESP32", variant: "" });
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
      ...(index === 8 ? { bom: [{ id: "fallback-bom", revisionId: "revision-8", name: "Fallback requirement", requiredQuantity: 2, unit: "gram", optional: true, notes: "Use black PETG", version: 1 }] } : {}),
      ...(index === 8 ? { artifacts: [serverArtifact({ id: "fallback-artifact", revisionId: undefined, role: "other", filename: "notes.txt", byteSize: 0 })] } : {}),
      ...(index === 0 ? { currentRevision: serverRevision({ id: "revision-0", projectId: "project-0", number: 1, status, notes: "Record a measurement", bom: [{ id: "bom-0", revisionId: "revision-0", name: "Insert", requiredQuantity: 1, unit: "each", optional: false, notes: "M3", version: 1 }], artifacts: [
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
    projects.push(serverProject({ id: "project-no-revision", name: "No revision", status: "planned", currentRevisionId: undefined, currentRevision: undefined }));

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
    expect(snapshot.projects.find((project) => project.id === "project-no-revision")).toMatchObject({ currentRevision: "No revision", railStep: 0, workItem: "Project setup" });
    expect(snapshot.projects.find((project) => project.id === "project-idea")).toMatchObject({ status: "idea", railStep: 0, accent: "orange" });
    expect(snapshot.projects.find((project) => project.id === "project-7")).toMatchObject({ status: "complete", railStep: 5, accent: "blue" });

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

  it("preserves set units, structured alternatives, conversions, and canonical gap candidates", async () => {
    const conversion = {
      inventory: { quantity: 1, unit: "set" },
      requirement: { quantity: 8, unit: "each" },
      evidence: { basis: "package_label", observedAt: "2026-08-30T00:00:00.000Z", source: "https://example.test/led-sets", sourceId: "label-1", note: "Eight per sealed set" }
    };
    const alternative = { itemId: "led-sets", compatible: "confirmed", reason: "Sealed package is a confirmed substitute", quantityConversion: conversion };
    const candidate = { itemId: "led-sets", relationship: "confirmed_alternative", compatibility: "confirmed", availableQuantity: 16, suppliedQuantity: 8, inspectQuantity: 0, reason: "Sealed package. Conversion: 1 set = 8 each. Capacity: 2 set(s) = 16 each." };
    const project = serverProject({
      currentRevision: serverRevision({
        bom: [{ id: "bom-led", revisionId: "revision-1", name: "LED package", itemId: undefined, requiredQuantity: 8, unit: "each", optional: false, constraints: {}, alternatives: [alternative], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }],
        gapEvaluation: {
          lines: [{ lineId: "bom-led", name: "LED package", optional: false, status: "supplied", decision: "ready", requiredQuantity: 8, unit: "each", suppliedQuantity: 8, inspectQuantity: 0, missingQuantity: 0, matchedItemIds: ["led-sets"], reasons: ["Physically confirmed stock covers this requirement."], alternatives: [alternative], candidates: [candidate] }],
          totals: { requiredLines: 1, optionalLines: 0, readyLines: 1, checkLines: 0, decideLines: 0, sourceLines: 0, partialLines: 0, missingLines: 0 }
        }
      })
    });
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-units" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", scopes: ["read"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [serverItem({ id: "led-sets", unit: "set", quantity: 2, availableQuantity: 2 })], projects: [project], offers: [] }));

    const snapshot = await createWorkspaceAdapter().loadWorkspace();
    expect(snapshot.inventory[0]).toMatchObject({ id: "led-sets", unit: "set" });
    expect(snapshot.projects[0]?.bom[0]).toMatchObject({ unit: "each", serverUnit: "each", alternatives: [alternative] });
    expect(snapshot.projects[0]?.gapEvaluation?.lines[0]).toMatchObject({ unit: "each", requiredQuantity: 8, alternatives: [alternative], candidates: [candidate] });
  });

  it("keeps a set-valued reconciliation preview scalar labelled as set after commit mapping", async () => {
    const project = serverProject({
      id: "project-set-reconciliation",
      currentRevisionId: "revision-set-reconciliation",
      currentRevision: serverRevision({
        id: "revision-set-reconciliation",
        bom: [{ id: "bom-set-reconciliation", revisionId: "revision-set-reconciliation", name: "LED package", requiredQuantity: 10, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }]
      })
    });
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-reconciliation-units" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [serverItem({ id: "set-reconciliation-item", unit: "set", quantity: 2, availableQuantity: 0 })], projects: [project], offers: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        id: "commit-set-reconciliation",
        projectId: project.id,
        projectRevisionId: "revision-set-reconciliation",
        draftId: "draft-set-reconciliation",
        status: "committed",
        basis: {
          hash: "a".repeat(64),
          bomLines: [{ bomLineId: "bom-set-reconciliation", version: 1, requiredQuantity: 10, unit: "each" }],
          reservations: [{ reservationId: "reservation-set-reconciliation", lineId: "bom-set-reconciliation", itemId: "set-reconciliation-item", quantity: 2, unit: "set", status: "active", version: 1 }],
          items: [{ itemId: "set-reconciliation-item", version: 1, onHand: 2, allocated: 2, available: 0, unit: "set" }]
        },
        lines: [{ bomLineId: "bom-set-reconciliation", outcomes: [{ reservationId: "reservation-set-reconciliation", itemId: "set-reconciliation-item", kind: "consumed", quantity: 2, unit: "set", evidence: { state: "physically_counted" } }] }],
        stockChanges: [],
        reservationChanges: [],
        createdAssets: [],
        committedAt: "2026-08-30T10:00:00.000Z"
      } }));

    const adapter = createWorkspaceAdapter();
    await adapter.loadWorkspace();
    const committed = await adapter.commitReconciliation(project.id, "revision-set-reconciliation", {
      projectId: project.id,
      projectName: project.name,
      projectRevisionId: "revision-set-reconciliation",
      status: "draft",
      lines: [],
      trace: { draftId: "draft-set-reconciliation" }
    });

    expect(committed.preview?.lines[0]).toMatchObject({ bomLineId: "bom-set-reconciliation", reservedQuantity: 2, unit: "set" });
    expect(committed.lines[0]).toMatchObject({ plannedQuantity: 10, plannedUnit: "each", reservedQuantity: 2, unit: "set", outcomes: [{ quantity: 2, unit: "set" }] });
  });

  it("maps and submits a set-valued reconciliation draft without relabelling the BOM", async () => {
    const revisionId = "revision-set-draft";
    const project = serverProject({
      id: "project-set-draft",
      currentRevisionId: revisionId,
      currentRevision: serverRevision({
        id: revisionId,
        projectId: "project-set-draft",
        bom: [{ id: "bom-set-draft", revisionId, name: "LED package", requiredQuantity: 10, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 3 }]
      })
    });
    const reservation = { reservationId: "reservation-set-draft", lineId: "bom-set-draft", itemId: "set-item", quantity: 1, unit: "set", status: "active", version: 4 };
    const draft = {
      id: "draft-set-draft",
      projectId: project.id,
      projectRevisionId: revisionId,
      status: "draft",
      version: 5,
      basis: {
        hash: "b".repeat(64),
        bomLines: [{ bomLineId: "bom-set-draft", version: 3, requiredQuantity: 10, unit: "each" }],
        reservations: [reservation],
        items: [{ itemId: "set-item", version: 7, onHand: 2, allocated: 1, available: 1, unit: "set" }]
      },
      lines: [{ bomLineId: "bom-set-draft", outcomes: [{ reservationId: reservation.reservationId, itemId: reservation.itemId, kind: "consumed", quantity: 1, unit: "set", evidence: { state: "physically_counted", source: "Build notes" } }] }],
      preview: {
        lines: [{ bomLineId: "bom-set-draft", reservedQuantity: 1, accountedQuantity: 1, unaccountedQuantity: 0, outcomeCount: 1, unit: "set" }],
        reservationChanges: [{ reservationId: reservation.reservationId, fromStatus: "active", toStatus: "settled", quantity: 1, unit: "set" }],
        stockChanges: [{ itemId: "set-item", kind: "consume", quantity: 1, unit: "set", beforeOnHand: 2, afterOnHand: 1, beforeAllocated: 1, afterAllocated: 0, beforeAvailable: 1, afterAvailable: 1, eventKey: "event-set-draft" }],
        createdAssets: []
      },
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:05:00.000Z"
    };
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-reconciliation-draft" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [serverItem({ id: "set-item", unit: "set", quantity: 2, availableQuantity: 1 })], projects: [project], offers: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: draft, replayed: false }));

    const adapter = createWorkspaceAdapter();
    await adapter.loadWorkspace();
    const input: ReconciliationViewModel = {
      projectId: project.id,
      projectName: project.name,
      projectRevisionId: revisionId,
      status: "draft",
      version: 4,
      lines: [{
        id: "bom-set-draft",
        bomLineId: "bom-set-draft",
        name: "LED package",
        itemLabel: "LED sets",
        plannedQuantity: 10,
        plannedUnit: "each",
        reservedQuantity: 1,
        unit: "set",
        reservations: [{ id: reservation.reservationId, itemId: reservation.itemId, quantity: 1, unit: "set", status: "active", version: 4 }],
        outcomes: [{ id: "outcome-set-draft", reservationId: reservation.reservationId, itemId: reservation.itemId, kind: "consumed", quantity: 1, unit: "set", evidence: { state: "physically_counted", source: "Build notes" } }]
      }],
      trace: { draftId: "draft-set-draft", basisHash: "b".repeat(64) }
    };
    const mapped = await adapter.saveReconciliationDraft(project.id, revisionId, input);
    expect(mapped.lines[0]).toMatchObject({ plannedQuantity: 10, plannedUnit: "each", reservedQuantity: 1, unit: "set", outcomes: [{ quantity: 1, unit: "set" }] });
    expect(mapped.preview?.lines[0]).toMatchObject({ reservedQuantity: 1, accountedQuantity: 1, unit: "set" });
    const body = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(body).toMatchObject({ projectRevisionId: revisionId, draftId: "draft-set-draft", expectedVersion: 4, lines: [{ outcomes: [{ quantity: 1, unit: "set" }] }] });
  });

  it("uses an active reservation unit and falls back to the BOM unit when none is reserved", async () => {
    const revisionId = "revision-reconciliation-initial";
    const project = serverProject({
      id: "project-reconciliation-initial",
      currentRevisionId: revisionId,
      currentRevision: serverRevision({
        id: revisionId,
        projectId: "project-reconciliation-initial",
        bom: [
          { id: "bom-set-initial", revisionId, name: "LED package", requiredQuantity: 10, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 },
          { id: "bom-empty-initial", revisionId, name: "Spacer", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }
        ]
      })
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", scopes: ["read"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [serverItem({ id: "set-item-initial", unit: "set", quantity: 1, availableQuantity: 0 })], projects: [project], offers: [] }))
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse([{ id: "reservation-set-initial", lineId: "bom-set-initial", itemId: "set-item-initial", quantity: 1, unit: "set", status: "active", version: 2 }]));

    const adapter = createWorkspaceAdapter();
    await adapter.loadWorkspace();
    const initial = await adapter.readReconciliation(project.id, revisionId);

    expect(initial.lines).toMatchObject([
      { bomLineId: "bom-set-initial", plannedQuantity: 10, plannedUnit: "each", reservedQuantity: 1, unit: "set" }
    ]);
    expect(initial.availableLines).toMatchObject([
      { bomLineId: "bom-empty-initial", plannedQuantity: 1, plannedUnit: "each", reservedQuantity: 0, unit: "each" }
    ]);
  });

  it("starts close-out with only active-reservation lines, even for a large BOM", async () => {
    const revisionId = "revision-reservation-focused";
    const bom = Array.from({ length: 22 }, (_, index) => ({
      id: `bom-focused-${index + 1}`,
      revisionId,
      name: `Requirement ${index + 1}`,
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      constraints: {},
      alternatives: [],
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
      version: index + 1
    }));
    const project = serverProject({
      id: "project-reservation-focused",
      currentRevisionId: revisionId,
      currentRevision: serverRevision({ id: revisionId, projectId: "project-reservation-focused", bom })
    });
    const activeReservations = [0, 7, 14].map((lineIndex) => ({
      id: `reservation-focused-${lineIndex + 1}`,
      lineId: `bom-focused-${lineIndex + 1}`,
      itemId: `item-focused-${lineIndex + 1}`,
      quantity: 1,
      unit: "each",
      status: "active",
      version: 2
    }));
    const settledReservation = {
      id: "reservation-settled-only",
      lineId: "bom-focused-22",
      itemId: "item-focused-settled",
      quantity: 1,
      unit: "each",
      status: "settled",
      version: 3
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", scopes: ["read"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: activeReservations.concat(settledReservation).map((reservation) => serverItem({ id: reservation.itemId, name: reservation.itemId })), projects: [project], offers: [] }))
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse([...activeReservations, settledReservation]));

    const adapter = createWorkspaceAdapter();
    await adapter.loadWorkspace();
    const initial = await adapter.readReconciliation(project.id, revisionId);

    expect(initial.lines).toHaveLength(3);
    expect(initial.lines.map((line) => line.bomLineId)).toEqual(["bom-focused-1", "bom-focused-8", "bom-focused-15"]);
    expect(initial.availableLines).toHaveLength(19);
    expect(initial.availableLines?.map((line) => line.bomLineId)).toContain("bom-focused-22");
    expect(initial.availableLines?.every((line) => line.reservedQuantity === 0)).toBe(true);
  });

  it("maps a draft as active reservations plus explicitly submitted legacy lines", async () => {
    const revisionId = "revision-submitted-legacy";
    const project = serverProject({
      id: "project-submitted-legacy",
      currentRevisionId: revisionId,
      currentRevision: serverRevision({
        id: revisionId,
        projectId: "project-submitted-legacy",
        bom: [
          { id: "bom-active", revisionId, name: "Reserved part", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 4 },
          { id: "bom-legacy", revisionId, name: "Legacy reviewed part", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 5 },
          { id: "bom-unreserved", revisionId, name: "Unreserved part", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 6 }
        ]
      })
    });
    const draft = {
      id: "draft-submitted-legacy",
      projectId: project.id,
      projectRevisionId: revisionId,
      status: "draft",
      version: 3,
      basis: {
        hash: "c".repeat(64),
        bomLines: [
          { bomLineId: "bom-active", version: 4, requiredQuantity: 1, unit: "each" },
          { bomLineId: "bom-legacy", version: 5, requiredQuantity: 1, unit: "each" },
          { bomLineId: "bom-unreserved", version: 6, requiredQuantity: 1, unit: "each" }
        ],
        reservations: [{ reservationId: "reservation-active", lineId: "bom-active", itemId: "item-active", quantity: 1, unit: "each", status: "active", version: 2 }],
        items: [{ itemId: "item-active", version: 2, onHand: 1, allocated: 1, available: 0, unit: "each" }]
      },
      lines: [{ bomLineId: "bom-legacy", outcomes: [{ kind: "reviewed_no_change", quantity: 0, unit: "each", evidence: { state: "physically_counted" } }] }],
      preview: {
        lines: [
          { bomLineId: "bom-active", reservedQuantity: 1, accountedQuantity: 0, unaccountedQuantity: 1, outcomeCount: 0, unit: "each" },
          { bomLineId: "bom-legacy", reservedQuantity: 0, accountedQuantity: 0, unaccountedQuantity: 0, outcomeCount: 1, unit: "each" },
          { bomLineId: "bom-unreserved", reservedQuantity: 0, accountedQuantity: 0, unaccountedQuantity: 0, outcomeCount: 0, unit: "each" }
        ],
        reservationChanges: [],
        stockChanges: [],
        createdAssets: []
      },
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z"
    };
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf-submitted-legacy" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [serverItem({ id: "item-active", name: "Reserved part", availableQuantity: 0 })], projects: [project], offers: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: draft }))
      .mockResolvedValueOnce(jsonResponse({ data: draft }));

    const adapter = createWorkspaceAdapter();
    await adapter.loadWorkspace();
    const mapped = await adapter.readReconciliation(project.id, revisionId);

    expect(mapped.lines.map((line) => line.bomLineId)).toEqual(["bom-active", "bom-legacy"]);
    expect(mapped.lines.find((line) => line.bomLineId === "bom-legacy")?.outcomes[0]?.kind).toBe("reviewed_no_change");
    expect(mapped.availableLines?.map((line) => line.bomLineId)).toEqual(["bom-unreserved"]);

    await adapter.saveReconciliationDraft(project.id, revisionId, mapped);
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.lines.map((line: { bomLineId: string }) => line.bomLineId)).toEqual(["bom-active", "bom-legacy"]);
    expect(body.lines).not.toEqual(expect.arrayContaining([expect.objectContaining({ bomLineId: "bom-unreserved" })]));
  });
});

describe("reconciliation retry branches", () => {
  const revisionId = "revision-retry-branches";
  const project = serverProject({
    id: "project-retry-branches",
    currentRevisionId: revisionId,
    currentRevision: serverRevision({ id: revisionId, projectId: "project-retry-branches", bom: [] })
  });
  const model: ReconciliationViewModel = {
    projectId: project.id,
    projectName: project.name,
    projectRevisionId: revisionId,
    status: "draft",
    version: 1,
    lines: [],
    trace: { draftId: "draft-retry-branches" }
  };
  const prepare = async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [], projects: [project], offers: [] }));
    const adapter = createWorkspaceAdapter();
    await adapter.loadWorkspace();
    return { adapter, fetchMock };
  };

  it("releases known reconciliation failures and retains one key for ambiguous retries", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=reconciliation-retry" });

    const saveKnown = await prepare();
    saveKnown.fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "draft rejected" } }, 400));
    await expect(saveKnown.adapter.saveReconciliationDraft(project.id, revisionId, model)).rejects.toMatchObject({ kind: "validation", status: 400 });
    const firstSaveKey = new Headers(saveKnown.fetchMock.mock.calls.at(-1)?.[1]?.headers).get("idempotency-key");
    saveKnown.fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "draft rejected again" } }, 400));
    await expect(saveKnown.adapter.saveReconciliationDraft(project.id, revisionId, model)).rejects.toMatchObject({ kind: "validation", status: 400 });
    const secondSaveKey = new Headers(saveKnown.fetchMock.mock.calls.at(-1)?.[1]?.headers).get("idempotency-key");
    expect(secondSaveKey).not.toBe(firstSaveKey);

    const saveAmbiguous = await prepare();
    saveAmbiguous.fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "response lost" } }, 500));
    await expect(saveAmbiguous.adapter.saveReconciliationDraft(project.id, revisionId, model)).rejects.toMatchObject({ kind: "server", status: 500 });
    const ambiguousSaveKey = new Headers(saveAmbiguous.fetchMock.mock.calls.at(-1)?.[1]?.headers).get("idempotency-key");
    saveAmbiguous.fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "response lost again" } }, 500));
    await expect(saveAmbiguous.adapter.saveReconciliationDraft(project.id, revisionId, model)).rejects.toMatchObject({ kind: "server", status: 500 });
    expect(new Headers(saveAmbiguous.fetchMock.mock.calls.at(-1)?.[1]?.headers).get("idempotency-key")).toBe(ambiguousSaveKey);

    const commitKnown = await prepare();
    commitKnown.fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "commit rejected" } }, 400));
    await expect(commitKnown.adapter.commitReconciliation(project.id, revisionId, model)).rejects.toMatchObject({ kind: "validation", status: 400 });
    const firstCommitKey = new Headers(commitKnown.fetchMock.mock.calls.at(-1)?.[1]?.headers).get("idempotency-key");
    commitKnown.fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "commit rejected again" } }, 400));
    await expect(commitKnown.adapter.commitReconciliation(project.id, revisionId, model)).rejects.toMatchObject({ kind: "validation", status: 400 });
    expect(new Headers(commitKnown.fetchMock.mock.calls.at(-1)?.[1]?.headers).get("idempotency-key")).not.toBe(firstCommitKey);

    const commitAmbiguous = await prepare();
    commitAmbiguous.fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "commit response lost" } }, 500));
    await expect(commitAmbiguous.adapter.commitReconciliation(project.id, revisionId, model)).rejects.toMatchObject({ kind: "server", status: 500 });
    const ambiguousCommitKey = new Headers(commitAmbiguous.fetchMock.mock.calls.at(-1)?.[1]?.headers).get("idempotency-key");
    commitAmbiguous.fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "commit response lost again" } }, 500));
    await expect(commitAmbiguous.adapter.commitReconciliation(project.id, revisionId, model)).rejects.toMatchObject({ kind: "server", status: 500 });
    expect(new Headers(commitAmbiguous.fetchMock.mock.calls.at(-1)?.[1]?.headers).get("idempotency-key")).toBe(ambiguousCommitKey);
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
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: { event: {} } }) ); await expect(adapter.recordCount("missing-item", 1)).rejects.toMatchObject({ kind: "server", status: 502, message: "The service returned an incomplete count" }); vi.restoreAllMocks(); vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({})); await expect(adapter.createInventoryItem({ name: "New", category: "Accessories", quantity: 1, unit: "each" }) ).rejects.toMatchObject({ kind: "server", status: 502, message: "The service returned an incomplete mutation" }); vi.restoreAllMocks(); vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({})); await expect( adapter.createProject({ name: "New project", description: "Description" }) ).rejects.toMatchObject({ kind: "server", status: 502 }); vi.restoreAllMocks(); const uncachedRevisionFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ data: { id: "unknown-revision", projectId: "unknown", number: 2, name: "No cache", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 } }));
    await expect(adapter.createRevision("not-loaded", { name: "No cache" })).rejects.toMatchObject({ kind: "validation", status: 409 }); expect(uncachedRevisionFetch).not.toHaveBeenCalled();
    await expect(adapter.createBomLine("not-loaded", { name: "No revision", requiredQuantity: 1, unit: "each" })).rejects.toMatchObject({ kind: "validation", status: 409, message: "Create a project revision before adding a requirement" }); await expect(adapter.uploadArtifact( "not-loaded", new File(["data"], "data.stl"), "STL" ) ).rejects.toMatchObject({ kind: "validation", status: 409, message: "Create a project revision before uploading a file" }); }); it("removes a cached project with exact-name, version, and idempotency headers", async () => { const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf-remove", expiresAt: "2026-08-31T10:00:00.000Z" })).mockResolvedValueOnce( jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" })).mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }) ).mockResolvedValueOnce( jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [], projects: [{ ...serverProject(), currentRevision: serverRevision() }], offers: [] }) ).mockResolvedValueOnce(jsonResponse({ data: { id: "project-1", name: "Maker project", removedAt: "2026-08-30T11:00:00.000Z", removedBy: "admin", lastLifecycleStatus: "planned", releasedReservationIds: [], version: 2, auditId: "audit-remove" } })); const adapter = createWorkspaceAdapter(); await adapter.login("correct-password"); await adapter.loadWorkspace(); await expect(adapter.removeProject("project-1", 1)).resolves.toMatchObject({ id: "project-1", removedAt: "2026-08-30T11:00:00.000Z", lastLifecycleStatus: "planned", version: 2 }); const [url, init] = fetchMock.mock.calls[4]!; expect(url).toBe("/api/v1/projects/project-1"); expect(init).toMatchObject({ method: "DELETE", body: JSON.stringify({ name: "Maker project" }) }); expect(new Headers(init?.headers).get("if-match")).toBe("1"); expect(new Headers(init?.headers).get("idempotency-key")).toMatch( /^web-project-remove-/u );

  });

  it("reuses the removal idempotency key after an ambiguous response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf-remove-retry", expiresAt: "2026-08-31T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ status: "ok", service: "benchledger", version: "test", demo: false, now: "2026-08-30T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, actor: "admin", source: "ui", scopes: ["read", "write"] }))
      .mockResolvedValueOnce(jsonResponse({ source: "api", fetchedAt: "2026-08-30T10:00:00.000Z", inventory: [], projects: [{ ...serverProject(), currentRevision: serverRevision() }], offers: [] }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "The response was lost after the server committed" } }, 500 ) ) .mockResolvedValueOnce(jsonResponse({ data: { id: "project-1", name: "Maker project", removedAt: "2026-08-30T11:00:00.000Z", removedBy: "admin", lastLifecycleStatus: "planned", releasedReservationIds: [], version: 2, auditId: "audit-remove-retry" } }));
    const adapter = createWorkspaceAdapter();
    await adapter.login("correct-password");
    await adapter.loadWorkspace();

    await expect(adapter.removeProject("project-1", 1)).rejects.toMatchObject({ kind: "server", status: 500 }); await expect(adapter.removeProject("project-1", 1)).resolves.toMatchObject({ id: "project-1", removedAt: "2026-08-30T11:00:00.000Z" });
    const firstKey = new Headers(fetchMock.mock.calls[4]?.[1]?.headers).get( "idempotency-key" ); const secondKey = new Headers(fetchMock.mock.calls[5]?.[1]?.headers).get("idempotency-key" ); expect(firstKey).toMatch(/^web-project-remove-/u);
    expect(secondKey).toBe(firstKey); });
  }); describe("sample workspace adapter", () => { it("keeps sample category labels and category filtering coherent", async () => {
    const adapter = createSampleWorkspaceAdapter(); const categories = await adapter.listInventoryCategories({ limit: 50 }); const categoryIds = new Set(categories.data.map((category) => category.id)); const all = await adapter.listInventory({ limit: 50 }); expect(all.items)
      .toHaveLength(14); expect( all.items.every( (item) => item.categoryNodeId !== undefined && categoryIds.has(item.categoryNodeId) ))
      .toBe(true); const electronics = await adapter.listInventory({ categoryNodeId: "category-electronics", limit: 50 }); expect(electronics.items.map((item) => item.name)).toEqual([ "2.54 mm pin headers", "ESP32 DevKitC" ]); expect( electronics.items.every( (item) => item.categoryNodeId === "category-electronics" ) ) .toBe(true); }); it("keeps named sample projects revision-backed for build approach saves", async () => { const adapter = createSampleWorkspaceAdapter(); const snapshot = await adapter.loadWorkspace(); for (const expected of [ { name: "Horizon wallwash", revisionId: "sample-project-circadian-r09" }, { name: "Memory Loop v2", revisionId: "sample-project-battery-r02" } ]) { const project = snapshot.projects.find( (candidate) => candidate.name === expected.name ); expect(project).toMatchObject({ serverRevisionId: expected.revisionId, serverRevisionVersion: 1 }); expect(project?.bom.every((line) => line.role === "consumed")).toBe(true);
    const saved = await adapter.updateProjectRevision( expected.revisionId, { fabricationRoute: "printed", intendedPrinterItemId: "eq-h2d" }, project?.serverRevisionVersion );
    expect(saved).toMatchObject({ serverRevisionId: expected.revisionId, serverRevisionVersion: 2, fabricationRoute: "printed", intendedPrinterItemId: "eq-h2d" }); await expect( adapter.updateProjectRevision( expected.revisionId, { fabricationRoute: "none" }, 1 ) ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
} }); it("keeps demo pagination server-shaped and rejects malformed cursors", async () => {
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
    const createdProject = await adapter.createProject({ name: "Sample project", description: "A demo project", fabricationRoute: "printed", intendedPrinterItemId: "printer-1" });
    expect(createdProject).toMatchObject({ name: "Sample project", status: "idea", currentRevision: "r01", railStep: 0, fabricationRoute: "printed", intendedPrinterItemId: "printer-1" }); const oldBuildConfig = await adapter.createBuildConfigSnapshot( createdProject.id, createdProject.serverRevisionId!, { printerItemId: "printer-1", accessories: [], unknowns: [] } ); Object.assign(createdProject, { buildConfigSnapshot: oldBuildConfig });
    const revised = await adapter.createRevision(createdProject.id, { name: "r02 concept", notes: "Measure first", status: "CAD complete", fabricationRoute: "ready_made" });
    expect(revised).toMatchObject({ currentRevision: "r02 concept", railStep: 1, notes: ["Measure first"], bom: [], artifacts: [], fabricationRoute: "ready_made", intendedPrinterItemId: null }); expect(revised).not.toHaveProperty("buildConfigSnapshot"); await expect(adapter.updateProjectRevision(createdProject.serverRevisionId!, { fabricationRoute: "ready_made", intendedPrinterItemId: "printer-1" }, revised.serverRevisionVersion)).rejects.toMatchObject({ status: 400 }); const withBom = await adapter.createBomLine(createdProject.id, { name: "JST connector", requiredQuantity: 2, unit: "each", itemId: createdItem.id, note: "One per panel" });
    expect(withBom.bom[0]).toMatchObject({ label: "JST connector", required: 2, optional: false, note: "One per panel" });
    const roleResolved = await adapter.updateBomLineRole( createdProject.id, withBom.bom[0]!.id, "consumed", 1 ); expect(roleResolved.bom[0]).toMatchObject({ role: "consumed", version: 2 }); await expect( adapter.updateBomLineRole( createdProject.id, withBom.bom[0]!.id, "reusable", 1 ) ).rejects.toMatchObject({ code: "version_conflict", status: 409 }); const file = new File(["solid"], "sample.step", { type: "model/step" });
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
    await expect(adapter.createRevision(createdProject.id, { name: "Invalid printer route", intendedPrinterItemId: "printer-1" })).rejects.toMatchObject({ kind: "validation", status: 400 });
    const printed = await adapter.createRevision(createdProject.id, { name: "r03 printed", fabricationRoute: "printed", intendedPrinterItemId: "printer-1" });
    expect(printed).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: "printer-1" });
    const inherited = await adapter.createRevision(createdProject.id, { name: "r04 inherited" });
    expect(inherited).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: "printer-1" });
    const cleared = await adapter.createRevision(createdProject.id, { name: "r05 clear", intendedPrinterItemId: null });
    expect(cleared).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: null });
    const carriedClear = await adapter.createRevision(createdProject.id, { name: "r06 clear carried" });
    expect(carriedClear).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: null });
    await expect(adapter.removeProject(createdProject.id, after.projects.find((project) => project.id === createdProject.id)?.version)).resolves.toMatchObject({ id: createdProject.id, removedAt: expect.any(String), lastLifecycleStatus: "idea" });
    await expect(adapter.loadWorkspace()).resolves.toMatchObject({ projects: expect.not.arrayContaining([expect.objectContaining({ id: createdProject.id })]) });
  });
});
