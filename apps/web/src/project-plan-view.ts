import type { Project } from "./domain";
import type { RequirementFilter } from "./project-editing";

/** Legacy deep links remain valid within the four stable project sections. */
export function projectPrimaryTab(tab: string): "overview" | "plan" | "files" | "build" {
  if (tab === "overview" || tab === "files") return tab;
  if (tab === "plan" || tab === "offers") return "plan";
  return "build";
}

/** Session-only browsing state, separate from requirement drafts and canonical readiness. */
export interface ProjectPlanViewState {
  projectId: string;
  revisionId: string | undefined;
  query: string;
  filter: RequirementFilter;
  handledTaskRequest?: number | undefined;
  handledAddedPartId?: string;
  dismissedAddedPartId?: string;
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
