import "./specialist-journey.css";
import { useEffect, useRef, useState } from "react";
import type { Reservation } from "@benchledger/api-contract";
import type { InventoryItem, Project, BomLine } from "./domain";
import { ApiError, workflowCommandKey } from "./api";
import { readStockReservations, setAsideStock, releaseSetAsideStock } from "./stock-reservation-api";
import { useUnsavedWork } from "./unsaved-work";
import { Alert } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";
import { Input } from "./components/ui/input";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";

type Candidate = { line: BomLine; item: InventoryItem; maximum: number; coverage: number; wholeSets: boolean };
type Review = { kind: "reserve"; candidate: Candidate; quantity: number } | { kind: "release"; reservation: Reservation; name: string; unit: string };

/** UI suggestions only. The application rechecks identity, compatibility, evidence and balances atomically. */
export function reservationCandidates(project: Project, items: InventoryItem[], reservations: Reservation[]): Candidate[] {
  if (project.readinessUnavailable || !project.gapEvaluation) return [];
  const candidates: Candidate[] = [];
  for (const line of project.bom) {
    if (line.role !== "consumed") continue;
    const gap = project.gapEvaluation.lines.find((entry) => entry.lineId === line.id);
    if (!gap || gap.decision === "decide") continue;
    const active = reservations.filter((entry) => entry.lineId === line.id && entry.status === "active");
    const coverageFor = (item: InventoryItem) => {
      if (item.unit === line.unit) return 1;
      const conversions = (line.alternatives ?? []).filter((entry) => entry.itemId === item.id && entry.quantityConversion?.inventory.unit === (item.serverUnit ?? item.unit) && entry.quantityConversion.requirement.unit === (line.serverUnit ?? line.unit)).map((entry) => entry.quantityConversion!.requirement.quantity);
      return new Set(conversions).size === 1 && conversions[0]! > 0 ? conversions[0]! : undefined;
    };
    let held = 0, known = true;
    for (const reservation of active) {
      const item = items.find((entry) => entry.id === reservation.itemId);
      const coverage = item ? coverageFor(item) : undefined;
      if (!coverage) { known = false; break; }
      held += reservation.quantity * coverage;
    }
    if (!known || held >= line.required) continue;
    for (const item of items) {
      const evidence = item.serverEvidence ?? item.evidence;
      if (!["physically_counted", "commissioned"].includes(evidence) || item.unitStatus === "needs_correction" || !item.availableQuantity || item.availableQuantity <= 0) continue;
      const serverCandidate = gap.candidates?.find((entry) => entry.itemId === item.id);
      const approved = serverCandidate
        ? ["exact", "confirmed_alternative"].includes(serverCandidate.relationship) && serverCandidate.compatibility === "confirmed"
        : gap.matchedItemIds.includes(item.id) && (item.id === line.itemId || line.alternatives?.some((entry) => entry.itemId === item.id && entry.compatible === "confirmed"));
      if (!approved || active.some((entry) => items.find((stock) => stock.id === entry.itemId)?.unit !== item.unit)) continue;
      const coverage = coverageFor(item);
      if (!coverage) continue;
      const wholeSets = item.unit !== line.unit;
      const maximum = Math.min(wholeSets ? Math.floor(item.availableQuantity) : item.availableQuantity, wholeSets ? Math.ceil((line.required - held) / coverage) : line.required - held);
      if (maximum > 0) candidates.push({ line, item, maximum, coverage, wholeSets });
    }
  }
  return candidates;
}

export function StockReservationPlanning({ project, items, onRefresh, onUsedStock }: { project: Project; items: InventoryItem[]; onRefresh(): Promise<boolean>; onUsedStock?: (() => void) | undefined }) {
  const [state, setState] = useState<{ reservations: Reservation[]; closed: boolean }>();
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState<string>(), [nonce, setNonce] = useState(0);
  const [selection, setSelection] = useState(""), [quantity, setQuantity] = useState("");
  const [review, setReview] = useState<Review>(), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState<string>(), [receipt, setReceipt] = useState<string>();
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const command = useRef<{ review: Review; key: string; uncertain: boolean } | undefined>(undefined);
  const running = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const savedNotice = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  useEffect(() => { if (receipt) savedNotice.current?.focus(); }, [receipt]);
  useUnsavedWork(Boolean(review || selection || quantity), "stock set aside", busy || uncertain);
  const revisionId = project.serverRevisionId;
  useEffect(() => {
    let active = true;
    setLoading(true); setLoadError(undefined);
    if (!revisionId) { setLoading(false); return; }
    void readStockReservations(revisionId).then((value) => { if (active) setState(value); }).catch((failure: unknown) => { if (active) setLoadError(failure instanceof Error ? failure.message : "Stock set aside could not load."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revisionId, nonce]);
  const refresh = async () => {
    setRefreshNeeded(true);
    try { if (await onRefresh()) setRefreshNeeded(false); }
    catch { /* confirmed writes remain recorded; retry only the read */ }
    setNonce((value) => value + 1);
  };
  const candidates = state && !state.closed ? reservationCandidates(project, items, state.reservations) : [];
  const selected = candidates.find((candidate) => `${candidate.line.id}:${candidate.item.id}` === selection);
  const blocked = loading || Boolean(loadError) || refreshNeeded || project.status === "archived" || busy || uncertain;
  const reviewReservation = () => {
    const amount = Number(quantity);
    if (!selected || !Number.isFinite(amount) || amount <= 0 || amount > selected.maximum || selected.wholeSets && !Number.isSafeInteger(amount)) { setError("Choose confirmed stock and a quantity within the available amount."); return; }
    setError(undefined); setReview({ kind: "reserve", candidate: selected, quantity: amount });
  };
  const confirm = async () => {
    if (!revisionId || !review || running.current) return;
    running.current = true; setBusy(true); setError(undefined);
    const current = command.current ?? { review, key: workflowCommandKey("set-aside"), uncertain: false };
    command.current = current;
    try {
      const value = current.review.kind === "reserve"
        ? await setAsideStock(revisionId, { lineId: current.review.candidate.line.id, itemId: current.review.candidate.item.id, quantity: current.review.quantity }, current.key)
        : await releaseSetAsideStock(current.review.reservation, current.key);
      command.current = undefined; setUncertain(false); setReview(undefined); setSelection(""); setQuantity("");
      setState((prior) => prior ? { ...prior, reservations: [...prior.reservations.filter((entry) => entry.id !== value.id), value] } : prior);
      setReceipt(current.review.kind === "reserve" ? "Stock set aside. Record what was actually used after the build." : "Stock released. It is available for other projects; no stock was consumed.");
      await refresh();
    } catch (failure) {
      const ambiguous = current.uncertain || !(failure instanceof ApiError) || failure.kind === "server" || failure.kind === "offline";
      current.uncertain = ambiguous;
      setUncertain(ambiguous);
      if (!ambiguous) command.current = undefined;
      setError(ambiguous ? "The stock change was not confirmed. Retry the unchanged request before doing anything else." : failure instanceof Error ? failure.message : "Stock could not be set aside.");
    } finally { running.current = false; setBusy(false); }
  };
  if (!revisionId) return null;
  const active = state?.reservations.filter((entry) => entry.status === "active") ?? [];
  return <section className="surface stock-reservation-planning" aria-label="Stock for this build">
    <h2>Stock for this build</h2><p>Reserve confirmed stock for this project. The physical amount on hand stays unchanged.</p>
    {loading && <p role="status">Loading stock set aside…</p>}{loadError && <Alert asChild><p role="alert">{loadError}</p></Alert>}
    {receipt && <p role="status" tabIndex={-1} ref={savedNotice}>{receipt}</p>}{refreshNeeded && <Alert asChild><p role="alert">The workspace could not refresh. The confirmed stock change is saved. Refresh before making another change.</p></Alert>}
    {state?.closed && <p>This revision's stock review is complete. Create a new project revision before setting aside more stock.</p>}
    {review ? <section className="workflow-review" aria-label="Review stock set aside"><h3 tabIndex={-1} ref={reviewHeading}>{review.kind === "reserve" ? "Set this stock aside?" : "Release this stock?"}</h3>
      <p>{review.kind === "reserve" ? `${review.quantity} ${review.candidate.item.unit} of ${review.candidate.item.name} for ${review.candidate.line.label}.` : `${review.reservation.quantity} ${review.unit} of ${review.name} will become available to other projects.`}</p>
      {review.kind === "reserve" && <dl className="stock-review-facts"><div><dt>Stock item</dt><dd>{review.candidate.item.name}{review.candidate.item.location ? ` · ${review.candidate.item.location}` : ""}</dd></div><div><dt>Set aside</dt><dd>{review.quantity} {review.candidate.item.unit}</dd></div><div><dt>Available after</dt><dd>{Math.max(0, (review.candidate.item.availableQuantity ?? 0) - review.quantity)} {review.candidate.item.unit}</dd></div><div><dt>On hand</dt><dd>{review.candidate.item.quantity} {review.candidate.item.unit} · unchanged</dd></div></dl>}
      <p>{review.kind === "reserve" ? "The service checks current stock and requirement details before saving. Recorded stock on hand stays unchanged." : "This releases the amount set aside. It does not record use, loss or a physical return."}</p>
      <Button variant="ghost" disabled={busy || uncertain} onClick={() => { setReview(undefined); setError(undefined); }}>Back to stock selection</Button>
      <Button disabled={busy} onClick={() => { void confirm(); }}>{busy ? "Saving…" : uncertain ? "Retry unchanged stock change" : review.kind === "reserve" ? "Confirm set aside" : "Confirm release"}</Button>
    </section> : <>
      {active.length > 0 && <ul className="reserved-stock-list">{active.map((reservation) => { const item = items.find((entry) => entry.id === reservation.itemId); return <li key={reservation.id}><strong>{item?.name ?? "Stock item"}</strong> · {reservation.quantity} {item?.unit ?? "stock units"} for {project.bom.find((line) => line.id === reservation.lineId)?.label ?? "requirement"} <Button variant="ghost" disabled={blocked} onClick={() => { setError(undefined); setReview({ kind: "release", reservation, name: item?.name ?? "Stock item", unit: item?.unit ?? "stock units" }); }}>Release stock</Button></li>; })}</ul>}
      {!state?.closed && <fieldset className="correction-fields" disabled={blocked}><Label className="form-field"><span>Requirement and confirmed stock</span><NativeSelect value={selection} onChange={(event) => { setSelection(event.target.value); setQuantity(""); setError(undefined); }}><NativeSelectOption value="">Choose stock to set aside</NativeSelectOption>{candidates.map((candidate) => <NativeSelectOption key={`${candidate.line.id}:${candidate.item.id}`} value={`${candidate.line.id}:${candidate.item.id}`}>{candidate.line.label} — {candidate.item.name}</NativeSelectOption>)}</NativeSelect></Label>
        {selected && <><p>Up to {selected.maximum} {selected.item.unit} can be set aside.{selected.wholeSets ? ` Each set covers ${selected.coverage} ${selected.line.unit} of the requirement.` : ""}</p><Label className="form-field"><span>Quantity to set aside ({selected.item.unit})</span><Input type="number" min={selected.wholeSets ? 1 : 0.000001} step={selected.wholeSets ? 1 : "any"} max={selected.maximum} value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Label><Button variant="outline" type="button" onClick={reviewReservation}>Review stock to set aside</Button></>}
        {!candidates.length && !loading && !loadError && <p>No additional confirmed stock is ready to set aside. Match stock to a requirement, resolve its details and confirm the physical quantity in Parts. Reusable tools do not need consumption reservations.</p>}
      </fieldset>}
    </>}
    {error && <Alert asChild><p role="alert">{error}</p></Alert>}
    <div className="dialog-actions"><Button variant="ghost" disabled={busy || uncertain || Boolean(review)} onClick={() => { void refresh(); }}>Refresh stock for this build</Button>{onUsedStock && <Button variant="outline" disabled={busy || uncertain || Boolean(review)} onClick={onUsedStock}>Record actual stock use</Button>}</div>
  </section>;
}
