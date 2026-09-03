import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InventoryDrawer, ProjectExpertContext, ProjectFiles } from "./App";
import type { Artifact, Project } from "./domain";
import { inventory } from "./mock-data";
import { artifactIdentityLabel, artifactScopeChoices, artifactScopeIdentity, defaultArtifactScope, filterArtifactsForScope } from "./artifact-scope";

const project: Project = {
  id: "project-lamp",
  name: "Lamp",
  subtitle: "A lamp",
  description: "A revisioned lamp",
  status: "building",
  updated: "2026-09-02",
  currentRevision: "Current fit",
  workItem: "Legacy summary only",
  railStep: 1,
  bom: [],
  artifacts: [],
  notes: [],
  accent: "orange",
  serverRevisionId: "project-r7",
  projectRevisions: [{ id: "project-r7", number: 7, name: "Current fit", status: "concept" }],
  workItems: [
    { id: "work-legacy", name: "Unbound notes", kind: "notes" },
    { id: "work-body", name: "Body", kind: "part", currentRevisionId: "work-r3", currentRevision: { id: "work-r3", number: 3, name: "Body fit", status: "concept" } }
  ]
};

const artifact = (id: string, overrides: Partial<Artifact> = {}): Artifact => ({
  id,
  name: `${id}.step`,
  role: "STEP",
  revision: "r07",
  size: "10 B",
  hash: id.padEnd(64, "0"),
  updated: "2026-09-02",
  status: "candidate",
  ...overrides
});

describe("artifact scope selection", () => {
  it("defaults to the exact project revision independently of work-item ordering", () => {
    const choices = artifactScopeChoices(project);
    expect(defaultArtifactScope(project)).toEqual({ kind: "project", projectRevisionId: "project-r7" });
    expect(choices.map((choice) => choice.label)).toEqual([
      "Project · r07 · Current fit",
      "Work item · Body · r03 · Body fit",
      "Work item · Unbound notes · No current revision",
      "All files (read-only)"
    ]);
    expect(artifactScopeChoices(project, true).map((choice) => choice.label)).toEqual([
      "Project · r07 · Current fit · project-r7",
      "Work item · Body · work-body · r03 · Body fit · work-r3",
      "Work item · Unbound notes · work-legacy · No current revision",
      "All files (read-only)"
    ]);
    expect(choices[1]?.target).toEqual({ kind: "work-item", workItemId: "work-body", workItemRevisionId: "work-r3" });
    expect(choices[2]?.disabled).toBe(true);
    expect(choices[3]).toMatchObject({ readOnly: true, disabled: false, target: { kind: "all" } });
  });

  it("matches project and work-item ancestry exactly while retaining legacy files in All", () => {
    const files = [
      artifact("project-current", { projectRevisionId: "project-r7" }),
      artifact("project-old", { projectRevisionId: "project-r6" }),
      artifact("work-current", { workItemId: "work-body", workItemRevisionId: "work-r3" }),
      artifact("work-old", { workItemId: "work-body", workItemRevisionId: "work-r2" }),
      artifact("legacy")
    ];
    expect(filterArtifactsForScope(files, { kind: "project", projectRevisionId: "project-r7" }).map((file) => file.id)).toEqual(["project-current"]);
    expect(filterArtifactsForScope(files, { kind: "work-item", workItemId: "work-body", workItemRevisionId: "work-r3" }).map((file) => file.id)).toEqual(["work-current"]);
    expect(filterArtifactsForScope(files, { kind: "all" }).map((file) => file.id)).toEqual(files.map((file) => file.id));
    expect(artifactIdentityLabel(files[0]!)).toBe("Project revision");
    expect(artifactIdentityLabel(files[2]!)).toBe("Work item revision");
    expect(artifactIdentityLabel(files[4]!)).toBe("Not assigned to a revision");
    expect(artifactIdentityLabel(files[0]!, true)).toBe("Project · project-r7");
    expect(artifactIdentityLabel(files[2]!, true)).toBe("Work item · work-body · work-r3");
    expect(artifactIdentityLabel(files[4]!, true)).toBe("Unbound / legacy");
    expect(artifactScopeIdentity({ kind: "all" })).toBe("All files · read-only");
  });

  it("keeps raw artifact ancestry and hashes out of beginner file views", () => {
    const markup = renderToStaticMarkup(<ProjectFiles project={{ ...project, allArtifacts: [artifact("project-current", { projectRevisionId: "project-r7" }), artifact("legacy")] }} expert={false} sampleMode={false} onUpload={async () => undefined} />);
    expect(markup).toContain("Project · r07 · Current fit");
    expect(markup).toContain("Project revision");
    expect(markup).not.toContain("projectRevisionId=");
    expect(markup).not.toContain("Current fit · project-r7");
    expect(markup).not.toContain("Body · work-body");
    expect(markup).not.toContain("SHA-256");
    expect(markup).not.toContain("Unbound / legacy");
  });

  it("keeps the unassigned inventory label plain for beginners and diagnostic for experts", () => {
    const item = inventory.find((candidate) => candidate.categoryNodeId === undefined)!;
    const props = {
      item,
      categories: [],
      categoriesLoading: false,
      onClose: () => undefined,
      onCount: async () => item,
      onCommission: async () => item,
      onUpdate: async () => item
    };
    const beginnerMarkup = renderToStaticMarkup(<InventoryDrawer {...props} expert={false} />);
    expect(beginnerMarkup).toContain("Unassigned item");
    expect(beginnerMarkup).not.toContain("Unassigned legacy item");
    const expertMarkup = renderToStaticMarkup(<InventoryDrawer {...props} expert />);
    expect(expertMarkup).toContain("Unassigned legacy item");
  });

  it("renders real scope identity, disabled unrevisioned items, and hash evidence without a fabricated path", () => {
    const markup = renderToStaticMarkup(<ProjectFiles project={{ ...project, allArtifacts: [artifact("project-current", { projectRevisionId: "project-r7" }), artifact("legacy")] }} expert sampleMode={false} onUpload={async () => undefined} />);
    expect(markup).toContain("Project · r07 · Current fit · project-r7");
    expect(markup).toContain("Work item · Body · work-body · r03 · Body fit · work-r3");
    expect(markup).toContain("All files (read-only)");
    expect(markup).toContain("SHA-256");
    expect(markup).not.toContain("/work-items/");
    expect(markup).not.toContain("legacy-summary-only");
  });

  it("renders only real work-item identities in the expert sidebar context", () => {
    const markup = renderToStaticMarkup(<ProjectExpertContext project={project} />);
    expect(markup).toContain("Body · work-body · work-r3");
    expect(markup).toContain("Unbound notes · work-legacy · No current revision");
    expect(markup).not.toContain("project-lamp/work-item");
    const emptyMarkup = renderToStaticMarkup(<ProjectExpertContext project={{ ...project, workItems: [] }} />);
    expect(emptyMarkup).toContain("No work items recorded");
    expect(emptyMarkup).not.toContain("project-lamp/work-item");
  });
});
