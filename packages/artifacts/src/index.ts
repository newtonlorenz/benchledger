import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile, link, copyFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

/**
 * Artifact bytes are intentionally opaque.  The store never tries to parse,
 * execute, decompress, or otherwise interpret a CAD, build, firmware, or
 * project file.
 */
export type ArtifactByteSource = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

export type ArtifactRole = string;

export type ArtifactErrorCode =
  | "INVALID_INPUT"
  | "PATH_UNSAFE"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UPLOAD_QUOTA_EXCEEDED"
  | "STORAGE_QUOTA_EXCEEDED"
  | "SIZE_MISMATCH"
  | "DIGEST_MISMATCH"
  | "UPLOAD_STATE"
  | "MANIFEST_IMMUTABLE"
  | "BUNDLE_INVALID"
  | "BUNDLE_EXISTS"
  | "CORRUPT"
  | "IO_ERROR";

export interface ArtifactError {
  readonly code: ArtifactErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ArtifactError };

export interface ArtifactStoreOptions {
  readonly root: string;
  readonly maxUploadBytes: number;
  readonly maxStorageBytes: number;
  /** Injectable wall clock in milliseconds, primarily for deterministic tests. */
  readonly clock?: () => number;
}

export interface BeginUploadInput {
  readonly projectId: string;
  readonly workItemId?: string | undefined;
  readonly revisionId?: string | undefined;
  readonly filename: string;
  readonly mediaType?: string | undefined;
  readonly role?: ArtifactRole | undefined;
  readonly description?: string | undefined;
  readonly source?: string | undefined;
  readonly expectedBytes?: number | undefined;
  readonly expectedSha256?: string | undefined;
  readonly artifactId?: string | undefined;
  readonly artifactRevisionId?: string | undefined;
}

export type UploadStatus = "open" | "finalized" | "expired" | "aborted";

export interface UploadSession {
  readonly sessionId: string;
  readonly status: UploadStatus;
  readonly projectId: string;
  readonly workItemId?: string | undefined;
  readonly revisionId?: string | undefined;
  readonly filename: string;
  readonly mediaType?: string | undefined;
  readonly role?: ArtifactRole | undefined;
  readonly description?: string | undefined;
  readonly source?: string | undefined;
  readonly expectedBytes?: number | undefined;
  readonly expectedSha256?: string | undefined;
  readonly artifactId: string;
  readonly artifactRevisionId: string;
  readonly bytesWritten: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
}

interface StoredUploadSession extends UploadSession {
  readonly version: 1;
}

export interface UploadProgress {
  readonly sessionId: string;
  readonly status: "open";
  readonly bytesWritten: number;
  readonly expectedBytes?: number | undefined;
  readonly remainingBytes?: number | undefined;
}

export interface ArtifactRevision {
  readonly version: 1;
  readonly artifactId: string;
  readonly artifactRevisionId: string;
  readonly projectId: string;
  readonly workItemId?: string | undefined;
  readonly revisionId?: string | undefined;
  readonly filename: string;
  readonly mediaType?: string | undefined;
  readonly role?: ArtifactRole | undefined;
  readonly description?: string | undefined;
  readonly source?: string | undefined;
  readonly bytes: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly projectPath?: string | undefined;
  readonly createdAt: string;
}

export interface StoredArtifact extends ArtifactRevision {
  readonly deduplicated: boolean;
}

export interface ArtifactBytes {
  readonly artifact: ArtifactRevision;
  readonly bytes: Buffer;
}

export interface ArtifactHash {
  readonly bytes: number;
  readonly sha256: string;
}

export interface StoreUsage {
  readonly uniqueBytes: number;
  readonly blobCount: number;
  readonly activeUploadBytes: number;
  readonly maxStorageBytes: number;
}

/** Result of compensating a filesystem finalization after its DB mutation failed. */
export interface FinalizationRollback {
  readonly sessionId: string;
  readonly artifactId: string;
  readonly artifactRevisionId: string;
  readonly artifactRecordRemoved: boolean;
  readonly blobRemoved: boolean;
  readonly projectionRemoved: boolean;
}

export interface RevisionManifestEntryInput {
  readonly artifactRevisionId: string;
  readonly filename?: string | undefined;
  readonly role?: ArtifactRole | undefined;
  readonly artifactId?: string | undefined;
  readonly mediaType?: string | undefined;
  readonly bytes?: number | undefined;
  readonly sha256?: string | undefined;
  readonly storageKey?: string | undefined;
}

export interface RevisionManifestEntry {
  readonly artifactRevisionId: string;
  readonly artifactId: string;
  readonly filename: string;
  readonly role?: ArtifactRole | undefined;
  readonly mediaType?: string | undefined;
  readonly bytes: number;
  readonly sha256: string;
  readonly storageKey: string;
}

export interface RevisionManifestInput {
  readonly projectId: string;
  readonly workItemId?: string | undefined;
  readonly revisionId: string;
  readonly entries: readonly RevisionManifestEntryInput[];
  readonly frozenAt?: string | undefined;
}

export interface RevisionManifest {
  readonly version: 1;
  readonly projectId: string;
  readonly workItemId?: string | undefined;
  readonly revisionId: string;
  readonly frozenAt: string;
  readonly entries: readonly RevisionManifestEntry[];
}

export interface CreatedRevisionManifest {
  readonly manifest: RevisionManifest;
  readonly canonicalJson: string;
  readonly sha256: string;
}

export interface FreezeRevisionInput extends RevisionManifestInput {}

export interface ExpireOrphanOptions {
  readonly olderThanMs: number;
  readonly now?: Date | undefined;
}

export interface ExpireOrphanResult {
  readonly expiredSessionIds: readonly string[];
  readonly reclaimedBytes: number;
}

export interface ExportRevisionBundleInput {
  readonly projectId: string;
  readonly workItemId?: string | undefined;
  readonly revisionId: string;
  readonly destination: string;
}

export interface PortableBundleFile {
  readonly artifactRevisionId: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PortableBundleManifest {
  readonly format: "benchledger-artifact-bundle";
  readonly version: 1;
  readonly exportedAt: string;
  readonly revisionManifest: RevisionManifest;
  readonly files: readonly PortableBundleFile[];
}

export interface ExportRevisionBundleResult {
  readonly bundlePath: string;
  readonly manifest: PortableBundleManifest;
  readonly sha256: string;
}

export interface RestoreRevisionBundleResult {
  readonly projectId: string;
  readonly workItemId?: string | undefined;
  readonly revisionId: string;
  readonly artifactRevisionIds: readonly string[];
}

interface RevisionManifestEnvelope {
  readonly manifest: RevisionManifest;
  readonly sha256: string;
}

interface StoredArtifactRecord extends ArtifactRevision {
  readonly version: 1;
}

interface FinalizationReceipt {
  readonly session: StoredUploadSession;
  readonly artifact: StoredArtifactRecord;
  readonly createdArtifactRecord: boolean;
  readonly createdBlob: boolean;
  readonly createdProjection: boolean;
}

interface StoredPortableBundleManifest extends PortableBundleManifest {}

class StoreFailure extends Error {
  public readonly code: ArtifactErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(code: ArtifactErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "StoreFailure";
    this.code = code;
    this.details = details;
  }
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TEXT_LENGTH = 8_192;
export const DEFAULT_UPLOAD_SESSION_TTL_MS = 15 * 60 * 1_000;
function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(error: StoreFailure): Result<T> {
  return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
}

function resultFrom<T>(action: () => Promise<T>): Promise<Result<T>> {
  return action().then(ok).catch((error: unknown) => {
    if (error instanceof StoreFailure) return fail<T>(error);
    const message = error instanceof Error ? error.message : "Artifact store operation failed";
    return fail<T>(new StoreFailure("IO_ERROR", message));
  });
}

function assertValidId(value: string, field: string): void {
  if (!ID_RE.test(value)) {
    throw new StoreFailure("INVALID_INPUT", `${field} must be a short, path-safe identifier`, { field });
  }
}

function optionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > MAX_TEXT_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new StoreFailure("INVALID_INPUT", `${field} is empty, too long, or contains control characters`, { field });
  }
  return value;
}

/** Return true only for one portable filename segment, never a path. */
export function isSafeFilename(value: string): boolean {
  try {
    safeFilename(value);
    return true;
  } catch {
    return false;
  }
}

/** Normalize and validate a filename before it enters a generated path. */
export function safeFilename(value: string): string {
  if (typeof value !== "string") throw new StoreFailure("PATH_UNSAFE", "filename must be text");
  const normalized = value.normalize("NFKC");
  if (
    normalized.length === 0 ||
    normalized.length > 255 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes(":") ||
    /[ .]$/u.test(normalized) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(normalized) ||
    normalized.includes("\u0000") ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    isAbsolute(normalized)
  ) {
    throw new StoreFailure("PATH_UNSAFE", "filename must be one safe path segment", { filename: value });
  }
  return normalized;
}

function safeSha256(value: string | undefined, field = "sha256"): string | undefined {
  if (value === undefined) return undefined;
  if (!SHA256_RE.test(value)) throw new StoreFailure("INVALID_INPUT", `${field} must be a lowercase SHA-256 digest`, { field });
  return value;
}

function validateByteCount(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StoreFailure("INVALID_INPUT", `${field} must be a non-negative safe integer`, { field });
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stream a source through SHA-256 while counting bytes; no source buffering. */
export async function artifactSha256(source: ArtifactByteSource | Readable): Promise<ArtifactHash> {
  const hash = createHash("sha256");
  let bytes = 0;
  if (source instanceof Uint8Array) {
    hash.update(source);
    bytes = source.byteLength;
  } else {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) throw new StoreFailure("INVALID_INPUT", "artifact stream yielded non-byte data");
      bytes += chunk.byteLength;
      if (!Number.isSafeInteger(bytes)) throw new StoreFailure("UPLOAD_QUOTA_EXCEEDED", "artifact is too large");
      hash.update(chunk);
    }
  }
  return { bytes, sha256: hash.digest("hex") };
}

function manifestForHash(manifest: RevisionManifest): CreatedRevisionManifest {
  const json = canonicalJson(manifest);
  return { manifest, canonicalJson: json, sha256: digestBytes(Buffer.from(json, "utf8")) };
}

/** Build a stable manifest payload and hash without touching the filesystem. */
export function createRevisionManifest(input: RevisionManifestInput): CreatedRevisionManifest {
  assertValidId(input.projectId, "projectId");
  assertValidId(input.revisionId, "revisionId");
  if (input.workItemId !== undefined) assertValidId(input.workItemId, "workItemId");
  if (!Array.isArray(input.entries)) throw new StoreFailure("INVALID_INPUT", "entries must be an array");
  const seen = new Set<string>();
  const entries = input.entries.map((entry) => {
    assertValidId(entry.artifactRevisionId, "artifactRevisionId");
    if (seen.has(entry.artifactRevisionId)) throw new StoreFailure("CONFLICT", "manifest contains a duplicate artifact revision", { artifactRevisionId: entry.artifactRevisionId });
    seen.add(entry.artifactRevisionId);
    const filename = entry.filename === undefined ? undefined : safeFilename(entry.filename);
    const role = optionalText(entry.role, "role");
    const artifactId = entry.artifactId === undefined ? undefined : (assertValidId(entry.artifactId, "artifactId"), entry.artifactId);
    const mediaType = optionalText(entry.mediaType, "mediaType");
    const bytes = validateByteCount(entry.bytes, "bytes");
    const sha256 = safeSha256(entry.sha256);
    const storageKey = optionalText(entry.storageKey, "storageKey");
    const result: RevisionManifestEntryInput = omitUndefined({
      artifactRevisionId: entry.artifactRevisionId,
      filename,
      role,
      artifactId,
      mediaType,
      bytes,
      sha256,
      storageKey
    });
    return result;
  }).sort((a, b) => a.artifactRevisionId.localeCompare(b.artifactRevisionId));
  const normalizedEntries = entries.map((entry) => ({
    artifactRevisionId: entry.artifactRevisionId,
    ...(entry.filename === undefined ? {} : { filename: entry.filename }),
    ...(entry.role === undefined ? {} : { role: entry.role }),
    ...(entry.artifactId === undefined ? {} : { artifactId: entry.artifactId }),
    ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }),
    ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
    ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
    ...(entry.storageKey === undefined ? {} : { storageKey: entry.storageKey })
  })) as unknown as RevisionManifestEntry[];
  // The pure helper is intentionally deterministic when no timestamp is
  // supplied. Store.freezeRevision supplies the real freeze time itself.
  const frozenAt = input.frozenAt ?? "1970-01-01T00:00:00.000Z";
  if (Number.isNaN(Date.parse(frozenAt))) throw new StoreFailure("INVALID_INPUT", "frozenAt must be an ISO date");
  const manifest: RevisionManifest = {
    version: 1,
    projectId: input.projectId,
    ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }),
    revisionId: input.revisionId,
    frozenAt,
    entries: normalizedEntries
  };
  return manifestForHash(manifest);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathSegment(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : value;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new StoreFailure("CORRUPT", `${label} is not an object`);
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new StoreFailure("CORRUPT", `${label}.${key} is missing or invalid`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new StoreFailure("CORRUPT", `${key} is present but invalid`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new StoreFailure("CORRUPT", `${label}.${key} is missing or invalid`);
  return value;
}

function requiredDate(record: Record<string, unknown>, key: string, label: string): string {
  const value = requiredString(record, key, label);
  if (!Number.isFinite(Date.parse(value))) throw new StoreFailure("CORRUPT", `${label}.${key} is invalid`);
  return value;
}

function legacyExpiry(createdAt: string): string {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) throw new StoreFailure("CORRUPT", "upload session.createdAt is invalid");
  const expiresAt = new Date(createdAtMs + DEFAULT_UPLOAD_SESSION_TTL_MS);
  if (!Number.isFinite(expiresAt.getTime())) throw new StoreFailure("CORRUPT", "upload session expiry is invalid");
  return expiresAt.toISOString();
}

function parseUploadSession(value: unknown): StoredUploadSession {
  const record = asRecord(value, "upload session");
  if (record.version !== 1) throw new StoreFailure("CORRUPT", "unsupported upload session version");
  const createdAt = requiredDate(record, "createdAt", "upload session");
  const expiresAt = record.expiresAt === undefined ? legacyExpiry(createdAt) : requiredDate(record, "expiresAt", "upload session");
  if (Date.parse(expiresAt) < Date.parse(createdAt)) throw new StoreFailure("CORRUPT", "upload session expiresAt precedes createdAt");
  const session = omitUndefined({
    version: 1 as const,
    sessionId: requiredString(record, "sessionId", "upload session"),
    status: requiredString(record, "status", "upload session") as UploadStatus,
    projectId: requiredString(record, "projectId", "upload session"),
    workItemId: optionalString(record, "workItemId"),
    revisionId: optionalString(record, "revisionId"),
    filename: requiredString(record, "filename", "upload session"),
    mediaType: optionalString(record, "mediaType"),
    role: optionalString(record, "role"),
    description: optionalString(record, "description"),
    source: optionalString(record, "source"),
    expectedBytes: record.expectedBytes === undefined ? undefined : requiredNumber(record, "expectedBytes", "upload session"),
    expectedSha256: optionalString(record, "expectedSha256"),
    artifactId: requiredString(record, "artifactId", "upload session"),
    artifactRevisionId: requiredString(record, "artifactRevisionId", "upload session"),
    bytesWritten: requiredNumber(record, "bytesWritten", "upload session"),
    createdAt,
    expiresAt,
    updatedAt: requiredString(record, "updatedAt", "upload session")
  });
  if (!["open", "finalized", "expired", "aborted"].includes(session.status)) throw new StoreFailure("CORRUPT", "upload session has an invalid status");
  return session;
}

function parseArtifactRecord(value: unknown): StoredArtifactRecord {
  const record = asRecord(value, "artifact record");
  if (record.version !== 1) throw new StoreFailure("CORRUPT", "unsupported artifact record version");
  const parsed = omitUndefined({
    version: 1 as const,
    artifactId: requiredString(record, "artifactId", "artifact record"),
    artifactRevisionId: requiredString(record, "artifactRevisionId", "artifact record"),
    projectId: requiredString(record, "projectId", "artifact record"),
    workItemId: optionalString(record, "workItemId"),
    revisionId: optionalString(record, "revisionId"),
    filename: requiredString(record, "filename", "artifact record"),
    mediaType: optionalString(record, "mediaType"),
    role: optionalString(record, "role"),
    description: optionalString(record, "description"),
    source: optionalString(record, "source"),
    bytes: requiredNumber(record, "bytes", "artifact record"),
    sha256: requiredString(record, "sha256", "artifact record"),
    storageKey: requiredString(record, "storageKey", "artifact record"),
    projectPath: optionalString(record, "projectPath"),
    createdAt: requiredString(record, "createdAt", "artifact record")
  });
  if (!SHA256_RE.test(parsed.sha256)) throw new StoreFailure("CORRUPT", "artifact record has an invalid digest");
  return parsed;
}

/**
 * A small, filesystem-backed content-addressed artifact store.
 *
 * The store is deliberately independent from the application database.  The
 * application can persist the returned IDs and hashes in SQLite, while this
 * package remains useful for import/export, backup, and offline tests.  All
 * generated paths stay beneath `root`; callers never provide a filesystem
 * path for an artifact.
 */
export class ArtifactStore {
  public readonly root: string;
  public readonly maxUploadBytes: number;
  public readonly maxStorageBytes: number;

  private readonly clock: () => number;
  private readonly sessionLocks = new Map<string, Promise<void>>();
  /** Finalizations remain compensatable until the audited DB mutation commits. */
  private readonly finalizationReceipts = new Map<string, FinalizationReceipt>();
  private layoutPromise: Promise<void> | undefined;

  public constructor(options: ArtifactStoreOptions) {
    if (typeof options.root !== "string" || options.root.length === 0) throw new TypeError("root is required");
    if (!Number.isSafeInteger(options.maxUploadBytes) || options.maxUploadBytes <= 0) throw new TypeError("maxUploadBytes must be positive");
    if (!Number.isSafeInteger(options.maxStorageBytes) || options.maxStorageBytes <= 0) throw new TypeError("maxStorageBytes must be positive");
    if (options.maxUploadBytes > options.maxStorageBytes) throw new TypeError("maxUploadBytes cannot exceed maxStorageBytes");
    if (options.clock !== undefined && typeof options.clock !== "function") throw new TypeError("clock must be a function");
    this.root = resolve(options.root);
    this.maxUploadBytes = options.maxUploadBytes;
    this.maxStorageBytes = options.maxStorageBytes;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Create the private directory layout, rejecting a symlinked store root. */
  public init(): Promise<Result<void>> {
    return resultFrom(async () => {
      await this.ensureLayout();
    });
  }

  public beginUpload(input: BeginUploadInput): Promise<Result<UploadSession>> {
    return resultFrom(async () => {
      const normalized = this.validateBeginInput(input);
      await this.ensureLayout();
      // Touching the generated project directory here makes a symlink in any
      // project component fail before bytes can be accepted.
      await this.ensureProjectDirectory(normalized.projectId, normalized.workItemId, normalized.revisionId);
      const sessionId = randomUUID();
      const now = this.nowMs();
      const createdAt = this.isoFromMs(now, "clock");
      const session: StoredUploadSession = omitUndefined({
        version: 1 as const,
        sessionId,
        status: "open" as const,
        projectId: normalized.projectId,
        workItemId: normalized.workItemId,
        revisionId: normalized.revisionId,
        filename: normalized.filename,
        mediaType: normalized.mediaType,
        role: normalized.role,
        description: normalized.description,
        source: normalized.source,
        expectedBytes: normalized.expectedBytes,
        expectedSha256: normalized.expectedSha256,
        artifactId: normalized.artifactId ?? randomUUID(),
        artifactRevisionId: normalized.artifactRevisionId ?? randomUUID(),
        bytesWritten: 0,
        createdAt,
        expiresAt: this.isoFromMs(now + DEFAULT_UPLOAD_SESSION_TTL_MS, "upload session expiry"),
        updatedAt: createdAt
      });
      const partPath = this.uploadPartPath(sessionId);
      const sessionPath = this.uploadSessionPath(sessionId);
      const handle = await this.openExclusive(partPath);
      await handle.close();
      await this.writeJsonAtomic(sessionPath, session);
      return this.publicSession(session);
    });
  }

  /** Read one upload session and its persisted ancestry without changing its state. */
  public getUploadSession(sessionId: string): Promise<Result<UploadSession>> {
    return this.withSessionLock(sessionId, () => resultFrom(async () => {
      assertValidId(sessionId, "sessionId");
      await this.ensureLayout();
      return this.publicSession(await this.readSession(sessionId));
    }));
  }

  /** Append one byte stream to an open upload session. */
  public writeUpload(sessionId: string, source: ArtifactByteSource | Readable): Promise<Result<UploadProgress>> {
    return this.withSessionLock(sessionId, async () => resultFrom(async () => {
      assertValidId(sessionId, "sessionId");
      await this.ensureLayout();
      const session = await this.readSession(sessionId);
      await this.assertOpenSession(session);
      const partPath = this.uploadPartPath(sessionId);
      await this.assertPathNoSymlink(partPath, this.root);
      let bytesWritten = session.bytesWritten;
      let expiredAt: number | undefined;
      const expiresAtMs = Date.parse(session.expiresAt);
      const handle = await open(partPath, "a");
      try {
        for await (const chunk of source) {
          await this.assertOpenSession(session);
          if (!(chunk instanceof Uint8Array)) throw new StoreFailure("INVALID_INPUT", "artifact stream yielded non-byte data");
          const next = bytesWritten + chunk.byteLength;
          if (next > this.maxUploadBytes) {
            throw new StoreFailure("UPLOAD_QUOTA_EXCEEDED", "upload exceeds the per-upload quota", { maxUploadBytes: this.maxUploadBytes });
          }
          if (session.expectedBytes !== undefined && next > session.expectedBytes) {
            throw new StoreFailure("SIZE_MISMATCH", "upload exceeds its declared size", { expectedBytes: session.expectedBytes });
          }
          await handle.write(chunk);
          bytesWritten = next;
          const writtenAt = this.nowMs();
          if (writtenAt >= expiresAtMs) {
            expiredAt = writtenAt;
            await handle.sync();
            break;
          }
          const updated: StoredUploadSession = { ...session, bytesWritten, updatedAt: this.isoFromMs(writtenAt, "clock") };
          await this.writeJsonAtomic(this.uploadSessionPath(sessionId), updated);
        }
        if (expiredAt === undefined) {
          await handle.sync();
          const completedAt = this.nowMs();
          if (completedAt >= expiresAtMs) expiredAt = completedAt;
        }
      } finally {
        await handle.close();
      }
      if (expiredAt !== undefined) {
        await this.expireSession({ ...session, bytesWritten }, expiredAt);
        throw new StoreFailure("UPLOAD_STATE", "upload session has expired", { sessionId, expiresAt: session.expiresAt });
      }
      const progress: UploadProgress = {
        sessionId,
        status: "open",
        bytesWritten,
        ...(session.expectedBytes === undefined ? {} : {
          expectedBytes: session.expectedBytes,
          remainingBytes: session.expectedBytes - bytesWritten
        })
      };
      return progress;
    }));
  }

  /** Alias which makes stream-oriented call sites self-documenting. */
  public writeUploadStream(sessionId: string, source: ArtifactByteSource | Readable): Promise<Result<UploadProgress>> {
    return this.writeUpload(sessionId, source);
  }

  /**
   * Hash and commit an upload.  The content-addressed blob is linked into its
   * final name atomically; an existing exact blob is reused.  No destination
   * file is ever replaced, even if a second session races this one.
   */
  public finalizeUpload(sessionId: string): Promise<Result<StoredArtifact>> {
    return this.withSessionLock(sessionId, async () => resultFrom(async () => {
      assertValidId(sessionId, "sessionId");
      await this.ensureLayout();
      const session = await this.readSession(sessionId);
      if (session.status === "finalized") {
        const existing = await this.readArtifactRecord(session.artifactRevisionId);
        return { ...existing, deduplicated: true };
      }
      await this.assertOpenSession(session);
      const partPath = this.uploadPartPath(sessionId);
      await this.assertPathNoSymlink(partPath, this.root);
      const partStat = await this.safeStat(partPath, "upload data");
      if (partStat === undefined || !partStat.isFile()) throw new StoreFailure("CORRUPT", "upload data is not a regular file");
      const actual = await artifactSha256(createReadStream(partPath));
      if (actual.bytes !== partStat.size) throw new StoreFailure("CORRUPT", "upload changed while being finalized");
      if (session.expectedBytes !== undefined && actual.bytes !== session.expectedBytes) {
        throw new StoreFailure("SIZE_MISMATCH", "upload does not match its declared size", { expectedBytes: session.expectedBytes, actualBytes: actual.bytes });
      }
      if (session.expectedSha256 !== undefined && actual.sha256 !== session.expectedSha256) {
        throw new StoreFailure("DIGEST_MISMATCH", "upload does not match its declared SHA-256", { expectedSha256: session.expectedSha256, actualSha256: actual.sha256 });
      }
      const artifact = this.buildArtifactRecord(session, actual);
      const recordPath = this.artifactRecordPath(artifact.artifactRevisionId);
      // Validate a caller-supplied revision ID before linking bytes into the
      // CAS. A conflicting retry must not leave an unreferenced blob behind.
      const prior = await this.tryReadArtifactRecord(artifact.artifactRevisionId);
      if (prior !== undefined && !sameArtifactIdentity(prior, artifact)) throw new StoreFailure("CONFLICT", "artifact revision ID already names different bytes", { artifactRevisionId: artifact.artifactRevisionId });
      const blobPath = this.blobPath(actual.sha256);
      await this.ensureBlobPrefix(actual.sha256);
      const existingBlob = await this.existingExactBlob(blobPath, actual);
      let deduplicated = existingBlob;
      let createdBlob = false;
      if (!existingBlob) {
        const usage = await this.getUsageUnsafe();
        if (usage.uniqueBytes + actual.bytes > this.maxStorageBytes) {
          throw new StoreFailure("STORAGE_QUOTA_EXCEEDED", "finalizing this unique blob exceeds the instance quota", { maxStorageBytes: this.maxStorageBytes, uniqueBytes: usage.uniqueBytes, incomingBytes: actual.bytes });
        }
        try {
          // link(2) creates the destination directory entry atomically and
          // fails with EEXIST instead of replacing a concurrent blob.
          await link(partPath, blobPath);
          deduplicated = false;
          createdBlob = true;
        } catch (error: unknown) {
          if (isNodeError(error, "EEXIST")) {
            const raced = await this.existingExactBlob(blobPath, actual);
            if (!raced) throw new StoreFailure("CORRUPT", "content-addressed destination already exists with different bytes");
            deduplicated = true;
          } else {
            throw error;
          }
        }
      }
      let createdArtifactRecord = false;
      let createdProjection = false;
      let receipt: FinalizationReceipt | undefined;
      const rememberReceipt = (): void => {
        const next: FinalizationReceipt = {
          session,
          artifact,
          createdArtifactRecord,
          createdBlob,
          createdProjection
        };
        receipt = next;
        this.finalizationReceipts.set(sessionId, next);
      };

      // From this point on, every operation can have already made one of the
      // final artifact paths visible when it reports an error (for example a
      // post-rename cleanup failure). Keep the receipt before entering that
      // window so the store can compensate without an application-provided
      // artifact ID.
      rememberReceipt();
      try {
        if (prior === undefined) {
          const created = await this.writeJsonExclusive(recordPath, artifact);
          createdArtifactRecord = created;
          rememberReceipt();
          if (!created) {
            const raced = await this.readArtifactRecord(artifact.artifactRevisionId);
            if (!sameArtifactIdentity(raced, artifact)) throw new StoreFailure("CONFLICT", "artifact revision ID already names different bytes", { artifactRevisionId: artifact.artifactRevisionId });
          }
        }
        createdProjection = await this.ensureProjectProjection(artifact, blobPath);
        rememberReceipt();
        const finalized: StoredUploadSession = { ...session, status: "finalized", bytesWritten: actual.bytes, updatedAt: this.nowIso() };
        await this.writeJsonAtomic(this.uploadSessionPath(sessionId), finalized);
        // Keep the finalized session metadata for idempotent retries, but
        // remove the extra hard link once the artifact record is durable.
        await this.safeUnlink(partPath);
        return { ...artifact, deduplicated };
      } catch (error: unknown) {
        if (receipt === undefined) throw error;
        try {
          // A failure in this store-local window must not rely on the
          // application seeing a finalizedArtifactId. Restore the upload and
          // remove only paths created by this finalization before returning.
          await this.rollbackFinalizationReceipt(receipt, false);
        } catch (cleanupError: unknown) {
          const message = cleanupError instanceof Error ? cleanupError.message : "unknown cleanup failure";
          throw new StoreFailure("IO_ERROR", "artifact finalization failed and could not be cleaned up", { sessionId, artifactRevisionId: artifact.artifactRevisionId, cleanupError: message });
        }
        throw error;
      }
    }));
  }

  /**
   * Mark a successful audited finalization as durable. The receipt is only a
   * process-local rollback window; after this call a later failed command may
   * never remove the artifact created by this committed command.
   */
  public commitFinalization(sessionId: string, artifactId: string): Promise<Result<void>> {
    return this.withSessionLock(sessionId, async () => resultFrom(async () => {
      assertValidId(sessionId, "sessionId");
      assertValidId(artifactId, "artifactId");
      await this.ensureLayout();
      const receipt = this.finalizationReceipts.get(sessionId);
      if (receipt !== undefined && receipt.artifact.artifactId !== artifactId) {
        throw new StoreFailure("CONFLICT", "finalization receipt does not match the artifact", { sessionId });
      }
      this.finalizationReceipts.delete(sessionId);
    }));
  }

  /**
   * Compensate a successful filesystem finalization after its surrounding
   * audited SQLite mutation rolled back. Only paths created by this session
   * are removed; pre-existing content-addressed blobs, records, and
   * projections remain untouched. The upload is reopened with its bytes so a
   * caller can safely retry finalization after fixing the failed mutation.
   */
  public rollbackFinalization(sessionId: string): Promise<Result<FinalizationRollback>> {
    return this.withSessionLock(sessionId, async () => resultFrom(async () => {
      assertValidId(sessionId, "sessionId");
      await this.ensureLayout();
      const receipt = this.finalizationReceipts.get(sessionId);
      if (receipt === undefined) throw new StoreFailure("UPLOAD_STATE", "finalization is no longer in the compensatable window", { sessionId });
      const current = await this.readSession(sessionId);
      if (current.status !== "finalized") throw new StoreFailure("UPLOAD_STATE", "upload session is not finalized", { sessionId });
      const { artifact } = receipt;
      if (artifact.artifactId !== receipt.session.artifactId) throw new StoreFailure("CORRUPT", "finalization receipt has inconsistent artifact identity", { sessionId });
      return this.rollbackFinalizationReceipt(receipt, true);
    }));
  }

  /**
   * Remove the paths owned by a finalization receipt and reopen its upload.
   * `requireFinalized` is used by the public compensation API; an internal
   * finalize failure may have happened before the session metadata was written
   * and therefore accepts either the original open state or finalized state.
   */
  private async rollbackFinalizationReceipt(receipt: FinalizationReceipt, requireFinalized: boolean): Promise<FinalizationRollback> {
    const { session, artifact } = receipt;
    const sessionPath = this.uploadSessionPath(session.sessionId);
    if (requireFinalized) {
      const current = await this.readSession(session.sessionId);
      if (current.status !== "finalized") {
        throw new StoreFailure("UPLOAD_STATE", "upload session is not finalized", { sessionId: session.sessionId });
      }
    }
    if (artifact.artifactId !== session.artifactId) {
      throw new StoreFailure("CORRUPT", "finalization receipt has inconsistent artifact identity", { sessionId: session.sessionId });
    }

    const partPath = this.uploadPartPath(session.sessionId);
    const blobPath = this.blobPath(artifact.sha256);

    // Recreate the upload hard link before potentially removing a newly
    // created blob. This keeps a failed audited mutation retryable without
    // copying or buffering opaque artifact bytes. It also handles an unlink
    // that removed the link before reporting its failure.
    const part = await this.safeStat(partPath, "upload data", true);
    if (part !== undefined && !part.isFile()) throw new StoreFailure("CORRUPT", "upload data is not a regular file");
    if (part === undefined) {
      const blob = await this.safeStat(blobPath, "content-addressed blob", true);
      if (blob === undefined || !blob.isFile()) throw new StoreFailure("CORRUPT", "finalized artifact bytes are missing");
      await link(blobPath, partPath);
    } else {
      const partHash = await artifactSha256(createReadStream(partPath));
      if (partHash.bytes !== artifact.bytes || partHash.sha256 !== artifact.sha256) throw new StoreFailure("CORRUPT", "finalized upload data failed hash verification");
    }

    if (receipt.createdProjection && artifact.projectPath !== undefined) {
      await this.safeUnlink(resolve(this.root, artifact.projectPath));
    }

    let artifactRecordRemoved = false;
    if (receipt.createdArtifactRecord) {
      const currentRecord = await this.tryReadArtifactRecord(artifact.artifactRevisionId);
      if (currentRecord !== undefined) {
        if (!sameArtifactIdentity(currentRecord, artifact)) throw new StoreFailure("CONFLICT", "artifact record changed before compensation", { artifactRevisionId: artifact.artifactRevisionId });
        await this.safeUnlink(this.artifactRecordPath(artifact.artifactRevisionId));
        artifactRecordRemoved = true;
      }
    }

    let blobRemoved = false;
    if (receipt.createdBlob) {
      const records = await this.listArtifactRevisions();
      if (!records.ok) throw new StoreFailure(records.error.code, records.error.message, records.error.details);
      if (!records.value.some((candidate) => candidate.sha256 === artifact.sha256)) {
        await this.safeUnlink(blobPath);
        blobRemoved = true;
      }
    }

    const reopened: StoredUploadSession = {
      ...session,
      status: "open",
      bytesWritten: artifact.bytes,
      updatedAt: this.nowIso()
    };
    await this.writeJsonAtomic(sessionPath, reopened);
    this.finalizationReceipts.delete(session.sessionId);
    return {
      sessionId: session.sessionId,
      artifactId: artifact.artifactId,
      artifactRevisionId: artifact.artifactRevisionId,
      artifactRecordRemoved,
      blobRemoved,
      projectionRemoved: receipt.createdProjection
    };
  }

  /** Delete a session and its uncommitted bytes. */
  public abortUpload(sessionId: string): Promise<Result<void>> {
    return this.withSessionLock(sessionId, async () => resultFrom(async () => {
      assertValidId(sessionId, "sessionId");
      await this.ensureLayout();
      const session = await this.readSession(sessionId);
      if (session.status === "finalized") throw new StoreFailure("UPLOAD_STATE", "a finalized upload cannot be aborted");
      await this.safeUnlink(this.uploadPartPath(sessionId));
      await this.safeUnlink(this.uploadSessionPath(sessionId));
    }));
  }

  /** Recover metadata and the actual byte count after a process interruption. */
  public recoverUpload(sessionId: string): Promise<Result<UploadSession>> {
    return this.withSessionLock(sessionId, () => resultFrom(async () => {
      assertValidId(sessionId, "sessionId");
      await this.ensureLayout();
      const session = await this.readSession(sessionId);
      if (session.status === "finalized") return this.publicSession(session);
      await this.assertOpenSession(session);
      const partPath = this.uploadPartPath(sessionId);
      const part = await this.safeStat(partPath, "upload data", true);
      if (!part) throw new StoreFailure("NOT_FOUND", "recoverable upload data was not found", { sessionId });
      if (!part.isFile()) throw new StoreFailure("CORRUPT", "recoverable upload data is not a regular file");
      const bytesWritten = part.size;
      if (bytesWritten > this.maxUploadBytes) throw new StoreFailure("UPLOAD_QUOTA_EXCEEDED", "recoverable upload exceeds the per-upload quota");
      if (session.expectedBytes !== undefined && bytesWritten > session.expectedBytes) throw new StoreFailure("SIZE_MISMATCH", "recoverable upload exceeds its declared size");
      const updated: StoredUploadSession = bytesWritten === session.bytesWritten ? session : { ...session, bytesWritten, updatedAt: this.nowIso() };
      if (updated !== session) await this.writeJsonAtomic(this.uploadSessionPath(sessionId), updated);
      return this.publicSession(updated);
    }));
  }

  /**
   * Return open sessions with surviving data. This is intentionally read-only;
   * callers may decide whether to resume or expire each orphan.
   */
  public listOrphanUploads(): Promise<Result<readonly UploadSession[]>> {
    return resultFrom(async () => {
      await this.ensureLayout();
      const names = await readdir(this.uploadsDir());
      const sessions: UploadSession[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const sessionId = name.slice(0, -5);
        if (!ID_RE.test(sessionId)) continue;
        const session = await this.readSession(sessionId);
        if (session.status !== "open") continue;
        const data = await this.safeStat(this.uploadPartPath(sessionId), "upload data", true);
        if (data?.isFile()) sessions.push(this.publicSession(session));
      }
      sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return sessions;
    });
  }

  /** Alias used by maintenance jobs that want a recovery scan by name. */
  public recoverOrphanUploads(): Promise<Result<readonly UploadSession[]>> {
    return this.listOrphanUploads();
  }

  /** Expire and remove open sessions whose update time is older than a bound. */
  public expireOrphanUploads(options: ExpireOrphanOptions): Promise<Result<ExpireOrphanResult>> {
    return resultFrom(async () => {
      if (!Number.isSafeInteger(options.olderThanMs) || options.olderThanMs < 0) throw new StoreFailure("INVALID_INPUT", "olderThanMs must be a non-negative safe integer");
      await this.ensureLayout();
      const now = options.now?.getTime() ?? this.nowMs();
      this.isoFromMs(now, "now");
      const listed = await this.listOrphanUploads();
      if (!listed.ok) throw new StoreFailure(listed.error.code, listed.error.message, listed.error.details);
      const expiredSessionIds: string[] = [];
      let reclaimedBytes = 0;
      const handled = new Set<string>();
      for (const session of listed.value) {
        handled.add(session.sessionId);
        const swept = await this.withSessionLock(session.sessionId, async () => {
          // Re-read under the same lock used by write/finalize/recover so a
          // maintenance sweep cannot expire a session that just finalized.
          const current = await this.readSession(session.sessionId);
          if (current.status !== "open") return ok({ expired: false, reclaimedBytes: 0 });
          const age = now - Date.parse(current.updatedAt);
          const expiryDue = now >= Date.parse(current.expiresAt);
          if (!expiryDue && age < options.olderThanMs) return ok({ expired: false, reclaimedBytes: 0 });
          return ok({ expired: true, reclaimedBytes: await this.expireSession(current, now) });
        });
        if (!swept.ok) throw new StoreFailure(swept.error.code, swept.error.message, swept.error.details);
        if (!swept.value.expired) continue;
        reclaimedBytes += swept.value.reclaimedBytes;
        expiredSessionIds.push(session.sessionId);
      }
      // A crash can occur between creating a .part file and its JSON record.
      // Such a file cannot be resumed safely because its project metadata is
      // unknown, but it must still be reclaimed by the maintenance sweep.
      for (const name of await readdir(this.uploadsDir())) {
        if (!name.endsWith(".part")) continue;
        const sessionId = name.slice(0, -5);
        if (!ID_RE.test(sessionId) || handled.has(sessionId)) continue;
        const partPath = this.uploadPartPath(sessionId);
        const data = await this.safeStat(partPath, "upload data", true);
        if (data === undefined || !data.isFile()) continue;
        const age = now - data.mtimeMs;
        if (age < options.olderThanMs) continue;
        reclaimedBytes += data.size;
        await this.safeUnlink(partPath);
        expiredSessionIds.push(sessionId);
      }
      return { expiredSessionIds, reclaimedBytes };
    });
  }

  /** Alias for scheduled orphan maintenance. */
  public sweepOrphans(options: ExpireOrphanOptions): Promise<Result<ExpireOrphanResult>> {
    return this.expireOrphanUploads(options);
  }

  public getUsage(): Promise<Result<StoreUsage>> {
    return resultFrom(async () => {
      await this.ensureLayout();
      return this.getUsageUnsafe();
    });
  }

  public listArtifactRevisions(): Promise<Result<readonly ArtifactRevision[]>> {
    return resultFrom(async () => {
      await this.ensureLayout();
      const names = await readdir(this.artifactRecordsDir());
      const records: ArtifactRevision[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        if (!ID_RE.test(id)) continue;
        records.push(await this.readArtifactRecord(id));
      }
      records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.artifactRevisionId.localeCompare(b.artifactRevisionId));
      return records;
    });
  }

  public readArtifact(artifactRevisionId: string): Promise<Result<ArtifactBytes>> {
    return resultFrom(async () => {
      assertValidId(artifactRevisionId, "artifactRevisionId");
      await this.ensureLayout();
      const artifact = await this.readArtifactRecord(artifactRevisionId);
      const blobPath = this.blobPath(artifact.sha256);
      const data = await this.readBlobExact(blobPath, artifact.bytes, artifact.sha256);
      return { artifact, bytes: data };
    });
  }

  /** Read a revision manifest and recompute its hash from canonical bytes. */
  public readRevisionManifest(input: Pick<RevisionManifestInput, "projectId" | "workItemId" | "revisionId">): Promise<Result<CreatedRevisionManifest>> {
    return resultFrom(async () => {
      this.validateManifestIdentity(input);
      await this.ensureLayout();
      const path = this.manifestPath(input.projectId, input.workItemId, input.revisionId);
      const envelope = await this.readManifestEnvelope(path);
      return manifestForHash(envelope.manifest);
    });
  }

  /**
   * Freeze a project revision. Once written, the same revision can only be
   * returned idempotently; different entries are rejected rather than replaced.
   */
  public freezeRevision(input: FreezeRevisionInput): Promise<Result<CreatedRevisionManifest>> {
    return resultFrom(async () => {
      this.validateManifestIdentity(input);
      await this.ensureLayout();
      if (!Array.isArray(input.entries)) throw new StoreFailure("INVALID_INPUT", "entries must be an array");
      const entries: RevisionManifestEntry[] = [];
      const seen = new Set<string>();
      for (const requested of input.entries) {
        assertValidId(requested.artifactRevisionId, "artifactRevisionId");
        if (seen.has(requested.artifactRevisionId)) throw new StoreFailure("CONFLICT", "manifest contains a duplicate artifact revision", { artifactRevisionId: requested.artifactRevisionId });
        seen.add(requested.artifactRevisionId);
        const artifact = await this.readArtifactRecord(requested.artifactRevisionId);
        if (artifact.projectId !== input.projectId || (artifact.workItemId ?? undefined) !== (input.workItemId ?? undefined) || (artifact.revisionId ?? undefined) !== (input.revisionId ?? undefined)) {
          throw new StoreFailure("CONFLICT", "artifact belongs to a different project revision", { artifactRevisionId: requested.artifactRevisionId });
        }
        const filename = requested.filename === undefined ? artifact.filename : safeFilename(requested.filename);
        const role = requested.role === undefined ? artifact.role : optionalText(requested.role, "role");
        const entry = omitUndefined({
          artifactRevisionId: artifact.artifactRevisionId,
          artifactId: artifact.artifactId,
          filename,
          role,
          mediaType: artifact.mediaType,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          storageKey: artifact.storageKey
        }) as RevisionManifestEntry;
        entries.push(entry);
      }
      entries.sort((a, b) => a.artifactRevisionId.localeCompare(b.artifactRevisionId));
      const path = this.manifestPath(input.projectId, input.workItemId, input.revisionId);
      const current = await this.tryReadManifestEnvelope(path);
      const frozenAt = current?.manifest.frozenAt ?? input.frozenAt ?? this.nowIso();
      if (Number.isNaN(Date.parse(frozenAt))) throw new StoreFailure("INVALID_INPUT", "frozenAt must be an ISO date");
      const created = manifestForHash({
        version: 1,
        projectId: input.projectId,
        ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }),
        revisionId: input.revisionId,
        frozenAt,
        entries
      });
      if (current !== undefined) {
        const currentCreated = manifestForHash(current.manifest);
        if (currentCreated.canonicalJson !== created.canonicalJson) throw new StoreFailure("MANIFEST_IMMUTABLE", "revision manifest is already frozen with different entries", { projectId: input.projectId, revisionId: input.revisionId });
        return currentCreated;
      }
      const envelope: RevisionManifestEnvelope = { manifest: created.manifest, sha256: created.sha256 };
      const createdEnvelope = await this.writeJsonExclusive(path, envelope);
      if (!createdEnvelope) {
        const raced = await this.readManifestEnvelope(path);
        const racedCreated = manifestForHash(raced.manifest);
        if (racedCreated.canonicalJson !== created.canonicalJson) throw new StoreFailure("MANIFEST_IMMUTABLE", "revision manifest is already frozen with different entries", { projectId: input.projectId, revisionId: input.revisionId });
        return racedCreated;
      }
      return created;
    });
  }

  public exportRevisionBundle(input: ExportRevisionBundleInput): Promise<Result<ExportRevisionBundleResult>> {
    return resultFrom(async () => {
      this.validateManifestIdentity(input);
      if (typeof input.destination !== "string" || input.destination.length === 0) throw new StoreFailure("INVALID_INPUT", "destination is required");
      await this.ensureLayout();
      const source = await this.readManifestEnvelope(this.manifestPath(input.projectId, input.workItemId, input.revisionId));
      const destination = resolve(input.destination);
      if (isInside(this.root, destination)) throw new StoreFailure("PATH_UNSAFE", "bundle destination cannot be inside the artifact store");
      await this.prepareEmptyDirectory(destination);
      const filesDir = join(destination, "files");
      await mkdir(filesDir, { recursive: true });
      await this.assertPathNoSymlink(filesDir, destination);
      const files: PortableBundleFile[] = [];
      for (const [index, entry] of source.manifest.entries.entries()) {
        const artifact = await this.readArtifactRecord(entry.artifactRevisionId);
        // Portable bundle manifests always use POSIX separators, regardless of
        // the host that produced the directory.
        const relativePath = `files/${String(index).padStart(4, "0")}-${safeFilename(entry.filename)}`;
        const target = join(destination, "files", `${String(index).padStart(4, "0")}-${safeFilename(entry.filename)}`);
        await this.assertPathNoSymlink(target, destination);
        await copyFile(this.blobPath(artifact.sha256), target, 0);
        const copied = await artifactSha256(createReadStream(target));
        if (copied.bytes !== artifact.bytes || copied.sha256 !== artifact.sha256) throw new StoreFailure("CORRUPT", "exported artifact bytes failed verification", { artifactRevisionId: artifact.artifactRevisionId });
        files.push({ artifactRevisionId: artifact.artifactRevisionId, relativePath, filename: entry.filename, bytes: artifact.bytes, sha256: artifact.sha256 });
      }
      const portable: StoredPortableBundleManifest = {
        format: "benchledger-artifact-bundle",
        version: 1,
        exportedAt: this.nowIso(),
        revisionManifest: source.manifest,
        files
      };
      const manifestText = `${canonicalJson(portable)}\n`;
      await this.writeJsonAtomicExternal(join(destination, "manifest.json"), portable, destination);
      return { bundlePath: destination, manifest: portable, sha256: digestBytes(Buffer.from(manifestText, "utf8")) };
    });
  }

  /**
   * Restore a directory bundle created by exportRevisionBundle.  This reads
   * only the declared files and treats every byte as opaque; it never extracts
   * an archive or executes a restored file.
   */
  public restoreRevisionBundle(bundlePath: string): Promise<Result<RestoreRevisionBundleResult>> {
    return resultFrom(async () => {
      if (typeof bundlePath !== "string" || bundlePath.length === 0) throw new StoreFailure("INVALID_INPUT", "bundlePath is required");
      const bundle = resolve(bundlePath);
      const bundleStat = await this.safeStatExternal(bundle, "bundle", true);
      if (!bundleStat?.isDirectory()) throw new StoreFailure("BUNDLE_INVALID", "bundle path must be a directory");
      const manifestPath = join(bundle, "manifest.json");
      await this.assertExternalPathNoSymlink(manifestPath, bundle);
      let portable: StoredPortableBundleManifest;
      try {
        portable = JSON.parse(await readFile(manifestPath, "utf8")) as StoredPortableBundleManifest;
      } catch (error: unknown) {
        if (error instanceof StoreFailure) throw error;
        throw new StoreFailure("BUNDLE_INVALID", "bundle manifest is not valid JSON");
      }
      this.validatePortableManifest(portable);
      await this.ensureLayout();
      const restoredIds: string[] = [];
      for (const file of portable.files) {
        const entry = portable.revisionManifest.entries.find((candidate) => candidate.artifactRevisionId === file.artifactRevisionId);
        if (entry === undefined) throw new StoreFailure("BUNDLE_INVALID", "bundle file has no matching revision entry", { artifactRevisionId: file.artifactRevisionId });
        const sourcePath = join(bundle, file.relativePath);
        await this.assertExternalPathNoSymlink(sourcePath, bundle);
        const sourceStat = await this.safeStatExternal(sourcePath, "bundle file");
        if (sourceStat === undefined || !sourceStat.isFile()) throw new StoreFailure("BUNDLE_INVALID", "bundle file is not a regular file", { relativePath: file.relativePath });
        const hash = await artifactSha256(createReadStream(sourcePath));
        if (hash.bytes !== file.bytes || hash.sha256 !== file.sha256 || hash.bytes !== entry.bytes || hash.sha256 !== entry.sha256) {
          throw new StoreFailure("DIGEST_MISMATCH", "bundle file failed its manifest hash", { relativePath: file.relativePath });
        }
        const upload = await this.beginUpload({
          projectId: portable.revisionManifest.projectId,
          ...(portable.revisionManifest.workItemId === undefined ? {} : { workItemId: portable.revisionManifest.workItemId }),
          revisionId: portable.revisionManifest.revisionId,
          filename: entry.filename,
          ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }),
          ...(entry.role === undefined ? {} : { role: entry.role }),
          expectedBytes: entry.bytes,
          expectedSha256: entry.sha256,
          artifactId: entry.artifactId,
          artifactRevisionId: entry.artifactRevisionId
        });
        if (!upload.ok) throw new StoreFailure(upload.error.code, upload.error.message, upload.error.details);
        const written = await this.writeUpload(upload.value.sessionId, createReadStream(sourcePath));
        if (!written.ok) throw new StoreFailure(written.error.code, written.error.message, written.error.details);
        const finalized = await this.finalizeUpload(upload.value.sessionId);
        if (!finalized.ok) throw new StoreFailure(finalized.error.code, finalized.error.message, finalized.error.details);
        restoredIds.push(finalized.value.artifactRevisionId);
      }
      const frozen = await this.freezeRevision({
        projectId: portable.revisionManifest.projectId,
        ...(portable.revisionManifest.workItemId === undefined ? {} : { workItemId: portable.revisionManifest.workItemId }),
        revisionId: portable.revisionManifest.revisionId,
        frozenAt: portable.revisionManifest.frozenAt,
        entries: portable.revisionManifest.entries.map((entry) => ({ artifactRevisionId: entry.artifactRevisionId, filename: entry.filename, ...(entry.role === undefined ? {} : { role: entry.role }) }))
      });
      if (!frozen.ok) throw new StoreFailure(frozen.error.code, frozen.error.message, frozen.error.details);
      return {
        projectId: portable.revisionManifest.projectId,
        ...(portable.revisionManifest.workItemId === undefined ? {} : { workItemId: portable.revisionManifest.workItemId }),
        revisionId: portable.revisionManifest.revisionId,
        artifactRevisionIds: restoredIds
      };
    });
  }

  private validateBeginInput(input: BeginUploadInput): BeginUploadInput {
    if (input === null || typeof input !== "object") throw new StoreFailure("INVALID_INPUT", "upload input is required");
    assertValidId(input.projectId, "projectId");
    if (input.workItemId !== undefined) assertValidId(input.workItemId, "workItemId");
    if (input.revisionId !== undefined) assertValidId(input.revisionId, "revisionId");
    const filename = safeFilename(input.filename);
    const expectedBytes = validateByteCount(input.expectedBytes, "expectedBytes");
    if (expectedBytes !== undefined && expectedBytes > this.maxUploadBytes) throw new StoreFailure("UPLOAD_QUOTA_EXCEEDED", "declared upload size exceeds the per-upload quota", { maxUploadBytes: this.maxUploadBytes, expectedBytes });
    const expectedSha256 = safeSha256(input.expectedSha256, "expectedSha256");
    const mediaType = optionalText(input.mediaType, "mediaType");
    const role = optionalText(input.role, "role");
    const description = optionalText(input.description, "description");
    const source = optionalText(input.source, "source");
    if (input.artifactId !== undefined) assertValidId(input.artifactId, "artifactId");
    if (input.artifactRevisionId !== undefined) assertValidId(input.artifactRevisionId, "artifactRevisionId");
    return omitUndefined({
      projectId: input.projectId,
      workItemId: input.workItemId,
      revisionId: input.revisionId,
      filename,
      mediaType,
      role,
      description,
      source,
      expectedBytes,
      expectedSha256,
      artifactId: input.artifactId,
      artifactRevisionId: input.artifactRevisionId
    });
  }

  private validateManifestIdentity(input: Pick<RevisionManifestInput, "projectId" | "workItemId" | "revisionId">): void {
    if (input === null || typeof input !== "object") throw new StoreFailure("INVALID_INPUT", "manifest identity is required");
    assertValidId(input.projectId, "projectId");
    assertValidId(input.revisionId, "revisionId");
    if (input.workItemId !== undefined) assertValidId(input.workItemId, "workItemId");
  }

  private publicSession(session: StoredUploadSession): UploadSession {
    const { version: _version, ...publicValue } = session;
    return publicValue;
  }

  private nowMs(): number {
    let value: number;
    try {
      value = this.clock();
    } catch {
      throw new StoreFailure("INVALID_INPUT", "clock could not provide a valid time");
    }
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
      throw new StoreFailure("INVALID_INPUT", "clock must return a valid safe integer timestamp");
    }
    return value;
  }

  private isoFromMs(value: number, field: string): string {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new StoreFailure("INVALID_INPUT", `${field} must be a valid safe integer timestamp`);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new StoreFailure("INVALID_INPUT", `${field} must be a valid date`);
    return date.toISOString();
  }

  private nowIso(): string {
    return this.isoFromMs(this.nowMs(), "clock");
  }

  private async expireSession(session: UploadSession, now: number): Promise<number> {
    const partPath = this.uploadPartPath(session.sessionId);
    const data = await this.safeStat(partPath, "upload data", true);
    if (data !== undefined && !data.isFile()) throw new StoreFailure("CORRUPT", "upload data is not a regular file");
    const reclaimedBytes = data?.isFile() ? data.size : 0;
    const expired: StoredUploadSession = {
      ...session,
      version: 1,
      status: "expired",
      bytesWritten: data?.isFile() ? data.size : session.bytesWritten,
      updatedAt: this.isoFromMs(now, "expiry time")
    };
    // Mark the session unavailable before reclaiming its bytes. If a process
    // stops between these operations, the stale bytes remain inaccessible to
    // upload/finalize/recovery and can be removed by the next sweep.
    await this.writeJsonAtomic(this.uploadSessionPath(session.sessionId), expired);
    await this.safeUnlink(partPath);
    return reclaimedBytes;
  }

  private async reclaimExpiredPart(session: UploadSession): Promise<void> {
    const partPath = this.uploadPartPath(session.sessionId);
    const data = await this.safeStat(partPath, "upload data", true);
    if (data !== undefined && !data.isFile()) throw new StoreFailure("CORRUPT", "upload data is not a regular file");
    await this.safeUnlink(partPath);
  }

  private buildArtifactRecord(session: StoredUploadSession, hash: ArtifactHash): StoredArtifactRecord {
    const storageKey = `blobs/sha256/${hash.sha256.slice(0, 2)}/${hash.sha256}`;
    const projectPath = this.projectArtifactPath(session);
    return omitUndefined({
      version: 1 as const,
      artifactId: session.artifactId,
      artifactRevisionId: session.artifactRevisionId,
      projectId: session.projectId,
      workItemId: session.workItemId,
      revisionId: session.revisionId,
      filename: session.filename,
      mediaType: session.mediaType,
      role: session.role,
      description: session.description,
      source: session.source,
      bytes: hash.bytes,
      sha256: hash.sha256,
      storageKey,
      projectPath,
      createdAt: session.createdAt
    });
  }

  private projectArtifactPath(session: StoredUploadSession): string | undefined {
    if (session.workItemId === undefined || session.revisionId === undefined) return undefined;
    const relativePath = join("projects", session.projectId, session.workItemId, session.revisionId, "artifacts", `${session.artifactRevisionId}-${session.filename}`);
    return relativePath;
  }

  private async ensureProjectProjection(artifact: ArtifactRevision, blobPath: string): Promise<boolean> {
    if (artifact.projectPath === undefined) return false;
    if (artifact.projectPath.length === 0 || artifact.projectPath.includes("\\") || artifact.projectPath.includes("\u0000")) throw new StoreFailure("PATH_UNSAFE", "stored project path is invalid");
    const target = resolve(this.root, artifact.projectPath);
    if (!isInside(this.root, target)) throw new StoreFailure("PATH_UNSAFE", "stored project path escapes artifact store");
    const projectRoot = join(this.root, "projects", artifact.projectId);
    await this.assertPathNoSymlink(target, projectRoot);
    await mkdir(dirname(target), { recursive: true });
    await this.assertPathNoSymlink(target, projectRoot);
    const existing = await this.safeStat(target, "project artifact projection", true);
    if (existing !== undefined) {
      if (!existing.isFile()) throw new StoreFailure("PATH_UNSAFE", "project artifact projection is not a regular file");
      const existingHash = await artifactSha256(createReadStream(target));
      if (existingHash.bytes !== artifact.bytes || existingHash.sha256 !== artifact.sha256) throw new StoreFailure("CONFLICT", "project artifact projection already contains different bytes");
      return false;
    }
    try {
      await link(blobPath, target);
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const existingHash = await artifactSha256(createReadStream(target));
      if (existingHash.bytes !== artifact.bytes || existingHash.sha256 !== artifact.sha256) throw new StoreFailure("CONFLICT", "project artifact projection already contains different bytes");
      return false;
    }
    return true;
  }

  private async existingExactBlob(blobPath: string, expected: ArtifactHash): Promise<boolean> {
    const existing = await this.safeStat(blobPath, "content-addressed blob", true);
    if (existing === undefined) return false;
    if (!existing.isFile()) throw new StoreFailure("PATH_UNSAFE", "content-addressed blob is not a regular file");
    if (existing.size !== expected.bytes) throw new StoreFailure("CORRUPT", "content-addressed blob has an unexpected size", { sha256: expected.sha256 });
    const hash = await artifactSha256(createReadStream(blobPath));
    if (hash.sha256 !== expected.sha256 || hash.bytes !== expected.bytes) throw new StoreFailure("CORRUPT", "content-addressed blob failed hash verification", { sha256: expected.sha256 });
    return true;
  }

  private async readBlobExact(blobPath: string, expectedBytes: number, expectedSha256: string): Promise<Buffer> {
    const file = await this.safeStat(blobPath, "content-addressed blob");
    if (file === undefined || !file.isFile() || file.size !== expectedBytes) throw new StoreFailure("CORRUPT", "stored artifact bytes are missing or have the wrong size", { expectedSha256 });
    await this.assertPathNoSymlink(blobPath, this.root);
    const bytes = await readFile(blobPath);
    const hash = await artifactSha256(bytes);
    if (hash.bytes !== expectedBytes || hash.sha256 !== expectedSha256) throw new StoreFailure("CORRUPT", "stored artifact bytes failed hash verification", { expectedSha256 });
    return bytes;
  }

  private async readArtifactRecord(artifactRevisionId: string): Promise<StoredArtifactRecord> {
    const path = this.artifactRecordPath(artifactRevisionId);
    const data = await this.readJson(path, "artifact record");
    const record = parseArtifactRecord(data);
    if (record.artifactRevisionId !== artifactRevisionId) throw new StoreFailure("CORRUPT", "artifact record ID does not match its path");
    return record;
  }

  private async tryReadArtifactRecord(artifactRevisionId: string): Promise<StoredArtifactRecord | undefined> {
    try {
      return await this.readArtifactRecord(artifactRevisionId);
    } catch (error: unknown) {
      if (error instanceof StoreFailure && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  }

  private async readSession(sessionId: string): Promise<StoredUploadSession> {
    const sessionPath = this.uploadSessionPath(sessionId);
    const data = await this.readJson(sessionPath, "upload session");
    const session = parseUploadSession(data);
    if (session.sessionId !== sessionId) throw new StoreFailure("CORRUPT", "upload session ID does not match its path");
    // Version 1 records written before explicit expiry support did not carry
    // expiresAt. Preserve their recoverability, but persist the derived value
    // immediately so later operations never need to re-infer a deadline.
    if (isRecord(data) && data.expiresAt === undefined) await this.writeJsonAtomic(sessionPath, session);
    return session;
  }

  private async assertOpenSession(session: StoredUploadSession): Promise<void> {
    if (session.status !== "open") {
      if (session.status === "expired") await this.reclaimExpiredPart(session);
      throw new StoreFailure("UPLOAD_STATE", `upload session is ${session.status}`, { sessionId: session.sessionId });
    }
    const now = this.nowMs();
    if (now < Date.parse(session.expiresAt)) return;
    await this.expireSession(session, now);
    throw new StoreFailure("UPLOAD_STATE", "upload session has expired", { sessionId: session.sessionId, expiresAt: session.expiresAt });
  }

  private async readManifestEnvelope(path: string): Promise<RevisionManifestEnvelope> {
    const data = asRecord(await this.readJson(path, "revision manifest"), "revision manifest envelope");
    const manifest = this.parseRevisionManifest(data.manifest);
    const sha256 = requiredString(data, "sha256", "revision manifest envelope");
    if (!SHA256_RE.test(sha256)) throw new StoreFailure("CORRUPT", "revision manifest envelope has an invalid hash");
    const created = manifestForHash(manifest);
    if (created.sha256 !== sha256) throw new StoreFailure("CORRUPT", "revision manifest envelope hash does not match content");
    return { manifest, sha256 };
  }

  private async tryReadManifestEnvelope(path: string): Promise<RevisionManifestEnvelope | undefined> {
    try {
      return await this.readManifestEnvelope(path);
    } catch (error: unknown) {
      if (error instanceof StoreFailure && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  }

  private parseRevisionManifest(value: unknown): RevisionManifest {
    const record = asRecord(value, "revision manifest");
    if (record.version !== 1) throw new StoreFailure("CORRUPT", "unsupported revision manifest version");
    const projectId = requiredString(record, "projectId", "revision manifest");
    const revisionId = requiredString(record, "revisionId", "revision manifest");
    const workItemId = optionalString(record, "workItemId");
    assertValidId(projectId, "projectId");
    assertValidId(revisionId, "revisionId");
    if (workItemId !== undefined) assertValidId(workItemId, "workItemId");
    if (!Array.isArray(record.entries)) throw new StoreFailure("CORRUPT", "revision manifest entries are invalid");
    const entries: RevisionManifestEntry[] = record.entries.map((value, index) => {
      const entry = asRecord(value, `revision manifest entry ${index}`);
      const artifactRevisionId = requiredString(entry, "artifactRevisionId", "revision manifest entry");
      const artifactId = requiredString(entry, "artifactId", "revision manifest entry");
      const filename = safeFilename(requiredString(entry, "filename", "revision manifest entry"));
      const sha256 = safeSha256(requiredString(entry, "sha256", "revision manifest entry")) as string;
      assertValidId(artifactRevisionId, "artifactRevisionId");
      assertValidId(artifactId, "artifactId");
      const role = optionalString(entry, "role");
      const mediaType = optionalString(entry, "mediaType");
      const bytes = requiredNumber(entry, "bytes", "revision manifest entry");
      const storageKey = requiredString(entry, "storageKey", "revision manifest entry");
      if (!storageKey.startsWith("blobs/sha256/") || !storageKey.endsWith(`/${sha256}`)) throw new StoreFailure("CORRUPT", "revision manifest storage key is invalid");
      return omitUndefined({ artifactRevisionId, artifactId, filename, role, mediaType, bytes, sha256, storageKey }) as RevisionManifestEntry;
    });
    const frozenAt = requiredString(record, "frozenAt", "revision manifest");
    if (Number.isNaN(Date.parse(frozenAt))) throw new StoreFailure("CORRUPT", "revision manifest frozenAt is invalid");
    return {
      version: 1,
      projectId,
      ...(workItemId === undefined ? {} : { workItemId }),
      revisionId,
      frozenAt,
      entries
    };
  }

  private validatePortableManifest(value: unknown): asserts value is StoredPortableBundleManifest {
    const record = asRecord(value, "portable bundle manifest");
    if (record.format !== "benchledger-artifact-bundle" || record.version !== 1) throw new StoreFailure("BUNDLE_INVALID", "unsupported portable bundle format");
    this.parseRevisionManifest(record.revisionManifest);
    if (!Array.isArray(record.files)) throw new StoreFailure("BUNDLE_INVALID", "portable bundle files are invalid");
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    for (const value of record.files) {
      const file = asRecord(value, "portable bundle file");
      const artifactRevisionId = requiredString(file, "artifactRevisionId", "portable bundle file");
      const relativePath = requiredString(file, "relativePath", "portable bundle file");
      const filename = safeFilename(requiredString(file, "filename", "portable bundle file"));
      const bytes = requiredNumber(file, "bytes", "portable bundle file");
      const sha256 = safeSha256(requiredString(file, "sha256", "portable bundle file")) as string;
      if (!ID_RE.test(artifactRevisionId) || seenIds.has(artifactRevisionId)) throw new StoreFailure("BUNDLE_INVALID", "portable bundle has duplicate artifact IDs");
      if (seenPaths.has(relativePath) || !relativePath.startsWith("files/") || relativePath.includes("\\") || relativePath.includes("/") && relativePath.split("/").some((part) => part === ".." || part === "")) throw new StoreFailure("BUNDLE_INVALID", "portable bundle file path is unsafe", { relativePath });
      if (basename(relativePath) !== relativePath.slice("files/".length)) throw new StoreFailure("BUNDLE_INVALID", "portable bundle file path must be one file segment", { relativePath });
      const entry = (record.revisionManifest as RevisionManifest).entries.find((candidate) => candidate.artifactRevisionId === artifactRevisionId);
      if (entry === undefined || entry.filename !== filename || entry.bytes !== bytes || entry.sha256 !== sha256) throw new StoreFailure("BUNDLE_INVALID", "portable bundle file does not match its revision entry", { artifactRevisionId });
      seenIds.add(artifactRevisionId);
      seenPaths.add(relativePath);
    }
    if (seenIds.size !== (record.revisionManifest as RevisionManifest).entries.length) throw new StoreFailure("BUNDLE_INVALID", "portable bundle is missing a revision entry file");
  }

  private uploadsDir(): string {
    return join(this.root, ".uploads");
  }

  private uploadPartPath(sessionId: string): string {
    assertValidId(sessionId, "sessionId");
    return join(this.uploadsDir(), `${sessionId}.part`);
  }

  private uploadSessionPath(sessionId: string): string {
    assertValidId(sessionId, "sessionId");
    return join(this.uploadsDir(), `${sessionId}.json`);
  }

  private artifactRecordsDir(): string {
    return join(this.root, "records", "artifacts");
  }

  private artifactRecordPath(artifactRevisionId: string): string {
    assertValidId(artifactRevisionId, "artifactRevisionId");
    return join(this.artifactRecordsDir(), `${artifactRevisionId}.json`);
  }

  private manifestPath(projectId: string, workItemId: string | undefined, revisionId: string): string {
    assertValidId(projectId, "projectId");
    assertValidId(revisionId, "revisionId");
    if (workItemId !== undefined) assertValidId(workItemId, "workItemId");
    return join(this.root, "records", "manifests", projectId, pathSegment(workItemId, "_project"), `${revisionId}.json`);
  }

  private blobPath(sha256: string): string {
    if (!SHA256_RE.test(sha256)) throw new StoreFailure("INVALID_INPUT", "sha256 must be a lowercase SHA-256 digest");
    return join(this.root, "blobs", "sha256", sha256.slice(0, 2), sha256);
  }

  private async ensureLayout(): Promise<void> {
    if (this.layoutPromise === undefined) {
      this.layoutPromise = (async () => {
        await mkdir(this.root, { recursive: true });
        await this.assertPathNoSymlink(this.root, this.root);
        const directories = [this.uploadsDir(), join(this.root, "blobs"), join(this.root, "blobs", "sha256"), join(this.root, "records"), this.artifactRecordsDir(), join(this.root, "records", "manifests"), join(this.root, "projects")];
        for (const directory of directories) {
          await this.assertPathNoSymlink(directory, this.root);
          await mkdir(directory, { recursive: true });
          await this.assertPathNoSymlink(directory, this.root);
        }
      })().catch((error: unknown) => {
        this.layoutPromise = undefined;
        throw error;
      });
    }
    await this.layoutPromise;
  }

  private async ensureProjectDirectory(projectId: string, workItemId: string | undefined, revisionId: string | undefined): Promise<void> {
    const components = [this.root, "projects", projectId];
    if (workItemId !== undefined) components.push(workItemId);
    if (revisionId !== undefined) components.push(revisionId);
    const path = join(...components);
    await this.assertPathNoSymlink(path, this.root);
    await mkdir(path, { recursive: true });
    await this.assertPathNoSymlink(path, this.root);
  }

  private async ensureBlobPrefix(sha256: string): Promise<void> {
    const prefix = join(this.root, "blobs", "sha256", sha256.slice(0, 2));
    await this.assertPathNoSymlink(prefix, this.root);
    await mkdir(prefix, { recursive: true });
    await this.assertPathNoSymlink(prefix, this.root);
  }

  private async openExclusive(path: string): Promise<FileHandle> {
    await this.assertPathNoSymlink(path, this.root);
    return open(path, "wx", 0o600);
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    await this.assertPathNoSymlink(parent, this.root);
    await this.assertPathNoSymlink(path, this.root);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await this.assertPathNoSymlink(temporary, this.root);
    const text = `${canonicalJson(value)}\n`;
    try {
      await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await this.safeUnlink(temporary);
    }
  }

  /** Write a JSON record atomically without replacing an existing record. */
  private async writeJsonExclusive(path: string, value: unknown): Promise<boolean> {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    await this.assertPathNoSymlink(parent, this.root);
    await this.assertPathNoSymlink(path, this.root);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await this.assertPathNoSymlink(temporary, this.root);
    const text = `${canonicalJson(value)}\n`;
    try {
      await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        await link(temporary, path);
        return true;
      } catch (error: unknown) {
        if (isNodeError(error, "EEXIST")) return false;
        throw error;
      }
    } finally {
      await this.safeUnlink(temporary);
    }
  }

  private async writeJsonAtomicExternal(path: string, value: unknown, base: string): Promise<void> {
    await this.assertExternalPathNoSymlink(path, base);
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    await this.assertExternalPathNoSymlink(parent, base);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await this.assertExternalPathNoSymlink(temporary, base);
    const text = `${canonicalJson(value)}\n`;
    try {
      await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      try {
        await unlink(temporary);
      } catch (error: unknown) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }

  private async readJson(path: string, label: string): Promise<unknown> {
    await this.assertPathNoSymlink(path, this.root);
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) throw new StoreFailure("NOT_FOUND", `${label} was not found`, { path: relative(this.root, path) });
      if (error instanceof SyntaxError) throw new StoreFailure("CORRUPT", `${label} is not valid JSON`);
      throw error;
    }
  }

  private async safeStat(path: string, label: string, optional = false): Promise<Stats | undefined> {
    await this.assertPathNoSymlink(path, this.root);
    try {
      return await lstat(path, { bigint: false });
    } catch (error: unknown) {
      if (optional && isNodeError(error, "ENOENT")) return undefined;
      if (isNodeError(error, "ENOENT")) throw new StoreFailure("NOT_FOUND", `${label} was not found`, { path: relative(this.root, path) });
      throw error;
    }
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await this.assertPathNoSymlink(path, this.root);
      await unlink(path);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }

  /** Reject symlinks in a generated store path, including a symlinked root. */
  private async assertPathNoSymlink(target: string, base: string): Promise<void> {
    const resolvedBase = resolve(base);
    const resolvedTarget = resolve(target);
    if (!isInside(resolvedBase, resolvedTarget)) throw new StoreFailure("PATH_UNSAFE", "generated path escapes artifact store");
    const relativePath = relative(resolvedBase, resolvedTarget);
    let current = resolvedBase;
    try {
      const baseStat = await lstat(current, { bigint: false });
      if (baseStat.isSymbolicLink()) throw new StoreFailure("PATH_UNSAFE", "symlink in artifact store path", { path: relative(this.root, current) });
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const parts = relativePath === "" ? [] : relativePath.split(sep);
    for (const part of parts) {
      current = join(current, part);
      let item;
      try {
        item = await lstat(current);
      } catch (error: unknown) {
        if (isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      if (item.isSymbolicLink()) throw new StoreFailure("PATH_UNSAFE", "symlink in artifact store path", { path: relative(this.root, current) });
    }
  }

  private async assertExternalPathNoSymlink(target: string, base: string): Promise<void> {
    const resolvedBase = resolve(base);
    const resolvedTarget = resolve(target);
    if (!isInside(resolvedBase, resolvedTarget)) throw new StoreFailure("PATH_UNSAFE", "bundle path escapes bundle root");
    await this.assertPathNoSymlink(resolvedTarget, resolvedBase);
  }

  private async safeStatExternal(path: string, label: string, optional = false): Promise<Stats | undefined> {
    const target = resolve(path);
    try {
      return await lstat(target, { bigint: false });
    } catch (error: unknown) {
      if (optional && isNodeError(error, "ENOENT")) return undefined;
      if (isNodeError(error, "ENOENT")) throw new StoreFailure("NOT_FOUND", `${label} was not found`);
      throw error;
    }
  }

  private async prepareEmptyDirectory(destination: string): Promise<void> {
    const existing = await this.safeStatExternal(destination, "bundle destination", true);
    if (existing !== undefined) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new StoreFailure("PATH_UNSAFE", "bundle destination must be a real directory");
      const contents = await readdir(destination);
      if (contents.length > 0) throw new StoreFailure("BUNDLE_EXISTS", "bundle destination is not empty");
      return;
    }
    await mkdir(destination, { recursive: true });
    await this.assertExternalPathNoSymlink(destination, dirname(destination));
  }

  private async getUsageUnsafe(): Promise<StoreUsage> {
    let uniqueBytes = 0;
    let blobCount = 0;
    const root = join(this.root, "blobs", "sha256");
    const prefixes = await readdir(root);
    for (const prefix of prefixes) {
      if (!/^[a-f0-9]{2}$/u.test(prefix)) throw new StoreFailure("CORRUPT", "unexpected content-addressed prefix", { prefix });
      const prefixPath = join(root, prefix);
      await this.assertPathNoSymlink(prefixPath, this.root);
      const names = await readdir(prefixPath);
      for (const name of names) {
        if (!SHA256_RE.test(name) || !name.startsWith(prefix)) throw new StoreFailure("CORRUPT", "unexpected content-addressed blob name", { name });
        const blob = join(prefixPath, name);
        const item = await this.safeStat(blob, "content-addressed blob");
        if (item === undefined || !item.isFile()) throw new StoreFailure("CORRUPT", "content-addressed entry is not a regular file", { name });
        uniqueBytes += item.size;
        blobCount += 1;
      }
    }
    let activeUploadBytes = 0;
    const sessions = await readdir(this.uploadsDir());
    for (const name of sessions) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      const session = await this.readSession(id);
      if (session.status !== "open") continue;
      const data = await this.safeStat(this.uploadPartPath(id), "upload data", true);
      activeUploadBytes += data?.isFile() ? data.size : 0;
    }
    return { uniqueBytes, blobCount, activeUploadBytes, maxStorageBytes: this.maxStorageBytes };
  }

  private async withSessionLock<T>(sessionId: string, action: () => Promise<Result<T>>): Promise<Result<T>> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    this.sessionLocks.set(sessionId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === current) this.sessionLocks.delete(sessionId);
    }
  }
}

function sameArtifactIdentity(a: ArtifactRevision, b: ArtifactRevision): boolean {
  return canonicalJson({
    artifactId: a.artifactId,
    artifactRevisionId: a.artifactRevisionId,
    projectId: a.projectId,
    workItemId: a.workItemId,
    revisionId: a.revisionId,
    filename: a.filename,
    mediaType: a.mediaType,
    role: a.role,
    description: a.description,
    source: a.source,
    bytes: a.bytes,
    sha256: a.sha256,
    storageKey: a.storageKey,
    projectPath: a.projectPath
  }) === canonicalJson({
    artifactId: b.artifactId,
    artifactRevisionId: b.artifactRevisionId,
    projectId: b.projectId,
    workItemId: b.workItemId,
    revisionId: b.revisionId,
    filename: b.filename,
    mediaType: b.mediaType,
    role: b.role,
    description: b.description,
    source: b.source,
    bytes: b.bytes,
    sha256: b.sha256,
    storageKey: b.storageKey,
    projectPath: b.projectPath
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
