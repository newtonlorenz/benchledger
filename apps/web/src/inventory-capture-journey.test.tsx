// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddBomDialog, NewInventoryDialog, InventoryTable, SettingsPage, type NewInventoryDraft } from "./App";
import { DEFAULT_MANAGED_INVENTORY_CATEGORIES as categories } from "./category-ui";
import { inventory, catalogProducts, projects } from "./mock-data";
import { UnsavedWorkContext } from "./unsaved-work";
import { ApiError } from "./api";

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await new Promise(resolve => setTimeout(resolve, 0)); });
const props = () => ({ expert: false, categories, categoriesLoading: false, catalogQuery: "", catalogProducts: [], onCatalogQuery: vi.fn(), onResetCatalog: vi.fn(), onSearchCatalog: vi.fn().mockResolvedValue([]), onSearchCatalogPage: vi.fn().mockResolvedValue({ products: [], nextCursor: undefined }), onCreateCatalogProduct: vi.fn().mockResolvedValue(undefined), onCreateExact: vi.fn().mockResolvedValue(false), onLinkExact: vi.fn().mockResolvedValue(false), onClose: vi.fn(), onGoSettings: vi.fn(), onCreate: vi.fn().mockResolvedValue(false) });
function choose(kind: string) { fireEvent.change(screen.getByRole("combobox", { name: "What are you adding?" }), { target: { value: kind } }); fireEvent.click(screen.getByRole("button", { name: /Continue/ })); }

it("captures location and quantity, retaining the draft after a failed save and guarded dismissal", async () => {
  const actions = props(); render(<NewInventoryDialog {...actions} />); choose("electronic");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Loose connectors" } });
  fireEvent.change(screen.getByLabelText("Location (optional)"), { target: { value: "Drawer B" } });
  fireEvent.change(screen.getByLabelText("Recorded quantity"), { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "Add item" }));
  await screen.findByText(/The item was not added/);
  expect(actions.onCreate).toHaveBeenCalledWith({ name: "Loose connectors", quantity: 12, unit: "each", location: "Drawer B", kind: "electronic", category: "Electronics", categoryNodeId: "category-electronics" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("alertdialog", { name: "Discard this item draft?" })).toBeTruthy();
  expect(actions.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Loose connectors");
  fireEvent.keyDown(document, { key: "Escape" });
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(actions.onClose).toHaveBeenCalledOnce();
});

it("allows an active category when the usual category is archived", () => {
  const active = categories.find(category => category.id === "category-tools")!;
  render(<NewInventoryDialog {...props()} categories={[active, { ...categories.find(category => category.id === "category-electronics")!, archived: true }]} />);
  fireEvent.change(screen.getByRole("combobox", { name: "What are you adding?" }), { target: { value: "electronic" } });
  const category = screen.getByRole("combobox", { name: /Category/ });
  expect((category as HTMLSelectElement).disabled).toBe(false);
  fireEvent.change(category, { target: { value: active.id } });
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(screen.getByLabelText("Name")).toBeTruthy();
});

it("starts with product search, discloses facets and permits unknown manual identity", async () => {
  const actions = props(); render(<NewInventoryDialog {...actions} />); choose("filament");
  expect(screen.getByRole("combobox", { name: "Exact filament product" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Manufacturer / brand" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Find by product details" }));
  expect(screen.getByRole("combobox", { name: "Manufacturer / brand" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add details myself" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unlabelled blue spool" } });
  fireEvent.change(screen.getByLabelText("Recorded quantity"), { target: { value: "450" } });
  fireEvent.click(screen.getByRole("button", { name: "Add item" }));
  await waitFor(() => expect(actions.onCreate).toHaveBeenCalledOnce());
  expect(actions.onCreate.mock.calls[0]?.[0]).toMatchObject({ name: "Unlabelled blue spool", quantity: 450, unit: "g", kind: "filament" });
  expect(actions.onCreate.mock.calls[0]?.[0]).not.toHaveProperty("manufacturer");
  expect(actions.onCreateExact).not.toHaveBeenCalled();
});

it("opens mobile item details directly while desktop taps retain inspection", () => {
  const item = inventory[0]!; const onSelectItem = vi.fn(), onInspectItem = vi.fn();
  const match = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  render(<InventoryTable items={[item]} categories={[]} selectedIds={new Set()} selectAllRef={{ current: null }} allLoadedSelected={false} hasUnversionedLoaded={false} onToggleAll={vi.fn()} onToggleSelected={vi.fn()} onSelectItem={onSelectItem} onInspectItem={onInspectItem} />);
  fireEvent.click(screen.getByRole("button", { name: new RegExp("^" + item.name) }));
  expect(onSelectItem).toHaveBeenCalledWith(item.id); expect(onInspectItem).not.toHaveBeenCalled();
  match.mockReturnValue({ matches: false } as MediaQueryList);
  fireEvent.click(screen.getByRole("button", { name: new RegExp("^" + item.name) }));
  expect(onInspectItem).toHaveBeenCalledWith(item.id);
});

it("keeps sign out directly reachable without opening connection details", () => {
  const onLogout = vi.fn();
  render(<SettingsPage expert={false} sampleMode={false} connection="ready" categories={[]} categoriesLoading={false} onRetryCategories={vi.fn()} onCreateCategory={vi.fn()} onUpdateCategory={vi.fn()} onArchiveCategory={vi.fn()} hideLogout={false} onExpert={vi.fn()} onLogout={onLogout} />);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" })); expect(onLogout).toHaveBeenCalledOnce();
});

it("guards a selected catalogue draft and blocks dismissal during its save", async () => {
  const actions = props(); let finish!: (value: boolean) => void;
  actions.onCreateExact.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
  render(<NewInventoryDialog {...actions} catalogProducts={catalogProducts.filter(product => product.kind === "printer")} />); choose("printer");
  await waitFor(() => expect(screen.queryByRole("status", { name: "Searching" })).toBeNull());
  fireEvent.change(screen.getByRole("combobox", { name: "Exact printer model" }), { target: { value: "Bambu" } });
  const option = await screen.findByRole("option", { name: /Bambu Lab/ });
  fireEvent.click(option);
  await screen.findByText("Exact product selected");
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  fireEvent.click(screen.getByRole("button", { name: "Add printer" }));
  await waitFor(() => expect(actions.onCreateExact).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  expect(actions.onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await act(async () => { finish(false); }); await screen.findByText(/was not saved/);
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

it("closes untouched nested inventory capture without discarding its parent project draft", () => {
  const actions = props(); const registry = { set: vi.fn(), request: vi.fn(), hasDraft: () => true };
  render(<UnsavedWorkContext.Provider value={registry}><NewInventoryDialog {...actions} /></UnsavedWorkContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(actions.onClose).toHaveBeenCalledOnce();
  expect(registry.request).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("receives the requirement context without guessing a package quantity or unit conversion", async () => {
  const actions = props();
  render(<NewInventoryDialog {...actions} receiving={{ projectId: "synthetic-project", revisionId: "synthetic-revision", projectName: "Synthetic lamp", lineId: "synthetic-wire", lineName: "Silicone wire", unit: "m" }} />);
  choose("wire");
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Silicone wire");
  expect(screen.getByLabelText("Quantity received")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Unit")).toHaveProperty("value", "m");
  fireEvent.change(screen.getByLabelText("Quantity received"), { target: { value: "2.5" } });
  fireEvent.click(screen.getByRole("button", { name: "Add item" }));
  await waitFor(() => expect(actions.onCreate).toHaveBeenCalledOnce());
  expect(actions.onCreate.mock.calls[0]?.[0]).toMatchObject({ name: "Silicone wire", quantity: 2.5, unit: "m", kind: "wire" });
  expect(actions.onCreate.mock.calls[0]?.[0]).not.toHaveProperty("evidence");
});

it("requires an explicit received quantity for an exact printer", async () => {
  const actions = props();
  render(<NewInventoryDialog {...actions} catalogProducts={catalogProducts.filter(product => product.kind === "printer")} receiving={{ projectId: "synthetic-project", revisionId: "synthetic-revision", projectName: "Synthetic workshop", lineId: "synthetic-printer", lineName: "Workshop printer", unit: "each" }} />);
  choose("printer");
  await waitFor(() => expect(screen.queryByRole("status", { name: "Searching" })).toBeNull());
  fireEvent.change(screen.getByRole("combobox", { name: "Exact printer model" }), { target: { value: "Bambu" } });
  fireEvent.click(await screen.findByRole("option", { name: /Bambu Lab/ }));
  expect(await screen.findByLabelText("Owned units")).toHaveProperty("value", "");
  expect(actions.onCreateExact).not.toHaveBeenCalled();
});


it("captures electronic specifications and asks separately to review an entered physical count", async () => {
  const actions = props(); render(<NewInventoryDialog {...actions} />); choose("electronic");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic sensor board" } });
  fireEvent.change(screen.getByLabelText("Details and specifications (optional)"), { target: { value: "3.3 V, I2C, 2.54 mm header" } });
  fireEvent.change(screen.getByLabelText("Recorded quantity"), { target: { value: "6" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "I have counted these" }));
  expect(actions.onCreate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add item and review count" }));
  await waitFor(() => expect(actions.onCreate).toHaveBeenCalledWith(expect.objectContaining({ description: "3.3 V, I2C, 2.54 mm header", quantity: 6 }), { reviewCount: true }));
  expect(actions.onCreate.mock.calls[0]?.[0]).not.toHaveProperty("evidence");
});

it("retains and freezes an ambiguous item save for the same explicit retry after remount", async () => {
  const actions = props(); let retained: NewInventoryDraft | undefined;
  const remember = (draft: NewInventoryDraft) => { retained = draft; };
  actions.onCreate.mockRejectedValueOnce(new ApiError("Lost acknowledgement", { kind: "offline" }));
  const view = render(<NewInventoryDialog {...actions} onDraftChange={remember} requirementName="Synthetic connector" />); choose("electronic");
  fireEvent.change(screen.getByLabelText("Recorded quantity"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "I have counted these" }));
  fireEvent.click(screen.getByRole("button", { name: "Add item and review count" }));
  await screen.findByRole("button", { name: "Retry unchanged item" });
  expect(screen.getByLabelText("Name").matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  expect(actions.onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(retained?.uncertain).toBe(true));
  view.unmount();
  render(<NewInventoryDialog {...actions} initialDraft={retained} onDraftChange={remember} requirementName="Synthetic connector" />);
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Synthetic connector");
  expect(screen.getByLabelText("Recorded quantity")).toHaveProperty("value", "4");
  expect(actions.onCreate).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry unchanged item" }));
  await waitFor(() => expect(actions.onCreate).toHaveBeenCalledTimes(2));
  expect(actions.onCreate.mock.calls[1]).toEqual(actions.onCreate.mock.calls[0]);
});


it("restores supporting inventory capture without a suspended requirement's modal hiding it", async () => {
  const actions = props();
  const draft: NewInventoryDraft = { itemType: "electronic", categoryNodeId: "category-electronics", selectionConfirmed: true, manualDetails: false, name: "Synthetic resumed connector", manufacturer: "", model: "", sku: "", location: "", description: "2 pins", quantity: "5", unit: "each", counted: true, uncertain: true };
  render(<>
    <AddBomDialog items={[]} project={projects[0]!} expert={false} suspended onClose={vi.fn()} onCreate={async () => true} />
    <NewInventoryDialog {...actions} requirementName="Synthetic resumed connector" initialDraft={draft} />
  </>);
  const capture = await screen.findByRole("dialog", { name: "Add an inventory item" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(capture.getAttribute("aria-hidden")).not.toBe("true");
  expect(screen.getByLabelText("Recorded quantity")).toHaveProperty("value", "5");
  expect(actions.onCreate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry unchanged item" }));
  await waitFor(() => expect(actions.onCreate).toHaveBeenCalledOnce());
});
