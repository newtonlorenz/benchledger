import { describe, expect, it } from "vitest";
import { McpAdapter } from "./adapter.js";
import { McpProtocol, createMcpHttpHandler } from "./protocol.js";
import { runStdio } from "./stdio.js";
import * as mcpExports from "./index.js";
import { Writable, Readable } from "node:stream";
import type { BenchLedgerBackend, McpRequestContext } from "./types.js";

const context: McpRequestContext = {
  actorId: "protocol-test",
  scopes: ["inventory:read", "context:read"],
};

function backend(): BenchLedgerBackend {
  const emptyPage = { items: [], nextCursor: null, hasMore: false };
  return {
    inventory: {
      summary: async () => ({ generatedAt: "2026-08-30T10:00:00.000Z", counts: { totalItems: 0, confirmedItems: 0, inspectFirstItems: 0, missingItems: 0 }, categories: [] }),
      list: async () => emptyPage,
      get: async () => { throw new Error("not used"); },
      create: async () => { throw new Error("not used"); },
      createWithInitialRevision: async () => { throw new Error("not used"); },
      update: async () => { throw new Error("not used"); },
      bulkUpdate: async () => { throw new Error("not used"); },
      retire: async () => { throw new Error("not used"); },
      recordStockEvent: async () => { throw new Error("not used"); },
      listStockEvents: async () => emptyPage,
    },
    projects: {
      list: async () => emptyPage,
      get: async () => { throw new Error("not used"); },
      create: async () => { throw new Error("not used"); },
      update: async () => { throw new Error("not used"); },
      retire: async () => { throw new Error("not used"); },
      createWorkItem: async () => { throw new Error("not used"); },
      getWorkItem: async () => { throw new Error("not used"); },
      createProjectRevision: async () => { throw new Error("not used"); },
      getProjectRevision: async () => { throw new Error("not used"); },
      createWorkItemRevision: async () => { throw new Error("not used"); },
      getWorkItemRevision: async () => { throw new Error("not used"); },
      context: async () => { throw new Error("not used"); },
    },
    bom: {
      listLines: async () => emptyPage,
      createLine: async () => { throw new Error("not used"); },
      updateLine: async () => { throw new Error("not used"); },
      retireLine: async () => { throw new Error("not used"); },
      restoreLine: async () => { throw new Error("not used"); },
      evaluate: async () => { throw new Error("not used"); },
      reserve: async () => { throw new Error("not used"); },
      release: async () => { throw new Error("not used"); },
      recordUsage: async () => { throw new Error("not used"); },
    },
    artifacts: {
      list: async () => emptyPage,
      getMetadata: async () => { throw new Error("not used"); },
      beginUpload: async () => { throw new Error("not used"); },
      finalizeUpload: async () => { throw new Error("not used"); },
      downloadMetadata: async () => { throw new Error("not used"); },
      retire: async () => { throw new Error("not used"); },
    },
    offers: {
      list: async () => emptyPage,
      recordSnapshot: async () => { throw new Error("not used"); },
    },
    context: {
      refresh: async () => ({ generatedAt: "2026-08-30T10:00:00.000Z", expiresAt: "2026-08-30T10:05:00.000Z", inventorySummaryUri: "benchledger://inventory/summary", projectUris: [] }),
    },
  };
}

describe("McpProtocol", () => {
  it("keeps the package barrel wired to the public MCP surface", () => {
    expect(mcpExports.McpAdapter).toBe(McpAdapter);
    expect(mcpExports.McpProtocol).toBe(McpProtocol);
    expect(mcpExports.runStdio).toBe(runStdio);
    expect(mcpExports.MCP_PROTOCOL_VERSION).toBe("2025-06-18");
  });

  it("serves initialize and tool discovery through JSON-RPC", async () => {
    const protocol = new McpProtocol(new McpAdapter(backend()), { context });
    const initialize = await protocol.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(initialize).toMatchObject({ jsonrpc: "2.0", id: 1, result: { capabilities: { tools: {}, resources: {} } } });

    const tools = await protocol.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(tools).toMatchObject({ jsonrpc: "2.0", id: 2, result: { tools: expect.arrayContaining([expect.objectContaining({ name: "list_inventory" })]) } });
  });

  it("returns a structured tool result and supports bounded resources", async () => {
    const protocol = new McpProtocol(new McpAdapter(backend()), { context });
    const call = await protocol.handle({ jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: "list_inventory", arguments: { limit: 5 } } });
    expect(call).toMatchObject({ jsonrpc: "2.0", id: "call", result: { isError: false, structuredContent: { items: [] } } });

    const resource = await protocol.handle({ jsonrpc: "2.0", id: "resource", method: "resources/read", params: { uri: "benchledger://inventory/summary" } });
    expect(resource).toMatchObject({ jsonrpc: "2.0", id: "resource", result: { contents: [{ uri: "benchledger://inventory/summary", mimeType: "application/json" }] } });
  });

  it("does not expose arbitrary methods or return responses for notifications", async () => {
    const protocol = new McpProtocol(new McpAdapter(backend()), { context });
    const unknown = await protocol.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_shell", arguments: { command: "pwd" } } });
    expect(unknown).toMatchObject({ jsonrpc: "2.0", id: 3, error: { code: -32602 } });
    await expect(protocol.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeNull();
  });

  it("covers lifecycle, resource listing, request validation, and protocol error mapping", async () => {
    const protocol = new McpProtocol(new McpAdapter(backend()), { context, serverInfo: { name: "test-mcp", version: "9.9.9" } });
    await expect(protocol.handle({ jsonrpc: "2.0", id: 1, method: "ping" })).resolves.toMatchObject({ id: 1, result: {} });
    await expect(protocol.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "old-version" } })).resolves.toMatchObject({ id: 2, result: { protocolVersion: "2025-06-18", serverInfo: { name: "test-mcp", version: "9.9.9" } } });
    await expect(protocol.handle({ jsonrpc: "2.0", id: 3, method: "resources/list" })).resolves.toMatchObject({ result: { resources: expect.arrayContaining([expect.objectContaining({ uri: "benchledger://inventory/summary" })]) } });
    await expect(protocol.handle({ jsonrpc: "2.0", id: 4, method: "resources/templates/list" })).resolves.toMatchObject({ result: { resourceTemplates: expect.arrayContaining([expect.objectContaining({ uriTemplate: expect.stringContaining("{projectId}") })]) } });
    await expect(protocol.handle({ jsonrpc: "2.0", id: 5, method: "nope" })).resolves.toMatchObject({ id: 5, error: { code: -32601 } });
    await expect(protocol.handle(null)).resolves.toMatchObject({ id: null, error: { code: -32600 } });
    await expect(protocol.handle({ jsonrpc: "1.0", id: 6, method: "ping" })).resolves.toMatchObject({ id: null, error: { code: -32600 } });
    await expect(protocol.handle({ jsonrpc: "2.0", id: {}, method: "ping" })).resolves.toMatchObject({ id: null, error: { code: -32600 } });
    await expect(protocol.handle({ jsonrpc: "2.0", id: 7, method: "initialize", params: [] })).resolves.toMatchObject({ id: 7, error: { code: -32602 } });
    await expect(protocol.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} })).resolves.toMatchObject({ id: 8, error: { code: -32602 } });
    await expect(protocol.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x".repeat(129) } })).resolves.toMatchObject({ id: 9, error: { code: -32602 } });
    await expect(protocol.handle({ jsonrpc: "2.0", id: 10, method: "resources/read", params: {} })).resolves.toMatchObject({ id: 10, error: { code: -32602 } });
    await expect(protocol.handle({ jsonrpc: "2.0", id: 11, method: "resources/read", params: { uri: "benchledger://nope" } })).resolves.toMatchObject({ id: 11, error: { code: -32602 } });
    await expect(protocol.handle({ jsonrpc: "2.0", id: 12, method: "resources/read", params: { uri: "benchledger://inventory/summary" } })).resolves.toMatchObject({ id: 12, result: { contents: expect.any(Array) } });
  });

  it("maps adapter failures into tool results while preserving JSON-RPC transport errors", async () => {
    const notFoundBackend = backend();
    notFoundBackend.inventory.list = async () => { const error = new Error("missing"); Object.assign(error, { statusCode: 404 }); throw error; };
    const notFound = new McpProtocol(new McpAdapter(notFoundBackend), { context });
    await expect(notFound.handle({ jsonrpc: "2.0", id: "nf", method: "tools/call", params: { name: "list_inventory" } })).resolves.toMatchObject({ result: { isError: true, structuredContent: { error: { code: "NOT_FOUND" } } } });
    const forbiddenBackend = backend();
    forbiddenBackend.inventory.list = async () => { const error = new Error("no"); Object.assign(error, { code: "forbidden" }); throw error; };
    const forbidden = new McpProtocol(new McpAdapter(forbiddenBackend), { context });
    await expect(forbidden.handle({ jsonrpc: "2.0", id: "f", method: "tools/call", params: { name: "list_inventory" } })).resolves.toMatchObject({ result: { isError: true, structuredContent: { error: { code: "FORBIDDEN" } } } });
    await expect(forbidden.handle({ jsonrpc: "2.0", id: "r", method: "resources/read", params: { uri: "benchledger://inventory/items/%E0%A4%A" } })).resolves.toMatchObject({ id: "r", error: { code: -32602 } });
  });

  it("handles HTTP framing limits, content negotiation, context resolution, and notifications", async () => {
    const protocol = new McpProtocol(new McpAdapter(backend()), { context });
    const handler = createMcpHttpHandler(protocol, { context, maxBodyBytes: 100 });
    await expect(handler({ method: "GET", body: {} })).resolves.toMatchObject({ status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
    await expect(handler({ method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).resolves.toMatchObject({ status: 415 });
    await expect(handler({ method: "POST", body: undefined })).resolves.toMatchObject({ status: 400, body: expect.stringContaining("A JSON-RPC body is required") });
    await expect(handler({ method: "POST", body: "x".repeat(101) })).resolves.toMatchObject({ status: 413 });
    await expect(handler({ method: "POST", body: "not-json" })).resolves.toMatchObject({ status: 400, body: expect.stringContaining("Parse error") });
    const unauthenticated = createMcpHttpHandler(protocol, { resolveContext: async () => undefined });
    await expect(unauthenticated({ method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" } })).resolves.toMatchObject({ status: 401 });
    const resolvedContext = createMcpHttpHandler(protocol, { resolveContext: async (headers) => ({ ...context, actorId: headers.authorization ?? "resolved" }) });
    const success = await resolvedContext({ method: "POST", headers: { authorization: "agent", "CONTENT-TYPE": "application/json; charset=utf-8" }, body: { jsonrpc: "2.0", id: 2, method: "ping" } });
    expect(success).toMatchObject({ status: 200, headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(success.body)).toMatchObject({ id: 2, result: {} });
    const notification = await resolvedContext({ method: "POST", body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(notification).toMatchObject({ status: 202, body: "" });
  });

  it("frames newline-delimited stdio requests and reports malformed or oversized input", async () => {
    const chunks: string[] = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } });
    const input = Readable.from([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n",
      "not-json\n",
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      `${"x".repeat(1_000_001)}\n`,
    ]);
    await runStdio(backend(), { input, output, context });
    expect(chunks).toHaveLength(3);
    expect(JSON.parse(chunks[0]!)).toMatchObject({ id: 1, result: {} });
    expect(JSON.parse(chunks[1]!)).toMatchObject({ id: null, error: { code: -32700 } });
    expect(JSON.parse(chunks[2]!)).toMatchObject({ id: null, error: { code: -32600 } });
  });
});
