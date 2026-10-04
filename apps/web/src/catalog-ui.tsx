import "./inventory-capture.css";
import { Command, CommandList, CommandItem } from "./components/ui/command";
import { SearchCombobox } from "./components/search-combobox";
import { Alert } from "./components/ui/alert";
import { Label } from "./components/ui/label";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { createContext, useContext, useEffect, useId, useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import type {
  BuildConfigInput,
  BuildFilamentSelection,
  CatalogKind,
  CatalogProduct,
  InventoryItem,
  InventoryProductProfile,
  LinkState
} from "./domain";
import { buildSetupSummary, catalogProductLabel, exactProductLabel, isExactProductIdentityComplete, isUnknownFilamentSelection } from "./domain";
import type { InventoryPage, CatalogProductDraft, CatalogProductPage, CatalogSearchOptions, ExactInventoryInput } from "./api";
import { Icon } from "./icons";
import { inventoryCandidateLabel, inventoryCandidateText } from "./inventory-identity";

export type ComboboxKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "Enter" | "Escape";

export const CATALOG_FACET_PAGE_SIZE = 100;
export const CATALOG_FACET_MAX_PRODUCTS = 1000;
export type CatalogFacetPartialReason = "cap" | "no-progress";

export interface CatalogSelectionState {
  selected?: CatalogProduct | undefined;
  query: string;
  showCreate: boolean;
}

/** Selecting an exact catalog entry ends the stale search/custom-product path. */
export function nextCatalogSelectionState(current: CatalogSelectionState, product: CatalogProduct | undefined): CatalogSelectionState {
  if (!product) return { ...current, selected: undefined };
  return { selected: product, query: "", showCreate: false };
}

export interface CatalogKindResetState {
  completeProducts: CatalogProduct[];
  completeProductsLoaded: boolean;
  completeProductsPartial: boolean;
  completeProductsPartialReason?: CatalogFacetPartialReason | undefined;
  query: string;
  showCreate: boolean;
}

/** Reset transient catalog state when the inventory item kind changes. */
export function resetCatalogKindState(): CatalogKindResetState {
  return {
    completeProducts: [],
    completeProductsLoaded: false,
    completeProductsPartial: false,
    completeProductsPartialReason: undefined,
    query: "",
    showCreate: false
  };
}

export interface CompleteCatalogProductsResult {
  products: CatalogProduct[];
  partial: boolean;
  pageCount: number;
  partialReason?: CatalogFacetPartialReason | undefined;
}

export interface CatalogFacetPageOptions {
  pageSize?: number;
  maxProducts?: number;
}

/**
 * Read the complete-kind catalog in bounded cursor pages for facet choices.
 * The cap is intentional: a malformed or very large catalog must not make an
 * inventory dialog unresponsive, and the caller is told when the view is
 * partial so it can offer the exact search/custom-product path.
 */
export async function loadCompleteCatalogProducts(
  kind: CatalogKind,
  fetchPage: (kind: CatalogKind, query: string, options: { limit: number; cursor?: string }) => Promise<CatalogProductPage>,
  options: CatalogFacetPageOptions = {}
): Promise<CompleteCatalogProductsResult> {
  const requestedPageSize = options.pageSize ?? CATALOG_FACET_PAGE_SIZE;
  const pageSize = Number.isFinite(requestedPageSize)
    ? Math.min(CATALOG_FACET_PAGE_SIZE, Math.max(1, Math.floor(requestedPageSize)))
    : CATALOG_FACET_PAGE_SIZE;
  const requestedMaxProducts = options.maxProducts ?? CATALOG_FACET_MAX_PRODUCTS;
  const maxProducts = Number.isFinite(requestedMaxProducts)
    ? Math.max(pageSize, Math.floor(requestedMaxProducts))
    : CATALOG_FACET_MAX_PRODUCTS;
  const productsById = new Map<string, CatalogProduct>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;

  while (productsById.size < maxProducts) {
    const sizeBeforePage = productsById.size;
    const page = await fetchPage(kind, "", cursor ? { limit: pageSize, cursor } : { limit: pageSize });
    pageCount += 1;
    let uniqueProductsAdded = 0;
    for (const product of page.products) {
      if (productsById.size >= maxProducts) break;
      if (!productsById.has(product.id)) {
        productsById.set(product.id, product);
        uniqueProductsAdded += 1;
      }
    }

    const nextCursor = page.nextCursor?.trim();
    if (uniqueProductsAdded === 0 && nextCursor) return { products: [...productsById.values()], partial: true, partialReason: "no-progress", pageCount };
    if (productsById.size >= maxProducts) {
      const pageTruncated = page.products.length > maxProducts - sizeBeforePage;
      const hasUnloadedProducts = nextCursor !== undefined || (page.total !== undefined && page.total > productsById.size);
      const partial = pageTruncated || hasUnloadedProducts;
      return { products: [...productsById.values()], partial, ...(partial ? { partialReason: "cap" as const } : {}), pageCount };
    }
    if (!nextCursor) {
      const partial = page.total !== undefined && page.total > productsById.size;
      return { products: [...productsById.values()], partial, ...(partial ? { partialReason: "no-progress" as const } : {}), pageCount };
    }
    if (page.products.length === 0 || seenCursors.has(nextCursor)) return { products: [...productsById.values()], partial: true, partialReason: "no-progress", pageCount };
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { products: [...productsById.values()], partial: true, pageCount };
}

export interface ComboboxState {
  activeIndex: number;
  open: boolean;
}

/** Pure keyboard model used by the catalog combobox and unit tests. */
export function reduceComboboxKey(state: ComboboxState, key: ComboboxKey, optionCount: number): ComboboxState {
  if (key === "Escape") return { ...state, open: false };
  if (optionCount === 0) return { ...state, open: true };
  if (key === "ArrowDown") return { activeIndex: Math.min(Math.max(state.activeIndex + 1, 0), optionCount - 1), open: true };
  if (key === "ArrowUp") return { activeIndex: Math.max(state.activeIndex - 1, 0), open: true };
  if (key === "Home") return { activeIndex: 0, open: true };
  if (key === "End") return { activeIndex: optionCount - 1, open: true };
  if (key === "Enter") return { ...state, open: true };
  return state;
}

export function catalogProductDisplayName(product: CatalogProduct): string { const model = product.model?.trim() || product.family?.trim(); const base = [product.manufacturer?.trim(), model].filter(Boolean).join(" "); const variant = product.variant?.trim(); return ( [ base, variant && variant.toLocaleLowerCase() !== model?.toLocaleLowerCase() ? variant : undefined ] .filter(Boolean) .join(" · ") || product.productCode || product.id );
}

function productDetailLine(product: CatalogProduct): string {
  const details = [
    product.kind === "filament" && (product.colourName ?? product.colour ?? product.color),
    product.kind === "filament" && (product.colourCode ?? product.colorCode),
    product.kind === "filament" && product.diameterMm !== undefined ? `${product.diameterMm} mm` : undefined,
    product.kind === "filament" && (product.nominalNetMassG ?? product.netMassG) !== undefined ? `${(product.nominalNetMassG ?? product.netMassG)!.toLocaleString()} g net` : undefined,
    product.productCode ?? product.sku
  ].filter((value): value is string => Boolean(value));
  return details.concat(product.sku && !product.productCode ? [product.sku] : []).join(" · ");
}

export type CatalogFacetKey = | "manufacturer" | "family" | "subtype" | "colour" | "colourCode" | "diameterMm" | "netMassG" | "model" | "variant";

export interface CatalogFacetSelection {
  manufacturer?: string;
  family?: string;
  subtype?: string;
  colour?: string;
  colourCode?: string;
  diameterMm?: string;
  netMassG?: string;
  model?: string;
  variant?: string;
}

function catalogFacetValue(product: CatalogProduct, key: CatalogFacetKey): string | undefined {
  switch (key) {
    case "manufacturer": return product.manufacturer;
    case "family": return product.materialFamily ?? product.family;
    case "subtype": return product.materialSubtype;
    case "colour": return product.colourName ?? product.colour ?? product.color;
    case "colourCode": return product.colourCode ?? product.colorCode;
    case "diameterMm": return product.diameterMm === undefined ? undefined : String(product.diameterMm);
    case "netMassG": return String(product.nominalNetMassG ?? product.netMassG ?? "");
    case "model": return product.exactModel ?? product.model ?? product.productName;
    case "variant": return product.exactVariant ?? product.variant;
  }
}

/** Return unique facet values without leaking a product's physical ownership state. */
export function catalogFacetValues(products: readonly CatalogProduct[], kind: CatalogKind, key: CatalogFacetKey): string[] {
  const values = new Map<string, string>();
  products.filter((product) => product.kind === kind).forEach((product) => {
    const value = catalogFacetValue(product, key)?.trim();
    if (value && !values.has(value.toLocaleLowerCase())) values.set(value.toLocaleLowerCase(), value);
  });
  return [...values.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base", numeric: true }));
}

function facetEquals(product: CatalogProduct, key: CatalogFacetKey, expected: string | undefined): boolean {
  if (!expected) return true;
  return ( catalogFacetValue(product, key)?.toLocaleLowerCase() === expected.toLocaleLowerCase() );
}

/** Apply the exact, progressive facet choices to a bounded catalog page. */
export function filterCatalogProductsByFacets(products: readonly CatalogProduct[], kind: CatalogKind, selection: CatalogFacetSelection): CatalogProduct[] {
  return products.filter((product) => product.kind === kind && (Object.keys(selection) as CatalogFacetKey[]).every((key) => facetEquals(product, key, selection[key])));
}

function facetLabel(key: CatalogFacetKey, value: string): string {
  if (key === "diameterMm") return `${value} mm`;
  if (key === "netMassG") return `${Number(value).toLocaleString()} g net`;
  return value;
}

function productFacetSelection(product: CatalogProduct): CatalogFacetSelection {
  const keys: CatalogFacetKey[] = ["manufacturer", "family", "subtype", "colour", "colourCode", "diameterMm", "netMassG", "model", "variant"];
  return keys.reduce<CatalogFacetSelection>((selection, key) => {
    const value = catalogFacetValue(product, key);
    return value ? { ...selection, [key]: value } : selection;
  }, {});
}

interface CatalogFacetSelectProps {
  id: string;
  facet: CatalogFacetKey;
  label: string;
  value: string;
  values: readonly string[];
  disabled?: boolean;
  optional?: boolean;
  onChange: (value: string) => void;
}

function CatalogFacetSelect({ id, facet, label, value, values, disabled = false, optional = false, onChange }: CatalogFacetSelectProps) {
  return ( <Label className="form-field catalog-facet-field" htmlFor={id}><span>{label} {optional && <small>(optional)</small>}</span><NativeSelect id={id} value={value} disabled={disabled || values.length === 0} onChange={(event) => onChange(event.target.value)}><NativeSelectOption value="">{optional ? `Any ${label.toLocaleLowerCase()}` : `Select ${label.toLocaleLowerCase()}`}</NativeSelectOption>{values.map((option) => ( <NativeSelectOption key={option} value={option}>{facetLabel(facet, option)}</NativeSelectOption>))}</NativeSelect></Label> );
}

export interface CatalogFacetPickerProps {
  kind: CatalogKind;
  products: readonly CatalogProduct[];
  selected?: CatalogProduct | undefined;
  onSelect: (product: CatalogProduct | undefined) => void;
  onAddUnlisted?: () => void;
  partial?: boolean;
  partialCount?: number;
  partialReason?: CatalogFacetPartialReason | undefined;
}

/**
 * A bounded, progressive selector for exact catalog identity. Native selects
 * keep the path keyboard and mobile accessible; the free-text combobox remains
 * available below it for users who already know a product name or code.
 */
export function CatalogFacetPicker({ kind, products, selected, onSelect, onAddUnlisted, partial = false, partialCount, partialReason }: CatalogFacetPickerProps) {
  const [facets, setFacets] = useState<CatalogFacetSelection>(() => selected ? productFacetSelection(selected) : {});
  const isFilament = kind === "filament";
  const order: readonly CatalogFacetKey[] = isFilament
    ? ["manufacturer", "family", "subtype", "colour", "colourCode", "diameterMm", "netMassG"]
    : ["manufacturer", "model", "variant"];

  useEffect(() => {
    if (selected) setFacets(productFacetSelection(selected));
  }, [selected?.id]);

  const changeFacet = (key: CatalogFacetKey, value: string) => {
    const index = order.indexOf(key);
    const next = order.reduce<CatalogFacetSelection>((result, current, currentIndex) => {
      if (currentIndex < index) {
        const existing = facets[current];
        return existing ? { ...result, [current]: existing } : result;
      }
      if (current === key && value) return { ...result, [current]: value };
      return result;
    }, {});
    setFacets(next);
    onSelect(undefined);
  };

  const valuesFor = (key: CatalogFacetKey): string[] => {
    const index = order.indexOf(key);
    const prior = order.slice(0, index).reduce<CatalogFacetSelection>((result, priorKey) => {
      const value = facets[priorKey];
      return value ? { ...result, [priorKey]: value } : result;
    }, {});
    return catalogFacetValues(filterCatalogProductsByFacets(products, kind, prior), kind, key);
  };
  const matches = filterCatalogProductsByFacets(products, kind, facets);
  const required = isFilament
    ? Boolean(facets.manufacturer && facets.family && facets.colour && facets.diameterMm && facets.netMassG)
    : Boolean(facets.manufacturer && facets.model);
  const activeFacetCount = Object.keys(facets).length;
  const selectionId = `catalog-facet-${kind}`;
  const loadedCount = partialCount ?? products.filter((product) => product.kind === kind).length;
  const partialMessage = partialReason === "cap"
    ? `Showing the first ${loadedCount.toLocaleString()} catalog entries (safety cap). Narrow the search or add an unlisted product if the exact entry is not shown.`
    : `Only ${loadedCount.toLocaleString()} catalog entries loaded; catalog paging stopped before another unique entry was found. Search by exact name/code or add an unlisted product.`;

  return ( <section className="catalog-facet-picker" aria-labelledby={`${selectionId}-heading`}>
    <div className="catalog-facet-heading"><div><span className="eyebrow">Choose by details</span><h3 id={`${selectionId}-heading`}>{isFilament ? "Find the exact filament" : "Find the exact printer"}</h3></div><span className="catalog-facet-count">{products.filter((product) => product.kind === kind).length} catalog entries</span></div>
    <p className="catalog-facet-note">Catalog entries describe products only. They do not indicate that you own, have available, or can use a product.</p>
    {partial && ( <p className="catalog-facet-partial" role="status">{partialMessage}</p> )}
    <div className={`catalog-facet-grid ${isFilament ? "is-filament" : "is-printer"}`}>
      <CatalogFacetSelect id={`${selectionId}-manufacturer`} facet="manufacturer" label="Manufacturer / brand" value={facets.manufacturer ?? ""} values={valuesFor("manufacturer")} onChange={(value) => changeFacet("manufacturer", value)} />
      {isFilament ? ( <>
        <CatalogFacetSelect id={`${selectionId}-family`} facet="family" label="Product line / material family" value={facets.family ?? ""} values={valuesFor("family")} disabled={!facets.manufacturer} onChange={(value) => changeFacet("family", value)} />
        <CatalogFacetSelect id={`${selectionId}-subtype`} facet="subtype" label="Material subtype" value={facets.subtype ?? ""} values={valuesFor("subtype")} disabled={!facets.family} optional onChange={(value) => changeFacet("subtype", value)} />
        <CatalogFacetSelect id={`${selectionId}-colour`} facet="colour" label="Colour" value={facets.colour ?? ""} values={valuesFor("colour")} disabled={!facets.family} onChange={(value) => changeFacet("colour", value)} />
        <CatalogFacetSelect id={`${selectionId}-colourCode`} facet="colourCode" label="Colour code" value={facets.colourCode ?? ""} values={valuesFor("colourCode")} disabled={!facets.colour} optional onChange={(value) => changeFacet("colourCode", value)} />
        <CatalogFacetSelect id={`${selectionId}-diameterMm`} facet="diameterMm" label="Diameter" value={facets.diameterMm ?? ""} values={valuesFor("diameterMm")} disabled={!facets.colour} onChange={(value) => changeFacet("diameterMm", value)} />
        <CatalogFacetSelect id={`${selectionId}-netMassG`} facet="netMassG" label="Net mass" value={facets.netMassG ?? ""} values={valuesFor("netMassG")} disabled={!facets.diameterMm} onChange={(value) => changeFacet("netMassG", value)} />
      </> ) : ( <>
        <CatalogFacetSelect id={`${selectionId}-model`} facet="model" label="Exact model" value={facets.model ?? ""} values={valuesFor("model")} disabled={!facets.manufacturer} onChange={(value) => changeFacet("model", value)} />
        <CatalogFacetSelect id={`${selectionId}-variant`} facet="variant" label="Variant" value={facets.variant ?? ""} values={valuesFor("variant")} disabled={!facets.model} optional onChange={(value) => changeFacet("variant", value)} />
      </> )}
    </div>
    {required && ( <div className="catalog-exact-choices" aria-live="polite"><div className="catalog-exact-choices-heading"><strong>Exact product</strong><span>{matches.length} match{matches.length === 1 ? "" : "es"}</span></div>{matches.length ? ( <Command shouldFilter={false} tabIndex={0}><CommandList className="catalog-exact-choice-list" aria-label={`Exact ${kind} products`}>{matches.map((product) => ( <CommandItem value={product.id} className={`catalog-exact-choice ${selected?.id === product.id ? "is-selected" : ""}`} key={product.id} onSelect={() => onSelect(product)}><span className="catalog-option-copy"><strong>{catalogProductDisplayName(product)}</strong><small>{productDetailLine(product) || "Product details not recorded yet"}</small></span><Icon name={selected?.id === product.id ? "check-circle" : "chevron-right"} size={15} /></CommandItem>))}</CommandList></Command> ) : ( <div className="catalog-facet-empty"><p className="catalog-empty">No exact product matches these details.</p>{onAddUnlisted && ( <Button variant="outline" type="button" className="button button-secondary" onClick={onAddUnlisted}><Icon name="plus" size={15} /> Add product</Button> )}</div> )}</div> )}
    {activeFacetCount > 0 && !required && ( <p className="field-hint">Keep choosing details to reveal exact product matches.</p> )}
  </section> );
}

export interface CatalogComboboxProps {
  kind: CatalogKind;
  products: CatalogProduct[];
  query: string;
  selected?: CatalogProduct | undefined;
  onQueryChange: (value: string) => void;
  onSelect: (product: CatalogProduct | undefined) => void;
  label: string;
  placeholder?: string;
  loading?: boolean;
  disabled?: boolean;
  hint?: string;
}

/**
 * An APG-style combobox: the input owns focus, results are a listbox, and
 * arrow/Home/End/Enter/Escape work without relying on a mouse.
 */
export function CatalogCombobox({ kind, products, query, selected, onQueryChange, onSelect, label, placeholder = "Search exact products", loading = false, disabled = false, hint }: CatalogComboboxProps) {
  return <div className="catalog-combobox"><SearchCombobox label={label} value={selected ? catalogProductDisplayName(selected) : query} onValueChange={next => { if (selected) onSelect(undefined); onQueryChange(next); }} placeholder={placeholder} disabled={disabled} loading={loading} options={products.map(product => ({ id: product.id, content: <span><strong>{catalogProductDisplayName(product)}</strong><small>{productDetailLine(product)}</small></span> }))} onSelect={id => { const product = products.find(product => product.id === id); if (product) { onSelect(product); onQueryChange(""); } }} empty={`No exact ${kind} products match that search.`}/>{hint && <p className="field-hint">{hint}</p>}{selected && <div className="catalog-selected" aria-live="polite"><span className="catalog-selected-label">Selected exact product</span><strong>{catalogProductDisplayName(selected)}</strong><small>{productDetailLine(selected) || "Details to confirm"}</small></div>}</div>;
}

export interface CatalogProductCreateFormProps {
  kind: CatalogKind;
  onCreate: (input: CatalogProductDraft) => Promise<CatalogProduct | undefined>;
  onCancel?: () => void;
}

/** Compact no-results path. It creates a catalog identity, never stock. */
export function CatalogProductCreateForm({ kind, onCreate, onCancel }: CatalogProductCreateFormProps) {
  const [manufacturer, setManufacturer] = useState("");
  const [family, setFamily] = useState("");
  const [model, setModel] = useState("");
  const [variant, setVariant] = useState("");
  const [colour, setColour] = useState("");
  const [colourCode, setColourCode] = useState("");
  // Required canonical facts start empty: examples belong in placeholders, not
  // in the payload that creates an exact product identity.
  const [diameter, setDiameter] = useState("");
  const [netMass, setNetMass] = useState("");
  const [buildVolumeX, setBuildVolumeX] = useState("");
  const [buildVolumeY, setBuildVolumeY] = useState("");
  const [buildVolumeZ, setBuildVolumeZ] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const positiveNumber = (value: string): boolean => Number.isFinite(Number(value)) && Number(value) > 0;
  const identityReady = Boolean(
    manufacturer.trim()
      && (kind === "filament"
        ? family.trim() && colour.trim() && positiveNumber(diameter) && positiveNumber(netMass)
        : model.trim() && positiveNumber(buildVolumeX) && positiveNumber(buildVolumeY) && positiveNumber(buildVolumeZ))
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!identityReady || submitting) return;
    setSubmitting(true);
    setError(undefined);
    const draft: CatalogProductDraft = {
      kind,
      manufacturer: manufacturer.trim(),
      ...(family.trim() ? { family: family.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(variant.trim() ? { variant: variant.trim() } : {}),
      ...(kind === "filament" && colour.trim() ? { colour: colour.trim() } : {}),
      ...(kind === "filament" && colourCode.trim() ? { colourCode: colourCode.trim() } : {}),
      ...(kind === "filament" && Number.isFinite(Number(diameter)) && Number(diameter) > 0 ? { diameterMm: Number(diameter) } : {}),
      ...(kind === "filament" && Number.isFinite(Number(netMass)) && Number(netMass) > 0 ? { netMassG: Number(netMass) } : {}),
      ...(kind === "printer" && positiveNumber(buildVolumeX) && positiveNumber(buildVolumeY) && positiveNumber(buildVolumeZ) ? { buildVolumeMm: { x: Number(buildVolumeX), y: Number(buildVolumeY), z: Number(buildVolumeZ) } } : {})
    };
    try {
      const created = await onCreate(draft);
      if (!created) setError("The product could not be added. Check the details and try again.");
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The product could not be added.");
    } finally {
      setSubmitting(false);
    }
  };

  return <form className="catalog-create-form" onSubmit={event => { void submit(event); }}>
    <div className="catalog-create-heading"><h3>Add product</h3><p>Add the exact identity from its label or specification. Stock is recorded in the next step.</p></div>
    <Label className="form-field"><span>Manufacturer</span><Input autoFocus required value={manufacturer} onChange={event => setManufacturer(event.target.value)} placeholder="e.g. Bambu Lab" disabled={submitting} /></Label>
    {kind === "filament" ? <>
      <Label className="form-field"><span>Family · material family</span><Input required value={family} onChange={event => setFamily(event.target.value)} placeholder="e.g. PETG HF" disabled={submitting} /></Label>
      <Label className="form-field"><span>Colour</span><Input required value={colour} onChange={event => setColour(event.target.value)} placeholder="e.g. Black" disabled={submitting} /></Label>
      <div className="form-row"><Label className="form-field"><span>Diameter (mm)</span><Input required type="number" min="0.1" step="0.01" value={diameter} onChange={event => setDiameter(event.target.value)} disabled={submitting} /></Label><Label className="form-field"><span>Net mass (g)</span><Input required type="number" min="1" step="1" value={netMass} onChange={event => setNetMass(event.target.value)} disabled={submitting} /></Label></div>
    </> : <>
      <Label className="form-field"><span>Model · exact model</span><Input required value={model} onChange={event => setModel(event.target.value)} placeholder="Exact model" disabled={submitting} /></Label>
      <fieldset className="catalog-printer-volume-fields"><legend>Build volume (mm)</legend><Label className="form-field"><span>X</span><Input required type="number" min="1" step="any" value={buildVolumeX} onChange={event => setBuildVolumeX(event.target.value)} placeholder="325" disabled={submitting} /></Label><Label className="form-field"><span>Y</span><Input required type="number" min="1" step="any" value={buildVolumeY} onChange={event => setBuildVolumeY(event.target.value)} placeholder="320" disabled={submitting} /></Label><Label className="form-field"><span>Z</span><Input required type="number" min="1" step="any" value={buildVolumeZ} onChange={event => setBuildVolumeZ(event.target.value)} placeholder="325" disabled={submitting} /></Label></fieldset>
    </>}
    <Disclosure className="inventory-capture-details"><DisclosureTrigger>Variant & additional identity</DisclosureTrigger><DisclosureContent>
      {kind === "filament" ? <><Label className="form-field"><span>Model <small>(optional)</small></span><Input value={model} onChange={event => setModel(event.target.value)} placeholder="Product name" disabled={submitting} /></Label><Label className="form-field"><span>Colour code <small>(optional)</small></span><Input value={colourCode} onChange={event => setColourCode(event.target.value)} placeholder="#000000" disabled={submitting} /></Label></> : <Label className="form-field"><span>Family <small>(optional)</small></span><Input value={family} onChange={event => setFamily(event.target.value)} disabled={submitting} /></Label>}
      <Label className="form-field"><span>Variant <small>(optional)</small></span><Input value={variant} onChange={event => setVariant(event.target.value)} placeholder={kind === "filament" ? "Material subtype" : "Bundle / revision"} disabled={submitting} /></Label>
    </DisclosureContent></Disclosure>
    {error && <Alert asChild><p className="form-error" role="alert">{error} Your entries are kept.</p></Alert>}
    <div className="dialog-actions"><Button variant="ghost" type="button" className="button button-quiet" onClick={onCancel} disabled={submitting}>Back to results</Button><Button variant="default" type="submit" className="button button-primary" disabled={!identityReady || submitting}>{submitting ? "Adding…" : "Add product"}<Icon name="plus" size={16} /></Button></div>
  </form>;
}

export function ownedItemLabel(item: InventoryItem, items: readonly InventoryItem[]): string {
  if (!item.catalogProduct) return `${inventoryCandidateText(item, items)} · Exact product unknown`;
  const catalogName = catalogProductDisplayName(item.catalogProduct);
  const identity = inventoryCandidateLabel(item, items);
  if (identity.discriminator) return `${catalogName} · ${identity.discriminator}`; return catalogName; } function ownedPrinterVolumeLabel(item: InventoryItem): string | undefined { const volume = item.catalogProduct?.buildVolumeMm;
  return volume ? `${volume.x} × ${volume.y} × ${volume.z} mm build volume` : undefined;
}

export interface BuildItemEligibility {
  eligible: boolean;
  reason?: string;
}

function hasConfirmedPhysicalEvidence(item: InventoryItem): boolean {
  if (item.serverEvidence !== undefined) return ( item.serverEvidence === "physically_counted" || item.serverEvidence === "commissioned" );
  return item.evidence === "counted" || item.evidence === "commissioned";
}

/** Return the user-facing reason a physical item cannot be used for setup. */
export function buildItemEligibility(item: InventoryItem, category: "Printers" | "Filament"): BuildItemEligibility {
  if (item.category !== category) return { eligible: false, reason: `Choose a ${category === "Printers" ? "printer" : "filament"} inventory item.` };
  if (item.unitStatus === "needs_correction") return { eligible: false, reason: item.unitCorrectionReason ?? "Correct this item's unit before using it in a build setup." };
  if (category === "Printers") {
    if (!item.catalogProduct) return { eligible: false, reason: "The exact printer details are incomplete. Add the model and variant before using it in a build setup." };
    return isExactProductIdentityComplete(item)
      ? { eligible: true }
      : { eligible: false, reason: "The exact printer bundle or variant details are incomplete. Update them before using this printer in a build setup." };
  }
  // Exact catalog-backed filament keeps the established setup path. The
  // physical evidence and availability gate only applies when no catalog
  // identity is available and the UI is about to emit the explicit unknown
  // identity branch.
  if (item.catalogProduct) return { eligible: true };
  if (!hasConfirmedPhysicalEvidence(item)) return { eligible: false, reason: "A physical count or commissioning evidence is required before setup." };
  return { eligible: true };
}

/** Convert the selected physical spool to the explicit create-request shape. */
export function buildFilamentSelection(item: InventoryItem): BuildFilamentSelection {
  if (item.catalogProduct) {
    return {
      itemId: item.id,
      catalogProductId: item.catalogProduct.id,
      ...(item.productProfile?.id ? { profileId: item.productProfile.id } : {})
    };
  }
  return { itemId: item.id, catalogIdentityState: "unknown" };
}

export type OwnedInventorySearch = (category: "Printers" | "Filament", query: string, signal: AbortSignal) => Promise<InventoryPage>;
export const OwnedInventorySearchContext = createContext<OwnedInventorySearch | undefined>(undefined);

export interface OwnedItemComboboxProps {
  category: "Printers" | "Filament";
  candidateFilter?: ((item: InventoryItem) => boolean) | undefined;
  items: InventoryItem[];
  value?: InventoryItem | undefined;
  onSelect: (item: InventoryItem | undefined) => void; onResolveItem?: ((item: InventoryItem) => void) | undefined; label: string; helper?: string; showInitialChoices?: boolean; }

export function OwnedItemCombobox({ category, items, value, onSelect, onResolveItem, label, helper, showInitialChoices = false, candidateFilter }: OwnedItemComboboxProps) {
 const [query,setQuery] = useState("");
 const search = useContext(OwnedInventorySearchContext);
 const [page,setPage] = useState<InventoryPage>();
 const [loading,setLoading] = useState(false);
 const [error,setError] = useState(false);
 const [retry,setRetry] = useState(0);
 useEffect(() => {
   if (!search) return;
   let active = true; const controller = new AbortController();
   setLoading(true); setError(false); setPage(undefined);
   const timer = setTimeout(() => { void search(category, query.trim().slice(0,200), controller.signal).then(result => { if (active) setPage(result); }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); }); }, 250);
   return () => { active = false; clearTimeout(timer); controller.abort(); };
 }, [search,category,query,retry]);
 const candidates = (page?.items ?? items).filter(item => item.category === category && !item.tags.includes("retired") && (!candidateFilter || candidateFilter(item)) && (page !== undefined || !query.trim() || inventoryCandidateText(item,items).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
 const lookupStatus = <>{loading && <p role="status" className="form-hint">Searching owned inventory…</p>}{error && <div role="alert"><p>Owned inventory search is unavailable. Loaded suggestions are still shown.</p><Button variant="outline" type="button" onClick={() => setRetry(value => value + 1)}>Retry owned inventory search</Button></div>}{page && <p className="form-hint">{candidates.length} selectable {category === "Printers" ? "printers" : "filament items"} shown from {page.total} inventory matches.{page.nextCursor ? " Refine the search to find another item." : ""} Eligibility checks still apply.</p>}</>;
 const choose = (item: InventoryItem) => { onSelect(item); setQuery(""); };
 const eligibility = value ? buildItemEligibility(value,category) : undefined;
 return <div className="catalog-combobox owned-combobox"><SearchCombobox label={label} value={value ? ownedItemLabel(value,items) : query} onValueChange={next => { if (value) onSelect(undefined); setQuery(next); }} placeholder={`Choose an owned ${category === "Printers" ? "printer" : "filament"}`} loading={loading} options={candidates.map(item => ({ id:item.id, content:<span><strong>{ownedItemLabel(item,items)}</strong><small>{item.quantity.toLocaleString()} {item.unit} · {exactProductLabel(item)} · {buildItemEligibility(item,category).eligible ? "Eligible" : "Needs details"}</small></span> }))} onSelect={id => { const item=candidates.find(item=>item.id===id); if(item)choose(item); }} empty={error ? "Search unavailable; retry to check other owned items." : `No selectable ${category === "Printers" ? "printers" : "filament"} in these results.`}/>{lookupStatus}{helper && <small className="form-field-help">{helper}</small>}{showInitialChoices && !value && !query.trim() && <div className="owned-quick-choices" aria-label={`${label} quick choices`}>{candidates.slice(0,4).map(item=><Button variant="ghost" type="button" className="owned-quick-choice" key={item.id} onClick={()=>choose(item)}><strong>{ownedItemLabel(item,items)}</strong><small>{ownedPrinterVolumeLabel(item) ?? exactProductLabel(item)}</small></Button>)}</div>}{value && <div className="catalog-selected"><span className="catalog-selected-label">Owned item</span><strong>{ownedItemLabel(value,items)}</strong><small>{value.catalogProduct ? exactProductLabel(value) : category === "Printers" ? "Printer model not recorded" : "Filament details not recorded"}</small>{eligibility && !eligibility.eligible && <Alert><span>{category === "Printers" ? "Add the exact printer model and variant." : eligibility.reason}</span>{category === "Printers" && onResolveItem && <Button variant="ghost" type="button" className="text-button" onClick={()=>onResolveItem(value)}>Add printer details</Button>}</Alert>}</div>}</div>;
}

export interface SetupSummaryProps {
  input: BuildConfigInput;
  printer?: InventoryItem | undefined;
  filament?: InventoryItem | undefined;
  expert: boolean;
  heading?: string;
}

function setupSnapshotField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function physicalEvidenceSummary(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const selection = value as Record<string, unknown>;
  const physicalEvidence = selection.physicalEvidence;
  if (physicalEvidence === null || typeof physicalEvidence !== "object" || Array.isArray(physicalEvidence)) return undefined;
  const evidence = physicalEvidence as Record<string, unknown>;
  const state = typeof evidence.state === "string" && evidence.state.trim() ? evidence.state.trim() : undefined;
  if (!state) return undefined;
  const stateLabel = state === "physically_counted" ? "Physically counted" : state === "delivered_uncounted" ? "Delivered, not counted" : state === "ordered_unverified" ? "Ordered, not verified" : state === "commissioned" ? "Commissioned" : state;
  return [
    `${stateLabel} (${state})`,
    typeof evidence.source === "string" && evidence.source.trim() ? `Source: ${evidence.source.trim()}` : undefined,
    typeof evidence.sourceId === "string" && evidence.sourceId.trim() ? `Source record: ${evidence.sourceId.trim()}` : undefined,
    typeof evidence.observedAt === "string" && evidence.observedAt.trim() ? `Observed: ${evidence.observedAt.trim()}` : undefined,
    typeof evidence.note === "string" && evidence.note.trim() ? `Note: ${evidence.note.trim()}` : undefined
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

export function BuildSetupSummary({ input, printer, filament, expert, heading = "Setup summary" }: SetupSummaryProps) {
  const persisted = input as BuildConfigInput & {
    contentSha256?: string;
    contentHash?: string;
    projectRevisionId?: string;
    printerItemSnapshot?: unknown;
    filamentSelections?: readonly unknown[];
    slicerDescriptor?: unknown;
    firmwareDescriptor?: unknown;
  };
  const printerSnapshot = persisted.printerItemSnapshot;
  const filamentSnapshot = persisted.filamentSelections?.[0];
  const printerId = printer?.id ?? setupSnapshotField(printerSnapshot, "itemId");
  const filamentId = filament?.id ?? setupSnapshotField(filamentSnapshot, "itemId");
  const printerProductId = printer?.catalogProduct?.id ?? setupSnapshotField(printerSnapshot, "catalogProductId");
  const filamentProductId = filament?.catalogProduct?.id ?? setupSnapshotField(filamentSnapshot, "catalogProductId");
  const versions = [
    printer?.catalogProduct?.version && `printer v${printer.catalogProduct.version}`,
    filament?.catalogProduct?.version && `filament v${filament.catalogProduct.version}`,
    input.slicerVersion,
    setupSnapshotField(persisted.slicerDescriptor, "version") && `slicer v${setupSnapshotField(persisted.slicerDescriptor, "version")}`,
    setupSnapshotField(persisted.firmwareDescriptor, "version") && `firmware v${setupSnapshotField(persisted.firmwareDescriptor, "version")}`
  ].filter(Boolean).join(" · ");
  const evidence = [
    printer?.productProfile?.linkState ?? setupSnapshotField(printerSnapshot, "linkState") ?? "not linked",
    physicalEvidenceSummary(filamentSnapshot) ?? filament?.productProfile?.linkState ?? setupSnapshotField(filamentSnapshot, "linkState") ?? "not linked"
  ].join(" · ");
  const unknownFilament = isUnknownFilamentSelection(input, filament);
  return ( <section className="setup-summary" aria-label="Build setup summary"><div className="setup-summary-heading"><span className="eyebrow">{heading}</span>{expert && <span className="expert-badge">Technical details</span>}</div><p>{buildSetupSummary(input, printer, filament)}</p>{unknownFilament && ( <div className="setup-blockers" role="status"><strong>Exact product unknown</strong><span>Design open</span><p>Blocker: confirm the physical filament identity before production approval.</p></div> )}{expert && ( <Disclosure className="expert-detail setup-expert-detail"><DisclosureTrigger>Show IDs, versions, evidence &amp; unknowns</DisclosureTrigger><DisclosureContent><div className="detail-grid"><div><span>Revision ID</span><code>{persisted.projectRevisionId ?? "Not recorded"}</code></div><div><span>Printer ID</span><code>{printerId ?? "Not selected"}</code></div><div><span>Filament ID</span><code>{filamentId ?? "Not selected"}</code></div><div><span>Printer product</span><code>{printerProductId ?? "Exact product not confirmed"}</code></div><div><span>Filament product</span><code>{filamentProductId ?? "Exact product unknown"}</code></div><div><span>Versions</span><code>{versions || "Not recorded"}</code></div><div><span>Evidence</span><code>{evidence}</code></div><div><span>Content hash</span><code>{[persisted.contentSha256, persisted.contentHash, printer?.catalogProduct?.contentHash, filament?.catalogProduct?.contentHash].filter(Boolean).join(" · ") || "Not recorded"}</code></div><div><span>Unknowns</span><code>{input.unknowns.join(" · ") || "None recorded"}</code></div></div></DisclosureContent></Disclosure> )}</section> );
}

export interface CatalogInventoryFlowProps {
  initialQuantity?: string | undefined;
  category: "Printers" | "Filament";
  onDraftChange?: (state: { dirty: boolean; busy: boolean }) => void;
  products: CatalogProduct[];
  query: string;
  onQueryChange: (query: string) => void;
  onSearch: (kind: CatalogKind, query: string, options?: { limit?: number }) => Promise<CatalogProduct[]>;
  onSearchPage?: (kind: CatalogKind, query: string, options?: CatalogSearchOptions) => Promise<CatalogProductPage>;
  onCreateProduct: (input: CatalogProductDraft) => Promise<CatalogProduct | undefined>;
  onCreate: (input: ExactInventoryInput) => Promise<boolean>; onAddManually?: () => void; existingItem?: InventoryItem; }

export function CatalogInventoryFlow({ initialQuantity, onDraftChange, category, products, query, onQueryChange, onSearch, onSearchPage, onCreateProduct, onCreate, onAddManually, existingItem }: CatalogInventoryFlowProps) {
  const kind: CatalogKind = category === "Filament" ? "filament" : "printer";
  const [selected, setSelected] = useState<CatalogProduct>();
  const [completeProducts, setCompleteProducts] = useState<CatalogProduct[]>(products);
  const [completeProductsLoaded, setCompleteProductsLoaded] = useState(false);
  const [completeProductsPartial, setCompleteProductsPartial] = useState(false);
  const [completeProductsPartialReason, setCompleteProductsPartialReason] = useState<CatalogFacetPartialReason>();
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [quantity, setQuantity] = useState(initialQuantity ?? (existingItem ? String(existingItem.quantity) : category === "Filament" ? "" : "1"));
  const [linkState, setLinkState] = useState<LinkState>("reported");
  const [lotBatch, setLotBatch] = useState("");
  const [spoolState, setSpoolState] = useState<"sealed" | "opened">("sealed");
  const [openedAt, setOpenedAt] = useState("");
  const [tareMass, setTareMass] = useState("");
  const [placement, setPlacement] = useState("");
  const [assetLabel, setAssetLabel] = useState("");
  const [commissionedAt, setCommissionedAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [creatingProduct, setCreatingProduct] = useState(false);
  const dirty = Boolean(selected || query.trim() || showCreate || lotBatch || openedAt || tareMass || placement || assetLabel || commissionedAt || linkState !== "reported" || spoolState !== "sealed" || quantity !== (initialQuantity ?? (existingItem ? String(existingItem.quantity) : category === "Filament" ? "" : "1")));
  useEffect(() => { onDraftChange?.({ dirty, busy: submitting || creatingProduct }); }, [dirty, submitting, creatingProduct, onDraftChange]);
  useEffect(() => () => { onDraftChange?.({ dirty: false, busy: false }); }, [onDraftChange]);

  useEffect(() => {
    const reset = resetCatalogKindState();
    setSelected(undefined);
    setCompleteProducts(reset.completeProducts);
    setCompleteProductsLoaded(reset.completeProductsLoaded);
    setCompleteProductsPartial(reset.completeProductsPartial);
    setCompleteProductsPartialReason(reset.completeProductsPartialReason);
    setShowCreate(reset.showCreate);
    setFormError(undefined);
    onQueryChange(reset.query);
  }, [kind]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const load = async () => {
      try {
        if (!query.trim() && onSearchPage) {
          const result = await loadCompleteCatalogProducts(kind, (pageKind, pageQuery, options) => onSearchPage(pageKind, pageQuery, options), {});
          if (active) {
            setCompleteProducts(result.products);
            setCompleteProductsPartial(result.partial);
            setCompleteProductsPartialReason(result.partialReason);
            setCompleteProductsLoaded(true);
          }
          return;
        }
        const results = await onSearch(kind, query, { limit: CATALOG_FACET_PAGE_SIZE });
        if (!active) return;
        // The parent-owned list drives the searchable combobox. Keep a separate
        // blank-query page for facets so typing a search cannot collapse them.
        if (!query.trim()) {
          setCompleteProducts(results);
          setCompleteProductsPartial(false);
          setCompleteProductsPartialReason(undefined);
          setCompleteProductsLoaded(true);
        }
      } catch {
        // The combobox and custom-product path remain usable when catalog lookup
        // fails; the parent reports connected-service errors where appropriate.
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [kind, query]);

  const selectProduct = (product: CatalogProduct | undefined) => {
    const next = nextCatalogSelectionState({ selected, query, showCreate }, product);
    setSelected(next.selected);
    if (product) {
      setShowCreate(next.showCreate);
      onQueryChange(next.query);
    }
  };

  const createProduct = async (input: CatalogProductDraft) => {
    setCreatingProduct(true);
    try {
      const product = await onCreateProduct(input);
      if (product) selectProduct(product);
      return product;
    } finally { setCreatingProduct(false); }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || submitting) return;
    const parsedQuantity = Number(quantity);
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) { setFormError("Enter a quantity greater than zero."); return; }
    setSubmitting(true);
    setFormError(undefined);
    const input: ExactInventoryInput = {
      category,
      product: selected,
      quantity: parsedQuantity,
      linkState,
      ...(category === "Filament" ? { filament: {
        ...(lotBatch.trim() ? { lotBatch: lotBatch.trim() } : {}),
        state: spoolState,
        ...(openedAt ? { openedAt } : {}),
        ...(Number.isFinite(Number(tareMass)) && Number(tareMass) >= 0 && tareMass !== "" ? { tareMassG: Number(tareMass) } : {}),
        ...(placement.trim() ? { placement: placement.trim() } : {})
      } } : { printer: {
        ...(assetLabel.trim() ? { assetLabel: assetLabel.trim() } : {}),
        ...(commissionedAt ? { commissionedAt } : {}),
        ...(placement.trim() ? { placement: placement.trim() } : {})
      } })
    };
    try {
      const created = await onCreate(input);
      if (!created) setFormError( `${existingItem ? "The exact product link" : "The exact inventory record"} was not saved. Check the service connection and try again.` );
    } catch (caught: unknown) {
      setFormError(caught instanceof Error ? caught.message : "The exact inventory record was not saved.");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmation = linkState === "confirmed" ? "I checked the physical item against this exact product." : "Reported for now — confirm the exact product after checking the item.";
  const activeSelected = selected?.kind === kind ? selected : undefined;
  const submitLabel = existingItem ? existingItem.productProfile ? "Change exact product" : "Link exact product" : `Add ${category === "Filament" ? "filament spool" : "printer"}`; const facetProducts = completeProductsLoaded || completeProducts.length === 0 ? completeProducts : products;
  const noSearchResults = !activeSelected && query.trim() && !loading && products.length === 0 && !showCreate;
  return <div className="catalog-inventory-flow">
    {!activeSelected && !showCreate && <>
      <CatalogCombobox key={kind} kind={kind} products={products} query={query} onQueryChange={onQueryChange} onSelect={selectProduct} label={`Exact ${category === "Filament" ? "filament product" : "printer model"}`} loading={loading} hint="Search by name or product code. You can add an unidentified item with the details you know." />
      <Disclosure className="catalog-browse-details"><DisclosureTrigger>Find by product details</DisclosureTrigger><DisclosureContent><CatalogFacetPicker key={kind} kind={kind} products={facetProducts.length ? facetProducts : products} selected={activeSelected} partial={completeProductsPartial} partialCount={completeProducts.length} partialReason={completeProductsPartialReason} onSelect={selectProduct} onAddUnlisted={() => setShowCreate(true)} /></DisclosureContent></Disclosure>
      {onAddManually && <Button variant="ghost" type="button" className="button button-quiet" onClick={onAddManually}>Add details myself</Button>}
      {noSearchResults && <div className="catalog-no-results"><p>No exact product found. Add its identity to the catalog, or record the item now and confirm its details later.</p><Button variant="outline" type="button" className="button button-secondary" onClick={() => setShowCreate(true)}><Icon name="plus" size={15} />Add product</Button></div>}
    </>}
    {showCreate && <CatalogProductCreateForm kind={kind} onCreate={createProduct} onCancel={() => setShowCreate(false)} />}
    {activeSelected && <form className="exact-inventory-form" onSubmit={event => { void submit(event); }}>
      <div className="exact-product-card" aria-label="Exact product selected"><h3>{catalogProductDisplayName(activeSelected)}</h3><p>{productDetailLine(activeSelected) || "Product details not recorded yet"}</p><span className="sr-only">Exact product selected</span></div>
      <Label className="form-field"><span>{existingItem ? "Recorded quantity (unchanged)" : category === "Filament" ? "Current mass (g)" : "Owned units"}</span><Input autoFocus type="number" min="0.01" step="any" inputMode="decimal" required value={quantity} onChange={event => setQuantity(event.target.value)} disabled={submitting || Boolean(existingItem)} /></Label>
      <Label className="form-field"><span>Current placement <small>(optional)</small></span><Input value={placement} onChange={event => setPlacement(event.target.value)} placeholder={category === "Filament" ? "Shelf / AMS slot" : "Print room"} disabled={submitting} /></Label>
      <Label className="form-field"><span>Product identity</span><NativeSelect value={linkState} onChange={event => setLinkState(event.target.value as LinkState)} disabled={submitting}><NativeSelectOption value="reported">Not checked yet</NativeSelectOption><NativeSelectOption value="confirmed">I checked the exact product</NativeSelectOption></NativeSelect></Label>
      <p className={`link-state-note ${linkState === "confirmed" ? "is-confirmed" : ""}`}><Icon name={linkState === "confirmed" ? "check-circle" : "info"} size={15} />{confirmation}</p>
      <p className="field-hint">Product identity and physical stock are separate checks. This form does not record a physical count.</p>
      {category === "Filament" && <Label className="form-field"><span>Spool state</span><NativeSelect value={spoolState} onChange={event => setSpoolState(event.target.value as "sealed" | "opened")} disabled={submitting}><NativeSelectOption value="sealed">Sealed</NativeSelectOption><NativeSelectOption value="opened">Opened</NativeSelectOption></NativeSelect></Label>}
      <Disclosure className="inventory-capture-details"><DisclosureTrigger>{category === "Filament" ? "Batch & spool details" : "Printer details"}</DisclosureTrigger><DisclosureContent>
        {category === "Filament" ? <>
          <Label className="form-field"><span>Lot / batch <small>(optional)</small></span><Input value={lotBatch} onChange={event => setLotBatch(event.target.value)} placeholder="Printed spool lot" disabled={submitting} /></Label>
          {spoolState === "opened" && <Label className="form-field"><span>Opened date</span><Input type="date" value={openedAt} onChange={event => setOpenedAt(event.target.value)} disabled={submitting} /></Label>}
          <Label className="form-field"><span>Tare mass (g) <small>(optional)</small></span><Input type="number" min="0" step="any" value={tareMass} onChange={event => setTareMass(event.target.value)} placeholder="Empty spool weight" disabled={submitting} /></Label>
        </> : <>
          <Label className="form-field"><span>Asset label <small>(optional)</small></span><Input value={assetLabel} onChange={event => setAssetLabel(event.target.value)} placeholder="e.g. PRINT-01" disabled={submitting} /></Label>
          <Label className="form-field"><span>Setup date <small>(optional)</small></span><Input type="date" value={commissionedAt} onChange={event => setCommissionedAt(event.target.value)} disabled={submitting} /></Label>
        </>}
      </DisclosureContent></Disclosure>
      {formError && <Alert asChild><p className="form-error" role="alert">{formError} Your entries are kept.</p></Alert>}
      <div className="dialog-actions"><Button variant="ghost" type="button" className="button button-quiet" onClick={() => setSelected(undefined)} disabled={submitting}>Change product</Button><Button variant="default" type="submit" className="button button-primary" disabled={submitting}>{submitting ? "Saving…" : submitLabel}<Icon name="plus" size={16} /></Button></div>
    </form>}
  </div>;
}

export function splitSetupValues(value: string): string[] {
  return value.split(/[\n,]/u).map((part) => part.trim()).filter(Boolean);
}

export function emptyBuildConfig(): BuildConfigInput {
  return { accessories: [], unknowns: [] };
}

export function profileForItem(item: InventoryItem | undefined): InventoryProductProfile | undefined {
  return item?.productProfile;
}

export type CatalogUiNode = ReactNode;
