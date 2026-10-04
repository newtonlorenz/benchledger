// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { calculateProjectSummary } from "./domain";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectEditingContext, ProjectManagementBar, RequirementEditAction, RequirementEditForm, ProjectEditForm, RemovedRequirements, matchesRequirementFilter } from "./project-editing";
import { inventory, projects } from "./mock-data";

describe("maker correction surfaces", () => {
  const project = projects[0]!, line = project.bom[0]!;
  const actions = { project, editRequirement: () => undefined, editProject: () => undefined, listRemoved: async () => [], restore: async () => undefined };
  it("keeps unauthorised or archived contexts read-only", () => {
    expect(renderToStaticMarkup(<RequirementEditAction line={line} />)).toBe("");
    const html = renderToStaticMarkup(<ProjectEditingContext.Provider value={{ ...actions, project: { ...project, status: "archived" } }}><RequirementEditAction line={line} /><ProjectManagementBar /></ProjectEditingContext.Provider>);
    expect(html).not.toContain("Edit requirement"); expect(html).not.toContain("Edit project"); expect(html).toContain("Export project");
  });
  it("offers explicit active project actions and bounded exports", () => {
    render(<ProjectEditingContext.Provider value={actions}><RequirementEditAction line={line} /><ProjectManagementBar /></ProjectEditingContext.Provider>);
    expect(screen.getByRole("button", { name: "Edit project" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Export project" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    expect(screen.getByRole("menuitem", { name: "Download requirements CSV" })).toBeTruthy();
    expect(screen.getByText(/snapshots, not backups/)).toBeTruthy(); cleanup();
  });
  it("keeps editing distinct from stock evidence and permanent deletion", () => {
    const html = renderToStaticMarkup(<RequirementEditForm line={line} items={inventory} onSave={async () => undefined} onRetire={async () => undefined} onClose={() => undefined} onBusy={() => undefined} />);
    expect(html).toContain("Required quantity"); expect(html).toContain("Already in your workshop?"); expect(html).toContain("not proof of compatibility"); expect(html).toContain("Remove from plan"); expect(html).toContain("Restore it from Removed requirements");
    const projectHtml = renderToStaticMarkup(<ProjectEditForm project={project} onSave={async () => undefined} onClose={() => undefined} onBusy={() => undefined} />);
    expect(projectHtml).toContain("Project stage"); expect(projectHtml).toContain("does not certify readiness");
  });
});

it("requirement filtering preserves optional and attention semantics without changing the plan", () => {
  const project = structuredClone(projects[0]!);
  const baseline = JSON.stringify(project);
  const row = calculateProjectSummary(project, inventory).lineStatuses[0]!;
  const optional = { ...row, line: { ...row.line, optional: true }, decision: "source" as const };
  expect(matchesRequirementFilter(optional, "", "optional")).toBe(true);
  expect(matchesRequirementFilter(optional, "", "attention")).toBe(false);
  expect(matchesRequirementFilter(optional, "", "source")).toBe(false);
  expect(matchesRequirementFilter({ ...row, line: { ...row.line, optional: false }, decision: "check" }, "", "attention")).toBe(true);
  expect(JSON.stringify(project)).toBe(baseline);
});
it("requirement discovery matches words across its name and note", () => {
  const row = calculateProjectSummary(projects[0]!, inventory).lineStatuses[0]!;
  const entry = { ...row, line: { ...row.line, label: "Café spacer", note: "Anodised aluminium", optional: false }, decision: "source" as const };
  expect(matchesRequirementFilter(entry, "aluminium cafe", "source")).toBe(true);
  expect(matchesRequirementFilter(entry, "steel", "all")).toBe(false);
});


afterEach(cleanup);
it("hides an empty removal history but makes a removed last requirement recoverable", async () => {
  const listRemoved = vi.fn().mockResolvedValue([]);
  const actions = { project: { ...projects[0]!, bom: [] }, editRequirement: vi.fn(), editProject: vi.fn(), listRemoved, restore: vi.fn().mockResolvedValue(undefined) };
  const view = render(<ProjectEditingContext.Provider value={actions}><RemovedRequirements hideWhenEmpty /></ProjectEditingContext.Provider>);
  await waitFor(() => expect(listRemoved).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: "Removed requirements" })).toBeNull();
  listRemoved.mockResolvedValue([projects[0]!.bom[0]!]);
  view.rerender(<ProjectEditingContext.Provider value={{ ...actions, project: { ...actions.project, serverRevisionId: "synthetic-new-revision" } }}><RemovedRequirements hideWhenEmpty /></ProjectEditingContext.Provider>);
  fireEvent.click(await screen.findByRole("button", { name: "Removed requirements" }));
  fireEvent.click(await screen.findByRole("button", { name: `Restore requirement ${projects[0]!.bom[0]!.label}` }));
  await waitFor(() => expect(actions.restore).toHaveBeenCalledWith(projects[0]!.bom[0]!));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Removed requirements" })).toBeNull());
});
