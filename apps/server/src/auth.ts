import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export type AuthScope = "read" | "write" | "admin";

export interface BearerTokenRecord {
  readonly hash: string;
  readonly scopes: ReadonlySet<AuthScope>;
  /** Stable operator-facing name; never put the plaintext token here. */
  readonly label?: string;
  readonly projectIds?: ReadonlySet<string>;
  readonly expiresAt?: number;
}

export interface AuthConfig {
  readonly sessionSecret: string;
  readonly adminPasswordHash?: string;
  /** Optional Argon2id adapter supplied by the host/runtime. */
  readonly passwordVerifier?: (password: string, encodedHash: string) => Promise<boolean>;
  readonly demo?: boolean;
  readonly demoPassword?: string;
  readonly bearerTokens?: readonly BearerTokenRecord[];
  readonly secureCookies?: boolean;
  readonly sessionTtlSeconds?: number;
}

const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const TOKEN_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const TOKEN_SCOPE_NAMES = new Set<AuthScope>(["read", "write", "admin"]);

/**
 * A write credential is also a read credential. Keeping the implied scope in
 * the record (rather than relying on each caller to remember the rule) makes
 * environment and JSON-backed token configuration behave identically.
 * Admin remains a distinct least-privilege scope and is expanded only by
 * `hasScope`/the MCP host when it is actually needed.
 */
function scopesWithImpliedRead(scopes: Iterable<AuthScope>): ReadonlySet<AuthScope> {
  const normalized = new Set<AuthScope>(scopes);
  if (normalized.has("write")) normalized.add("read");
  return normalized;
}

function tokenHash(value: unknown, source: string): string {
  if (typeof value !== "string" || !TOKEN_HASH_PATTERN.test(value)) {
    throw new Error(`${source} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function tokenLabel(value: unknown, source: string): string {
  if (typeof value !== "string" || !TOKEN_LABEL_PATTERN.test(value)) {
    throw new Error(`${source} must be a non-empty identifier using letters, numbers, dot, underscore, colon, or hyphen`);
  }
  return value;
}

function tokenHashList(raw: string, source: string): readonly string[] {
  if (raw.trim().length === 0) throw new Error(`${source} must not be empty`);
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => value.length === 0)) throw new Error(`${source} contains an empty token digest`);
  return values.map((value, index) => tokenHash(value, `${source}[${index}]`));
}

function readTokenHashEnvironment(env: NodeJS.ProcessEnv, scope: AuthScope): readonly string[] {
  const prefix = `BENCHLEDGER_MCP_${scope.toUpperCase()}_TOKEN`;
  const names = [`${prefix}_HASHES`, `${prefix}_SHA256`];
  return names.flatMap((name) => env[name] === undefined ? [] : tokenHashList(env[name]!, name));
}

function parsedTokenRecord(value: unknown, index: number): BearerTokenRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`BENCHLEDGER_BEARER_TOKENS_JSON[${index}] must be an object`);
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["hash", "sha256", "scopes", "label", "projectIds", "expiresAt"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key)) || (record.hash !== undefined && record.sha256 !== undefined)) throw new Error(`BENCHLEDGER_BEARER_TOKENS_JSON[${index}] has unsupported fields`);
  const hashValue = record.hash ?? record.sha256;
  const hash = tokenHash(hashValue, `BENCHLEDGER_BEARER_TOKENS_JSON[${index}].hash`);
  const label = record.label === undefined ? undefined : tokenLabel(record.label, `BENCHLEDGER_BEARER_TOKENS_JSON[${index}].label`);
  if (!Array.isArray(record.scopes) || record.scopes.length === 0 || record.scopes.some((scope) => typeof scope !== "string" || !TOKEN_SCOPE_NAMES.has(scope as AuthScope))) {
    throw new Error(`BENCHLEDGER_BEARER_TOKENS_JSON[${index}].scopes is invalid`);
  }
  const scopes = scopesWithImpliedRead(record.scopes as AuthScope[]);
  const projectIds = record.projectIds;
  if (projectIds !== undefined && (!Array.isArray(projectIds) || projectIds.some((projectId) => typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)))) {
    throw new Error(`BENCHLEDGER_BEARER_TOKENS_JSON[${index}].projectIds is invalid`);
  }
  const expiresAt = record.expiresAt;
  if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || (expiresAt as number) <= 0)) {
    throw new Error(`BENCHLEDGER_BEARER_TOKENS_JSON[${index}].expiresAt is invalid`);
  }
  return {
    hash,
    scopes,
    ...(label === undefined ? {} : { label }),
    ...(projectIds === undefined ? {} : { projectIds: new Set(projectIds as string[]) }),
    ...(expiresAt === undefined ? {} : { expiresAt: expiresAt as number })
  };
}

/**
 * Load only SHA-256 digests from deployment environment configuration. The
 * plaintext bearer tokens remain with the agent/client secret store and are
 * never accepted, persisted, or logged by the server.
 */
export function bearerTokensFromEnvironment(env: NodeJS.ProcessEnv = process.env): readonly BearerTokenRecord[] {
  const records: BearerTokenRecord[] = [];
  for (const scope of ["read", "write", "admin"] as const) {
    for (const hash of readTokenHashEnvironment(env, scope)) records.push({ hash, scopes: scopesWithImpliedRead([scope]) });
  }
  const json = env.BENCHLEDGER_BEARER_TOKENS_JSON;
  if (json !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(json) as unknown; } catch { throw new Error("BENCHLEDGER_BEARER_TOKENS_JSON must contain a JSON array"); }
    if (!Array.isArray(parsed)) throw new Error("BENCHLEDGER_BEARER_TOKENS_JSON must contain a JSON array");
    records.push(...parsed.map(parsedTokenRecord));
  }
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.hash)) throw new Error("Bearer token digests must be unique across configured scopes");
    seen.add(record.hash);
  }
  return records;
}

/**
 * LAN deployments are HTTP by default. Set BENCHLEDGER_SECURE_COOKIES=true
 * only when TLS terminates in front of the app and forwards HTTPS requests.
 */
export function secureCookiesFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.BENCHLEDGER_SECURE_COOKIES;
  if (raw === undefined || raw.trim() === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error("BENCHLEDGER_SECURE_COOKIES must be exactly true or false");
}

export interface Principal {
  readonly actor: string;
  readonly source: "ui" | "api" | "mcp";
  readonly scopes: ReadonlySet<AuthScope>;
  readonly projectIds?: ReadonlySet<string>;
  readonly via: "session" | "bearer";
}

interface SessionPayload {
  readonly actor: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly csrf: string;
}

const SESSION_COOKIE = "forge_session";
const CSRF_COOKIE = "forge_csrf";
const SESSION_VERSION = "v1";

/**
 * Derive a stable pseudonymous actor from the configured digest when no
 * operator label is supplied. Hashing the already-hashed token keeps the
 * plaintext and the configured SHA-256 digest out of audit/idempotency keys,
 * while the full digest makes accidental actor collisions impractical.
 */
function bearerActor(record: BearerTokenRecord): string {
  const label = record.label ?? `token-${digest(`benchledger:bearer-actor:${record.hash}`)}`;
  return `mcp-token:${label}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encodeSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`${SESSION_VERSION}.${body}`).digest("base64url");
  return `${SESSION_VERSION}.${body}.${signature}`;
}

function decodeSession(value: string, secret: string): SessionPayload | null {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return null;
  const body = parts[1];
  const signature = parts[2];
  if (!body || !signature) return null;
  const expected = createHmac("sha256", secret).update(`${SESSION_VERSION}.${body}`).digest("base64url");
  if (!safeEqualText(signature, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (typeof parsed.actor !== "string" || typeof parsed.issuedAt !== "number" || typeof parsed.expiresAt !== "number" || typeof parsed.csrf !== "string") return null;
    if (parsed.expiresAt <= Date.now()) return null;
    return { actor: parsed.actor, issuedAt: parsed.issuedAt, expiresAt: parsed.expiresAt, csrf: parsed.csrf };
  } catch {
    return null;
  }
}

/**
 * Hash a bearer token before putting it in an environment-backed configuration.
 * The plaintext token is intentionally never stored by the server.
 */
export function hashBearerToken(token: string): string {
  return digest(token);
}

/**
 * Create a password hash for the built-in verifier. Deployments should prefer an
 * Argon2id hash from a password manager; the verifier rejects unknown formats.
 * `scrypt` is provided using Node's standard library for a dependency-free local
 * bootstrap and has a deliberately expensive work factor.
 */
export async function hashAdminPassword(password: string): Promise<string> {
  if (!password || password.length < 12) throw new Error("Admin password must contain at least 12 characters");
  const { scrypt } = await import("node:crypto");
  const salt = randomBytes(16).toString("base64url");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key));
  });
  return `scrypt$16384$8$1$${salt}$${derived.toString("base64url")}`;
}

async function verifyScrypt(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nText, rText, pText, salt, expectedText] = parts;
  const n = Number(nText); const r = Number(rText); const p = Number(pText);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 16384 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 8 || !salt || !expectedText) return false;
  const expected = Buffer.from(expectedText, "base64url");
  const { scrypt } = await import("node:crypto");
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, expected.length, { N: n, r, p }, (error, key) => error ? reject(error) : resolve(key));
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class AuthManager {
  private readonly sessionTtlMs: number;
  private readonly bearerActors: ReadonlyMap<string, string>;

  constructor(private readonly config: AuthConfig) {
    if (!config.sessionSecret || config.sessionSecret.length < 32) throw new Error("sessionSecret must contain at least 32 characters");
    this.sessionTtlMs = Math.max(300, config.sessionTtlSeconds ?? 8 * 60 * 60) * 1000;
    const actors = new Map<string, string>();
    const hashes = new Set<string>();
    for (const [index, record] of (config.bearerTokens ?? []).entries()) {
      tokenHash(record.hash, `bearerTokens[${index}].hash`);
      if (hashes.has(record.hash)) throw new Error("Bearer token digests must be unique across configured tokens");
      hashes.add(record.hash);
      if (record.label !== undefined) tokenLabel(record.label, `bearerTokens[${index}].label`);
      const actor = bearerActor(record);
      if ([...actors.values()].includes(actor)) throw new Error("Bearer token actor labels must be unique across configured tokens");
      actors.set(record.hash, actor);
    }
    this.bearerActors = actors;
  }

  async verifyPassword(password: string): Promise<boolean> {
    if (this.config.demo && this.config.demoPassword && safeEqualText(password, this.config.demoPassword)) return true;
    if (!this.config.adminPasswordHash) return false;
    if (this.config.adminPasswordHash.startsWith("scrypt$")) return verifyScrypt(password, this.config.adminPasswordHash);
    if (this.config.adminPasswordHash.startsWith("$argon2id$") && this.config.passwordVerifier) {
      return this.config.passwordVerifier(password, this.config.adminPasswordHash);
    }
    // Argon2id is delegated to an instance adapter. Unknown hashes fail closed
    // rather than degrading to plaintext or a weak hash.
    return false;
  }

  issueSession(reply: FastifyReply, actor = "admin"): { readonly csrf: string; readonly expiresAt: number } {
    const now = Date.now();
    const csrf = randomBytes(24).toString("base64url");
    const payload: SessionPayload = { actor, issuedAt: now, expiresAt: now + this.sessionTtlMs, csrf };
    const value = encodeSession(payload, this.config.sessionSecret);
    const secure = this.config.secureCookies ?? true;
    reply.setCookie(SESSION_COOKIE, value, {
      httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: Math.floor(this.sessionTtlMs / 1000)
    });
    reply.setCookie(CSRF_COOKIE, csrf, {
      httpOnly: false, sameSite: "lax", secure, path: "/", maxAge: Math.floor(this.sessionTtlMs / 1000)
    });
    return { csrf, expiresAt: payload.expiresAt };
  }

  clearSession(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
  }

  authenticate(request: FastifyRequest): Principal | null {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith("Bearer ")) {
      const token = authorization.slice("Bearer ".length).trim();
      if (!token || token.length > 4096) return null;
      const hash = digest(token);
      const record = this.config.bearerTokens?.find((candidate) => safeEqualText(candidate.hash, hash));
      if (!record || (record.expiresAt !== undefined && record.expiresAt <= Date.now())) return null;
      const actor = this.bearerActors.get(record.hash);
      if (actor === undefined) return null;
      return { actor, source: "mcp", scopes: scopesWithImpliedRead(record.scopes), ...(record.projectIds ? { projectIds: record.projectIds } : {}), via: "bearer" };
    }
    const session = request.cookies?.[SESSION_COOKIE];
    if (!session) return null;
    const payload = decodeSession(session, this.config.sessionSecret);
    if (!payload) return null;
    return { actor: payload.actor, source: "ui", scopes: new Set<AuthScope>(["read", "write"]), via: "session" };
  }

  csrfValid(request: FastifyRequest, principal: Principal): boolean {
    if (principal.via === "bearer" || request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return true;
    const session = request.cookies?.[SESSION_COOKIE];
    if (!session) return false;
    const payload = decodeSession(session, this.config.sessionSecret);
    const header = request.headers["x-csrf-token"];
    const supplied = Array.isArray(header) ? header[0] : header;
    const csrfCookie = request.cookies?.[CSRF_COOKIE];
    return Boolean(payload && supplied && csrfCookie && safeEqualText(payload.csrf, supplied) && safeEqualText(payload.csrf, csrfCookie));
  }

  hasScope(principal: Principal, needed: AuthScope): boolean {
    return principal.scopes.has("admin") || principal.scopes.has(needed) || (needed === "read" && principal.scopes.has("write"));
  }
}

export { CSRF_COOKIE, SESSION_COOKIE };
