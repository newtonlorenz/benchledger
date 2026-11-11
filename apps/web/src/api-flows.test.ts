import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, conflictReason, createWorkspaceAdapter } from "./api";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

const createdProject = (id: string, revisionId: string) => ({ data: {
  project: { id, name: `Project ${id}`, description: "", status: "idea", currentRevisionId: revisionId, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 },
  revision: { id: revisionId, projectId: id, number: 1, name: "Initial concept", status: "concept", createdAt: "2026-08-30T10:00:00.000Z", version: 1 }
} });

const emptyGaps = (revisionId: string) => ({ revisionId, lines: [], totals: { requiredLines: 0, optionalLines: 0, readyLines: 0, checkLines: 0, decideLines: 0, sourceLines: 0, partialLines: 0, missingLines: 0 } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project readiness refresh", () => {
  it("never returns archived projects and refreshes only active ones", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) return jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf", expiresAt: "2026-08-31T10:00:00.000Z" });
      if (url.endsWith("/projects/with-initial-revision")) return jsonResponse(createdProject("active-1", "rev-active"));
      if (url.includes("status=archived")) return jsonResponse({ data: [{ id: "archived-1", name: "Old", description: "", status: "archived", currentRevisionId: "rev-archived", createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z", version: 1 }] });
      if (url.includes("/gaps")) return jsonResponse(emptyGaps(url.includes("rev-active") ? "rev-active" : "rev-archived"));
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createWorkspaceAdapter();
    await adapter.login("pw");
    await adapter.createProject({ name: "Active", description: "" });
    const archived = await adapter.listArchivedProjects();
    expect(archived.map((project) => project.id)).toContain("archived-1");
    const refreshed = await adapter.refreshProjectReadiness();
    expect(refreshed.map((project) => project.id)).toEqual(["active-1"]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("rev-archived"))).toBe(false);
  });

  it("keeps successful refreshes and the previous evaluation when one project fails", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf" });
    let created = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) return jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf", expiresAt: "2026-08-31T10:00:00.000Z" });
      if (url.endsWith("/projects/with-initial-revision")) { created += 1; return jsonResponse(createdProject(`p${created}`, `rev-${created}`)); }
      if (url.includes("rev-1/gaps")) return jsonResponse(emptyGaps("rev-1"));
      if (url.includes("rev-2/gaps")) return jsonResponse({ error: { code: "internal", message: "boom" } }, 500);
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createWorkspaceAdapter();
    await adapter.login("pw");
    await adapter.createProject({ name: "One", description: "" });
    await adapter.createProject({ name: "Two", description: "" });
    const refreshed = await adapter.refreshProjectReadiness();
    expect(refreshed).toHaveLength(2);
    expect(refreshed.find((project) => project.id === "p1")).toMatchObject({ readinessUnavailable: false });
    expect(refreshed.find((project) => project.id === "p2")).toMatchObject({ readinessUnavailable: true });
  });

  it("rethrows a session expiry instead of reporting partial readiness", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) return jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf", expiresAt: "2026-08-31T10:00:00.000Z" });
      if (url.endsWith("/projects/with-initial-revision")) return jsonResponse(createdProject("p1", "rev-1"));
      return jsonResponse({ error: { code: "unauthenticated", message: "Sign in" } }, 401);
    });
    const adapter = createWorkspaceAdapter();
    await adapter.login("pw");
    await adapter.createProject({ name: "One", description: "" });
    await expect(adapter.refreshProjectReadiness()).rejects.toMatchObject({ kind: "unauthenticated" });
  });
});

describe("request errors", () => {
  it("classifies HTTP 409 as a conflict and keeps the server code", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) return jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf", expiresAt: "2026-08-31T10:00:00.000Z" });
      return jsonResponse({ error: { code: "version_conflict", message: "Project changed since it was loaded" } }, 409);
    });
    const adapter = createWorkspaceAdapter();
    await adapter.login("pw");
    const failure = await adapter.createProject({ name: "One", description: "" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ kind: "conflict", status: 409, code: "version_conflict" });
  });

  it("treats 428 precondition_required as a stale conflict that needs a reload", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) return jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf", expiresAt: "2026-08-31T10:00:00.000Z" });
      return jsonResponse({ error: { code: "precondition_required", message: "If-Match is required" } }, 428);
    });
    const adapter = createWorkspaceAdapter();
    await adapter.login("pw");
    const failure = await adapter.createProject({ name: "One", description: "" }).catch((error: unknown) => error) as ApiError;
    expect(failure).toMatchObject({ kind: "conflict", status: 428, code: "precondition_required" });
    expect(conflictReason(failure)).toBe("stale");
  });

  it("keeps validation issue messages from the server", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) return jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf", expiresAt: "2026-08-31T10:00:00.000Z" });
      return jsonResponse({ error: { code: "validation", message: "Request validation failed", details: { issues: [{ path: "name", message: "Name is required", code: "too_small" }, { path: "description", message: "Too long", code: "too_big" }] } } }, 400);
    });
    const adapter = createWorkspaceAdapter();
    await adapter.login("pw");
    const failure = await adapter.createProject({ name: "One", description: "" }).catch((error: unknown) => error) as ApiError;
    expect(failure.kind).toBe("validation");
    expect(failure.issues).toEqual([{ path: "name", message: "Name is required", code: "too_small" }, { path: "description", message: "Too long", code: "too_big" }]);
  });

  it("always sends If-Match when editing inventory and archiving projects", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) return jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf", expiresAt: "2026-08-31T10:00:00.000Z" });
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createWorkspaceAdapter();
    await adapter.login("pw");
    // No known version: refuse locally instead of sending an unguarded write.
    await expect(adapter.updateInventoryItem("unknown-item", { name: "x" })).rejects.toMatchObject({ kind: "conflict" });
    await expect(adapter.archiveProject("unknown-project")).rejects.toMatchObject({ kind: "conflict" });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
  });

  it("passes a timeout signal to every request", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf", expiresAt: "2026-08-31T10:00:00.000Z" }));
    await createWorkspaceAdapter().login("pw");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a timed-out request as offline", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(createWorkspaceAdapter().login("pw")).rejects.toMatchObject({ kind: "offline" });
  });
});

describe("artifact upload", () => {
  it("reads and hashes the file bytes once", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) return jsonResponse({ authenticated: true, actor: "admin", csrfToken: "csrf", expiresAt: "2026-08-31T10:00:00.000Z" });
      if (url.endsWith("/projects/with-initial-revision")) return jsonResponse(createdProject("p1", "rev-1"));
      if (url.endsWith("/artifacts/uploads")) return jsonResponse({ data: { id: "upload-1", artifactId: "artifact-1", expiresAt: "2026-08-30T11:00:00.000Z", maxBytes: 5, uploadUrl: "/api/v1/artifacts/uploads/upload-1", status: "pending" } });
      if (url.endsWith("/finalize")) return jsonResponse({ data: { id: "artifact-1", projectId: "p1", revisionId: "rev-1", role: "step", filename: "body.step", mediaType: "model/step", byteSize: 5, sha256: "b".repeat(64), currentCandidate: true, retired: false, createdAt: "2026-08-30T10:00:00.000Z", version: 1 } });
      return jsonResponse({ receivedBytes: 5 });
    });
    const adapter = createWorkspaceAdapter();
    await adapter.login("pw");
    await adapter.createProject({ name: "One", description: "" });
    const file = new File(["solid"], "body.step", { type: "model/step" });
    const read = vi.spyOn(file, "arrayBuffer");
    await adapter.uploadArtifact("p1", file, "STEP");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reports progress and can be cancelled when sent through XHR", async () => {
    const { binaryRequest } = await import("./api");
    class FakeXhr {
      static last: FakeXhr | undefined;
      upload = { onprogress: undefined as undefined | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) };
      status = 0; responseText = ""; withCredentials = false;
      onload: (() => void) | undefined; onerror: (() => void) | undefined; onabort: (() => void) | undefined; ontimeout: (() => void) | undefined;
      timeout = 0;
      headers: Record<string, string> = {};
      aborted = false;
      constructor() { FakeXhr.last = this; }
      open() {}
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      send() { this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 }); }
      abort() { this.aborted = true; this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress: number[] = [];
    const controller = new AbortController();
    const pending = binaryRequest("/api/v1/artifacts/uploads/x", new ArrayBuffer(2), "csrf", { onProgress: (fraction) => progress.push(fraction), signal: controller.signal });
    expect(progress).toEqual([0.5]);
    expect(FakeXhr.last?.headers["X-CSRF-Token"]).toBe("csrf");
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXhr.last?.aborted).toBe(true);
  });
});

describe("inventory item by id", () => {
  it("fetches a single item for a deep link", async () => {
    vi.stubGlobal("document", { cookie: "forge_csrf=csrf" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ id: "item-9", name: "Deep linked", kind: "tool", quantity: 1, availableQuantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-31T10:00:00.000Z", version: 3 }));
    const item = await createWorkspaceAdapter().readInventoryItem("item-9");
    expect(item).toMatchObject({ id: "item-9", name: "Deep linked", version: 3, updatedAt: "2026-08-31T10:00:00.000Z" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/inventory/item-9");
  });

  it("finds a sample item by id", async () => {
    const { createSampleWorkspaceAdapter } = await import("./api");
    const adapter = createSampleWorkspaceAdapter();
    const first = (await adapter.listInventory({ limit: 1 })).items[0]!;
    await expect(adapter.readInventoryItem(first.id)).resolves.toMatchObject({ id: first.id });
    await expect(adapter.readInventoryItem("missing")).rejects.toMatchObject({ status: 404 });
  });
});
