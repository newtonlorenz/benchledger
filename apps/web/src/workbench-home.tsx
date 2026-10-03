import { useEffect, useMemo, useState } from "react";
import { Alert } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "./components/ui/disclosure";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import type { InventoryItem, Project } from "./domain";
import { Icon } from "./icons";
import { deriveHomeProjects, filterHomeProjects, readHomePreferences, writeHomePreferences } from "./workbench-state";
import type { HomeFilter, HomePreferences, HomeProject, HomeTask } from "./workbench-state";
import "./home-experience.css";

export interface WorkbenchHomeProps {
  projects: Project[]; items: InventoryItem[]; printers: InventoryItem[]; sampleMode: boolean; isPrinterUsable?: ((item: InventoryItem) => boolean) | undefined;
  onOpen(id: string, tab?: "plan" | "files" | "offers" | "reconciliation"): void;
  onTask(task: HomeTask): void; onNewProject(event: React.MouseEvent<HTMLButtonElement>): void;
  onAddItem(): void; onImport?: (() => void) | undefined; onInventory(): void; onItem(id: string): void;
  onRefresh?: (() => Promise<boolean>) | undefined;
}

const projectFilters: [HomeFilter, string][] = [["active", "Active projects"], ["attention", "Needs attention"], ["pinned", "Pinned projects"], ["complete", "Complete projects"], ["all", "All projects"]];

export function WorkbenchHome(props: WorkbenchHomeProps) {
  const { projects, items, sampleMode } = props;
  const [preferences, setPreferences] = useState(() => readHomePreferences(sampleMode));
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(12);
  const [taskKind, setTaskKind] = useState<"all" | "check" | "source">("all");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [queueLimit, setQueueLimit] = useState(8);
  const rows = useMemo(() => deriveHomeProjects(projects, items), [projects, items]);
  const filtered = filterHomeProjects(rows, query, preferences);
  const tasks = rows.flatMap((row) => row.tasks);
  const queue = tasks.filter((task) => taskKind === "all" || task.kind === taskKind);
  const recent = preferences.recent.map((id) => rows.find((row) => row.project.id === id)).find((row) => row && row.project.status !== "complete");
  const counts: Record<HomeFilter, number> = {
    all: rows.length,
    active: rows.filter((row) => row.project.status !== "complete").length,
    attention: rows.filter((row) => row.tasks.length).length,
    complete: rows.filter((row) => row.project.status === "complete").length,
    pinned: rows.filter((row) => preferences.pins.includes(row.project.id)).length,
  };

  useEffect(() => setQueueLimit(8), [taskKind]);
  useEffect(() => { setPreferences(readHomePreferences(sampleMode)); }, [sampleMode]);
  const update = (patch: Partial<HomePreferences>) => {
    setLimit(12);
    setPreferences((current) => {
      const next = { ...current, ...patch };
      writeHomePreferences(next, sampleMode);
      return next;
    });
  };
  const pin = (id: string) => update({ pins: preferences.pins.includes(id) ? preferences.pins.filter((value) => value !== id) : [...preferences.pins, id].slice(-100) });
  const refresh = async () => {
    if (!props.onRefresh || refreshing) return;
    setRefreshing(true);
    setRefreshError(false);
    try { setRefreshError(!await props.onRefresh()); }
    catch { setRefreshError(true); }
    finally { setRefreshing(false); }
  };
  const refreshButton = props.onRefresh && <Button variant="ghost" type="button" className="text-button home-refresh" disabled={refreshing} onClick={() => { void refresh(); }}><Icon name="refresh" size={16} />{refreshing ? "Refreshing…" : "Refresh workspace"}</Button>;

  return <div className="home-workspace home-experience">
    <header className="home-heading">
      <div><h1>Workspace overview</h1><p>Choose a project or review your inventory.</p></div>
      <div className="home-actions">
        <Button variant="outline" type="button" className="button button-secondary" onClick={props.onInventory}><Icon name="box" size={16} />Open inventory</Button>
        <Button type="button" className="button button-primary" onClick={props.onNewProject}><Icon name="plus" size={16} />New project</Button>
      </div>
    </header>

    {refreshError && <Alert asChild><p role="alert" className="home-read-error">The workspace could not refresh. The previous records remain visible. Retry before using stock.</p></Alert>}
    {rows.some((row) => row.unknown && row.project.status !== "complete") && <p role="status" className="home-results-warning">Some stock results are unavailable. Check and sourcing counts exclude those projects. Refresh the workspace before using stock.</p>}

    {recent && <section className="home-resume" aria-label="Resume recent project">
      <Icon name="clock" size={16} /><span>Recently opened</span>
      <Button variant="ghost" type="button" className="home-resume-link" aria-label="Resume project" title="Last opened in this browser" onClick={() => props.onOpen(recent.project.id)}>{recent.project.name}<Icon name="arrow-right" size={15} /></Button>
    </section>}

    {!rows.length ? <section className="home-onboarding">
      <h2>What would you like to make?</h2>
      <p>Create a project with a name and a goal. Add its parts, materials and tools, then check what you already own before sourcing anything else.</p>
      <p>You can choose equipment and add design files as your idea develops.</p>
      {refreshButton}
    </section> : <section className="home-projects" aria-label="Project register">
      <div className="home-section-title"><h2>Your projects</h2>{refreshButton}</div>
      <div className="home-project-toolbar">
        <Label className="home-search"><Icon name="search" size={16} /><Input aria-label="Find a project" placeholder="Find a project" value={query} onChange={(event) => { setQuery(event.target.value.slice(0, 200)); setLimit(12); }} /></Label>
        <Label className="home-view"><span>View</span><NativeSelect aria-label="Filter projects" value={preferences.filter} onChange={(event) => update({ filter: event.target.value as HomeFilter })}>{projectFilters.map(([filter, label]) => <NativeSelectOption value={filter} key={filter}>{label} ({counts[filter]})</NativeSelectOption>)}</NativeSelect></Label>
        <Label className="home-sort"><span>Sort</span><NativeSelect aria-label="Sort projects" value={preferences.sort} onChange={(event) => update({ sort: event.target.value as HomePreferences["sort"] })}><NativeSelectOption value="recent">Recent first</NativeSelectOption><NativeSelectOption value="name">Name</NativeSelectOption><NativeSelectOption value="attention">Open checks</NativeSelectOption></NativeSelect></Label>
      </div>
      <div className="home-register-columns" aria-hidden="true"><span /><span>Project</span><span>Stage</span><span>Stock readiness</span><span>Next action</span></div>
      <div className="home-project-list">{filtered.slice(0, limit).map((row) => <HomeProjectRow key={row.project.id} row={row} pinned={preferences.pins.includes(row.project.id)} onPin={() => pin(row.project.id)} onOpen={() => props.onOpen(row.project.id)} onTask={props.onTask} />)}</div>
      {!filtered.length && <div className="home-filter-empty"><Icon name="folder" size={24} /><strong>No projects match this view</strong><p>Change the view or clear the search.</p><Button variant="ghost" type="button" className="text-button" onClick={() => { setQuery(""); update({ filter: "all" }); }}>Show all projects</Button></div>}
      <div className="home-list-footer"><span>{Math.min(limit, filtered.length)} of {filtered.length} matching loaded projects</span>{filtered.length > limit && <Button variant="ghost" type="button" className="text-button" onClick={() => setLimit((value) => value + 12)}>Show more projects</Button>}</div>
    </section>}

    <div className="home-support">
      {rows.length > 0 && <Disclosure className="home-disclosure home-task-disclosure">
        <DisclosureTrigger aria-label="All next actions"><span>All next actions <small>{tasks.length}</small></span></DisclosureTrigger>
        <DisclosureContent><section className="home-task-queue" aria-label="Workspace attention queue">
          <div className="home-queue-toolbar"><p>Review the open planning work across your projects.</p><Label className="home-queue-view"><span>Show</span><NativeSelect aria-label="Filter attention queue" value={taskKind} onChange={(event) => setTaskKind(event.target.value as typeof taskKind)}><NativeSelectOption value="all">All tasks</NativeSelectOption><NativeSelectOption value="check">Stock checks</NativeSelectOption><NativeSelectOption value="source">Sourcing</NativeSelectOption></NativeSelect></Label></div>
          {queue.length ? <div className="home-task-list">{queue.slice(0, queueLimit).map((task) => <Button variant="ghost" type="button" className="home-task" key={task.id} onClick={() => props.onTask(task)} aria-label={`${task.label}: ${task.projectName}`}><Icon name={task.kind === "check" ? "tool" : task.kind === "source" ? "tag" : task.kind === "files" ? "file" : task.kind === "refresh" ? "refresh" : "clipboard"} size={18} /><span><strong>{task.label}</strong><small>{task.projectName}</small></span><span className="home-task-detail">{task.detail}</span><Icon name="arrow-right" size={16} /></Button>)}</div> : <div className="home-queue-empty"><strong>{tasks.length ? "No tasks in this view" : "No open planning checks"}</strong><p>{tasks.length ? "Select All tasks to review other work." : "This does not confirm that a design or physical build is validated."}</p></div>}
          {queue.length > queueLimit && <div className="home-queue-footer"><span>Showing {queueLimit} of {queue.length} tasks</span><Button variant="ghost" type="button" className="text-button" onClick={() => setQueueLimit((value) => value + 8)}>Show more tasks</Button></div>}
        </section></DisclosureContent>
      </Disclosure>}
      <Disclosure className="home-disclosure home-tools-disclosure" defaultOpen={!rows.length}>
        <DisclosureTrigger>Workspace tools</DisclosureTrigger>
        <DisclosureContent><div className="home-tools">
          <div className="home-entry-tools">
            <Button variant="outline" type="button" className="button button-secondary" onClick={props.onAddItem}><Icon name="box" size={16} />Add inventory</Button>
            {props.onImport && <Button variant="outline" type="button" className="button button-secondary" onClick={props.onImport}><Icon name="upload" size={16} />Import requirements</Button>}
          </div>
          <section className="home-equipment" aria-label="Workshop equipment">
            <h3>Workshop equipment</h3><p>Up to three printers from the loaded inventory.</p>
            {props.printers.length ? props.printers.slice(0, 3).map((item) => <Button variant="ghost" type="button" className="home-equipment-item" key={item.id} onClick={() => props.onItem(item.id)}><Icon name="box" size={18} /><span><strong>{item.name}</strong><small>{props.isPrinterUsable?.(item) === false ? "Needs stock or product setup check" : item.catalogProduct?.buildVolumeMm ? `${item.catalogProduct.buildVolumeMm.x} × ${item.catalogProduct.buildVolumeMm.y} × ${item.catalogProduct.buildVolumeMm.z} mm build volume` : "Open recorded equipment details"}</small></span><Icon name="arrow-right" size={16} /></Button>) : <p>No printers in the loaded records. A printer is not needed for every build.</p>}
            <Button variant="ghost" type="button" className="text-button" onClick={props.onInventory}>Manage inventory<Icon name="arrow-right" size={15} /></Button>
          </section>
        </div></DisclosureContent>
      </Disclosure>
    </div>
    <p className="home-scope-note">Projects and task counts cover loaded records only. Pins and recent projects are saved in this browser. Stock readiness is separate from build validation.</p>
  </div>;
}

function HomeProjectRow({ row, pinned, onPin, onOpen, onTask }: { row: HomeProject; pinned: boolean; onPin(): void; onOpen(): void; onTask(task: HomeTask): void }) {
  const { project, tasks } = row;
  const task = tasks[0];
  return <article className="home-project-row">
    <Button variant="ghost" type="button" className={`home-pin ${pinned ? "is-pinned" : ""}`} aria-label={`${pinned ? "Unpin" : "Pin"} project ${project.name}`} aria-pressed={pinned} onClick={onPin} title={pinned ? "Unpin project" : "Pin project"}><Icon name="pin" size={17} /></Button>
    <Button variant="ghost" type="button" className="home-project-name" onClick={onOpen} aria-label={`Open project ${project.name}`}><strong>{project.name}</strong><small>{project.currentRevision} · {project.bom.length} {project.bom.length === 1 ? "requirement" : "requirements"}</small></Button>
    <Badge variant="outline" className="home-project-stage">{project.status}</Badge>
    <span className={`home-stock-state${row.unknown ? " is-unavailable" : ""}`}>{row.unknown ? "Stock results unavailable" : row.required ? `${row.ready} / ${row.required} stock-ready` : "No required parts"}</span>
    <Button variant="ghost" type="button" className="home-project-next" onClick={() => task ? onTask(task) : onOpen()} aria-label={`${task?.label ?? "Open project"}: ${project.name}`}>{task?.label ?? (project.status === "complete" ? "View project" : "Review project")}<Icon name="arrow-right" size={15} /></Button>
  </article>;
}
