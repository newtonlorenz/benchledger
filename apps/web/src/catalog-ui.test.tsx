import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BuildSetupSummary,
  CATALOG_FACET_MAX_PRODUCTS,
  CatalogFacetPicker,
  CatalogCombobox,
  CatalogInventoryFlow,
  CatalogProductCreateForm,
  catalogFacetValues,
  filterCatalogProductsByFacets,
  loadCompleteCatalogProducts,
  reduceComboboxKey
} from "./catalog-ui";
import { buildSetupSummary, exactProductLabel } from "./domain";
import { catalogProducts, inventory } from "./mock-data";
import type { BuildConfigInput, CatalogProduct, InventoryItem } from "./domain";

const printerProduct = catalogProducts.find((product) => product.kind === "printer")!;
const filamentProduct = catalogProducts.find((product) => product.kind === "filament")!;

function exactItem(item: InventoryItem, product: CatalogProduct): InventoryItem {
  return {
    ...item,
    catalogProduct: product,
    productProfile: { inventoryItemId: item.id, catalogProductId: product.id, linkState: "confirmed" }
  };
}

describe("catalog selection UI", () => {
  it("follows catalog cursors beyond the first facet page and reports the safety cap", async () => {
    const calls: Array<{ limit: number; cursor?: string }> = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ ...filamentProduct, id: `facet-${index}` }));
    const secondPage = Array.from({ length: 100 }, (_, index) => ({ ...filamentProduct, id: `facet-${100 + index}` }));
    const result = await loadCompleteCatalogProducts("filament", async (_kind, _query, options) => {
      calls.push(options);
      return options.cursor ? { products: secondPage, limit: options.limit, total: 200, nextCursor: "200" } : { products: firstPage, limit: options.limit, total: 200, nextCursor: "100" };
    }, { maxProducts: 150 });
    expect(result.products).toHaveLength(150);
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe("cap");
    expect(result.pageCount).toBe(2);
    expect(calls).toEqual([{ limit: 100 }, { limit: 100, cursor: "100" }]);
    expect(CATALOG_FACET_MAX_PRODUCTS).toBe(1000);
  });

  it("stops when a cursor page adds no new product ids, even when its cursor advances", async () => {
    const product = { ...filamentProduct, id: "repeated-facet-product" };
    const cursors: Array<string | undefined> = [];
    const result = await loadCompleteCatalogProducts("filament", async (_kind, _query, options) => {
      cursors.push(options.cursor);
      return options.cursor
        ? { products: [product], limit: options.limit, total: 3, nextCursor: "cursor-after-duplicate" }
        : { products: [product], limit: options.limit, total: 3, nextCursor: "cursor-duplicate" };
    });
    expect(result.products).toEqual([product]);
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe("no-progress");
    expect(result.pageCount).toBe(2);
    expect(cursors).toEqual([undefined, "cursor-duplicate"]);
  });

  it("finishes the facet cache when the API has no next cursor", async () => {
    const result = await loadCompleteCatalogProducts("filament", async (_kind, _query, options) => ({ products: [filamentProduct], limit: options.limit, total: 1 }));
    expect(result).toMatchObject({ products: [filamentProduct], partial: false, pageCount: 1 });
  });

  it("does not call an exactly full, cursorless catalog partial", async () => {
    const products = Array.from({ length: 4 }, (_, index) => ({ ...filamentProduct, id: `exact-cap-${index}` }));
    const result = await loadCompleteCatalogProducts("filament", async (_kind, _query, options) => ({ products, limit: options.limit, total: products.length }), { pageSize: 4, maxProducts: 4 });
    expect(result).toMatchObject({ products, partial: false, pageCount: 1 });
  });

  it("derives bounded, case-insensitive filament facets without stock claims", () => {
    const products: CatalogProduct[] = [
      { ...filamentProduct, id: "filament-pla-black", manufacturer: "Bambu Lab", materialFamily: "PLA", materialSubtype: "Basic", colourName: "Black", colourCode: "BK", diameterMm: 1.75, nominalNetMassG: 1000 },
      { ...filamentProduct, id: "filament-pla-white", manufacturer: "bambu lab", materialFamily: "PLA", materialSubtype: "Basic", colourName: "White", colourCode: "WH", diameterMm: 1.75, nominalNetMassG: 1000 },
      { ...filamentProduct, id: "filament-petg", manufacturer: "Bambu Lab", materialFamily: "PETG", materialSubtype: "HF", colourName: "Black", colourCode: "BK", diameterMm: 1.75, nominalNetMassG: 1000 }
    ];
    expect(catalogFacetValues(products, "filament", "manufacturer")).toEqual(["Bambu Lab"]);
    expect(catalogFacetValues(products, "filament", "family")).toEqual(["PETG", "PLA"]);
    expect(filterCatalogProductsByFacets(products, "filament", { manufacturer: "bambu lab", family: "PLA", colour: "black", diameterMm: "1.75", netMassG: "1000" })).toHaveLength(1);

    const markup = renderToStaticMarkup(<CatalogFacetPicker kind="filament" products={products} selected={products[0]} onSelect={() => undefined} onAddUnlisted={() => undefined} />);
    expect(markup).toContain("Manufacturer / brand");
    expect(markup).toContain("Product line / material family");
    expect(markup).toContain("Material subtype");
    expect(markup).toContain("Colour code");
    expect(markup).toContain("1.75 mm");
    expect(markup).toContain("1,000 g net");
    expect(markup).toContain("Exact product");
    expect(markup).toContain("Catalog entries describe products only");
    expect(markup).not.toContain("in stock");
    expect(markup).not.toContain("Available:");
    const partialMarkup = renderToStaticMarkup(<CatalogFacetPicker kind="filament" products={products} onSelect={() => undefined} partial partialCount={150} partialReason="cap" />);
    expect(partialMarkup).toContain("Showing the first 150 catalog entries (safety cap)");
    expect(partialMarkup).toContain("Narrow the search");
    const noProgressMarkup = renderToStaticMarkup(<CatalogFacetPicker kind="filament" products={products} onSelect={() => undefined} partial partialCount={3} partialReason="no-progress" />);
    expect(noProgressMarkup).toContain("Only 3 catalog entries loaded");
    expect(noProgressMarkup).toContain("paging stopped before another unique entry was found");
    expect(noProgressMarkup).not.toContain("first 1,000");
  });

  it("progresses printer facets to an exact model and variant", () => {
    const products: CatalogProduct[] = [
      { ...printerProduct, id: "printer-a", manufacturer: "Bambu Lab", exactModel: "H2D", exactVariant: "AMS Combo" },
      { ...printerProduct, id: "printer-b", manufacturer: "Bambu Lab", exactModel: "H2D", exactVariant: "Standard" },
      { ...printerProduct, id: "printer-c", manufacturer: "Creality", exactModel: "K1", exactVariant: "Max" }
    ];
    expect(catalogFacetValues(products, "printer", "model")).toEqual(["H2D", "K1"]);
    expect(filterCatalogProductsByFacets(products, "printer", { manufacturer: "Bambu Lab", model: "H2D", variant: "AMS Combo" })).toHaveLength(1);
    const markup = renderToStaticMarkup(<CatalogFacetPicker kind="printer" products={products} selected={products[0]} onSelect={() => undefined} />);
    expect(markup).toContain("Exact model");
    expect(markup).toContain("Variant");
    expect(markup).toContain("Bambu Lab · H2D · H2D · AMS Combo");
  });

  it("keeps keyboard navigation bounded and dismissible", () => {
    expect(reduceComboboxKey({ activeIndex: 0, open: true }, "ArrowDown", 2)).toEqual({ activeIndex: 1, open: true });
    expect(reduceComboboxKey({ activeIndex: 1, open: true }, "ArrowDown", 2)).toEqual({ activeIndex: 1, open: true });
    expect(reduceComboboxKey({ activeIndex: 1, open: true }, "ArrowUp", 2)).toEqual({ activeIndex: 0, open: true });
    expect(reduceComboboxKey({ activeIndex: 1, open: true }, "Home", 2)).toEqual({ activeIndex: 0, open: true });
    expect(reduceComboboxKey({ activeIndex: 0, open: true }, "End", 2)).toEqual({ activeIndex: 1, open: true });
    expect(reduceComboboxKey({ activeIndex: 0, open: true }, "Escape", 2)).toEqual({ activeIndex: 0, open: false });
    expect(reduceComboboxKey({ activeIndex: 0, open: false }, "ArrowDown", 0)).toEqual({ activeIndex: 0, open: true });
  });

  it("exposes a labeled combobox and complete filament product detail", () => {
    const markup = renderToStaticMarkup(
      <CatalogCombobox
        kind="filament"
        products={[filamentProduct]}
        query=""
        selected={filamentProduct}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        label="Exact filament product"
      />
    );
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain("Selected exact product");
    expect(markup).toContain("Bambu Lab · PETG HF · PETG HF · 1 kg spool");
    expect(markup).toContain("Black");
    expect(markup).toContain("#000000");
    expect(markup).toContain("1.75 mm");
    expect(markup).toContain("1,000 g net");
  });

  it("offers a compact add-product form when the catalog has no match", () => {
    const formMarkup = renderToStaticMarkup(
      <CatalogProductCreateForm kind="filament" onCreate={async () => undefined} />
    );
    expect(formMarkup).toContain("No exact match");
    expect(formMarkup).toContain("Add product");
    expect(formMarkup).toContain("Manufacturer");
    expect(formMarkup).toContain("Colour");
    expect(formMarkup).toContain("Colour code");
    expect(formMarkup).toContain("Diameter (mm)");
    expect(formMarkup).toContain("Net mass (g)");

    const flowMarkup = renderToStaticMarkup(
      <CatalogInventoryFlow
        category="Filament"
        products={[]}
        query="unlisted material"
        onQueryChange={() => undefined}
        onSearch={async () => []}
        onCreateProduct={async () => undefined}
        onCreate={async () => true}
        onBack={() => undefined}
      />
    );
    expect(flowMarkup).toContain("No exact product found");
    expect(flowMarkup).toContain("Add product");
  });
});

describe("exact-product language and setup summary", () => {
  it("keeps legacy filament and printer rows visibly unconfirmed", () => {
    const legacyPrinter = inventory.find((item) => item.category === "Printers")!;
    const confirmedPrinter = exactItem(legacyPrinter, printerProduct);
    expect(exactProductLabel(legacyPrinter)).toBe("Exact product not confirmed");
    expect(exactProductLabel(confirmedPrinter)).toBe("Exact product confirmed");
  });

  it("gives beginners a plain setup sentence and experts the trace fields", () => {
    const printer = exactItem(inventory.find((item) => item.category === "Printers")!, printerProduct);
    const filament = exactItem(inventory.find((item) => item.category === "Filament")!, filamentProduct);
    const input: BuildConfigInput = {
      printerItemId: printer.id,
      filamentItemId: filament.id,
      printerProductId: printerProduct.id,
      filamentProductId: filamentProduct.id,
      nozzleDiameterMm: 0.4,
      nozzleMaterial: "Hardened steel",
      buildPlate: "Textured PEI",
      accessories: ["AMS 2 Pro"],
      firmware: "01.08",
      slicer: "Bambu Studio",
      slicerVersion: "1.10",
      profile: "0.20 mm Standard",
      calibration: "Flow checked",
      unknowns: ["First-layer coupon remains"]
    };
    const summary = buildSetupSummary(input, printer, filament);
    expect(summary).toContain("Use Bambu Lab · H2D · H2D · AMS Combo with Bambu Lab · PETG HF");
    expect(summary).toContain("0.4 mm nozzle");
    expect(summary).toContain("1 setup detail remains to confirm");

    const markup = renderToStaticMarkup(<BuildSetupSummary input={input} printer={printer} filament={filament} expert />);
    expect(markup).toContain("Show IDs, versions, evidence &amp; unknowns");
    expect(markup).toContain(printer.id);
    expect(markup).toContain(printerProduct.id);
    expect(markup).toContain("First-layer coupon remains");
  });

  it("keeps canonical references visible when rendering a persisted snapshot", () => {
    const snapshot = {
      printerItemId: "printer-1",
      filamentItemId: "filament-1",
      accessories: ["AMS 2 Pro"],
      unknowns: ["Nozzle wear date"],
      projectRevisionId: "revision-7",
      printerItemSnapshot: { itemId: "printer-1", catalogProductId: "printer-product-1", profileId: "printer-profile-1", linkState: "confirmed" },
      filamentSelections: [{ itemId: "filament-1", catalogProductId: "filament-product-1", profileId: "filament-profile-1", linkState: "reported" }],
      slicerDescriptor: { name: "Bambu Studio", version: "1.10.0" },
      firmwareDescriptor: { version: "01.08" },
      explicitUnknowns: ["Nozzle wear date"],
      contentSha256: "a".repeat(64)
    };
    const markup = renderToStaticMarkup(<BuildSetupSummary input={snapshot} expert />);
    expect(markup).toContain("revision-7");
    expect(markup).toContain("printer-product-1");
    expect(markup).toContain("filament-product-1");
    expect(markup).toContain("slicer v1.10.0");
    expect(markup).toContain("a".repeat(64));
    expect(markup).toContain("Nozzle wear date");
  });
});
