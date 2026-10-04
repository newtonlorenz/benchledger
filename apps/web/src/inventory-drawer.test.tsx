// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InventoryDrawer } from "./App";
import { WorkspaceModal } from "./components/workspace-modal";
import { AlertDialogTitle } from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import { inventory } from "./mock-data";
import { ApiError, workflowRequest } from "./api";
import { UnsavedWorkContext, useNavigationGuard } from "./unsaved-work";

vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), workflowRequest: vi.fn() }));
afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 0)); vi.mocked(workflowRequest).mockReset(); });
const item = { ...inventory[0]!, evidence: "delivered" as const, serverEvidence: "delivered_uncounted" as const, availableQuantity: 0, reserved: 0, version: 3 };
const props = () => ({ item, categories: [], categoriesLoading: false, expert: true, onClose: vi.fn(), onCount: vi.fn().mockResolvedValue(item), onCommission: vi.fn().mockResolvedValue(item), onUpdate: vi.fn().mockResolvedValue(item), onDelete: vi.fn() });

it("focuses editing on item details and retains stock, commissioning and image drafts when cancelled", async () => {
  vi.mocked(workflowRequest).mockResolvedValue({ itemId: item.id, version: 0, images: [] });
  const actions = props();
  render(<InventoryDrawer {...actions} />);
  fireEvent.change(screen.getByLabelText("Counted quantity"), { target: { value: "7" } });
  fireEvent.change(screen.getByLabelText("Observed quantity"), { target: { value: "8" } });
  fireEvent.click(await screen.findByRole("button", { name: "Add image" }));
  const input = screen.getByLabelText("Image file") as HTMLInputElement;
  const file = new File(["synthetic photo"], "part.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText("Caption (optional)"), { target: { value: "Connector detail" } });
  fireEvent.click(screen.getByRole("button", { name: "Edit item" }));
  const edit = screen.getByRole("form", { name: "Edit item" });
  expect(within(edit).getByRole("textbox", { name: "Name" })).toBe(document.activeElement);
  expect(screen.queryByRole("spinbutton", { name: "Counted quantity" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Review commissioning" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Item images" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Delete (item|printer)/ })).toBeNull();
  fireEvent.change(within(edit).getByRole("textbox", { name: "Name" }), { target: { value: "Draft item name" } });
  fireEvent.click(within(edit).getByRole("button", { name: "Cancel" }));
  expect((screen.getByLabelText("Counted quantity") as HTMLInputElement).value).toBe("7");
  expect((screen.getByLabelText("Observed quantity") as HTMLInputElement).value).toBe("8");
  expect(screen.getByLabelText("Image file")).toBe(input);
  expect(input.files?.[0]).toBe(file);
  expect((screen.getByLabelText("Caption (optional)") as HTMLInputElement).value).toBe("Connector detail");
  fireEvent.click(screen.getByRole("button", { name: "Edit item" }));
  expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(item.name);
  expect(actions.onCount).not.toHaveBeenCalled();
  expect(actions.onCommission).not.toHaveBeenCalled();
  expect(actions.onUpdate).not.toHaveBeenCalled();
});

it("keeps a metadata draft through the existing leave guard and a failed versioned save", async () => {
  const actions = props();
  actions.onUpdate.mockRejectedValueOnce(new Error("Item changed. Reload before saving."));
  function GuardedDrawer() {
    const guard = useNavigationGuard();
    return <UnsavedWorkContext.Provider value={guard.registry}>
      <InventoryDrawer {...actions} sampleMode suspended={Boolean(guard.pending)} onClose={() => guard.registry.request(actions.onClose)} />
      {guard.pending && <WorkspaceModal kind="alertdialog" onClose={guard.cancel}><div role="alertdialog" aria-labelledby="unsaved-heading"><AlertDialogTitle id="unsaved-heading">Unsaved changes</AlertDialogTitle><p>{guard.pending.labels.join(", ")}</p><Button onClick={guard.cancel}>Keep editing</Button></div></WorkspaceModal>}
    </UnsavedWorkContext.Provider>;
  }
  render(<GuardedDrawer />);
  fireEvent.click(screen.getByRole("button", { name: "Edit item" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Updated label" } });
  fireEvent.click(screen.getByRole("button", { name: "Close item details" }));
  expect(actions.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("alertdialog", { name: "Unsaved changes" }).textContent).toContain("item details");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Updated label");
  fireEvent.submit(screen.getByRole("form", { name: "Edit item" }));
  await screen.findByText("Item changed. Reload before saving.");
  expect(actions.onUpdate).toHaveBeenCalledWith(item.id, expect.objectContaining({ name: "Updated label" }), 3);
  expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Updated label");
  expect(screen.queryByRole("button", { name: "Review physical count" })).toBeNull();
  actions.onUpdate.mockResolvedValueOnce({ ...item, name: "Updated label", version: 4 });
  // Settle the save and its draft-guard effect before the next user action.
  await act(async () => { fireEvent.submit(screen.getByRole("form", { name: "Edit item" })); });
  await waitFor(() => expect(screen.queryByRole("form", { name: "Edit item" })).toBeNull());
  expect(screen.getByRole("button", { name: "Review physical count" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close item details" }));
  expect(actions.onClose).toHaveBeenCalledOnce();
});


it("reviews explicit capture intent without writing, retains a failed count and finishes with a receipt", async () => {
  const actions = props(), onCountIntentConsumed = vi.fn(), onAddAnother = vi.fn();
  actions.onCount.mockRejectedValueOnce(new ApiError("Lost acknowledgement", { kind: "offline" })).mockResolvedValueOnce({ ...item, quantity: 8, evidence: "counted", serverEvidence: "physically_counted" });
  render(<InventoryDrawer {...actions} sampleMode initialCountQuantity={8} onCountIntentConsumed={onCountIntentConsumed} onAddAnother={onAddAnother} />);
  const review = screen.getByRole("alertdialog", { name: "Review physical count" });
  expect(actions.onCount).not.toHaveBeenCalled();
  expect(onCountIntentConsumed).toHaveBeenCalledOnce();
  fireEvent.click(within(review).getByRole("button", { name: "Confirm physical count" }));
  fireEvent.click(await within(review).findByRole("button", { name: "Retry unchanged observation" }));
  const receipt = await screen.findByText("Physical count saved");
  expect(actions.onCount.mock.calls).toEqual([[item.id, 8], [item.id, 8]]);
  expect(screen.queryByRole("spinbutton", { name: "Counted quantity" })).toBeNull();
  expect(receipt.closest('[role="status"]')).toBe(document.activeElement);
  fireEvent.click(screen.getByRole("button", { name: "Add another item" }));
  expect(onAddAnother).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(actions.onClose).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Update count" }));
  expect(screen.getByLabelText("Counted quantity")).toHaveProperty("value", "8");
});

it("returns to a requirement without asking to discard its parent draft and guards new item changes", () => {
  const actions = props(); const parentRegistry = { set: vi.fn(), request: vi.fn(), hasDraft: () => true };
  render(<UnsavedWorkContext.Provider value={parentRegistry}><InventoryDrawer {...actions} sampleMode nested doneLabel="Back to requirement" /></UnsavedWorkContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Back to requirement" }));
  expect(actions.onClose).toHaveBeenCalledOnce();
  expect(parentRegistry.request).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Counted quantity"), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "Back to requirement" }));
  expect(screen.getByRole("alertdialog", { name: "Discard this item draft?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("Counted quantity")).toHaveProperty("value", "9");
  expect(actions.onClose).toHaveBeenCalledOnce();
});

it("keeps a recorded count compact until an explicit update and edits missing descriptions as blank", () => {
  const actions = props();
  render(<InventoryDrawer {...actions} sampleMode item={{ ...item, evidence: "counted", description: "" }} />);
  expect(screen.queryByRole("spinbutton", { name: "Counted quantity" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Update count" }));
  expect(screen.getByLabelText("Counted quantity")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit item" }));
  expect(screen.getByLabelText("Description")).toHaveProperty("value", "");
});
