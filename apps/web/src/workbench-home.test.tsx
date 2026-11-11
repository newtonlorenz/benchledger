// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { WorkbenchHome, groupHomeTasks, nextBestTask, projectLifecycleLabel } from "./workbench-home";
import type { HomeTask } from "./workbench-state";
import { projects, inventory } from "./mock-data";
import { homePreferenceKey } from "./workbench-state";
beforeEach(() => { localStorage.clear(); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const fixture = (id: string, status: typeof projects[number]["status"] = "planned") => ({ ...structuredClone(projects[0]!), id, name: id, status, fabricationRoute: "none" as const });
const props = () => ({ projects: [fixture("Café fixture"), fixture("Sensor box"), fixture("Finished jig", "complete")], items: inventory, printers: [], sampleMode: false, onOpen: vi.fn(), onTask: vi.fn(), onNewProject: vi.fn(), onAddItem: vi.fn(), onImport: vi.fn(), onInventory: vi.fn(), onItem: vi.fn(), onRefresh: vi.fn(async () => true) });
it("searches, pins and resumes accessible projects using local preferences", async () => {
  localStorage.setItem(homePreferenceKey(false), JSON.stringify({ recent: ["inaccessible-id", "Sensor box"] }));
  const data = props(); render(<WorkbenchHome {...data} />);
  expect(screen.getByLabelText("Resume recent project").textContent).toContain("Sensor box");
  fireEvent.click(screen.getByRole("button", { name: "Resume project" })); expect(data.onOpen).toHaveBeenCalledWith("Sensor box");
  fireEvent.change(screen.getByLabelText("Find a project"), { target: { value: "cafe" } }); expect(document.querySelectorAll(".home-project-row")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Pin project Café fixture" }));
  fireEvent.change(screen.getByLabelText("Find a project"), { target: { value: "" } }); fireEvent.click(within(screen.getByRole("group", { name: "Filter projects" })).getByRole("button", { name: /^Pinned/u }));
  expect(document.querySelectorAll(".home-project-row")).toHaveLength(1); expect(localStorage.getItem(homePreferenceKey(false))).toContain("Café fixture");
  fireEvent.click(screen.getByRole("button", { name: "Unpin project Café fixture" })); expect(screen.getByText("No projects match this view")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show all projects" })); expect(document.querySelectorAll(".home-project-row")).toHaveLength(3);
  fireEvent.change(screen.getByLabelText("Sort projects"), { target: { value: "name" } }); expect(document.querySelector(".home-project-name")?.textContent).toContain("Café fixture");
});
it("opens concrete tasks, provides quick entry and preserves refresh failures", async () => {
  const data = props(); data.onRefresh.mockResolvedValue(false); render(<WorkbenchHome {...data} />);
  fireEvent.click(screen.getByRole("button", { name: "New project" })); fireEvent.click(screen.getByRole("button", { name: "Add inventory" })); fireEvent.click(screen.getByRole("button", { name: "Import BOM" }));
  expect(data.onNewProject).toHaveBeenCalledOnce(); expect(data.onAddItem).toHaveBeenCalledOnce(); expect(data.onImport).toHaveBeenCalledOnce();
  fireEvent.click(document.querySelector<HTMLButtonElement>(".home-task")!); expect(data.onTask).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" })); await screen.findByRole("alert"); expect(document.querySelectorAll(".home-project-row")).toHaveLength(2);
});
it("handles empty, unavailable and long project lists without invented totals", async () => {
  const data = props(); const view = render(<WorkbenchHome {...data} projects={[]} />);
  expect(screen.getByRole("heading", { name: "Create a project or import its requirements" })).toBeTruthy();
  view.rerender(<WorkbenchHome {...data} projects={[{ ...fixture("Unknown"), readinessUnavailable: true }]} />);
  expect(screen.getByText(/Check and sourcing counts exclude those projects/u)).toBeTruthy();
  view.rerender(<WorkbenchHome {...data} projects={Array.from({ length: 18 }, (_, i) => fixture(`Project ${i}`))} />);
  expect(document.querySelectorAll(".home-project-row")).toHaveLength(12); fireEvent.click(screen.getByRole("button", { name: "Show more projects" })); expect(document.querySelectorAll(".home-project-row")).toHaveLength(18);
  const next = screen.getByLabelText("Next best action");
  expect(next.textContent).toContain("Next step"); expect(next.textContent).toContain("18 active");
  fireEvent.click(within(next).getByRole("button", { name: /need attention$/u })); expect(within(screen.getByRole("group", { name: "Filter projects" })).getByRole("button", { name: /^Needs attention/u }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(next).getByRole("button", { name: /active$/u })); expect(within(screen.getByRole("group", { name: "Filter projects" })).getByRole("button", { name: /^Active/u }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Stock checks" })); expect((screen.getByRole("button", { name: "Stock checks" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Sourcing" })); fireEvent.click(screen.getByRole("button", { name: "All tasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Manage inventory" })); expect(data.onInventory).toHaveBeenCalledOnce();
  data.onRefresh.mockRejectedValueOnce(new Error("offline")); fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" })); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not refresh"));
});
it("shows one next best action, lifecycle labels and a single boundaries explainer", () => {
  const data = props(); render(<WorkbenchHome {...data} />);
  const next = screen.getByLabelText("Next best action"); const action = next.querySelector<HTMLButtonElement>(".home-next-action");
  expect(action).toBeTruthy(); fireEvent.click(action!); expect(data.onTask).toHaveBeenCalledOnce();
  expect(document.querySelector(".home-project-row .register-stage")?.textContent).toBe("Planned");
  expect(document.querySelector(".home-project-name small")?.textContent).toMatch(/^Revision /u);
  expect(projectLifecycleLabel("validating")).toBe("Validating");
  expect(screen.queryByLabelText("Workspace task shortcuts")).toBeNull();
  expect(screen.getByText("What BenchLedger never does")).toBeTruthy(); expect(screen.getByText(/Never buys anything/u)).toBeTruthy();
});
it("collapses shared setup tasks and ranks blocking stock work first", () => {
  const task = (projectId: string, kind: HomeTask["kind"], label: string): HomeTask => ({ id: `${projectId}:${kind}`, projectId, projectName: projectId, kind, label, detail: `${label} detail`, count: 1 });
  const tasks = [task("A", "setup", "Set build approach"), task("B", "setup", "Set build approach"), task("C", "setup", "Set build approach"), task("B", "check", "Check stock"), task("C", "check", "Check stock")];
  const queue = groupHomeTasks(tasks);
  expect(queue.map((entry) => [entry.label, entry.projects.length])).toEqual([["Set build approach", 3], ["Check stock", 1], ["Check stock", 1]]);
  expect(nextBestTask(tasks, [])?.id).toBe("B:check"); expect(nextBestTask(tasks, ["C"])?.id).toBe("C:check"); expect(nextBestTask([], [])).toBeUndefined();
});
it("labels a grouped queue entry with the number of projects", () => {
  const data = props(); data.projects = [{ ...fixture("Alpha"), fabricationRoute: "undecided" as never }, { ...fixture("Beta"), fabricationRoute: "undecided" as never }, { ...fixture("Gamma"), fabricationRoute: "undecided" as never }];
  render(<WorkbenchHome {...data} />);
  const queue = screen.getByRole("region", { name: "Workspace attention queue" });
  const grouped = within(queue).getByRole("button", { name: "Set build approach: 3 projects" });
  expect(grouped.textContent).toContain("3 projects: Alpha, Beta and 1 more");
  fireEvent.click(grouped); expect(data.onTask).toHaveBeenCalledWith(expect.objectContaining({ kind: "setup" }));
});
