import { useEffect, useId, useMemo, useState } from "react";
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
import { buildSetupSummary, catalogProductLabel, exactProductLabel, isUnknownFilamentSelection } from "./domain";
import type { CatalogProductDraft, CatalogProductPage, CatalogSearchOptions, ExactInventoryInput } from "./api";
import { Icon } from "./icons";

export type ComboboxKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "Enter" | "Escape";

export const CATALOG_FACET_PAGE_SIZE = 100;
export const CATALOG_FACET_MAX_PRODUCTS = 1000;
export type CatalogFacetPartialReason = "cap" | "no-progress";

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
      const hasUnloadedProducts = nextCursor !== undefined || page.total !== undefined && page.total > productsById.size;
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

export function catalogProductDisplayName(product: CatalogProduct): string {
  return catalogProductLabel(product) || product.productCode || product.id;
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

export type CatalogFacetKey = "manufacturer" | "family" | "subtype" | "colour" | "colourCode" | "diameterMm" | "netMassG" | "model" | "variant";

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
  return catalogFacetValue(product, key)?.toLocaleLowerCase() === expected.toLocaleLowerCase();
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
  return <label className="form-field catalog-facet-field" htmlFor={id}><span>{label} {optional && <small>(optional)</small>}</span><select id={id} value={value} disabled={disabled || values.length === 0} onChange={(event) => onChange(event.target.value)}><option value="">{optional ? `Any ${label.toLocaleLowerCase()}` : `Select ${label.toLocaleLowerCase()}`}</option>{values.map((option) => <option key={option} value={option}>{facetLabel(facet, option)}</option>)}</select></label>;
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

  return <section className="catalog-facet-picker" aria-labelledby={`${selectionId}-heading`}>
    <div className="catalog-facet-heading"><div><span className="eyebrow">Choose by details</span><h3 id={`${selectionId}-heading`}>{isFilament ? "Find the exact filament" : "Find the exact printer"}</h3></div><span className="catalog-facet-count">{products.filter((product) => product.kind === kind).length} catalog entries</span></div>
    <p className="catalog-facet-note">Catalog entries describe products only. They do not indicate that you own, have available, or can use a product.</p>
    {partial && <p className="catalog-facet-partial" role="status">{partialMessage}</p>}
    <div className={`catalog-facet-grid ${isFilament ? "is-filament" : "is-printer"}`}>
      <CatalogFacetSelect id={`${selectionId}-manufacturer`} facet="manufacturer" label="Manufacturer / brand" value={facets.manufacturer ?? ""} values={valuesFor("manufacturer")} onChange={(value) => changeFacet("manufacturer", value)} />
      {isFilament ? <>
        <CatalogFacetSelect id={`${selectionId}-family`} facet="family" label="Product line / material family" value={facets.family ?? ""} values={valuesFor("family")} disabled={!facets.manufacturer} onChange={(value) => changeFacet("family", value)} />
        <CatalogFacetSelect id={`${selectionId}-subtype`} facet="subtype" label="Material subtype" value={facets.subtype ?? ""} values={valuesFor("subtype")} disabled={!facets.family} optional onChange={(value) => changeFacet("subtype", value)} />
        <CatalogFacetSelect id={`${selectionId}-colour`} facet="colour" label="Colour" value={facets.colour ?? ""} values={valuesFor("colour")} disabled={!facets.family} onChange={(value) => changeFacet("colour", value)} />
        <CatalogFacetSelect id={`${selectionId}-colourCode`} facet="colourCode" label="Colour code" value={facets.colourCode ?? ""} values={valuesFor("colourCode")} disabled={!facets.colour} optional onChange={(value) => changeFacet("colourCode", value)} />
        <CatalogFacetSelect id={`${selectionId}-diameterMm`} facet="diameterMm" label="Diameter" value={facets.diameterMm ?? ""} values={valuesFor("diameterMm")} disabled={!facets.colour} onChange={(value) => changeFacet("diameterMm", value)} />
        <CatalogFacetSelect id={`${selectionId}-netMassG`} facet="netMassG" label="Net mass" value={facets.netMassG ?? ""} values={valuesFor("netMassG")} disabled={!facets.diameterMm} onChange={(value) => changeFacet("netMassG", value)} />
      </> : <>
        <CatalogFacetSelect id={`${selectionId}-model`} facet="model" label="Exact model" value={facets.model ?? ""} values={valuesFor("model")} disabled={!facets.manufacturer} onChange={(value) => changeFacet("model", value)} />
        <CatalogFacetSelect id={`${selectionId}-variant`} facet="variant" label="Variant" value={facets.variant ?? ""} values={valuesFor("variant")} disabled={!facets.model} optional onChange={(value) => changeFacet("variant", value)} />
      </>}
    </div>
    {required && <div className="catalog-exact-choices" aria-live="polite"><div className="catalog-exact-choices-heading"><strong>Exact product</strong><span>{matches.length} match{matches.length === 1 ? "" : "es"}</span></div>{matches.length ? <div className="catalog-exact-choice-list" role="listbox" aria-label={`Exact ${kind} products`}>{matches.map((product) => <button type="button" role="option" aria-selected={selected?.id === product.id} className={`catalog-exact-choice ${selected?.id === product.id ? "is-selected" : ""}`} key={product.id} onClick={() => onSelect(product)}><span className="catalog-option-copy"><strong>{catalogProductDisplayName(product)}</strong><small>{productDetailLine(product) || "Product details not recorded yet"}</small></span><Icon name={selected?.id === product.id ? "check-circle" : "chevron-right"} size={15} /></button>)}</div> : <div className="catalog-facet-empty"><p className="catalog-empty">No exact product matches these details.</p>{onAddUnlisted && <button type="button" className="button button-secondary" onClick={onAddUnlisted}><Icon name="plus" size={15} /> Add product</button>}</div>}</div>}
    {activeFacetCount > 0 && !required && <p className="field-hint">Keep choosing details to reveal exact product matches.</p>}
  </section>;
}

function ProductOption({ id, product, active, onSelect }: { id: string; product: CatalogProduct; active: boolean; onSelect: () => void }) {
  const detail = productDetailLine(product);
  return <button id={id} type="button" role="option" aria-selected={active} className={`catalog-option ${active ? "is-active" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={onSelect}>
    <span className="catalog-option-copy"><strong>{catalogProductDisplayName(product)}</strong><small>{detail || "Product details not recorded yet"}</small></span>
    <Icon name="chevron-right" size={15} />
  </button>;
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
  const listId = useId();
  const inputId = useId();
  const [state, setState] = useState<ComboboxState>({ activeIndex: 0, open: false });
  const [hasFocus, setHasFocus] = useState(false);
  const optionCount = products.length;
  const visible = state.open && hasFocus;
  const activeId = optionCount && state.activeIndex >= 0 ? `${listId}-option-${state.activeIndex}` : undefined;

  useEffect(() => {
    setState((current) => ({ ...current, activeIndex: Math.min(current.activeIndex, Math.max(products.length - 1, 0)) }));
  }, [products.length]);

  const selectProduct = (product: CatalogProduct) => {
    onSelect(product);
    onQueryChange("");
    setState({ activeIndex: products.indexOf(product), open: false });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const key = event.key as ComboboxKey;
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"].includes(key)) return;
    event.preventDefault();
    const next = reduceComboboxKey({ ...state, open: true }, key, optionCount);
    setState(next);
    if (key === "Enter" && products[next.activeIndex]) selectProduct(products[next.activeIndex]!);
  };

  const inputValue = selected ? catalogProductDisplayName(selected) : query;
  return <div className="catalog-combobox">
    <label className="form-field catalog-combobox-field" htmlFor={inputId}><span>{label}</span>
      <div className="catalog-input-shell">
        <Icon name="search" size={16} />
        <input id={inputId} role="combobox" aria-expanded={visible} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={visible ? activeId : undefined} value={inputValue} placeholder={placeholder} disabled={disabled} onFocus={() => { setHasFocus(true); setState((current) => ({ ...current, open: true })); }} onBlur={() => { window.setTimeout(() => { setHasFocus(false); setState((current) => ({ ...current, open: false })); }, 120); }} onChange={(event) => { if (selected) onSelect(undefined); onQueryChange(event.target.value); setState((current) => ({ ...current, activeIndex: 0, open: true })); }} onKeyDown={handleKeyDown} />
        {loading && <span className="catalog-loading" aria-label="Searching">…</span>}
      </div>
    </label>
    {hint && <p className="field-hint">{hint}</p>}
    {visible && <div className="catalog-listbox" id={listId} role="listbox" aria-label={`${label} results`}>
      {products.length ? products.map((product, index) => <ProductOption id={`${listId}-option-${index}`} key={product.id} product={product} active={index === state.activeIndex} onSelect={() => selectProduct(product)} />) : <p className="catalog-empty">No exact {kind} products match that search.</p>}
    </div>}
    {selected && <div className="catalog-selected" aria-live="polite"><span className="catalog-selected-label">Selected exact product</span><strong>{catalogProductDisplayName(selected)}</strong><small>{productDetailLine(selected) || "Details to confirm"}</small></div>}
  </div>;
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

  return <form className="catalog-create-form" onSubmit={(event) => { void submit(event); }}>
    <div className="catalog-create-heading"><div><span className="eyebrow">No exact match</span><h3>Add product</h3></div><span className="catalog-create-note">This adds a catalog identity first.</span></div>
    <div className="form-row catalog-create-row"><label className="form-field"><span>Manufacturer</span><input autoFocus required value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} placeholder="e.g. Bambu Lab" disabled={submitting} /></label><label className="form-field"><span>Family{kind === "filament" && " · material family"}</span><input required={kind === "filament"} value={family} onChange={(event) => setFamily(event.target.value)} placeholder="e.g. PETG HF" disabled={submitting} /></label></div>
    <div className="form-row catalog-create-row"><label className="form-field"><span>Model{kind === "printer" && " · exact model"}</span><input required={kind === "printer"} value={model} onChange={(event) => setModel(event.target.value)} placeholder={kind === "filament" ? "Product name (optional)" : "Exact model"} disabled={submitting} /></label><label className="form-field"><span>Variant <small>(optional)</small></span><input value={variant} onChange={(event) => setVariant(event.target.value)} placeholder={kind === "filament" ? "Material subtype" : "Bundle / revision"} disabled={submitting} /></label></div>
    {kind === "filament" && <div className="catalog-filament-fields"><label className="form-field"><span>Colour</span><input required value={colour} onChange={(event) => setColour(event.target.value)} placeholder="e.g. Black" disabled={submitting} /></label><label className="form-field"><span>Colour code <small>(optional)</small></span><input value={colourCode} onChange={(event) => setColourCode(event.target.value)} placeholder="#000000" disabled={submitting} /></label><label className="form-field"><span>Diameter (mm)</span><input required type="number" min="0.1" step="0.01" value={diameter} onChange={(event) => setDiameter(event.target.value)} disabled={submitting} /></label><label className="form-field"><span>Net mass (g)</span><input required type="number" min="1" step="1" value={netMass} onChange={(event) => setNetMass(event.target.value)} disabled={submitting} /></label></div>}
    {kind === "printer" && <div className="catalog-printer-volume-fields"><span className="field-group-label">Build volume (mm)</span><label className="form-field"><span>X</span><input required type="number" min="1" step="any" value={buildVolumeX} onChange={(event) => setBuildVolumeX(event.target.value)} placeholder="325" disabled={submitting} /></label><label className="form-field"><span>Y</span><input required type="number" min="1" step="any" value={buildVolumeY} onChange={(event) => setBuildVolumeY(event.target.value)} placeholder="320" disabled={submitting} /></label><label className="form-field"><span>Z</span><input required type="number" min="1" step="any" value={buildVolumeZ} onChange={(event) => setBuildVolumeZ(event.target.value)} placeholder="325" disabled={submitting} /></label></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onCancel} disabled={submitting}>Back to results</button><button type="submit" className="button button-primary" disabled={!identityReady || submitting}>{submitting ? "Adding…" : "Add product"}<Icon name="plus" size={16} /></button></div>
  </form>;
}

function ownedItemLabel(item: InventoryItem): string {
  return item.catalogProduct ? catalogProductDisplayName(item.catalogProduct) : `${item.name} · Exact product unknown`;
}

export interface BuildItemEligibility {
  eligible: boolean;
  reason?: string;
}

function hasConfirmedPhysicalEvidence(item: InventoryItem): boolean {
  if (item.serverEvidence !== undefined) return item.serverEvidence === "physically_counted" || item.serverEvidence === "commissioned";
  return item.evidence === "counted" || item.evidence === "commissioned";
}

/** Return the user-facing reason a physical item cannot be used for setup. */
export function buildItemEligibility(item: InventoryItem, category: "Printers" | "Filament"): BuildItemEligibility {
  if (item.category !== category) return { eligible: false, reason: `Choose a ${category === "Printers" ? "printer" : "filament"} inventory item.` };
  if (item.unitStatus === "needs_correction") return { eligible: false, reason: item.unitCorrectionReason ?? "Correct this item's unit before using it in a build setup." };
  if (category === "Printers") {
    return item.catalogProduct
      ? { eligible: true }
      : { eligible: false, reason: "An exact printer product link is required for setup." };
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

export interface OwnedItemComboboxProps {
  category: "Printers" | "Filament";
  items: InventoryItem[];
  value?: InventoryItem | undefined;
  onSelect: (item: InventoryItem | undefined) => void;
  label: string;
}

export function OwnedItemCombobox({ category, items, value, onSelect, label }: OwnedItemComboboxProps) {
  const inputId = useId();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const candidates = useMemo(() => items.filter((item) => item.category === category && (!query.trim() || `${item.name} ${item.variant} ${item.manufacturer ?? ""} ${item.catalogProduct ? catalogProductDisplayName(item.catalogProduct) : ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))), [category, items, query]);
  const displayValue = value ? ownedItemLabel(value) : query;
  const activeId = open && candidates.length ? `${listId}-option-${active}` : undefined;
  const choose = (item: InventoryItem) => {
    if (!buildItemEligibility(item, category).eligible) return;
    onSelect(item); setQuery(""); setOpen(false); setActive(Math.max(candidates.indexOf(item), 0));
  };
  const selectedEligibility = value ? buildItemEligibility(value, category) : undefined;
  const selectedProductLabel = value?.catalogProduct ? exactProductLabel(value) : "Exact product unknown";
  return <div className="catalog-combobox owned-combobox"><label className="form-field" htmlFor={inputId}><span>{label}</span><div className="catalog-input-shell"><Icon name="search" size={16} /><input id={inputId} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId} value={displayValue} placeholder={`Choose an owned ${category === "Printers" ? "printer" : "filament"}`} onFocus={() => setOpen(true)} onChange={(event) => { if (value) onSelect(undefined); setQuery(event.target.value); setActive(0); setOpen(true); }} onKeyDown={(event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"].includes(event.key)) return;
    event.preventDefault();
    const next = reduceComboboxKey({ activeIndex: active, open: true }, event.key as ComboboxKey, candidates.length);
    setActive(next.activeIndex); setOpen(next.open);
    if (event.key === "Enter" && candidates[next.activeIndex]) choose(candidates[next.activeIndex]!);
  }} onBlur={() => window.setTimeout(() => setOpen(false), 120)} /></div></label>{open && <div className="catalog-listbox" id={listId} role="listbox" aria-label={`${label} results`}>{candidates.length ? candidates.map((item, index) => { const eligibility = buildItemEligibility(item, category); return <button id={`${listId}-option-${index}`} type="button" role="option" aria-selected={index === active} aria-disabled={!eligibility.eligible} disabled={!eligibility.eligible} className={`catalog-option ${index === active ? "is-active" : ""} ${eligibility.eligible ? "" : "is-ineligible"}`} key={item.id} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)}><span className="catalog-option-copy"><strong>{ownedItemLabel(item)}</strong><small>{item.quantity.toLocaleString()} {item.unit} · {item.catalogProduct ? exactProductLabel(item) : "Exact product unknown"}{eligibility.eligible ? " · Eligible" : ` · Not eligible: ${eligibility.reason}`}</small></span><Icon name={eligibility.eligible ? "chevron-right" : "warning"} size={15} /></button>; }) : <p className="catalog-empty">No owned {category === "Printers" ? "printers" : "filament"} match that search.</p>}</div>}{value && <div className="catalog-selected"><span className="catalog-selected-label">Owned item</span><strong>{ownedItemLabel(value)}</strong><small>{selectedProductLabel}</small>{selectedEligibility && !selectedEligibility.eligible && <p className="catalog-selection-error" role="alert">Not eligible: {selectedEligibility.reason}</p>}</div>}</div>;
}

export interface SetupSummaryProps {
  input: BuildConfigInput;
  printer?: InventoryItem | undefined;
  filament?: InventoryItem | undefined;
  expert: boolean;
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

export function BuildSetupSummary({ input, printer, filament, expert }: SetupSummaryProps) {
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
  return <section className="setup-summary" aria-label="Build setup summary"><div className="setup-summary-heading"><span className="eyebrow">Setup summary</span>{expert && <span className="expert-badge">Expert details</span>}</div><p>{buildSetupSummary(input, printer, filament)}</p>{unknownFilament && <div className="setup-blockers" role="status"><strong>Exact product unknown</strong><span>Design open</span><p>Blocker: confirm the physical filament identity before production approval.</p></div>}{expert && <details className="expert-detail setup-expert-detail"><summary>Show IDs, versions, evidence &amp; unknowns</summary><div className="detail-grid"><div><span>Revision ID</span><code>{persisted.projectRevisionId ?? "Not recorded"}</code></div><div><span>Printer ID</span><code>{printerId ?? "Not selected"}</code></div><div><span>Filament ID</span><code>{filamentId ?? "Not selected"}</code></div><div><span>Printer product</span><code>{printerProductId ?? "Exact product not confirmed"}</code></div><div><span>Filament product</span><code>{filamentProductId ?? "Exact product unknown"}</code></div><div><span>Versions</span><code>{versions || "Not recorded"}</code></div><div><span>Evidence</span><code>{evidence}</code></div><div><span>Content hash</span><code>{[persisted.contentSha256, persisted.contentHash, printer?.catalogProduct?.contentHash, filament?.catalogProduct?.contentHash].filter(Boolean).join(" · ") || "Not recorded"}</code></div><div><span>Unknowns</span><code>{input.unknowns.join(" · ") || "None recorded"}</code></div></div></details>}</section>;
}

export interface CatalogInventoryFlowProps {
  category: "Printers" | "Filament";
  products: CatalogProduct[];
  query: string;
  onQueryChange: (query: string) => void;
  onSearch: (kind: CatalogKind, query: string, options?: { limit?: number }) => Promise<CatalogProduct[]>;
  onSearchPage?: (kind: CatalogKind, query: string, options?: CatalogSearchOptions) => Promise<CatalogProductPage>;
  onCreateProduct: (input: CatalogProductDraft) => Promise<CatalogProduct | undefined>;
  onCreate: (input: ExactInventoryInput) => Promise<boolean>;
  onBack: () => void;
}

export function CatalogInventoryFlow({ category, products, query, onQueryChange, onSearch, onSearchPage, onCreateProduct, onCreate, onBack }: CatalogInventoryFlowProps) {
  const kind: CatalogKind = category === "Filament" ? "filament" : "printer";
  const [selected, setSelected] = useState<CatalogProduct>();
  const [completeProducts, setCompleteProducts] = useState<CatalogProduct[]>(products);
  const [completeProductsLoaded, setCompleteProductsLoaded] = useState(false);
  const [completeProductsPartial, setCompleteProductsPartial] = useState(false);
  const [completeProductsPartialReason, setCompleteProductsPartialReason] = useState<CatalogFacetPartialReason>();
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [quantity, setQuantity] = useState(category === "Filament" ? "" : "1");
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

  const createProduct = async (input: CatalogProductDraft) => {
    const product = await onCreateProduct(input);
    if (product) { setSelected(product); setShowCreate(false); onQueryChange(""); }
    return product;
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
      if (!created) setFormError("The exact inventory record was not saved. Check the service connection and try again.");
    } catch (caught: unknown) {
      setFormError(caught instanceof Error ? caught.message : "The exact inventory record was not saved.");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmation = linkState === "confirmed" ? "I checked the physical item against this exact product." : "Reported for now — confirm the exact product after checking the item.";
  const facetProducts = completeProductsLoaded || completeProducts.length === 0 ? completeProducts : products;
  const noSearchResults = !selected && query.trim() && !loading && products.length === 0 && !showCreate;
  return <div className="catalog-inventory-flow"><button type="button" className="text-button catalog-back" onClick={onBack}><Icon name="arrow-left" size={15} /> Choose another category</button><CatalogFacetPicker kind={kind} products={facetProducts.length ? facetProducts : products} selected={selected} partial={completeProductsPartial} partialCount={completeProducts.length} partialReason={completeProductsPartialReason} onSelect={setSelected} onAddUnlisted={() => setShowCreate(true)} /><div className="catalog-search-divider"><span>or search by name / code</span></div><CatalogCombobox kind={kind} products={products} query={query} selected={selected} onQueryChange={onQueryChange} onSelect={setSelected} label={`Exact ${category === "Filament" ? "filament product" : "printer model"}`} loading={loading} hint="Search the local catalog. A catalog match does not indicate ownership, available stock, or compatibility." />{noSearchResults && <div className="catalog-no-results"><p>No exact product found. Add the manufacturer and required product facts so future builds can refer to the same identity.</p><button type="button" className="button button-secondary" onClick={() => setShowCreate(true)}><Icon name="plus" size={15} /> Add product</button></div>}{showCreate && <CatalogProductCreateForm kind={kind} onCreate={createProduct} onCancel={() => setShowCreate(false)} />}{selected && <form className="exact-inventory-form" onSubmit={(event) => { void submit(event); }}><div className="exact-product-card"><span className="eyebrow">Exact product selected</span><strong>{catalogProductDisplayName(selected)}</strong><small>{productDetailLine(selected) || "Product details not recorded yet"}</small></div><div className="form-row"><label className="form-field"><span>{category === "Filament" ? "Current mass (g)" : "Owned units"}</span><input type="number" min="0.01" step="any" required value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={submitting} /></label><label className="form-field"><span>Link state</span><select value={linkState} onChange={(event) => setLinkState(event.target.value as LinkState)} disabled={submitting}><option value="reported">Reported (check later)</option><option value="confirmed">Confirmed exact product</option></select></label></div>{category === "Filament" ? <div className="physical-profile-grid"><label className="form-field"><span>Lot / batch <small>(optional)</small></span><input value={lotBatch} onChange={(event) => setLotBatch(event.target.value)} placeholder="Printed spool lot" disabled={submitting} /></label><label className="form-field"><span>Spool state</span><select value={spoolState} onChange={(event) => setSpoolState(event.target.value as "sealed" | "opened")} disabled={submitting}><option value="sealed">Sealed</option><option value="opened">Opened</option></select></label>{spoolState === "opened" && <label className="form-field"><span>Opened date</span><input type="date" value={openedAt} onChange={(event) => setOpenedAt(event.target.value)} disabled={submitting} /></label>}<label className="form-field"><span>Tare mass (g) <small>(optional)</small></span><input type="number" min="0" step="any" value={tareMass} onChange={(event) => setTareMass(event.target.value)} placeholder="Empty spool weight" disabled={submitting} /></label><label className="form-field"><span>Current placement <small>(optional)</small></span><input value={placement} onChange={(event) => setPlacement(event.target.value)} placeholder="Shelf / AMS slot" disabled={submitting} /></label></div> : <div className="physical-profile-grid"><label className="form-field"><span>Asset label <small>(optional)</small></span><input value={assetLabel} onChange={(event) => setAssetLabel(event.target.value)} placeholder="e.g. PRINT-01" disabled={submitting} /></label><label className="form-field"><span>Commissioned date <small>(optional)</small></span><input type="date" value={commissionedAt} onChange={(event) => setCommissionedAt(event.target.value)} disabled={submitting} /></label><label className="form-field"><span>Current placement <small>(optional)</small></span><input value={placement} onChange={(event) => setPlacement(event.target.value)} placeholder="Print room" disabled={submitting} /></label></div>}<p className={`link-state-note ${linkState === "confirmed" ? "is-confirmed" : ""}`}><Icon name={linkState === "confirmed" ? "check-circle" : "info"} size={15} />{confirmation}</p>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => setSelected(undefined)} disabled={submitting}>Change product</button><button type="submit" className="button button-primary" disabled={submitting}>{submitting ? "Saving…" : `Add ${category === "Filament" ? "filament spool" : "printer"}`}<Icon name="plus" size={16} /></button></div></form>}</div>;
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
