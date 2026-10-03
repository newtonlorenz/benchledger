// @vitest-environment jsdom
import { afterEach, it, expect, vi } from "vitest";
import { render, fireEvent, screen, waitFor, cleanup } from "@testing-library/react";
import { MakerPlanningTools } from "./maker-planning-ui";
import { PlanSummary } from "./build-plan-ui";
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

it("explains an empty build plan and focuses the action needed to continue", () => {
  render(<BuildEditor project={project} items={inventory} initial={null} root="/project" onCancel={() => undefined} onSaved={() => undefined} />);
  click("Review build plan");
  expect(screen.getByRole("alert").textContent).toBe("Add at least one required part before reviewing this plan.");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add build part" }));
  expect(screen.queryByRole("button", { name: "Save planning snapshot" })).toBeNull();
  click("Add build part");
  expect(screen.queryByRole("alert")).toBeNull();
  click("Review build plan");
  expect(screen.getByRole("alert").textContent).toBe("Give part 1 a name so you can identify it on your plates.");
  expect(document.activeElement).toBe(screen.getByLabelText("Build part 1 name"));
  expect(screen.queryByRole("button", { name: "Save planning snapshot" })).toBeNull();
  change("Build part 1 name", "Spacer");
  click("Review build plan");
  expect(screen.getByRole("button", { name: "Save planning snapshot" })).toBeTruthy();
  expect(workflowRequest).not.toHaveBeenCalled();
});

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
  change("Guided project name", "Sensor"); change("Guided project goal", "Useful sensor"); change("Guided build approach", "none"); click("Import requirements CSV"); change("BOM CSV text", "name,quantity,unit\nBracket,2,each"); click("Review CSV mapping"); change("CSV Quantity column", "1"); change("CSV default unit", "each"); change("CSV default use", "consumed"); change("CSV decimal convention", "dot"); click("Use mapped requirements in draft");
  change("Requirement 1 name", "Revised bracket"); change("Requirement 1 quantity", "3"); change("Requirement 1 unit", "each"); change("Requirement 1 use", "consumed"); change("Requirement 1 owned item", ""); change("Requirement 1 specification", "20 mm mounting"); change("Setup workstreams", "Design\nAssembly");
  click("Preview complete project"); await waitFor(() => expect(preview).toHaveBeenCalledOnce()); expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Synthetic preview unavailable");
  click("Add draft requirement"); change("Requirement 2 name", "Tool"); click("Remove draft row 2"); expect(screen.queryByLabelText("Requirement 2 name")).toBeNull();
});
it("updates workstream status, notes and due date through an observed version", async () => {
  const row = { item: { id: "work", name: "Assembly", kind: "assembly", currentRevisionId: "rev" }, revision: { number: 1, name: "Initial" }, assignment: { version: 1, status: "todo" } };
  vi.mocked(workflowRequest).mockImplementation(async (path, method) => method === "PUT" ? { data: { id: "work", workItemId: "work", version: 2, status: "in_progress", notes: "Fit check first", dueDate: "2027-01-02" } } : path === "/team/directory" ? { members: [] } : { data: [row], total: 1 });
  render(<WorkstreamPlanning project={project} />); await screen.findByText("Assembly · To do"); click("Assembly · To do"); change("Status for Assembly", "in_progress"); change("Due date", "2027-01-02"); change("Workstream notes", "Fit check first"); click("Save workstream progress");
  await waitFor(() => expect(vi.mocked(workflowRequest).mock.calls.some((call) => call[1] === "PUT")).toBe(true)); expect(vi.mocked(workflowRequest).mock.calls.find((call) => call[1] === "PUT")![2]).toMatchObject({ expectedVersion: 1, status: "in_progress", notes: "Fit check first", dueDate: "2027-01-02" });
});


it("defaults new plates to the confirmed project printer and matching setup only", () => {
  const printer = inventory.find((item) => item.category === "Printers")!;
  const configured = { ...project, intendedPrinterItemId: printer.id, buildConfigSnapshot: { ...project.buildConfigSnapshot!, id: "setup-current", printerItemId: printer.id } };
  const view = render(<BuildEditor project={configured} items={inventory} initial={null} root="/project" onCancel={() => undefined} onSaved={() => undefined} />);
  click("Add build part"); change("Build part 1 name", "Lid"); click("Add plate layout");
  expect(screen.getByLabelText("Plate 1 printer")).toHaveProperty("value", printer.id);
  expect(screen.getByRole("checkbox", { name: "Link this revision's recorded printer setup" }).getAttribute("data-state")).toBe("checked");
  change("Plate 1 printer", ""); expect(screen.queryByRole("checkbox", { name: "Link this revision's recorded printer setup" })).toBeNull();
  view.unmount();
  render(<BuildEditor project={configured} items={inventory.map((item) => item.id === printer.id ? { ...item, serverEvidence: "delivered_uncounted" } : item)} initial={null} root="/project" onCancel={() => undefined} onSaved={() => undefined} />);
  click("Add build part"); change("Build part 1 name", "Lid"); click("Add plate layout");
  expect(screen.getByLabelText("Plate 1 printer")).toHaveProperty("value", "");
});

it("uploads a missing file without leaving or losing the current build draft", async () => {
  const onUpload = vi.fn(async () => undefined);
  const props = { project, items: inventory, initial: null, root: "/project", onCancel: () => undefined, onSaved: () => undefined, onUpload };
  const view = render(<BuildEditor {...props} />);
  click("Add build part"); change("Build part 1 name", "Enclosure lid"); change("Build part 1 quantity", "3");
  const file = new File(["synthetic"], "lid.stl");
  fireEvent.change(screen.getByLabelText("Add a missing build file"), { target: { files: [file] } });
  await screen.findByText("File uploaded. Select it under Exact revision file for the matching part.");
  expect(onUpload).toHaveBeenCalledWith(file, "STL", { kind: "project", projectRevisionId: project.serverRevisionId });
  const artifact = { id: "new-lid", name: "lid.stl", role: "STL" as const, revision: "r01", projectRevisionId: project.serverRevisionId!, status: "candidate" as const, hash: "a".repeat(64), size: "1 KB", updated: "2026-10-03" };
  view.rerender(<BuildEditor {...props} project={{ ...project, artifacts: [artifact], allArtifacts: [artifact] }} />);
  expect(screen.getByLabelText("Build part 1 name")).toHaveProperty("value", "Enclosure lid");
  expect(screen.getByLabelText("Build part 1 quantity")).toHaveProperty("value", "3");
  change("Build part 1 file", "new-lid"); expect(screen.getByLabelText("Build part 1 file")).toHaveProperty("value", "new-lid");
});

it("keeps build warnings visible and technical evidence collapsed", () => {
  const plan = { id: "p", projectId: project.id, projectRevisionId: project.serverRevisionId!, version: 1, name: "Bracket", parts: [], plates: [], contentSha256: "a".repeat(64), createdAt: "2026-10-03T00:00:00.000Z", createdBy: "synthetic", warnings: ["Filament: planned 100 g exceeds currently available 20 g."], artifactBasis: [], totals: { parts: [], materialGrams: [], minutes: 0, timeComplete: true } };
  render(<PlanSummary plan={plan} items={inventory} />);
  expect(screen.getByText(plan.warnings[0]! ).closest("[hidden]")).toBeNull();
  expect(screen.getByText(/Snapshot:/).closest("[hidden]")).not.toBeNull();
});
it("leads non-print projects to workstreams while print details remain optional", async () => {
  vi.mocked(workflowRequest).mockImplementation(async (path) => path === "/team/directory" ? { members: [] } : path.endsWith("/build-plan") ? null : { data: [], total: 0 });
  render(<MakerPlanningTools project={{ ...project, fabricationRoute: "none" }} items={inventory} onRefresh={async () => true} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Add workstream" })).toHaveProperty("disabled", false));
  expect(screen.queryByRole("button", { name: "Create build plan" })).toBeNull();
  click("Parts and print plates, optional"); expect(screen.getByRole("button", { name: "Create build plan" })).toBeTruthy();
});

it("retains the build draft while the project switches to a printed approach", async () => {
  vi.mocked(workflowRequest).mockImplementation(async (path) => path === "/team/directory" ? { members: [] } : path.endsWith("/build-plan") ? null : { data: [], total: 0 });
  const onApproach = vi.fn(), onRefresh = async () => true;
  const view = render(<MakerPlanningTools project={{ ...project, fabricationRoute: "undecided" }} items={inventory} onRefresh={onRefresh} onApproach={onApproach} />);
  click("Parts and print plates, optional");
  await waitFor(() => expect(screen.getByRole("button", { name: "Create build plan" })).toHaveProperty("disabled", false));
  click("Create build plan"); click("Add build part"); change("Build part 1 name", "Keep this lid"); change("Build part 1 quantity", "3"); click("Choose build approach"); expect(onApproach).toHaveBeenCalledOnce();
  view.rerender(<MakerPlanningTools project={{ ...project, fabricationRoute: "printed" }} items={inventory} onRefresh={onRefresh} onApproach={onApproach} />);
  expect(screen.getByLabelText("Build part 1 name")).toHaveProperty("value", "Keep this lid");
  expect(screen.getByLabelText("Build part 1 quantity")).toHaveProperty("value", "3");
  expect(screen.getByRole("button", { name: "Add plate layout" })).toHaveProperty("disabled", false);
});

it("freezes an ambiguous upload and retries the same file until confirmed", async () => {
  const onUpload = vi.fn().mockRejectedValueOnce(new ApiError("Lost response", { kind: "offline" })).mockRejectedValueOnce(new ApiError("Forbidden", { kind: "forbidden", status: 403 })).mockResolvedValueOnce(undefined);
  render(<BuildEditor project={project} items={inventory} initial={null} root="/project" onCancel={() => undefined} onSaved={() => undefined} onUpload={onUpload} />);
  click("Add build part"); change("Build part 1 name", "Retained lid");
  const file = new File(["synthetic"], "lid.stl");
  fireEvent.change(screen.getByLabelText("Add a missing build file"), { target: { files: [file] } });
  await screen.findByRole("button", { name: "Retry unchanged file upload" });
  expect(screen.getByLabelText("Add a missing build file").matches(":disabled")).toBe(true);
  click("Retry unchanged file upload"); await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
  await screen.findByRole("button", { name: "Retry unchanged file upload" });
  expect(screen.getByLabelText("Build part 1 name").matches(":disabled")).toBe(true);
  click("Retry unchanged file upload"); await screen.findByText("File uploaded. Select it under Exact revision file for the matching part.");
  expect(screen.getByLabelText("Build part 1 name")).toHaveProperty("value", "Retained lid");
  expect(onUpload.mock.calls.every(([uploaded]) => uploaded === file)).toBe(true);
  expect(screen.getByLabelText("Add a missing build file").matches(":disabled")).toBe(false);
});
