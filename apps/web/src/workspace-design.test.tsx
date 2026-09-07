// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { appearanceKey, defaultAppearance, parseAppearance, readAppearance, applyAppearance, storeAppearance } from "./appearance";
import { AppearanceControl, useAppearance } from "./workspace-controls";
import { WorkspaceCommands, filterWorkspaceCommands } from "./workspace-commands";
import type { WorkspaceCommand } from "./workspace-commands";
import { WorkbenchMetrics, WorkbenchRegister } from "./workbench-register";
import { projects, inventory } from "./mock-data";
let dark = false;
const listeners = new Set<() => void>();
beforeEach(() => {
  localStorage.clear(); dark = false; listeners.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ get matches() { return dark; }, addEventListener: (_event: string, callback: () => void) => listeners.add(callback), removeEventListener: (_event: string, callback: () => void) => listeners.delete(callback) })));
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("accepts only known appearance settings and recovers from invalid storage", () => {
  for (const raw of [null, "", "bad-json", "[]", "null", "42"]) expect(parseAppearance(raw)).toEqual(defaultAppearance);
  expect(parseAppearance('{"colourMode":"blue","density":"tiny","collapsed":"yes"}')).toEqual(defaultAppearance);
  expect(parseAppearance('{"colourMode":"dark","density":"compact","collapsed":true}')).toEqual({ colourMode: "dark", density: "compact", collapsed: true });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(readAppearance()).toEqual(defaultAppearance);
});
it("applies system preference and remains usable when persistence is blocked", () => {
  dark = true; applyAppearance(defaultAppearance); expect(document.documentElement.dataset.theme).toBe("dark");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  storeAppearance({ colourMode: "light", density: "compact", collapsed: true });
  expect(document.documentElement.dataset).toMatchObject({ theme: "light", density: "compact", nav: "rail" });
});
function Preferences() { const preference = useAppearance(); return <AppearanceControl value={preference.value} onChange={preference.change} />; }
it("changes local theme and density, follows system changes and responds to other tabs", async () => {
  render(<Preferences />); fireEvent.click(screen.getByLabelText("Workspace appearance"));
  fireEvent.click(screen.getByRole("radio", { name: "Dark", hidden: true }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  fireEvent.click(screen.getByRole("radio", { name: "Compact", hidden: true }));
  expect(parseAppearance(localStorage.getItem(appearanceKey))).toMatchObject({ density: "compact", colourMode: "dark" });
  fireEvent.click(screen.getByRole("radio", { name: "System", hidden: true }));
  dark = true; for (const callback of listeners) callback(); expect(document.documentElement.dataset.theme).toBe("dark");
  fireEvent(window, new StorageEvent("storage", { key: appearanceKey, newValue: '{"colourMode":"light"}' }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
  fireEvent(window, new StorageEvent("storage", { key: "other", newValue: "ignore" }));
  expect(document.documentElement.dataset.theme).toBe("light");
  fireEvent(window, new StorageEvent("storage", { key: null, newValue: null }));
  await waitFor(() => expect((screen.getByRole("radio", { name: "System", hidden: true }) as HTMLInputElement).checked).toBe(true));
});
it("closes view controls on Escape and outside pointer clicks", async () => {
  render(<Preferences />); const trigger = screen.getByLabelText("Workspace appearance"); const details = trigger.closest("details")!;
  details.open = true; fireEvent(details, new Event("toggle")); await waitFor(() => expect(details.open).toBe(true));
  fireEvent.keyDown(document, { key: "Escape" }); expect(details.open).toBe(false); expect(document.activeElement).toBe(trigger);
  details.open = true; fireEvent(details, new Event("toggle"));
  fireEvent.pointerDown(document.body); expect(details.open).toBe(false);
});
const commands = (run = vi.fn()): WorkspaceCommand[] => [
  { id: "inventory", label: "Inventory", detail: "Find stock records", group: "Navigation", icon: "box", run },
  { id: "project", label: "Café fixture", detail: "Assembly revision", group: "Projects", icon: "folder", run },
  { id: "new", label: "New project", detail: "Add a project", group: "Actions", icon: "plus", run }
];
it("filters commands across labels and details without changing user records", () => {
  const source = commands(); const before = JSON.stringify(source);
  expect(filterWorkspaceCommands(source, "revision cafe").map((entry) => entry.id)).toEqual(["project"]);
  expect(filterWorkspaceCommands(source, "no-match")).toEqual([]);
  expect(filterWorkspaceCommands(Array.from({ length: 40 }, (_, i) => ({ ...source[0]!, id: String(i) })), "")).toHaveLength(12);
  expect(JSON.stringify(source)).toBe(before);
});
it("supports keyboard selection, pointer selection and the full-search fallback", () => {
  const onRun = vi.fn(), onSearchInventory = vi.fn(); render(<WorkspaceCommands commands={commands()} onRun={onRun} onSearchInventory={onSearchInventory} />);
  const input = screen.getByRole("combobox");
  fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" }); expect(onRun.mock.calls[0]?.[0].id).toBe("project");
  fireEvent.keyDown(input, { key: "End" }); fireEvent.keyDown(input, { key: "Enter" }); expect(onRun.mock.calls[1]?.[0].id).toBe("new");
  fireEvent.keyDown(input, { key: "Home" }); fireEvent.keyDown(input, { key: "ArrowUp" }); fireEvent.keyDown(input, { key: "Enter" }); expect(onRun.mock.calls[2]?.[0].id).toBe("new");
  const option = screen.getByRole("option", { name: /Inventory/u }); fireEvent.pointerMove(option); fireEvent.mouseDown(option); fireEvent.click(option); expect(onRun.mock.calls[3]?.[0].id).toBe("inventory");
  fireEvent.change(input, { target: { value: "missing" } }); fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" }); expect(onRun).toHaveBeenCalledTimes(4);
  fireEvent.click(screen.getByRole("button", { name: "Search inventory" })); expect(onSearchInventory).toHaveBeenCalledOnce();
});
it("shows actual loaded project totals and keeps unknown stock results explicit", () => {
  const project = { ...structuredClone(projects[0]!), readinessUnavailable: true, gapEvaluation: undefined };
  const { gapEvaluation: _gap, ...withoutGap } = project;
  render(<WorkbenchMetrics projects={[withoutGap]} items={inventory} />);
  expect(screen.getByLabelText("Loaded workspace summary").textContent).toContain("Loaded stock records");
  expect(screen.getAllByText("?")).toHaveLength(2);
});
it("opens a selected project and has an honest empty state", () => {
  const onOpen = vi.fn(); const rendered = render(<WorkbenchRegister projects={projects} items={inventory} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: `Open project ${projects[0]!.name}` })); expect(onOpen).toHaveBeenCalledWith(projects[0]!.id);
  rendered.rerender(<WorkbenchRegister projects={[]} items={[]} onOpen={onOpen} />); expect(screen.getByText("No projects yet")).toBeTruthy();
});
