import { useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Icon } from "./icons";

/**
 * The reconciliation screen deliberately owns a small UI-facing contract.
 * Adapters can map the API contract into this shape without making the
 * beginner-facing component depend on a transport or storage package.
 */
export type ReconciliationOutcomeKind =
  | "consumed"
  | "returned"
  | "damaged_lost"
  | "usable_leftover"
  | "converted_asset"
  | "reviewed_no_change";

export type ReconciliationEvidenceState =
  | "physically_counted"
  | "commissioned"
  | "delivered_uncounted"
  | "ordered_unverified"
  | "allocated"
  | "consumed"
  | "unknown";

export type ReconciliationItemKind =
  | "printer"
  | "tool"
  | "accessory"
  | "consumable"
  | "electronic"
  | "fastener"
  | "filament"
  | "wire"
  | "adhesive"
  | "other"
  | (string & {});

export type ReconciliationQuantityUnit = string;
export type ReconciliationReservationStatus = "active" | "released" | "consumed" | "settled";
export type ReconciliationStockChangeKind = "consume" | "loss" | "release";

export interface ReconciliationEvidenceViewModel {
  state?: ReconciliationEvidenceState;
  source?: string;
  sourceId?: string;
  observedAt?: string;
  note?: string;
  condition?: "new" | "good" | "worn" | "needs_repair" | "unknown";
  uncertainty?: number | undefined;
}

export interface ReconciliationConvertedAssetViewModel {
  name?: string;
  kind?: ReconciliationItemKind;
  quantity?: number | undefined;
  unit?: ReconciliationQuantityUnit;
  location?: string;
}

export interface ReconciliationOutcomeViewModel {
  id: string;
  reservationId?: string;
  itemId?: string;
  kind?: ReconciliationOutcomeKind;
  quantity: number;
  unit: ReconciliationQuantityUnit;
  evidence: ReconciliationEvidenceViewModel;
  convertedAsset?: ReconciliationConvertedAssetViewModel;
}

export interface ReconciliationReservationViewModel {
  id: string;
  itemId: string;
  quantity: number;
  unit: ReconciliationQuantityUnit;
  status?: ReconciliationReservationStatus;
  version?: number;
  itemLabel?: string;
}

export interface ReconciliationLineViewModel {
  id: string;
  bomLineId: string;
  name: string;
  itemLabel: string;
  itemKind?: ReconciliationItemKind;
  plannedQuantity: number;
  /** Unit declared by the BOM/revision. It can differ from the held stock
   * unit when the server has recorded a package conversion. */
  plannedUnit: ReconciliationQuantityUnit;
  reservedQuantity: number;
  /** Reservation/outcome unit. Unlike plannedUnit, this follows active held
   * stock and is the unit used by reconciliation arithmetic and writes. */
  unit: ReconciliationQuantityUnit;
  reservations?: readonly ReconciliationReservationViewModel[];
  version?: number;
  outcomes: readonly ReconciliationOutcomeViewModel[];
}

export interface ReconciliationPreviewLineViewModel {
  bomLineId: string;
  reservedQuantity: number;
  accountedQuantity: number;
  unaccountedQuantity: number;
  outcomeCount: number;
  unit?: ReconciliationQuantityUnit;
}

export interface ReconciliationPreviewReservationChangeViewModel {
  reservationId: string;
  fromStatus: ReconciliationReservationStatus;
  toStatus: ReconciliationReservationStatus;
  quantity: number;
  unit: ReconciliationQuantityUnit;
}

export interface ReconciliationPreviewStockChangeViewModel {
  itemId: string;
  itemLabel?: string;
  kind: ReconciliationStockChangeKind;
  quantity: number;
  unit: ReconciliationQuantityUnit;
  beforeOnHand?: number;
  afterOnHand?: number;
  beforeAllocated?: number;
  afterAllocated?: number;
  beforeAvailable?: number;
  afterAvailable?: number;
  eventKey: string;
}

export interface ReconciliationPreviewAssetViewModel {
  itemId: string;
  name: string;
  kind: ReconciliationItemKind;
  quantity: number;
  unit: ReconciliationQuantityUnit;
}

export interface ReconciliationPreviewViewModel {
  lines: readonly ReconciliationPreviewLineViewModel[];
  reservationChanges: readonly ReconciliationPreviewReservationChangeViewModel[];
  stockChanges: readonly ReconciliationPreviewStockChangeViewModel[];
  createdAssets: readonly ReconciliationPreviewAssetViewModel[];
  basisHash?: string;
  generatedAt?: string;
}

export interface ReconciliationTraceViewModel {
  draftId?: string;
  draftVersion?: number;
  basisHash?: string;
  deterministicEventIds?: readonly string[];
  auditId?: string;
  replayed?: boolean;
}

export interface ReconciliationViewModel {
  projectId: string;
  projectName: string;
  projectRevisionId: string;
  status: "draft" | "committed";
  version?: number;
  lines: readonly ReconciliationLineViewModel[];
  preview?: ReconciliationPreviewViewModel;
  trace?: ReconciliationTraceViewModel;
  committedAt?: string;
  error?: string;
}

export interface ReconciliationLineSummary {
  accountedQuantity: number;
  unaccountedQuantity: number;
  overageQuantity: number;
  complete: boolean;
  invalidOutcome: boolean;
}

const EPSILON = 0.000001;

const outcomeOptions: readonly { kind: ReconciliationOutcomeKind; label: string; description: string }[] = [
  { kind: "consumed", label: "Used in the build", description: "Installed, printed, or used up." },
  { kind: "returned", label: "Returned intact", description: "Still usable and back in the workshop." },
  { kind: "damaged_lost", label: "Damaged or lost", description: "No longer available for this project." },
  { kind: "usable_leftover", label: "Usable leftover", description: "Remaining material or parts you can use later." },
  { kind: "converted_asset", label: "Made a reusable asset", description: "Turned into a new tracked workshop item." },
  { kind: "reviewed_no_change", label: "Reviewed — no change", description: "Use only when this line has zero active reservations and needs no stock change." }
];

const evidenceOptions: readonly { value: ReconciliationEvidenceState; label: string }[] = [
  { value: "physically_counted", label: "Physically counted" },
  { value: "commissioned", label: "Commissioned" },
  { value: "delivered_uncounted", label: "Delivered, not counted" },
  { value: "allocated", label: "Allocated to this project" },
  { value: "consumed", label: "Recorded as consumed" },
  { value: "unknown", label: "Unknown / needs checking" }
];

const assetKinds: readonly { value: ReconciliationItemKind; label: string }[] = [
  { value: "printer", label: "Printer" },
  { value: "tool", label: "Tool" },
  { value: "accessory", label: "Accessory" },
  { value: "consumable", label: "Consumable" },
  { value: "electronic", label: "Electronic part" },
  { value: "fastener", label: "Fastener" },
  { value: "filament", label: "Filament" },
  { value: "wire", label: "Wire" },
  { value: "other", label: "Other" }
];

export function outcomeLabel(kind: ReconciliationOutcomeKind): string {
  return outcomeOptions.find((option) => option.kind === kind)?.label ?? kind;
}

export function evidenceLabel(state: ReconciliationEvidenceState): string {
  return evidenceOptions.find((option) => option.value === state)?.label ?? state;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isValidOutcome(outcome: ReconciliationOutcomeViewModel): boolean {
  if (!outcome.kind || !isFiniteNonNegative(outcome.quantity)) return false;
  if (outcome.kind === "reviewed_no_change") {
    return outcome.quantity <= EPSILON
      && outcome.reservationId === undefined
      && outcome.itemId === undefined
      && outcome.convertedAsset === undefined
      && Boolean(outcome.evidence.state);
  }
  if (outcome.quantity <= EPSILON) return false;
  if (!outcome.evidence.state) return false;
  if (outcome.kind !== "converted_asset") return true;
  const asset = outcome.convertedAsset;
  return Boolean(asset?.name?.trim() && asset.kind && asset.quantity !== undefined && asset.quantity > EPSILON && asset.unit?.trim());
}

function activeReservations(line: ReconciliationLineViewModel): readonly ReconciliationReservationViewModel[] {
  return (line.reservations ?? []).filter((reservation) => reservation.status === undefined || reservation.status === "active");
}

export function summarizeReconciliationLine(line: ReconciliationLineViewModel): ReconciliationLineSummary {
  const active = activeReservations(line);
  const hasReservationDetails = line.reservations !== undefined;
  const assigned = new Map<string, number>();
  const accountedQuantity = line.outcomes.reduce((total, outcome) => {
    if (outcome.kind === "reviewed_no_change") return total;
    const quantity = isFiniteNonNegative(outcome.quantity) ? outcome.quantity : 0;
    if (outcome.reservationId !== undefined) assigned.set(outcome.reservationId, (assigned.get(outcome.reservationId) ?? 0) + quantity);
    return total + quantity;
  }, 0);
  const aggregateUnaccounted = Math.max(line.reservedQuantity - accountedQuantity, 0);
  const aggregateOverage = Math.max(accountedQuantity - line.reservedQuantity, 0);
  const reservationUnaccounted = hasReservationDetails
    ? active.reduce((total, reservation) => Math.max(reservation.quantity - (assigned.get(reservation.id) ?? 0), 0) + total, 0)
    : aggregateUnaccounted;
  const reservationOverage = hasReservationDetails
    ? active.reduce((total, reservation) => Math.max((assigned.get(reservation.id) ?? 0) - reservation.quantity, 0) + total, 0)
    : aggregateOverage;
  const unknownReservationQuantity = hasReservationDetails
    ? line.outcomes.reduce((total, outcome) => outcome.kind !== "reviewed_no_change" && outcome.reservationId !== undefined && !active.some((reservation) => reservation.id === outcome.reservationId) ? total + (isFiniteNonNegative(outcome.quantity) ? outcome.quantity : 0) : total, 0)
    : 0;
  const reviewedNoChange = line.outcomes.filter((outcome) => outcome.kind === "reviewed_no_change");
  const hasDisposition = line.outcomes.some((outcome) => outcome.kind !== "reviewed_no_change");
  const invalidReservationAssignment = hasReservationDetails && line.outcomes.some((outcome) => outcome.kind !== "reviewed_no_change" && (outcome.reservationId === undefined || !active.some((reservation) => reservation.id === outcome.reservationId)));
  const invalidNoChange = reviewedNoChange.length > 0 && (active.length > 0 || line.reservedQuantity > EPSILON || hasDisposition || reviewedNoChange.length !== 1);
  const invalidOutcome = line.outcomes.length === 0 || line.outcomes.some((outcome) => !isValidOutcome(outcome)) || invalidReservationAssignment || invalidNoChange;
  const unaccountedQuantity = reservationUnaccounted;
  const overageQuantity = reservationOverage + unknownReservationQuantity;
  return {
    accountedQuantity,
    unaccountedQuantity,
    overageQuantity,
    invalidOutcome,
    complete: !invalidOutcome && unaccountedQuantity <= EPSILON && overageQuantity <= EPSILON
  };
}

export function reconciliationCanCommit(model: ReconciliationViewModel): boolean {
  if (model.status !== "draft" || !model.preview) return false;
  if (model.preview.basisHash && model.trace?.basisHash && model.preview.basisHash !== model.trace.basisHash) return false;
  return model.lines.length > 0 && model.lines.every((line) => summarizeReconciliationLine(line).complete);
}

function nextOutcomeId(lineId: string, counter: { current: number }): string {
  counter.current += 1;
  return `${lineId}-outcome-${counter.current}`;
}

function clearPreview(model: ReconciliationViewModel, lines: readonly ReconciliationLineViewModel[]): ReconciliationViewModel {
  const { preview: _preview, error: _error, ...withoutTransientState } = model;
  return { ...withoutTransientState, lines };
}

function formatQuantity(value: number, unit: string): string {
  return `${Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${unit}`;
}

function formatDate(value?: string): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function outcomeTone(summary: ReconciliationLineSummary): string {
  if (summary.overageQuantity > EPSILON) return "reconciliation-tone-bad";
  if (summary.invalidOutcome || summary.unaccountedQuantity > EPSILON) return "reconciliation-tone-warn";
  return "reconciliation-tone-good";
}

function outcomeSummary(summary: ReconciliationLineSummary, unit: string): string {
  if (summary.overageQuantity > EPSILON) return `${formatQuantity(summary.overageQuantity, unit)} too much assigned`;
  if (summary.unaccountedQuantity > EPSILON) return `${formatQuantity(summary.unaccountedQuantity, unit)} still to account for`;
  if (summary.invalidOutcome) return "Choose an outcome and add its evidence";
  return "Fully accounted";
}

export interface ReconciliationUIProps {
  model: ReconciliationViewModel;
  expert?: boolean;
  onExpertChange?: (expert: boolean) => void;
  /** Optional controlled confirmation state, useful to host the dialog in a router or test harness. */
  confirmationOpen?: boolean;
  onConfirmationChange?: (open: boolean) => void;
  onChange: (next: ReconciliationViewModel) => void;
  onRequestPreview: (model: ReconciliationViewModel) => void | Promise<void>;
  onConfirmCommit: (model: ReconciliationViewModel) => void | Promise<void>;
}

/**
 * Controlled close-out experience. It intentionally never talks to the API:
 * preview and commit remain explicit adapter callbacks so REST and MCP can
 * share the same review model.
 */
export function ReconciliationUI({ model, expert = false, onExpertChange, confirmationOpen: confirmationOpenProp, onConfirmationChange, onChange, onRequestPreview, onConfirmCommit }: ReconciliationUIProps) {
  const headingId = useId();
  const lineHeadingId = useId();
  const outcomeIdPrefix = useId();
  const outcomeCounter = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewPending, setPreviewPending] = useState(false);
  const [localConfirmationOpen, setLocalConfirmationOpen] = useState(false);
  const [commitPending, setCommitPending] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const safeIndex = model.lines.length ? Math.min(activeIndex, model.lines.length - 1) : 0;
  const activeLine = model.lines[safeIndex];
  const activeSummary = activeLine ? summarizeReconciliationLine(activeLine) : undefined;
  const allLinesComplete = model.lines.length > 0 && model.lines.every((line) => summarizeReconciliationLine(line).complete);
  const previewCurrent = Boolean(model.preview && (!model.preview.basisHash || !model.trace?.basisHash || model.preview.basisHash === model.trace.basisHash));
  const canCommit = reconciliationCanCommit(model) && previewCurrent && !commitPending;
  const confirmationOpen = confirmationOpenProp ?? localConfirmationOpen;

  const setConfirmationOpen = (open: boolean) => {
    if (confirmationOpenProp === undefined) setLocalConfirmationOpen(open);
    onConfirmationChange?.(open);
  };

  const changeLines = (lines: readonly ReconciliationLineViewModel[]) => {
    setLocalError(undefined);
    onChange(clearPreview(model, lines));
  };

  const updateLine = (lineId: string, update: (line: ReconciliationLineViewModel) => ReconciliationLineViewModel) => {
    changeLines(model.lines.map((line) => line.id === lineId ? update(line) : line));
  };

  const addOutcome = () => {
    if (!activeLine) return;
    const reservations = activeReservations(activeLine);
    const reservation = reservations.length === 1 ? reservations[0] : undefined;
    const outcome: ReconciliationOutcomeViewModel = {
      id: `${outcomeIdPrefix}-${nextOutcomeId(activeLine.id, outcomeCounter)}`,
      ...(reservation ? { reservationId: reservation.id, itemId: reservation.itemId } : {}),
      quantity: 0,
      unit: reservation?.unit ?? activeLine.unit,
      evidence: {}
    };
    updateLine(activeLine.id, (line) => ({ ...line, outcomes: [...line.outcomes, outcome] }));
  };

  const updateOutcome = (outcomeId: string, update: (outcome: ReconciliationOutcomeViewModel) => ReconciliationOutcomeViewModel) => {
    if (!activeLine) return;
    updateLine(activeLine.id, (line) => ({
      ...line,
      outcomes: line.outcomes.map((outcome) => outcome.id === outcomeId ? update(outcome) : outcome)
    }));
  };

  const removeOutcome = (outcomeId: string) => {
    if (!activeLine) return;
    updateLine(activeLine.id, (line) => ({ ...line, outcomes: line.outcomes.filter((outcome) => outcome.id !== outcomeId) }));
  };

  const requestPreview = async () => {
    if (!allLinesComplete || previewPending || model.status !== "draft") return;
    setPreviewPending(true);
    setLocalError(undefined);
    try {
      await onRequestPreview(model);
    } catch (caught: unknown) {
      setLocalError(caught instanceof Error ? caught.message : "The server preview could not be generated.");
    } finally {
      setPreviewPending(false);
    }
  };

  const commit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCommit || commitPending) return;
    setCommitPending(true);
    setLocalError(undefined);
    try {
      await onConfirmCommit(model);
      setConfirmationOpen(false);
    } catch (caught: unknown) {
      setLocalError(caught instanceof Error ? caught.message : "The close-out could not be committed.");
    } finally {
      setCommitPending(false);
    }
  };

  return <section className="reconciliation-shell" aria-labelledby={headingId}>
    <header className="reconciliation-header">
      <div>
        <span className="eyebrow">Project close-out</span>
        <h1 id={headingId}>Reconcile {model.projectName}</h1>
        <p>Review what happened to each reserved requirement. Nothing changes in inventory until you approve the final close-out.</p>
      </div>
      <div className="reconciliation-header-actions">
        <span className={`reconciliation-status ${model.status === "committed" ? "is-committed" : ""}`}><span className="reconciliation-status-dot" />{model.status === "committed" ? "Committed" : "Draft review"}</span>
        {onExpertChange && <button type="button" className={`mode-toggle reconciliation-mode-toggle ${expert ? "is-expert" : ""}`} aria-pressed={expert} onClick={() => onExpertChange(!expert)}><span className="mode-dot" />{expert ? "Expert details" : "Beginner view"}</button>}
      </div>
    </header>

    {model.status === "committed" && <div className="reconciliation-committed" role="status"><Icon name="check-circle" size={19} /><div><strong>Project close-out committed</strong><span>{model.committedAt ? `Committed ${formatDate(model.committedAt)}.` : "The final inventory changes are recorded."}</span></div>{model.trace?.replayed && <span className="reconciliation-replay-pill">Retry replayed safely</span>}</div>}

    {localError && <p className="reconciliation-error" role="alert"><Icon name="warning" size={16} />{localError}</p>}
    {model.error && <p className="reconciliation-error" role="alert"><Icon name="warning" size={16} />{model.error}</p>}

    <div className="reconciliation-progress" aria-label="Reconciliation progress">
      <div className="reconciliation-progress-copy"><span className="eyebrow">Requirement review</span><strong>{activeLine ? `Line ${safeIndex + 1} of ${model.lines.length}` : "No reserved lines"}</strong><span>{allLinesComplete ? "Every line is accounted for" : "One line at a time"}</span></div>
      <div className="reconciliation-progress-track" aria-hidden="true"><span style={{ width: model.lines.length ? `${((model.lines.filter((line) => summarizeReconciliationLine(line).complete).length / model.lines.length) * 100).toFixed(2)}%` : "0%" }} /></div>
      <span className="reconciliation-progress-count">{model.lines.filter((line) => summarizeReconciliationLine(line).complete).length}/{model.lines.length} complete</span>
    </div>

    {activeLine && activeSummary ? <>
      <div className="reconciliation-line-nav">
        <button type="button" className="button button-quiet" onClick={() => setActiveIndex((current) => Math.max(current - 1, 0))} disabled={safeIndex === 0}><Icon name="arrow-left" size={16} />Previous</button>
        <div className="reconciliation-line-dots" aria-label="Choose requirement line">
          {model.lines.map((line, index) => {
            const summary = summarizeReconciliationLine(line);
            return <button type="button" key={line.id} className={`reconciliation-line-dot ${index === safeIndex ? "is-current" : ""} ${summary.complete ? "is-complete" : ""}`} aria-label={`Review ${line.name}, line ${index + 1}${summary.complete ? ", complete" : ""}`} aria-current={index === safeIndex ? "step" : undefined} onClick={() => setActiveIndex(index)}><span>{summary.complete ? <Icon name="check" size={13} /> : index + 1}</span></button>;
          })}
        </div>
        <button type="button" className="button button-quiet" onClick={() => setActiveIndex((current) => Math.min(current + 1, model.lines.length - 1))} disabled={safeIndex === model.lines.length - 1}>Next<Icon name="arrow-right" size={16} /></button>
      </div>

      <article className="reconciliation-line" aria-labelledby={lineHeadingId}>
        <div className="reconciliation-line-heading">
          <div><span className="eyebrow">Requirement {safeIndex + 1}</span><h2 id={lineHeadingId}>{activeLine.name}</h2><p>{activeLine.itemLabel}{activeLine.itemKind ? ` · ${activeLine.itemKind}` : ""}</p></div>
          <span className={`reconciliation-line-state ${outcomeTone(activeSummary)}`}>{outcomeSummary(activeSummary, activeLine.unit)}</span>
        </div>

        <div className="reconciliation-quantity-strip" aria-label={`${activeLine.name} quantities`}>
          <div><span>Planned</span><strong>{formatQuantity(activeLine.plannedQuantity, activeLine.plannedUnit)}</strong><small>From this revision</small></div>
          <div><span>Reserved</span><strong>{formatQuantity(activeLine.reservedQuantity, activeLine.unit)}</strong><small>{activeLine.reservations?.length ? `${activeLine.reservations.length} reservation${activeLine.reservations.length === 1 ? "" : "s"}` : "Held for this build"}</small></div>
          <div className={activeSummary.unaccountedQuantity > EPSILON ? "is-pending" : "is-ready"}><span>Unaccounted</span><strong>{formatQuantity(activeSummary.unaccountedQuantity, activeLine.unit)}</strong><small>{activeSummary.overageQuantity > EPSILON ? "Over the reservation" : activeSummary.unaccountedQuantity > EPSILON ? "Allocate an outcome" : "Ready for preview"}</small></div>
        </div>

        {expert && <details className="reconciliation-expert" open><summary><span>Expert trace for this line</span><Icon name="chevron-down" size={15} /></summary><div className="reconciliation-expert-grid"><div><span>BOM line</span><code>{activeLine.bomLineId}</code></div><div><span>Line version</span><code>{activeLine.version ?? "Not recorded"}</code></div><div><span>Reservations</span><code>{activeLine.reservations?.map((reservation) => `${reservation.id} v${reservation.version ?? "?"}`).join(" · ") || "Not recorded"}</code></div><div><span>Item IDs</span><code>{activeLine.reservations?.map((reservation) => reservation.itemId).join(" · ") || "Not recorded"}</code></div></div></details>}

        <div className="reconciliation-outcomes-heading"><div><span className="eyebrow">What happened?</span><p>Split this reservation across as many explicit outcomes as needed.</p></div><button type="button" className="button button-secondary" onClick={addOutcome} disabled={model.status !== "draft"}><Icon name="plus" size={16} />Add outcome</button></div>

        <div className="reconciliation-outcomes">
          {activeLine.outcomes.length === 0 && <div className="reconciliation-no-outcome"><Icon name="clipboard" size={21} /><div><strong>No outcome selected yet</strong><span>Choose what happened before moving to the next line. Only a line with zero active reservations can use “Reviewed — no change”. Active reservations need an explicit outcome.</span></div></div>}
          {activeLine.outcomes.map((outcome, outcomeIndex) => <OutcomeEditor key={outcome.id} outcome={outcome} index={outcomeIndex} line={activeLine} expert={expert} onChange={(update) => updateOutcome(outcome.id, update)} onRemove={() => removeOutcome(outcome.id)} />)}
        </div>

        {activeSummary.overageQuantity > EPSILON && <p className="reconciliation-inline-warning" role="alert"><Icon name="warning" size={16} />This line is over-accounted. Reduce an outcome quantity before requesting a preview.</p>}
      </article>
    </> : <div className="reconciliation-empty"><Icon name="clipboard" size={23} /><h2>Nothing reserved for close-out</h2><p>This revision has no active reservations to reconcile.</p></div>}

    <section className="reconciliation-preview" aria-labelledby={`${headingId}-preview`}>
      <div className="reconciliation-section-heading"><div><span className="eyebrow">Before anything changes</span><h2 id={`${headingId}-preview`}>Server preview</h2><p>The server calculates the exact reservation, stock, and asset changes from this review.</p></div>{allLinesComplete && model.status === "draft" && <button type="button" className="button button-secondary" onClick={() => { void requestPreview(); }} disabled={previewPending}>{previewPending ? "Preparing preview…" : model.preview ? "Refresh preview" : "Preview changes"}<Icon name="arrow-right" size={16} /></button>}</div>
      {!allLinesComplete && <div className="reconciliation-preview-empty"><Icon name="info" size={17} /><span>Finish every line, including evidence for each outcome, to request a server preview.</span></div>}
      {allLinesComplete && !model.preview && <div className="reconciliation-preview-empty"><Icon name="clock" size={17} /><span>No preview yet. Request one when the review above is complete.</span></div>}
      {model.preview && <PreviewDetails preview={model.preview} expert={expert} />}
    </section>

    <footer className="reconciliation-footer">
      <div><span className="eyebrow">Final step</span><strong>{model.status === "committed" ? "This close-out is complete" : canCommit ? "Ready to close the project" : "Review and preview before closing"}</strong><p>{model.status === "committed" ? "The committed receipt remains available in the project history." : canCommit ? "Check the server preview, then confirm the inventory changes." : "Commit stays locked until every reserved quantity is explicitly accounted for and a fresh server preview is present."}</p></div>
      <div className="reconciliation-footer-actions"><span className="reconciliation-lock-note" aria-live="polite"><Icon name={canCommit ? "check-circle" : "info"} size={15} />{canCommit ? "Preview checked" : previewCurrent && model.preview ? "Review incomplete" : "Preview required"}</span><button type="button" className="button button-primary" onClick={() => setConfirmationOpen(true)} disabled={!canCommit || model.status !== "draft"}>{model.status === "committed" ? "Committed" : "Confirm close-out"}<Icon name="arrow-right" size={16} /></button></div>
    </footer>

    {expert && <details className="reconciliation-expert reconciliation-global-expert" open><summary><span>Project-level evidence and replay</span><Icon name="chevron-down" size={15} /></summary><div className="reconciliation-expert-grid"><div><span>Project revision</span><code>{model.projectRevisionId}</code></div><div><span>Draft</span><code>{model.trace?.draftId ?? "Not recorded"} {model.trace?.draftVersion !== undefined ? `v${model.trace.draftVersion}` : ""}</code></div><div><span>Basis hash</span><code>{model.trace?.basisHash ?? "Not recorded"}</code></div><div><span>Audit ID</span><code>{model.trace?.auditId ?? "Not recorded"}</code></div><div><span>Replay state</span><code>{model.trace?.replayed === true ? "Replayed idempotently" : model.trace?.replayed === false ? "First commit" : "Not recorded"}</code></div><div><span>Deterministic event IDs</span><code>{model.trace?.deterministicEventIds?.join(" · ") || "Shown in preview"}</code></div></div></details>}

      {confirmationOpen && <div className="reconciliation-confirm-scrim" role="presentation"><form className="reconciliation-confirm" role="dialog" aria-modal="true" aria-labelledby={`${headingId}-confirm`} onSubmit={(event) => { void commit(event); }}><div className="reconciliation-confirm-icon"><Icon name="warning" size={21} /></div><span className="eyebrow">One explicit commit</span><h2 id={`${headingId}-confirm`}>Commit this close-out?</h2><p>This will settle the reviewed reservations and apply the server preview to inventory. It can’t be edited as a draft afterward.</p><div className="reconciliation-confirm-summary"><strong>{model.lines.length} requirement{model.lines.length === 1 ? "" : "s"} reviewed</strong><span>{model.preview?.stockChanges.length ?? 0} stock changes · {model.preview?.createdAssets.length ?? 0} reusable assets</span></div><div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => setConfirmationOpen(false)} disabled={commitPending}>Go back</button><button type="submit" className="button button-primary" disabled={commitPending}>{commitPending ? "Committing…" : "Yes, commit close-out"}<Icon name="check" size={16} /></button></div></form></div>}
  </section>;
}

interface OutcomeEditorProps {
  outcome: ReconciliationOutcomeViewModel;
  index: number;
  line: ReconciliationLineViewModel;
  expert: boolean;
  onChange: (update: (outcome: ReconciliationOutcomeViewModel) => ReconciliationOutcomeViewModel) => void;
  onRemove: () => void;
}

function OutcomeEditor({ outcome, index, line, expert, onChange, onRemove }: OutcomeEditorProps) {
  const outcomeLabelId = `reconciliation-outcome-${outcome.id}`;
  const evidenceLabelId = `reconciliation-evidence-${outcome.id}`;
  const valid = isValidOutcome(outcome);

  const patch = (partial: Partial<ReconciliationOutcomeViewModel>) => {
    onChange((current) => ({ ...current, ...partial }));
  };
  const patchEvidence = (partial: Partial<ReconciliationEvidenceViewModel>) => {
    onChange((current) => ({ ...current, evidence: { ...current.evidence, ...partial } }));
  };
  const patchAsset = (partial: Partial<ReconciliationConvertedAssetViewModel>) => {
    onChange((current) => ({ ...current, convertedAsset: { ...current.convertedAsset, ...partial } }));
  };
  const updateNumber = (event: ChangeEvent<HTMLInputElement>, update: (value: number) => void) => {
    const value = event.target.value;
    update(value === "" ? 0 : Number(value));
  };
  const reservations = activeReservations(line);
  const clearReservationFields = (current: ReconciliationOutcomeViewModel) => {
    const { reservationId: _reservationId, itemId: _itemId, convertedAsset: _convertedAsset, ...withoutReservation } = current;
    return withoutReservation;
  };
  const chooseKind = (kind: ReconciliationOutcomeKind | "") => {
    if (!kind) return;
    if (kind === "reviewed_no_change") {
      onChange((current) => ({ ...clearReservationFields(current), kind, quantity: 0, unit: line.unit }));
      return;
    }
    const reservation = outcome.reservationId === undefined && reservations.length === 1
      ? reservations[0]
      : reservations.find((candidate) => candidate.id === outcome.reservationId);
    onChange((current) => ({
      ...clearReservationFields(current),
      kind,
      ...(reservation ? { reservationId: reservation.id, itemId: reservation.itemId, unit: reservation.unit } : { unit: line.unit })
    }));
  };
  const chooseReservation = (reservationId: string) => {
    const reservation = reservations.find((candidate) => candidate.id === reservationId);
    if (!reservation) {
      onChange((current) => ({ ...clearReservationFields(current), unit: line.unit }));
      return;
    }
    patch({ reservationId: reservation.id, itemId: reservation.itemId, unit: reservation.unit });
  };

  return <article className={`reconciliation-outcome ${valid ? "is-valid" : "is-incomplete"}`}>
    <div className="reconciliation-outcome-top"><span className="reconciliation-outcome-number">{index + 1}</span><div className="reconciliation-outcome-title"><span className="eyebrow">Outcome {index + 1}</span><strong>{outcome.kind ? outcomeLabel(outcome.kind) : "Choose an outcome"}</strong></div><button type="button" className="icon-button reconciliation-remove" aria-label={`Remove outcome ${index + 1}`} onClick={onRemove}><Icon name="close" size={17} /></button></div>
    <div className="reconciliation-outcome-fields">
      <label className="form-field"><span id={outcomeLabelId}>Outcome</span><select aria-labelledby={outcomeLabelId} value={outcome.kind ?? ""} onChange={(event) => chooseKind(event.target.value as ReconciliationOutcomeKind | "")}><option value="" disabled>Choose what happened</option>{outcomeOptions.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}</select></label>
      <label className="form-field reconciliation-quantity-field"><span>Quantity</span><div className="reconciliation-input-with-unit"><input type="number" min="0" step="any" inputMode="decimal" value={outcome.quantity === 0 ? "" : outcome.quantity} aria-label={`Quantity for outcome ${index + 1}`} onChange={(event) => updateNumber(event, (quantity) => patch({ quantity }))} /><span>{line.unit}</span></div></label>
    </div>
    {outcome.kind !== "reviewed_no_change" && reservations.length > 0 && <label className="form-field reconciliation-reservation-field"><span>Reserved item</span><select aria-label={`Reservation for outcome ${index + 1}`} value={outcome.reservationId ?? ""} onChange={(event) => chooseReservation(event.target.value)}><option value="">Choose a reservation</option>{reservations.map((reservation) => <option key={reservation.id} value={reservation.id}>{reservation.itemLabel ?? reservation.itemId} · {formatQuantity(reservation.quantity, reservation.unit)}</option>)}</select></label>}
    {outcome.kind && <p className="reconciliation-outcome-help">{outcomeOptions.find((option) => option.kind === outcome.kind)?.description}</p>}
    <details className="reconciliation-evidence" open><summary><span id={evidenceLabelId}>Evidence for this outcome</span><span className={outcome.evidence.state ? "is-recorded" : "is-needed"}>{outcome.evidence.state ? evidenceLabel(outcome.evidence.state) : "Required"}</span></summary><div className="reconciliation-evidence-fields">
      <label className="form-field"><span>Evidence state</span><select aria-label={`Evidence state for outcome ${index + 1}`} value={outcome.evidence.state ?? ""} onChange={(event) => { const state = event.target.value as ReconciliationEvidenceState | ""; if (state) patchEvidence({ state }); }}><option value="" disabled>Choose evidence</option>{evidenceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className="form-field"><span>Source <small>(optional)</small></span><input value={outcome.evidence.source ?? ""} maxLength={500} placeholder="Physical check, build notes, or project log" onChange={(event) => patchEvidence({ source: event.target.value })} /></label>
      <label className="form-field"><span>Observed <small>(optional)</small></span><input type="datetime-local" value={outcome.evidence.observedAt ?? ""} onChange={(event) => patchEvidence({ observedAt: event.target.value })} /></label>
      <label className="form-field reconciliation-evidence-note"><span>Note <small>(optional)</small></span><textarea rows={2} maxLength={2000} value={outcome.evidence.note ?? ""} placeholder="What did you observe?" onChange={(event) => patchEvidence({ note: event.target.value })} /></label>
      {expert && <><label className="form-field"><span>Source ID <small>(optional)</small></span><input maxLength={500} value={outcome.evidence.sourceId ?? ""} placeholder="Evidence reference" onChange={(event) => patchEvidence({ sourceId: event.target.value })} /></label><label className="form-field"><span>Condition <small>(optional)</small></span><select aria-label={`Condition for outcome ${index + 1}`} value={outcome.evidence.condition ?? ""} onChange={(event) => { const condition = event.target.value as NonNullable<ReconciliationEvidenceViewModel["condition"]> | ""; if (condition) patchEvidence({ condition }); }}><option value="">Not recorded</option><option value="new">New</option><option value="good">Good</option><option value="worn">Worn</option><option value="needs_repair">Needs repair</option><option value="unknown">Unknown</option></select></label><label className="form-field"><span>Uncertainty <small>(optional)</small></span><input type="number" min="0" step="any" value={outcome.evidence.uncertainty ?? ""} onChange={(event) => patchEvidence({ uncertainty: event.target.value === "" ? undefined : Number(event.target.value) })} /></label></>}
    </div></details>
    {outcome.kind === "converted_asset" && <div className="reconciliation-asset-fields"><div className="reconciliation-asset-heading"><div><span className="eyebrow">New reusable asset</span><p>Give the new item a concise identity and positive starting quantity.</p></div><Icon name="box" size={18} /></div><div className="reconciliation-asset-grid"><label className="form-field"><span>Name</span><input required maxLength={240} value={outcome.convertedAsset?.name ?? ""} placeholder="e.g. Finished enclosure" onChange={(event) => patchAsset({ name: event.target.value })} /></label><label className="form-field"><span>Kind</span><select required aria-label="Reusable asset kind" value={outcome.convertedAsset?.kind ?? ""} onChange={(event) => { const kind = event.target.value as ReconciliationItemKind | ""; if (kind) patchAsset({ kind }); }}><option value="" disabled>Choose kind</option>{assetKinds.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select></label><label className="form-field"><span>Quantity</span><input required type="number" min="0.001" step="any" value={outcome.convertedAsset?.quantity ?? ""} onChange={(event) => patchAsset({ quantity: event.target.value === "" ? undefined : Number(event.target.value) })} /></label><label className="form-field"><span>Unit</span><input required maxLength={40} value={outcome.convertedAsset?.unit ?? line.unit} onChange={(event) => patchAsset({ unit: event.target.value })} /></label></div></div>}
  </article>;
}

function PreviewDetails({ preview, expert }: { preview: ReconciliationPreviewViewModel; expert: boolean }) {
  const stockChanges = preview.stockChanges;
  const reservationChanges = preview.reservationChanges;
  const createdAssets = preview.createdAssets;
  return <div className="reconciliation-preview-details">
    <div className="reconciliation-preview-summary"><div><strong>{stockChanges.length + reservationChanges.length + createdAssets.length}</strong><span>planned changes</span></div><div><strong>{stockChanges.length}</strong><span>stock events</span></div><div><strong>{createdAssets.length}</strong><span>new assets</span></div>{preview.generatedAt && <small>Generated {formatDate(preview.generatedAt)}</small>}</div>
    {preview.lines.length > 0 && <div className="reconciliation-preview-block"><h3>Line check</h3><div className="reconciliation-preview-lines">{preview.lines.map((line) => <div key={line.bomLineId}><span>{line.bomLineId}</span><strong>{formatQuantity(line.accountedQuantity, line.unit ?? "units")}</strong><small>{line.unaccountedQuantity > EPSILON ? `${formatQuantity(line.unaccountedQuantity, line.unit ?? "units")} unaccounted` : `${line.outcomeCount} outcome${line.outcomeCount === 1 ? "" : "s"}`}</small></div>)}</div></div>}
    {reservationChanges.length > 0 && <div className="reconciliation-preview-block"><h3>Reservation settlement</h3><ul className="reconciliation-preview-list">{reservationChanges.map((change) => <li key={`${change.reservationId}-${change.toStatus}`}><span>{change.reservationId}</span><strong>{change.fromStatus} → {change.toStatus}</strong><small>{formatQuantity(change.quantity, change.unit)}</small></li>)}</ul></div>}
    {stockChanges.length > 0 && <div className="reconciliation-preview-block"><h3>Inventory changes</h3><ul className="reconciliation-preview-list">{stockChanges.map((change) => <li key={change.eventKey}><span>{change.itemLabel ?? change.itemId}</span><strong>{change.kind === "consume" ? "Consume" : change.kind === "release" ? "Release" : "Loss"} {formatQuantity(change.quantity, change.unit)}</strong>{expert ? <code>{change.eventKey}</code> : <small>{change.afterAvailable !== undefined ? `${formatQuantity(change.afterAvailable, change.unit)} available after` : "Server-calculated event"}</small>}</li>)}</ul></div>}
    {createdAssets.length > 0 && <div className="reconciliation-preview-block"><h3>Reusable assets</h3><ul className="reconciliation-preview-list">{createdAssets.map((asset) => <li key={asset.itemId}><span>{asset.name}</span><strong>{formatQuantity(asset.quantity, asset.unit)}</strong><small>{asset.kind} · {asset.itemId}</small></li>)}</ul></div>}
    {expert && preview.basisHash && <p className="reconciliation-preview-hash"><span>Preview basis hash</span><code>{preview.basisHash}</code></p>}
  </div>;
}
