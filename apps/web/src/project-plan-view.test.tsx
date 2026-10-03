// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ProjectPlan } from "./App";
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
  fireEvent.change(screen.getByLabelText("Filter project requirements"), { target: { value: "source" } });
}
function returnToPlan() {
  fireEvent.click(screen.getByText("Open Files")); fireEvent.click(screen.getByText("Open Plan"));
}

it("keeps stock checks visible below the requirements working area", () => {
  render(<ProjectPlan project={project} summary={calculateProjectSummary(project, [])} expert onOpenItem={vi.fn()} onAddBom={vi.fn()} onResolveBomRole={async () => undefined} />);
  const requirements = screen.getByRole("heading", { name: "Required parts and materials" });
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
