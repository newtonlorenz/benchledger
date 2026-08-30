import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BuildSetupSummary,
  CatalogCombobox,
  CatalogInventoryFlow,
  CatalogProductCreateForm,
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
