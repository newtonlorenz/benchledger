import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hashAdminPassword, AuthManager, bearerTokensFromEnvironment, hashBearerToken, secureCookiesFromEnvironment, type BearerTokenRecord } from "./auth.js";

function encodedSession(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`v1.${body}`).digest("base64url");
  return `v1.${body}.${signature}`;
}

describe("AuthManager", () => {
  it("verifies a high-cost local password hash and rejects a wrong password", async () => {
    const hash = await hashAdminPassword("a-long-test-password");
    const auth = new AuthManager({ sessionSecret: "s".repeat(48), adminPasswordHash: hash, secureCookies: false });
    await expect(auth.verifyPassword("a-long-test-password")).resolves.toBe(true);
    await expect(auth.verifyPassword("wrong-password")).resolves.toBe(false);
  });

  it("fails closed when no production password hash is configured", async () => {
    const auth = new AuthManager({ sessionSecret: "s".repeat(48) });
    await expect(auth.verifyPassword("anything-at-all")).resolves.toBe(false);
  });

  it("allows a host to provide the Argon2id verifier without storing plaintext", async () => {
    const auth = new AuthManager({ sessionSecret: "s".repeat(48), adminPasswordHash: "$argon2id$v=19$m=65536,t=3,p=1$fixture$hash", passwordVerifier: async (password, encoded) => password === "correct-password" && encoded.startsWith("$argon2id$") });
    await expect(auth.verifyPassword("correct-password")).resolves.toBe(true);
    await expect(auth.verifyPassword("wrong-password")).resolves.toBe(false);
  });

  it("loads separate read and write bearer digests without accepting plaintext configuration", () => {
    const read = hashBearerToken("read-secret");
    const write = hashBearerToken("write-secret");
    const records = bearerTokensFromEnvironment({
      BENCHLEDGER_MCP_READ_TOKEN_HASHES: read,
      BENCHLEDGER_MCP_WRITE_TOKEN_HASHES: write
    });
    expect(records).toHaveLength(2);
    expect(records[0]?.scopes).toEqual(new Set(["read"]));
    expect(records[1]?.scopes).toEqual(new Set(["read", "write"]));
    const auth = new AuthManager({ sessionSecret: "s".repeat(48), bearerTokens: records });
    expect(auth.hasScope({ actor: "mcp-token", source: "mcp", scopes: records[1]!.scopes, via: "bearer" }, "read")).toBe(true);
    expect(() => bearerTokensFromEnvironment({ BENCHLEDGER_MCP_READ_TOKEN_HASHES: "read-secret" })).toThrow(/SHA-256/);
    expect(() => bearerTokensFromEnvironment({ BENCHLEDGER_MCP_READ_TOKEN_HASHES: read, BENCHLEDGER_MCP_WRITE_TOKEN_HASHES: read })).toThrow(/unique/);
  });

  it("supports validated JSON token records and makes LAN HTTP cookies the default", () => {
    const hash = hashBearerToken("json-secret");
    const records = bearerTokensFromEnvironment({ BENCHLEDGER_BEARER_TOKENS_JSON: JSON.stringify([{ hash, scopes: ["write"], projectIds: ["project-1"] }]) });
    expect(records[0]).toMatchObject({ hash, projectIds: new Set(["project-1"]) });
    expect(records[0]?.scopes).toEqual(new Set(["read", "write"]));
    expect(secureCookiesFromEnvironment({})).toBe(false);
    expect(secureCookiesFromEnvironment({ BENCHLEDGER_SECURE_COOKIES: "true" })).toBe(true);
    expect(() => secureCookiesFromEnvironment({ BENCHLEDGER_SECURE_COOKIES: "yes" })).toThrow(/exactly true or false/);
  });

  it("accepts all digest environment aliases and rejects malformed token records", () => {
    const read = hashBearerToken("read-one");
    const readTwo = hashBearerToken("read-two");
    const write = hashBearerToken("write-one");
    const admin = hashBearerToken("admin-one");
    const records = bearerTokensFromEnvironment({
      BENCHLEDGER_MCP_READ_TOKEN_SHA256: `${read}, ${readTwo}`,
      BENCHLEDGER_MCP_WRITE_TOKEN_SHA256: write,
      BENCHLEDGER_MCP_ADMIN_TOKEN_HASHES: admin,
    });
    expect(records).toHaveLength(4);
    expect(records[2]?.scopes).toEqual(new Set(["read", "write"]));
    expect(records[3]?.scopes).toEqual(new Set(["admin"]));
    expect(() => bearerTokensFromEnvironment({ BENCHLEDGER_MCP_READ_TOKEN_HASHES: "" })).toThrow(/must not be empty/u);
    expect(() => bearerTokensFromEnvironment({ BENCHLEDGER_MCP_READ_TOKEN_HASHES: `${read},` })).toThrow(/empty token/u);
    expect(() => bearerTokensFromEnvironment({ BENCHLEDGER_BEARER_TOKENS_JSON: "not-json" })).toThrow(/JSON array/u);
    expect(() => bearerTokensFromEnvironment({ BENCHLEDGER_BEARER_TOKENS_JSON: "{}" })).toThrow(/JSON array/u);
    for (const value of [
      null,
      [],
      { hash: read, sha256: read },
      { hash: read, extra: true, scopes: ["read"] },
      { hash: read, scopes: [] },
      { hash: read, scopes: ["unknown"] },
      { hash: read, scopes: ["read"], projectIds: ["bad/id"] },
      { hash: read, scopes: ["read"], projectIds: "project-1" },
      { hash: read, scopes: ["read"], expiresAt: 0 },
      { hash: read, scopes: ["read"], expiresAt: 1.5 },
    ]) {
      expect(() => bearerTokensFromEnvironment({ BENCHLEDGER_BEARER_TOKENS_JSON: JSON.stringify([value]) })).toThrow();
    }
    expect(bearerTokensFromEnvironment({ BENCHLEDGER_BEARER_TOKENS_JSON: JSON.stringify([{ sha256: read, scopes: ["admin"], expiresAt: 1 }]) })[0]).toMatchObject({ hash: read, expiresAt: 1 });
  });

  it("fails closed for unknown password formats and enforces the bootstrap hash boundary", async () => {
    await expect(hashAdminPassword("short")).rejects.toThrow(/12 characters/u);
    const unknown = new AuthManager({ sessionSecret: "s".repeat(48), adminPasswordHash: "plaintext-password" });
    await expect(unknown.verifyPassword("plaintext-password")).resolves.toBe(false);
    const malformedScrypt = new AuthManager({ sessionSecret: "s".repeat(48), adminPasswordHash: "scrypt$1$1$1$salt$hash" });
    await expect(malformedScrypt.verifyPassword("anything")).resolves.toBe(false);
    expect(() => new AuthManager({ sessionSecret: "too-short" })).toThrow(/32 characters/u);
  });

  it("issues and clears signed sessions and rejects malformed or expired session cookies", () => {
    const secret = "s".repeat(48);
    const auth = new AuthManager({ sessionSecret: secret, sessionTtlSeconds: 1 });
    const reply = { setCookie: vi.fn(), clearCookie: vi.fn() };
    const session = auth.issueSession(reply as never, "operator");
    expect(session.csrf).toEqual(expect.any(String));
    expect(reply.setCookie).toHaveBeenCalledTimes(2);
    expect(reply.setCookie.mock.calls[0]?.[2]).toMatchObject({ httpOnly: true, secure: true, maxAge: 300 });
    const sessionCookie = reply.setCookie.mock.calls[0]?.[1] as string;
    const csrfCookie = reply.setCookie.mock.calls[1]?.[1] as string;
    const request = { headers: {}, cookies: { forge_session: sessionCookie, forge_csrf: csrfCookie }, method: "GET" } as never;
    expect(auth.authenticate(request)).toMatchObject({ actor: "operator", source: "ui", via: "session" });
    auth.clearSession(reply as never);
    expect(reply.clearCookie).toHaveBeenCalledTimes(2);

    const invalid = [
      "bad",
      "v2.one.two",
      "v1..signature",
      "v1.body.",
      encodedSession(secret, { actor: "operator", issuedAt: Date.now(), expiresAt: Date.now() - 1, csrf: "csrf" }),
      encodedSession(secret, { actor: "operator", issuedAt: Date.now(), expiresAt: Date.now() + 10_000 }),
      encodedSession(secret, { actor: "operator", issuedAt: Date.now(), expiresAt: Date.now() + 10_000, csrf: "csrf" }).replace(/.$/u, "x"),
    ];
    for (const value of invalid) expect(auth.authenticate({ headers: {}, cookies: { forge_session: value }, method: "GET" } as never)).toBeNull();
  });

  it("normalizes bearer authentication, scope checks, and CSRF methods", () => {
    const secret = "s".repeat(48);
    const validToken = "valid-bearer-token";
    const expiredToken = "expired-bearer-token";
    const auth = new AuthManager({
      sessionSecret: secret,
      bearerTokens: [
        { hash: hashBearerToken(validToken), scopes: new Set(["write"]) },
        { hash: hashBearerToken(expiredToken), scopes: new Set(["read"]), expiresAt: Date.now() },
      ],
    });
    expect(auth.authenticate({ headers: { authorization: `Bearer ${validToken}` }, cookies: {} } as never)).toMatchObject({ scopes: new Set(["read", "write"]), via: "bearer" });
    expect(auth.authenticate({ headers: { authorization: `Bearer ${expiredToken}` }, cookies: {} } as never)).toBeNull();
    expect(auth.authenticate({ headers: { authorization: "Bearer " + "x".repeat(4097) }, cookies: {} } as never)).toBeNull();
    expect(auth.authenticate({ headers: { authorization: "Bearer " }, cookies: {} } as never)).toBeNull();
    expect(auth.authenticate({ headers: { authorization: "Basic abc" }, cookies: {} } as never)).toBeNull();
    expect(auth.hasScope({ actor: "admin", source: "mcp", scopes: new Set(["admin"]), via: "bearer" }, "write")).toBe(true);
    expect(auth.hasScope({ actor: "read", source: "mcp", scopes: new Set(["read"]), via: "bearer" }, "read")).toBe(true);
    expect(auth.hasScope({ actor: "read", source: "mcp", scopes: new Set(["read"]), via: "bearer" }, "write")).toBe(false);
    expect(auth.hasScope({ actor: "write", source: "mcp", scopes: new Set(["write"]), via: "bearer" }, "read")).toBe(true);

    const reply = { setCookie: vi.fn() };
    const session = new AuthManager({ sessionSecret: secret, secureCookies: false });
    const issued = session.issueSession(reply as never);
    const sessionCookie = reply.setCookie.mock.calls[0]?.[1] as string;
    const csrfCookie = reply.setCookie.mock.calls[1]?.[1] as string;
    const principal = { actor: "admin", source: "ui" as const, scopes: new Set(["read", "write"] as const), via: "session" as const };
    expect(session.csrfValid({ method: "GET", cookies: {} } as never, principal)).toBe(true);
    expect(session.csrfValid({ method: "HEAD", cookies: {} } as never, principal)).toBe(true);
    expect(session.csrfValid({ method: "OPTIONS", cookies: {} } as never, principal)).toBe(true);
    expect(session.csrfValid({ method: "POST", cookies: { forge_session: sessionCookie, forge_csrf: csrfCookie }, headers: { "x-csrf-token": [issued.csrf] } } as never, principal)).toBe(true);
    expect(session.csrfValid({ method: "POST", cookies: {} as Record<string, string>, headers: {} } as never, principal)).toBe(false);
    expect(session.csrfValid({ method: "POST", cookies: { forge_session: sessionCookie, forge_csrf: "wrong" }, headers: { "x-csrf-token": issued.csrf } } as never, principal)).toBe(false);
    expect(session.csrfValid({ method: "POST", cookies: { forge_session: sessionCookie, forge_csrf: csrfCookie }, headers: { "x-csrf-token": "wrong" } } as never, principal)).toBe(false);
    expect(session.csrfValid({ method: "POST", cookies: {}, headers: {} } as never, { ...principal, via: "bearer" })).toBe(true);
  });

  it("attributes bearer principals by stable non-secret labels and separates unlabeled tokens", () => {
    const secret = "s".repeat(48);
    const firstToken = "first-bearer-token";
    const secondToken = "second-bearer-token";
    const labeledAuth = new AuthManager({
      sessionSecret: secret,
      bearerTokens: [
        { hash: hashBearerToken(firstToken), scopes: new Set(["read"]), label: "cad-agent" },
        { hash: hashBearerToken(secondToken), scopes: new Set(["write"]), label: "inventory-agent" }
      ]
    });
    const first = labeledAuth.authenticate({ headers: { authorization: `Bearer ${firstToken}` }, cookies: {} } as never);
    const second = labeledAuth.authenticate({ headers: { authorization: `Bearer ${secondToken}` }, cookies: {} } as never);
    expect(first).toMatchObject({ actor: "mcp-token:cad-agent", source: "mcp", via: "bearer" });
    expect(second).toMatchObject({ actor: "mcp-token:inventory-agent", source: "mcp", via: "bearer" });
    expect(first?.actor).not.toContain(firstToken);
    expect(second?.actor).not.toContain(secondToken);

    const firstHash = hashBearerToken(firstToken);
    const secondHash = hashBearerToken(secondToken);
    const unlabeledRecords: readonly BearerTokenRecord[] = [
      { hash: firstHash, scopes: new Set(["read"]) },
      { hash: secondHash, scopes: new Set(["read"]) }
    ];
    const unlabeledAuth = new AuthManager({ sessionSecret: secret, bearerTokens: unlabeledRecords });
    const unlabeledFirst = unlabeledAuth.authenticate({ headers: { authorization: `Bearer ${firstToken}` }, cookies: {} } as never);
    const unlabeledSecond = unlabeledAuth.authenticate({ headers: { authorization: `Bearer ${secondToken}` }, cookies: {} } as never);
    expect(unlabeledFirst?.actor).toBeTruthy();
    expect(unlabeledSecond?.actor).toBeTruthy();
    expect(unlabeledFirst?.actor).not.toBe(unlabeledSecond?.actor);
    expect(unlabeledFirst?.actor).not.toContain(firstToken);
    expect(unlabeledSecond?.actor).not.toContain(secondToken);
    expect(unlabeledFirst?.actor).not.toContain(firstHash);
    expect(unlabeledSecond?.actor).not.toContain(secondHash);

    const sameLabel: readonly BearerTokenRecord[] = [
      { hash: firstHash, scopes: new Set(["read"]), label: "same-agent" },
      { hash: secondHash, scopes: new Set(["read"]), label: "same-agent" }
    ];
    expect(() => new AuthManager({ sessionSecret: secret, bearerTokens: sameLabel })).toThrow(/unique/u);
    expect(bearerTokensFromEnvironment({ BENCHLEDGER_BEARER_TOKENS_JSON: JSON.stringify([{ hash: firstHash, scopes: ["read"], label: "json-agent" }]) })[0]).toMatchObject({ label: "json-agent" });
  });
});
