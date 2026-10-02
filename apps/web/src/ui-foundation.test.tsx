// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceModal } from "./components/workspace-modal";
import { DialogTitle } from "./components/ui/dialog";
import { AlertDialogTitle } from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { SearchCombobox } from "./components/search-combobox";
afterEach(cleanup);
it("retains an editor draft while a nested confirmation opens and closes", async () => {
 function Editor() { const [draft,setDraft]=useState("");const[confirm,setConfirm]=useState(false);return <><WorkspaceModal onClose={()=>setConfirm(true)}><section inert={confirm}><DialogTitle>Edit record</DialogTitle><Input aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)}/><Button onClick={()=>setConfirm(true)}>Close editor</Button></section></WorkspaceModal>{confirm&&<WorkspaceModal kind="alertdialog" onClose={()=>setConfirm(false)}><section><AlertDialogTitle>Leave draft?</AlertDialogTitle><Button data-autofocus onClick={()=>setConfirm(false)}>Keep editing</Button></section></WorkspaceModal>}</>; }
 render(<Editor/>);fireEvent.change(screen.getByLabelText("Draft"),{target:{value:"Unsaved maker notes"}});fireEvent.click(screen.getByRole("button",{name:"Close editor"}));
 await waitFor(()=>expect(screen.getByRole("button",{name:"Keep editing"})).toBe(document.activeElement));
 fireEvent.keyDown(document.activeElement!, {key:"Escape"});
 await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());expect(screen.getByLabelText("Draft")).toHaveProperty("value","Unsaved maker notes");
 fireEvent.click(screen.getByRole("button",{name:"Close editor"}));
 await waitFor(()=>expect(screen.getByRole("button",{name:"Keep editing"})).toBe(document.activeElement));
 fireEvent.keyDown(document.activeElement!, {key:"Escape"});
 await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
 expect(screen.getByLabelText("Draft")).toHaveProperty("value","Unsaved maker notes");
});
it("uses keyboard selection in the shared search picker and closes its results", async () => {
 const select=vi.fn();render(<SearchCombobox label="Owned item" value="" onValueChange={()=>{}} options={[{id:"first",content:"First item"},{id:"second",content:"Second item"}]} onSelect={select} empty="No stock"/>);
 const input=screen.getByRole("combobox");fireEvent.focus(input);await screen.findByRole("option",{name:"First item"});fireEvent.keyDown(input,{key:"ArrowDown"});fireEvent.keyDown(input,{key:"Enter"});expect(select).toHaveBeenCalledWith("second");expect(screen.queryByRole("listbox")).toBeNull();
});
