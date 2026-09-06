import { calculateProjectSummary } from "./domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectEditingContext, ProjectManagementBar, RequirementEditAction, RequirementEditForm, ProjectEditForm, matchesRequirementFilter } from "./project-editing";
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
    const html = renderToStaticMarkup(<ProjectEditingContext.Provider value={actions}><RequirementEditAction line={line} /><ProjectManagementBar /></ProjectEditingContext.Provider>);
    expect(html).toContain("Edit project"); expect(html).toContain("Download requirements CSV"); expect(html).toContain("snapshots, not backups");
  });
  it("keeps editing distinct from stock evidence and permanent deletion", () => {
    const html = renderToStaticMarkup(<RequirementEditForm line={line} items={inventory} onSave={async () => undefined} onRetire={async () => undefined} onClose={() => undefined} onBusy={() => undefined} />);
    expect(html).toContain("Required quantity"); expect(html).toContain("No selected item"); expect(html).toContain("not proof of compatibility"); expect(html).toContain("Remove from plan"); expect(html).toContain("Restore it from Removed requirements");
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
