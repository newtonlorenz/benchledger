// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GuidedSetup } from "./guided-setup";
import { createSampleWorkspaceAdapter } from "./api";
import { inventory } from "./mock-data";
import { UnsavedWorkContext, useNavigationGuard } from "./unsaved-work";
afterEach(cleanup);

it("previews a name and requirement without forcing planning decisions", async () => {
  const adapter = createSampleWorkspaceAdapter();
  const preview = vi.spyOn(adapter, "previewProjectSetup").mockRejectedValue(new Error("Preview unavailable"));
  render(<GuidedSetup adapter={adapter} items={inventory} onDone={async () => undefined} onBusy={() => undefined} initialDraft={{ name: "Desk sensor", description: "" }} />);
  expect(screen.getByLabelText("Guided project name")).toHaveProperty("value", "Desk sensor");
  expect(screen.getByRole("button", { name: "Project details, optional" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Add draft requirement" }));
  fireEvent.change(screen.getByLabelText("Requirement 1 name"), { target: { value: "Sensor board" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview complete project" }));
  await waitFor(() => expect(preview).toHaveBeenCalledOnce());
  expect(preview.mock.calls[0]![0]).toMatchObject({ project: { name: "Desk sensor", description: "" }, revision: { fabricationRoute: "undecided" }, bomLines: [{ name: "Sensor board", requiredQuantity: 1 }], reservations: [] });
});

it("protects imported requirements and keeps editing without losing the source", () => {
  function Harness() {
    const guard = useNavigationGuard();
    return <UnsavedWorkContext.Provider value={guard.registry}><GuidedSetup adapter={createSampleWorkspaceAdapter()} items={inventory} onDone={async () => undefined} onBusy={() => undefined} initialMode="import" /><button onClick={() => guard.registry.request(() => undefined)}>Leave setup</button>{guard.pending && <div role="alertdialog"><button onClick={guard.cancel}>Keep editing</button></div>}</UnsavedWorkContext.Provider>;
  }
  render(<Harness />);
  expect(screen.getByRole("button", { name: "Import requirements CSV" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.change(screen.getByLabelText("BOM CSV text"), { target: { value: "name,quantity\nSensor,1" } });
  fireEvent.click(screen.getByRole("button", { name: "Leave setup" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("BOM CSV text")).toHaveProperty("value", "name,quantity\nSensor,1");
});


it("focuses the first template requirement and searches only the expanded row", async () => {
  const adapter = createSampleWorkspaceAdapter();
  const list = vi.spyOn(adapter, "listInventory").mockResolvedValue({ items: [], total: 0, limit: 25 });
  render(<GuidedSetup adapter={adapter} items={[]} onDone={async () => undefined} onBusy={() => undefined} initialMode="template" />);
  fireEvent.click(screen.getByRole("button", { name: "Printed part" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Requirement 1 name"));
  const templateSummary = screen.getByRole("button", { name: "Printed part template added" });
  expect(templateSummary.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Printed part" })).toBeNull();
  fireEvent.click(templateSummary);
  expect(screen.getByRole("button", { name: "Printed part" })).toHaveProperty("disabled", true);
  expect(screen.getByText("Templates are disabled while a draft contains requirements, so they cannot overwrite it.").closest("[hidden]")).toBeNull();
  fireEvent.click(templateSummary);
  expect(screen.queryByRole("region", { name: "Review owned items" })).toBeNull();
  expect(list).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Details for requirement 1/u }));
  expect(screen.getAllByRole("region", { name: "Review owned items" })).toHaveLength(1);
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Add draft requirement" }));
  fireEvent.change(screen.getByLabelText("Requirement 2 name"), { target: { value: "Screws" } });
  fireEvent.click(screen.getByRole("button", { name: /Details for requirement 2/u }));
  expect(screen.getAllByRole("region", { name: "Review owned items" })).toHaveLength(1);
  expect(list.mock.calls[0]![1]?.signal?.aborted).toBe(true);
});

it("preserves a searched stock selection and changes its unit only by explicit choice", async () => {
  const adapter = createSampleWorkspaceAdapter();
  const stock = { ...inventory.find((item) => item.category === "Filament")!, id: "remote-filament", name: "Remote blue filament", unit: "g" as const };
  const search = vi.spyOn(adapter, "listInventory").mockResolvedValue({ items: [stock], total: 1, limit: 25 });
  const preview = vi.spyOn(adapter, "previewProjectSetup").mockRejectedValue(new Error("Preview unavailable"));
  render(<GuidedSetup adapter={adapter} items={[]} onDone={async () => undefined} onBusy={() => undefined} initialDraft={{ name: "Sensor housing", description: "" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Add draft requirement" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Requirement 1 name"));
  fireEvent.change(screen.getByLabelText("Requirement 1 name"), { target: { value: "Filament" } });
  fireEvent.change(screen.getByLabelText("Requirement 1 quantity"), { target: { value: "200" } });
  fireEvent.click(screen.getByRole("button", { name: /Details for requirement 1/u }));
  fireEvent.click(await screen.findByRole("button", { name: /Choose owned item Remote blue filament/u }));
  expect(search).toHaveBeenCalledWith({ q: "Filament", limit: 25 }, { signal: expect.any(AbortSignal) });
  expect(screen.getByLabelText("Requirement 1 unit")).toHaveProperty("value", "each");
  expect(screen.getByText(/No conversion is inferred/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use grams for this requirement" }));
  expect(screen.getByLabelText("Requirement 1 unit")).toHaveProperty("value", "gram");
  expect(screen.getByLabelText("Requirement 1 quantity")).toHaveProperty("value", "200");
  fireEvent.click(screen.getByRole("button", { name: /Details for requirement 1/u }));
  expect(screen.queryByRole("region", { name: "Review owned items" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Details for requirement 1/u }));
  expect(screen.getByRole("button", { name: /Choose owned item Remote blue filament/u }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Preview complete project" }));
  await waitFor(() => expect(preview).toHaveBeenCalledOnce());
  expect(preview.mock.calls[0]![0]).toMatchObject({ bomLines: [{ name: "Filament", itemId: "remote-filament", unit: "gram", requiredQuantity: 200 }] });
});
