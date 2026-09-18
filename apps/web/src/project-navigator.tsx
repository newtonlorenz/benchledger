import { useState } from "react";
import type { Project } from "./domain";
import { Icon } from "./icons";

/** A document navigator. All changes still pass through the app's draft guard. */
export function ProjectNavigator({ projects, selectedId, view, archivedCount, onSelect, onViewChange }: {
  projects: Project[];
  selectedId: string | undefined;
  view: "active" | "archived";
  archivedCount: number;
  onSelect(id: string): void;
  onViewChange(view: "active" | "archived"): void;
}) {
  const [query, setQuery] = useState("");
  const normalise = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const matches = projects.filter((project) => normalise(project.name).includes(normalise(query.trim())));
  return <section className="project-navigator" aria-label="Project navigator">
    <div className="navigator-heading"><strong>Projects</strong><span>{projects.length} loaded</span></div>
    <div className="project-view-switch" role="group" aria-label="Project view">
      <button type="button" aria-pressed={view === "active"} className={view === "active" ? "is-active" : ""} onClick={() => onViewChange("active")}>Active projects</button>
      <button type="button" aria-pressed={view === "archived"} className={view === "archived" ? "is-active" : ""} onClick={() => onViewChange("archived")}>Archived ({archivedCount})</button>
    </div>
    <label className="navigator-search"><Icon name="search" size={14} /><input aria-label="Filter project navigator" placeholder="Filter projects…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="navigator-projects">
      {matches.map((project) => <button type="button" key={project.id} className={`navigator-project ${project.id === selectedId ? "is-selected" : ""}`} aria-current={project.id === selectedId ? "page" : undefined} aria-label={`Switch to project ${project.name}`} title={project.name} onClick={() => onSelect(project.id)}>
        <Icon name="folder" size={16} /><span><strong>{project.name}</strong><small>{project.currentRevision} · {project.status}</small></span>
      </button>)}
      {!matches.length && <p className="navigator-empty">{query.trim() ? "No matching projects." : view === "archived" ? "No archived projects." : "Your projects will appear here."}</p>}
    </div>
    {query && <button type="button" className="text-button navigator-clear" onClick={() => setQuery("")}>Clear project filter</button>}
  </section>;
}
