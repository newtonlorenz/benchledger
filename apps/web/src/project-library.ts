import type { Artifact, Project } from "./domain";

/** Only images attached to a current project or work-item revision can be selected. */
export function currentBuildFiles(project: Project): Artifact[] {
  const revisions = new Map((project.workItems ?? []).map((item) => [item.id, item.currentRevisionId ?? item.currentRevision?.id]));
  return (project.allArtifacts ?? project.artifacts).filter((file) => file.status !== "superseded" &&
    (file.workItemId ? Boolean(file.workItemRevisionId) && revisions.get(file.workItemId) === file.workItemRevisionId
      : Boolean(project.serverRevisionId) && file.projectRevisionId === project.serverRevisionId));
}

export function productCover(project: Project): Artifact | undefined {
  const presentation = project.presentation;
  if (!presentation?.coverArtifactId || presentation.projectId !== project.id || presentation.projectRevisionId !== project.serverRevisionId) return undefined;
  return currentBuildFiles(project).find((file) => file.id === presentation.coverArtifactId && file.hash === presentation.coverSha256 && isProductImage(file));
}

export function isProductImage(file: Artifact): boolean {
  return ["image/png", "image/jpeg", "image/webp"].includes(file.mediaType ?? "") &&
    (file.byteSize ?? Infinity) <= 20 * 1024 * 1024;
}

