import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BuildSetupSummary,
  CatalogCombobox,
  CatalogInventoryFlow,
  CatalogProductCreateForm,
  OwnedItemCombobox,
  reduceComboboxKey
} from "./catalog-ui";
import { catalogProducts, inventory } from "./mock-data";
import type { BuildConfigInput, CatalogProduct, InventoryItem } from "./domain";

const printer = catalogProducts.find((product) => product.kind === "printer")!;
const filament = catalogProducts.find((product) => product.kind === "filament")!;
const printerItem = inventory.find((item) => item.category === "Printers")!;
const filamentItem = inventory.find((item) => item.category === "Filament")!;

describe("exact-product UI edge rendering", () => {
  it("keeps the combobox reducer stable at empty, lower, upper, and unknown keys", () => {
    expect(reduceComboboxKey({ activeIndex: 0, open: false }, "ArrowUp", 2)).toEqual({ activeIndex: 0, open: true });
    expect(reduceComboboxKey({ activeIndex: 1, open: true }, "ArrowDown", 0)).toEqual({ activeIndex: 1, open: true });
    expect(reduceComboboxKey({ activeIndex: -1, open: false }, "ArrowDown", 2)).toEqual({ activeIndex: 0, open: true });
    expect(reduceComboboxKey({ activeIndex: 0, open: false }, "Enter", 2)).toEqual({ activeIndex: 0, open: true });
    expect(reduceComboboxKey({ activeIndex: 0, open: false }, "not-a-key" as never, 2)).toEqual({ activeIndex: 0, open: false });
  });

  it("renders printer, loading, disabled, hint, and empty catalog states", () => {
    const printerMarkup = renderToStaticMarkup(
      <CatalogCombobox
        kind="printer"
        products={[printer]}
        query="H2D"
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        label="Exact printer model"
        loading
        disabled
        hint="Use the exact model and variant."
      />
    );
    expect(printerMarkup).toContain('role="combobox"');
    expect(printerMarkup).toContain('disabled=""');
    expect(printerMarkup).toContain('aria-label="Searching"');
    expect(printerMarkup).toContain("Use the exact model and variant.");

    const sparsePrinter: CatalogProduct = { id: "sparse-printer", kind: "printer", manufacturer: "Maker" };
    const selectedMarkup = renderToStaticMarkup(
      <CatalogCombobox
        kind="printer"
        products={[]}
        query=""
        selected={sparsePrinter}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        label="Exact printer model"
      />
    );
    expect(selectedMarkup).toContain("Selected exact product");
    expect(selectedMarkup).toContain("Details to confirm");
  });

  it("renders both exact-product creation forms and owned item states", () => {
    const printerForm = renderToStaticMarkup(<CatalogProductCreateForm kind="printer" onCreate={async () => undefined} onCancel={() => undefined} />);
    expect(printerForm).toContain("Exact model");
    expect(printerForm).toContain("Build volume (mm)");
    expect(printerForm).toContain("Back to results");

    const selected = { ...filamentItem, catalogProduct: filament, productProfile: { inventoryItemId: filamentItem.id, catalogProductId: filament.id, linkState: "reported" as const } };
    const owned = renderToStaticMarkup(<OwnedItemCombobox category="Filament" items={[printerItem, selected]} value={selected} onSelect={() => undefined} label="Owned filament" />);
    expect(owned).toContain("Owned item");
    expect(owned).toContain("Choose an owned filament");

    const noMatch = renderToStaticMarkup(<OwnedItemCombobox category="Printers" items={[filamentItem]} onSelect={() => undefined} label="Owned printer" />);
    expect(noMatch).toContain("Choose an owned printer");
  });

  it("keeps beginner summary plain when no setup facts exist", () => {
    const input: BuildConfigInput = { accessories: [], unknowns: [] };
    const markup = renderToStaticMarkup(<BuildSetupSummary input={input} expert={false} />);
    expect(markup).toContain("Use No printer selected with No filament selected.");
    expect(markup).not.toContain("Show IDs, versions");
  });

  it("renders the printer no-results flow without fabricating a product", () => {
    const calls: string[] = [];
    const markup = renderToStaticMarkup(
      <CatalogInventoryFlow
        category="Printers"
        products={[]}
        query="unknown printer"
        onQueryChange={(value) => calls.push(value)}
        onSearch={async () => []}
        onCreateProduct={async () => undefined}
        onCreate={async () => false}
        onBack={() => calls.push("back")}
      />
    );
    expect(markup).toContain("No exact product found");
    expect(markup).toContain("Add product");
    expect(markup).toContain("Exact printer model");
    expect(calls).toEqual([]);
  });
});
