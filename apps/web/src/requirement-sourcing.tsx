import { Badge } from "./components/ui/badge";
import { Alert } from "./components/ui/alert";
import { Card } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { Checkbox } from "./components/ui/checkbox";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { Input } from "./components/ui/input";
import { useUnsavedWork } from "./unsaved-work";
import { useCallback, useEffect, useRef, useState } from "react";
import { requirementOfferSchema, offerChoiceSchema } from "@benchledger/api-contract";
import type { BomLine, RequirementOffer, OfferChoice, RequirementOfferEstimate } from "@benchledger/api-contract";
import type { Project } from "./domain";
import { useWorkflowRead, useWorkflowCommand, mutationValue, quotedMoney, quotedMinor, revisionWorkflowPath } from "./workflow-ui";
interface SourcingRow { line: BomLine; decision: string; missingQuantity: number; offers: RequirementOffer[]; choice: OfferChoice | null; estimate: RequirementOfferEstimate }
interface SourcingPage { data: SourcingRow[]; total: number; revisionTotal?: number; nextCursor?: string; totals: Record<string, { knownMinor: number; shippingComplete: boolean; taxesComplete: boolean }>; notice: string }
export function RequirementSourcing({ project, readOnly = false, onPlan }: { project: Project; readOnly?: boolean; onPlan?: (() => void) | undefined }) {
  const [filter, setFilter] = useState<"source" | "review" | "all" | "optional">("source");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string>(), [previous, setPrevious] = useState<(string | undefined)[]>([]), [draftFor, setDraftFor] = useState<string>();
  const root = project.serverRevisionId ? revisionWorkflowPath(project.id, project.serverRevisionId) : undefined;
  const parameters = new URLSearchParams({ limit: "20", filter, ...(query.trim() ? { query: query.trim() } : {}), ...(cursor ? { cursor } : {}) });
  const source = useWorkflowRead<SourcingPage>(root ? `${root}/sourcing?${parameters}` : undefined, JSON.stringify(project.bom.map((line) => [line.id, line.version])));
  const [saved, setSaved] = useState(false);
  const quoteTriggers = useRef(new Map<string, HTMLButtonElement>());
  const sourcingRegion = useRef<HTMLElement>(null);
  const pendingFocus = useRef<{ lineId: string; awaitingRefresh: boolean } | undefined>(undefined);
  const closeQuote = (lineId: string, wasSaved: boolean) => {
    pendingFocus.current = { lineId, awaitingRefresh: wasSaved };
    setDraftFor(undefined);
    if (wasSaved) { setSaved(true); source.reload(); }
  };
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || draftFor !== undefined) return;
    if (source.loading) { pending.awaitingRefresh = false; return; }
    if (pending.awaitingRefresh) return;
    const trigger = quoteTriggers.current.get(pending.lineId);
    if (trigger && !trigger.disabled) trigger.focus();
    else sourcingRegion.current?.focus();
    pendingFocus.current = undefined;
  }, [draftFor, source.loading, source.error]);
  const [pendingSelections, setPendingSelections] = useState<Set<string>>(() => new Set());
  const selectionState = useCallback((id: string, pending: boolean) => setPendingSelections((current) => {
    if (current.has(id) === pending) return current;
    const next = new Set(current); if (pending) next.add(id); else next.delete(id); return next;
  }), []);
  const selectionBlocked = pendingSelections.size > 0;

  if (!root) return <p>Supplier quotes require a connected project revision.</p>;
  const visibleRows = source.data?.data ?? [];
  const refreshBlocked = draftFor !== undefined || source.loading || selectionBlocked;
  const canWrite = !readOnly && project.status !== "archived" && !source.loading && !source.error;
  return <Card asChild><section className="surface requirement-sourcing" aria-label="Requirement sourcing" ref={sourcingRegion} tabIndex={-1}>
    <div className="workflow-section-heading"><div><span className="eyebrow">Shopping list</span><h2>Supplier quotes for this project</h2></div>{onPlan && <Button variant="ghost" type="button" className="button button-quiet" onClick={onPlan}>Back to plan</Button>}</div>
    <p>Record quotes for missing stock. Check each quote before selection. No purchase is made.</p>
    <div className="sourcing-view-controls"><div role="group" aria-label="Sourcing view">{([["source", "Needs sourcing"], ["review", "Needs review"], ["optional", "Optional"], ["all", "All requirements"]] as const).map(([value, label]) => <Button variant="ghost" key={value} type="button" aria-pressed={filter === value} disabled={draftFor !== undefined || selectionBlocked} onClick={() => { setFilter(value); setCursor(undefined); setPrevious([]); }}>{label}</Button>)}</div><Label className="field-search"><Input aria-label="Search quote requirements" placeholder="Find a requirement or supplier" value={query} disabled={draftFor !== undefined || selectionBlocked} onChange={(event) => { setQuery(event.target.value.slice(0, 200)); setCursor(undefined); setPrevious([]); }} /></Label></div>
    <p className="form-hint">Search covers all requirements in this revision. Cost totals do not change with the filter.</p>
    {saved && <p role="status" className="form-success">Quote saved.{source.error ? " The list could not refresh. Retry the read, not the save." : ""}</p>}
    {source.loading && <p role="status">Loading requirement quotes…</p>}{source.error && <Alert asChild><p role="alert">{source.error}{source.data ? " Previous records remain visible. Refresh before making another change." : ""}</p></Alert>}
    {source.data && <><div className="sourcing-totals">{Object.entries(source.data.totals).length ? Object.entries(source.data.totals).map(([currency, total]) => <p key={currency}><strong>{quotedMoney(total.knownMinor, currency)}</strong> · {total.shippingComplete ? "recorded shipping included" : "shipping incomplete"} · {total.taxesComplete ? "tax included" : "tax not fully confirmed"}</p>) : <p>No current quotes selected for the estimate.</p>}</div>
      <p className="sourcing-results-count" role="status">{source.data.total} matching {source.data.total === 1 ? "requirement" : "requirements"} · {source.data.revisionTotal ?? source.data.total} in the full revision</p>
      {!visibleRows.length && !source.loading && !source.error && <div className="sourcing-empty"><strong>{filter === "source" ? "No source gaps match this view" : "No requirements match this view"}</strong><p>Change the filter or search to review other requirements.</p><Button variant="outline" type="button" className="button button-secondary" onClick={() => { setFilter("all"); setQuery(""); setCursor(undefined); setPrevious([]); }}>Show all quote requirements</Button></div>}
      <div className="sourcing-register">{visibleRows.map((row) => <article className={`sourcing-requirement ${row.offers.length ? "has-quotes" : "no-quotes"}`} aria-label={`Quotes for ${row.line.name}`} key={row.line.id}>
        <div className="sourcing-row-summary"><div><h3>{row.line.name}</h3><p>{row.line.requiredQuantity} {row.line.unit} required · {row.missingQuantity} unfilled · {row.offers.length} {row.offers.length === 1 ? "quote" : "quotes"}</p></div><Badge variant="outline" className={`status-pill tone-${row.line.optional ? "neutral" : row.decision === "ready" ? "good" : row.decision === "source" ? "bad" : row.decision === "check" ? "warn" : "info"}`}>{row.line.optional ? "Optional" : row.decision === "source" ? "Source" : row.decision === "check" ? "Check" : row.decision === "ready" ? "Ready" : "Decide"}</Badge>
          {!readOnly && project.status !== "archived" && <Button variant="outline" type="button" className="button button-secondary" ref={(node) => { if (node) quoteTriggers.current.set(row.line.id, node); else quoteTriggers.current.delete(row.line.id); }} disabled={!canWrite || draftFor !== undefined || selectionBlocked} onClick={() => { setSaved(false); setDraftFor(row.line.id); }} aria-label={`Record quote for ${row.line.name}`}>Record quote</Button>}
        </div>
        {row.estimate.status === "estimated" ? <p className="estimate-summary">{row.estimate.packages} packs supply {row.estimate.partsSupplied} {row.line.unit} · {quotedMoney(row.estimate.totalMinor!, row.estimate.currency!)} known cost</p> : row.offers.length > 0 && !row.offers.some((offer) => offer.id === row.choice?.offerId) && <p className="form-hint">{row.estimate.reason}</p>}
        {draftFor === row.line.id && <QuoteForm line={row.line} root={root} onSaved={() => closeQuote(row.line.id, true)} onCancel={() => closeQuote(row.line.id, false)} />}
        {row.offers.map((offer) => <QuoteCard key={offer.id} offer={offer} row={row} root={root} readOnly={!canWrite || draftFor !== undefined || selectionBlocked && !pendingSelections.has(offer.id)} onPending={selectionState} onSaved={source.reload} onRecord={() => { setSaved(false); setDraftFor(row.line.id); }} />)}
      </article>)}</div>
      <div className="workflow-pagination"><Button variant="ghost" type="button" className="button button-quiet" disabled={!previous.length || refreshBlocked} onClick={() => { setCursor(previous.at(-1)); setPrevious((all) => all.slice(0, -1)); }}>Previous requirements</Button><span>{visibleRows.length} shown · {source.data.total} matches</span><Button variant="ghost" type="button" className="button button-quiet" disabled={!source.data.nextCursor || refreshBlocked} onClick={() => { setPrevious((all) => [...all, cursor]); setCursor(source.data!.nextCursor); }}>Next requirements</Button></div>
    </>}
    <Button variant="ghost" type="button" className="text-button" disabled={refreshBlocked} onClick={source.reload}>Refresh supplier quotes</Button>
  </section></Card>;
}
function QuoteCard({ offer, row, root, readOnly, onSaved, onPending, onRecord }: { offer: RequirementOffer; row: SourcingRow; root: string; readOnly: boolean; onSaved(): void; onPending(id: string, pending: boolean): void; onRecord(): void }) {
  const [confirmed, setConfirmed] = useState(false); const command = useWorkflowCommand();
  useUnsavedWork(command.uncertain, "quote selection", command.busy || command.uncertain);
  useEffect(() => { onPending(offer.id, command.busy || command.uncertain); return () => onPending(offer.id, false); }, [offer.id, command.busy, command.uncertain, onPending]);
  const selected = row.choice?.offerId === offer.id, current = selected && row.choice?.bomLineVersion === row.line.version;
  const includedInEstimate = current && row.estimate.status === "estimated";
  const sourceGap = row.decision === "source" && !row.line.optional && row.missingQuantity > 0;
  const needsNewObservation = selected && !includedInEstimate && sourceGap;
  const choose = async () => { try { await command.execute(`${root}/offer-choice`, "PUT", { bomLineId: row.line.id, offerId: selected && current ? null : offer.id, expectedVersion: row.choice?.version ?? 0, expectedBomLineVersion: row.line.version, confirmedFit: confirmed }, (value) => offerChoiceSchema.parse(mutationValue(value, ["id", "version"]))); onSaved(); } catch { /* state retained for explicit retry */ } };
  return <div className={`quote-card ${selected ? "is-selected" : ""}`}><strong>{offer.supplier}: {offer.title}</strong><p>{quotedMoney(offer.priceMinor, offer.currency)} per pack of {offer.packageQuantity} {offer.packageUnit} · shipping {offer.shippingMinor === undefined ? "not recorded" : quotedMoney(offer.shippingMinor, offer.currency)} · tax {offer.taxIncluded}</p><p>Observed {offer.observedAt.slice(0,10)} · review after {offer.validForDays} days</p>{offer.notes && <p>{offer.notes}</p>}<a href={offer.url} target="_blank" rel="noreferrer noopener">Open recorded supplier source</a>
    {selected && <div className="quote-selection-status"><p><strong>{includedInEstimate ? "Selected for estimate" : sourceGap ? "Selected quote needs review" : "Selected quote, not included in estimate"}</strong></p>{!includedInEstimate && <p>{row.estimate.reason ?? "The requirement changed. Review the selected quote again."}</p>}{needsNewObservation && !readOnly && <><p className="form-hint">Review this quote against the requirement. Record a replacement if its date, price or package details need correcting.</p><Button variant="outline" type="button" className="button button-secondary" disabled={command.busy || command.uncertain} onClick={onRecord}>Record replacement quote</Button></>}</div>}
    {!readOnly && <div className="quote-review-actions">{(!selected || !current) && <Label className="check-field"><Checkbox  checked={confirmed} disabled={command.busy || command.uncertain} onCheckedChange={(checked) => setConfirmed(checked === true)} /><span>I checked that this quoted item meets the current requirement</span></Label>}<Button variant="ghost" type="button" className="button button-quiet" disabled={command.busy || (!current && !confirmed)} onClick={() => { void choose(); }}>{command.busy ? "Saving…" : command.uncertain ? "Retry unchanged selection" : current ? "Clear quote selection" : "Use reviewed quote"}</Button></div>}
    {command.error && <Alert asChild><p role="alert" className="form-error">{command.error}</p></Alert>}
  </div>;
}
export function QuoteForm({ line, root, onSaved, onCancel }: { line: BomLine; root: string; onSaved(): void; onCancel(): void }) {
  const [supplier, setSupplier] = useState(""), [title, setTitle] = useState(line.name), [url, setUrl] = useState("");
  const [quantity, setQuantity] = useState("1"), [unit, setUnit] = useState(line.unit), [price, setPrice] = useState(""), [currency, setCurrency] = useState("EUR"), [shipping, setShipping] = useState("");
  const [initialObservedAt] = useState(() => new Date().toISOString().slice(0,10));
  const [tax, setTax] = useState("unknown"), [observedAt, setObservedAt] = useState(initialObservedAt), [notes, setNotes] = useState("");
  const [error, setError] = useState<string>(); const command = useWorkflowCommand();
  useUnsavedWork(Boolean(supplier || url || price || shipping || notes || title !== line.name || quantity !== "1" || unit !== line.unit || tax !== "unknown" || currency !== "EUR" || observedAt !== initialObservedAt), "supplier quote", command.busy || command.uncertain);
  const save = async () => { setError(undefined); try { const body = { bomLineId: line.id, expectedBomLineVersion: line.version, supplier, title, url, packageQuantity: Number(quantity), packageUnit: unit, priceMinor: quotedMinor(price, currency), currency, ...(shipping.trim() ? { shippingMinor: quotedMinor(shipping, currency) } : {}), taxIncluded: tax, observedAt: `${observedAt}T00:00:00.000Z`, validForDays: 30, ...(notes.trim() ? { notes } : {}) }; await command.execute(`${root}/requirement-offers`, "POST", body, (value) => requirementOfferSchema.parse(mutationValue(value, ["id", "version"]))); onSaved(); } catch (failure) { if (!command.error) setError(failure instanceof Error ? failure.message : "The quote was not saved."); } };
  return <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><h4>Record supplier quote</h4><fieldset disabled={command.busy || command.uncertain} className="correction-fields">
    <Label className="form-field"><span>Supplier</span><Input autoFocus required maxLength={240} value={supplier} onChange={(event) => setSupplier(event.target.value)} /></Label><Label className="form-field"><span>Quoted item</span><Input required maxLength={240} value={title} onChange={(event) => setTitle(event.target.value)} /></Label><Label className="form-field"><span>Supplier source URL</span><Input required type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://supplier.example/item" /></Label>
    <div className="form-row"><Label className="form-field"><span>Quantity per pack</span><Input required type="number" min="0.000001" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Label><Label className="form-field"><span>Pack unit</span><NativeSelect aria-label="Quoted pack unit" value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}>{["each", "gram", "metre", "millimetre", "millilitre", "set"].map((value) => <NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect></Label></div>
    <div className="form-row"><Label className="form-field"><span>Pack price</span><Input required inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="12.50" /></Label><Label className="form-field"><span>Currency</span><NativeSelect aria-label="Quoted currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>{["EUR", "GBP", "USD", "AUD", "CAD", "CHF", "DKK", "SEK", "NOK", "JPY"].map((value) => <NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect></Label></div>
    <Label className="form-field"><span>Shipping for this quote, blank if unknown</span><Input inputMode="decimal" value={shipping} onChange={(event) => setShipping(event.target.value)} placeholder="Unknown" /></Label><Label className="form-field"><span>Tax included</span><NativeSelect aria-label="Quoted tax included" value={tax} onChange={(event) => setTax(event.target.value)}><NativeSelectOption value="unknown">Not confirmed</NativeSelectOption><NativeSelectOption value="yes">Yes</NativeSelectOption><NativeSelectOption value="no">No</NativeSelectOption></NativeSelect></Label><Label className="form-field"><span>Observation date</span><Input required type="date" value={observedAt} onChange={(event) => setObservedAt(event.target.value)} /></Label><Label className="form-field"><span>Quote notes</span><Textarea maxLength={2000} rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></Label>
  </fieldset>{(error || command.error) && <Alert asChild><p role="alert" className="form-error">{command.error ?? error}</p></Alert>}<div className="dialog-actions"><Button variant="ghost" type="button" className="button button-quiet" disabled={command.busy || command.uncertain} onClick={onCancel}>Cancel quote</Button><Button variant="default" type="submit" className="button button-primary" disabled={command.busy}>{command.busy ? "Saving…" : command.uncertain ? "Retry unchanged quote" : "Save supplier observation"}</Button></div></form>;
}
