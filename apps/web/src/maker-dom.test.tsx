// @vitest-environment jsdom
import { afterEach, it, expect, vi } from "vitest";
import { render, fireEvent, screen, waitFor, cleanup } from "@testing-library/react";
import { BuildEditor } from "./build-plan-ui";
import { QuoteForm } from "./requirement-sourcing";
import { ExistingBomImport } from "./bom-import-ui";
import { GuidedSetup } from "./guided-setup";
import { WorkstreamPlanning } from "./workstream-ui";
import { createSampleWorkspaceAdapter, workflowRequest, ApiError } from "./api";
import { projects, inventory } from "./mock-data";
import type { BomLine } from "@benchledger/api-contract";
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), workflowRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(workflowRequest).mockReset(); });
const project = { ...structuredClone(projects[0]!), fabricationRoute: "printed" as const };
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

it("edits a repeated plate draft, reviews it and confirms its saved identity", async () => {
  const saved = vi.fn(); vi.mocked(workflowRequest).mockImplementation(async (_path, _method, body) => ({ data: { ...(body as object), id: "plan", version: 1, projectRevisionId: project.serverRevisionId, contentSha256: "a".repeat(64), totals: {} } }));
  render(<BuildEditor project={project} items={inventory} initial={null} root="/project" onCancel={() => undefined} onSaved={saved} />);
  change("Build plan name", "Reviewed plate batch"); click("Add build part"); change("Build part 1 name", "Spacer"); change("Build part 1 quantity", "5");
  click("Add plate layout"); change("Plate 1 name", "Spacer layout"); change("Plate 1 runs", "2"); change("Plate 1 quantity Spacer", "3");
  click("Add material estimate"); change("Plate 1 material 1", inventory.find((item) => item.category === "Filament")!.id); change("Grams per run", "12"); change("Plate 1 material role 1", "support"); change("Plate 1 material side 1", "left"); change("Minutes per run, optional", "40"); change("Build planning notes", "Check the slicer before printing.");
  click("Review build plan"); expect(screen.getByText(/2 runs, with 3 × Spacer/u)).toBeTruthy(); click("Back to build draft"); click("Review build plan"); click("Save planning snapshot");
  await waitFor(() => expect(saved).toHaveBeenCalledOnce()); const body = vi.mocked(workflowRequest).mock.calls[0]![2] as { plates: { copies: number }[] }; expect(body.plates[0]!.copies).toBe(2);
});
it("retains the exact planning command after a lost acknowledgement", async () => {
  const initial = { id: "p", projectId: project.id, projectRevisionId: project.serverRevisionId!, version: 1, name: "Bracket", parts: [{ id: "part", name: "Bracket", quantity: 1 }], plates: [], contentSha256: "a".repeat(64), createdAt: "2026-09-06T00:00:00.000Z", createdBy: "synthetic", warnings: [], artifactBasis: [], totals: { parts: [], materialGrams: [], minutes: 0, timeComplete: true } };
  vi.mocked(workflowRequest).mockRejectedValueOnce(new ApiError("Connection lost", { kind: "offline" })).mockResolvedValueOnce({ data: { ...initial, version: 2 } }); const saved = vi.fn();
  render(<BuildEditor project={project} items={inventory} initial={initial} root="/project" onCancel={() => undefined} onSaved={saved} />); click("Review build plan"); click("Save planning snapshot");
  await screen.findByRole("button", { name: "Retry unchanged plan" }); click("Retry unchanged plan"); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(vi.mocked(workflowRequest).mock.calls[0]![3]).toBe(vi.mocked(workflowRequest).mock.calls[1]![3]);
});
it("maps a CSV append and confirms it without discarding existing requirements", async () => {
  const onRefresh = vi.fn(async () => true);
  vi.mocked(workflowRequest).mockResolvedValueOnce({ id: "preview", projectRevisionId: project.serverRevisionId, version: 1, contentSha256: "a".repeat(64), rows: [{ id: "line", name: "Spacer", requiredQuantity: 4, unit: "each", role: "consumed" }], warnings: [] }).mockResolvedValueOnce({ data: { previewId: "preview", lines: [{ id: "line" }] } });
  render(<ExistingBomImport project={project} onRefresh={onRefresh} />); change("Requirements CSV text", "name,quantity,unit\nSpacer,4,each"); change("Import delimiter", ","); click("Map import columns");
  change("Import Name column", "0"); change("Import Quantity column", "1"); change("Import Unit column", "2"); change("Import default unit", "each"); change("Import default use", "consumed"); change("Import decimal convention", "dot");
  click("Preview requirement append"); await screen.findByRole("heading", { name: "Review 1 new requirements" }); click("Confirm append requirements"); await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce()); expect(await screen.findByText("1 requirements imported")).toBeTruthy();
});
it("records explicit supplier amounts, tax and observation metadata", async () => {
  const line: BomLine = { id: "line", revisionId: "revision", name: "Screw", requiredQuantity: 4, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [], version: 1, createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" };
  vi.mocked(workflowRequest).mockImplementation(async (_path, _method, input) => { const { expectedBomLineVersion, ...fields } = input as Record<string, unknown>; return { data: { ...fields, id: "quote", projectId: project.id, projectRevisionId: "revision", bomLineVersion: expectedBomLineVersion, createdAt: "2026-09-06T00:00:00.000Z", recordedBy: "synthetic", version: 1 } }; }); const saved = vi.fn();
  render(<QuoteForm line={line} root="/project" onSaved={saved} onCancel={() => undefined} />); change("Supplier", "Synthetic supplier"); change("Quoted item", "Pack of screws"); change("Supplier source URL", "https://supplier.example/item"); change("Quantity per pack", "4"); change("Quoted pack unit", "each"); change("Pack price", "2.50"); change("Quoted currency", "GBP"); change("Shipping for this quote, blank if unknown", "2.00"); change("Quoted tax included", "yes"); change("Observation date", "2026-09-06"); change("Quote notes", "Observed manually"); click("Save supplier observation"); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(vi.mocked(workflowRequest).mock.calls[0]![2]).toMatchObject({ priceMinor: 250, shippingMinor: 200, currency: "GBP", packageQuantity: 4 });
});
it("keeps guided drafts editable and validates the mapped proposal before preview", async () => {
  const adapter = createSampleWorkspaceAdapter(); const preview = vi.spyOn(adapter, "previewProjectSetup").mockRejectedValue(new Error("Synthetic preview unavailable"));
  render(<GuidedSetup adapter={adapter} items={inventory} onDone={async () => undefined} onBusy={() => undefined} />);
  change("Guided project name", "Sensor"); change("Guided project goal", "Useful sensor"); change("Guided build approach", "none"); change("BOM CSV text", "name,quantity,unit\nBracket,2,each"); click("Review CSV mapping"); change("CSV Quantity column", "1"); change("CSV default unit", "each"); change("CSV default use", "consumed"); change("CSV decimal convention", "dot"); click("Use mapped requirements in draft");
  change("Requirement 1 name", "Revised bracket"); change("Requirement 1 quantity", "3"); change("Requirement 1 unit", "each"); change("Requirement 1 use", "consumed"); change("Requirement 1 owned item", ""); change("Requirement 1 specification", "20 mm mounting"); change("Setup workstreams", "Design\nAssembly");
  click("Preview complete project"); await waitFor(() => expect(preview).toHaveBeenCalledOnce()); expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Synthetic preview unavailable");
  click("Add draft requirement"); change("Requirement 2 name", "Tool"); click("Remove draft row 2"); expect(screen.queryByLabelText("Requirement 2 name")).toBeNull();
});
it("updates workstream status, notes and due date through an observed version", async () => {
  const row = { item: { id: "work", name: "Assembly", kind: "assembly", currentRevisionId: "rev" }, revision: { number: 1, name: "Initial" }, assignment: { version: 1, status: "todo" } };
  vi.mocked(workflowRequest).mockImplementation(async (path, method) => method === "PUT" ? { data: { id: "work", workItemId: "work", version: 2, status: "in_progress", notes: "Fit check first", dueDate: "2027-01-02" } } : path === "/team/directory" ? { members: [] } : { data: [row], total: 1 });
  render(<WorkstreamPlanning project={project} />); await screen.findByText("Assembly · To do"); change("Status for Assembly", "in_progress"); change("Due date", "2027-01-02"); change("Workstream notes", "Fit check first"); click("Save workstream progress");
  await waitFor(() => expect(vi.mocked(workflowRequest).mock.calls.some((call) => call[1] === "PUT")).toBe(true)); expect(vi.mocked(workflowRequest).mock.calls.find((call) => call[1] === "PUT")![2]).toMatchObject({ expectedVersion: 1, status: "in_progress", notes: "Fit check first", dueDate: "2027-01-02" });
});
