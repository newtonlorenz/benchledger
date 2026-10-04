import { describe, expect, it } from "vitest";
import type { BuildPlan } from "@benchledger/api-contract";
import type { Artifact, Project } from "./domain";
import { projects } from "./mock-data";
import { buildFileGroup, buildPlanChecks, currentBuildFiles, preferredPrintFile, productCover } from "./project-library";

const file = (id: string, patch: Partial<Artifact> = {}): Artifact => ({ id, name: `${id}.3mf`, role: "Build plate", revision: "r01", hash: "a".repeat(64), size: "1 KB", updated: "2026-10-03", status: "candidate", projectRevisionId: "current", ...patch });
const unbound = (id: string, patch: Partial<Artifact> = {}) => { const value = file(id, patch); delete value.projectRevisionId; return value; };
const project = (files: Artifact[]): Project => ({ ...structuredClone(projects[0]!), id: "fixture", serverRevisionId: "current", artifacts: [], allArtifacts: files, workItems: [{ id: "pcb", name: "PCB", kind: "pcb", currentRevisionId: "pcb-current" }] });

describe("revision-safe product and build handoff", () => {
  it("excludes historical, retired and unbound files while keeping current work-item files", () => {
    const data = project([file("current"), file("old", { projectRevisionId: "old" }), file("retired", { status: "superseded" }), unbound("unbound"), unbound("board", { name: "controller.kicad_pcb", workItemId: "pcb", workItemRevisionId: "pcb-current" }), unbound("old-board", { workItemId: "pcb", workItemRevisionId: "pcb-old" })]);
    expect(currentBuildFiles(data).map((entry) => entry.id)).toEqual(["current", "board"]);
    expect(preferredPrintFile(data)?.id).toBe("current");
  });
  it("only uses the deliberately selected image with matching revision, hash and supported format", () => {
    const image = file("render", { name: "product.png", role: "Photo", mediaType: "image/png", byteSize: 200 });
    const data = project([image]);
    expect(productCover(data)).toBeUndefined();
    data.presentation = { projectId: data.id, projectRevisionId: "current", version: 1, coverArtifactId: image.id, coverSha256: image.hash, imageKind: "render", updatedAt: "2026-10-03T10:00:00Z", updatedBy: "fixture", warnings: [] };
    expect(productCover(data)).toEqual(image);
    data.presentation.coverSha256 = "b".repeat(64); expect(productCover(data)).toBeUndefined();
    data.presentation.coverSha256 = image.hash; data.presentation.projectRevisionId = "old"; expect(productCover(data)).toBeUndefined();
    data.presentation.projectRevisionId = "current"; image.mediaType = "image/svg+xml"; expect(productCover(data)).toBeUndefined();
    image.mediaType = "image/png"; image.byteSize = 21 * 1024 * 1024; expect(productCover(data)).toBeUndefined();
  });
  it("groups printable, board, component and instruction files without labelling a photo as a build file", () => {
    expect(buildFileGroup(file("plate"))).toBe("print");
    expect(buildFileGroup(file("board", { name: "controller.kicad_pcb", role: "Editable CAD" }))).toBe("board");
    expect(buildFileGroup(file("exports", { name: "gerbers.zip", role: "File" }))).toBe("board");
    expect(buildFileGroup(file("body", { name: "body.step", role: "STEP" }))).toBe("components");
    expect(buildFileGroup(file("instructions", { name: "assembly.md", role: "Notes" }))).toBe("instructions");
    expect(buildFileGroup(file("schematic", { name: "schematic.svg", role: "Drawing" }))).toBe("instructions");
    expect(buildFileGroup(file("manifest", { name: "manifest.json", role: "Document" }))).toBe("instructions");
    expect(buildFileGroup(file("photo", { name: "product.png", role: "Photo" }))).toBeUndefined();
  });
  it("adds stale-source checks to the MCP plan's unresolved warnings", () => {
    const data = project([file("current")]);
    const plan = { projectId: data.id, projectRevisionId: "current", warnings: ["Review supports"], artifactBasis: [{ id: "old", sha256: "a".repeat(64) }, { id: "current", sha256: "b".repeat(64) }] } as BuildPlan;
    expect(buildPlanChecks(data, plan)).toEqual(["Review supports", "A file in the plan is no longer current. Review the plan against the current files."]);
    plan.projectRevisionId = "old";
    expect(buildPlanChecks(data, plan)).toContain("This plan belongs to another revision. Refresh the current build plan.");
  });
});
