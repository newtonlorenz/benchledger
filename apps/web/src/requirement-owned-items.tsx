import { useEffect, useState } from "react";
import type { InventoryPage } from "./api";
import type { InventoryItem, QuantityDisplayUnit } from "./domain";
import { inventoryCandidateText, inventoryDiscriminator } from "./inventory-identity";
import { requirementCandidateStock } from "./requirement-journey";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";
import "./requirement-journey.css";
const inventoryUnitLabels: Record<QuantityDisplayUnit, string> = { each: "pieces", g: "grams", m: "metres", set: "sets", millimetre: "millimetres", millilitre: "millilitres" };
export type OwnedItemSearch = (query: string, signal: AbortSignal) => Promise<InventoryPage>;
export function RequirementOwnedItems({ items, requirementName, selectedId, onSelect, unit, onUnitChange, queryOverride, onQueryChange, disabled = false, focusSearch = false, onSearch }: {
  items: InventoryItem[]; requirementName: string; selectedId: string; onSelect(id: string): void;
  unit: QuantityDisplayUnit; onUnitChange(unit: QuantityDisplayUnit): void;
  queryOverride: string | undefined; onQueryChange(query: string | undefined): void; disabled?: boolean; focusSearch?: boolean; onSearch?: OwnedItemSearch | undefined;
}) {
  const query = (queryOverride ?? requirementName).trim().slice(0, 200);
  const searchEnabled = Boolean(query || queryOverride !== undefined || focusSearch);
  const [result, setResult] = useState<{ query: string; page: InventoryPage }>();
  const [loading, setLoading] = useState(false), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  const [retainedSelection, setRetainedSelection] = useState<InventoryItem>();
  useEffect(() => {
    if (!onSearch || !searchEnabled) { setLoading(false); setError(false); return; }
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError(false);
    const timer = window.setTimeout(() => {
      void onSearch(query, controller.signal).then((page) => {
        if (active) setResult({ query, page });
      }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [query, onSearch, searchEnabled, retry]);
  const page = result?.query === query ? result.page : undefined;
  const eligible = (item: InventoryItem) => item.category !== "Printers" && !item.tags.some((tag) => tag.toLowerCase() === "retired");
  const loadedMatches = items.filter((item) => eligible(item) && (!query || [item.name, item.variant, item.location, item.manufacturer, item.sku, inventoryDiscriminator(item)].filter(Boolean).join(" ").toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const matches = page ? page.items.filter(eligible) : loadedMatches;
  const selectedItem = page?.items.find((item) => item.id === selectedId) ?? items.find((item) => item.id === selectedId) ?? (retainedSelection?.id === selectedId ? retainedSelection : undefined);
  useEffect(() => { if (selectedItem) setRetainedSelection(selectedItem); }, [selectedItem]);
  const limit = page ? 25 : 5;
  const shownMatches = matches.slice(0, limit);
  const candidates = selectedItem && !shownMatches.some((item) => item.id === selectedId) ? [selectedItem, ...shownMatches] : shownMatches;
  const identities = [...new Map([...items, ...(page?.items ?? []), ...(selectedItem ? [selectedItem] : [])].map((item) => [item.id, item])).values()];
  const choose = (item: InventoryItem) => { setRetainedSelection(item); onSelect(item.id); };
  return <section className="requirement-owned-options" aria-label="Review owned items">
        <h3>Already in your workshop?</h3>
        <p className="form-hint">Choose an item only if it meets your requirement. Stock will be checked after saving.</p>
        <Disclosure defaultOpen={focusSearch}><DisclosureTrigger>Find a different owned item</DisclosureTrigger><DisclosureContent><Label className="form-field"><span>Search matching inventory</span><Input autoFocus={focusSearch} value={queryOverride ?? requirementName} onChange={(event) => onQueryChange(event.target.value)} placeholder="Name, colour, location or SKU" disabled={disabled} /></Label>{queryOverride !== undefined && <Button variant="ghost" type="button" onClick={() => onQueryChange(undefined)} disabled={disabled}>Search using requirement name</Button>}</DisclosureContent></Disclosure>
        {searchEnabled && <>
          <div className="requirement-candidates">{candidates.map((item) => <Button key={item.id} variant="outline" type="button" className="requirement-candidate" data-item-id={item.id} aria-pressed={selectedId === item.id} aria-label={`Choose owned item ${inventoryCandidateText(item, identities)}`} disabled={disabled} onClick={() => choose(item)}><span><strong>{inventoryCandidateText(item, identities)}</strong><small>{inventoryDiscriminator(item)}</small><small>{requirementCandidateStock(item)}</small></span><span aria-hidden="true">{selectedId === item.id ? "Selected" : "Choose"}</span></Button>)}</div>
          {loading && <p role="status">Searching your inventory… Loaded suggestions remain available.</p>}
          {error && <div role="alert"><p>Inventory search could not complete. Previous suggestions remain available.</p><Button type="button" variant="outline" disabled={disabled || loading} onClick={() => setRetry((value) => value + 1)}>Retry inventory search</Button></div>}
          {!loading && !error && page && <p className="form-hint" role="status">{shownMatches.length} selectable {shownMatches.length === 1 ? "item" : "items"} shown from {page.total === undefined ? `${page.items.length} returned inventory matches` : `${page.total} inventory matches`}.{page.nextCursor ? " Refine the search to find other matches; up to 25 are returned." : ""}{page.items.some((item) => !eligible(item)) ? " Printers and retired items are excluded from these choices." : ""}{!matches.length ? " Try a different search or continue without choosing stock." : ""}</p>}
          {!page && <p className="form-hint">{loadedMatches.length ? `${Math.min(loadedMatches.length, 5)} of ${loadedMatches.length} matching loaded items shown.` : "No matches in the loaded inventory."}{onSearch ? " Search checks the full inventory." : " Try a different search, or continue without choosing stock."}</p>}

        </>}
        {selectedId && !selectedItem && <p role="status">Previously selected item is outside the loaded inventory. It will be kept unless you choose another item or clear the selection.</p>}
        {selectedId && !selectedItem && <Button variant="ghost" type="button" disabled={disabled} onClick={() => onSelect("")}>Clear owned item selection</Button>}
        {selectedItem && <div className="requirement-selection" role="status"><p>Selected: <strong>{inventoryCandidateText(selectedItem, identities)}</strong>. Selection is a planning choice, not confirmation of fit or usable stock.</p>{selectedItem.unit !== unit && <><p>Stock is recorded in {inventoryUnitLabels[selectedItem.unit]}; your requirement uses {inventoryUnitLabels[unit]}. No conversion is inferred.</p><Button variant="outline" type="button" disabled={disabled || selectedItem.unitStatus === "needs_correction"} onClick={() => onUnitChange(selectedItem.unit)}>Use {inventoryUnitLabels[selectedItem.unit]} for this requirement</Button><p className="form-hint">Changing the unit keeps the entered number. Review the quantity before saving.</p></>}<Button variant="ghost" type="button" disabled={disabled} onClick={() => onSelect("")}>Clear owned item selection</Button></div>}
      </section>;
}
