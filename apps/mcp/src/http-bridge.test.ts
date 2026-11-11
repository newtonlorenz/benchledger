import { expect, it, vi } from "vitest";
// @ts-expect-error host-only standalone JavaScript, not adapter runtime code
import { createForwarder } from "../../../scripts/mcp-http-client.mjs";

const token = "synthetic-host-credential-not-real";
const okResponse = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), { headers: { "content-type": "application/json" } });

it("sends a model-supplied idempotencyKey as the header so the adapter never sees two different keys", async () => {
  const request = vi.fn().mockImplementation(async () => okResponse());
  const forward = createForwarder({ endpoint: "https://service.example/mcp", token }, request);
  await forward({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_build_plan", arguments: { projectId: "synthetic", idempotencyKey: "agent-chosen-key-1" } } });
  expect(request.mock.calls[0]?.[1].headers["idempotency-key"]).toBe("agent-chosen-key-1");
  await forward({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "save_build_plan", arguments: { projectId: "synthetic" } } });
  expect(request.mock.calls[1]?.[1].headers["idempotency-key"]).toMatch(/^host-/u);
});
