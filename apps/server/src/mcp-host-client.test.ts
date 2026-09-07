import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp, bearerRecord } from "./app.js";
// @ts-expect-error host-only standalone JavaScript, not server runtime code
import { readClientConfig, createForwarder } from "../../../scripts/mcp-http-client.mjs";
const token = "synthetic-host-credential-not-real";
it("requires a private owned regular config and rejects redirects-to-public HTTP configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "benchledger-host-config-")), path = join(directory, "connection.json");
  const config = { endpoint: "http://127.0.0.1:8792/api/v1/mcp", token, allowInsecureLan: true };
  try {
    await writeFile(path, JSON.stringify(config), { mode: 0o600 }); expect(await readClientConfig(path)).toEqual({ endpoint: config.endpoint, token });
    await chmod(path, 0o644); await expect(readClientConfig(path)).rejects.toThrow("unsafe"); await chmod(path, 0o600);
    await symlink(path, join(directory, "link")); await expect(readClientConfig(join(directory, "link"))).rejects.toThrow("unsafe");
    for (const bad of [{ ...config, endpoint: "http://public.example/mcp" }, { ...config, endpoint: "http://192.168.1.attacker.example/mcp" }, { ...config, endpoint: "https://user:secret@service.example/mcp" }, { ...config, endpoint: "https://service.example/mcp?token=unsafe" }, { ...config, token: "bad\ncredential" }, { ...config, unknown: true }]) {
      await writeFile(path, JSON.stringify(bad)); await expect(readClientConfig(path)).rejects.toThrow("invalid");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("keeps an unchanged command key after an ambiguous response without retrying or leaking credentials", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error(token)).mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }), { headers: { "content-type": "application/json" } }));
  const forward = createForwarder({ endpoint: "https://service.example/mcp", token }, request);
  const message = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_project", arguments: { projectId: "synthetic" } } };
  const first = await forward(message); expect(first.error.message).toContain("Do not assume"); expect(JSON.stringify(first)).not.toContain(token); expect(request).toHaveBeenCalledTimes(1);
  await forward({ ...message, id: 2 }); expect(request.mock.calls[0]?.[1].headers["idempotency-key"]).toBe(request.mock.calls[1]?.[1].headers["idempotency-key"]); expect(request.mock.calls[0]?.[1].redirect).toBe("error");
});
it("connects an official stdio client to authenticated HTTP without passing credentials in argv", async () => {
  const app = await createApp({ demo: true, logger: false, auth: { sessionSecret: "s".repeat(48), bearerTokens: [bearerRecord(token, ["read", "write"], ["synthetic-project-lamp"])] } });
  const directory = await mkdtemp(join(tmpdir(), "benchledger-stdio-"));
  const configPath = join(directory, "connection.json");
  const client = new Client({ name: "host-client-test", version: "1.0.0" });
  try {
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    await writeFile(configPath, JSON.stringify({ endpoint: base + "/api/v1/mcp", token, allowInsecureLan: true }), { mode: 0o600 });
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../../../scripts/mcp-http-client.mjs", import.meta.url)), "--config", configPath], stderr: "pipe" });
    let stderr = ""; transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(84);
    const allowed = await client.callTool({ name: "read_project", arguments: { projectId: "synthetic-project-lamp" } }); expect(allowed.isError).toBe(false);
    const denied = await client.callTool({ name: "read_project", arguments: { projectId: "other-project" } }); expect(denied.isError).toBe(true);
    const globalWrite = await client.callTool({ name: "create_project", arguments: { name: "Not permitted" } }); expect(globalWrite.isError).toBe(true);
    expect(stderr).not.toContain(token);
  } finally { await client.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
