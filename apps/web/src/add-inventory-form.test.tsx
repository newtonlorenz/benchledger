// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NewInventoryDialog } from "./App";
import { DEFAULT_MANAGED_INVENTORY_CATEGORIES } from "./category-ui";

afterEach(cleanup);
const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 10)); });

function renderAdd(overrides: { expert?: boolean; onCreate?: ReturnType<typeof vi.fn> } = {}) {
  const onCreate = overrides.onCreate ?? vi.fn(async () => true);
  const page = vi.fn(async () => ({ products: [], limit: 100, total: 0 }));
  render(<NewInventoryDialog expert={overrides.expert ?? false} categories={DEFAULT_MANAGED_INVENTORY_CATEGORIES} categoriesLoading={false} catalogQuery="" catalogProducts={[]} onCatalogQuery={() => undefined} onResetCatalog={() => undefined} onSearchCatalog={async () => []} onSearchCatalogPage={page} onCreateCatalogProduct={async () => undefined} onCreateExact={async () => true} onLinkExact={async () => true} onClose={() => undefined} onGoSettings={() => undefined} onCreate={onCreate} />);
  return { dialog: screen.getByRole("dialog", { name: "Add to inventory" }), onCreate };
}

describe("one-form inventory add", () => {
  it("starts with type chips and no separate Continue step", () => {
    const { dialog } = renderAdd();
    const types = within(dialog).getByRole("radiogroup", { name: "What are you adding?" });
    expect(within(types).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toContain("tool");
    expect(within(dialog).queryByRole("button", { name: "Continue" })).toBeNull();
    expect(within(dialog).queryByRole("combobox")).toBeNull();
  });

  it("adds a tool from one form with location, category and the counted-now choice", async () => {
    const { dialog, onCreate } = renderAdd();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Tool" }));
    await settle();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Flush cutters" } });
    fireEvent.change(within(dialog).getByLabelText(/Location/u), { target: { value: "Bench drawer" } });
    expect(within(dialog).getByText(/Files under/u).textContent).toContain("Tools");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I've counted this now/u }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add item" }));
    await settle();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Flush cutters", kind: "tool", categoryNodeId: "category-tools", location: "Bench drawer" }), true);
  });

  it("keeps the name when switching type and lets experts pick the category directly", async () => {
    const { dialog } = renderAdd({ expert: true });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Tool" }));
    await settle();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Kept name" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Fastener" }));
    await settle();
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Kept name");
    expect((within(dialog).getByRole("combobox", { name: /Category/u }) as HTMLSelectElement).value).toBe("category-fasteners");
  });

  it("shows Add details myself with the catalog search before any search fails", async () => {
    const { dialog } = renderAdd();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Filament" }));
    await settle();
    expect(within(dialog).getByRole("combobox", { name: "Exact filament product" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add details myself" }));
    await settle();
    expect(within(dialog).getByLabelText("Brand or manufacturer")).toBeTruthy();
    expect(dialog.textContent).toContain("exact product is not confirmed");
    expect(within(dialog).getByRole("button", { name: "Search the catalog instead" })).toBeTruthy();
  });
});
