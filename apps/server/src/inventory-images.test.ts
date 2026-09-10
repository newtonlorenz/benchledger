import { describe, expect, it, vi } from "vitest";
import { ApplicationService } from "@benchledger/application";
import type { RequestContext } from "@benchledger/application";
import { McpAdapter, createApplicationBackend } from "@benchledger/mcp";
import { createSyntheticRuntime } from "./memory-store.js";
import { createApp, bearerRecord } from "./app.js";
const demoPassword = "demo-password-please-change";
const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMw6piAFTEMpAQAEKQ94TX+ea8AAAAASUVORK5CYII=";
const upload = { expectedVersion: 0, filename: "synthetic.png", mediaType: "image/png", imageBase64, caption: "Synthetic fixture", sourceKind: "reference" };
const ctx: RequestContext = { actor: "test", source: "api", correlationId: "image-test", scopes: new Set(["read", "write"]), idempotencyKey: "image-command-1" };
describe("inventory images across application, HTTP and MCP", () => {
  it("adds to printers and electronics without changing stock, replays and rejects stale/malformed commands", async () => {
    const runtime = createSyntheticRuntime(), service = new ApplicationService(runtime.ports);
    const before = await service.getInventoryItem("printer-h2d");
    const result = await service.inventoryImages.add("printer-h2d", upload, ctx);
    expect(result.data).toMatchObject({ version: 1, images: [{ width: 8, height: 6, mediaType: "image/webp", sourceKind: "reference" }] });
    expect(await service.getInventoryItem("printer-h2d")).toEqual(before);
    expect(await service.inventoryImages.add("printer-h2d", upload, ctx)).toMatchObject({ replayed: true, data: result.data });
    await expect(service.inventoryImages.add("printer-h2d", { ...upload, caption: "changed" }, ctx)).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(service.inventoryImages.add("printer-h2d", upload, { ...ctx, idempotencyKey: "another-command" })).rejects.toMatchObject({ code: "conflict" });
    const content = await service.inventoryImages.content("printer-h2d", result.data.images[0]!.id, ctx);
    expect(Buffer.from(content.bytes).toString("ascii", 8, 12)).toBe("WEBP");
    await expect(service.inventoryImages.content("board-esp32", result.data.images[0]!.id, ctx)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.inventoryImages.gallery("printer-h2d", { ...ctx, projectId: "restricted" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.inventoryImages.add("board-esp32", { ...upload, imageBase64: Buffer.from("not an image").toString("base64") }, { ...ctx, idempotencyKey: "invalid-image" })).rejects.toMatchObject({ code: "validation" });
    for (const patch of [{ imageBase64: "AB==" }, { filename: "../image.png" }, { sourceKind: "verified" }, { imageBase64: "a".repeat(3_000_000) }, { imageBase64: imageBase64, url: "https://example.org/image.png" }]) {
      await expect(service.inventoryImages.add("board-esp32", { ...upload, ...patch }, ctx)).rejects.toMatchObject({ code: "validation" });
    }
    const noKey = { ...ctx, idempotencyKey: "" };
    await expect(service.inventoryImages.add("board-esp32", upload, noKey)).rejects.toMatchObject({ code: "validation" });
    await service.inventoryImages.add("board-esp32", upload, { ...ctx, idempotencyKey: "electronic-image" });
    expect((await service.inventoryImages.gallery("board-esp32", ctx)).version).toBe(1);
  });
  it("rolls back images when audit fails and limits the gallery", async () => {
    const runtime = createSyntheticRuntime(), service = new ApplicationService(runtime.ports);
    const spy = vi.spyOn(runtime.ports.audit, "append").mockRejectedValueOnce(new Error("synthetic audit failure"));
    await expect(service.inventoryImages.add("printer-h2d", upload, ctx)).rejects.toThrow("synthetic audit failure");
    expect((await service.inventoryImages.gallery("printer-h2d", ctx)).images).toHaveLength(0);
    spy.mockRestore();
    for (let i = 0; i < 12; i++) await service.inventoryImages.add("printer-h2d", { ...upload, expectedVersion: i }, { ...ctx, idempotencyKey: `image-command-${i}` });
    await expect(service.inventoryImages.add("printer-h2d", { ...upload, expectedVersion: 12 }, { ...ctx, idempotencyKey: "thirteenth-image" })).rejects.toMatchObject({ code: "quota_exceeded" });
  });
  it("protects HTTP reads and writes, content ownership and browser CSRF", async () => {
    const app = await createApp({ demo: true, logger: false, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("image-writer", ["read", "write"]), bearerRecord("image-reader", ["read"]), bearerRecord("image-scoped", ["read", "write"], ["synthetic-project-lamp"])] } });
    const url = "/api/v1/inventory/printer-h2d/images";
    const headers = { authorization: "Bearer image-writer", "idempotency-key": "http-image-command" };
    try {
      expect((await app.inject({ url })).statusCode).toBe(401);
      for (const method of ["GET", "POST"] as const) expect((await app.inject({ method, url, headers: { authorization: "Bearer image-scoped" }, ...(method === "POST" ? { payload: upload } : {}) })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, headers: { authorization: "Bearer image-reader" }, payload: upload })).statusCode).toBe(403);
      const result = await app.inject({ method: "POST", url, headers, payload: upload });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.body).not.toContain(imageBase64);
      const imageId = result.json().data.images[0].id;
      const contentUrl = `${url}/${imageId}/content`;
      expect((await app.inject({ url: contentUrl })).statusCode).toBe(401);
      expect((await app.inject({ url: contentUrl, headers: { authorization: "Bearer image-scoped" } })).statusCode).toBe(403);
      const content = await app.inject({ url: contentUrl, headers });
      expect(content.statusCode).toBe(200); expect(content.headers["content-type"]).toBe("image/webp"); expect(content.headers["cache-control"]).toBe("private, no-store");
      expect((await app.inject({ url: contentUrl.replace("printer-h2d", "board-esp32"), headers })).statusCode).toBe(404);
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
      const cookies = login.headers["set-cookie"] as string[];
      expect((await app.inject({ method: "POST", url, headers: { cookie: cookies.map(c => c.split(";")[0]).join("; ") }, payload: upload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, headers, payload: { ...upload, imageBase64: "a".repeat(3 * 1024 * 1024) } })).statusCode).toBe(413);
    } finally { await app.close(); }
  });
  it("accepts a real image above the ordinary MCP envelope through authenticated HTTP", async () => {
    const app = await createApp({ demo: true, logger: false, auth: { sessionSecret: "s".repeat(48), bearerTokens: [bearerRecord("image-transport", ["read", "write"])] } });
    try {
      const largeImage = Buffer.concat([Buffer.from(imageBase64, "base64"), Buffer.alloc(800_000)]).toString("base64");
      const response = await app.inject({ method: "POST", url: "/api/v1/mcp", headers: { authorization: "Bearer image-transport" }, payload: { jsonrpc: "2.0", id: "image", method: "tools/call", params: { name: "add_inventory_image", arguments: { itemId: "printer-h2d", image: { ...upload, imageBase64: largeImage } } } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ result: { isError: false, structuredContent: { data: { version: 1 } } } });
    } finally { await app.close(); }
  });
  it("lets MCP add exact host-encoded images and replay headerless retries with no byte leakage", async () => {
    const service = new ApplicationService(createSyntheticRuntime().ports), adapter = new McpAdapter(createApplicationBackend(service));
    const context = { actorId: "image-agent", scopes: ["inventory:read", "inventory:write"] as const };
    expect(await adapter.callTool("list_inventory_images", { itemId: "printer-h2d" }, context)).toMatchObject({ structuredContent: { version: 0, images: [] } });
    const input = { itemId: "printer-h2d", image: upload };
    const result = await adapter.callTool("add_inventory_image", input, context);
    expect(result).toMatchObject({ isError: false, structuredContent: { data: { version: 1 }, replayed: false } });
    expect(JSON.stringify(result)).not.toContain(imageBase64);
    expect(await adapter.callTool("add_inventory_image", input, context)).toMatchObject({ structuredContent: { replayed: true } });
    for (const name of ["list_inventory_images", "add_inventory_image"]) expect(await adapter.callTool(name, input, { ...context, projectIds: ["synthetic-project-lamp"] })).toMatchObject({ isError: true, structuredContent: { error: { code: "FORBIDDEN" } } });
    expect(await adapter.callTool("add_inventory_image", input, { actorId: "reader", scopes: ["inventory:read"] })).toMatchObject({ isError: true });
    expect(await adapter.callTool("add_inventory_image", { ...input, path: "/private/image.png" }, context)).toMatchObject({ isError: true });
  });
});
