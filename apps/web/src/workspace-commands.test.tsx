// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceCommands } from "./workspace-commands";
Element.prototype.scrollIntoView = function scrollIntoView() { return undefined; };
import type { WorkspaceCommand } from "./workspace-commands";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const nav: WorkspaceCommand = { id: "page:inventory", label: "Inventory", detail: "Open inventory", group: "Navigation", icon: "box", run: () => undefined };

describe("workspace command palette", () => {
  it("searches the whole inventory on the server, debounced, and opens the chosen item", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const onSearchItems = vi.fn(async (query: string) => [{ id: `item:${query}`, label: "M3 heat-set insert", detail: "Drawer 4", group: "Inventory" as const, icon: "box" as const, run }]);
    const onRun = vi.fn((command: WorkspaceCommand) => command.run());
    render(<WorkspaceCommands commands={[nav]} onRun={onRun} onSearchInventory={() => undefined} onSearchItems={onSearchItems} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "insert" } });
    expect(onSearchItems).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });
    expect(onSearchItems).toHaveBeenCalledWith("insert", expect.any(AbortSignal));
    const option = screen.getByRole("option", { name: /M3 heat-set insert/u });
    fireEvent.click(option);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not query the server for one-character input", async () => {
    vi.useFakeTimers();
    const onSearchItems = vi.fn(async () => []);
    render(<WorkspaceCommands commands={[nav]} onRun={() => undefined} onSearchInventory={() => undefined} onSearchItems={onSearchItems} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "m" } });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(onSearchItems).not.toHaveBeenCalled();
  });
});
