import { Badge } from "./components/ui/badge";
import { Alert } from "./components/ui/alert";
import { Card } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { useEffect, useMemo, useState } from "react";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "./components/ui/disclosure";
import "./home-experience.css";
import { Icon } from "./icons";
import type { InventoryItem, Project } from "./domain";
import { deriveHomeProjects, filterHomeProjects, readHomePreferences, writeHomePreferences } from "./workbench-state";
import type { HomeFilter, HomePreferences, HomeProject, HomeTask } from "./workbench-state";
export interface WorkbenchHomeProps {
  projects: Project[]; items: InventoryItem[]; printers: InventoryItem[]; sampleMode: boolean; isPrinterUsable?: ((item: InventoryItem) => boolean) | undefined;
  onOpen(id: string, tab?: "plan" | "files" | "offers" | "reconciliation"): void;
  onTask(task: HomeTask): void; onNewProject(event: React.MouseEvent<HTMLButtonElement>): void;
  onAddItem(): void; onImport?: (() => void) | undefined; onInventory(): void; onItem(id: string): void;
  onRefresh?: (() => Promise<boolean>) | undefined;
}
export function WorkbenchHome(props: WorkbenchHomeProps) {
  const { projects, items, sampleMode } = props;
  const [preferences, setPreferences] = useState(() => readHomePreferences(sampleMode));
  const [query, setQuery] = useState(""); const [limit, setLimit] = useState(12);
  const [taskKind, setTaskKind] = useState<"all" | "check" | "source">("all");
  const [refreshing, setRefreshing] = useState(false), [refreshError, setRefreshError] = useState(false);
  const [queueLimit, setQueueLimit] = useState(8);
  useEffect(() => setQueueLimit(8), [taskKind]);
  const rows = useMemo(() => deriveHomeProjects(projects, items), [projects, items]);
  const filtered = filterHomeProjects(rows, query, preferences);
  const tasks = rows.flatMap((row) => row.tasks);
  const queue = tasks.filter((task) => taskKind === "all" || task.kind === taskKind);
  const recent = preferences.recent.map((id) => rows.find((row) => row.project.id === id)).find((row) => row && row.project.status !== "complete");
  useEffect(() => { setPreferences(readHomePreferences(sampleMode)); }, [sampleMode]);
  const update = (patch: Partial<HomePreferences>) => { setLimit(12); setPreferences((current) => { const next = { ...current, ...patch }; writeHomePreferences(next, sampleMode); return next; }); };
  const pin = (id: string) => update({ pins: preferences.pins.includes(id) ? preferences.pins.filter((value) => value !== id) : [...preferences.pins, id].slice(-100) });
  const refresh = async () => { if (!props.onRefresh || refreshing) return; setRefreshing(true); setRefreshError(false); try { setRefreshError(!await props.onRefresh()); } catch { setRefreshError(true); } finally { setRefreshing(false); } };
  const counts: Record<HomeFilter, number> = { all: rows.length, active: rows.filter((row) => row.project.status !== "complete").length, attention: rows.filter((row) => row.tasks.length).length, complete: rows.filter((row) => row.project.status === "complete").length, pinned: rows.filter((row) => preferences.pins.includes(row.project.id)).length };
  return <div className="home-workspace home-experience">
    <header className="home-heading"><div><h1>Workspace overview</h1><p>Resume a project. Check stock. Plan the next build.</p></div><div className="home-actions"><Button variant="ghost" type="button" className="button button-quiet" onClick={props.onAddItem}><Icon name="box" size={16} />Add inventory</Button>{props.onImport && <Button variant="outline" type="button" className="button button-secondary" onClick={props.onImport}><Icon name="upload" size={16} />Import requirements</Button>}<Button variant={recent ? "outline" : "default"} type="button" className={`button ${recent ? "button-secondary" : "button-primary"}`} onClick={props.onNewProject}><Icon name="plus" size={16} />New project</Button></div></header>
    {refreshError && <Alert asChild><p role="alert" className="home-read-error">The workspace could not refresh. The previous records remain visible. Retry before using stock.</p></Alert>}
    {!rows.length && <Card asChild><section className="surface home-onboarding"><h2>What would you like to make?</h2><p>Create a project with a name and a goal, or import a list of parts. You can choose equipment later.</p><ol><li><strong>Describe your idea</strong><span>Record what the finished project needs to do.</span></li><li><strong>Add what it needs</strong><span>List parts, materials and tools, including anything you already own.</span></li><li><strong>Check before sourcing</strong><span>Confirm usable stock, then review what is missing.</span></li></ol><p>Starting with your workshop instead? Add inventory to record the stock you own.</p>{props.onRefresh && <Button variant="ghost" type="button" className="text-button" disabled={refreshing} onClick={() => { void refresh(); }}><Icon name="refresh" size={15} />{refreshing ? "Refreshing…" : "Refresh workspace"}</Button>}</section></Card>}
    {rows.some((row) => row.unknown && row.project.status !== "complete") && <p role="status" className="home-results-warning">Some stock results are unavailable. Check and sourcing counts exclude those projects. Refresh the workspace before using stock.</p>}
    {recent && <section className="home-resume" aria-label="Resume recent project"><Icon name="clock" size={18} /><span><small>Last opened in this browser</small><strong>{recent.project.name}</strong>{recent.tasks[0] && <span className="home-resume-next">Next: {recent.tasks[0].label}</span>}</span><span className="home-resume-revision">{recent.project.currentRevision}</span><Button variant="default" type="button" className="button button-primary" onClick={() => props.onOpen(recent.project.id)}>Resume project<Icon name="arrow-right" size={15} /></Button></section>}
    {rows.length > 0 && <div className="home-work-grid"><Card asChild><section className="surface home-projects" aria-label="Project register"><div className="home-section-title"><h2>Your projects</h2>{props.onRefresh && <Button variant="ghost" type="button" className="text-button" disabled={refreshing} onClick={() => { void refresh(); }}><Icon name="refresh" size={15} />{refreshing ? "Refreshing…" : "Refresh workspace"}</Button>}</div>
      <div className="home-project-filters" role="group" aria-label="Filter projects">{([["active", "Active"], ["attention", "Needs attention"], ["pinned", "Pinned"], ["complete", "Complete"], ["all", "All"]] as [HomeFilter, string][]).map(([filter, label]) => <Button variant="ghost" type="button" key={filter} aria-pressed={preferences.filter === filter} className={preferences.filter === filter ? "is-selected" : ""} onClick={() => update({ filter })}>{label}<span>{counts[filter]}</span></Button>)}</div>
      <Disclosure className="home-find-projects" defaultOpen={rows.length > 6}><DisclosureTrigger>Find and sort projects</DisclosureTrigger><DisclosureContent><div className="home-project-toolbar"><Label className="field-search"><Icon name="search" size={16} /><Input aria-label="Find a project" placeholder="Find a project" value={query} onChange={(event) => { setQuery(event.target.value.slice(0, 200)); setLimit(12); }} /></Label><Label className="home-sort"><span>Sort</span><NativeSelect aria-label="Sort projects" value={preferences.sort} onChange={(event) => update({ sort: event.target.value as HomePreferences["sort"] })}><NativeSelectOption value="recent">Recent first</NativeSelectOption><NativeSelectOption value="name">Name</NativeSelectOption><NativeSelectOption value="attention">Open checks</NativeSelectOption></NativeSelect></Label></div></DisclosureContent></Disclosure>
      <div className="home-register-columns" aria-hidden="true"><span /><span>Project</span><span>Stage</span><span>Stock readiness</span><span>Next action</span></div><div className="home-project-list">{filtered.slice(0, limit).map((row) => <HomeProjectRow key={row.project.id} row={row} pinned={preferences.pins.includes(row.project.id)} onPin={() => pin(row.project.id)} onOpen={() => props.onOpen(row.project.id)} onTask={props.onTask} />)}</div>
      {!filtered.length && <div className="home-filter-empty"><Icon name="folder" size={23} /><strong>{rows.length ? "No projects match this view" : "No projects yet"}</strong><p>{rows.length ? "Change the filter or clear the search." : "Use New project or Import requirements to start."}</p>{rows.length > 0 && <Button variant="ghost" type="button" className="text-button" onClick={() => { setQuery(""); update({ filter: "all" }); }}>Show all projects</Button>}</div>}
      <div className="home-list-footer"><span>{Math.min(limit, filtered.length)} of {filtered.length} matching loaded projects</span>{filtered.length > limit && <Button variant="ghost" type="button" className="text-button" onClick={() => setLimit((value) => value + 12)}>Show more projects</Button>}</div>
    </section></Card>
    <aside className="home-right-column">
      <Card asChild><section className="surface home-task-queue" aria-label="Workspace attention queue"><div className="home-section-title"><h2>Needs attention</h2><span>{queue.length} {queue.length === 1 ? "task" : "tasks"}</span></div>
        <div className="home-queue-filters" role="group" aria-label="Filter attention queue">{([["all", "All tasks"], ["check", "Stock checks"], ["source", "Sourcing"]] as const).map(([kind, label]) => <Button variant="ghost" key={kind} type="button" aria-pressed={taskKind === kind} onClick={() => setTaskKind(kind)}>{label}</Button>)}</div>
        {queue.length ? queue.slice(0, queueLimit).map((task) => <Button variant="ghost" type="button" className={`home-task home-task-${task.kind}`} key={task.id} onClick={() => props.onTask(task)} aria-label={`${task.label}: ${task.projectName}`}><span className="home-task-mark"><Icon name={task.kind === "check" ? "tool" : task.kind === "source" ? "tag" : task.kind === "files" ? "file" : task.kind === "refresh" ? "refresh" : "clipboard"} size={16} /></span><span><strong>{task.label}</strong><small>{task.projectName}</small><span>{task.detail}</span></span><Icon name="arrow-right" size={15} /></Button>) : <div className="home-queue-empty"><Icon name="check-circle" size={22} /><strong>{tasks.length ? "No tasks in this view" : "No open planning checks"}</strong><p>{tasks.length ? "Select All tasks to review other work." : "This does not confirm that a design or physical build is validated."}</p></div>}
        {queue.length > queueLimit && <div className="home-queue-footnote"><Button variant="ghost" type="button" className="text-button" onClick={() => setQueueLimit((value) => value + 8)}>Show more tasks</Button></div>}
      </section></Card>
    </aside></div>}
    <Disclosure className="home-equipment-disclosure"><DisclosureTrigger>Workshop equipment</DisclosureTrigger><DisclosureContent>
      <section className="home-equipment" aria-label="Workshop equipment">
        <p>Up to three printers from the loaded inventory. Open inventory to review all your stock.</p>
        {props.printers.length ? props.printers.slice(0, 3).map((item) => <Button variant="ghost" type="button" className="workshop-printer-card" key={item.id} onClick={() => props.onItem(item.id)}><span><strong>{item.name}</strong><small>{props.isPrinterUsable?.(item) === false ? "Needs stock or product setup check" : item.catalogProduct?.buildVolumeMm ? `${item.catalogProduct.buildVolumeMm.x} × ${item.catalogProduct.buildVolumeMm.y} × ${item.catalogProduct.buildVolumeMm.z} mm build volume` : "Open recorded equipment details"}</small></span><Icon name="arrow-up-right" size={15} /></Button>) : <p>No printers in the loaded records. A printer is not needed for every build.</p>}
        <Button variant="ghost" type="button" className="text-button" onClick={props.onInventory}>Manage inventory<Icon name="arrow-right" size={15} /></Button>
      </section>
    </DisclosureContent></Disclosure>
    <p className="home-scope-note">Projects and task counts cover loaded records only. Pins and recent projects are saved in this browser. Stock readiness is separate from build validation.</p>
  </div>;
}
function HomeProjectRow({ row, pinned, onPin, onOpen, onTask }: { row: HomeProject; pinned: boolean; onPin(): void; onOpen(): void; onTask(task: HomeTask): void }) {
  const { project, tasks } = row;
  const task = tasks[0];
  return <article className="home-project-row">
    <Button variant="ghost" type="button" className={`home-pin ${pinned ? "is-pinned" : ""}`} aria-label={`${pinned ? "Unpin" : "Pin"} project ${project.name}`} aria-pressed={pinned} onClick={onPin} title={pinned ? "Unpin project" : "Pin project"}><Icon name="pin" size={17} /></Button>
    <Button variant="ghost" type="button" className="home-project-name" onClick={onOpen} aria-label={`Open project ${project.name}`}><strong>{project.name}</strong><small>{project.currentRevision} · {project.bom.length} {project.bom.length === 1 ? "requirement" : "requirements"}</small></Button>
    <Badge variant="outline" className={`register-stage register-stage-${project.status}`}>{project.status}</Badge>
    <span className="home-stock-state">{row.unknown ? "Stock results unavailable" : row.required ? `${row.ready} / ${row.required} stock-ready` : "No required parts"}</span>
    <Button variant="ghost" type="button" className="home-project-next" onClick={() => task ? onTask(task) : onOpen()} aria-label={`${task?.label ?? "Open project"}: ${project.name}`}>{task?.label ?? (project.status === "complete" ? "View project" : "Review project")}<Icon name="arrow-right" size={15} /></Button>
  </article>;
}
