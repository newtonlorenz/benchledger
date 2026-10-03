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
