import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import type { InventoryItem, Project } from "./domain";
import { deriveHomeProjects, filterHomeProjects, readHomePreferences, writeHomePreferences } from "./workbench-state";
import type { HomeFilter, HomePreferences, HomeProject, HomeTask, HomeTaskKind } from "./workbench-state";
export interface WorkbenchHomeProps {
  projects: Project[]; items: InventoryItem[]; printers: InventoryItem[]; sampleMode: boolean; isPrinterUsable?: ((item: InventoryItem) => boolean) | undefined;
  onOpen(id: string, tab?: "plan" | "files" | "offers" | "reconciliation"): void;
  onTask(task: HomeTask): void; onNewProject(event: React.MouseEvent<HTMLButtonElement>): void;
  onAddItem(): void; onImport?: (() => void) | undefined; onInventory(): void; onItem(id: string): void;
  onRefresh?: (() => Promise<boolean>) | undefined;
}
/** Readable project lifecycle label. Kept here (not imported from App) to avoid a circular module import. */
export function projectLifecycleLabel(status: Project["status"]): string {
  const labels: Record<Project["status"], string> = { idea: "Idea", planned: "Planned", ready: "Ready", building: "Building", validating: "Validating", complete: "Complete", archived: "Archived" };
  return labels[status];
}
/** A queue entry. Generic setup tasks shared by several projects collapse into one entry. */
export interface HomeQueueEntry { id: string; kind: HomeTaskKind; label: string; detail: string; projects: string[]; task: HomeTask }
const taskPriority: Record<HomeTaskKind, number> = { refresh: 0, check: 1, source: 2, decide: 3, requirements: 4, setup: 5, files: 6, review: 7 };
const groupedKinds: ReadonlySet<HomeTaskKind> = new Set(["refresh", "setup", "requirements", "files"]);
const taskIcon = (kind: HomeTaskKind): IconName => kind === "check" ? "tool" : kind === "source" ? "tag" : kind === "files" ? "file" : kind === "refresh" ? "refresh" : kind === "setup" ? "sliders" : "clipboard";
/** Pick the single most useful next task: blocking stock work first, then the most recently opened project. */
export function nextBestTask(tasks: readonly HomeTask[], recent: readonly string[]): HomeTask | undefined {
  const rank = (id: string) => { const index = recent.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  return [...tasks].sort((a, b) => taskPriority[a.kind] - taskPriority[b.kind] || rank(a.projectId) - rank(b.projectId))[0];
}
/** Deduplicate the attention queue so "Set build approach" appears once, not once per project. */
export function groupHomeTasks(tasks: readonly HomeTask[]): HomeQueueEntry[] {
  const entries: HomeQueueEntry[] = [], groups = new Map<string, HomeQueueEntry>();
  for (const task of tasks) {
    if (!groupedKinds.has(task.kind)) { entries.push({ id: task.id, kind: task.kind, label: task.label, detail: task.detail, projects: [task.projectName], task }); continue; }
    const key = `${task.kind}:${task.label}`, existing = groups.get(key);
    if (existing) { existing.projects.push(task.projectName); continue; }
    const entry: HomeQueueEntry = { id: `group:${key}`, kind: task.kind, label: task.label, detail: task.detail, projects: [task.projectName], task };
    groups.set(key, entry); entries.push(entry);
  }
  return entries;
}
const projectList = (names: readonly string[]) => names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
export function WorkbenchHome(props: WorkbenchHomeProps) {
  const { projects, items, sampleMode } = props;
  const [preferences, setPreferences] = useState(() => readHomePreferences(sampleMode));
  const [query, setQuery] = useState(""); const [limit, setLimit] = useState(12);
  const [taskKind, setTaskKind] = useState<"all" | "check" | "source">("all");
  const [refreshing, setRefreshing] = useState(false), [refreshError, setRefreshError] = useState(false);
  const taskRef = useRef<HTMLElement>(null);
  const [queueLimit, setQueueLimit] = useState(8);
  useEffect(() => setQueueLimit(8), [taskKind]);
  const rows = useMemo(() => deriveHomeProjects(projects, items), [projects, items]);
  const filtered = filterHomeProjects(rows, query, preferences);
  const tasks = rows.flatMap((row) => row.tasks);
  const queue = groupHomeTasks(tasks.filter((task) => taskKind === "all" || task.kind === taskKind));
  const recent = preferences.recent.map((id) => rows.find((row) => row.project.id === id)).find((row) => row && row.project.status !== "complete");
  const next = nextBestTask(tasks, preferences.recent);
  useEffect(() => { setPreferences(readHomePreferences(sampleMode)); }, [sampleMode]);
  const update = (patch: Partial<HomePreferences>) => { setLimit(12); setPreferences((current) => { const next = { ...current, ...patch }; writeHomePreferences(next, sampleMode); return next; }); };
  const pin = (id: string) => update({ pins: preferences.pins.includes(id) ? preferences.pins.filter((value) => value !== id) : [...preferences.pins, id].slice(-100) });
  const refresh = async () => { if (!props.onRefresh || refreshing) return; setRefreshing(true); setRefreshError(false); try { setRefreshError(!await props.onRefresh()); } catch { setRefreshError(true); } finally { setRefreshing(false); } };
  const counts: Record<HomeFilter, number> = { all: rows.length, active: rows.filter((row) => row.project.status !== "complete").length, attention: rows.filter((row) => row.tasks.length).length, complete: rows.filter((row) => row.project.status === "complete").length, pinned: rows.filter((row) => preferences.pins.includes(row.project.id)).length };
  return <div className="home-workspace">
    <header className="home-heading"><div><span className="eyebrow">Workbench</span><h1>Workspace overview</h1><p>Resume a project. Check stock. Plan the next build.</p></div><div className="home-actions"><button type="button" className="button button-quiet" onClick={props.onAddItem}><Icon name="box" size={16} />Add inventory</button>{props.onImport && <button type="button" className="button button-secondary" onClick={props.onImport}><Icon name="upload" size={16} />Import BOM</button>}<button type="button" className="button button-primary" onClick={props.onNewProject}><Icon name="plus" size={16} />New project</button></div></header>
    {!rows.length ? <section className="surface home-onboarding"><span className="eyebrow">Start a workspace</span><h2>Create a project or import its requirements</h2><p>Add inventory when you have stock to record. You do not need a printer to start.</p><div><span><strong>1. Define</strong>Name the project and its required result.</span><span><strong>2. Plan</strong>Add requirements or review a BOM import.</span><span><strong>3. Check</strong>Confirm stock, then review the missing parts.</span></div></section> : <section className={`home-next ${next ? `home-next-${next.kind}` : "is-clear"}`} aria-label="Next best action">
      <span className="home-next-mark"><Icon name={next ? taskIcon(next.kind) : "check-circle"} size={18} /></span>
      <span className="home-next-copy"><span className="eyebrow">Next step</span>{next ? <><strong>{next.label} <span>· {next.projectName}</span></strong><small>{next.detail}</small></> : <><strong>Nothing needs attention</strong><small>Every active project has its requirements and stock reviewed.</small></>}</span>
      <span className="home-next-summary"><button type="button" className="text-button" onClick={() => update({ filter: "active" })}>{counts.active} active</button><span aria-hidden="true">·</span><button type="button" className="text-button" onClick={() => { update({ filter: "attention" }); }}>{counts.attention} need attention</button></span>
      {next && <button type="button" className="button button-primary home-next-action" onClick={() => props.onTask(next)} aria-label={`${next.label}: ${next.projectName}`}>{next.label}<Icon name="arrow-right" size={15} /></button>}
    </section>}
    {rows.some((row) => row.unknown && row.project.status !== "complete") && <p role="status" className="home-results-warning">Some stock results are unavailable. Check and sourcing counts exclude those projects. Refresh the workspace before using stock.</p>}
    {recent && <section className="home-resume" aria-label="Resume recent project"><Icon name="clock" size={18} /><span><small>Last opened in this browser</small><strong>{recent.project.name}</strong></span><span className="home-resume-revision">Revision {recent.project.currentRevision}</span><button type="button" className="button button-secondary" onClick={() => props.onOpen(recent.project.id)}>Resume project<Icon name="arrow-right" size={15} /></button></section>}
    <div className="home-work-grid"><section className="surface home-projects" aria-label="Project register"><div className="home-section-title"><h2>Your projects</h2>{props.onRefresh && <button type="button" className="text-button" disabled={refreshing} onClick={() => { void refresh(); }}><Icon name="refresh" size={15} />{refreshing ? "Refreshing…" : "Refresh workspace"}</button>}</div>
      {refreshError && <p role="alert" className="home-read-error">The workspace could not refresh. The previous records remain visible. Retry before using stock.</p>}
      <div className="home-project-filters" role="group" aria-label="Filter projects">{([["active", "Active"], ["attention", "Needs attention"], ["pinned", "Pinned"], ["complete", "Complete"], ["all", "All"]] as [HomeFilter, string][]).map(([filter, label]) => <button type="button" key={filter} aria-pressed={preferences.filter === filter} className={preferences.filter === filter ? "is-selected" : ""} onClick={() => update({ filter })}>{label}<span>{counts[filter]}</span></button>)}</div>
      <div className="home-project-toolbar"><label className="field-search"><Icon name="search" size={16} /><input aria-label="Find a project" placeholder="Find a project" value={query} onChange={(event) => { setQuery(event.target.value.slice(0, 200)); setLimit(12); }} /></label><label className="home-sort"><span>Sort</span><select aria-label="Sort projects" value={preferences.sort} onChange={(event) => update({ sort: event.target.value as HomePreferences["sort"] })}><option value="recent">Recent first</option><option value="name">Name</option><option value="attention">Open checks</option></select></label></div>
      <div className="home-project-list">{filtered.slice(0, limit).map((row) => <HomeProjectRow key={row.project.id} row={row} pinned={preferences.pins.includes(row.project.id)} onPin={() => pin(row.project.id)} onOpen={() => props.onOpen(row.project.id)} onTask={props.onTask} />)}</div>
      {!filtered.length && <div className="home-filter-empty"><Icon name="folder" size={23} /><strong>{rows.length ? "No projects match this view" : "No projects yet"}</strong><p>{rows.length ? "Change the filter or clear the search." : "Use New project or Import BOM to start."}</p>{rows.length > 0 && <button type="button" className="text-button" onClick={() => { setQuery(""); update({ filter: "all" }); }}>Show all projects</button>}</div>}
      <div className="home-list-footer"><span>{Math.min(limit, filtered.length)} of {filtered.length} matching projects</span>{filtered.length > limit && <button type="button" className="text-button" onClick={() => setLimit((value) => value + 12)}>Show more projects</button>}</div>
    </section>
    <aside className="home-right-column">
      <section className="surface home-task-queue" ref={taskRef} tabIndex={-1} aria-label="Workspace attention queue"><div className="home-section-title"><h2>Needs attention</h2><span>{queue.length} {queue.length === 1 ? "task" : "tasks"}</span></div>
        <div className="home-queue-filters" role="group" aria-label="Filter attention queue">{([["all", "All tasks"], ["check", "Stock checks"], ["source", "Sourcing"]] as const).map(([kind, label]) => <button key={kind} type="button" aria-pressed={taskKind === kind} onClick={() => setTaskKind(kind)}>{label}</button>)}</div>
        {queue.length ? queue.slice(0, queueLimit).map((entry) => <button type="button" className={`home-task home-task-${entry.kind}`} key={entry.id} onClick={() => props.onTask(entry.task)} aria-label={`${entry.label}: ${entry.projects.length > 1 ? `${entry.projects.length} projects` : entry.task.projectName}`}><span className="home-task-mark"><Icon name={taskIcon(entry.kind)} size={16} /></span><span><strong>{entry.label}</strong><small>{entry.projects.length > 1 ? `${entry.projects.length} projects: ${projectList(entry.projects)}` : entry.task.projectName}</small><span>{entry.projects.length > 1 ? `Opens ${entry.task.projectName} first.` : entry.detail}</span></span><Icon name="arrow-right" size={15} /></button>) : <div className="home-queue-empty"><Icon name="check-circle" size={22} /><strong>{tasks.length ? "No tasks in this view" : "No open planning checks"}</strong><p>{tasks.length ? "Select All tasks to review other work." : "Stock planning is up to date. Physical builds still need their own checks."}</p></div>}
        {queue.length > queueLimit && <div className="home-queue-footnote"><button type="button" className="text-button" onClick={() => setQueueLimit((value) => value + 8)}>Show more tasks</button></div>}
      </section>
      <section className="surface home-equipment" aria-label="Workshop equipment"><div className="home-section-title"><h2>Workshop equipment</h2><Icon name="printer" size={18} /></div>
        {props.printers.length ? props.printers.slice(0, 3).map((item) => <button type="button" className="workshop-printer-card" key={item.id} onClick={() => props.onItem(item.id)}><span><strong>{item.name}</strong><small>{props.isPrinterUsable?.(item) === false ? "Needs stock or product setup check" : item.catalogProduct?.buildVolumeMm ? `${item.catalogProduct.buildVolumeMm.x} × ${item.catalogProduct.buildVolumeMm.y} × ${item.catalogProduct.buildVolumeMm.z} mm build volume` : "Open recorded equipment details"}</small></span><Icon name="arrow-up-right" size={15} /></button>) : <p>No owned printers recorded. Electronics and ready-made builds do not need a printer.</p>}
        <button type="button" className="text-button" onClick={props.onInventory}>Manage inventory<Icon name="arrow-right" size={15} /></button>
      </section>
    </aside></div>
    <WorkbenchBoundaries />
  </div>;
}
/** The single place that lists what BenchLedger never does, instead of repeating it on every panel. */
export function WorkbenchBoundaries() {
  return <details className="home-boundaries">
    <summary><Icon name="info" size={15} />What BenchLedger never does</summary>
    <ul>
      <li><strong>Never buys anything.</strong> Quotes, totals and shopping lists are plans. You place every order yourself.</li>
      <li><strong>Never changes stock by looking.</strong> Viewing, planning, catalog matches and previews leave quantities and reservations unchanged. Stock changes only when a stock update is recorded and confirmed.</li>
      <li><strong>Never confirms ownership or fit.</strong> A catalog match or “stock-ready” count is not proof that you own a part, that it fits or that a build works. Physical checks stay with you.</li>
      <li><strong>Never runs your machines.</strong> It does not start printers, heat hardware, send print jobs or flash firmware.</li>
      <li><strong>Keeps view settings local.</strong> Pins, recent projects and appearance are saved in this browser only.</li>
    </ul>
  </details>;
}
function HomeProjectRow({ row, pinned, onPin, onOpen, onTask }: { row: HomeProject; pinned: boolean; onPin(): void; onOpen(): void; onTask(task: HomeTask): void }) {
  const { project, tasks } = row;
  const task = tasks[0];
  return <article className="home-project-row">
    <button type="button" className={`home-pin ${pinned ? "is-pinned" : ""}`} aria-label={`${pinned ? "Unpin" : "Pin"} project ${project.name}`} aria-pressed={pinned} onClick={onPin} title={pinned ? "Unpin project" : "Pin project"}><Icon name="pin" size={17} /></button>
    <button type="button" className="home-project-name" onClick={onOpen} aria-label={`Open project ${project.name}`}><strong>{project.name}</strong><small>Revision {project.currentRevision} · {project.bom.length} {project.bom.length === 1 ? "requirement" : "requirements"}</small></button>
    <span className={`register-stage register-stage-${project.status}`}>{projectLifecycleLabel(project.status)}</span>
    <span className="home-stock-state">{row.unknown ? "Stock results unavailable" : row.required ? `${row.ready} of ${row.required} ready to use` : "No required parts"}</span>
    <button type="button" className="home-project-next" onClick={() => task ? onTask(task) : onOpen()} aria-label={`${task?.label ?? "Open project"}: ${project.name}`}>{task?.label ?? (project.status === "complete" ? "View project" : "Review project")}<Icon name="arrow-right" size={15} /></button>
  </article>;
}
