import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createSyntheticRuntime } from "./memory-store.js";
import { ApplicationService } from "@benchledger/application";
import { createApp, bearerRecord } from "./app.js";
const projectId = "synthetic-project-lamp", revisionId = "synthetic-revision-lamp-r01", root = `/api/v1/projects/${projectId}/revisions/${revisionId}/assembly`;
const ctx = { actor: "synthetic-assembly-author", source: "api" as const, correlationId: "synthetic-assembly", scopes: new Set(["read", "write"]), idempotencyKey: "assembly-setup-key" };
const bytes = new TextEncoder().encode("solid plate\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 30 0 0\nvertex 0 20 0\nendloop\nendfacet\nendsolid plate");
async function setup() {
  const runtime = createSyntheticRuntime();
  const session = await runtime.ports.artifacts.beginUpload({ projectId, revisionId, filename: "synthetic-plate.stl", role: "stl", mediaType: "model/stl", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, ctx);
  await runtime.ports.artifacts.writeUpload(session.id, bytes); const file = await runtime.ports.artifacts.finalizeUpload(session.id, ctx);
  const source = { artifactId: file.id, sha256: file.sha256, unit: "millimetre" as const };
  return { runtime, file, source };
}
describe("assembly HTTP and MCP parity", () => {
  it("inspects, saves, reads and retains history with strict scope, hashes and concurrency", async () => {
    const { runtime, source } = await setup();
    const app = await createApp({ ports: runtime.ports, demo: true, auth: { sessionSecret: "synthetic-assembly-session-".repeat(3), bearerTokens: [bearerRecord("writer", ["read", "write"], [projectId]), bearerRecord("reader", ["read"], [projectId]), bearerRecord("wrong", ["read", "write"], ["different-project"])] } });
    let serial = 0;
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object, token = "writer", key = `synthetic-assembly-${++serial}`) => app.inject({ method, url, headers: { authorization: `Bearer ${token}`, "idempotency-key": key }, ...(payload ? { payload } : {}) });
    try {
      const inspected = await call("POST", `${root}/inspect`, { sources: [source] }, "reader"); expect(inspected.statusCode, inspected.body).toBe(200);
      const input = { expectedVersion: 0, name: "Synthetic assembly", sources: [source], parts: inspected.json().parts, steps: [{ id: "step-1", name: "Fit plate", partIds: [inspected.json().parts[0].id], notes: "Inspect the mounting surface." }], notes: "Viewing only" };
      expect((await call("GET", root)).json().assembly).toBeNull();
      const saved = await call("PUT", root, input, "writer", "assembly-save-once"); expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().data.version).toBe(1);
      expect((await call("PUT", root, input, "writer", "assembly-save-once")).json().replayed).toBe(true);
      expect((await call("PUT", root, { ...input, name: "Changed" }, "writer", "assembly-save-once")).statusCode).toBe(409);
      expect((await call("PUT", root, input)).statusCode).toBe(409);
      expect((await call("PUT", root, { ...input, expectedVersion: 1 }, "reader")).statusCode).toBe(403);
      expect((await call("POST", `${root}/inspect`, { sources: [source] }, "wrong")).statusCode).toBe(403);
      expect((await call("POST", `${root}/inspect`, { sources: [{ ...source, sha256: "0".repeat(64) }] })).statusCode).toBe(409);
      expect((await call("PUT", root, { ...input, expectedVersion: 1, parts: [{ ...input.parts[0], nodeId: "missing" }] })).statusCode).toBe(400);
      expect((await call("PUT", root, { ...input, expectedVersion: 1, steps: [{ ...input.steps[0], partIds: ["missing"] }] })).statusCode).toBe(400);
      const rpc = async (name: string, args: object, token = "writer") => (await call("POST", "/api/v1/mcp", { jsonrpc: "2.0", id: serial, method: "tools/call", params: { name, arguments: args } }, token)).json();
      const scope = { projectId, projectRevisionId: revisionId };
      for (const [name, args] of [ ["inspect_assembly_sources", { ...scope, proposal: { sources: [source] }, limit: 1 }], ["save_project_assembly", { ...scope, assembly: { ...input, expectedVersion: 1 } }], ["read_project_assembly", scope], ["read_assembly_history", scope] ] as const) {
        const result = await rpc(name, args); expect(result.result?.isError, JSON.stringify(result)).not.toBe(true); expect(result.error).toBeUndefined();
        if (name === "inspect_assembly_sources") expect(JSON.stringify(result)).not.toContain('"positions"');
      }
      expect((await rpc("save_project_assembly", { ...scope, assembly: { ...input, expectedVersion: 2 } }, "reader")).result.isError).toBe(true);
      expect((await rpc("read_project_assembly", scope, "wrong")).result.isError).toBe(true);
      expect((await call("GET", root)).json().assembly.version).toBe(2);
      const history = (await call("GET", `${root}/history?limit=1`)).json(); expect(history.data[0].version).toBe(2); expect(history.nextCursor).toBe("1");
      const openapi = (await call("GET", "/api/v1/openapi.json")).json(); expect(openapi.paths["/projects/{projectId}/revisions/{revisionId}/assembly"].put.requestBody).toBeDefined();
    } finally { await app.close(); }
  });
  it("rolls back a failed audit and rejects foreign ancestry, retired sources and archived writes", async () => {
    const { runtime, file, source } = await setup(); const service = new ApplicationService(runtime.ports);
    const input = { expectedVersion: 0, name: "Assembly", sources: [source], parts: (await service.assemblies.inspect(projectId, revisionId, { sources: [source] })).parts, steps: [], notes: "" };
    const audit = vi.spyOn(runtime.ports.audit, "append").mockRejectedValueOnce(new Error("Synthetic audit failure"));
    await expect(service.assemblies.save(projectId, revisionId, input, ctx)).rejects.toThrow("Synthetic audit failure"); audit.mockRestore();
    expect((await service.assemblies.read(projectId, revisionId)).assembly).toBeNull();
    await expect(service.assemblies.inspect(projectId, "synthetic-revision-stand-r01", { sources: [source] })).rejects.toThrow();
    await service.assemblies.save(projectId, revisionId, input, ctx);
    await runtime.ports.artifacts.retireArtifact(file.id, file.version, ctx);
    expect((await service.assemblies.read(projectId, revisionId)).warnings.join()).toMatch(/retired/);
    await expect(service.assemblies.save(projectId, revisionId, { ...input, expectedVersion: 1 }, { ...ctx, idempotencyKey: "assembly-after-retire" })).rejects.toThrow(/retired/);
    const project = await service.getProject(projectId); await runtime.ports.projects.archiveProject!(projectId, project.version, ctx);
    await expect(service.assemblies.save(projectId, revisionId, { ...input, expectedVersion: 1 }, { ...ctx, idempotencyKey: "assembly-after-archive" })).rejects.toThrow(/Restore/);
    await expect(service.assemblies.save(projectId, revisionId, input, { ...ctx, idempotencyKey: "x" })).rejects.toThrow(/stable/);
  });
});
