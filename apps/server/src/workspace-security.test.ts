import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, bearerRecord } from "./app.js";
import { hashBearerToken } from "./auth.js";
import { createProductionRuntime, MemoryWorkspaceSecurity, hashWorkspacePassword } from "@benchledger/runtime";
import { createMemoryRuntime } from "./memory-store.js";

function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

function csrfFromCookie(cookie: string): string {
  const token = cookie.split("; ").find((value) => value.startsWith("forge_csrf="))?.slice("forge_csrf=".length);
  if (token === undefined) throw new Error("CSRF cookie was not issued");
  return token;
}

describe("workspace password access", () => {
  it("defaults to LAN-open, requires explicit browser bootstrap, and never grants MCP implicitly", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-workspace-open-"));
    const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    const app = await createApp({ runtime, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    try {
      const access = await app.inject({ method: "GET", url: "/api/v1/auth/access" });
      expect(access.statusCode).toBe(200);
      expect(access.json()).toEqual({ mode: "lan_open", passwordConfigured: false, version: 1 });
      expect((await app.inject({ method: "GET", url: "/api/v1/workspace" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/v1/mcp", payload: {} })).statusCode).toBe(401);

      const lan = await app.inject({ method: "POST", url: "/api/v1/auth/lan-session" });
      expect(lan.statusCode).toBe(200);
      expect(lan.json()).toMatchObject({ mode: "lan_open", authenticated: true, actor: "workspace-admin", credentialRevision: 1 });
      const cookie = cookieHeader(lan.headers["set-cookie"]);
      expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } })).json()).toMatchObject({ actor: "workspace-admin", scopes: expect.arrayContaining(["admin"]) });
      expect((await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { cookie } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { cookie, authorization: "Basic invalid" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/v1/mcp", headers: { cookie, "x-csrf-token": csrfFromCookie(cookie) }, payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } })).statusCode).toBe(401);
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("enables, rotates, changes, and disables the durable password with CSRF and reauthentication", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-workspace-password-"));
    const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    const app = await createApp({ runtime, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    try {
      const lan = await app.inject({ method: "POST", url: "/api/v1/auth/lan-session" });
      const oldCookie = cookieHeader(lan.headers["set-cookie"]);
      const oldCsrf = csrfFromCookie(oldCookie);
      const enabled = await app.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { cookie: oldCookie, "x-csrf-token": oldCsrf, "if-match": "1", "idempotency-key": "workspace-enable-1" }, payload: { mode: "password", newPassword: "first-workspace-password" } });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toMatchObject({ mode: "password", access: { mode: "password", passwordConfigured: true, version: 2 }, session: { actor: "workspace-admin" } });
      expect(JSON.stringify(enabled.json())).not.toContain("first-workspace-password");
      const storedEnable = await runtime.ports.idempotency.get("workspace-admin", "workspace-enable-1") as { fingerprint?: string };
      expect(storedEnable.fingerprint).toBe(createHmac("sha256", "s".repeat(48)).update("6:enable1:10:24:first-workspace-password").digest("hex"));
      expect(JSON.stringify(storedEnable)).not.toContain("first-workspace-password");
      expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: oldCookie } })).statusCode).toBe(401);

      const newCookie = cookieHeader(enabled.headers["set-cookie"]);
      const newCsrf = csrfFromCookie(newCookie);
      const wrong = await app.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { cookie: newCookie, "x-csrf-token": newCsrf, "if-match": "2", "idempotency-key": "workspace-change-wrong" }, payload: { mode: "password", currentPassword: "wrong-password", newPassword: "second-workspace-password" } });
      expect(wrong.statusCode).toBe(401);
      const changed = await app.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { cookie: newCookie, "x-csrf-token": newCsrf, "if-match": "2", "idempotency-key": "workspace-change-1" }, payload: { mode: "password", currentPassword: "first-workspace-password", newPassword: "second-workspace-password" } });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ access: { mode: "password", version: 3 }, session: { authenticated: true } });
      const changedReplay = await app.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { cookie: cookieHeader(changed.headers["set-cookie"]), "x-csrf-token": csrfFromCookie(cookieHeader(changed.headers["set-cookie"])), "if-match": "2", "idempotency-key": "workspace-change-1" }, payload: { mode: "password", currentPassword: "first-workspace-password", newPassword: "second-workspace-password" } });
      expect(changedReplay.statusCode).toBe(200);
      expect(changedReplay.json()).toMatchObject({ replayed: true, access: { mode: "password", version: 3 } });
      const changedSessionCookie = cookieHeader(changed.headers["set-cookie"]);
      expect((await app.inject({ method: "POST", url: "/api/v1/mcp", headers: { cookie: changedSessionCookie, "x-csrf-token": csrfFromCookie(changedSessionCookie) }, payload: { jsonrpc: "2.0", id: 2, method: "initialize", params: {} } })).statusCode).toBe(401);
      const changedCookie = cookieHeader(changed.headers["set-cookie"]);
      const changedCsrf = csrfFromCookie(changedCookie);
      const historicalEnableReplay = await app.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { cookie: changedCookie, "x-csrf-token": changedCsrf, "if-match": "1", "idempotency-key": "workspace-enable-1" }, payload: { mode: "password", newPassword: "first-workspace-password" } });
      expect(historicalEnableReplay.statusCode).toBe(200);
      expect(historicalEnableReplay.json()).toMatchObject({ mode: "password", access: { mode: "password", passwordConfigured: true, version: 3 }, session: { credentialRevision: 3 }, credentialRevision: 3, replayed: true });
      expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: cookieHeader(enabled.headers["set-cookie"]) } })).statusCode).toBe(401);
      const replayCookie = cookieHeader(historicalEnableReplay.headers["set-cookie"]);
      expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: replayCookie } })).statusCode).toBe(200);
      const disabled = await app.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { cookie: changedCookie, "x-csrf-token": changedCsrf, "if-match": "3", "idempotency-key": "workspace-disable-1" }, payload: { mode: "lan_open", currentPassword: "second-workspace-password" } });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toMatchObject({ access: { mode: "lan_open", passwordConfigured: false, version: 4 } });
      const disabledCookie = cookieHeader(disabled.headers["set-cookie"]);
      const disabledReplay = await app.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { cookie: disabledCookie, "x-csrf-token": csrfFromCookie(disabledCookie), "if-match": "3", "idempotency-key": "workspace-disable-1" }, payload: { mode: "lan_open", currentPassword: "second-workspace-password" } });
      expect(disabledReplay.statusCode).toBe(200);
      expect(disabledReplay.json()).toMatchObject({ replayed: true, access: { mode: "lan_open", version: 4 } });
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { ["password"]: "second-workspace-password" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/lan-session" })).statusCode).toBe(200);
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects bearer/project principals and requires idempotency for security changes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-workspace-boundary-"));
    const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    const bearerFixture = "admin-security-token";
    const app = await createApp({ runtime, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord(bearerFixture, ["admin"], undefined, "security-agent")] }, logger: false });
    try {
      const lan = await app.inject({ method: "POST", url: "/api/v1/auth/lan-session" });
      const cookie = cookieHeader(lan.headers["set-cookie"]);
      const csrf = csrfFromCookie(cookie);
      const missing = await app.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { cookie, "x-csrf-token": csrf }, payload: { mode: "password", newPassword: "a-new-workspace-password" } });
      expect(missing.statusCode).toBe(400);
      const bearer = await app.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { authorization: `Bearer ${bearerFixture}` }, payload: { mode: "password", newPassword: "a-new-workspace-password" } });
      expect(bearer.statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/api/v1/capabilities" })).json()).toMatchObject({ authentication: { bearerRequiredForMcp: true, explicitLanSession: "/api/v1/auth/lan-session" }, actions: expect.arrayContaining(["reconciliation.read", "reconciliation.write"]) });
      expect(hashBearerToken(bearerFixture)).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects distinct NUL-framed password fields under one idempotency key", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-workspace-fingerprint-"));
    const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    const app = await createApp({ runtime, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    const initialPassword = "aaaaaaaaaaaa\u0000bbbbbbbbbbbb";
    const replacementPassword = "cccccccccccc";
    try {
      const lan = await app.inject({ method: "POST", url: "/api/v1/auth/lan-session" });
      const lanCookie = cookieHeader(lan.headers["set-cookie"]);
      const enabled = await app.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { cookie: lanCookie, "x-csrf-token": csrfFromCookie(lanCookie), "if-match": "1", "idempotency-key": "workspace-fingerprint-enable" }, payload: { mode: "password", newPassword: initialPassword } });
      expect(enabled.statusCode).toBe(200);
      const enabledCookie = cookieHeader(enabled.headers["set-cookie"]);
      const firstChange = await app.inject({ method: "POST", url: "/api/v1/auth/security", headers: { cookie: enabledCookie, "x-csrf-token": csrfFromCookie(enabledCookie), "if-match": "2", "idempotency-key": "workspace-fingerprint-change" }, payload: { operation: "change_password", currentPassword: initialPassword, newPassword: replacementPassword, expectedVersion: 2 } });
      expect(firstChange.statusCode).toBe(200);
      const changedCookie = cookieHeader(firstChange.headers["set-cookie"]);
      const collidingChange = await app.inject({ method: "POST", url: "/api/v1/auth/security", headers: { cookie: changedCookie, "x-csrf-token": csrfFromCookie(changedCookie), "if-match": "2", "idempotency-key": "workspace-fingerprint-change" }, payload: { operation: "change_password", currentPassword: "aaaaaaaaaaaa", newPassword: "bbbbbbbbbbbb\u0000cccccccccccc", expectedVersion: 2 } });
      expect(collidingChange.statusCode).toBe(409);
      expect(collidingChange.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("forwards an injected Argon2 verifier and rejects invalid bootstrap hashes before runtime startup", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-workspace-bootstrap-"));
    const encoded = "$argon2id$v=19$m=65536,t=3,p=1$synthetic-salt$synthetic-hash";
    const verifier = async (password: string, hash: string): Promise<boolean> => password === "argon-workspace-password" && hash === encoded;
    try {
      const app = await createApp({ dataDir, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: "s".repeat(48), secureCookies: false, adminPasswordHash: encoded, passwordVerifier: verifier }, logger: false });
      try {
        expect((await app.inject({ method: "GET", url: "/api/v1/auth/access" })).json()).toEqual({ mode: "password", passwordConfigured: true, version: 1 });
        expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { ["password"]: "argon-workspace-password" } })).statusCode).toBe(200);
      } finally {
        await app.close();
      }
      await expect(createApp({ dataDir: join(dataDir, "invalid"), publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: "s".repeat(48), secureCookies: false, adminPasswordHash: "not-a-password-hash" }, logger: false })).rejects.toThrow(/bootstrap password hash is invalid/u);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("persists a Settings password change across production close and reopen", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-workspace-reopen-"));
    const sessionSecret = "s".repeat(48);
    const oldPassword = "argon-workspace-password";
    const newPassword = "reopened-workspace-password";
    // Synthetic but structurally valid Argon2id material keeps this test
    // dependency-free while exercising the host-injected verifier boundary.
    const encoded = "$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljLXNhbHQ$c3ludGhldGljLWhhc2g";
    const verifier = async (password: string, hash: string): Promise<boolean> => password === oldPassword && hash === encoded;
    const runtime = await createProductionRuntime({ dataDir, workspacePasswordHash: encoded, workspacePasswordVerifier: verifier });
    const app = await createApp({ runtime, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret, secureCookies: false }, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: oldPassword } });
      expect(login.statusCode).toBe(200);
      expect(login.body).not.toContain(oldPassword);
      const cookie = cookieHeader(login.headers["set-cookie"]);
      const csrf = csrfFromCookie(cookie);
      const changed = await app.inject({
        method: "POST",
        url: "/api/v1/auth/security",
        headers: { cookie, "x-csrf-token": csrf, "if-match": "1", "idempotency-key": "workspace-reopen-change" },
        payload: { operation: "change_password", currentPassword: oldPassword, newPassword, expectedVersion: 1 }
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.body).not.toContain(oldPassword);
      expect(changed.body).not.toContain(newPassword);
      const audits = await runtime.ports.audit.list(100);
      const serializedAudits = JSON.stringify(audits);
      expect(serializedAudits).not.toContain(oldPassword);
      expect(serializedAudits).not.toContain(newPassword);
      expect(serializedAudits).not.toContain(encoded);
      const stored = await runtime.ports.idempotency.get("workspace-admin", "workspace-reopen-change");
      expect(JSON.stringify(stored)).not.toContain(oldPassword);
      expect(JSON.stringify(stored)).not.toContain(newPassword);
      expect(JSON.stringify(stored)).not.toContain(encoded);
    } finally {
      await app.close();
    }

    const reopenedRuntime = await createProductionRuntime({ dataDir, workspacePasswordVerifier: verifier });
    const reopenedApp = await createApp({ runtime: reopenedRuntime, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret, secureCookies: false }, logger: false });
    try {
      const reopenedLogin = await reopenedApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: newPassword } });
      expect(reopenedLogin.statusCode, reopenedLogin.body).toBe(200);
      expect(reopenedLogin.body).not.toContain(newPassword);
      expect((await reopenedApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: oldPassword } })).statusCode).toBe(401);
    } finally {
      await reopenedApp.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("applies cumulative and concurrent throttles across verification and password hashing", async () => {
    const oldPassword = "old-workspace-password";
    const encoded = await hashWorkspacePassword(oldPassword);
    const makePorts = () => {
      const memory = createMemoryRuntime();
      const security = new MemoryWorkspaceSecurity({ bootstrapHash: encoded, verifier: async (password, hash) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return password === oldPassword && hash === encoded;
      } });
      return { ...memory.ports, workspaceSecurity: security };
    };
    const first = makePorts();
    const app = await createApp({ ports: first, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: oldPassword } });
      const cookie = cookieHeader(login.headers["set-cookie"]);
      const csrf = csrfFromCookie(cookie);
      for (let index = 0; index < 5; index += 1) {
        const failed = await app.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { cookie, "x-csrf-token": csrf, "if-match": "1", "idempotency-key": `throttle-current-${index}` }, payload: { mode: "password", currentPassword: "wrong-workspace-password", newPassword: "replacement-workspace-password" } });
        expect(failed.statusCode, failed.body).toBe(401);
      }
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: oldPassword } })).statusCode).toBe(429);
    } finally {
      await app.close();
    }

    const concurrent = makePorts();
    const concurrentApp = await createApp({ ports: concurrent, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    try {
      const results = await Promise.all([0, 1, 2].map((index) => concurrentApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: `wrong-workspace-password-${index}` } })));
      expect(results.map((result) => result.statusCode)).toEqual(expect.arrayContaining([429]));
    } finally {
      await concurrentApp.close();
    }

    const openMemory = createMemoryRuntime();
    const openPorts = { ...openMemory.ports, workspaceSecurity: new MemoryWorkspaceSecurity() };
    const hashingApp = await createApp({ ports: openPorts, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    try {
      const lan = await hashingApp.inject({ method: "POST", url: "/api/v1/auth/lan-session" });
      const cookie = cookieHeader(lan.headers["set-cookie"]);
      const csrf = csrfFromCookie(cookie);
      const results = await Promise.all([0, 1, 2].map((index) => hashingApp.inject({ method: "PATCH", url: "/api/v1/auth/access", headers: { cookie, "x-csrf-token": csrf, "if-match": "1", "idempotency-key": `throttle-hash-${index}` }, payload: { mode: "password", newPassword: `hashing-workspace-password-${index}` } })));
      expect(results.filter((result) => result.statusCode === 429)).toHaveLength(1);
    } finally {
      await hashingApp.close();
    }
  });
});
