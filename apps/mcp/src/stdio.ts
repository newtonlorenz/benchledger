import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { McpAdapter } from "./adapter.js";
import { McpProtocol } from "./protocol.js";
import type { BenchLedgerBackend, McpRequestContext } from "./types.js";

export interface StdioServerOptions {
  input?: Readable;
  output?: Writable;
  context: McpRequestContext;
}

/**
 * Newline-delimited JSON-RPC bridge for local MCP clients. The application
 * owns the backend and actor context; this helper only handles framing.
 */
export async function runStdio(backend: BenchLedgerBackend, options: StdioServerOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const protocol = new McpProtocol(new McpAdapter(backend), { context: options.context });
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.length > 1_000_000) {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request exceeds the MCP size limit." } })}\n`);
      continue;
    }
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } })}\n`);
      continue;
    }
    const response = await protocol.handle(request);
    if (response !== null) output.write(`${JSON.stringify(response)}\n`);
  }
}
