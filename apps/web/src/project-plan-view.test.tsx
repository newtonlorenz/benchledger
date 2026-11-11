// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ProjectPlan, ProjectPage, ProjectRevisionHistory, combinedProjectSummary } from "./App";
import * as api from "./api";
import { projectPrimaryTab } from "./project-plan-view";
import { ProjectEditingContext } from "./project-editing";
import type { ComponentProps } from "react";
import { projects } from "./mock-data";
import { calculateProjectSummary, type Project } from "./domain";
import type { ProjectPlanViewState } from "./project-plan-view";
import type { HomeTask } from "./workbench-state";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const { gapEvaluation: _gapEvaluation, ...baseProject } = projects[0]!;
const project: Project = {
  ...baseProject, id: "plan-project", serverRevisionId: "plan-r1",
  bom: Array.from({ length: 24 }, (_, index) => ({ id: `line-${index}`, version: 1, label: `Connector ${index + 1}`, required: 1, unit: "each", role: "consumed" }))
};
type Task = HomeTask & { request: number };
const task: Task = { id: "review", projectId: project.id, projectName: project.name, kind: "check", label: "Review", detail: "", count: 1, request: 1 };
function Harness({ current = project, homeTask }: { current?: Project; homeTask?: Task }) {
  const [view, setView] = useState<ProjectPlanViewState>();
  const [plan, setPlan] = useState(true);
  const base = calculateProjectSummary(current, []);
  // The view tests use an already-evaluated source result; domain readiness has its own tests.
  const summary = { ...base, lineStatuses: base.lineStatuses.map(line => ({ ...line, decision: "source" as const, state: "missing" as const })) };
  return <><button onClick={() => setPlan(!plan)}>{plan ? "Open Files" : "Open Plan"}</button>
    {plan && <ProjectPlan key={`${current.id}:${current.serverRevisionId}`} project={current} summary={summary} homeTask={homeTask} expert={false} viewState={view} onViewStateChange={setView} onOpenItem={vi.fn()} onAddBom={vi.fn()} onResolveBomRole={async () => undefined} />}
  </>;
}
function filterPlan() {
  fireEvent.change(screen.getByLabelText("Search project requirements"), { target: { value: "Connector 24" } });
  fireEvent.click(screen.getByRole("button", { name: "To source" }));
}
function returnToPlan() {
  fireEvent.click(screen.getByText("Open Files")); fireEvent.click(screen.getByText("Open Plan"));
}

it("keeps stock checks visible below the requirements working area", () => {
  render(<ProjectPlan project={project} summary={calculateProjectSummary(project, [])} expert onOpenItem={vi.fn()} onAddBom={vi.fn()} onResolveBomRole={async () => undefined} />);
  const requirements = screen.getByRole("heading", { name: "Parts" });
  const checks = screen.getByRole("heading", { name: "Stock checks" });
  expect(requirements.compareDocumentPosition(checks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(checks.closest("[hidden], [inert]" )).toBeNull();
  expect(screen.getByText("No open physical checks are recorded for this revision.")).toBeTruthy();
});

it("retains the query and filter across Plan tab remounts without changing full-plan totals", () => {
  render(<Harness />); filterPlan(); returnToPlan();
  expect(screen.getByLabelText("Search project requirements")).toHaveProperty("value", "Connector 24");
  expect(screen.getByLabelText("Filter project requirements")).toHaveProperty("value", "source");
  expect(screen.getByText("Showing 1 of 24 requirements. Readiness and exports still use the full plan.")).toBeTruthy();
  expect(document.querySelectorAll(".bom-row")).toHaveLength(1);
  fireEvent.click(screen.getByText("Clear requirement filters")); returnToPlan();
  expect(screen.getByLabelText("Search project requirements")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Filter project requirements")).toHaveProperty("value", "all");
  expect(document.querySelectorAll(".bom-row")).toHaveLength(24);
});

for (const change of ["project", "revision"] as const) {
  it(`starts with all requirements when the ${change} changes`, () => {
    const view = render(<Harness />); filterPlan();
    view.rerender(<Harness current={{ ...project, ...(change === "project" ? { id: "different-project" } : { serverRevisionId: "plan-r2" }) }} />);
    expect(screen.getByLabelText("Search project requirements")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Filter project requirements")).toHaveProperty("value", "all");
  });
}

it("handles each explicit home task once without reapplying it over the maker's filters on return", () => {
  const view = render(<Harness homeTask={task} />);
  expect(screen.getByLabelText("Filter project requirements")).toHaveProperty("value", "check");
  filterPlan(); returnToPlan();
  expect(screen.getByLabelText("Search project requirements")).toHaveProperty("value", "Connector 24");
  expect(screen.getByLabelText("Filter project requirements")).toHaveProperty("value", "source");
  view.rerender(<Harness homeTask={{ ...task, kind: "decide", request: 2 }} />);
  expect(screen.getByLabelText("Search project requirements")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Filter project requirements")).toHaveProperty("value", "decide");
  view.rerender(<Harness current={{ ...project, serverRevisionId: "plan-r2" }} homeTask={{ ...task, kind: "decide", request: 2 }} />);
  expect(screen.getByLabelText("Filter project requirements")).toHaveProperty("value", "all");
});

it("offers one clear first-part action and preserves a useful existing-file route", () => {
  const empty = { ...project, bom: [] };
  const add = vi.fn(), importParts = vi.fn(), files = vi.fn();
  render(<ProjectPlan project={empty} summary={calculateProjectSummary(empty, [])} expert={false} onImport={importParts} onFiles={files} onAddBom={add} onOpenItem={vi.fn()} onResolveBomRole={vi.fn()} />);
  expect(screen.getAllByRole("button", { name: "Add first part" })).toHaveLength(1);
  expect(screen.queryByText(/0.*ready/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add first part" }));
  fireEvent.click(screen.getByRole("button", { name: "Import parts list" }));
  fireEvent.click(screen.getByRole("button", { name: "Browse files" }));
  expect(add).toHaveBeenCalledTimes(1); expect(importParts).toHaveBeenCalledTimes(1); expect(files).toHaveBeenCalledTimes(1);
});

it("opens a part from its name without changing its stock", () => {
  const edit = vi.fn();
  render(<ProjectEditingContext.Provider value={{ project, editRequirement: edit, editProject: vi.fn(), listRemoved: vi.fn(async () => []), restore: vi.fn() }}><ProjectPlan project={project} summary={calculateProjectSummary(project, [])} expert={false} onAddBom={vi.fn()} onOpenItem={vi.fn()} onResolveBomRole={vi.fn()}/></ProjectEditingContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Connector 1" }));
  expect(edit).toHaveBeenCalledWith(project.bom[0]);
});

it("shows search and one set of common filters for a small parts list", () => {
  const small = { ...project, bom: project.bom.slice(0, 2) };
  const base = calculateProjectSummary(small, []);
  const summary = { ...base, inspectLines: 1, sourceLines: 1, lineStatuses: base.lineStatuses.map((row, index) => ({ ...row, decision: index ? "source" as const : "check" as const })) };
  const shopping = vi.fn();
  render(<ProjectPlan project={small} summary={summary} expert={false} onShopping={shopping} onOpenItem={vi.fn()} onAddBom={vi.fn()} onResolveBomRole={vi.fn()}/>);
  expect(screen.getByRole("textbox", { name: "Search project requirements" })).toBeTruthy();
  expect(screen.getByLabelText("Filter project requirements").closest("[hidden]")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "To check" }));
  expect(document.querySelectorAll(".bom-row")).toHaveLength(1);
  expect(screen.getByText("Connector 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "To source" }));
  expect(document.querySelectorAll(".bom-row")).toHaveLength(1);
  expect(screen.getByText("Connector 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(document.querySelectorAll(".bom-row")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Shopping list" }));
  expect(shopping).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("Parts views")).toBeNull();
});

const pageProps: ComponentProps<typeof ProjectPage> = {
  project, projects: [project], projectView: "active", archivedProjectCount: 0, items: [], offers: [], tab: "plan", expert: false, sampleMode: true,
  pcbSupported: false, assemblySupported: false, makerWorkflowsSupported: false, reconciliationSupported: false,
  onImportBom: vi.fn(), onNewInventory: vi.fn(), onTabChange: vi.fn(), onSelectProject: vi.fn(), onProjectViewChange: vi.fn(), onOpenItem: vi.fn(), onNavigate: vi.fn(), onToast: vi.fn(), onNewProject: vi.fn(), onArchive: vi.fn(), onRestore: vi.fn(), onRemove: vi.fn(), onNewRevision: vi.fn(), onEditBuildApproach: vi.fn(), onAddBom: vi.fn(), onResolveBomRole: vi.fn(), onUpload: vi.fn(), onReadReconciliation: vi.fn(), onSaveReconciliation: vi.fn(), onCommitReconciliation: vi.fn(), onRefreshWorkspace: vi.fn(), onListInspections: vi.fn(), onReadInspection: vi.fn(), onPreviewInspection: vi.fn(), onConfirmInspection: vi.fn()
};

it("keeps exactly four primary sections and maps existing task links into them", () => {
  expect(["overview", "plan", "offers", "files", "build", "reconciliation", "assembly", "pcb"].map(projectPrimaryTab)).toEqual(["overview", "plan", "plan", "files", "build", "build", "build", "build"]);
  const view = render(<ProjectPage {...pageProps} tab="offers"/>);
  expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Overview", "Parts", "Files", "Build"]);
  expect(screen.getByRole("tab", { name: "Parts" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("button", { name: "Project tools" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Project details" })).toBeNull();
  view.rerender(<ProjectPage {...pageProps} tab="pcb"/>);
  expect(screen.getByRole("tab", { name: "Build" }).getAttribute("aria-selected")).toBe("true");
});

it("returns from a secondary task when its selected primary tab is clicked", () => {
  const navigate = vi.fn();
  const view = render(<ProjectPage {...pageProps} tab="offers" onTabChange={navigate}/>);
  fireEvent.click(screen.getByRole("tab", { name: "Parts" }));
  expect(navigate).toHaveBeenLastCalledWith("plan");
  view.rerender(<ProjectPage {...pageProps} tab="pcb" onTabChange={navigate}/>);
  fireEvent.click(screen.getByRole("tab", { name: "Build" }));
  expect(navigate).toHaveBeenLastCalledWith("build");
});

it("keeps project actions scoped and shows recorded revision history", () => {
  const current = { ...project, projectRevisions: [{ id: "plan-r1", name: "Current shape" }, { id: "plan-r0", name: "Early shape" }] };
  render(<ProjectEditingContext.Provider value={{ project: current, editRequirement: vi.fn(), editProject: vi.fn(), refreshProject: vi.fn(), listRemoved: vi.fn(async () => []), restore: vi.fn() }}><ProjectPage {...pageProps} project={current}/></ProjectEditingContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
  expect(screen.getByRole("button", { name: "Edit project" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Refresh project" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Revision history" }));
  expect(screen.getByText("Early shape")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Browse file history" })).toBeTruthy();
});

it("returns a cancelled archive confirmation to the stable project actions trigger", async () => {
  render(<ProjectPage {...pageProps}/>);
  const trigger = screen.getByRole("button", { name: "Project actions" });
  trigger.focus(); fireEvent.click(trigger);
  const archive = screen.getByRole("button", { name: "Archive project" });
  expect(archive.getAttribute("data-focus-return")).toBe(trigger.id);
  archive.focus(); fireEvent.click(archive);
  await screen.findByRole("alertdialog", { name: `Archive ${project.name}?` });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("reads a paged revision snapshot without changing the active revision", async () => {
  const read = vi.spyOn(api, "workflowRequest").mockImplementation(async path => {
    if (path.endsWith("/snapshot")) return { revision: { number: 1, name: "Earlier design" }, lines: [{ id: "old-line", name: "Earlier connector", requiredQuantity: 2, unit: "each" }], files: [{ id: "old-file", filename: "earlier.step", role: "CAD" }] };
    return { data: [{ id: "plan-r0", number: 1, name: "Earlier design" }], nextCursor: "older-page" };
  });
  render(<ProjectRevisionHistory project={project} remote/>);
  fireEvent.click(await screen.findByRole("button", { name: "Read revision 1: Earlier design" }));
  const snapshot = await screen.findByRole("region", { name: "Read-only revision snapshot" });
  expect(snapshot.textContent).toContain("1 requirements · 1 files");
  expect(snapshot.textContent).toContain("Earlier connector: 2 each");
  expect(snapshot.textContent).toContain("earlier.step · CAD");
  fireEvent.click(screen.getByRole("button", { name: "Older revisions" }));
  await waitFor(() => expect(read).toHaveBeenCalledWith(`/projects/${project.id}/revision-history?limit=10&cursor=older-page`));
  expect(read.mock.calls.every(([, method]) => method === undefined)).toBe(true);
  expect(project.serverRevisionId).toBe("plan-r1");
});

it("keeps unavailable project readiness and project identity in a combined proposal", () => {
  const unavailable = { ...project, id: "second-project", name: "Second build", readinessUnavailable: true };
  const combined = combinedProjectSummary([project, unavailable, { ...project, id: "archived", status: "archived" }], []);
  expect(combined.readinessUnavailable).toBe(true);
  expect(combined.totalLines).toBe(48);
  expect(combined.lineStatuses[0]?.line.label).toBe(`${project.name} · Connector 1`);
  expect(combined.lineStatuses[24]?.line.label).toBe("Second build · Connector 1");
});

it("returns to the newly added part, highlights it and offers a secondary continuation", async () => {
  const addAnother = vi.fn();
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  const added = project.bom[23]!;
  function AddedPartHarness() {
    const [view, setView] = useState<ProjectPlanViewState>({ projectId: project.id, revisionId: project.serverRevisionId, query: "would hide the new part", filter: "ready" });
    return <ProjectPlan project={project} summary={calculateProjectSummary(project, [])} addedPart={{ projectId: project.id, lineId: added.id, name: added.label }} viewState={view} onViewStateChange={setView} expert={false} onAddBom={addAnother} onOpenItem={vi.fn()} onResolveBomRole={vi.fn()}/>;
  }
  render(<AddedPartHarness/>);
  const row = document.querySelector<HTMLElement>('[data-requirement-id="line-23"]')!;
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(screen.getByLabelText("Search project requirements")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Filter project requirements")).toHaveProperty("value", "all");
  expect(row.classList.contains("is-new-part")).toBe(true);
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add another" }));
  expect(addAnother).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss added part notice" }));
  expect(row.classList.contains("is-new-part")).toBe(false);
});
