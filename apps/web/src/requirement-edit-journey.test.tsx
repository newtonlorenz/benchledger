// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { RequirementEditForm } from "./project-editing";
import { UnsavedWorkContext, useNavigationGuard } from "./unsaved-work";
import { ApiError } from "./api";
import type { BomUpdateInput } from "./api";
import { inventory } from "./mock-data";
import type { BomLine } from "./domain";
afterEach(cleanup);
const line: BomLine = { id: "synthetic-line", version: 2, label: "Synthetic screw", required: 4, unit: "each", role: "consumed" };
const stock = { ...inventory.find((item) => item.category !== "Printers")!, id: "synthetic-stock", name: "Synthetic screw", unit: "each" as const, quantity: 8, availableQuantity: 8, reserved: 0, evidence: "counted" as const, serverEvidence: "physically_counted" as const, tags: [] };
const props = { line, items: [stock], onSave: async () => undefined, onRetire: async () => undefined, onClose: () => undefined, onBusy: () => undefined };

it("opens stock matching at the candidate search and saves only the explicit item patch", async () => {
  const save = vi.fn(async () => undefined);
  render(<RequirementEditForm {...props} initialFocus="stock" onSave={save} />);
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search matching inventory" }));
  expect(screen.queryByRole("textbox", { name: "Requirement name" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Choose owned item Synthetic screw" }));
  fireEvent.click(screen.getByRole("button", { name: "Save requirement" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ itemId: stock.id }));
});

it("preserves an owned item outside the loaded page unless explicitly cleared", async () => {
  const save = vi.fn(async () => undefined);
  render(<RequirementEditForm {...props} line={{ ...line, itemId: "unloaded-stock" }} initialFocus="stock" onSave={save} />);
  expect(screen.getByRole("status").textContent).toContain("outside the loaded inventory");
  fireEvent.click(screen.getByRole("button", { name: "Clear owned item selection" }));
  fireEvent.click(screen.getByRole("button", { name: "Save requirement" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ itemId: null }));
});

function GuardedEdit() {
  const guard = useNavigationGuard(); const [open, setOpen] = useState(true);
  return <UnsavedWorkContext.Provider value={guard.registry}>{open && <RequirementEditForm {...props} onClose={() => guard.registry.request(() => setOpen(false))} />}{guard.pending && <div role="alertdialog"><button onClick={guard.cancel}>Keep editing</button><button onClick={guard.discard}>Discard changes</button></div>}</UnsavedWorkContext.Provider>;
}
it("keeps changed requirement values until discard is explicit", async () => {
  render(<GuardedEdit />);
  fireEvent.change(screen.getByLabelText("Requirement name"), { target: { value: "Changed synthetic screw" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("Requirement name")).toHaveProperty("value", "Changed synthetic screw");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.queryByLabelText("Requirement name")).toBeNull();
});

it("retains the exact original patch through ambiguous and failed retries", async () => {
  const save = vi.fn<(input: BomUpdateInput) => Promise<void>>()
    .mockRejectedValueOnce(new ApiError("Synthetic connection lost", { kind: "offline" }))
    .mockRejectedValueOnce(new ApiError("Synthetic retry failed", { kind: "validation", status: 409 }))
    .mockResolvedValueOnce(undefined);
  render(<RequirementEditForm {...props} onSave={save} />);
  fireEvent.change(screen.getByLabelText("Requirement name"), { target: { value: "Original correction" } });
  fireEvent.click(screen.getByRole("button", { name: "Save requirement" }));
  await screen.findByRole("button", { name: "Retry unchanged save" });
  expect(screen.getByLabelText("Requirement name").matches(":disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Requirement name"), { target: { value: "Synthetic event on disabled field" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry unchanged save" }));
  await screen.findByText("Synthetic retry failed");
  expect(screen.getByLabelText("Requirement name").matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry unchanged save" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
  for (const [input] of save.mock.calls) expect(input).toEqual({ name: "Original correction" });
});

it("updates the stock-mode summary when a different requirement unit is explicitly chosen", () => {
  render(<RequirementEditForm {...props} line={{ ...line, itemId: stock.id }} items={[{ ...stock, unit: "g" }]} initialFocus="stock" />);
  fireEvent.click(screen.getByRole("button", { name: "Use grams for this requirement" }));
  expect(screen.getByText("Synthetic screw · 4 g required. Review an owned item before sourcing.")).toBeTruthy();
});

it("closes a normalised no-op correction without claiming unsaved changes", () => {
  render(<GuardedEdit />);
  fireEvent.change(screen.getByLabelText("Requirement name"), { target: { value: "  Synthetic screw  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save requirement" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByLabelText("Requirement name")).toBeNull();
});

it("uses server search from the stock edit entry when the candidate is outside the loaded inventory", async () => {
  const save = vi.fn(async () => undefined);
  const search = vi.fn().mockResolvedValue({ items: [stock], total: 1, limit: 25 });
  render(<RequirementEditForm {...props} items={[]} initialFocus="stock" onSearchOwnedItems={search} onSave={save}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Choose owned item Synthetic screw" }));
  fireEvent.click(screen.getByRole("button", { name: "Save requirement" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ itemId: stock.id }));
  expect(search).toHaveBeenCalledWith(line.label, expect.any(AbortSignal));
});
