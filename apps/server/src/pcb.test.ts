import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ApplicationService } from "@benchledger/application";
import { createSyntheticRuntime } from "./memory-store.js";
import { createApp, bearerRecord } from "./app.js";
it("inspects native PCB through authenticated HTTP/MCP without changing source, stock or saved assembly", async () => {
  const runtime = createSyntheticRuntime(), service = new ApplicationService(runtime.ports);
  const projectId = "synthetic-project-lamp", revisionId = "synthetic-revision-lamp-r01";
  const bytes = await readFile("packages/artifacts/testfiles/synthetic-board.kicad_pcb");
  const context = { actor: "synthetic", source: "api" as const, correlationId: "synthetic-pcb", scopes: new Set(["read", "write"]), idempotencyKey: "synthetic-pcb-upload" };
  const upload = await service.beginArtifactUpload({ projectId, projectRevisionId: revisionId, filename: "synthetic-board.kicad_pcb", role: "cad_source", mediaType: "application/x-kicad-pcb", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, context);
  await service.writeArtifactUpload(upload.data.id, bytes); const file = (await service.finalizeArtifactUpload(upload.data.id, { ...context, idempotencyKey: "synthetic-pcb-finalise" })).data;
  const app = await createApp({ ports: runtime.ports, demo: true, auth: { sessionSecret: "synthetic-pcb-session-".repeat(4), bearerTokens: [bearerRecord("reader", ["read"], [projectId]), bearerRecord("other", ["read"], ["other-project"])] } });
  const root = `/api/v1/projects/${projectId}/revisions/${revisionId}/assembly`, source = { artifactId: file.id, sha256: file.sha256, unit: "millimetre", upAxis: "z" };
  const request = (token: string, sources = [source], url = root + "/inspect") => app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: { sources } });
  try {
    expect((await app.inject({ method: "POST", url: root + "/inspect", payload: { sources: [source] } })).statusCode).toBe(401);
    expect((await request("other")).statusCode).toBe(403);
    expect((await request("reader", [{ ...source, sha256: "0".repeat(64) }])).statusCode).toBe(409);
    expect((await request("reader", [source], `/api/v1/projects/${projectId}/revisions/synthetic-revision-stand-r01/assembly/inspect`)).statusCode).toBe(403);
    expect((await request("reader", [{ ...source, unit: "metre" }])).statusCode).toBe(400);
    const inspected = await request("reader"); expect(inspected.statusCode, inspected.body).toBe(200);
    expect(inspected.json().geometry.find((m: { pcb?: { kind: string } }) => m.pcb?.kind === "board").pcb.holeCount).toBe(5);
    const rpc = await app.inject({ method: "POST", url: "/api/v1/mcp", headers: { authorization: "Bearer reader" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inspect_assembly_sources", arguments: { projectId, projectRevisionId: revisionId, proposal: { sources: [source] }, limit: 100 } } } });
    expect(rpc.json().result.isError, rpc.body).not.toBe(true); expect(rpc.body).toContain("Footprint geometry only"); expect(rpc.body).not.toContain('"positions"');
    expect((await service.assemblies.read(projectId, revisionId)).assembly).toBeNull();
    expect(Buffer.from((await runtime.ports.artifacts.readArtifact(file.id)).body)).toEqual(bytes);
    await runtime.ports.artifacts.retireArtifact(file.id, file.version, context);
    const historical = await request("reader"); expect(historical.json().warnings.join()).toMatch(/retired/);
  } finally { await app.close(); }
});
