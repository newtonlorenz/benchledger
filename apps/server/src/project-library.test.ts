import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApplicationService, type ApplicationPorts, type RequestContext } from "@benchledger/application";
import type { Artifact, ProjectPresentation } from "@benchledger/api-contract";
import { createProductionRuntime } from "@benchledger/runtime";
import { createApp, bearerRecord } from "./app.js";
import { createMemoryRuntime, createSyntheticRuntime } from "./memory-store.js";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMw6piAFTEMpAQAEKQ94TX+ea8AAAAASUVORK5CYII=", "base64");
let serial = 0;
const context = (key = `library-command-${++serial}`): RequestContext => ({ actor: "synthetic-reviewer", source: "api", scopes: new Set(["read", "write", "admin"]), correlationId: "project-library-test", idempotencyKey: key });
async function attachImage(service: ApplicationService, ports: ApplicationPorts, projectId: string, scope: { projectRevisionId: string } | { workItemId: string; workItemRevisionId: string }): Promise<Artifact> {
  const upload = await service.beginArtifactUpload({ projectId, ...scope, filename: "synthetic-product.png", mediaType: "image/png", byteSize: image.length, sha256: createHash("sha256").update(image).digest("hex"), role: "photo" }, context());
  await ports.artifacts.writeUpload(upload.data.id, image);
  return (await service.finalizeArtifactUpload(upload.data.id, context())).data;
}

describe("revision-scoped project presentations", () => {
  for (const durable of [false, true]) it(`keeps versioned covers, clear history and idempotency in ${durable ? "SQLite" : "memory"} without physical changes`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchledger-project-library-"));
    const runtime = durable ? await createProductionRuntime({ dataDir: dir }) : createSyntheticRuntime();
    const service = new ApplicationService(runtime.ports);
    try {
      const project = (await service.createProject({ name: "Synthetic product", status: "planned" }, context())).data;
      const revision = (await service.createProjectRevision(project.id, { name: "Initial", status: "concept" }, context())).data;
      const file = await attachImage(service, runtime.ports, project.id, { projectRevisionId: revision.id });
      const before = await service.listInventory({ limit: 200 });
      expect(await service.makerWorkflows.projectPresentation(project.id, revision.id)).toBeNull();
      const input = { expectedVersion: 0, coverArtifactId: file.id, imageKind: "render", caption: "Finished-product concept" };
      const saved = await service.makerWorkflows.saveProjectPresentation(project.id, revision.id, input, context("presentation-once"));
      expect(saved.data).toMatchObject({ version: 1, coverSha256: file.sha256, projectId: project.id, projectRevisionId: revision.id });
      expect(saved.audit.action).toBe("project.presentation.save");
      expect((await service.makerWorkflows.saveProjectPresentation(project.id, revision.id, input, context("presentation-once"))).replayed).toBe(true);
      await expect(service.makerWorkflows.saveProjectPresentation(project.id, revision.id, { ...input, caption: "Changed" }, context("presentation-once"))).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(service.makerWorkflows.saveProjectPresentation(project.id, revision.id, input, context())).rejects.toMatchObject({ code: "conflict" });
      const { idempotencyKey: _key, ...withoutKey } = context();
      await expect(service.makerWorkflows.saveProjectPresentation(project.id, revision.id, input, withoutKey)).rejects.toMatchObject({ code: "validation" });
      expect(await service.makerWorkflows.projectPresentation(project.id, revision.id)).toEqual(saved.data);
      await service.makerWorkflows.saveProjectPresentation(project.id, revision.id, { expectedVersion: 1, coverArtifactId: null, imageKind: "reference" }, context());
      expect(await service.makerWorkflows.projectPresentation(project.id, revision.id)).toMatchObject({ coverArtifactId: null, version: 2 });
      const history = await service.makerWorkflows.projectPresentationHistory(project.id, revision.id, { limit: 1 });
      expect(history).toMatchObject({ data: [{ version: 2, coverArtifactId: null }], nextCursor: "1" });
      expect((await service.makerWorkflows.projectPresentationHistory(project.id, revision.id, { cursor: history.nextCursor })).data).toMatchObject([{ version: 1, coverArtifactId: file.id, coverSha256: file.sha256 }]);
      await service.makerWorkflows.saveProjectPresentation(project.id, revision.id, { ...input, expectedVersion: 2 }, context());
      await service.retireArtifact(file.id, file.version, context());
      expect(await service.makerWorkflows.projectPresentation(project.id, revision.id)).toMatchObject({ version: 3, coverArtifactId: null, coverSha256: file.sha256, warnings: expect.arrayContaining([expect.stringContaining("retired")]) });
      expect((await service.makerWorkflows.projectPresentationHistory(project.id, revision.id)).data[0]).toMatchObject({ coverArtifactId: file.id });
      expect(await service.listInventory({ limit: 200 })).toEqual(before);
      expect(await service.getProjectRevision(revision.id)).toMatchObject({ status: "concept" });
      if (durable && "database" in runtime) expect(runtime.database.get("SELECT COUNT(*) AS count FROM maker_workflow_history WHERE kind='project_presentation'")).toMatchObject({ count: 3 });
    } finally { if ("close" in runtime) await runtime.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects cross-project and historical covers, invalidates changed hashes/workstream revisions, and checks file limits", async () => {
    const runtime = createSyntheticRuntime(), service = new ApplicationService(runtime.ports);
    const projectId = "synthetic-project-lamp", revisionId = "synthetic-revision-lamp-r01";
    const work = await service.makerWorkflows.createWorkstream(projectId, { name: "Product assembly", kind: "assembly" }, context());
    const workFile = await attachImage(service, runtime.ports, projectId, { workItemId: work.data.item.id, workItemRevisionId: work.data.revision.id });
    const other = (await service.createProjectWithInitialRevision({ project: { name: "Other product", status: "planned" }, revision: { name: "Initial", status: "concept" } }, context())).data;
    const otherFile = await attachImage(service, runtime.ports, other.project.id, { projectRevisionId: other.revision.id });
    const input = { expectedVersion: 0, coverArtifactId: workFile.id, imageKind: "built_photo" };
    await expect(service.makerWorkflows.saveProjectPresentation(projectId, revisionId, { ...input, coverArtifactId: otherFile.id }, context())).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.makerWorkflows.saveProjectPresentation(projectId, other.revision.id, input, context())).rejects.toMatchObject({ code: "forbidden" });
    await service.makerWorkflows.saveProjectPresentation(projectId, revisionId, input, context());
    const original = runtime.ports.artifacts.getArtifact.bind(runtime.ports.artifacts);
    const reader = vi.spyOn(runtime.ports.artifacts, "getArtifact").mockImplementation(async (id) => { const file = await original(id); return file === null ? null : { ...file, sha256: "b".repeat(64) }; });
    expect(await service.makerWorkflows.projectPresentation(projectId, revisionId)).toMatchObject({ coverArtifactId: null, warnings: expect.arrayContaining([expect.stringContaining("hash has changed")]) });
    reader.mockImplementation(async (id) => { const file = await original(id); return file === null ? null : { ...file, mediaType: "image/svg+xml" }; });
    await expect(service.makerWorkflows.saveProjectPresentation(projectId, revisionId, { ...input, expectedVersion: 1 }, context())).rejects.toMatchObject({ code: "validation" });
    reader.mockImplementation(async (id) => { const file = await original(id); return file === null ? null : { ...file, byteSize: 20 * 1024 * 1024 + 1 }; });
    await expect(service.makerWorkflows.saveProjectPresentation(projectId, revisionId, { ...input, expectedVersion: 1 }, context())).rejects.toMatchObject({ code: "validation" });
    reader.mockRestore();
    await service.createWorkItemRevision(work.data.item.id, { name: "Second", status: "concept" }, context());
    expect(await service.makerWorkflows.projectPresentation(projectId, revisionId)).toMatchObject({ coverArtifactId: null, warnings: expect.arrayContaining([expect.stringContaining("current project/workstream")]) });
    await expect(service.makerWorkflows.saveProjectPresentation(projectId, revisionId, { ...input, expectedVersion: 1 }, context())).rejects.toMatchObject({ code: "forbidden" });
    const historicalFile = await attachImage(service, runtime.ports, projectId, { projectRevisionId: revisionId });
    await service.makerWorkflows.saveProjectPresentation(projectId, revisionId, { ...input, expectedVersion: 1, coverArtifactId: historicalFile.id }, context());
    const next = (await service.createProjectRevision(projectId, { name: "Next", status: "concept" }, context())).data;
    expect(await service.makerWorkflows.projectPresentation(projectId, revisionId)).toMatchObject({ version: 2, coverArtifactId: null, warnings: expect.arrayContaining([expect.stringContaining("historical project revision")]) });
    await expect(service.makerWorkflows.saveProjectPresentation(projectId, next.id, { ...input, coverArtifactId: historicalFile.id }, context())).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.makerWorkflows.saveProjectPresentation(projectId, revisionId, { ...input, coverArtifactId: historicalFile.id }, context())).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects corrupted current and historical presentation identities", async () => {
    const runtime = createSyntheticRuntime(), service = new ApplicationService(runtime.ports);
    const projectId = "synthetic-project-lamp", revisionId = "synthetic-revision-lamp-r01";
    await service.makerWorkflows.saveProjectPresentation(projectId, revisionId, { expectedVersion: 0, coverArtifactId: null, imageKind: "render" }, context());
    const store = runtime.ports.makerWorkflows!;
    const original = (await store.get("project_presentation", revisionId))!;
    const read = vi.spyOn(store, "get");
    for (const corrupted of [
      { ...original, projectId: "other-project" },
      { ...original, id: "other-revision" },
      { ...original, payload: { ...original.payload, version: 2 } },
      { ...original, payload: { ...original.payload, coverSha256: "invalid" } }
    ]) {
      read.mockResolvedValue(corrupted);
      await expect(service.makerWorkflows.projectPresentation(projectId, revisionId)).rejects.toMatchObject({ code: "integrity_error" });
    }
    read.mockRestore();
    const history = vi.spyOn(store, "history").mockResolvedValue({ data: [{ ...original, revisionId: "other-revision" }], limit: 25 });
    await expect(service.makerWorkflows.projectPresentationHistory(projectId, revisionId)).rejects.toMatchObject({ code: "integrity_error" });
    history.mockRestore();
  });
});

describe("project library HTTP/MCP parity and paging", () => {
  it("reads and saves the same presentation via HTTP and MCP with scoped authorisation", async () => {
    const runtime = createSyntheticRuntime(), service = new ApplicationService(runtime.ports);
    const projectId = "synthetic-project-lamp", revisionId = "synthetic-revision-lamp-r01";
    const file = await attachImage(service, runtime.ports, projectId, { projectRevisionId: revisionId });
    const work = await service.makerWorkflows.createWorkstream(projectId, { name: "Gallery workstream", kind: "part" }, context());
    const workFile = await attachImage(service, runtime.ports, projectId, { workItemId: work.data.item.id, workItemRevisionId: work.data.revision.id });
    expect((await service.makerWorkflows.projectLibrary()).data[0]).toMatchObject({ id: projectId, buildPlan: null });
    const plan = (await service.makerWorkflows.saveBuildPlan(projectId, revisionId, { expectedVersion: 0, name: "Synthetic gallery build", parts: [{ id: "part-one", name: "Housing", quantity: 1 }], plates: [] }, context())).data;
    const writerToken = randomBytes(32).toString("hex");
    const workspaceReaderToken = randomBytes(32).toString("hex");
    const app = await createApp({ runtime, demo: true, logger: false, auth: { sessionSecret: randomBytes(48).toString("hex"), bearerTokens: [bearerRecord(writerToken, ["read", "write"], [projectId]), bearerRecord(workspaceReaderToken, ["read"]), bearerRecord("library-reader", ["read"], [projectId]), bearerRecord("library-wrong", ["read", "write"], ["other-project"])] } });
    const path = `/api/v1/projects/${projectId}/revisions/${revisionId}/presentation`;
    const headers = (token = writerToken, key = `library-http-${++serial}`) => ({ authorization: `Bearer ${token}`, "idempotency-key": key });
    const rpc = async (name: string, args: object, token = writerToken) => (await app.inject({ method: "POST", url: "/api/v1/mcp", headers: headers(token), payload: { jsonrpc: "2.0", id: "library", method: "tools/call", params: { name, arguments: args } } })).json().result;
    try {
      expect((await rpc("read_project_presentation", { projectId, projectRevisionId: revisionId })).structuredContent).toEqual({ presentation: null });
      const input = { expectedVersion: 0, coverArtifactId: file.id, imageKind: "render", caption: "Synthetic product render" };
      expect((await app.inject({ method: "PUT", url: path, headers: headers("library-reader"), payload: input })).statusCode).toBe(403);
      const save = await app.inject({ method: "PUT", url: path, headers: headers(), payload: input });
      expect(save.statusCode, save.body).toBe(200);
      const selected = save.json().data as ProjectPresentation;
      expect((await rpc("read_project_presentation", { projectId, projectRevisionId: revisionId })).structuredContent.presentation).toEqual(selected);
      const changed = await rpc("save_project_presentation", { projectId, projectRevisionId: revisionId, presentation: { ...input, expectedVersion: 1, imageKind: "reference" } });
      expect(changed.isError).toBe(false);
      expect((await app.inject({ method: "GET", url: path, headers: headers() })).json()).toEqual(changed.structuredContent.data);
      expect((await rpc("save_project_presentation", { projectId, projectRevisionId: revisionId, presentation: { ...input, expectedVersion: 2 } }, "library-reader")).isError).toBe(true);
      expect((await rpc("read_project_presentation", { projectId, projectRevisionId: revisionId }, "library-wrong")).structuredContent.error.code).toBe("FORBIDDEN");
      const history = await app.inject({ method: "GET", url: `${path}/history?limit=1`, headers: headers() });
      expect(history.statusCode, history.body).toBe(200);
      expect(history.json()).toMatchObject({ data: [{ version: 2, imageKind: "reference" }], nextCursor: "1" });
      expect((await rpc("read_project_presentation_history", { projectId, projectRevisionId: revisionId, limit: 1 })).structuredContent).toEqual(history.json());
      for (const suffix of ["", "/history"]) expect((await app.inject({ method: "GET", url: `${path}${suffix}`, headers: headers("library-wrong") })).statusCode).toBe(403);
      const httpPage = await app.inject({ method: "GET", url: "/api/v1/project-library?limit=1", headers: headers() });
      expect(httpPage.statusCode, httpPage.body).toBe(200);
      const page = httpPage.json();
      expect(page.data[0]).toMatchObject({ id: projectId, presentation: changed.structuredContent.data, currentRevision: { id: revisionId, bom: expect.any(Array), gapEvaluation: expect.any(Object) }, artifacts: expect.arrayContaining([expect.objectContaining({ id: file.id, revisionId }), expect.objectContaining({ id: workFile.id, workItemId: work.data.item.id, revisionId: work.data.revision.id })]), workItems: expect.any(Array), buildPlan: plan });
      expect((await rpc("list_project_library", { limit: 1 })).structuredContent).toEqual(page);
      expect(page).not.toHaveProperty("inventory");
      const workspace = await app.inject({ method: "GET", url: "/api/v1/workspace", headers: headers(workspaceReaderToken) });
      expect(workspace.statusCode, workspace.body).toBe(200);
      expect(workspace.json().projects[0]).not.toHaveProperty("presentation");
      expect(workspace.json().projects[0]).not.toHaveProperty("buildPlan");
      expect((await app.inject({ method: "GET", url: "/api/v1/project-library", headers: headers("library-wrong") })).json().data).toEqual([]);
      for (const query of ["limit=101", "limit=0", "status=complete", "cursor=invalid", "unknown=true"]) expect((await app.inject({ method: "GET", url: `/api/v1/project-library?${query}`, headers: headers() })).statusCode).toBe(400);
      const capabilities = (await app.inject({ method: "GET", url: "/api/v1/capabilities" })).json();
      expect(capabilities.actions).toContain("project_library.read");
      const openapi = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();
      expect(openapi.paths["/project-library"].get.parameters).toHaveLength(3);
      expect(openapi.paths["/projects/{projectId}/revisions/{revisionId}/presentation"].put.requestBody).toBeDefined();
    } finally { await app.close(); }
  });

  it("exhausts more than 200 projects without truncation and preserves completed/archived/scoped filters", async () => {
    const runtime = createMemoryRuntime(), service = new ApplicationService(runtime.ports);
    for (let index = 0; index < 205; index++) await runtime.ports.projects.createProject({ id: `library-product-${String(index).padStart(3, "0")}`, name: `Synthetic product ${index}`, status: index === 204 ? "complete" : "planned" }, context());
    const archived = await runtime.ports.projects.createProject({ id: "library-archived", name: "Synthetic archived product", status: "archived" }, context());
    const readAll = async (status: "active" | "archived" | "all", projectIds?: readonly string[]) => {
      const ids: string[] = []; let cursor: string | undefined; let count = 0;
      do { const page = await service.makerWorkflows.projectLibrary({ limit: 100, status, ...(cursor === undefined ? {} : { cursor }) }, projectIds); ids.push(...page.data.map((project) => project.id)); cursor = page.nextCursor; expect(++count).toBeLessThan(10); } while (cursor !== undefined);
      return ids;
    };
    expect(await readAll("active")).toHaveLength(205);
    expect(await readAll("active")).toContain("library-product-204");
    expect(await readAll("archived")).toEqual([archived.id]);
    expect(await readAll("all")).toHaveLength(206);
    const allowlist = ["library-product-204", archived.id, "library-product-001", "missing-project"];
    expect(await readAll("active", allowlist)).toEqual(["library-product-001", "library-product-204"]);
    expect(await readAll("archived", allowlist)).toEqual([archived.id]);
    expect(await readAll("all", [])).toEqual([]);
    const page = await service.makerWorkflows.projectLibrary({ limit: 1 }, allowlist);
    await expect(service.makerWorkflows.projectLibrary({ limit: 1, cursor: page.nextCursor, status: "all" }, allowlist)).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(service.makerWorkflows.projectLibrary({ limit: 1, cursor: page.nextCursor }, ["library-product-001"])).rejects.toMatchObject({ code: "invalid_cursor" });
    const activePage = await service.makerWorkflows.projectLibrary({ limit: 100, status: "all" });
    const next = await service.makerWorkflows.projectLibrary({ limit: 100, status: "all", cursor: activePage.nextCursor });
    expect(next.data).toHaveLength(100);
    const tail = await service.makerWorkflows.projectLibrary({ limit: 100, status: "all", cursor: next.nextCursor });
    expect(tail.data).toHaveLength(6);
    expect(tail.nextCursor).toBeUndefined();
    const app = await createApp({ runtime, demo: true, logger: false, auth: { sessionSecret: "library-page-session-".repeat(3), bearerTokens: [bearerRecord("all-library-reader", ["read"]), bearerRecord("scoped-library-reader", ["read"], ["library-product-001", "library-product-204"])] } });
    try {
      const ids: string[] = []; let cursor: string | undefined;
      do {
        const response = await app.inject({ method: "GET", url: `/api/v1/project-library?limit=100${cursor === undefined ? "" : `&cursor=${cursor}`}`, headers: { authorization: "Bearer all-library-reader" } });
        expect(response.statusCode, response.body).toBe(200);
        const page = response.json(); ids.push(...page.data.map((project: { id: string }) => project.id)); cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(new Set(ids).size).toBe(205);
      const scoped = await app.inject({ method: "GET", url: "/api/v1/project-library?limit=1", headers: { authorization: "Bearer scoped-library-reader" } });
      expect(scoped.json().data.map((project: { id: string }) => project.id)).toEqual(["library-product-001"]);
      const last = await app.inject({ method: "GET", url: `/api/v1/project-library?limit=1&cursor=${scoped.json().nextCursor}`, headers: { authorization: "Bearer scoped-library-reader" } });
      expect(last.json().data.map((project: { id: string }) => project.id)).toEqual(["library-product-204"]);
      expect(last.json().nextCursor).toBeUndefined();
    } finally { await app.close(); }
  });
});
