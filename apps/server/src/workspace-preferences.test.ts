import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, bearerRecord } from "./app.js";
import { jsonOpenApi } from "./openapi.js";

function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

function csrfFromCookie(cookie: string): string {
  const token = cookie.split("; ").find((value) => value.startsWith("forge_csrf="))?.slice("forge_csrf=".length);
  if (token === undefined) throw new Error("CSRF cookie was not issued");
  return token;
}

describe("workspace preferences REST surface", () => {
  it("reads for every authenticated caller, previews impact and lets only an admin browser session change the policy", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-preferences-"));
    const app = await createApp({
      dataDir, publicBaseUrl: "http://127.0.0.1:8792", logger: false,
      auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("reader-token-value", ["read"]), bearerRecord("admin-agent-token", ["read", "write", "admin"]), bearerRecord("scoped-token-value", ["read", "write"], ["some-project"])] }
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/v1/workspace/preferences" })).statusCode).toBe(401);
      const read = await app.inject({ method: "GET", url: "/api/v1/workspace/preferences", headers: { authorization: "Bearer reader-token-value" } });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ stockReceivingPolicy: "on_receipt", version: 1 });
      expect(read.headers.etag).toBe('"1"');

      const lan = await app.inject({ method: "POST", url: "/api/v1/auth/lan-session" });
      const cookie = cookieHeader(lan.headers["set-cookie"]);
      const csrf = csrfFromCookie(cookie);
      const created = await app.inject({ method: "POST", url: "/api/v1/inventory", headers: { cookie, "x-csrf-token": csrf }, payload: { id: "rest-delivered", name: "Delivered inserts", kind: "fastener", quantity: 8, unit: "each", tags: [], links: [], evidence: { state: "delivered_uncounted" } } });
      expect(created.statusCode).toBe(201);

      const impact = await app.inject({ method: "GET", url: "/api/v1/workspace/preferences/stock-receiving-impact?stockReceivingPolicy=on_delivery", headers: { authorization: "Bearer reader-token-value" } });
      expect(impact.statusCode).toBe(200);
      expect(impact.json()).toMatchObject({ from: "on_receipt", to: "on_delivery", gained: [{ itemId: "rest-delivered", evidenceState: "delivered_uncounted", from: "inspect_first", to: "assumed" }], lost: [], blockedBy: [] });
      expect((await app.inject({ method: "GET", url: "/api/v1/workspace/preferences/stock-receiving-impact?stockReceivingPolicy=sometimes", headers: { authorization: "Bearer reader-token-value" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/api/v1/workspace/preferences/stock-receiving-impact?stockReceivingPolicy=on_delivery", headers: { authorization: "Bearer scoped-token-value" } })).statusCode).toBe(403);

      // Agents (bearer tokens), even with admin scope, cannot change it.
      for (const token of ["reader-token-value", "admin-agent-token"]) {
        const denied = await app.inject({ method: "PUT", url: "/api/v1/workspace/preferences", headers: { authorization: `Bearer ${token}` }, payload: { stockReceivingPolicy: "on_delivery" } });
        expect(denied.statusCode).toBe(403);
      }
      expect((await app.inject({ method: "PUT", url: "/api/v1/workspace/preferences", headers: { cookie }, payload: { stockReceivingPolicy: "on_delivery" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "PUT", url: "/api/v1/workspace/preferences", headers: { cookie, "x-csrf-token": csrf }, payload: { stockReceivingPolicy: "on_arrival" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/v1/workspace/preferences", headers: { cookie, "x-csrf-token": csrf, "if-match": '"1"' }, payload: { stockReceivingPolicy: "on_delivery", expectedVersion: 2 } })).statusCode).toBe(400);
      const stale = await app.inject({ method: "PUT", url: "/api/v1/workspace/preferences", headers: { cookie, "x-csrf-token": csrf, "if-match": '"4"' }, payload: { stockReceivingPolicy: "on_delivery" } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: "conflict", details: { reason: "version_mismatch", actualVersion: 1 } } });

      const changed = await app.inject({ method: "PUT", url: "/api/v1/workspace/preferences", headers: { cookie, "x-csrf-token": csrf, "if-match": '"1"', "idempotency-key": "policy-change-0001" }, payload: { stockReceivingPolicy: "on_delivery" } });
      expect(changed.statusCode).toBe(200);
      expect(changed.headers.etag).toBe('"2"');
      expect(changed.json()).toMatchObject({ data: { stockReceivingPolicy: "on_delivery", version: 2 }, audit: { action: "workspace.preferences.update", actor: "workspace-admin", change: { from: "on_receipt", to: "on_delivery" } }, replayed: false });
      const replay = await app.inject({ method: "PUT", url: "/api/v1/workspace/preferences", headers: { cookie, "x-csrf-token": csrf, "if-match": '"1"', "idempotency-key": "policy-change-0001" }, payload: { stockReceivingPolicy: "on_delivery" } });
      expect(replay.json()).toMatchObject({ replayed: true, data: { version: 2 } });

      const item = await app.inject({ method: "GET", url: "/api/v1/inventory/rest-delivered", headers: { authorization: "Bearer reader-token-value" } });
      expect(item.json()).toMatchObject({ availableQuantity: 8, availability: "assumed", evidence: { state: "delivered_uncounted" } });
      const workspace = await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { cookie } });
      expect(workspace.json()).toMatchObject({ preferences: { stockReceivingPolicy: "on_delivery", version: 2 } });
      const capabilities = await app.inject({ method: "GET", url: "/api/v1/capabilities" });
      expect(capabilities.json()).toMatchObject({ stockReceivingPolicy: { policies: ["on_purchase", "on_delivery", "on_receipt"], default: "on_receipt" }, vocabulary: { assumed: expect.stringMatching(/receiving policy/) } });
      expect(JSON.stringify(capabilities.json())).not.toContain("on_delivery\",\"version");
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("honours optional If-Match / expectedVersion atomically on counts and stock events", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-stock-version-"));
    const app = await createApp({ dataDir, publicBaseUrl: "http://127.0.0.1:8792", logger: false, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("writer-token-value", ["read", "write"])] } });
    const headers = { authorization: "Bearer writer-token-value" };
    try {
      const created = await app.inject({ method: "POST", url: "/api/v1/inventory", headers, payload: { id: "versioned-item", name: "Versioned spool", kind: "filament", quantity: 500, unit: "gram", tags: [], links: [], evidence: { state: "physically_counted" } } });
      expect(created.statusCode).toBe(201);
      const stale = await app.inject({ method: "POST", url: "/api/v1/inventory/versioned-item/count", headers: { ...headers, "if-match": '"9"' }, payload: { quantity: 400 } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { details: { reason: "version_conflict", expectedVersion: 9, actualVersion: 1 } } });
      expect((await app.inject({ method: "GET", url: "/api/v1/inventory/versioned-item", headers })).json()).toMatchObject({ quantity: 500, version: 1 });
      expect((await app.inject({ method: "POST", url: "/api/v1/inventory/versioned-item/count", headers: { ...headers, "if-match": '"1"' }, payload: { quantity: 400, expectedVersion: 2 } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/v1/inventory/versioned-item/count", headers, payload: { quantity: 400, expectedVersion: 0 } })).statusCode).toBe(400);
      const counted = await app.inject({ method: "POST", url: "/api/v1/inventory/versioned-item/count", headers: { ...headers, "if-match": '"1"' }, payload: { quantity: 400 } });
      expect(counted.statusCode).toBe(201);
      const version = (counted.json() as { data: { item: { version: number } } }).data.item.version;
      const staleEvent = await app.inject({ method: "POST", url: "/api/v1/inventory/versioned-item/stock-events", headers, payload: { type: "consume", quantity: 10, unit: "gram", expectedVersion: version - 1 } });
      expect(staleEvent.statusCode).toBe(409);
      const event = await app.inject({ method: "POST", url: "/api/v1/inventory/versioned-item/stock-events", headers, payload: { type: "consume", quantity: 10, unit: "gram", expectedVersion: version } });
      expect(event.statusCode).toBe(201);
      // Without a version the legacy unconditional behaviour is unchanged.
      expect((await app.inject({ method: "POST", url: "/api/v1/inventory/versioned-item/stock-events", headers, payload: { type: "consume", quantity: 5, unit: "gram" } })).statusCode).toBe(201);
      expect((await app.inject({ method: "GET", url: "/api/v1/inventory/versioned-item", headers })).json()).toMatchObject({ quantity: 385 });
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("documents the endpoints in OpenAPI", () => {
    const document = jsonOpenApi("test") as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };
    expect(Object.keys(document.paths["/workspace/preferences"] ?? {}).sort()).toEqual(["get", "put"]);
    expect(document.paths["/workspace/preferences/stock-receiving-impact"]?.get).toBeDefined();
    expect(document.components.schemas.WorkspacePreferences).toBeDefined();
    expect(document.components.schemas.StockReceivingPolicyImpact).toBeDefined();
  });
});
