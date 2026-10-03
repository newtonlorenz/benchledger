import type { Project } from "./domain";
import type { RequirementFilter } from "./project-editing";

/** Session-only browsing state, separate from requirement drafts and canonical readiness. */
export interface ProjectPlanViewState {
  projectId: string;
  revisionId: string | undefined;
  query: string;
  filter: RequirementFilter;
  handledTaskRequest?: number | undefined;
}

export function projectPlanView(project: Project, saved?: ProjectPlanViewState): ProjectPlanViewState {
  if (saved?.projectId === project.id && saved.revisionId === project.serverRevisionId) return saved;
  return {
    projectId: project.id,
    revisionId: project.serverRevisionId,
    query: "",
    filter: "all",
    // A task already handled on the preceding revision is not a new navigation request.
    ...(saved?.projectId === project.id ? { handledTaskRequest: saved.handledTaskRequest } : {})
  };
}
