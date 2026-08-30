import { createHash, randomBytes } from "node:crypto";
import { ApplicationError } from "@benchledger/application";
import type { ArtifactTransferProvider } from "@benchledger/mcp";

/**
 * Transfer credentials are deliberately separate from API/MCP bearer tokens.
 * They are short-lived, single-purpose, and only the SHA-256 digest of the
 * random value is retained by this process. The plaintext exists only in the
 * response header returned to the caller.
 */
export const TRANSFER_TOKEN_HEADER = "x-bench-transfer-token";

export const TRANSFER_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

export type TransferAction = "upload_write" | "upload_finalize" | "artifact_download";

interface Capability {
  readonly action: TransferAction;
  /** Stable authenticated actor captured when the capability is issued. */
  readonly actor: string;
  readonly resourceId: string;
  readonly projectId: string;
  readonly expectedByteLength: number;
  readonly expectedSha256: string;
  readonly expiresAt: number;
  used: boolean;
  inFlight: boolean;
}

type CapabilityInput = Omit<Capability, "used" | "inFlight">;

export interface TransferCapability {
  readonly action: TransferAction;
  /** Stable authenticated actor captured when the capability is issued. */
  readonly actor: string;
  readonly resourceId: string;
  readonly projectId: string;
  readonly expectedByteLength: number;
  readonly expectedSha256: string;
  readonly expiresAt: number;
}

export interface ArtifactTransferManagerOptions {
  readonly clock?: () => number;
  readonly uploadTtlMs?: number;
  readonly downloadTtlMs?: number;
}

export interface FinalizeCapabilityBody {
  readonly sha256: string;
  readonly byteLength: number;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_UPLOAD_TTL_MS = 15 * 60 * 1000;
const DEFAULT_DOWNLOAD_TTL_MS = 5 * 60 * 1000;
const MAX_UPLOAD_TTL_MS = 15 * 60 * 1000;
const MAX_DOWNLOAD_TTL_MS = 5 * 60 * 1000;

function invalid(message: string): never {
  throw new ApplicationError("validation", message);
}

function forbidden(message = "The transfer capability is invalid or no longer valid"): never {
  throw new ApplicationError("forbidden", message);
}

function expired(): never {
  throw new ApplicationError("upload_expired", "The transfer capability has expired");
}

function validateId(value: string, label: string): string {
  if (!ID.test(value)) invalid(`${label} is invalid`);
  return value;
}

function validateSha256(value: string, label: string): string {
  if (!SHA256.test(value)) invalid(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function validateByteLength(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${label} must be a positive safe integer`);
  return value;
}

function validateActor(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
  return value;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function capabilityHeader(token: string): Readonly<Record<string, string>> {
  return { [TRANSFER_TOKEN_HEADER]: token };
}

function capabilityUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

function tokenFromHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value) || value === undefined || !TOKEN.test(value)) forbidden();
  return value;
}

/**
 * Host-owned issuer and verifier for MCP artifact transfer links. This is an
 * in-memory store by design: a process restart invalidates outstanding links,
 * which is safer than accidentally making a stale transfer capability durable.
 */
export class ArtifactTransferManager implements ArtifactTransferProvider {
  private readonly capabilities = new Map<string, Capability>();
  private readonly clock: () => number;
  private readonly uploadTtlMs: number;
  private readonly downloadTtlMs: number;
  private readonly baseUrl: string;

  public constructor(baseUrl: string, options: ArtifactTransferManagerOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/u, "");
    this.clock = options.clock ?? Date.now;
    this.uploadTtlMs = positiveTtl(options.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS, MAX_UPLOAD_TTL_MS, "uploadTtlMs");
    this.downloadTtlMs = positiveTtl(options.downloadTtlMs ?? DEFAULT_DOWNLOAD_TTL_MS, MAX_DOWNLOAD_TTL_MS, "downloadTtlMs");
  }

  issueUpload(input: {
    uploadId: string;
    projectId: string;
    expiresAt: string;
    byteLength: number;
    sha256: string;
    actor: string;
  }): {
    uploadUrl: string;
    uploadHeaders: Readonly<Record<string, string>>;
    finalizeUrl: string;
    finalizeHeaders: Readonly<Record<string, string>>;
    expiresAt: string;
  } {
    const uploadId = validateId(input.uploadId, "uploadId");
    const projectId = validateId(input.projectId, "projectId");
    const actor = validateActor(input.actor, "actor");
    const byteLength = validateByteLength(input.byteLength, "byteLength");
    const sha256 = validateSha256(input.sha256, "sha256");
    const requestedExpiry = Date.parse(input.expiresAt);
    const now = this.clock();
    if (!Number.isFinite(requestedExpiry) || requestedExpiry <= now) expired();
    const expiresAt = Math.min(requestedExpiry, now + this.uploadTtlMs, now + MAX_UPLOAD_TTL_MS);
    const write = this.issueCapability({ action: "upload_write", actor, resourceId: uploadId, projectId, expectedByteLength: byteLength, expectedSha256: sha256, expiresAt });
    const finalize = this.issueCapability({ action: "upload_finalize", actor, resourceId: uploadId, projectId, expectedByteLength: byteLength, expectedSha256: sha256, expiresAt });
    const expiresAtIso = new Date(expiresAt).toISOString();
    return {
      uploadUrl: capabilityUrl(this.baseUrl, `/api/v1/transfers/uploads/${encodeURIComponent(uploadId)}`),
      uploadHeaders: capabilityHeader(write.token),
      finalizeUrl: capabilityUrl(this.baseUrl, `/api/v1/transfers/uploads/${encodeURIComponent(uploadId)}/finalize`),
      finalizeHeaders: capabilityHeader(finalize.token),
      expiresAt: expiresAtIso,
    };
  }

  issueDownload(input: {
    artifactId: string;
    projectId: string;
    byteLength: number;
    sha256: string;
    actor: string;
  }): {
    downloadUrl: string;
    requiredHeaders: Readonly<Record<string, string>>;
    expiresAt: string;
  } {
    const artifactId = validateId(input.artifactId, "artifactId");
    const projectId = validateId(input.projectId, "projectId");
    const actor = validateActor(input.actor, "actor");
    const byteLength = validateByteLength(input.byteLength, "byteLength");
    const sha256 = validateSha256(input.sha256, "sha256");
    const expiresAt = this.clock() + this.downloadTtlMs;
    const capability = this.issueCapability({ action: "artifact_download", actor, resourceId: artifactId, projectId, expectedByteLength: byteLength, expectedSha256: sha256, expiresAt });
    return {
      downloadUrl: capabilityUrl(this.baseUrl, `/api/v1/transfers/artifacts/${encodeURIComponent(artifactId)}/download`),
      requiredHeaders: capabilityHeader(capability.token),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  authorizeUploadWrite(tokenHeader: string | string[] | undefined, uploadId: string, body: Uint8Array): TransferCapability {
    // Compatibility helper for callers that still perform a single synchronous
    // write. The transfer route uses claim/commit/release below so a transient
    // storage failure does not burn the ticket.
    const capability = this.claimUploadWrite(tokenHeader, uploadId, body);
    this.commitUploadWrite(tokenHeader, uploadId);
    return capability;
  }

  /**
   * Claim a write capability while its durable byte write is in progress.
   * Body length and digest are checked before changing one-shot state, and the
   * claim must be committed or released by the caller.
   */
  claimUploadWrite(tokenHeader: string | string[] | undefined, uploadId: string, body: Uint8Array): TransferCapability {
    const token = tokenFromHeader(tokenHeader);
    const resourceId = validateId(uploadId, "uploadId");
    const capability = this.validateUploadWrite(token, resourceId, body);
    const stored = this.capabilities.get(hashToken(token));
    if (stored === undefined || stored.used || stored.inFlight) forbidden("The transfer capability has already been used");
    stored.inFlight = true;
    return { ...capability };
  }

  /** Consume a claimed write capability after the durable byte write commits. */
  commitUploadWrite(tokenHeader: string | string[] | undefined, uploadId: string): void {
    const token = tokenFromHeader(tokenHeader);
    const resourceId = validateId(uploadId, "uploadId");
    const digest = hashToken(token);
    const stored = this.capabilities.get(digest);
    if (stored === undefined || stored.action !== "upload_write" || stored.resourceId !== resourceId || stored.inFlight !== true) forbidden();
    stored.inFlight = false;
    stored.used = true;
    this.capabilities.delete(digest);
  }

  /** Release an in-flight write claim after a failed durable operation. */
  releaseUploadWrite(tokenHeader: string | string[] | undefined, uploadId: string): void {
    const token = tokenFromHeader(tokenHeader);
    const resourceId = validateId(uploadId, "uploadId");
    const stored = this.capabilities.get(hashToken(token));
    if (stored?.action === "upload_write" && stored.resourceId === resourceId && stored.inFlight === true) {
      stored.inFlight = false;
    }
  }

  /** Validate write bytes without changing one-shot capability state. */
  private validateUploadWrite(token: string, resourceId: string, body: Uint8Array): TransferCapability {
    const capability = this.peek(token, "upload_write", resourceId);
    if (body.byteLength !== capability.expectedByteLength) {
      throw new ApplicationError("integrity_error", "Uploaded byte length does not match the transfer capability");
    }
    const actualSha256 = createHash("sha256").update(body).digest("hex");
    if (actualSha256 !== capability.expectedSha256) {
      throw new ApplicationError("integrity_error", "Uploaded SHA-256 does not match the transfer capability");
    }
    return capability;
  }

  /**
   * Authenticate a transfer request before Fastify parses or buffers its
   * body. The returned capability is a read-only snapshot; one-shot state is
   * claimed only after the small finalize body or the verified upload bytes
   * have passed their integrity checks.
   */
  preflight(action: TransferAction, tokenHeader: string | string[] | undefined, resourceId: string): TransferCapability {
    const token = tokenFromHeader(tokenHeader);
    const capability = this.peek(token, action, validateId(resourceId, "resourceId"));
    const stored = this.capabilities.get(hashToken(token));
    if ((action === "upload_write" || action === "upload_finalize") && (stored?.used === true || stored?.inFlight === true)) {
      forbidden("The transfer capability has already been used");
    }
    return capability;
  }

  preflightUploadWrite(tokenHeader: string | string[] | undefined, uploadId: string, contentLength: number | undefined): TransferCapability {
    const capability = this.preflight("upload_write", tokenHeader, uploadId);
    if (contentLength !== undefined && contentLength !== capability.expectedByteLength) {
      throw new ApplicationError("integrity_error", "Uploaded byte length does not match the transfer capability");
    }
    return capability;
  }

  /** Validate finalize details without consuming the capability. */
  validateFinalize(tokenHeader: string | string[] | undefined, uploadId: string, body: FinalizeCapabilityBody): TransferCapability {
    const capability = this.preflight("upload_finalize", tokenHeader, uploadId);
    if (body.byteLength !== capability.expectedByteLength || body.sha256 !== capability.expectedSha256) {
      throw new ApplicationError("integrity_error", "Finalize details do not match the transfer capability");
    }
    const stored = this.capabilities.get(hashToken(tokenFromHeader(tokenHeader)));
    if (stored?.used === true || stored?.inFlight === true) forbidden("The transfer capability has already been used");
    return capability;
  }

  /**
   * Claim a finalize capability while its durable operation is in progress.
   * A claim is intentionally distinct from consumption so a failed audit or
   * SQLite commit can release the capability and let the caller retry.
   */
  claimFinalize(tokenHeader: string | string[] | undefined, uploadId: string, body: FinalizeCapabilityBody): TransferCapability {
    const token = tokenFromHeader(tokenHeader);
    const capability = this.validateFinalize(token, uploadId, body);
    const stored = this.capabilities.get(hashToken(token));
    if (stored === undefined) forbidden();
    stored.inFlight = true;
    return { ...capability };
  }

  /** Consume a claimed finalize capability after the durable operation commits. */
  commitFinalize(tokenHeader: string | string[] | undefined, uploadId: string): void {
    const token = tokenFromHeader(tokenHeader);
    const resourceId = validateId(uploadId, "uploadId");
    const stored = this.capabilities.get(hashToken(token));
    if (stored === undefined || stored.action !== "upload_finalize" || stored.resourceId !== resourceId || stored.inFlight !== true) forbidden();
    stored.inFlight = false;
    stored.used = true;
    this.capabilities.delete(hashToken(token));
  }

  /** Release an in-flight claim after a failed durable operation. */
  releaseFinalize(tokenHeader: string | string[] | undefined, uploadId: string): void {
    const token = tokenFromHeader(tokenHeader);
    const resourceId = validateId(uploadId, "uploadId");
    const digest = hashToken(token);
    const stored = this.capabilities.get(digest);
    if (stored?.action === "upload_finalize" && stored.resourceId === resourceId && stored.inFlight === true) {
      stored.inFlight = false;
    }
  }

  authorizeFinalize(tokenHeader: string | string[] | undefined, uploadId: string, body: FinalizeCapabilityBody): TransferCapability {
    // Kept as a compatibility alias for integrations that only need to
    // validate finalize details. New callers must claim and commit explicitly
    // around the durable operation.
    return this.validateFinalize(tokenHeader, uploadId, body);
  }

  authorizeDownload(tokenHeader: string | string[] | undefined, artifactId: string): TransferCapability {
    return this.peek(tokenFromHeader(tokenHeader), "artifact_download", artifactId);
  }

  assertDownloadedArtifact(capability: TransferCapability, artifact: { projectId: string; byteSize: number; sha256: string }): void {
    if (artifact.projectId !== capability.projectId || artifact.byteSize !== capability.expectedByteLength || artifact.sha256 !== capability.expectedSha256) {
      forbidden();
    }
  }

  private issueCapability(input: CapabilityInput): { token: string; capability: TransferCapability } {
    this.removeExpired();
    const token = randomBytes(32).toString("base64url");
    const capability: Capability = { ...input, used: false, inFlight: false };
    this.capabilities.set(hashToken(token), capability);
    return { token, capability: { ...input } };
  }

  private take(token: string, action: TransferAction, resourceId: string): TransferCapability {
    const capability = this.find(token, action, resourceId);
    if (capability.used || capability.inFlight) forbidden("The transfer capability has already been used");
    capability.used = true;
    return { ...capability };
  }

  private peek(token: string, action: TransferAction, resourceId: string): TransferCapability {
    const capability = this.find(token, action, resourceId);
    return { ...capability };
  }

  private find(token: string, action: TransferAction, resourceId: string): Capability {
    const capability = this.capabilities.get(hashToken(token));
    if (capability === undefined || capability.action !== action || capability.resourceId !== resourceId) forbidden();
    if (this.clock() >= capability.expiresAt) {
      this.capabilities.delete(hashToken(token));
      expired();
    }
    return capability;
  }

  private removeExpired(): void {
    const now = this.clock();
    for (const [digest, capability] of this.capabilities) {
      // A claimed finalize may finish after its TTL. It is still bounded by
      // the claim made before expiry and must be released/committed explicitly
      // rather than stranded by a later capability issuance.
      if (capability.used || (!capability.inFlight && capability.expiresAt <= now)) this.capabilities.delete(digest);
    }
  }
}

function positiveTtl(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) invalid(`${label} must be a positive duration no greater than ${maximum}ms`);
  return value;
}

export function transferTokenFromRequestHeader(value: string | string[] | undefined): string {
  return tokenFromHeader(value);
}
