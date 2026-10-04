// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { AddBomDialog, NewProjectDialog } from "./App";
import { UnsavedWorkContext, useNavigationGuard } from "./unsaved-work";
import { WorkspaceModal } from "./components/workspace-modal";
import { AlertDialogTitle } from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import type { ProjectCreateInput } from "./api";
import { inventory, projects } from "./mock-data";

afterEach(async () => { cleanup(); await new Promise((resolve) => setTimeout(resolve, 0)); });
function DraftHarness({ kind, create = vi.fn(async () => "created" as const) }: { kind: "project" | "requirement"; create?: (input: ProjectCreateInput) => Promise<"created" | "ambiguous" | "failed"> }) {
  const guard = useNavigationGuard();
  const [open, setOpen] = useState(true);
  const close = () => guard.registry.request(() => setOpen(false));
  return <UnsavedWorkContext.Provider value={guard.registry}>
    {open && (kind === "project"
      ? <NewProjectDialog items={inventory} dismissalPending={Boolean(guard.pending)} onClose={close} onCreate={async (input) => { const outcome = await create(input); if (outcome === "created") setOpen(false); return outcome; }} />
      : <AddBomDialog items={inventory} project={projects[0]!} expert={false} dismissalPending={Boolean(guard.pending)} onClose={close} onCreate={async () => { await create({ name: "Synthetic requirement", description: "Test", fabricationRoute: "none" }); setOpen(false); return true; }} />)}
    {guard.pending && <WorkspaceModal kind="alertdialog" onClose={guard.cancel}><section><AlertDialogTitle>{guard.pending.unresolved ? "Finish the pending save" : "Leave without saving?"}</AlertDialogTitle><Button data-autofocus onClick={guard.cancel}>Keep editing</Button>{!guard.pending.unresolved && <Button onClick={guard.discard}>Discard changes and leave</Button>}</section></WorkspaceModal>}
  </UnsavedWorkContext.Provider>;
}
for (const kind of ["project", "requirement"] as const) {
  it(`retains the ${kind} draft after Escape until discard is chosen`, async () => {
    render(<DraftHarness kind={kind} />);
    const name = kind === "project" ? "Project name" : "Part name";
    fireEvent.change(screen.getByLabelText(name, { exact: true }), { target: { value: "Synthetic draft" } });
    fireEvent.keyDown(screen.getByLabelText(name, { exact: true }), { key: "Escape" });
    await screen.findByRole("alertdialog");
    expect(document.querySelector('.dialog[inert]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByLabelText(name, { exact: true })).toHaveProperty("value", "Synthetic draft");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes and leave" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it(`closes a blank ${kind} without prompting and a saved one without discard`, async () => {
    const view = render(<DraftHarness kind={kind} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    view.unmount();
    const create = vi.fn(async () => "created" as const);
    render(<DraftHarness kind={kind} create={create} />);
    fireEvent.change(screen.getByLabelText(kind === "project" ? "Project name" : "Part name", { exact: true }), { target: { value: "Synthetic draft" } });
    if (kind === "project") fireEvent.change(screen.getByLabelText("Project goal", { exact: true }), { target: { value: "Check the build" } });
    fireEvent.click(screen.getByRole("button", { name: kind === "project" ? "Create project" : "Add part" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
}
it("retains an unconfirmed project creation for recovery rather than discarding it", async () => {
  render(<DraftHarness kind="project" create={async () => "ambiguous"} />);
  fireEvent.change(screen.getByLabelText("Project name", { exact: true }), { target: { value: "Synthetic project" } });
  fireEvent.change(screen.getByLabelText("Project goal", { exact: true }), { target: { value: "Check acknowledgement" } });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByRole("alertdialog", { name: "Finish the pending save" });
  expect(screen.queryByRole("button", { name: "Discard changes and leave" })).toBeNull();
});

it("retries only the original unconfirmed project, including after a failed retry", async () => {
  const create = vi.fn<(input: ProjectCreateInput) => Promise<"created" | "ambiguous" | "failed">>()
    .mockResolvedValueOnce("ambiguous").mockResolvedValueOnce("failed").mockResolvedValueOnce("created");
  render(<DraftHarness kind="project" create={create} />);
  fireEvent.change(screen.getByLabelText("Project name", { exact: true }), { target: { value: "Original project" } });
  fireEvent.change(screen.getByLabelText("Project goal", { exact: true }), { target: { value: "Original goal" } });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByRole("button", { name: "Retry unchanged project" });
  expect(screen.getByLabelText("Project name", { exact: true })).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("Project goal", { exact: true })).toHaveProperty("disabled", true);
  // Even a synthetic change event cannot replace the payload retained for recovery.
  fireEvent.change(screen.getByLabelText("Project name", { exact: true }), { target: { value: "Changed project" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry unchanged project" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  await screen.findByText("The retry was not confirmed. Your original project details are retained. Retry the unchanged project.");
  expect(screen.getByLabelText("Project name", { exact: true })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Retry unchanged project" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(create).toHaveBeenCalledTimes(3);
  for (const [input] of create.mock.calls) expect(input).toEqual({ name: "Original project", description: "Original goal", fabricationRoute: "undecided" });
});


it("locks the printer picker while project creation is pending and unconfirmed", async () => {
  let resolveCreate!: (outcome: "ambiguous") => void;
  const create = vi.fn(() => new Promise<"ambiguous">((resolve) => { resolveCreate = resolve; }));
  render(<DraftHarness kind="project" create={create} />);
  fireEvent.change(screen.getByLabelText("Project name", { exact: true }), { target: { value: "Printed project" } });
  fireEvent.change(screen.getByLabelText("Project goal", { exact: true }), { target: { value: "Check printer recovery" } });
  fireEvent.click(screen.getByRole("button", { name: "Planning details" }));
  fireEvent.click(screen.getByRole("radio", { name: /3D-print parts/i }));
  const picker = screen.getByPlaceholderText("Choose an owned printer");
  const fieldset = picker.closest("fieldset")!;
  expect(fieldset.disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  expect(fieldset.disabled).toBe(true);
  expect(fieldset.hasAttribute("inert")).toBe(true);
  expect(picker.matches(":disabled")).toBe(true);
  resolveCreate("ambiguous");
  await screen.findByRole("button", { name: "Retry unchanged project" });
  expect(fieldset.disabled).toBe(true);
  expect(fieldset.hasAttribute("inert")).toBe(true);
  expect(picker.matches(":disabled")).toBe(true);
});

it("does not warn about a hidden printer after returning a blank project to undecided", async () => {
  render(<DraftHarness kind="project" />);
  fireEvent.click(screen.getByRole("button", { name: "Planning details" }));
  fireEvent.click(screen.getByRole("radio", { name: /3D-print parts/i }));
  fireEvent.click(document.querySelector<HTMLButtonElement>(".owned-quick-choice")!);
  expect(screen.getByText("Owned item")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /Decide later/i }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});
