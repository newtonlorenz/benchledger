import "./inventory-experience.css";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";
import { Label } from "./components/ui/label";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { useEffect, useState } from "react";
import type { InventoryImageGallery } from "@benchledger/api-contract";
import { inventoryImageUrl, workflowRequest } from "./api";
import { formatQuantity } from "./domain";
import type { InventoryItem, Project } from "./domain";
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
    <Button variant="outline" type="button" className="button button-secondary" onClick={() => void copy()}><Icon name="copy" size={15} />Copy for AI{items.length > 1 ? ` (${items.length})` : ""}</Button>
    {message && <p role="status">{message}</p>}
    {fallback !== undefined && <Label>Inventory brief<Textarea aria-label="Inventory brief" readOnly value={fallback} onFocus={(event) => event.currentTarget.select()} rows={8} /></Label>}
  </div>;
}

/** Only recorded images are shown; missing and failed images keep a neutral placeholder. */
export function InventoryThumbnail({ item, sampleMode = true, large = false }: { item: InventoryItem; sampleMode?: boolean; large?: boolean }) {
  const [image, setImage] = useState<InventoryImageGallery["images"][number]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setImage(undefined); setFailed(false);
    if (!sampleMode) void workflowRequest<InventoryImageGallery>(`/inventory/${encodeURIComponent(item.id)}/images`)
      .then(gallery => { if (active) setImage(gallery.images.find(candidate => candidate.sourceKind === "item_photo") ?? gallery.images[0]); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [item.id, sampleMode]);
  const role = image?.sourceKind === "item_photo" ? "Item photo" : image?.sourceKind === "reference" ? "Reference image" : image?.sourceKind === "generated" ? "AI-generated image" : "Image source unknown";
  return <span className={`inventory-thumbnail${large ? " is-large" : ""}`}>
    {image && !failed ? <><img src={inventoryImageUrl(item.id, image.id)} alt="" loading="lazy" onError={() => setFailed(true)} />{large && <small>{role}</small>}</> : <><Icon name="box" size={large ? 36 : 22} />{large && <small>{failed ? "Image unavailable" : "No image"}</small>}</>}
  </span>;
}

export function InventoryProjectNeeds({ item, projects, onOpenProjectPart }: { item: InventoryItem; projects?: readonly Project[] | undefined; onOpenProjectPart?: ((projectId: string, lineId: string) => void) | undefined }) {
  const needs = projects?.filter(project => project.status !== "archived" && !project.removedAt).flatMap(project => project.bom.filter(line => line.itemId === item.id).map(line => ({ project, line }))) ?? [];
  return <section className="inventory-project-needs" aria-label="Needed by projects"><h3>Needed by projects</h3>
    {needs.length ? <ul>{needs.map(({ project, line }) => <li key={`${project.id}:${line.id}`}>
      <div><strong>{project.name} <span>· {project.currentRevision}</span></strong><span>{line.label} · Needs {formatQuantity(line.required, line.unit)}</span></div>
      {onOpenProjectPart && <Button variant="ghost" className="text-button" aria-label={`Open ${line.label} in ${project.name}`} onClick={() => onOpenProjectPart(project.id, line.id)}>Open part<Icon name="arrow-right" size={15} /></Button>}
    </li>)}</ul> : <p>{projects ? "No linked requirements in the loaded projects." : "Project requirements are not loaded here."}</p>}
    {needs.length > 0 && <p className="field-hint">Required amounts are not a record of stock used.</p>}
  </section>;
}

export function InventoryInspector({ item, category, sampleMode = true, projects, onOpenProjectPart, onOpen, onCountStock, onClose }: { item?: InventoryItem | undefined; category?: string | undefined; sampleMode?: boolean; projects?: readonly Project[] | undefined; onOpenProjectPart?: ((projectId: string, lineId: string) => void) | undefined; onOpen: (id: string) => void; onCountStock?: ((id: string) => void) | undefined; onClose: () => void }) {
  const assessment = item ? webInventoryAssessment(item) : undefined;
  const lastCount = item && webInventoryEvidence(item) === "physically_counted" ? item.provenance?.observedAt ?? item.lastCounted : undefined;
  return <aside id="inventory-item-inspector" className="inventory-inspector" aria-label="Inventory inspector">
    <div className="inventory-inspector-title"><h2>{item?.name ?? "Item details"}</h2><Button variant="ghost" className="icon-button" aria-label="Hide item inspector" onClick={onClose}><Icon name="close" size={18} /></Button></div>
    {item && assessment ? <div key={item.id} className="inventory-inspector-body">
      <p className="inventory-inspector-identity">{[item.manufacturer, item.model ?? item.variant].filter(Boolean).join(" · ") || item.category}</p>
      <div className="inventory-stock-overview">
        <InventoryThumbnail item={item} sampleMode={sampleMode} large />
        <div className="inventory-stock-summary">
          <strong className="inventory-available-summary">{assessment.check ? inventoryStockLabel(item) : item.availableQuantity === undefined ? "Availability not reported" : `${formatQuantity(item.availableQuantity, item.unit)} available`}</strong>
          <p>{assessment.confirmed ? `${formatQuantity(item.quantity, item.unit)} confirmed` : `${formatQuantity(item.quantity, item.unit)} recorded, unconfirmed`} · {formatQuantity(item.reserved, item.unit)} reserved</p>
          <dl className="inventory-stock-facts"><div><dt>Location</dt><dd>{item.location && item.location !== "Unassigned" ? item.location : "Not recorded"}</dd></div><div><dt>Last physical count</dt><dd>{lastCount ? lastCount.slice(0, 10) : "Not recorded"}</dd></div></dl>
          <Button variant="outline" onClick={() => (onCountStock ?? onOpen)(item.id)} disabled={assessment.unitNeedsCorrection}>Count stock</Button>
        </div>
      </div>
      <p className="inventory-stock-explanation">{assessment.unitNeedsCorrection ? item.unitCorrectionReason ?? "Correct the unit before using this quantity." : assessment.needsRepair ? "Repair is needed. This item is excluded from available stock." : !assessment.confirmed ? "The recorded quantity has not been physically confirmed. Check the item before planning its use." : "A physical count does not confirm compatibility. Check the exact item against the project requirements."}</p>
      <InventoryProjectNeeds item={item} projects={projects} onOpenProjectPart={onOpenProjectPart} />
      <Disclosure className="inventory-inspector-disclosure"><DisclosureTrigger>Identity & compatibility</DisclosureTrigger><DisclosureContent><dl className="inventory-properties">
        <div><dt>Category</dt><dd>{category ?? "Not recorded"}</dd></div>
        <div><dt>Recorded condition</dt><dd>{item.condition?.replaceAll("_", " ") ?? "Unknown"}</dd></div>
        <div><dt>SKU</dt><dd>{item.sku || "Not recorded"}</dd></div>
        <div><dt>Record ID</dt><dd className="inventory-mono">{item.id}</dd></div>
      </dl>{item.description && <p>{item.description}</p>}{item.compatibility.length ? <ul>{item.compatibility.map(note => <li key={note}>{note}</li>)}</ul> : <p>No compatibility evidence is recorded.</p>}{item.tags.length > 0 && <div className="inventory-tags" aria-label="Item tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}</DisclosureContent></Disclosure>
      <Disclosure className="inventory-inspector-disclosure"><DisclosureTrigger>History & evidence</DisclosureTrigger><DisclosureContent><dl className="inventory-properties">
        <div><dt>Evidence</dt><dd>{webInventoryEvidence(item).replaceAll("_", " ")}</dd></div>
        <div><dt>Observed</dt><dd>{item.provenance?.observedAt ?? item.lastCounted ?? "Not recorded"}</dd></div>
        <div><dt>Source</dt><dd>{item.provenance?.source ?? "Not recorded"}</dd></div>
        <div><dt>Version</dt><dd>{item.version ?? "Unavailable"}</dd></div>
      </dl>{item.provenance?.note && <p>{item.provenance.note}</p>}</DisclosureContent></Disclosure>
      <div className="inventory-inspector-actions"><Button variant="ghost" onClick={() => onOpen(item.id)}>Open item details<Icon name="chevron-right" size={15} /></Button></div>
      <Disclosure className="inventory-inspector-disclosure"><DisclosureTrigger>Use with an AI assistant</DisclosureTrigger><DisclosureContent><p>Copy this record with its units, evidence and limits. Connected agents can query the same stock views through BenchLedger.</p><InventoryAiCopy items={[item]} /></DisclosureContent></Disclosure>
    </div> : <p className="inventory-inspector-empty">Choose an item in the register to inspect its stock, identity and evidence.</p>}
  </aside>;
}
