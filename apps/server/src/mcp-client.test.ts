import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, bearerRecord } from "./app.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

it("a real MCP SDK connects, validates discovery and uses atomic setup without a browser session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "benchledger-sdk-"));
  const token = randomBytes(32).toString("hex");
  const app = await createApp({ demo: false, dataDir: directory, publicBaseUrl: "http://127.0.0.1:8792", logger: false, auth: { sessionSecret: "s".repeat(48), bearerTokens: [bearerRecord(token, ["read", "write"])] } });
  const client = new Client({ name: "synthetic-sdk-acceptance", version: "1.0.0" });
  let serial = 0;
  try {
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(base + "/api/v1/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: (url, init) => { const headers = new Headers(init?.headers); headers.set("Idempotency-Key", `sdk-command-${++serial}`); return fetch(url, { ...init, headers, redirect: "error" }); } });
    // SDK 1.x exposes an undefined sessionId in no-session HTTP mode.
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    const discovery = await client.listTools(); expect(discovery.tools).toHaveLength(90);
    const capabilities = await client.readResource({ uri: "benchledger://capabilities" }); expect(capabilities.contents).toHaveLength(1);
    const preview = await client.callTool({ name: "preview_project_setup", arguments: { project: { id: "sdk-project", name: "SDK integration project", status: "planned" }, revision: { id: "sdk-revision", name: "Initial", status: "concept", fabricationRoute: "none" }, bomLines: [{ localRef: "part", name: "Synthetic bracket", requiredQuantity: 2, unit: "each", role: "consumed", optional: false, alternatives: [] }], workItems: [], reservations: [] } });
    expect(preview.isError).toBe(false); const review = preview.structuredContent as { id: string; version: number; contentSha256: string; fieldErrors: unknown[] };
    expect(review.fieldErrors).toEqual([]);
    const committed = await client.callTool({ name: "commit_project_setup", arguments: { previewId: review.id, expectedPreviewVersion: review.version, contentSha256: review.contentSha256, confirmReservations: false } });
    expect(committed.isError).toBe(false);
    const stock = await client.callTool({ name: "create_inventory_item", arguments: { name: "Synthetic delivery", category: "electronic", quantity: { value: 2, unit: "piece" }, evidence: { state: "delivery", source: "synthetic fixture", recordedAt: "2026-09-07T00:00:00Z" } } });
    expect(stock.isError).toBe(false);
    const stockId = (stock.structuredContent as { id: string }).id;
    const line = await client.callTool({ name: "create_bom_line", arguments: { projectRevisionId: "sdk-revision", description: "Uncounted part", quantity: 1, unit: "piece", role: "consumed", itemId: stockId } }); expect(line.isError).toBe(false);
    const gaps = await client.callTool({ name: "calculate_bom_gaps", arguments: { projectRevisionId: "sdk-revision" } });
    expect(gaps.structuredContent).toMatchObject({ lines: expect.arrayContaining([expect.objectContaining({ description: "Uncounted part", decision: "check", matches: expect.arrayContaining([expect.objectContaining({ availability: "inspect_first", suppliedQuantity: { value: 0, unit: "piece" } })]) })]) });
    const read = await client.callTool({ name: "read_project", arguments: { projectId: "sdk-project" } }); expect(read.isError).toBe(false); expect(JSON.stringify(read.structuredContent)).toContain("SDK integration project");
  } finally { await client.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
describe("MCP transport and credential boundaries", () => {
  it("rejects wrong origins, expired credentials and browser sessions; authenticated optional methods return 405", async () => {
    const app = await createApp({ demo: true, logger: false, publicBaseUrl: "http://localhost:8792", auth: { sessionSecret: "s".repeat(48), bearerTokens: [bearerRecord("sdk-valid", ["read"]), { ...bearerRecord("sdk-expired", ["read"]), expiresAt: 1 }] } });
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    try {
      for (const method of ["GET", "DELETE"] as const) {
        const response = await app.inject({ method, url: "/api/v1/mcp", headers: { authorization: "Bearer sdk-valid" } });
        expect(response.statusCode).toBe(405); expect(response.headers.allow).toBe("POST");
        expect(response.body).not.toContain("<!doctype");
      }
      expect((await app.inject({ method: "POST", url: "/api/v1/mcp", payload: body })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/v1/mcp", headers: { authorization: "Bearer sdk-expired" }, payload: body })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/v1/mcp", headers: { authorization: "Bearer sdk-valid", origin: "https://untrusted.example" }, payload: body })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/v1/mcp", headers: { authorization: "Bearer sdk-valid", origin: "http://localhost:8792" }, payload: body })).statusCode).toBe(200);
      const notification = await app.inject({ method: "POST", url: "/api/v1/mcp", headers: { authorization: "Bearer sdk-valid" }, payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
      expect(notification.statusCode).toBe(202); expect(notification.body).toBe("");
    } finally { await app.close(); }
  });
});
