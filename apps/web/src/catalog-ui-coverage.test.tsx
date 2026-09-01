import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BuildSetupSummary,
  CATALOG_FACET_MAX_PRODUCTS,
  CatalogFacetPicker,
  CatalogCombobox,
  CatalogInventoryFlow,
  CatalogProductCreateForm,
  OwnedItemCombobox,
  catalogFacetValues,
  filterCatalogProductsByFacets,
  loadCompleteCatalogProducts,
  reduceComboboxKey
} from "./catalog-ui";
import { catalogProducts, inventory } from "./mock-data";
import type { BuildConfigInput, CatalogProduct, InventoryItem } from "./domain";

const printer = catalogProducts.find((product) => product.kind === "printer")!;
const filament = catalogProducts.find((product) => product.kind === "filament")!;
const printerItem = inventory.find((item) => item.category === "Printers")!;
const filamentItem = inventory.find((item) => item.category === "Filament")!;

describe("exact-product UI edge rendering", () => {
  it("stops a repeated API cursor and marks facet data as partial", async () => {
    const product: CatalogProduct = { id: "cursor-product", kind: "filament", manufacturer: "Maker" };
    const result = await loadCompleteCatalogProducts("filament", async (_kind, _query, options) => ({ products: [product], limit: options.limit, nextCursor: "same-cursor" }), { maxProducts: CATALOG_FACET_MAX_PRODUCTS });
    expect(result.products).toEqual([product]);
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe("no-progress");
    expect(result.pageCount).toBe(2);
  });

  it("follows bounded facet cursors until every product is loaded", async () => {
    const first: CatalogProduct = { id: "page-one", kind: "filament", manufacturer: "Maker One" };
    const second: CatalogProduct = { id: "page-two", kind: "filament", manufacturer: "Maker Two" };
    const calls: Array<{ readonly limit: number; readonly cursor?: string }> = [];
    const result = await loadCompleteCatalogProducts("filament", async (_kind, _query, options) => {
      calls.push(options);
      return options.cursor === undefined
        ? { products: [first], limit: options.limit, total: 2, nextCursor: "page-two" }
        : { products: [second], limit: options.limit, total: 2 };
    }, { pageSize: 1, maxProducts: 2 });

    expect(calls).toEqual([{ limit: 1 }, { limit: 1, cursor: "page-two" }]);
    expect(result.products).toEqual([first, second]);
    expect(result.partial).toBe(false);
    expect(result.pageCount).toBe(2);
  });

  it("renders empty and no-match facet states with an unlisted fallback", () => {
    const unknown: CatalogProduct = { id: "unknown-filament", kind: "filament", manufacturer: "Acme", materialFamily: "PLA", colourName: "Blue", diameterMm: 1.75, nominalNetMassG: 750, lengthBasis: "unknown" };
    expect(catalogFacetValues([unknown], "filament", "subtype")).toEqual([]);
    expect(filterCatalogProductsByFacets([unknown], "filament", { manufacturer: "Other" })).toEqual([]);
    const calls: string[] = [];
    const markup = renderToStaticMarkup(<CatalogFacetPicker kind="filament" products={[unknown]} onSelect={() => undefined} onAddUnlisted={() => calls.push("add")} />);
    expect(markup).toContain("Choose by details");
    expect(markup).toContain("Any material subtype");
    expect(markup).toContain("Catalog entries describe products only");
    expect(markup).not.toContain("Exact product");
    expect(calls).toEqual([]);
  });

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
