// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InventoryDrawer } from "./App";
import { inventory } from "./mock-data";
import { ApiError } from "./api";
import { UnsavedWorkContext, useNavigationGuard } from "./unsaved-work";
import { WorkspaceModal } from "./components/workspace-modal";
import { AlertDialogTitle } from "./components/ui/alert-dialog";
import type { ComponentProps } from "react";

afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 0)); });
const item = { ...inventory[0]!, evidence: "delivered" as const, serverEvidence: "delivered_uncounted" as const, reserved: 0, version: 3 };
const actions = () => ({ item, sampleMode: true, categories: [], categoriesLoading: false, expert: true, onClose: vi.fn(), onCount: vi.fn().mockResolvedValue({ ...item, quantity: 7, version: 4 }), onCommission: vi.fn().mockResolvedValue({ ...item, quantity: 7, version: 4 }), onUpdate: vi.fn() });
function GuardedDrawer(props: ComponentProps<typeof InventoryDrawer>) {
  const guard = useNavigationGuard();
  return <UnsavedWorkContext.Provider value={guard.registry}><InventoryDrawer {...props} suspended={Boolean(guard.pending)} onClose={() => guard.registry.request(props.onClose)} />{guard.pending && <WorkspaceModal kind="alertdialog" onClose={guard.cancel}><div role="alertdialog" aria-labelledby="draft-heading"><AlertDialogTitle id="draft-heading">Keep stock observation?</AlertDialogTitle><button onClick={guard.cancel}>Keep editing</button>{!guard.pending.unresolved && <button onClick={guard.discard}>Discard observation</button>}</div></WorkspaceModal>}</UnsavedWorkContext.Provider>;
}
function review(kind: "count" | "commission") {
  fireEvent.change(screen.getByLabelText(kind === "count" ? "Counted quantity" : "Observed quantity"), { target: { value: "7" } });
  if (kind === "commission") { fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Synthetic bench observation" } }); fireEvent.change(screen.getByLabelText("Observed"), { target: { value: "2026-10-03T09:00" } }); }
  fireEvent.click(screen.getByRole("button", { name: kind === "count" ? "Review physical count" : "Review commissioning" }));
  return screen.getByRole("alertdialog", { name: kind === "count" ? "Review physical count" : "Review stock commissioning" });
}
it("closes a clean drawer immediately and protects a measured count until explicit discard", () => {
  const props = actions(); render(<GuardedDrawer {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Close item details" })); expect(props.onClose).toHaveBeenCalledOnce(); props.onClose.mockClear();
  fireEvent.change(screen.getByLabelText("Counted quantity"), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "Close item details" })); expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" })); expect(screen.getByLabelText("Counted quantity")).toHaveProperty("value", "7");
  fireEvent.click(screen.getByRole("button", { name: "Close item details" })); fireEvent.click(screen.getByRole("button", { name: "Discard observation" })); expect(props.onClose).toHaveBeenCalledOnce();
});
for (const kind of ["count", "commission"] as const) {
  it(`shows definitive ${kind} failure inside review and returns to the preserved draft`, async () => {
    const props = actions(), save = kind === "count" ? props.onCount : props.onCommission;
    save.mockRejectedValueOnce(new ApiError("Synthetic stock conflict: reload before changing this observation.", { kind: "validation", status: 409 }));
    render(<GuardedDrawer {...props} />); const dialog = review(kind);
    fireEvent.click(within(dialog).getByRole("button", { name: kind === "count" ? "Confirm physical count" : "Commission stock" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Synthetic stock conflict");
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to item" }));
    expect(screen.getByLabelText(kind === "count" ? "Counted quantity" : "Observed quantity")).toHaveProperty("value", "7");
    fireEvent.click(screen.getByRole("button", { name: "Close item details" })); expect(props.onClose).not.toHaveBeenCalled();
  });
  it(`retains reviewed ${kind} input through ambiguous and rejected retries and clears the draft only after success`, async () => {
    const props = actions(), save = kind === "count" ? props.onCount : props.onCommission;
    save.mockRejectedValueOnce(new ApiError("Synthetic lost response", { kind: "offline", status: 0 })).mockRejectedValueOnce(new ApiError("Synthetic retry rejected", { kind: "validation", status: 409 }));
    const view = render(<GuardedDrawer {...props} />); const dialog = review(kind);
    fireEvent.click(within(dialog).getByRole("button", { name: kind === "count" ? "Confirm physical count" : "Commission stock" }));
    await within(dialog).findByRole("button", { name: "Retry unchanged observation" });
    expect(within(dialog).getByRole("button", { name: "Back to item" }).matches(":disabled")).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" }); expect(screen.getByRole("alertdialog", { name: kind === "count" ? "Review physical count" : "Review stock commissioning" })).toBeTruthy();
    view.rerender(<GuardedDrawer {...props} item={{ ...item, version: 99, quantity: 99 }} />);
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry unchanged observation" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Retry unchanged observation" }).matches(":disabled")).toBe(false));
    expect(within(dialog).getByRole("button", { name: "Back to item" }).matches(":disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry unchanged observation" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(save).toHaveBeenCalledTimes(3); expect(save.mock.calls[1]).toEqual(save.mock.calls[0]); expect(save.mock.calls[2]).toEqual(save.mock.calls[0]);
    if (kind === "commission") expect(save.mock.calls[0]![2]).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Close item details" })); expect(props.onClose).toHaveBeenCalledOnce();
  });
}
