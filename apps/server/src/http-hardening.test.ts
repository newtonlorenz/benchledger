import { describe, expect, it, vi } from "vitest";
import { createApp, bearerRecord } from "./app.js";
import { AuthManager, assertStrongSessionSecret, secureCookiesFromEnvironment } from "./auth.js";
import { allowedHostsFromEnvironment, trustProxyFromEnvironment } from "./config.js";
import { createMemoryRuntime } from "./memory-store.js";
import { healthSchema } from "@benchledger/api-contract";
import { ApplicationService } from "@benchledger/application";

const secret = "s".repeat(48);

async function lanOpenApp(extra: Record<string, unknown> = {}) {
  return createApp({ runtime: createMemoryRuntime(), publicBaseUrl: "http://bench.example:8792", auth: { sessionSecret: secret, secureCookies: false }, logger: false, ...extra });
}

describe("DNS rebinding and cross-origin protection", () => {
  it("rejects a foreign Host header before issuing a LAN-open session", async () => {
    const app = await lanOpenApp();
    try {
      const rebound = await app.inject({ method: "POST", url: "/api/v1/auth/lan-session", headers: { host: "attacker.example:8792" } });
      expect(rebound.statusCode).toBe(421);
      expect(rebound.headers["set-cookie"]).toBeUndefined();
      expect((await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { host: "attacker.example:8792" } })).statusCode).toBe(421);
      expect((await app.inject({ method: "GET", url: "/", headers: { host: "attacker.example" } })).statusCode).toBe(421);
      // Configured public host and loopback names remain usable.
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/lan-session", headers: { host: "bench.example:8792" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/lan-session", headers: { host: "127.0.0.1:8794" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/lan-session", headers: { host: "[::1]:8792" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/lan-session" })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("honours an explicit extra host allow-list", async () => {
    const app = await lanOpenApp({ allowedHosts: ["bench.lan"] });
    try {
      expect((await app.inject({ method: "GET", url: "/api/v1/health", headers: { host: "BENCH.lan:8792" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/health", headers: { host: "other.lan" } })).statusCode).toBe(421);
    } finally { await app.close(); }
  });

  it("requires a same-origin Origin for LAN session bootstrap and cookie-authenticated writes", async () => {
    const app = await lanOpenApp();
    try {
      const crossSite = await app.inject({ method: "POST", url: "/api/v1/auth/lan-session", headers: { host: "bench.example:8792", origin: "http://attacker.example" } });
      expect(crossSite.statusCode).toBe(403);
      expect(crossSite.headers["set-cookie"]).toBeUndefined();
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/lan-session", headers: { host: "bench.example:8792", origin: "null" } })).statusCode).toBe(403);
      const sameOrigin = await app.inject({ method: "POST", url: "/api/v1/auth/lan-session", headers: { host: "bench.example:8792", origin: "http://bench.example:8792" } });
      expect(sameOrigin.statusCode).toBe(200);
      const cookie = (sameOrigin.headers["set-cookie"] as string[]).map((value) => value.split(";", 1)[0]).join("; ");
      const csrf = sameOrigin.json().csrfToken as string;
      const write = (origin: string) => app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie, "x-csrf-token": csrf, origin }, payload: { id: "origin-project", name: "Origin project", status: "idea" } });
      expect((await write("http://attacker.example")).statusCode).toBe(403);
      // A TLS proxy may forward an internal Host; the configured public origin still matches.
      expect((await write("http://bench.example:8792")).statusCode).toBe(201);
    } finally { await app.close(); }
  });
});

describe("request body limits", () => {
  it("bounds unauthenticated auth bodies to a few kilobytes", async () => {
    const app = await lanOpenApp();
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ password: "x".repeat(64 * 1024) }) });
      expect(login.statusCode).toBe(413);
      expect(login.json().error.code).toBe("quota_exceeded");
      const binary = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/octet-stream" }, payload: Buffer.alloc(3 * 1024 * 1024) });
      expect(binary.statusCode).toBe(413);
    } finally { await app.close(); }
  });

  it("caps ordinary API bodies at the JSON limit regardless of media type", async () => {
    const app = await lanOpenApp();
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/inventory", headers: { "content-type": "application/octet-stream" }, payload: Buffer.alloc(3 * 1024 * 1024) });
      expect(response.statusCode).toBe(413);
    } finally { await app.close(); }
  });

  it("lets the configured upload limit govern upload routes above the old 100 MB ceiling", async () => {
    const declared = String(120 * 1024 * 1024);
    const defaults = await lanOpenApp();
    const larger = await lanOpenApp({ maxUploadBytes: 150 * 1024 * 1024 });
    try {
      const request = { method: "PUT" as const, url: "/api/v1/artifacts/uploads/upload-1", headers: { "content-type": "application/octet-stream", "content-length": declared }, payload: Buffer.alloc(1) };
      expect((await defaults.inject(request)).statusCode).toBe(413);
      // Passes the size gate and reaches authentication instead.
      expect((await larger.inject(request)).statusCode).toBe(401);
      // The upload allowance does not leak to ordinary JSON routes.
      expect((await larger.inject({ ...request, method: "POST", url: "/api/v1/inventory" })).statusCode).toBe(413);
    } finally { await defaults.close(); await larger.close(); }
  });
});

describe("MCP body limit", () => {
  it("accepts the largest MCP inventory image (2 MiB raw, base64 in a JSON-RPC envelope) but still bounds the route", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: secret, secureCookies: false, bearerTokens: [bearerRecord("mcp-writer", ["read", "write"])] }, logger: false });
    const envelope = (base64: string) => JSON.stringify({ jsonrpc: "2.0", id: "image", method: "tools/call", params: { name: "add_inventory_image", arguments: { itemId: "printer-h2d", expectedVersion: 1, image: { filename: "photo.png", mediaType: "image/png", label: "item_photo", altText: "Synthetic photo", base64 } } } });
    const post = (payload: string) => app.inject({ method: "POST", url: "/api/v1/mcp", headers: { authorization: "Bearer mcp-writer", "content-type": "application/json" }, payload });
    try {
      const largest = Buffer.alloc(2 * 1024 * 1024, 7).toString("base64");
      const accepted = await post(envelope(largest));
      expect(accepted.statusCode, accepted.body.slice(0, 200)).not.toBe(413);
      expect((await post(envelope(`${largest}${"A".repeat(512 * 1024)}`))).statusCode).toBe(413);
    } finally { await app.close(); }
  });
});

describe("security headers", () => {
  it("adds nosniff, referrer, framing and CSP headers to API and SPA responses", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: secret, secureCookies: false }, logger: false });
    try {
      const api = await app.inject({ method: "GET", url: "/api/v1/health" });
      expect(api.headers["x-content-type-options"]).toBe("nosniff");
      expect(api.headers["referrer-policy"]).toBe("no-referrer");
      expect(api.headers["x-frame-options"]).toBe("DENY");
      expect(String(api.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
      const spa = await app.inject({ method: "GET", url: "/" });
      if (spa.statusCode === 200) {
        const csp = String(spa.headers["content-security-policy"]);
        expect(csp).toContain("script-src 'self'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("object-src 'none'");
        expect(csp).not.toContain("unsafe-eval");
      }
    } finally { await app.close(); }
  });
});

describe("session secret strength", () => {
  it("rejects the documented placeholder and low-entropy secrets", () => {
    expect(() => assertStrongSessionSecret("replace-with-at-least-32-random-bytes")).toThrow(/placeholder/u);
    expect(() => new AuthManager({ sessionSecret: "replace-with-at-least-32-random-bytes" })).toThrow(/placeholder/u);
    expect(() => assertStrongSessionSecret("a".repeat(64))).toThrow(/low-entropy|random/u);
    expect(() => assertStrongSessionSecret("abababababababababababababababab")).toThrow();
    expect(() => assertStrongSessionSecret("short")).toThrow(/32/u);
    expect(() => assertStrongSessionSecret("k3Jf9-Qw2LzX8pV0bN4mR7tY1uE6sA5dG_hC")).not.toThrow();
  });

  it("refuses a weak environment-sourced secret at startup", async () => {
    const previous = process.env.BENCHLEDGER_SESSION_SECRET;
    process.env.BENCHLEDGER_SESSION_SECRET = "replace-with-at-least-32-random-bytes";
    try {
      await expect(createApp({ runtime: createMemoryRuntime(), publicBaseUrl: "http://127.0.0.1:8792", logger: false })).rejects.toThrow(/BENCHLEDGER_SESSION_SECRET/u);
    } finally {
      if (previous === undefined) delete process.env.BENCHLEDGER_SESSION_SECRET; else process.env.BENCHLEDGER_SESSION_SECRET = previous;
    }
  });
});

describe("artifact download media types", () => {
  it("serves only allow-listed media types and falls back to octet-stream", async () => {
    const { artifactResponseType } = await import("./app.js");
    expect(artifactResponseType("image/png")).toBe("image/png");
    expect(artifactResponseType("Model/STL")).toBe("model/stl");
    expect(artifactResponseType("text/plain; charset=utf-8")).toBe("text/plain; charset=utf-8");
    expect(artifactResponseType("text/html")).toBe("application/octet-stream");
    expect(artifactResponseType("image/svg+xml")).toBe("application/octet-stream");
    expect(artifactResponseType("application/javascript")).toBe("application/octet-stream");
    expect(artifactResponseType("image/png\r\nx-injected: 1")).toBe("application/octet-stream");
  });
});

describe("readiness detail", () => {
  it("strips internal checks for unauthenticated callers but keeps them for authenticated ones", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: secret, secureCookies: false, bearerTokens: [bearerRecord("ready-reader", ["read"])] }, logger: false });
    try {
      const anonymous = await app.inject({ method: "GET", url: "/api/v1/ready" });
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.json()).not.toHaveProperty("checks");
      const authenticated = await app.inject({ method: "GET", url: "/api/v1/ready", headers: { authorization: "Bearer ready-reader" } });
      expect(authenticated.json()).toHaveProperty("checks");
    } finally { await app.close(); }
  });
});

describe("error mapping", () => {
  it("maps service-level ZodErrors to 400 validation with field paths and logs 5xx with correlation", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: secret, secureCookies: false, bearerTokens: [bearerRecord("zod-reader", ["read"])] }, logger: false });
    try {
      app.get("/api/v1/__zod", async () => healthSchema.parse({ status: 42 }));
      app.get("/api/v1/__boom", async () => { throw new Error("synthetic failure"); });
      const errorLog = vi.fn();
      app.addHook("onRequest", async (request) => { request.log.error = errorLog as never; });
      const zod = await app.inject({ method: "GET", url: "/api/v1/__zod", headers: { authorization: "Bearer zod-reader" } });
      expect(zod.statusCode).toBe(400);
      expect(zod.json().error.code).toBe("validation");
      expect(zod.json().error.details.issues[0]).toHaveProperty("path");
      expect(JSON.stringify(zod.json())).not.toContain("synthetic failure");
      const boom = await app.inject({ method: "GET", url: "/api/v1/__boom", headers: { authorization: "Bearer zod-reader", "x-correlation-id": "boom-correlation" } });
      expect(boom.statusCode).toBe(500);
      expect(boom.json().error).toMatchObject({ code: "internal", correlationId: "boom-correlation" });
      expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ correlationId: "boom-correlation" }), expect.any(String));
    } finally { await app.close(); }
  });
});

describe("server-side schema failures", () => {
  it("reports a malformed server-built response as a logged 500, not a client validation error", async () => {
    const runtime = createMemoryRuntime();
    const service = new ApplicationService(runtime.ports);
    vi.spyOn(service, "health").mockResolvedValue({ status: "ok", service: "benchledger", version: 42 } as never);
    const app = await createApp({ runtime, service, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: secret, secureCookies: false }, logger: false });
    try {
      const errorLog = vi.fn();
      app.addHook("onRequest", async (request) => { request.log.error = errorLog as never; });
      const response = await app.inject({ method: "GET", url: "/api/v1/health", headers: { "x-correlation-id": "shape-correlation" } });
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toEqual({ code: "internal", message: "An unexpected server error occurred", correlationId: "shape-correlation" });
      expect(JSON.stringify(response.json())).not.toContain("version");
      expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ correlationId: "shape-correlation" }), expect.any(String));
    } finally { await app.close(); }
  });

  it("keeps HTTP request-parsing failures as 400 validation with field paths", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: secret, secureCookies: false, bearerTokens: [bearerRecord("request-writer", ["read", "write"])] }, logger: false });
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { authorization: "Bearer request-writer" }, payload: { name: 42 } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("validation");
      expect(response.json().error.details.issues[0]).toHaveProperty("path");
    } finally { await app.close(); }
  });
});

describe("optimistic concurrency", () => {
  it("requires If-Match on BOM line edits with 428", async () => {
    const app = await createApp({ demo: true, runtime: createMemoryRuntime([]), auth: { sessionSecret: secret, bearerTokens: [bearerRecord("owner", ["read", "write"])] }, logger: false });
    const headers = { authorization: "Bearer owner" };
    try {
      const created = await app.inject({ method: "POST", url: "/api/v1/projects/with-initial-revision", headers, payload: { project: { id: "precondition-project", name: "Precondition project", status: "idea" }, revision: { id: "precondition-rev", name: "First", status: "concept", fabricationRoute: "none" } } });
      expect(created.statusCode, created.body).toBe(201);
      const line = await app.inject({ method: "POST", url: "/api/v1/project-revisions/precondition-rev/bom", headers, payload: { name: "Screws", role: "consumed", requiredQuantity: 4, unit: "each", optional: false, constraints: {}, alternatives: [] } });
      expect(line.statusCode, line.body).toBe(201);
      const id = line.json().data.id as string;
      const missing = await app.inject({ method: "PATCH", url: `/api/v1/bom-lines/${id}`, headers, payload: { name: "Renamed" } });
      expect(missing.statusCode).toBe(428);
      expect(missing.json().error.code).toBe("precondition_required");
      expect((await app.inject({ method: "PATCH", url: `/api/v1/bom-lines/${id}`, headers: { ...headers, "if-match": "1" }, payload: { name: "Renamed" } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("documents If-Match as required, with 428, on BOM line edits", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: secret, secureCookies: false }, logger: false });
    try {
      const patch = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json().paths["/bom-lines/{id}"].patch;
      expect(patch.parameters.find((parameter: { name: string }) => parameter.name === "If-Match")).toMatchObject({ in: "header", required: true });
      expect(patch.responses).toHaveProperty("428");
    } finally { await app.close(); }
  });
});

describe("pagination query validation", () => {
  it("rejects malformed limit and cursor values", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: secret, secureCookies: false, bearerTokens: [bearerRecord("page-admin", ["read", "write", "admin"])] }, logger: false });
    const headers = { authorization: "Bearer page-admin" };
    try {
      for (const url of ["/api/v1/projects?limit=abc", "/api/v1/projects?limit=0", "/api/v1/projects?limit=1.5", "/api/v1/projects/removed?limit=NaN", "/api/v1/offers?limit=", "/api/v1/audit?limit=-1", "/api/v1/inventory/printer-h2d/stock-events?limit=x", `/api/v1/offers?cursor=${"c".repeat(600)}`]) {
        const response = await app.inject({ method: "GET", url, headers });
        expect(response.statusCode, url).toBe(400);
        expect(response.json().error.code, url).toBe("validation");
      }
      expect((await app.inject({ method: "GET", url: "/api/v1/projects?limit=20", headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/audit?limit=200", headers })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});

describe("login rate limiting", () => {
  it("parses trust-proxy configuration without trusting arbitrary forwarders by default", () => {
    expect(trustProxyFromEnvironment({})).toBe(false);
    expect(trustProxyFromEnvironment({ BENCHLEDGER_TRUST_PROXY: "false" })).toBe(false);
    expect(trustProxyFromEnvironment({ BENCHLEDGER_TRUST_PROXY: "true" })).toBe(1);
    expect(trustProxyFromEnvironment({ BENCHLEDGER_TRUST_PROXY: "2" })).toBe(2);
    expect(trustProxyFromEnvironment({ BENCHLEDGER_TRUST_PROXY: "10.0.0.0/8, 127.0.0.1" })).toEqual(["10.0.0.0/8", "127.0.0.1"]);
    expect(() => trustProxyFromEnvironment({ BENCHLEDGER_TRUST_PROXY: "everyone" })).toThrow(/BENCHLEDGER_TRUST_PROXY/u);
    expect(trustProxyFromEnvironment({ BENCHLEDGER_TRUST_PROXY: "fd00::/8, ::1, loopback, 192.168.1.0/24" })).toEqual(["fd00::/8", "::1", "loopback", "192.168.1.0/24"]);
    // Hex-only words, out-of-range octets and prefixes fail at configuration time with a clear message.
    for (const value of ["abc", "dead:beef:zz", "999.1.1.1", "10.0.0.0/33", "::1/129", "10.0.0.1/", "fd00::/x"]) {
      expect(() => trustProxyFromEnvironment({ BENCHLEDGER_TRUST_PROXY: value }), value).toThrow(new RegExp(`BENCHLEDGER_TRUST_PROXY.*${value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}`, "u"));
    }
  });

  it("parses the extra allowed hosts list", () => {
    expect(allowedHostsFromEnvironment({})).toEqual([]);
    expect(allowedHostsFromEnvironment({ BENCHLEDGER_ALLOWED_HOSTS: "Bench.lan, 192.168.1.20" })).toEqual(["bench.lan", "192.168.1.20"]);
    expect(() => allowedHostsFromEnvironment({ BENCHLEDGER_ALLOWED_HOSTS: "http://bench.lan" })).toThrow(/BENCHLEDGER_ALLOWED_HOSTS/u);
  });

  it("slows, but never locks out, logins once the global failed-login ceiling is reached", async () => {
    const app = await createApp({ demo: true, trustProxy: true, loginSlowdownMs: 40, auth: { sessionSecret: secret, secureCookies: false }, logger: false });
    const attempt = (address: string, password: string) => app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": address }, payload: { password } });
    try {
      const fastStart = Date.now();
      expect((await attempt("10.2.0.1", "wrong-password-value")).statusCode).toBe(401);
      expect(Date.now() - fastStart).toBeLessThan(40);
      for (let index = 0; index < 60; index += 1) {
        const response = await attempt(`10.1.${Math.floor(index / 250)}.${index % 250}`, "wrong-password-value");
        // Each address is under its own budget, so wrong guesses stay plain 401s.
        expect(response.statusCode).toBe(401);
      }
      // Over the ceiling: a correct password from an unaffected address still works, after the delay.
      const started = Date.now();
      const correct = await attempt("10.3.0.1", "demo-password-please-change");
      expect(correct.statusCode).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(35);
      // A wrong guess is slowed too, so validity is not revealed by timing.
      const slowStart = Date.now();
      expect((await attempt("10.4.0.1", "wrong-password-value")).statusCode).toBe(401);
      expect(Date.now() - slowStart).toBeGreaterThanOrEqual(35);
    } finally { await app.close(); }
  });

  it("still limits repeated failures from one address", async () => {
    const app = await createApp({ demo: true, trustProxy: true, loginSlowdownMs: 0, auth: { sessionSecret: secret, secureCookies: false }, logger: false });
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 7; index += 1) {
        statuses.push((await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": "10.9.9.9" }, payload: { password: "wrong-password-value" } })).statusCode);
      }
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(statuses.slice(5)).toEqual([429, 429]);
    } finally { await app.close(); }
  });
});

describe("session cookies", () => {
  it("defaults to Secure cookies for an HTTPS public origin and leaves the env unset otherwise", async () => {
    expect(secureCookiesFromEnvironment({})).toBeUndefined();
    const app = await createApp({ runtime: createMemoryRuntime(), publicBaseUrl: "https://bench.example", auth: { sessionSecret: secret }, logger: false });
    try {
      const lan = await app.inject({ method: "POST", url: "/api/v1/auth/lan-session", headers: { host: "bench.example" } });
      expect(lan.statusCode).toBe(200);
      expect((lan.headers["set-cookie"] as string[]).every((value) => /;\s*Secure/iu.test(value))).toBe(true);
    } finally { await app.close(); }
  });
});
