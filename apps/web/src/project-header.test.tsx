// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeleteProjectConfirmation, OverflowMenu, ProjectSwitcher, RecordUseAction } from "./project-header";

afterEach(cleanup);

const projects = [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }, { id: "c", name: "Charlie" }];

describe("project switcher", () => {
  it("does not navigate while arrowing through projects; Enter commits", () => {
    const onSelect = vi.fn();
    render(<ProjectSwitcher projects={projects} value="a" onSelect={onSelect} />);
    const select = screen.getByRole("combobox", { name: "Choose project" });
    fireEvent.keyDown(select, { key: "ArrowDown" });
    fireEvent.change(select, { target: { value: "b" } });
    fireEvent.keyDown(select, { key: "ArrowDown" });
    fireEvent.change(select, { target: { value: "c" } });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(select, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("c");
  });

  it("commits a keyboard choice on blur and a pointer choice immediately", () => {
    const onSelect = vi.fn();
    render(<ProjectSwitcher projects={projects} value="a" onSelect={onSelect} />);
    const select = screen.getByRole("combobox", { name: "Choose project" });
    fireEvent.keyDown(select, { key: "ArrowDown" });
    fireEvent.change(select, { target: { value: "b" } });
    fireEvent.blur(select);
    expect(onSelect).toHaveBeenLastCalledWith("b");
    fireEvent.change(select, { target: { value: "c" } });
    expect(onSelect).toHaveBeenLastCalledWith("c");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("Escape abandons a keyboard choice", () => {
    const onSelect = vi.fn();
    render(<ProjectSwitcher projects={projects} value="a" onSelect={onSelect} />);
    const select = screen.getByRole("combobox", { name: "Choose project" }) as HTMLSelectElement;
    fireEvent.keyDown(select, { key: "ArrowDown" });
    fireEvent.change(select, { target: { value: "b" } });
    fireEvent.keyDown(select, { key: "Escape" });
    fireEvent.blur(select);
    expect(onSelect).not.toHaveBeenCalled();
    expect(select.value).toBe("a");
  });
});

describe("delete project confirmation", () => {
  it("enables deletion only after the exact project name is typed", () => {
    const onConfirm = vi.fn();
    render(<DeleteProjectConfirmation projectName="Desk lamp" busy={false} onConfirm={onConfirm} onCancel={() => {}} />);
    const button = screen.getByRole("button", { name: "Delete project" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText(/Type the project name/u), { target: { value: "desk lamp" } });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText(/Type the project name/u), { target: { value: " Desk lamp " } });
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("record use action", () => {
  it("opens the used-stock step when it is available", () => {
    const onOpen = vi.fn();
    render(<RecordUseAction available onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Record use" }));
    expect(onOpen).toHaveBeenCalled();
  });

  it("explains why recording use is unavailable instead of hiding it", () => {
    render(<RecordUseAction available={false} reason="This service does not support recording used stock yet." onOpen={() => {}} />);
    const button = screen.getByRole("button", { name: "Record use" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("This service does not support recording used stock yet.")).toBeTruthy();
  });
});

describe("project overflow menu", () => {
  const setup = () => {
    const edit = vi.fn(), exportSummary = vi.fn(), revision = vi.fn();
    render(<div><OverflowMenu label="More project actions" items={[{ id: "edit", label: "Edit project", onSelect: edit }, { id: "export", label: "Export summary", onSelect: exportSummary }, { id: "revision", label: "New revision", onSelect: revision, disabled: true }]} /><button type="button">Outside</button></div>);
    return { trigger: screen.getByRole("button", { name: "More project actions" }), edit, exportSummary, revision };
  };

  it("is a closed menu button until opened", () => {
    const { trigger } = setup();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on click, focuses the first item, and moves with arrow keys, Home and End", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "More project actions" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Edit project", "Export summary", "New revision"]);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
  });

  it("closes on Escape and returns focus to the button", () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("ArrowUp on the button opens at the last item", () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("runs an item once, closes and returns focus; disabled items do nothing", () => {
    const { trigger, exportSummary, revision } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "New revision" }));
    expect(revision).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Export summary" }));
    expect(exportSummary).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes without moving focus when the pointer goes elsewhere", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
