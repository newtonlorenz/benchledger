// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceModal } from "./components/workspace-modal";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { DialogTitle } from "./components/ui/dialog";
import { Button } from "./components/ui/button";

afterEach(cleanup);

function FirstRequirement() {
  const [editing, setEditing] = useState(false), [saved, setSaved] = useState(false);
  return <>
    {!saved && <Button data-focus-return="add-project-requirement" onClick={() => setEditing(true)}>Add first requirement</Button>}
    <Button id="add-project-requirement" onClick={() => setEditing(true)}>Add a requirement</Button>
    {editing && <WorkspaceModal onClose={() => setEditing(false)}><section><DialogTitle>Add requirement</DialogTitle><Button onClick={() => { setSaved(true); setEditing(false); }}>Save requirement</Button></section></WorkspaceModal>}
  </>;
}

it("returns a disappearing first-use action to the persistent add requirement control", async () => {
  render(<FirstRequirement />);
  const first = screen.getByRole("button", { name: "Add first requirement" });
  first.focus(); fireEvent.click(first);
  fireEvent.click(await screen.findByRole("button", { name: "Save requirement" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a requirement" })));
  expect(screen.queryByRole("button", { name: "Add first requirement" })).toBeNull();
});

function ProjectTool({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  return <>
    <Popover><PopoverTrigger asChild><Button>Project tools</Button></PopoverTrigger><PopoverContent aria-label="Project tools"><Button onClick={() => setEditing(true)}>{title}</Button></PopoverContent></Popover>
    {editing && <WorkspaceModal onClose={() => setEditing(false)}><section><DialogTitle>{title}</DialogTitle><label>Draft<input aria-label="Draft" /></label><Button onClick={() => setEditing(false)}>Cancel</Button></section></WorkspaceModal>}
  </>;
}

it.each(["New revision", "Edit project"])("returns %s dismissal to the persistent project tools launcher", async (title) => {
  render(<ProjectTool title={title} />);
  const launcher = screen.getByRole("button", { name: "Project tools" });
  for (const close of ["escape", "cancel"]) {
    fireEvent.click(launcher);
    const action = screen.getByRole("button", { name: title });
    action.focus(); fireEvent.click(action);
    await screen.findByRole("dialog", { name: title });
    await waitFor(() => expect(screen.queryByRole("button", { name: title })).toBeNull());
    if (close === "escape") fireEvent.keyDown(document, { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: title })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(launcher));
  }
});
