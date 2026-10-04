import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceAdapter } from "./api";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const project = (index: number) => ({ id: `project-${index}`, name: `Project ${index}`, status: "planned", version: 1, currentRevisionId: `revision-${index}`, createdAt: "2026-10-03T10:00:00Z", updatedAt: "2026-10-03T10:00:00Z", artifacts: [], workItems: [], presentation: null, buildPlan: null });
function setup(nextCursor = "page-two") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) return response({ status: "ok", service: "benchledger", version: "0.1.0", demo: true });
    if (url.endsWith("/auth/session")) return response({ authenticated: true, actor: "synthetic", csrfToken: "synthetic-csrf", expiresAt: "2026-10-04T10:00:00Z" });
    if (url.endsWith("/workspace")) return response({ inventory: [], projects: [project(0)], offers: [], capabilities: ["project_library.read"], source: "api", fetchedAt: "2026-10-03T10:00:00Z" });
    if (url.includes("status=archived")) return response({ data: [{ ...project(999), status: "archived" }], limit: 100 });
    if (url.includes("cursor=page-two")) return response({ data: [project(200)], limit: 100 });
    if (url.includes("/project-library?")) return response({ data: Array.from({ length: 200 }, (_, index) => project(index)), limit: 100, nextCursor });
    throw new Error(`Unexpected synthetic request ${url}`);
  });
}

it("exhausts the connected library and preserves MCP presentation metadata beyond the workspace preview", async () => {
  const fetchMock = setup();
  const adapter = createWorkspaceAdapter();
  const result = await adapter.loadWorkspace();
  expect(result.projects).toHaveLength(201);
  expect(result.projects.at(-1)).toMatchObject({ id: "project-200", projectLibraryAvailable: true, presentation: null, buildPlan: null });
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("cursor=page-two"))).toBe(true);
  expect(await adapter.listArchivedProjects()).toMatchObject([{ id: "project-999", projectLibraryAvailable: true }]);
});

it("fails visibly when paging repeats instead of publishing a truncated project library", async () => {
  setup("same-page");
  await expect(createWorkspaceAdapter().loadWorkspace()).rejects.toMatchObject({ kind: "server", message: "Project paging did not advance. Retry loading the workspace." });
});

it("keeps loaded archives out of active readiness refreshes while retaining completed projects", async () => {
  const gaps = { lines: [], totals: { requiredLines: 0, optionalLines: 0, readyLines: 0, checkLines: 0, decideLines: 0, sourceLines: 0, partialLines: 0, missingLines: 0 } };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) return response({ status: "ok", service: "benchledger", version: "test", demo: true });
    if (url.endsWith("/auth/session")) return response({ authenticated: true, actor: "synthetic" });
    if (url.endsWith("/workspace")) return response({ inventory: [], projects: [], offers: [], capabilities: ["project_library.read"] });
    if (url.includes("status=archived")) return response({ data: [{ ...project(3), status: "archived" }], limit: 100 });
    if (url.includes("/project-library?")) return response({ data: [project(1), { ...project(2), status: "complete" }], limit: 100 });
    if (url.endsWith("/gaps")) return response(gaps);
    throw new Error(`Unexpected synthetic request ${url}`);
  });
  const adapter = createWorkspaceAdapter();
  await adapter.loadWorkspace();
  await expect(adapter.listArchivedProjects()).resolves.toMatchObject([{ id: "project-3", status: "archived" }]);
  await expect(adapter.refreshProjectReadiness()).resolves.toMatchObject([{ id: "project-1", status: "planned" }, { id: "project-2", status: "complete" }]);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/gaps")).map(([url]) => String(url))).toEqual([
    "/api/v1/project-revisions/revision-1/gaps", "/api/v1/project-revisions/revision-2/gaps"
  ]);
});

it.each([false, true])("keeps same-revision library state through archive/restore when gap refresh fails=%s", async (gapRefreshFails) => {
  vi.stubGlobal("document", { cookie: "forge_csrf=synthetic-csrf" });
  const metadata = project(1);
  const presentation = { projectId: metadata.id, projectRevisionId: metadata.currentRevisionId, version: 1, coverArtifactId: "cover-1", coverSha256: "a".repeat(64), imageKind: "render", updatedAt: metadata.updatedAt, updatedBy: "synthetic", warnings: [] };
  const gaps = { lines: [], totals: { requiredLines: 0, optionalLines: 0, readyLines: 0, checkLines: 0, decideLines: 0, sourceLines: 0, partialLines: 0, missingLines: 0 } };
  const buildPlan = { id: "plan-1", projectId: metadata.id, projectRevisionId: metadata.currentRevisionId, version: 1, name: "Synthetic build", parts: [], plates: [], warnings: [], artifactBasis: [] };
  const hydrated = { ...metadata, presentation, buildPlan, currentRevision: { id: metadata.currentRevisionId, projectId: metadata.id, number: 1, version: 1, name: "First revision", status: "draft", createdAt: metadata.createdAt, updatedAt: metadata.updatedAt, bom: [], gapEvaluation: gaps }, artifacts: [{ id: "cover-1", projectId: metadata.id, projectRevisionId: metadata.currentRevisionId, filename: "synthetic-cover.png", role: "photo", sha256: "a".repeat(64), mediaType: "image/png", byteSize: 200, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt, version: 1 }] };
  let gapReads = 0;
  let gapsUnavailable = gapRefreshFails;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/health")) return response({ status: "ok", service: "benchledger", version: "test", demo: true });
    if (url.endsWith("/auth/session")) return response({ authenticated: true, actor: "synthetic" });
    if (url.endsWith("/workspace")) return response({ inventory: [], projects: [], offers: [], capabilities: ["project_library.read"] });
    if (url.includes("/project-library?")) return response({ data: [hydrated], limit: 100 });
    if (url.endsWith("/gaps")) { gapReads += 1; return gapsUnavailable ? new Response(JSON.stringify({ error: { message: "Synthetic gap failure" } }), { status: 503 }) : response(gaps); }
    if (url.endsWith("/projects/project-1") && init?.method === "PATCH") return response({ data: { ...metadata, status: "archived", version: 2 } });
    if (url.endsWith("/projects/project-1/restore") && init?.method === "POST") return response({ data: { ...metadata, version: 3 } });
    throw new Error(`Unexpected synthetic request ${url}`);
  });
  const adapter = createWorkspaceAdapter();
  const initial = (await adapter.loadWorkspace()).projects[0]!;
  const archived = await adapter.archiveProject(metadata.id, 1);
  await expect(adapter.refreshProjectReadiness()).resolves.toEqual([]);
  expect(gapReads).toBe(1);
  const restored = await adapter.restoreProject(metadata.id, 2);
  expect(archived).toMatchObject({ status: "archived", version: 2 });
  expect(restored).toMatchObject({ status: "planned", version: 3 });
  for (const saved of [archived, restored]) {
    expect(saved).toMatchObject({ projectLibraryAvailable: true, presentation, buildPlan, artifacts: initial.artifacts, allArtifacts: initial.allArtifacts, currentRevision: "r01", serverRevisionId: metadata.currentRevisionId });
    expect(saved.readinessUnavailable).toBe(gapRefreshFails);
    if (gapRefreshFails) expect(saved.gapEvaluation).toBeUndefined();
    else expect(saved.gapEvaluation).toEqual(initial.gapEvaluation);
  }
  expect(gapReads).toBe(2);
  gapsUnavailable = false;
  await expect(adapter.refreshProjectReadiness()).resolves.toMatchObject([{ id: metadata.id, status: "planned", presentation, readinessUnavailable: false, gapEvaluation: initial.gapEvaluation }]);
  expect(gapReads).toBe(3);
});

it("clears the library build plan when creating another project revision", async () => {
  vi.stubGlobal("document", { cookie: "forge_csrf=synthetic-csrf" });
  const metadata = project(1);
  const buildPlan = { id: "plan-1", projectId: metadata.id, projectRevisionId: metadata.currentRevisionId, version: 1, name: "Synthetic build", parts: [], plates: [], warnings: [], artifactBasis: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/health")) return response({ status: "ok", service: "benchledger", version: "test", demo: true });
    if (url.endsWith("/auth/session")) return response({ authenticated: true, actor: "synthetic", csrfToken: "synthetic-csrf" });
    if (url.endsWith("/workspace")) return response({ inventory: [], projects: [], offers: [], capabilities: ["project_library.read"] });
    if (url.includes("/project-library?")) return response({ data: [{ ...metadata, buildPlan }], limit: 100 });
    if (url.endsWith("/projects/project-1/revisions") && init?.method === "POST") return response({ data: { id: "revision-2", projectId: metadata.id, number: 2, version: 1, name: "Second revision", status: "concept", createdAt: metadata.updatedAt } });
    throw new Error(`Unexpected synthetic request ${url}`);
  });
  const adapter = createWorkspaceAdapter();
  expect((await adapter.loadWorkspace()).projects[0]!.buildPlan).toEqual(buildPlan);
  const revised = await adapter.createRevision(metadata.id, { name: "Second revision" });
  expect(revised.serverRevisionId).toBe("revision-2");
  expect(revised.buildPlan).toBeUndefined();
});
