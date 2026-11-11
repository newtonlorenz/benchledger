import { describe, expect, it } from "vitest";
import { commandJsonSchema, projectLibraryQuerySchema, projectPresentationInputSchema, projectPresentationSchema } from "./index.js";

describe("project library and presentation contracts", () => {
  it("accepts deliberate image kinds and a versioned clear without identity or authority fields", () => {
    for (const imageKind of ["render", "reference", "built_photo"]) expect(projectPresentationInputSchema.parse({ expectedVersion: 0, coverArtifactId: "cover-one", imageKind, caption: "  Display only  " })).toMatchObject({ imageKind, caption: "Display only" });
    expect(projectPresentationInputSchema.parse({ expectedVersion: 3, coverArtifactId: null, imageKind: "render" }).coverArtifactId).toBeNull();
    for (const input of [
      { expectedVersion: -1, coverArtifactId: null, imageKind: "render" },
      { expectedVersion: 1.5, coverArtifactId: null, imageKind: "render" },
      { expectedVersion: 0, coverArtifactId: "bad/id", imageKind: "render" },
      { expectedVersion: 0, coverArtifactId: "cover", imageKind: "validated" },
      { expectedVersion: 0, coverArtifactId: "cover", imageKind: "render", manufactured: true },
      { expectedVersion: 0, coverArtifactId: "cover", imageKind: "render", projectId: "other-project" },
      { expectedVersion: 0, coverArtifactId: "cover", imageKind: "render", caption: "x".repeat(1001) }
    ]) expect(projectPresentationInputSchema.safeParse(input).success).toBe(false);
    expect(commandJsonSchema(projectPresentationInputSchema)).toMatchObject({ type: "object", additionalProperties: false });
  });
  it("bounds pages strictly and retains hash-bound presentation metadata", () => {
    expect(projectLibraryQuerySchema.parse({})).toEqual({ limit: 25, status: "active" });
    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { status: "complete" }, { cursor: "../private" }, { cursor: "x".repeat(2049) }, { q: "unadvertised" }]) expect(projectLibraryQuerySchema.safeParse(input).success).toBe(false);
    const presentation = { projectId: "project-one", projectRevisionId: "revision-one", version: 1, coverArtifactId: "cover-one", imageKind: "render", coverSha256: "a".repeat(64), updatedAt: "2026-09-01T10:00:00.000Z", updatedBy: "synthetic-agent", warnings: [] };
    expect(projectPresentationSchema.parse(presentation)).toEqual(presentation);
    expect(projectPresentationSchema.safeParse({ ...presentation, coverSha256: "invalid" }).success).toBe(false);
  });
});
