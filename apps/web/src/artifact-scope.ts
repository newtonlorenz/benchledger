import type { Artifact, Project, ProjectRevisionReference, ProjectWorkItem } from "./domain";

/**
 * Uploads have one of two writable ancestry shapes.  The all-files view is a
 * deliberate read-only inspection mode and can never be sent to the API.
 */
export type ArtifactUploadTarget =
  | { readonly kind: "project"; readonly projectRevisionId: string }
  | { readonly kind: "work-item"; readonly workItemId: string; readonly workItemRevisionId: string };

export type ArtifactScope = ArtifactUploadTarget | { readonly kind: "all" };

export interface ArtifactScopeChoice {
  readonly key: string;
  readonly label: string;
  readonly target: ArtifactScope;
  readonly disabled: boolean;
  readonly readOnly: boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function revisionIdFor(reference: ProjectRevisionReference | undefined, fallback: string | undefined): string | undefined {
  return nonEmpty(reference?.id) ?? nonEmpty(fallback);
}

function revisionLabel(reference: ProjectRevisionReference | undefined, revisionId: string | undefined, expert: boolean): string {
  if (reference?.name?.trim()) return reference.number === undefined ? reference.name.trim() : `r${String(reference.number).padStart(2, "0")} · ${reference.name.trim()}`;
  if (reference?.number !== undefined) return `r${String(reference.number).padStart(2, "0")}`;
  return expert ? revisionId ?? "No current revision" : revisionId ? "Current revision" : "No current revision";
}

function projectRevisionReference(project: Project): ProjectRevisionReference | undefined {
  const id = nonEmpty(project.serverRevisionId);
  return project.projectRevisions?.find((reference) => reference.id === id)
    ?? (id ? { id, name: project.currentRevision } : undefined);
}

function workItemRevisionReference(item: ProjectWorkItem): ProjectRevisionReference | undefined {
  return item.currentRevision;
}

/**
 * Build the visible scope picker in a deterministic order.  The project
 * revision is always first and is the default when it exists.  Work items are
 * listed by their own identity and current revision; an item without a
 * current revision remains visible but disabled so the user can see why it
 * cannot receive a file yet.
 */
export function artifactScopeChoices(project: Project, expert = false): readonly ArtifactScopeChoice[] {
  const projectRevision = projectRevisionReference(project);
  const projectRevisionId = revisionIdFor(projectRevision, project.serverRevisionId);
  const projectChoice: ArtifactScopeChoice = {
    key: projectRevisionId === undefined ? "project:none" : `project:${projectRevisionId}`,
    label: projectRevisionId === undefined
      ? "Project · No current revision"
      : `Project · ${revisionLabel(projectRevision, projectRevisionId, expert)}${expert ? ` · ${projectRevisionId}` : ""}`,
    target: projectRevisionId === undefined ? { kind: "all" } : { kind: "project", projectRevisionId },
    disabled: projectRevisionId === undefined,
    readOnly: false,
  };

  const workItemChoices = [...(project.workItems ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((item): ArtifactScopeChoice => {
      const revision = workItemRevisionReference(item);
      const workItemRevisionId = revisionIdFor(revision, item.currentRevisionId);
      return {
        key: workItemRevisionId === undefined ? `work-item:${item.id}:none` : `work-item:${item.id}:${workItemRevisionId}`,
        label: workItemRevisionId === undefined
          ? `Work item · ${item.name}${expert ? ` · ${item.id}` : ""} · No current revision`
          : `Work item · ${item.name}${expert ? ` · ${item.id}` : ""} · ${revisionLabel(revision, workItemRevisionId, expert)}${expert ? ` · ${workItemRevisionId}` : ""}`,
        target: workItemRevisionId === undefined
          ? { kind: "all" }
          : { kind: "work-item", workItemId: item.id, workItemRevisionId },
        disabled: workItemRevisionId === undefined,
        readOnly: false,
      };
    });

  return [projectChoice, ...workItemChoices, {
    key: "all",
    label: "All files (read-only)",
    target: { kind: "all" },
    disabled: false,
    readOnly: true,
  }];
}

/** Use the project current revision as the deterministic initial target. */
export function defaultArtifactScope(project: Project): ArtifactScope {
  const projectRevisionId = nonEmpty(project.serverRevisionId);
  return projectRevisionId === undefined ? { kind: "all" } : { kind: "project", projectRevisionId };
}

export function artifactScopeKey(scope: ArtifactScope): string {
  if (scope.kind === "project") return `project:${scope.projectRevisionId}`;
  if (scope.kind === "work-item") return `work-item:${scope.workItemId}:${scope.workItemRevisionId}`;
  return "all";
}

/** A plain-language identity for the currently visible scope. */
export function artifactScopeIdentity(scope: ArtifactScope, expert = false): string {
  if (scope.kind === "project") return expert ? `Project · ${scope.projectRevisionId}` : "Project revision";
  if (scope.kind === "work-item") return expert ? `Work item · ${scope.workItemId} · ${scope.workItemRevisionId}` : "Work item revision";
  return "All files · read-only";
}

/** Display the durable ancestry carried by one artifact row. */
export function artifactIdentityLabel(artifact: Artifact, expert = false): string {
  if (artifact.workItemId !== undefined && artifact.workItemRevisionId !== undefined) {
    return expert ? `Work item · ${artifact.workItemId} · ${artifact.workItemRevisionId}` : "Work item revision";
  }
  if (artifact.projectRevisionId !== undefined) return expert ? `Project · ${artifact.projectRevisionId}` : "Project revision";
  return expert ? "Unbound / legacy" : "Not assigned to a revision";
}

export function artifactMatchesScope(artifact: Artifact, scope: ArtifactScope): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "project") return artifact.workItemId === undefined && artifact.projectRevisionId === scope.projectRevisionId;
  return artifact.workItemId === scope.workItemId && artifact.workItemRevisionId === scope.workItemRevisionId;
}

export function filterArtifactsForScope(artifacts: readonly Artifact[], scope: ArtifactScope): Artifact[] {
  return artifacts.filter((artifact) => artifactMatchesScope(artifact, scope));
}
