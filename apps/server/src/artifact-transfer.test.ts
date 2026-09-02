import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ArtifactTransferManager, TRANSFER_TOKEN_HEADER, transferTokenFromRequestHeader } from "./artifact-transfer.js";

function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function expectError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code} error`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("ArtifactTransferManager", () => {
  it("validates issuer limits and transfer input boundaries", () => {
    expect(() => new ArtifactTransferManager("http://maker.example", { uploadTtlMs: 0 })).toThrow(/uploadTtlMs/u);
    expect(() => new ArtifactTransferManager("http://maker.example", { downloadTtlMs: 5 * 60 * 1000 + 1 })).toThrow(/downloadTtlMs/u);
    const manager = new ArtifactTransferManager("http://maker.example/", { clock: () => 1_000 });
    const base = { uploadId: "upload-1", projectId: "project-1", expiresAt: new Date(2_000).toISOString(), byteLength: 1, sha256: "a".repeat(64), actor: "agent" };
    for (const input of [
      { ...base, uploadId: "../escape" },
      { ...base, projectId: "" },
      { ...base, byteLength: 0 },
      { ...base, byteLength: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, sha256: "A".repeat(64) },
      { ...base, expiresAt: "not-a-date" },
      { ...base, expiresAt: new Date(1_000).toISOString() },
    ]) {
      expect(() => manager.issueUpload(input)).toThrow();
    }
    const issued = manager.issueUpload(base);
    expect(() => transferTokenFromRequestHeader(undefined)).toThrow(/invalid/u);
    expect(() => transferTokenFromRequestHeader([issued.uploadHeaders[TRANSFER_TOKEN_HEADER]!])).toThrow(/invalid/u);
    expect(() => transferTokenFromRequestHeader("short-token")).toThrow(/invalid/u);
    expect(transferTokenFromRequestHeader(issued.uploadHeaders[TRANSFER_TOKEN_HEADER])).toHaveLength(43);
  });

  it("issues header-bound, separate upload and finalize capabilities", () => {
    let now = 1_000;
    const manager = new ArtifactTransferManager("https://maker.example:8792", { clock: () => now, uploadTtlMs: 100, downloadTtlMs: 100 });
    const body = new TextEncoder().encode("step-data");
    const issued = manager.issueUpload({ uploadId: "upload-1", projectId: "project-1", expiresAt: new Date(now + 500).toISOString(), byteLength: body.byteLength, sha256: digest(body), actor: "agent" });

    expect(issued.uploadUrl).toBe("https://maker.example:8792/api/v1/transfers/uploads/upload-1");
    expect(issued.finalizeUrl).toBe("https://maker.example:8792/api/v1/transfers/uploads/upload-1/finalize");
    expect(issued.uploadUrl).not.toContain("?");
    expect(issued.finalizeUrl).not.toContain("?");
    expect(issued.uploadHeaders).toHaveProperty(TRANSFER_TOKEN_HEADER);
    expect(issued.finalizeHeaders).toHaveProperty(TRANSFER_TOKEN_HEADER);
    expect(issued.uploadHeaders[TRANSFER_TOKEN_HEADER]).not.toBe(issued.finalizeHeaders[TRANSFER_TOKEN_HEADER]);
    expect(issued.expiresAt).toBe(new Date(now + 100).toISOString());
  });

  it("binds the authenticated actor to upload and finalize capabilities without exposing token fields", () => {
    let now = 1_000;
    const actor = "mcp-token:cad-agent";
    const manager = new ArtifactTransferManager("http://maker.example", { clock: () => now, uploadTtlMs: 1_000 });
    const body = new TextEncoder().encode("actor-bound");
    const issued = manager.issueUpload({ uploadId: "upload-1", projectId: "project-1", expiresAt: new Date(now + 2_000).toISOString(), byteLength: body.byteLength, sha256: digest(body), actor });
    const writeToken = issued.uploadHeaders[TRANSFER_TOKEN_HEADER];
    const finalizeToken = issued.finalizeHeaders[TRANSFER_TOKEN_HEADER];

    expect(manager.claimUploadWrite(writeToken, "upload-1", body)).toMatchObject({ actor });
    manager.releaseUploadWrite(writeToken, "upload-1");
    const claimed = manager.claimFinalize(finalizeToken, "upload-1", { byteLength: body.byteLength, sha256: digest(body) });
    expect(claimed).toMatchObject({ actor });
    expect(claimed).not.toHaveProperty("token");
    Object.assign(claimed, { actor: "attacker" });
    manager.releaseFinalize(finalizeToken, "upload-1");
    expect(manager.claimFinalize(finalizeToken, "upload-1", { byteLength: body.byteLength, sha256: digest(body) })).toMatchObject({ actor });
  });

  it("binds upload writes to the exact action, id, length, and digest", () => {
    let now = 1_000;
    const manager = new ArtifactTransferManager("http://maker.example", { clock: () => now, uploadTtlMs: 1_000 });
    const body = new TextEncoder().encode("step-data");
    const issued = manager.issueUpload({ uploadId: "upload-1", projectId: "project-1", expiresAt: new Date(now + 2_000).toISOString(), byteLength: body.byteLength, sha256: digest(body), actor: "agent" });
    const token = issued.uploadHeaders[TRANSFER_TOKEN_HEADER];

    expectError(() => manager.authorizeUploadWrite(token, "other-upload", body), "forbidden");
    expectError(() => manager.authorizeFinalize(token, "upload-1", { byteLength: body.byteLength, sha256: digest(body) }), "forbidden");

    const wrongLength = new TextEncoder().encode("wrong");
    expectError(() => manager.authorizeUploadWrite(token, "upload-1", wrongLength), "integrity_error");
    expect(manager.authorizeUploadWrite(token, "upload-1", body)).toMatchObject({ action: "upload_write", resourceId: "upload-1" });
    expectError(() => manager.authorizeUploadWrite(token, "upload-1", body), "forbidden");
  });

  it("preflights uploads before consuming the capability and rejects malformed headers", () => {
    let now = 1_000;
    const manager = new ArtifactTransferManager("http://maker.example", { clock: () => now, uploadTtlMs: 1_000 });
    const body = new TextEncoder().encode("step-data");
    const issued = manager.issueUpload({ uploadId: "upload-1", projectId: "project-1", expiresAt: new Date(now + 2_000).toISOString(), byteLength: body.byteLength, sha256: digest(body), actor: "agent" });
    const token = issued.uploadHeaders[TRANSFER_TOKEN_HEADER];
    expect(manager.preflightUploadWrite(token, "upload-1", undefined)).toMatchObject({ action: "upload_write" });
    expectError(() => manager.preflightUploadWrite(token, "upload-1", body.byteLength - 1), "integrity_error");
    expect(manager.preflight("upload_write", token, "upload-1")).toMatchObject({ resourceId: "upload-1" });
    expectError(() => manager.preflight("upload_finalize", token, "upload-1"), "forbidden");
    expectError(() => manager.preflight("upload_write", token, "bad/id"), "validation");
    manager.authorizeUploadWrite(token, "upload-1", body);
    expectError(() => manager.preflight("upload_write", token, "upload-1"), "forbidden");
  });

  it("keeps a write capability retryable until the durable write commits", () => {
    let now = 1_000;
    const manager = new ArtifactTransferManager("http://maker.example", { clock: () => now, uploadTtlMs: 1_000 });
    const body = new TextEncoder().encode("retryable-write");
    const issued = manager.issueUpload({ uploadId: "upload-1", projectId: "project-1", expiresAt: new Date(now + 2_000).toISOString(), byteLength: body.byteLength, sha256: digest(body), actor: "agent" });
    const token = issued.uploadHeaders[TRANSFER_TOKEN_HEADER];

    expect(manager.claimUploadWrite(token, "upload-1", body)).toMatchObject({ action: "upload_write", resourceId: "upload-1" });
    expectError(() => manager.claimUploadWrite(token, "upload-1", body), "forbidden");
    manager.releaseUploadWrite(token, "upload-1");
    expect(manager.claimUploadWrite(token, "upload-1", body)).toMatchObject({ action: "upload_write", resourceId: "upload-1" });
    manager.commitUploadWrite(token, "upload-1");
    expectError(() => manager.claimUploadWrite(token, "upload-1", body), "forbidden");
  });

  it("keeps finalize retryable until the durable operation commits", () => {
    let now = 1_000;
    const manager = new ArtifactTransferManager("http://maker.example", { clock: () => now, uploadTtlMs: 1_000 });
    const body = new TextEncoder().encode("step-data");
    const issued = manager.issueUpload({ uploadId: "upload-1", projectId: "project-1", expiresAt: new Date(now + 2_000).toISOString(), byteLength: body.byteLength, sha256: digest(body), actor: "agent" });
    const token = issued.finalizeHeaders[TRANSFER_TOKEN_HEADER];

    expectError(() => manager.authorizeFinalize(token, "upload-1", { byteLength: body.byteLength - 1, sha256: digest(body) }), "integrity_error");
    expect(manager.authorizeFinalize(token, "upload-1", { byteLength: body.byteLength, sha256: digest(body) })).toMatchObject({ action: "upload_finalize", resourceId: "upload-1" });
    manager.claimFinalize(token, "upload-1", { byteLength: body.byteLength, sha256: digest(body) });
    expectError(() => manager.claimFinalize(token, "upload-1", { byteLength: body.byteLength, sha256: digest(body) }), "forbidden");
    manager.releaseFinalize(token, "upload-1");
    manager.claimFinalize(token, "upload-1", { byteLength: body.byteLength, sha256: digest(body) });
    manager.commitFinalize(token, "upload-1");
    expectError(() => manager.claimFinalize(token, "upload-1", { byteLength: body.byteLength, sha256: digest(body) }), "forbidden");
  });

  it("releases only matching finalize claims and rejects invalid commits", () => {
    let now = 1_000;
    const manager = new ArtifactTransferManager("http://maker.example", { clock: () => now, uploadTtlMs: 1_000 });
    const body = new TextEncoder().encode("step-data");
    const issued = manager.issueUpload({ uploadId: "upload-1", projectId: "project-1", expiresAt: new Date(now + 2_000).toISOString(), byteLength: body.byteLength, sha256: digest(body), actor: "agent" });
    const token = issued.finalizeHeaders[TRANSFER_TOKEN_HEADER];
    const details = { byteLength: body.byteLength, sha256: digest(body) };
    manager.releaseFinalize(token, "upload-1");
    manager.claimFinalize(token, "upload-1", details);
    manager.releaseFinalize(token, "other-upload");
    expectError(() => manager.commitFinalize(token, "other-upload"), "forbidden");
    manager.commitFinalize(token, "upload-1");
    expect(() => manager.releaseFinalize(token, "upload-1")).not.toThrow();
  });

  it("enforces the exact expiry boundary and artifact binding for downloads", () => {
    let now = 1_000;
    const manager = new ArtifactTransferManager("http://maker.example", { clock: () => now, downloadTtlMs: 100 });
    const issued = manager.issueDownload({ artifactId: "artifact-1", projectId: "project-1", byteLength: 9, sha256: "a".repeat(64), actor: "agent" });
    const token = issued.requiredHeaders[TRANSFER_TOKEN_HEADER];
    expectError(() => manager.authorizeDownload(undefined, "artifact-1"), "forbidden");
    const capability = manager.authorizeDownload(token, "artifact-1");
    expectError(() => manager.authorizeDownload(token, "other-artifact"), "forbidden");
    expectError(() => manager.assertDownloadedArtifact(capability, { projectId: "other-project", byteSize: 9, sha256: "a".repeat(64) }), "forbidden");
    expect(() => manager.assertDownloadedArtifact(capability, { projectId: "project-1", byteSize: 9, sha256: "a".repeat(64) })).not.toThrow();

    now = 1_100;
    expectError(() => manager.authorizeDownload(token, "artifact-1"), "forbidden");
  });

  it("consumes a download capability after the first successful authorization", () => {
    const manager = new ArtifactTransferManager("https://maker.example", { clock: () => 1_000 });
    const issued = manager.issueDownload({ artifactId: "artifact-1", projectId: "project-1", byteLength: 9, sha256: "a".repeat(64), actor: "agent" });
    const token = issued.requiredHeaders[TRANSFER_TOKEN_HEADER];
    if (token === undefined) throw new Error("expected a download token");
    const capability = manager.authorizeDownload(token, "artifact-1");
    manager.assertDownloadedArtifact(capability, { projectId: "project-1", byteSize: 9, sha256: "a".repeat(64) });
    expectError(() => manager.authorizeDownload(token, "artifact-1"), "forbidden");
  });

  it("keeps a download capability retryable until the verified response commits", () => {
    const manager = new ArtifactTransferManager("https://maker.example", { clock: () => 1_000 });
    const issued = manager.issueDownload({ artifactId: "artifact-1", projectId: "project-1", byteLength: 9, sha256: "a".repeat(64), actor: "agent" });
    const token = issued.requiredHeaders[TRANSFER_TOKEN_HEADER];
    if (token === undefined) throw new Error("expected a download token");

    const claimed = manager.claimDownload(token, "artifact-1");
    expectError(() => manager.claimDownload(token, "artifact-1"), "forbidden");
    expectError(() => manager.assertDownloadedArtifact(claimed, { projectId: "project-1", byteSize: 8, sha256: "a".repeat(64) }), "forbidden");
    manager.releaseDownload(token, "artifact-1");
    const retry = manager.claimDownload(token, "artifact-1");
    manager.assertDownloadedArtifact(retry, { projectId: "project-1", byteSize: 9, sha256: "a".repeat(64) });
    manager.commitDownload(token, "artifact-1");
    expectError(() => manager.claimDownload(token, "artifact-1"), "forbidden");
  });

  it("validates finalize details, download tickets, and removes used capabilities", () => {
    let now = 1_000;
    const manager = new ArtifactTransferManager("http://maker.example", { clock: () => now, uploadTtlMs: 1_000, downloadTtlMs: 100 });
    const body = new TextEncoder().encode("step-data");
    const issued = manager.issueUpload({ uploadId: "upload-1", projectId: "project-1", expiresAt: new Date(now + 2_000).toISOString(), byteLength: body.byteLength, sha256: digest(body), actor: "agent" });
    const finalizeToken = issued.finalizeHeaders[TRANSFER_TOKEN_HEADER];
    expectError(() => manager.validateFinalize(finalizeToken, "upload-1", { byteLength: body.byteLength, sha256: "b".repeat(64) }), "integrity_error");
    expectError(() => manager.validateFinalize(finalizeToken, "upload-1", { byteLength: body.byteLength + 1, sha256: digest(body) }), "integrity_error");
    expectError(() => manager.authorizeDownload(issued.uploadHeaders[TRANSFER_TOKEN_HEADER], "upload-1"), "forbidden");
    manager.authorizeUploadWrite(issued.uploadHeaders[TRANSFER_TOKEN_HEADER], "upload-1", body);
    expectError(() => manager.authorizeUploadWrite(issued.uploadHeaders[TRANSFER_TOKEN_HEADER], "upload-1", body), "forbidden");
    const download = manager.issueDownload({ artifactId: "artifact-1", projectId: "project-1", byteLength: body.byteLength, sha256: digest(body), actor: "agent" });
    const downloadToken = download.requiredHeaders[TRANSFER_TOKEN_HEADER];
    expectError(() => manager.assertDownloadedArtifact(manager.authorizeDownload(downloadToken, "artifact-1"), { projectId: "project-1", byteSize: body.byteLength + 1, sha256: digest(body) }), "forbidden");
    now = 1_100;
    expectError(() => manager.authorizeDownload(downloadToken, "artifact-1"), "forbidden");
    // Issuing a new ticket also exercises cleanup of the already-used write capability.
    expect(manager.issueDownload({ artifactId: "artifact-2", projectId: "project-1", byteLength: 1, sha256: "c".repeat(64), actor: "agent" }).downloadUrl).toContain("artifact-2");
  });
});
