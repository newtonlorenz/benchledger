import { useState } from "react";
import { formatQuantity } from "./domain";
import type { InventoryItem } from "./domain";
import { Icon } from "./icons";
import { inventoryAiBrief, inventoryStockLabel, webInventoryAssessment, webInventoryEvidence } from "./inventory-workspace-state";

export function InventoryAiCopy({ items }: { items: readonly InventoryItem[] }) {
  const [message, setMessage] = useState("");
  const [fallback, setFallback] = useState<string>();
  const copy = async () => {
    const brief = inventoryAiBrief(items);
    try {
      await navigator.clipboard.writeText(brief);
      setMessage(`Copied ${items.length} ${items.length === 1 ? "record" : "records"}. Nothing was sent.`);
      setFallback(undefined);
    } catch { setFallback(brief); setMessage("Select and copy the brief below. Clipboard access is unavailable."); }
  };
  return <div className="inventory-ai-copy">
    <button type="button" className="button button-secondary" onClick={() => void copy()}><Icon name="copy" size={15} />Copy for AI{items.length > 1 ? ` (${items.length})` : ""}</button>
    {message && <p role="status">{message}</p>}
    {fallback !== undefined && <label>Inventory brief<textarea aria-label="Inventory brief" readOnly value={fallback} onFocus={(event) => event.currentTarget.select()} rows={8} /></label>}
  </div>;
}

export function InventoryInspector({ item, category, onOpen, onClose }: { item?: InventoryItem | undefined; category?: string | undefined; onOpen: (id: string) => void; onClose: () => void }) {
  const assessment = item ? webInventoryAssessment(item) : undefined;
  return <aside id="inventory-item-inspector" className="inventory-inspector" aria-label="Inventory inspector">
    <div className="inventory-inspector-title"><h2>Item inspector</h2><button className="icon-button" aria-label="Hide item inspector" onClick={onClose}><Icon name="close" size={16} /></button></div>
    {item && assessment ? <div key={item.id} className="inventory-inspector-body">
      <div className="inventory-inspector-identity"><span className={`stock-indicator ${assessment.check ? "is-check" : assessment.available ? "is-available" : ""}`}>{inventoryStockLabel(item)}</span><h3>{item.name}</h3><p>{[item.manufacturer, item.model ?? item.variant].filter(Boolean).join(" · ") || item.category}</p></div>
      <dl className="inventory-balances">
        <div><dt>Recorded</dt><dd>{formatQuantity(item.quantity, item.unit)}</dd></div>
        <div><dt>Available</dt><dd>{item.unitStatus === "needs_correction" ? "Fix unit" : item.availableQuantity === undefined ? "Not reported" : formatQuantity(item.availableQuantity, item.unit)}</dd></div>
        <div><dt>Reserved</dt><dd>{formatQuantity(item.reserved, item.unit)}</dd></div>
      </dl>
      <p className="inventory-stock-explanation">{assessment.unitNeedsCorrection ? item.unitCorrectionReason ?? "Correct the unit before using this quantity." : assessment.needsRepair ? "Repair is needed. This item is excluded from available stock." : !assessment.confirmed ? "The recorded quantity has not been physically confirmed. Check the item before planning its use." : assessment.available ? "Stock is available. Check identity, condition and compatibility against the project requirements." : assessment.reserved ? "The current balance is allocated. Check project reservations before planning reuse." : "No confirmed stock remains. Check project requirements before sourcing."}</p>
      <button className="button button-primary" onClick={() => onOpen(item.id)}>Edit item / record stock<Icon name="chevron-right" size={15} /></button>
      <section><h3>Identity & storage</h3><dl className="inventory-properties">
        <div><dt>Category</dt><dd>{category}</dd></div>
        <div><dt>Location</dt><dd>{item.location && item.location !== "Unassigned" ? item.location : "Not recorded"}</dd></div>
        <div><dt>Condition</dt><dd>{item.condition?.replaceAll("_", " ") ?? "Unknown"}</dd></div>
        <div><dt>SKU</dt><dd>{item.sku || "Not recorded"}</dd></div>
        <div><dt>Record ID</dt><dd className="inventory-mono">{item.id}</dd></div>
      </dl>{item.description && <p>{item.description}</p>}{item.tags.length > 0 && <div className="inventory-tags" aria-label="Item tags">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}</section>
      <section><h3>Stock evidence</h3><dl className="inventory-properties">
        <div><dt>Evidence</dt><dd>{webInventoryEvidence(item).replaceAll("_", " ")}</dd></div>
        <div><dt>Observed</dt><dd>{item.provenance?.observedAt ?? item.lastCounted ?? "Not recorded"}</dd></div>
        <div><dt>Source</dt><dd>{item.provenance?.source ?? "Not recorded"}</dd></div>
        <div><dt>Version</dt><dd>{item.version ?? "Unavailable"}</dd></div>
      </dl>{item.provenance?.note && <p>{item.provenance.note}</p>}</section>
      <section><h3>Use with an AI assistant</h3><p>Copy this record with its units, evidence and limits. Connected agents can query the same stock views through BenchLedger.</p><InventoryAiCopy items={[item]} /></section>
    </div> : <p className="inventory-inspector-empty">Choose an item in the register to inspect its stock, identity and evidence.</p>}
  </aside>;
}
