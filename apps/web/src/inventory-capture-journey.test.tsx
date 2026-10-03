// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewInventoryDialog, InventoryTable, SettingsPage } from "./App";
import { DEFAULT_MANAGED_INVENTORY_CATEGORIES as categories } from "./category-ui";
import { inventory, catalogProducts } from "./mock-data";
import { UnsavedWorkContext } from "./unsaved-work";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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
