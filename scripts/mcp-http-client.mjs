#!/usr/bin/env node
// Host-only stdio bridge. The server still enforces every scope and project boundary.
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
const MAX_REQUEST = 1024 * 1024, MAX_RESPONSE = 8 * MAX_REQUEST;
const fail = () => { throw new Error("Private MCP configuration is missing, unsafe or invalid."); };
export async function readClientConfig(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 8192 || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) fail();
    const config = JSON.parse(await handle.readFile("utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some(key => !["endpoint", "token", "allowInsecureLan"].includes(key))) fail();
    const endpoint = new URL(config.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith("/mcp")) fail();
    const trustedLan = isIP(endpoint.hostname) === 4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(endpoint.hostname) || ["localhost", "[::1]"].includes(endpoint.hostname);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && config.allowInsecureLan === true && trustedLan)) fail();
    if (typeof config.token !== "string" || config.token.length < 16 || config.token.length > 4096 || /[\s\u0000-\u001f]/u.test(config.token)) fail();
    return { endpoint: endpoint.href, token: config.token };
  } catch { fail(); } finally { await handle?.close(); }
}
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
export function createForwarder(config, request = fetch) {
  const unconfirmed = new Map();
  return async message => {
    const id = message && (typeof message.id === "string" || Number.isSafeInteger(message.id)) ? message.id : null;
    const error = (code, text) => id === null ? null : { jsonrpc: "2.0", id, error: { code, message: text } };
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || Buffer.byteLength(JSON.stringify(message)) > MAX_REQUEST) return error(-32600, "Invalid or oversized MCP request.");
    const operation = message.method === "tools/call" ? createHash("sha256").update(canonical({ name: message.params?.name, arguments: message.params?.arguments ?? {} })).digest("hex") : undefined;
    const key = operation ? unconfirmed.get(operation) ?? `host-${randomUUID()}` : undefined;
    if (operation && !unconfirmed.has(operation) && unconfirmed.size >= 64) return error(-32098, "Too many unconfirmed commands. Resolve unchanged requests before sending new commands.");
    if (operation) unconfirmed.set(operation, key);
    try {
      const response = await request(config.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${config.token}`, ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(message) });
      if (!response.ok) {
        await response.body?.cancel();
        if (operation && response.status < 500) unconfirmed.delete(operation);
        return error(response.status >= 500 ? -32098 : -32001, response.status >= 500 ? "Server response is not confirmed. Retry unchanged in this session or read current state before a new command." : `MCP request rejected (HTTP ${response.status}). Check the connection scope and request.`);
      }
      if (id === null) { await response.body?.cancel(); return null; }
      if (response.status === 202) throw new Error("Request acknowledgement is missing");
      if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Invalid response");
      let length = 0; const chunks = [];
      for await (const chunk of response.body) { length += chunk.byteLength; if (length > MAX_RESPONSE) throw new Error("Response too large"); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body?.jsonrpc !== "2.0" || body.id !== id || (!body.error && !body.result)) throw new Error("Unconfirmed response");
      if (operation && !["BACKEND_ERROR", "INTERNAL_ERROR"].includes(body.result?.structuredContent?.error?.code)) unconfirmed.delete(operation);
      return body;
    } catch { return error(-32098, "Connection or acknowledgement failed. Do not assume the command failed. Retry unchanged in this session or read current state before a new command."); }
  };
}
export async function runStdioBridge(config, input = process.stdin, output = process.stdout) {
  const forward = createForwarder(config); let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let newline;
    while ((newline = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
      if (line.byteLength > MAX_REQUEST) throw new Error("MCP request exceeds the local limit.");
      if (!line.toString("utf8").trim()) continue;
      let message;
      try { message = JSON.parse(line.toString("utf8")); }
      catch { output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON request." } }) + "\n"); continue; }
      const response = await forward(message);
      if (response) output.write(JSON.stringify(response) + "\n");
    }
    if (pending.byteLength > MAX_REQUEST) throw new Error("MCP request exceeds the local limit.");
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--help") console.log("Host MCP connection: node scripts/mcp-http-client.mjs --config <private-file>\nConfiguration: endpoint, token, optional allowInsecureLan. The file must be owned by this user with mode 0600. Use a project-restricted server token. No automatic retries; re-read state after restarting a connection with an unresolved write.");
  else {
    try {
      if (process.argv.length !== 4 || process.argv[2] !== "--config") fail();
      await runStdioBridge(await readClientConfig(process.argv[3]));
    } catch { console.error("BenchLedger MCP connection stopped. Check the private configuration, access permissions and server status. No automatic retries were made."); process.exitCode = 1; }
  }
}
