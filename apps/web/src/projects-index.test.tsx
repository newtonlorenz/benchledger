// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProjectsIndex, projectReadinessSummary } from "./projects-index";
import type { ProjectSummary } from "./domain";
import { inventory, projects } from "./mock-data";

afterEach(cleanup);
const summary = (overrides: Partial<ProjectSummary>): ProjectSummary => ({ totalLines: 5, readyLines: 0, inspectLines: 0, missingLines: 0, optionalLines: 0, readyDecisionLines: 0, checkLines: 0, decideLines: 0, sourceLines: 0, partialLines: 0, readinessUnavailable: false, lineStatuses: [], ...overrides });

describe("project readiness summary", () => {
  it("states what to buy, check and decide in plain words", () => {
    expect(projectReadinessSummary(summary({ sourceLines: 3, inspectLines: 2 }))).toBe("3 to buy · 2 to check");
    expect(projectReadinessSummary(summary({ decideLines: 1 }))).toBe("1 to decide");
    expect(projectReadinessSummary(summary({ readyLines: 5 }))).toBe("All 5 ready to use");
    expect(projectReadinessSummary(summary({ totalLines: 0 }))).toBe("No requirements yet");
    expect(projectReadinessSummary(summary({ readinessUnavailable: true, sourceLines: 3 }))).toBe("Stock results unavailable");
  });
});

describe("projects index", () => {
  const active = projects.slice(0, 2);
  const archived = [{ ...projects[2]!, id: "archived-one", name: "Old shelf bracket", status: "archived" as const }];
  const setup = (view: "active" | "archived" = "active") => {
    const onOpen = vi.fn(), onView = vi.fn(), onNewProject = vi.fn();
    render(<ProjectsIndex projects={active} archivedProjects={archived} items={inventory} view={view} currentProjectId={active[1]!.id} onOpen={onOpen} onViewChange={onView} onNewProject={onNewProject} />);
    return { onOpen, onView, onNewProject };
  };

  it("lists each project with its stage, readiness and last update", () => {
    setup();
    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeTruthy();
    const list = screen.getByRole("list", { name: "Active projects" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(within(first).getByRole("button", { name: `Open project ${active[0]!.name}` })).toBeTruthy();
    expect(first.textContent).toContain("Building");
    expect(first.textContent).toContain(`Updated ${active[0]!.updated}`);
    expect(first.textContent).toMatch(/to buy|to check|to decide|ready to use|No requirements yet|unavailable/u);
  });

  it("opens a project and offers to continue the current one", () => {
    const { onOpen } = setup();
    fireEvent.click(screen.getByRole("button", { name: `Open project ${active[0]!.name}` }));
    expect(onOpen).toHaveBeenLastCalledWith(active[0]!.id);
    fireEvent.click(screen.getByRole("button", { name: `Continue: ${active[1]!.name}` }));
    expect(onOpen).toHaveBeenLastCalledWith(active[1]!.id);
  });

  it("switches between active and archived projects with a pressed toggle", () => {
    const { onView } = setup();
    const group = screen.getByRole("group", { name: "Project view" });
    expect(within(group).getByRole("button", { name: "Active projects" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "Archived (1)" }));
    expect(onView).toHaveBeenCalledWith("archived");
    cleanup();
    setup("archived");
    expect(within(screen.getByRole("list", { name: "Archived projects" })).getByRole("button", { name: "Open project Old shelf bracket" })).toBeTruthy();
  });

  it("explains an empty view and keeps project creation available", () => {
    const onNewProject = vi.fn();
    render(<ProjectsIndex projects={[]} archivedProjects={[]} items={[]} view="active" onOpen={() => undefined} onViewChange={() => undefined} onNewProject={onNewProject} />);
    expect(screen.getByRole("heading", { name: "No projects yet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create first project" }));
    expect(onNewProject).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button", { name: "New project" })).toHaveLength(1);
  });
});
