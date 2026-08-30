import { McpAdapter } from "./adapter.js";
import { publicToolDefinitions } from "./capabilities.js";
import { McpAdapterError, mapBackendError } from "./errors.js";
import type {
  JsonObject,
  McpRequestContext,
  McpResourceReadResult,
  McpServerInfo,
  McpToolResult,
} from "./types.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: JsonObject | McpResourceReadResult;
  error?: {
    code: number;
    message: string;
    data?: JsonObject;
  };
}

export interface McpProtocolOptions {
  context: McpRequestContext;
  serverInfo?: McpServerInfo;
}

export interface McpHttpRequest {
  method: string;
  headers?: Readonly<Record<string, string | undefined>>;
  body: unknown;
}

export interface McpHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface McpHttpHandlerOptions {
  context?: McpRequestContext;
  resolveContext?: (headers: Readonly<Record<string, string | undefined>>) => Promise<McpRequestContext>;
  maxBodyBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(id: string | number | null, code: number, message: string, data?: JsonObject): JsonRpcResponse {
  const error: JsonRpcResponse["error"] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function requestId(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) return value;
  throw new McpAdapterError("INVALID_ARGUMENT", "JSON-RPC id must be a string, integer, or null.");
}

function jsonRpcRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || value.method.length === 0 || value.method.length > 128) {
    throw new McpAdapterError("INVALID_ARGUMENT", "Request must be a JSON-RPC 2.0 object with a method.");
  }
  const request: JsonRpcRequest = { jsonrpc: "2.0", id: requestId(value.id), method: value.method };
  if (value.params !== undefined) request.params = value.params;
  return request;
}

function paramsObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new McpAdapterError("INVALID_ARGUMENT", "Request params must be an object.");
  return value;
}

function protocolErrorForAdapter(error: McpAdapterError): { code: number; message: string } {
  if (error.code === "INVALID_ARGUMENT" || error.code === "INVALID_TOOL" || error.code === "INVALID_RESOURCE") return { code: -32602, message: error.message };
  if (error.code === "FORBIDDEN") return { code: -32003, message: error.message };
  return { code: -32000, message: error.message };
}

function toolResultJson(result: McpToolResult): JsonObject {
  return {
    content: result.content.map((entry) => ({ type: entry.type, text: entry.text })),
    structuredContent: result.structuredContent,
    isError: result.isError,
  };
}

/**
 * Small JSON-RPC dispatcher for stdio and authenticated HTTP transports.
 * Transport code supplies an actor context; this class never parses tokens or
 * reaches a database itself.
 */
export class McpProtocol {
  readonly adapter: McpAdapter;
  readonly context: McpRequestContext;
  readonly serverInfo: McpServerInfo;

  constructor(adapter: McpAdapter, options: McpProtocolOptions) {
    this.adapter = adapter;
    this.context = options.context;
    this.serverInfo = options.serverInfo ?? { name: "benchledger", version: "0.1.0" };
  }

  async handle(input: unknown): Promise<JsonRpcResponse | null> {
    let request: JsonRpcRequest;
    try {
      request = jsonRpcRequest(input);
    } catch (error) {
      const mapped = mapBackendError(error);
      return protocolError(null, -32600, mapped.message);
    }

    // JSON-RPC notifications intentionally do not receive a response. MCP
    // names its lifecycle notifications with a prefix, but the no-id rule is
    // broader and also prevents accidental responses to client extensions.
    if (request.id === null) return null;

    try {
      switch (request.method) {
        case "initialize":
          return this.initialize(request);
        case "ping":
          return { jsonrpc: "2.0", id: request.id ?? null, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id: request.id ?? null, result: { tools: publicToolDefinitions() } };
        case "tools/call":
          return await this.callTool(request);
        case "resources/list":
          return { jsonrpc: "2.0", id: request.id ?? null, result: { resources: this.adapter.listResources().map((entry) => ({ ...entry })) } };
        case "resources/templates/list":
          return { jsonrpc: "2.0", id: request.id ?? null, result: { resourceTemplates: this.adapter.listResourceTemplates().map((entry) => ({ ...entry })) } };
        case "resources/read":
          return await this.readResource(request);
        default:
          return protocolError(request.id ?? null, -32601, `Method '${request.method}' is not supported.`);
      }
    } catch (error) {
      const mapped = mapBackendError(error);
      const converted = protocolErrorForAdapter(mapped);
      return protocolError(request.id ?? null, converted.code, converted.message);
    }
  }

  private initialize(request: JsonRpcRequest): JsonRpcResponse {
    const params = paramsObject(request.params);
    const requestedVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION;
    const protocolVersion = requestedVersion === MCP_PROTOCOL_VERSION ? requestedVersion : MCP_PROTOCOL_VERSION;
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: this.serverInfo.name, version: this.serverInfo.version },
        instructions: "Read benchledger://capabilities before making recommendations or writes. Refresh context first; uncertain stock is inspect-first.",
      },
    };
  }

  private async callTool(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = paramsObject(request.params);
    if (typeof params.name !== "string" || params.name.length === 0 || params.name.length > 128) throw new McpAdapterError("INVALID_ARGUMENT", "tools/call requires a tool name.");
    const result = await this.adapter.callTool(params.name, params.arguments ?? {}, this.context);
    if (result.isError) {
      const error = result.structuredContent.error;
      if (isRecord(error) && error.code === "INVALID_TOOL") throw new McpAdapterError("INVALID_TOOL", `Unknown BenchLedger tool '${params.name}'.`);
    }
    return { jsonrpc: "2.0", id: request.id ?? null, result: toolResultJson(result) };
  }

  private async readResource(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = paramsObject(request.params);
    if (typeof params.uri !== "string" || params.uri.length === 0 || params.uri.length > 1024) throw new McpAdapterError("INVALID_ARGUMENT", "resources/read requires a URI.");
    const result: McpResourceReadResult = await this.adapter.readResource(params.uri, this.context);
    return { jsonrpc: "2.0", id: request.id ?? null, result };
  }
}

function headerValue(headers: Readonly<Record<string, string | undefined>> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === target) return value;
  return undefined;
}

/**
 * Framework-neutral HTTP bridge. A Fastify/Express route can pass its parsed
 * request body and an authenticated context here. Only POST JSON-RPC is
 * accepted; GET/SSE is intentionally not implied by the adapter.
 */
export function createMcpHttpHandler(protocol: McpProtocol, options: McpHttpHandlerOptions): (request: McpHttpRequest) => Promise<McpHttpResponse> {
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  return async (request): Promise<McpHttpResponse> => {
    const headers = request.headers ?? {};
    if (request.method.toUpperCase() !== "POST") {
      return { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: JSON.stringify({ error: "Only POST JSON-RPC requests are supported." }) };
    }
    const contentType = headerValue(headers, "content-type");
    if (contentType !== undefined && !contentType.toLowerCase().startsWith("application/json")) {
      return { status: 415, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: JSON.stringify({ error: "Content-Type must be application/json." }) };
    }
    const encoded = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    if (encoded === undefined) {
      return { status: 400, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "A JSON-RPC body is required." } }) };
    }
    const raw = encoded;
    if (raw.length > maxBodyBytes) {
      return { status: 413, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: JSON.stringify({ error: "Request body exceeds the MCP limit." }) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 400, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }) };
    }
    const context = options.resolveContext === undefined ? options.context : await options.resolveContext(headers);
    if (context === undefined) {
      return { status: 401, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: JSON.stringify({ error: "An authenticated MCP context is required." }) };
    }
    const effectiveProtocol = context === protocol.context ? protocol : new McpProtocol(protocol.adapter, { context, serverInfo: protocol.serverInfo });
    const response = await effectiveProtocol.handle(parsed);
    if (response === null) return { status: 202, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: "" };
    return { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: JSON.stringify(response) };
  };
}
