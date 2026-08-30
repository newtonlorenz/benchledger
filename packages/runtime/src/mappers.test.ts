import { describe, expect, it } from "vitest";
import type { UploadSession as StoreUploadSession } from "@benchledger/artifacts";
import { apiUploadSessionFromStore } from "./mappers.js";

describe("upload session mapping", () => {
  it("passes through the persisted expiry instead of deriving one from creation time", () => {
    const session: StoreUploadSession = {
      sessionId: "session-1",
      status: "open",
      projectId: "project-1",
      filename: "part.step",
      artifactId: "artifact-1",
      artifactRevisionId: "artifact-revision-1",
      bytesWritten: 0,
      createdAt: "2026-08-30T10:00:00.000Z",
      expiresAt: "2026-08-30T10:02:00.000Z",
      updatedAt: "2026-08-30T10:01:00.000Z"
    };

    expect(apiUploadSessionFromStore(session, 100)).toMatchObject({
      id: "session-1",
      expiresAt: "2026-08-30T10:02:00.000Z",
      maxBytes: 100,
      status: "pending"
    });
  });
});
