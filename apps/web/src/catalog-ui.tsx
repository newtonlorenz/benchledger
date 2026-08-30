import { useEffect, useId, useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import type {
  BuildConfigInput,
  CatalogKind,
  CatalogProduct,
  InventoryItem,
  InventoryProductProfile,
  LinkState
} from "./domain";
import { buildSetupSummary, catalogProductLabel, exactProductLabel } from "./domain";
import type { CatalogProductDraft, ExactInventoryInput } from "./api";
import { Icon } from "./icons";

export type ComboboxKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "Enter" | "Escape";

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
    product.kind === "filament" && (product.colour ?? product.color),
    product.kind === "filament" && (product.colourCode ?? product.colorCode),
    product.kind === "filament" && product.diameterMm !== undefined ? `${product.diameterMm} mm` : undefined,
    product.kind === "filament" && product.netMassG !== undefined ? `${product.netMassG.toLocaleString()} g net` : undefined,
    product.productCode
  ].filter((value): value is string => Boolean(value));
  return details.concat(product.sku && !product.productCode ? [product.sku] : []).join(" · ");
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
  return item.catalogProduct ? catalogProductDisplayName(item.catalogProduct) : `${item.name} · ${exactProductLabel(item)}`;
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
  const choose = (item: InventoryItem) => { onSelect(item); setQuery(""); setOpen(false); setActive(Math.max(candidates.indexOf(item), 0)); };
  return <div className="catalog-combobox owned-combobox"><label className="form-field" htmlFor={inputId}><span>{label}</span><div className="catalog-input-shell"><Icon name="search" size={16} /><input id={inputId} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId} value={displayValue} placeholder={`Choose an owned ${category === "Printers" ? "printer" : "filament"}`} onFocus={() => setOpen(true)} onChange={(event) => { if (value) onSelect(undefined); setQuery(event.target.value); setActive(0); setOpen(true); }} onKeyDown={(event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"].includes(event.key)) return;
    event.preventDefault();
    const next = reduceComboboxKey({ activeIndex: active, open: true }, event.key as ComboboxKey, candidates.length);
    setActive(next.activeIndex); setOpen(next.open);
    if (event.key === "Enter" && candidates[next.activeIndex]) choose(candidates[next.activeIndex]!);
  }} onBlur={() => window.setTimeout(() => setOpen(false), 120)} /></div></label>{open && <div className="catalog-listbox" id={listId} role="listbox" aria-label={`${label} results`}>{candidates.length ? candidates.map((item, index) => <button id={`${listId}-option-${index}`} type="button" role="option" aria-selected={index === active} className={`catalog-option ${index === active ? "is-active" : ""}`} key={item.id} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)}><span className="catalog-option-copy"><strong>{ownedItemLabel(item)}</strong><small>{item.quantity.toLocaleString()} {item.unit} · {exactProductLabel(item)}</small></span><Icon name="chevron-right" size={15} /></button>) : <p className="catalog-empty">No owned {category === "Printers" ? "printers" : "filament"} match that search.</p>}</div>}{value && <div className="catalog-selected"><span className="catalog-selected-label">Owned item</span><strong>{ownedItemLabel(value)}</strong><small>{exactProductLabel(value)}</small></div>}</div>;
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
    filament?.productProfile?.linkState ?? setupSnapshotField(filamentSnapshot, "linkState") ?? "not linked"
  ].join(" · ");
  return <section className="setup-summary" aria-label="Build setup summary"><div className="setup-summary-heading"><span className="eyebrow">Setup summary</span>{expert && <span className="expert-badge">Expert details</span>}</div><p>{buildSetupSummary(input, printer, filament)}</p>{expert && <details className="expert-detail setup-expert-detail"><summary>Show IDs, versions, evidence &amp; unknowns</summary><div className="detail-grid"><div><span>Revision ID</span><code>{persisted.projectRevisionId ?? "Not recorded"}</code></div><div><span>Printer ID</span><code>{printerId ?? "Not selected"}</code></div><div><span>Filament ID</span><code>{filamentId ?? "Not selected"}</code></div><div><span>Printer product</span><code>{printerProductId ?? "Exact product not confirmed"}</code></div><div><span>Filament product</span><code>{filamentProductId ?? "Exact product not confirmed"}</code></div><div><span>Versions</span><code>{versions || "Not recorded"}</code></div><div><span>Evidence</span><code>{evidence}</code></div><div><span>Content hash</span><code>{[persisted.contentSha256, persisted.contentHash, printer?.catalogProduct?.contentHash, filament?.catalogProduct?.contentHash].filter(Boolean).join(" · ") || "Not recorded"}</code></div><div><span>Unknowns</span><code>{input.unknowns.join(" · ") || "None recorded"}</code></div></div></details>}</section>;
}

export interface CatalogInventoryFlowProps {
  category: "Printers" | "Filament";
  products: CatalogProduct[];
  query: string;
  onQueryChange: (query: string) => void;
  onSearch: (kind: CatalogKind, query: string) => Promise<CatalogProduct[]>;
  onCreateProduct: (input: CatalogProductDraft) => Promise<CatalogProduct | undefined>;
  onCreate: (input: ExactInventoryInput) => Promise<boolean>;
  onBack: () => void;
}

export function CatalogInventoryFlow({ category, products, query, onQueryChange, onSearch, onCreateProduct, onCreate, onBack }: CatalogInventoryFlowProps) {
  const kind: CatalogKind = category === "Filament" ? "filament" : "printer";
  const [selected, setSelected] = useState<CatalogProduct>();
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
    void onSearch(kind, query).then((results) => {
      if (!active) return;
      // Keep the parent-owned list in sync through the callback contract; the
      // value is intentionally unused here when the parent already caches it.
      void results;
    }).catch(() => undefined).finally(() => { if (active) setLoading(false); });
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
  return <div className="catalog-inventory-flow"><button type="button" className="text-button catalog-back" onClick={onBack}><Icon name="arrow-left" size={15} /> Choose another category</button><CatalogCombobox kind={kind} products={products} query={query} selected={selected} onQueryChange={onQueryChange} onSelect={setSelected} label={`Exact ${category === "Filament" ? "filament product" : "printer model"}`} loading={loading} hint="Search the local catalog by manufacturer, family, model, colour, code, or variant." />{!selected && query.trim() && !loading && products.length === 0 && !showCreate && <div className="catalog-no-results"><p>No exact product found. Add the manufacturer and required product facts so future builds can refer to the same identity.</p><button type="button" className="button button-secondary" onClick={() => setShowCreate(true)}><Icon name="plus" size={15} /> Add product</button></div>}{showCreate && <CatalogProductCreateForm kind={kind} onCreate={createProduct} onCancel={() => setShowCreate(false)} />}{selected && <form className="exact-inventory-form" onSubmit={(event) => { void submit(event); }}><div className="exact-product-card"><span className="eyebrow">Exact product selected</span><strong>{catalogProductDisplayName(selected)}</strong><small>{productDetailLine(selected) || "Product details not recorded yet"}</small></div><div className="form-row"><label className="form-field"><span>{category === "Filament" ? "Current mass (g)" : "Owned units"}</span><input type="number" min="0.01" step="any" required value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={submitting} /></label><label className="form-field"><span>Link state</span><select value={linkState} onChange={(event) => setLinkState(event.target.value as LinkState)} disabled={submitting}><option value="reported">Reported (check later)</option><option value="confirmed">Confirmed exact product</option></select></label></div>{category === "Filament" ? <div className="physical-profile-grid"><label className="form-field"><span>Lot / batch <small>(optional)</small></span><input value={lotBatch} onChange={(event) => setLotBatch(event.target.value)} placeholder="Printed spool lot" disabled={submitting} /></label><label className="form-field"><span>Spool state</span><select value={spoolState} onChange={(event) => setSpoolState(event.target.value as "sealed" | "opened")} disabled={submitting}><option value="sealed">Sealed</option><option value="opened">Opened</option></select></label>{spoolState === "opened" && <label className="form-field"><span>Opened date</span><input type="date" value={openedAt} onChange={(event) => setOpenedAt(event.target.value)} disabled={submitting} /></label>}<label className="form-field"><span>Tare mass (g) <small>(optional)</small></span><input type="number" min="0" step="any" value={tareMass} onChange={(event) => setTareMass(event.target.value)} placeholder="Empty spool weight" disabled={submitting} /></label><label className="form-field"><span>Current placement <small>(optional)</small></span><input value={placement} onChange={(event) => setPlacement(event.target.value)} placeholder="Shelf / AMS slot" disabled={submitting} /></label></div> : <div className="physical-profile-grid"><label className="form-field"><span>Asset label <small>(optional)</small></span><input value={assetLabel} onChange={(event) => setAssetLabel(event.target.value)} placeholder="e.g. PRINT-01" disabled={submitting} /></label><label className="form-field"><span>Commissioned date <small>(optional)</small></span><input type="date" value={commissionedAt} onChange={(event) => setCommissionedAt(event.target.value)} disabled={submitting} /></label><label className="form-field"><span>Current placement <small>(optional)</small></span><input value={placement} onChange={(event) => setPlacement(event.target.value)} placeholder="Print room" disabled={submitting} /></label></div>}<p className={`link-state-note ${linkState === "confirmed" ? "is-confirmed" : ""}`}><Icon name={linkState === "confirmed" ? "check-circle" : "info"} size={15} />{confirmation}</p>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => setSelected(undefined)} disabled={submitting}>Change product</button><button type="submit" className="button button-primary" disabled={submitting}>{submitting ? "Saving…" : `Add ${category === "Filament" ? "filament spool" : "printer"}`}<Icon name="plus" size={16} /></button></div></form>}</div>;
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
