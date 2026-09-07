import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, bearerRecord } from "./app.js";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

it("official MCP review and replayed approval match the browser stock result without double consumption", async () => {
  const directory = await mkdtemp("/tmp/benchledger-approval-parity-");
  const token = randomUUID(), projectId = "approval-project", revisionId = "approval-revision";
  const app = await createApp({ demo: false, dataDir: directory, publicBaseUrl: "http://127.0.0.1", logger: false, auth: { sessionSecret: randomUUID().repeat(2), bearerTokens: [bearerRecord(token, ["read", "write"], [projectId]), bearerRecord("fixture-seeder", ["read", "write"])] } });
  const client = new Client({ name: "synthetic-approval-client", version: "1.0.0" });
  let key = randomUUID();
  const seed = async (path: string, payload: Record<string, unknown>) => { const response = await app.inject({ method: "POST", url: `/api/v1${path}`, headers: { authorization: "Bearer fixture-seeder", "idempotency-key": randomUUID() }, payload }); expect(response.statusCode, response.body).toBeLessThan(300); return response.json().data; };
  try {
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    await seed("/projects/with-initial-revision", { project: { id: projectId, name: "Synthetic approval parity", status: "building" }, revision: { id: revisionId, name: "Initial", status: "concept", fabricationRoute: "none" } });
    const item = await seed("/inventory", { id: "approval-stock", name: "Synthetic fasteners", kind: "fastener", quantity: 10, unit: "each", tags: [], links: [], evidence: { state: "physically_counted", source: "Synthetic fixture" } });
    const line = await seed(`/project-revisions/${revisionId}/bom`, { name: "Mounting", itemId: item.id, role: "consumed", requiredQuantity: 4, unit: "each", optional: false, constraints: {}, alternatives: [] });
    const reservation = await seed(`/project-revisions/${revisionId}/reservations`, { lineId: line.id, itemId: item.id, quantity: 4 });
    const transport = new StreamableHTTPClientTransport(new URL(base + "/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: (url, init) => { const headers = new Headers(init?.headers); headers.set("idempotency-key", key); return fetch(url, { ...init, headers, redirect: "error" }); } });
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    expect((await client.listTools()).tools).toHaveLength(84);
    key = randomUUID();
    const preview = await client.callTool({ name: "save_reconciliation_draft", arguments: { projectRevisionId: revisionId, lines: [{ bomLineId: line.id, outcomes: [{ reservationId: reservation.id, itemId: item.id, kind: "consumed", quantity: 4, unit: "each", evidence: { state: "physically_counted", source: "Synthetic software test only" } }] }] } });
    expect(preview.isError, JSON.stringify(preview.structuredContent)).toBe(false);
    const review = preview.structuredContent as { id: string; version: number };
    const stock = async () => (await app.inject({ method: "GET", url: `/api/v1/inventory/${item.id}`, headers: { authorization: "Bearer fixture-seeder" } })).json();
    expect((await stock()).quantity).toBe(10);
    key = randomUUID();
    const arguments_ = { projectRevisionId: revisionId, draftId: review.id, expectedVersion: review.version };
    const first = await client.callTool({ name: "commit_reconciliation", arguments: arguments_ });
    expect(first.isError, JSON.stringify(first.structuredContent)).toBe(false);
    const replay = await client.callTool({ name: "commit_reconciliation", arguments: arguments_ });
    expect(replay.isError, JSON.stringify(replay.structuredContent)).toBe(false);
    expect((await stock()).quantity).toBe(6);
    const project = (await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: { authorization: "Bearer fixture-seeder" } })).json();
    expect(project.project.status).toBe("building");
    key = randomUUID();
    const read = await client.callTool({ name: "read_reconciliation", arguments: { projectRevisionId: revisionId } });
    expect(read.isError).toBe(false);
  } finally { await client.close(); const closing = app.close(); app.server.closeAllConnections(); await closing; await rm(directory, { recursive: true, force: true }); }
});
