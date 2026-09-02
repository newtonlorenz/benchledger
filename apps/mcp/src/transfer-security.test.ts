import { describe, expect, it, vi } from "vitest";
import type { ApplicationService } from "@benchledger/application";
import { createApplicationBackend } from "./application-backend.js";
import { McpAdapter } from "./adapter.js";
import { McpProtocol } from "./protocol.js";
import type { BenchLedgerBackend, McpRequestContext } from "./types.js";

const context: McpRequestContext = {
  actorId: "transfer-security-test",
  scopes: ["artifacts:read", "artifacts:write"],
};

function serviceFixture(): ApplicationService & {
  beginArtifactUpload: ReturnType<typeof vi.fn>;
  getArtifact: ReturnType<typeof vi.fn>;
} {
  return {
    beginArtifactUpload: vi.fn(async () => {
      throw new Error("service must not be reached");
    }),
    getArtifact: vi.fn(async () => {
      throw new Error("service must not be reached");
    }),
  } as unknown as ApplicationService & {
    beginArtifactUpload: ReturnType<typeof vi.fn>;
    getArtifact: ReturnType<typeof vi.fn>;
  };
}

const uploadInput = {
  projectId: "project-1",
  projectRevisionId: "project-revision-1",
  filename: "part.step",
  role: "step",
  mediaType: "model/step",
  byteLength: 100,
  sha256: "a".repeat(64),
};

describe("artifact transfer model boundary", () => {
  it("fails closed before creating a session, audit, or capability and ignores the legacy issuer", async () => {
    const service = serviceFixture();
    const issuer = {
      issueUpload: vi.fn(() => ({ uploadUrl: "https://maker.test/upload", uploadHeaders: { authorization: "secret" }, finalizeUrl: "https://maker.test/finalize", finalizeHeaders: { authorization: "secret" }, expiresAt: "2026-08-30T10:15:00.000Z" })),
      issueDownload: vi.fn(() => ({ downloadUrl: "https://maker.test/download?token=secret", requiredHeaders: { authorization: "secret" }, expiresAt: "2026-08-30T10:15:00.000Z" })),
    };
    const backend = createApplicationBackend(service, { artifactTransfer: issuer });

    await expect(backend.artifacts.beginUpload(uploadInput, context)).rejects.toMatchObject({
      code: "HOST_TRANSFER_UNAVAILABLE",
      message: "Artifact transfer is unavailable through generic MCP; use the authenticated browser/HTTP Files flow.",
    });
    await expect(backend.artifacts.downloadMetadata({ artifactId: "artifact-1" }, context)).rejects.toMatchObject({
      code: "HOST_TRANSFER_UNAVAILABLE",
      message: "Artifact transfer is unavailable through generic MCP; use the authenticated browser/HTTP Files flow.",
    });

    expect(service.beginArtifactUpload).not.toHaveBeenCalled();
    expect(service.getArtifact).not.toHaveBeenCalled();
    expect(issuer.issueUpload).not.toHaveBeenCalled();
    expect(issuer.issueDownload).not.toHaveBeenCalled();
  });

  it("returns a fixed redacted error through MCP without backend details", async () => {
    const unsafeValue = "https://maker.test/transfers/upload-1?token=redacted-marker";
    const service = serviceFixture();
    const adapter = new McpAdapter(createApplicationBackend(service, {
      artifactTransfer: {
        issueUpload: vi.fn(() => { throw new Error(unsafeValue); }),
        issueDownload: vi.fn(() => { throw new Error(unsafeValue); }),
      },
    }));
    const result = await adapter.callTool("begin_artifact_upload", uploadInput, context);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "HOST_TRANSFER_UNAVAILABLE",
          message: "Artifact transfer is unavailable through generic MCP; use the authenticated browser/HTTP Files flow.",
        },
      },
    });
    expect(result.structuredContent?.error).not.toHaveProperty("details");
    expect(JSON.stringify(result)).not.toContain(unsafeValue);
  });

  it("rejects transfer URLs, headers, bearer values, and _meta from an untrusted backend", async () => {
    const payloads = [
      { uploadUrl: "https://maker.test/transfers/upload-1" },
      { requiredHeaders: { authorization: "secret" } },
      { diagnostic: "a".repeat(43) },
      { diagnostic: { nested: "https://maker.test/hidden-transfer" } },
      { _meta: { authorization: "secret" } },
    ];
    for (const payload of payloads) {
      const backend = { artifacts: { beginUpload: async () => payload } } as unknown as BenchLedgerBackend;
      const result = await new McpAdapter(backend).callTool("begin_artifact_upload", uploadInput, context);
      expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "HOST_TRANSFER_UNAVAILABLE" } } });
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(JSON.stringify(result)).not.toContain("maker.test");
    }
  });

  it("strips custom backend error messages and details from transfer JSON-RPC results", async () => {
    const unsafeValue = "bearer-redacted-marker-should-not-escape";
    const backend = {
      artifacts: {
        beginUpload: async () => { throw Object.assign(new Error(unsafeValue), { code: "FORBIDDEN", details: { authorization: unsafeValue } }); },
      },
    } as unknown as BenchLedgerBackend;
    const response = await new McpProtocol(new McpAdapter(backend), { context }).handle({
      jsonrpc: "2.0", id: "redacted-transfer-error", method: "tools/call", params: {
        name: "begin_artifact_upload",
        arguments: uploadInput,
      },
    });

    expect(response).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "HOST_TRANSFER_UNAVAILABLE" } } } });
    expect(JSON.stringify(response)).not.toContain(unsafeValue);
    expect(JSON.stringify(response)).not.toContain("details");
  });
});
