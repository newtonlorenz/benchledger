// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectNavigator } from "./project-navigator";
import { projects } from "./mock-data";

afterEach(cleanup);
it("finds a project, reports selection and delegates navigation without mutating records", () => {
  const records = [{ ...projects[0]!, id: "cafe", name: "Café fixture" }, { ...projects[0]!, id: "sensor", name: "Sensor box" }];
  const onSelect = vi.fn(), onViewChange = vi.fn();
  render(<ProjectNavigator projects={records} selectedId="sensor" view="active" archivedCount={2} onSelect={onSelect} onViewChange={onViewChange} />);
  expect(screen.getByRole("button", { name: "Switch to project Sensor box" }).getAttribute("aria-current")).toBe("page");
  fireEvent.change(screen.getByLabelText("Filter project navigator"), { target: { value: "cafe" } });
  expect(screen.queryByRole("button", { name: "Switch to project Sensor box" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Switch to project Café fixture" }));
  expect(onSelect).toHaveBeenCalledWith("cafe");
  fireEvent.change(screen.getByLabelText("Filter project navigator"), { target: { value: "missing" } });
  expect(screen.getByText("No matching projects.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear project filter" }));
  expect(screen.getByRole("button", { name: "Switch to project Sensor box" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Archived (2)" }));
  expect(onViewChange).toHaveBeenCalledWith("archived");
  expect(records.map((project) => project.name)).toEqual(["Café fixture", "Sensor box"]);
});
it("hides an empty workspace navigator while keeping archive states available", () => {
  const props = { projects: [], selectedId: undefined, archivedCount: 0, onSelect: vi.fn(), onViewChange: vi.fn() };
  const view = render(<ProjectNavigator {...props} view="active" />);
  expect(screen.queryByRole("region", { name: "Project navigator" })).toBeNull();
  expect(screen.queryByLabelText("Filter project navigator")).toBeNull();
  expect(screen.queryByRole("button", { name: "Archived (0)" })).toBeNull();
  view.rerender(<ProjectNavigator {...props} archivedCount={2} view="active" />);
  expect(screen.getByText("No active projects. Open the archive to review earlier work.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Archived (2)" }));
  expect(props.onViewChange).toHaveBeenCalledWith("archived");
  fireEvent.click(screen.getByRole("button", { name: "Active projects" }));
  expect(props.onViewChange).toHaveBeenCalledWith("active");
  view.rerender(<ProjectNavigator {...props} view="archived" />);
  expect(screen.getByText("No archived projects.")).toBeTruthy();
});
