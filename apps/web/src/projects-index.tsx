import type { MouseEvent } from "react";
import { Icon } from "./icons";
import { calculateProjectSummary } from "./domain";
import type { InventoryItem, Project, ProjectSummary } from "./domain";
import { projectLifecycleLabel } from "./workbench-home";

/** One plain line of what a project still needs, from loaded stock results. */
export function projectReadinessSummary(summary: ProjectSummary): string {
  if (summary.readinessUnavailable) return "Stock results unavailable";
  if (summary.totalLines === 0) return "No requirements yet";
  const parts = [
    summary.sourceLines ? `${summary.sourceLines} to buy` : "",
    summary.inspectLines ? `${summary.inspectLines} to check` : "",
    summary.decideLines ? `${summary.decideLines} to decide` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : `All ${summary.readyLines || summary.totalLines} ready to use`;
}

export interface ProjectsIndexProps {
  projects: readonly Project[];
  archivedProjects: readonly Project[];
  items: InventoryItem[];
  view: "active" | "archived";
  /** The project last open in this session, offered as Continue. */
  currentProjectId?: string | undefined;
  onOpen(projectId: string): void;
  onViewChange(view: "active" | "archived"): void;
  onNewProject(event: MouseEvent<HTMLButtonElement>): void;
}

/** The Projects destination: every project with its stage and what it still needs. */
export function ProjectsIndex({ projects, archivedProjects, items, view, currentProjectId, onOpen, onViewChange, onNewProject }: ProjectsIndexProps) {
  const rows = view === "archived" ? archivedProjects : projects;
  const current = currentProjectId ? [...projects, ...archivedProjects].find((project) => project.id === currentProjectId) : undefined;
  const listLabel = view === "archived" ? "Archived projects" : "Active projects";
  return <div className="projects-index">
    <div className="page-header"><div><div className="eyebrow">Workspace</div><h1>Projects</h1><p>Open a project to plan requirements, check stock or record what a build used.</p></div>
      <div className="header-actions">{current && <button type="button" className="button button-secondary" onClick={() => onOpen(current.id)}>Continue: {current.name}<Icon name="arrow-right" size={15} /></button>}<button type="button" className="button button-primary" onClick={onNewProject}><Icon name="plus" size={16} />New project</button></div>
    </div>
    <section className="surface projects-index-list-section" aria-labelledby="projects-index-heading">
      <div className="projects-index-toolbar"><h2 id="projects-index-heading" className="sr-only">{listLabel}</h2>
        <div className="project-view-switch" role="group" aria-label="Project view"><button type="button" aria-pressed={view === "active"} className={view === "active" ? "is-active" : ""} onClick={() => onViewChange("active")}>Active projects</button><button type="button" aria-pressed={view === "archived"} className={view === "archived" ? "is-active" : ""} onClick={() => onViewChange("archived")}>Archived ({archivedProjects.length})</button></div>
        <span className="projects-index-count">{rows.length} {rows.length === 1 ? "project" : "projects"}</span>
      </div>
      {rows.length === 0 ? <div className="empty-state"><span className="empty-icon"><Icon name="folder" size={23} /></span><h2>{view === "archived" ? "No archived projects" : "No projects yet"}</h2><p>{view === "archived" ? "Archived projects will appear here with their retained history." : "Enter a project name and goal. Then add requirements and files."}</p>{view === "active" && <button type="button" className="button button-secondary" onClick={onNewProject}>Create first project<Icon name="arrow-right" size={15} /></button>}</div>
        : <ul className="projects-index-list" aria-label={listLabel}>{rows.map((project) => {
          const summary = calculateProjectSummary(project, items);
          const isCurrent = project.id === current?.id;
          return <li key={project.id} className={`projects-index-row${isCurrent ? " is-current" : ""}`}>
            <button type="button" className="projects-index-open" onClick={() => onOpen(project.id)} aria-label={`Open project ${project.name}`}><strong>{project.name}</strong>{project.subtitle && <small>{project.subtitle}</small>}</button>
            <span className={`register-stage register-stage-${project.status}`}>{projectLifecycleLabel(project.status)}</span>
            <span className={`projects-index-readiness${summary.sourceLines || summary.inspectLines || summary.decideLines ? " needs-work" : ""}`}>{projectReadinessSummary(summary)}</span>
            <span className="projects-index-updated">Updated {project.updated}{isCurrent && <span className="projects-index-current"> · Current</span>}</span>
            <Icon name="arrow-right" size={15} />
          </li>;
        })}</ul>}
      <p className="projects-index-note">Counts use loaded stock records. Physical builds still need their own checks.</p>
    </section>
  </div>;
}
