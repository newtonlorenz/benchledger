import { calculateProjectSummary } from "./domain";
import type { InventoryItem, Project } from "./domain";
import { Icon } from "./icons";
export function WorkbenchMetrics({ projects, items }: { projects: Project[]; items: InventoryItem[] }) {
  const active = projects.filter((project) => project.status !== "archived" && project.status !== "complete");
  const summaries = active.map((project) => calculateProjectSummary(project, items));
  const unknown = summaries.some((summary) => summary.readinessUnavailable);
  const checks = summaries.reduce((sum, summary) => sum + summary.checkLines, 0);
  const source = summaries.reduce((sum, summary) => sum + summary.sourceLines, 0);
  return <section className="workbench-metrics" aria-label="Loaded workspace summary">
    {[{ label: "Active projects", value: active.length, detail: "In this workspace view", icon: "folder" as const }, { label: "Inventory records", value: items.length, detail: "Loaded stock records", icon: "box" as const }, { label: "Stock checks", value: unknown ? "?" : checks, detail: unknown ? "Refresh stock results" : "Required lines to check", icon: "tool" as const }, { label: "Source gaps", value: unknown ? "?" : source, detail: unknown ? "Refresh stock results" : "Required lines to source", icon: "tag" as const }].map((metric, index) => <div className="workbench-metric" key={metric.label}><div><span>{metric.label}</span><Icon name={metric.icon} size={16} /></div><strong>{metric.value}</strong><small><span className={`metric-tick metric-tick-${index}`} />{metric.detail}</small></div>)}
  </section>;
}
export function WorkbenchRegister({ projects, items, onOpen }: { projects: Project[]; items: InventoryItem[]; onOpen(id: string): void }) {
  const visible = projects.filter((project) => project.status !== "archived");
  return <section className="surface project-register" aria-label="Project register"><div className="register-heading"><div><span className="eyebrow">Project register</span><h2>Current projects</h2></div><span className="register-count">{visible.length} loaded</span></div>
    {visible.length ? <div className="register-rows">{visible.map((project) => { const summary = calculateProjectSummary(project, items); const required = project.bom.filter((line) => !line.optional).length; const ready = summary.lineStatuses.filter((line) => !line.line.optional && line.decision === "ready").length; const percentage = !summary.readinessUnavailable && required > 0 ? Math.round(ready / required * 100) : 0; return <button className="register-row" type="button" key={project.id} onClick={() => onOpen(project.id)} aria-label={`Open project ${project.name}`}><span className="register-project-icon"><Icon name="folder" size={19} /></span><span className="register-project-name"><strong>{project.name}</strong><small>{project.currentRevision} · {project.bom.length} requirements</small></span><span className={`register-stage register-stage-${project.status}`}>{project.status}</span><span className="register-progress"><span>{summary.readinessUnavailable ? "Stock results unavailable" : required ? `${ready}/${required} stock-ready` : "No requirements"}</span><span className="register-progress-track" aria-hidden="true"><span style={{ width: `${percentage}%` }} /></span></span><Icon name="arrow-up-right" size={16} /></button>; })}</div> : <div className="register-empty"><Icon name="folder" size={24} /><strong>No projects yet</strong><p>Create a project to add requirements and files.</p></div>}
    <div className="register-footnote"><Icon name="info" size={14} /><span>Stock readiness does not confirm design or build validation.</span></div>
  </section>;
}
