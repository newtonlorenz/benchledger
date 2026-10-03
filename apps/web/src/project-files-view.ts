import { artifactScopeChoices, artifactScopeKey, defaultArtifactScope } from "./artifact-scope";
import type { Project } from "./domain";

/** Browsing preferences only. File objects and pending uploads stay in the Files panel. */
export interface ProjectFilesViewState {
  projectId: string;
  revisionId: string | undefined;
  scopeKey: string;
  query: string;
}

export function projectFilesView(project: Project, saved?: ProjectFilesViewState): ProjectFilesViewState {
  const fallback: ProjectFilesViewState = {
    projectId: project.id,
    revisionId: project.serverRevisionId,
    scopeKey: artifactScopeKey(defaultArtifactScope(project)),
    query: ""
  };
  if (!saved || saved.projectId !== project.id || saved.revisionId !== project.serverRevisionId) return fallback;
  return artifactScopeChoices(project).some(choice => choice.key === saved.scopeKey && !choice.disabled) ? saved : fallback;
}
