import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { WorkspaceSecurityPort, WorkspaceSecurityStatus } from "@benchledger/application";
import { workspaceSecurityStatus, type WorkspaceSecurityRecord } from "@benchledger/domain";
import { WorkspaceSecurityConflict, WorkspaceSecurityRepository } from "@benchledger/database";
import type { BenchDatabase } from "@benchledger/database";
import { RuntimeConflict } from "./persistence.js";

export interface WorkspacePasswordVerifier {
  (password: string, encodedPasswordHash: string): Promise<boolean>;
}

export interface WorkspacePasswordHasher {
  (password: string): Promise<string>;
}

export class WorkspaceSecurityAuthenticationError extends Error {
  constructor(message = "Current workspace password is invalid") {
    super(message);
    this.name = "WorkspaceSecurityAuthenticationError";
  }
}

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 512;
const MAX_SCRYPT_MEMORY = 1_048_576;
const MAX_ARGON_MEMORY = 1_048_576;
const MAX_ARGON_TIME = 100;
const MAX_ARGON_PARALLELISM = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const BASE64 = /^[A-Za-z0-9+/=_-]+$/u;

function hashBytes(password: string, salt: string, n: number, r: number, p: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, { N: n, r, p }, (error, key) => error ? reject(error) : resolve(key));
  });
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function parseScryptHash(encoded: string): { readonly n: number; readonly r: number; readonly p: number; readonly salt: string; readonly expected: Buffer } | null {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, nText, rText, pText, salt, encodedExpected] = parts;
  if (nText === undefined || rText === undefined || pText === undefined || salt === undefined || encodedExpected === undefined) return null;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isSafeInteger(n) || !isPowerOfTwo(n) || n < 16_384 || n > MAX_SCRYPT_MEMORY) return null;
  if (!Number.isSafeInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isSafeInteger(p) || p < 1 || p > 8) return null;
  if (salt.length < 8 || salt.length > 128 || !BASE64URL.test(salt)) return null;
  if (encodedExpected.length < 22 || encodedExpected.length > 172 || !BASE64URL.test(encodedExpected)) return null;
  const expected = Buffer.from(encodedExpected, "base64url");
  if (expected.length < 16 || expected.length > 128) return null;
  return { n, r, p, salt, expected };
}

function isValidScryptHash(encoded: string): boolean {
  return parseScryptHash(encoded) !== null;
}

function isValidArgonHash(encoded: string): boolean {
  const match = /^\$(argon2id|argon2i|argon2d)\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/u.exec(encoded);
  if (match === null) return false;
  const [, , memoryText, timeText, parallelismText, salt, hash] = match;
  if (memoryText === undefined || timeText === undefined || parallelismText === undefined || salt === undefined || hash === undefined) return false;
  const memory = Number(memoryText);
  const time = Number(timeText);
  const parallelism = Number(parallelismText);
  return Number.isSafeInteger(memory) && memory >= 8 && memory <= MAX_ARGON_MEMORY
    && Number.isSafeInteger(time) && time >= 1 && time <= MAX_ARGON_TIME
    && Number.isSafeInteger(parallelism) && parallelism >= 1 && parallelism <= MAX_ARGON_PARALLELISM
    && salt.length >= 4 && salt.length <= 256 && BASE64.test(salt)
    && hash.length >= 4 && hash.length <= 256 && BASE64.test(hash);
}

function validateBootstrapHash(encoded: string, argonVerifierInjected: boolean): void {
  if (isValidScryptHash(encoded)) return;
  if (argonVerifierInjected && isValidArgonHash(encoded)) return;
  throw new Error("Workspace security bootstrap password hash is invalid");
}

async function verifyScrypt(password: string, encoded: string): Promise<boolean> {
  const parsed = parseScryptHash(encoded);
  if (parsed === null) return false;
  try {
    const actual = await hashBytes(password, parsed.salt, parsed.n, parsed.r, parsed.p, parsed.expected.length);
    return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
  } catch {
    return false;
  }
}

function defaultVerifier(password: string, encoded: string): Promise<boolean> {
  return verifyScrypt(password, encoded);
}

function cloneRecord(record: WorkspaceSecurityRecord): WorkspaceSecurityRecord {
  return { ...record };
}

function status(record: WorkspaceSecurityRecord): WorkspaceSecurityStatus {
  return workspaceSecurityStatus(record);
}

function runtimeConflict(error: unknown): never {
  if (error instanceof WorkspaceSecurityConflict) throw new RuntimeConflict(error.message, error.details);
  throw new Error("Workspace password operation failed");
}

async function verifyCandidate(verifier: WorkspacePasswordVerifier, password: string, encodedPasswordHash: string): Promise<boolean> {
  try {
    return await verifier(password, encodedPasswordHash);
  } catch {
    return false;
  }
}

async function hashCandidate(hasher: WorkspacePasswordHasher, password: string): Promise<string> {
  try {
    const encodedPasswordHash = await hasher(password);
    if (typeof encodedPasswordHash === "string" && encodedPasswordHash.length > 0 && encodedPasswordHash.length <= 4096) return encodedPasswordHash;
  } catch {
    // Do not allow an injected hasher error to expose a credential.
  }
  throw new Error("Workspace password operation failed");
}

function assertPassword(password: string, label: "Current" | "New"): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`${label} workspace password is invalid`);
  }
}

function assertExpectedVersion(record: WorkspaceSecurityRecord | null, expectedVersion: number | undefined): WorkspaceSecurityRecord {
  if (record === null) throw new Error("Workspace security has not been initialized");
  if (expectedVersion !== undefined && record.version !== expectedVersion) {
    throw new RuntimeConflict("Workspace security changed since it was read", { expectedVersion, actualVersion: record.version });
  }
  return record;
}

/** SQLite-backed workspace access adapter. Credential records remain inside
 * the runtime/database boundary and are never returned by the port. */
export class ProductionWorkspaceSecurityAdapter implements WorkspaceSecurityPort {
  private readonly externalVerify: WorkspacePasswordVerifier | undefined;
  private readonly hash: WorkspacePasswordHasher;
  private readonly argonVerifierInjected: boolean;

  constructor(
    private readonly repository: WorkspaceSecurityRepository,
    verifier?: WorkspacePasswordVerifier,
    hasher: WorkspacePasswordHasher = hashWorkspacePassword,
  ) {
    this.externalVerify = verifier;
    this.hash = hasher;
    this.argonVerifierInjected = verifier !== undefined;
  }

  /** Initialize only when the durable singleton does not already exist. */
  initialize(bootstrapHash: string | undefined): WorkspaceSecurityStatus {
    const existing = this.repository.get();
    if (existing !== null) return status(existing);
    if (bootstrapHash !== undefined && bootstrapHash.length > 0) {
      validateBootstrapHash(bootstrapHash, this.argonVerifierInjected);
    }
    return status(this.repository.ensureInitialized(bootstrapHash));
  }

  async getStatus(): Promise<WorkspaceSecurityStatus> {
    return status(assertExpectedVersion(this.repository.get(), undefined));
  }

  async verifyPassword(password: string): Promise<boolean> {
    const record = this.repository.get();
    if (record === null || record.mode !== "password" || record.encodedPasswordHash === null) return false;
    return this.verifyStoredPassword(password, record.encodedPasswordHash);
  }

  private async verifyStoredPassword(password: string, encodedPasswordHash: string): Promise<boolean> {
    if (isValidScryptHash(encodedPasswordHash)) return verifyScrypt(password, encodedPasswordHash);
    if (this.externalVerify !== undefined && isValidArgonHash(encodedPasswordHash)) {
      return verifyCandidate(this.externalVerify, password, encodedPasswordHash);
    }
    return false;
  }

  async enablePassword(newPassword: string, expectedVersion: number | undefined): Promise<WorkspaceSecurityStatus> {
    assertPassword(newPassword, "New");
    const current = assertExpectedVersion(this.repository.get(), expectedVersion);
    try {
      const encodedPasswordHash = await hashCandidate(this.hash, newPassword);
      return status(this.repository.update("password", encodedPasswordHash, current.version));
    } catch (error: unknown) {
      return runtimeConflict(error);
    }
  }

  async disablePassword(currentPassword: string, expectedVersion: number | undefined): Promise<WorkspaceSecurityStatus> {
    assertPassword(currentPassword, "Current");
    const current = assertExpectedVersion(this.repository.get(), expectedVersion);
    if (current.mode !== "password" || current.encodedPasswordHash === null || !await this.verifyStoredPassword(currentPassword, current.encodedPasswordHash)) {
      throw new WorkspaceSecurityAuthenticationError();
    }
    try {
      return status(this.repository.update("lan_open", null, current.version));
    } catch (error: unknown) {
      return runtimeConflict(error);
    }
  }

  async changePassword(input: { readonly currentPassword: string; readonly newPassword: string }, expectedVersion: number | undefined): Promise<WorkspaceSecurityStatus> {
    assertPassword(input.currentPassword, "Current");
    assertPassword(input.newPassword, "New");
    const current = assertExpectedVersion(this.repository.get(), expectedVersion);
    if (current.mode !== "password" || current.encodedPasswordHash === null || !await this.verifyStoredPassword(input.currentPassword, current.encodedPasswordHash)) {
      throw new WorkspaceSecurityAuthenticationError();
    }
    try {
      // Verify first so an incorrect current credential never incurs the
      // replacement hash cost. Application idempotency runs before this.
      const encodedPasswordHash = await hashCandidate(this.hash, input.newPassword);
      return status(this.repository.update("password", encodedPasswordHash, current.version));
    } catch (error: unknown) {
      return runtimeConflict(error);
    }
  }
}

export interface MemoryWorkspaceSecurityOptions {
  readonly bootstrapHash?: string;
  readonly verifier?: WorkspacePasswordVerifier;
  readonly hasher?: WorkspacePasswordHasher;
}

/** Small dependency-free implementation used by demo/test hosts. */
export class MemoryWorkspaceSecurity implements WorkspaceSecurityPort {
  private record: WorkspaceSecurityRecord;
  private readonly verify: WorkspacePasswordVerifier;
  private readonly hash: WorkspacePasswordHasher;

  constructor(options: MemoryWorkspaceSecurityOptions = {}) {
    const encodedPasswordHash = options.bootstrapHash === undefined || options.bootstrapHash.length === 0 ? null : options.bootstrapHash;
    if (encodedPasswordHash !== null) validateBootstrapHash(encodedPasswordHash, options.verifier !== undefined);
    const now = new Date().toISOString();
    this.record = {
      mode: encodedPasswordHash === null ? "lan_open" : "password",
      encodedPasswordHash,
      version: 1,
      credentialRevision: 1,
      updatedAt: now,
    };
    this.verify = options.verifier ?? defaultVerifier;
    this.hash = options.hasher ?? hashWorkspacePassword;
  }

  async getStatus(): Promise<WorkspaceSecurityStatus> { return status(cloneRecord(this.record)); }

  async verifyPassword(password: string): Promise<boolean> {
    if (this.record.mode !== "password" || this.record.encodedPasswordHash === null) return false;
    return this.verifyStoredPassword(password, this.record.encodedPasswordHash);
  }

  private async verifyStoredPassword(password: string, encodedPasswordHash: string): Promise<boolean> {
    if (isValidScryptHash(encodedPasswordHash)) return verifyScrypt(password, encodedPasswordHash);
    if (isValidArgonHash(encodedPasswordHash)) return verifyCandidate(this.verify, password, encodedPasswordHash);
    return false;
  }

  private update(mode: "lan_open" | "password", encodedPasswordHash: string | null, expectedVersion: number | undefined): WorkspaceSecurityStatus {
    assertExpectedVersion(this.record, expectedVersion);
    const now = new Date().toISOString();
    this.record = { mode, encodedPasswordHash, version: this.record.version + 1, credentialRevision: this.record.credentialRevision + 1, updatedAt: now };
    return status(cloneRecord(this.record));
  }

  async enablePassword(newPassword: string, expectedVersion: number | undefined): Promise<WorkspaceSecurityStatus> {
    assertPassword(newPassword, "New");
    const current = assertExpectedVersion(this.record, expectedVersion);
    const encodedPasswordHash = await hashCandidate(this.hash, newPassword);
    return this.update("password", encodedPasswordHash, current.version);
  }

  async disablePassword(currentPassword: string, expectedVersion: number | undefined): Promise<WorkspaceSecurityStatus> {
    assertPassword(currentPassword, "Current");
    const current = assertExpectedVersion(this.record, expectedVersion);
    if (current.mode !== "password" || current.encodedPasswordHash === null || !await this.verifyStoredPassword(currentPassword, current.encodedPasswordHash)) {
      throw new WorkspaceSecurityAuthenticationError();
    }
    return this.update("lan_open", null, current.version);
  }

  async changePassword(input: { readonly currentPassword: string; readonly newPassword: string }, expectedVersion: number | undefined): Promise<WorkspaceSecurityStatus> {
    assertPassword(input.currentPassword, "Current");
    assertPassword(input.newPassword, "New");
    const current = assertExpectedVersion(this.record, expectedVersion);
    if (current.mode !== "password" || current.encodedPasswordHash === null || !await this.verifyStoredPassword(input.currentPassword, current.encodedPasswordHash)) {
      throw new WorkspaceSecurityAuthenticationError();
    }
    const encodedPasswordHash = await hashCandidate(this.hash, input.newPassword);
    return this.update("password", encodedPasswordHash, current.version);
  }
}

/** Keep the database dependency in the production composition root. */
export function createProductionWorkspaceSecurityAdapter(database: BenchDatabase, verifier?: WorkspacePasswordVerifier, hasher?: WorkspacePasswordHasher): ProductionWorkspaceSecurityAdapter {
  return new ProductionWorkspaceSecurityAdapter(new WorkspaceSecurityRepository(database), verifier, hasher);
}

/** Generate the dependency-free local scrypt format accepted by the adapter. */
export async function hashWorkspacePassword(password: string): Promise<string> {
  assertPassword(password, "New");
  const salt = randomBytes(16).toString("base64url");
  const derived = await hashBytes(password, salt, 16_384, 8, 1, 32);
  return `scrypt$16384$8$1$${salt}$${derived.toString("base64url")}`;
}
