// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { EditBuildApproachDialog, NewRevisionDialog, ScopedDraftDialog } from "./App";
import { ProjectEditForm } from "./project-editing";
import { UnsavedWorkContext, useNavigationGuard, useUnsavedWork } from "./unsaved-work";
import { ApiError } from "./api";
import type { ProjectEditInput, ProjectRevisionUpdateInput, RevisionInput } from "./api";
import { inventory, projects } from "./mock-data";
afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 0)); });
const project = { ...projects[0]!, fabricationRoute: "undecided" as const, intendedPrinterItemId: null };
function ParentDraft() { useUnsavedWork(true, "underlying build plan"); return null; }
function EditHarness({ save, close = vi.fn() }: { save: (input: ProjectEditInput) => Promise<void>; close?: () => void }) {
  const [draft, setDraft] = useState({ dirty: false, unresolved: false });
  return <ScopedDraftDialog title="Edit project" {...draft} onClose={close}>{requestClose => <ProjectEditForm project={project} onDraftChange={setDraft} onBusy={() => undefined} onClose={requestClose} onSave={save} />}</ScopedDraftDialog>;
}
it("protects project brief edits on Escape and retains them until explicit discard", async () => {
  const close = vi.fn(); render(<EditHarness save={async () => undefined} close={close} />);
  fireEvent.change(screen.getByLabelText("Project goal and brief"), { target: { value: "Synthetic long brief to retain" } });
  fireEvent.keyDown(screen.getByLabelText("Project goal and brief"), { key: "Escape" });
  await screen.findByRole("alertdialog", { name: "Discard this draft?" });
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("Project goal and brief")).toHaveProperty("value", "Synthetic long brief to retain");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" })); expect(close).toHaveBeenCalledOnce();
});
it("keeps a project correction unresolved and retries its original payload after a rejected retry", async () => {
  const save = vi.fn<(input: ProjectEditInput) => Promise<void>>().mockRejectedValueOnce(new ApiError("Lost response", { kind: "offline" })).mockRejectedValueOnce(new ApiError("Retry rejected", { kind: "validation", status: 409 })).mockResolvedValueOnce(undefined);
  render(<EditHarness save={save} />);
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Original correction" } });
  fireEvent.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByRole("button", { name: "Retry unchanged save" });
  expect(screen.getByLabelText("Project name").matches(":disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Synthetic event on disabled field" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry unchanged save" })); await screen.findByText("Retry rejected");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await screen.findByRole("alertdialog", { name: "Finish the pending save" });
  expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  fireEvent.click(screen.getByRole("button", { name: "Retry unchanged save" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
  for (const [input] of save.mock.calls) expect(input.name).toBe("Original correction");
});
for (const kind of ["revision", "approach"] as const) {
  it(`keeps changed ${kind} fields when dismissal is cancelled`, async () => {
    const close = vi.fn();
    render(kind === "revision" ? <NewRevisionDialog project={project} items={[]} expert={false} onClose={close} onCreate={async () => false} /> : <EditBuildApproachDialog project={project} items={[]} expert={false} onClose={close} onSave={async () => false} />);
    if (kind === "revision") fireEvent.change(screen.getByLabelText("Notes (optional)"), { target: { value: "Synthetic revision notes to retain" } });
    else fireEvent.click(screen.getByRole("radio", { name: /Electronics \/ assembly only/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    if (kind === "revision") expect(screen.getByLabelText("Notes (optional)")).toHaveProperty("value", "Synthetic revision notes to retain");
    else expect(screen.getByRole("radio", { name: /Electronics \/ assembly only/ }).getAttribute("aria-checked")).toBe("true");
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));expect(close).toHaveBeenCalledOnce();
  });
  it(`retains the original ${kind} command through uncertain and rejected retries`, async () => {
    const save = vi.fn<(input: RevisionInput | ProjectRevisionUpdateInput) => Promise<boolean>>().mockRejectedValueOnce(new ApiError("Lost response", { kind: "server", status: 502 })).mockRejectedValueOnce(new ApiError("Retry rejected", { kind: "validation", status: 409 })).mockResolvedValueOnce(true);
    render(kind === "revision" ? <NewRevisionDialog project={project} items={[]} expert={false} onClose={vi.fn()} onCreate={save} /> : <EditBuildApproachDialog project={project} items={[]} expert={false} onClose={vi.fn()} onSave={save} />);
    if (kind === "revision") fireEvent.change(screen.getByLabelText("Revision name"), { target: { value: "Original revision" } });
    fireEvent.click(screen.getByRole("radio", { name: /Electronics \/ assembly only/ }));
    fireEvent.click(screen.getByRole("button", { name: kind === "revision" ? "Create revision" : "Save build approach" }));
    const retryLabel = kind === "revision" ? "Retry unchanged revision" : "Retry unchanged build approach";
    await screen.findByRole("button", { name: retryLabel });
    expect(screen.getByRole("radio", { name: /Electronics \/ assembly only/ }).matches(":disabled")).toBe(true);
    if (kind === "revision") fireEvent.change(screen.getByLabelText("Revision name"), { target: { value: "Synthetic event on disabled field" } });
    fireEvent.click(screen.getByRole("button", { name: retryLabel })); await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: retryLabel }).matches(":disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));await screen.findByRole("alertdialog", { name: "Finish the pending save" });expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: retryLabel }));await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    for (const [input] of save.mock.calls) expect(input).toEqual(save.mock.calls[0]![0]);
  });
}
it("closes a clean child approach without asking to discard its underlying build draft", () => {
  const close = vi.fn(); function Harness() { const guard = useNavigationGuard(); return <UnsavedWorkContext.Provider value={guard.registry}><ParentDraft /><EditBuildApproachDialog project={project} items={[]} expert={false} onClose={close} onSave={async () => true} />{guard.pending && <div data-testid="parent-discard" />}</UnsavedWorkContext.Provider>; }
  render(<Harness />); fireEvent.click(screen.getByRole("button", { name: "Cancel" }));expect(close).toHaveBeenCalledOnce();expect(screen.queryByRole("alertdialog")).toBeNull();expect(screen.queryByTestId("parent-discard")).toBeNull();
});
it("retains revision notes and page-leave protection while printer capture temporarily suspends it", async () => {
  function Harness() { const guard = useNavigationGuard(), [suspended, setSuspended] = useState(false); return <UnsavedWorkContext.Provider value={guard.registry}><NewRevisionDialog project={project} items={[]} expert={false} suspended={suspended} onAddPrinter={() => setSuspended(true)} onClose={vi.fn()} onCreate={async () => false} />{suspended && <><button onClick={() => guard.registry.request(() => undefined)}>Leave page</button><button onClick={() => setSuspended(false)}>Return from printer</button></>}{guard.pending && <div role="alertdialog">Revision still protected<button onClick={guard.cancel}>Keep revision</button></div>}</UnsavedWorkContext.Provider>; }
  render(<Harness />);fireEvent.change(screen.getByLabelText("Notes (optional)"), { target: { value: "Retain these measured dimensions" } });fireEvent.click(screen.getByRole("radio", { name: /3D-print parts/ }));fireEvent.click(screen.getByRole("button", { name: "Add printer" }));fireEvent.click(screen.getByRole("button", { name: "Leave page" }));await screen.findByRole("alertdialog");fireEvent.click(screen.getByRole("button", { name: "Keep revision" }));fireEvent.click(screen.getByRole("button", { name: "Return from printer" }));expect(screen.getByLabelText("Notes (optional)")).toHaveProperty("value", "Retain these measured dimensions");
});

it("keeps the saved printer when build approach is saved before inventory hydration", async () => {
  const save = vi.fn(async () => true);
  render(<EditBuildApproachDialog project={{ ...project, fabricationRoute: "printed", intendedPrinterItemId: "eq-h2d" }} items={[]} expert={false} onClose={vi.fn()} onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Save build approach" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ fabricationRoute: "printed", intendedPrinterItemId: "eq-h2d" }));
});
for (const kind of ["revision", "approach"] as const) {
  it(`hydrates carried ${kind} choices without marking the unchanged draft dirty`, () => {
    const close = vi.fn();
    const carriedProject = { ...project, fabricationRoute: "printed" as const, intendedPrinterItemId: "eq-h2d" };
    const dialog = (items: typeof inventory) => kind === "revision"
      ? <NewRevisionDialog project={carriedProject} items={items} expert onClose={close} onCreate={async () => true} />
      : <EditBuildApproachDialog project={carriedProject} items={items} expert onClose={close} onSave={async () => true} />;
    const view = render(dialog([])); view.rerender(dialog(inventory));
    expect(screen.getByRole("combobox", { name: kind === "revision" ? "Printer for this revision" : "Printer for this project" })).toHaveProperty("value", expect.stringContaining("H2D"));
    if (kind === "revision" && carriedProject.buildConfigSnapshot?.filamentItemId) expect(screen.getByRole("combobox", { name: "Filament (optional technical setup)" })).not.toHaveProperty("value", "");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledOnce(); expect(screen.queryByRole("alertdialog")).toBeNull();
  });
}
it("does not restore a printer explicitly cleared after hydration", async () => {
  const save = vi.fn(async () => true), carriedProject = { ...project, fabricationRoute: "printed" as const, intendedPrinterItemId: "eq-h2d" };
  const dialog = (items: typeof inventory) => <EditBuildApproachDialog project={carriedProject} items={items} expert={false} onClose={vi.fn()} onSave={save} />;
  const view = render(dialog([])); view.rerender(dialog(inventory));
  fireEvent.change(screen.getByRole("combobox", { name: "Printer for this project" }), { target: { value: "" } });
  view.rerender(dialog([...inventory]));
  expect(screen.getByRole("combobox", { name: "Printer for this project" })).toHaveProperty("value", "");
  fireEvent.click(screen.getByRole("button", { name: "Save build approach" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ fabricationRoute: "printed", intendedPrinterItemId: null }));
});
