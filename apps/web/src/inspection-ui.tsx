import { Card } from "./components/ui/card";
import { Alert } from "./components/ui/alert";
import { Label } from "./components/ui/label";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { WorkspaceModal } from "./components/workspace-modal";
import { DialogTitle } from "./components/ui/dialog";
import { useUnsavedWork } from "./unsaved-work";
import { ApiError } from "./api";
import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  InspectionAction as CanonicalInspectionAction,
  InspectionCompletionCommit as CanonicalInspectionCompletionCommit,
  InspectionCompletionPreview as CanonicalInspectionCompletionPreview,
  InspectionObservation as CanonicalInspectionObservation
} from "@benchledger/api-contract";
import { Icon } from "./icons";

/**
 * The inspection screen renders the canonical API contract directly. The API
 * adapter only unwraps the transport envelope, so traceability is not lost.
 */
export type InspectionAction = CanonicalInspectionAction;
export type InspectionCompletionInput = CanonicalInspectionObservation;
export type InspectionCompletionPreview = CanonicalInspectionCompletionPreview;
export type InspectionCompletionResult = CanonicalInspectionCompletionCommit;

export interface InspectionQueuePanelProps {
  actions: readonly InspectionAction[];
  expert?: boolean;
  loadError?: string | undefined;
  onViewAll?: (() => void) | undefined;
  onReadInspection?: ((action: InspectionAction) => Promise<InspectionAction>) | undefined;
  onPreviewInspection?: | ((action: InspectionAction, input: InspectionCompletionInput) => Promise<InspectionCompletionPreview>) | undefined;
  onConfirmInspection?: | ((action: InspectionAction, input: InspectionCompletionInput, preview: InspectionCompletionPreview) => Promise<InspectionCompletionResult | void>) | undefined;
}

export function formatObservedAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatPredicate(action: InspectionAction): string {
  const expectation = `${action.expected.quantity} ${action.expected.unit}`;
  const lines = action.expected.lineIds.length > 1 ? ` across ${action.expected.lineIds.length} BOM lines` : "";
  return `${action.kind.replaceAll("_", " ")} · ${expectation}${lines}`;
}

export function effectsLabel(effects: InspectionAction["effects"]): string {
  if (!effects) return "Recheck affected project requirements.";
  return effects.map((effect) => `${effect.kind.replaceAll("_", " ")}: ${effect.description}`).join(" · ");
}

export function previewDescription(preview: InspectionCompletionPreview): string {
  const changed = preview.affectedLines.length;
  return changed ? `${changed} requirement${changed === 1 ? "" : "s"} will be checked again after confirmation.` : "No project requirements are affected.";
}

export function gapQuantities(gap: InspectionCompletionPreview["before"]["gaps"][number] | undefined): string {
  if (gap === undefined) return "not evaluated";
  return `${gap.suppliedQuantity} supplied · ${gap.inspectQuantity} inspect · ${gap.missingQuantity} missing ${gap.unit}`;
}

type BomLineSnapshot = InspectionCompletionPreview["before"]["lines"][number];
type BomAlternativeSnapshot = BomLineSnapshot["alternatives"][number];

export function formatQuantityConversion(conversion: BomAlternativeSnapshot["quantityConversion"]): string {
  if (conversion === undefined) return "none";
  const { evidence } = conversion;
  const provenance = [evidence.basis, evidence.source, evidence.sourceId, evidence.observedAt]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  return `1 ${conversion.inventory.unit} = ${conversion.requirement.quantity} ${conversion.requirement.unit}${provenance ? ` (${provenance})` : ""}`;
}

export function alternativeChanges(beforeLines: readonly BomLineSnapshot[], afterLines: readonly BomLineSnapshot[]): string[] {
  const beforeById = new Map(beforeLines.map((line) => [line.id, line]));
  const afterById = new Map(afterLines.map((line) => [line.id, line]));
  const lineIds = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
  return lineIds.flatMap((lineId) => {
    const beforeLine = beforeById.get(lineId);
    const afterLine = afterById.get(lineId);
    const beforeAlternatives = new Map((beforeLine?.alternatives ?? []).map((alternative) => [alternative.itemId, alternative]));
    const afterAlternatives = new Map((afterLine?.alternatives ?? []).map((alternative) => [alternative.itemId, alternative]));
    const itemIds = [...new Set([...beforeAlternatives.keys(), ...afterAlternatives.keys()])].sort();
    return itemIds.flatMap((itemId) => {
      const before = beforeAlternatives.get(itemId);
      const after = afterAlternatives.get(itemId);
      if (JSON.stringify(before) === JSON.stringify(after)) return [];
      const beforeReason = before?.reason ?? "none";
      const afterReason = after?.reason ?? "none";
      return [`${lineId} · Alternative ${itemId}: compatibility ${before?.compatible ?? "not present"} → ${after?.compatible ?? "not present"}; conversion ${formatQuantityConversion(before?.quantityConversion)} → ${formatQuantityConversion(after?.quantityConversion)}; reason ${beforeReason} → ${afterReason}`];
    });
  });
}

export function lineReferences(action: InspectionAction): string {
  return ( action.lineVersions.map((line) => `${line.lineId} · v${line.version}`).join(", ") || "None" );
}

export function InspectionResultDialog({ action, expert, onClose, onPreviewInspection, onConfirmInspection }: {
  action: InspectionAction;
  expert: boolean;
  onClose: () => void;
  onPreviewInspection?: InspectionQueuePanelProps["onPreviewInspection"];
  onConfirmInspection?: InspectionQueuePanelProps["onConfirmInspection"];
}) {
  const headingId = useId();
  const [result, setResult] = useState("");
  const [quantity, setQuantity] = useState("");
  const [source, setSource] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [note, setNote] = useState("");
  const [conversionQuantity, setConversionQuantity] = useState("");
  const [conversionBasis, setConversionBasis] = useState("");
  const [preview, setPreview] = useState<InspectionCompletionPreview>();
  const [pending, setPending] = useState<"preview" | "confirm">();
  const [error, setError] = useState<string>();
  const [confirmUncertain, setConfirmUncertain] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  const reviewedInput = useRef<InspectionCompletionInput | undefined>(undefined);
  useUnsavedWork(Boolean(result || quantity || source || sourceId || observedAt || note || conversionQuantity || conversionBasis), "inspection result", Boolean(pending) || confirmUncertain);

  const input = (): InspectionCompletionInput => {
    const timestamp = observedAt ? new Date(observedAt).toISOString() : new Date().toISOString();
    const conversion = action.kind === "unit_conversion" && conversionQuantity.trim() && conversionBasis
      ? ({
        inventory: { quantity: 1 as const, unit: "set" as const },
        requirement: { quantity: Number(conversionQuantity), unit: "each" as const },
        evidence: {
          basis: conversionBasis as NonNullable<InspectionCompletionInput["conversion"]>["evidence"]["basis"],
          observedAt: timestamp,
          ...(source.trim() ? { source: source.trim() } : {}),
          ...(sourceId.trim() ? { sourceId: sourceId.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {})
        }
      } satisfies NonNullable<InspectionCompletionInput["conversion"]>) : undefined;
    return {
      result: result as InspectionCompletionInput["result"],
      ...(quantity.trim() ? { quantity: Number(quantity), unit: action.itemUnit } : {}),
      source: source.trim(),
      ...(sourceId.trim() ? { sourceId: sourceId.trim() } : {}),
      observedAt: timestamp,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(conversion === undefined ? {} : { conversion })
    };
  };

  const requestPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (!result.trim() || !source.trim() || pending || confirmUncertain) return;
    if (action.kind === "physical_quantity" && result === "confirmed" && !quantity.trim()) {
      setError(`Enter the observed quantity in ${action.itemUnit}.`);
      return;
    }
    if (action.kind === "unit_conversion" && result === "confirmed" && (!conversionQuantity.trim() || !conversionBasis)) {
      setError("Enter the whole-number pieces per set and choose the evidence basis for a confirmed conversion.");
      return;
    }
    if (quantity.trim() && (!Number.isFinite(Number(quantity)) || Number(quantity) < 0)) {
      setError("Enter a valid non-negative quantity.");
      return;
    }
    if (conversionQuantity.trim() && (!Number.isSafeInteger(Number(conversionQuantity)) || Number(conversionQuantity) < 1)) {
      setError("Enter a positive whole number of requirement pieces per set.");
      return;
    }
    setPending("preview");
    setError(undefined);
    try {
      if (!onPreviewInspection) throw new Error("The inspection preview service is not available.");
      const observed = input();
      setPreview(await onPreviewInspection(action, observed));
      reviewedInput.current = observed;
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The server preview could not be generated.");
    } finally {
      setPending(undefined);
    }
  };

  const confirm = async () => {
    if (!preview || !onConfirmInspection || pending || !reviewedInput.current) return;
    setPending("confirm");
    setError(undefined);
    try {
      await onConfirmInspection(action, reviewedInput.current!, preview);
      setConfirmUncertain(false); onClose();
    } catch (caught: unknown) {
      const uncertain = !(caught instanceof ApiError) || caught.kind === "server" || caught.kind === "offline";
      setConfirmUncertain(uncertain);
      setError(uncertain ? "The result was not confirmed. Retry the unchanged result before editing or leaving." : caught.message);
    } finally {
      setPending(undefined);
    }
  };

  return ( <WorkspaceModal onClose={() => { if (!pending && !confirmUncertain) onClose(); }}><form ref={dialogRef} tabIndex={-1} className="inspection-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} onSubmit={(event) => { void requestPreview(event); }}>
    <div className="inspection-dialog-icon"><Icon name="tool" size={20} /></div>
    <span className="eyebrow">Project check</span>
    <DialogTitle id={headingId}>Record the result</DialogTitle>
    <p className="inspection-dialog-question">{action.question}</p>
    <p className="inspection-dialog-candidate"><span>Candidate</span><strong>{action.candidate.name}</strong><small>Item {action.candidate.id} · version {action.candidate.version}</small></p>
    <div className="inspection-dialog-fields"><Label className="form-field" htmlFor={`${headingId}-result`}><span>Inspection result</span><NativeSelect id={`${headingId}-result`} data-autofocus autoFocus required value={result} onChange={(event) => { setResult(event.target.value); setPreview(undefined); }} disabled={Boolean(pending) || confirmUncertain}><NativeSelectOption value="">Choose one</NativeSelectOption>{action.possibleResults.map((possible) => ( <NativeSelectOption key={possible} value={possible}>{possible === "confirmed" ? "Confirmed" : "Inconclusive"}</NativeSelectOption>))}</NativeSelect></Label>{action.kind === "physical_quantity" && ( <Label className="form-field" htmlFor={`${headingId}-quantity`}><span>Observed quantity ({action.itemUnit})</span><Input id={`${headingId}-quantity`} type="number" min="0" step="any" required={result === "confirmed"} value={quantity} onChange={(event) => { setQuantity(event.target.value); setPreview(undefined); }} placeholder="Enter counted quantity" disabled={Boolean(pending) || confirmUncertain} /></Label> )}</div>
    {action.kind === "unit_conversion" && ( <div className="inspection-dialog-fields"><Label className="form-field" htmlFor={`${headingId}-conversion-quantity`}><span>Pieces per set <small>(positive whole number)</small></span><Input id={`${headingId}-conversion-quantity`} type="number" min="1" step="1" value={conversionQuantity} onChange={(event) => { setConversionQuantity(event.target.value); setPreview(undefined); }} placeholder="For example, 10" disabled={Boolean(pending) || confirmUncertain} /></Label><Label className="form-field" htmlFor={`${headingId}-conversion-basis`}><span>Conversion evidence basis</span><NativeSelect id={`${headingId}-conversion-basis`} value={conversionBasis} onChange={(event) => { setConversionBasis(event.target.value); setPreview(undefined); }} disabled={Boolean(pending) || confirmUncertain}><NativeSelectOption value="">Choose one</NativeSelectOption><NativeSelectOption value="package_label">Package label</NativeSelectOption><NativeSelectOption value="manufacturer_spec">Manufacturer specification</NativeSelectOption><NativeSelectOption value="physical_count">Physical count</NativeSelectOption><NativeSelectOption value="user_assertion">User assertion</NativeSelectOption></NativeSelect></Label></div> )}
    <div className="inspection-dialog-fields"><Label className="form-field" htmlFor={`${headingId}-source`}><span>How did you check?</span><NativeSelect id={`${headingId}-source`} required value={source} onChange={(event) => { setSource(event.target.value); setPreview(undefined); }} disabled={Boolean(pending) || confirmUncertain}><NativeSelectOption value="">Choose one</NativeSelectOption><NativeSelectOption value="Physical check">Physical check</NativeSelectOption><NativeSelectOption value="Read the label">Read the label</NativeSelectOption><NativeSelectOption value="Measured it">Measured it</NativeSelectOption><NativeSelectOption value="Checked a document">Checked a document</NativeSelectOption></NativeSelect></Label>{expert && ( <Label className="form-field" htmlFor={`${headingId}-source-id`}><span>Source ID <small>(optional)</small></span><Input id={`${headingId}-source-id`} value={sourceId} onChange={(event) => { setSourceId(event.target.value); setPreview(undefined); }} placeholder="Label, record, or document ID" disabled={Boolean(pending) || confirmUncertain} /></Label> )}</div>
    <div className="inspection-dialog-fields"><Label className="form-field" htmlFor={`${headingId}-observed-at`}><span>Observed <small>(optional; defaults to now)</small></span><Input id={`${headingId}-observed-at`} type="datetime-local" value={observedAt} onChange={(event) => { setObservedAt(event.target.value); setPreview(undefined); }} disabled={Boolean(pending) || confirmUncertain} /></Label><Label className="form-field" htmlFor={`${headingId}-note`}><span>Note <small>(optional)</small></span><Input id={`${headingId}-note`} value={note} onChange={(event) => { setNote(event.target.value); setPreview(undefined); }} placeholder="What did you check?" disabled={Boolean(pending) || confirmUncertain} /></Label></div>
    {expert && ( <Disclosure className="inspection-dialog-expert" defaultOpen><DisclosureTrigger>Technical traceability</DisclosureTrigger><DisclosureContent><div className="inspection-expert-grid"><span>Action ID</span><code>{action.id}</code><span>Revision</span><code>{action.projectRevisionId}</code><span>Affected lines</span><code>{lineReferences(action)}</code><span>Item</span><code>{action.itemId} · v{action.itemVersion}</code><span>Evidence</span><code>{[action.candidate.evidence.state, action.candidate.evidence.source].filter(Boolean).join(" · ") || "Not recorded"}</code><span>Predicate</span><code>{action.normalizedPredicate}</code><span>Unit</span><code>{action.expectedUnit}</code><span>Effects</span><code>{effectsLabel(action.effects)}</code></div></DisclosureContent></Disclosure> )}
    {error && ( <Alert asChild><p className="inspection-dialog-error" role="alert"><Icon name="warning" size={15} />{error}</p></Alert> )}
    {preview && ( <section className="inspection-server-preview" aria-label="Server preview"><div className="inspection-preview-heading"><div><span className="eyebrow">Server preview</span><h3>Review proposed changes</h3></div><span className="inspection-preview-status">Preview only</span></div><p>{previewDescription(preview)}</p>{preview.affectedLines.length > 0 && ( <ul>{preview.affectedLines.map((line) => { const before = preview.before.gaps.find((gap) => gap.lineId === line.lineId); const after = preview.after.gaps.find((gap) => gap.lineId === line.lineId); const changes = alternativeChanges(preview.before.lines ?? [], preview.after.lines ?? []).filter((change) => change.startsWith(`${line.lineId} · `)); return ( <li key={line.lineId}><strong>{line.lineId}</strong><span>v{line.version} · {" "} {line.beforeDecision ?? before?.decision ?? "not evaluated"}{" "} → {" "} {line.afterDecision ?? after?.decision ?? "not evaluated"}</span><small>Before: {gapQuantities(before)}<br />After: {gapQuantities(after)}</small>{changes.length > 0 ? ( <ul className="inspection-preview-alternatives">{changes.map((change) => ( <li key={change}><small>{change}</small></li>))}</ul> ) : ( <small className="inspection-preview-no-alternatives">No alternative compatibility or conversion changes.</small> )}</li> ); })}</ul> )}{preview.affectedLines.length === 0 && ( <p className="inspection-preview-empty">No BOM line changes are proposed by the server.</p> )}<div className="inspection-preview-fact"><span>Requires human confirmation</span><strong>Yes — nothing has changed yet</strong></div>{expert && ( <div className="inspection-preview-expert"><span>Preview ID</span><code>{preview.id}</code><span>Preview version</span><code>{preview.version}</code><span>Content hash</span><code>{preview.contentSha256}</code><span>Expires</span><code>{formatObservedAt(preview.expiresAt) ?? preview.expiresAt}</code></div> )}</section> )}
    <div className="dialog-actions"><Button variant="ghost" type="button" className="button button-quiet" onClick={onClose} disabled={Boolean(pending) || confirmUncertain}>Cancel</Button>{preview ? ( <Button variant="default" type="button" className="button button-primary" onClick={() => { void confirm(); }} disabled={Boolean(pending) || !onConfirmInspection}>{pending === "confirm" ? "Confirming…" : confirmUncertain ? "Retry unchanged result" : "Confirm result"}<Icon name="check" size={16} /></Button> ) : ( <Button variant="default" type="submit" className="button button-primary" disabled={Boolean(pending) || !result.trim() || !source.trim()}>{pending === "preview" ? "Loading preview…" : "Preview changes"}<Icon name="arrow-right" size={16} /></Button> )}</div>
  </form></WorkspaceModal> );
}

export function inspectionActionAccessibleNames(actions: readonly InspectionAction[]): string[] {
  const bases = actions.map((action) => `Check ${action.candidate.name}: ${action.question}`);
  const totals = new Map<string, number>();
  bases.forEach((base) => totals.set(base, (totals.get(base) ?? 0) + 1));
  const seen = new Map<string, number>();
  return bases.map((base) => {
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const total = totals.get(base) ?? 1;
    return total > 1 ? `${base} (${occurrence} of ${total})` : base;
  });
}

export function InspectionQueuePanel({ actions, expert = false, loadError, onViewAll, onReadInspection, onPreviewInspection, onConfirmInspection }: InspectionQueuePanelProps) {
  const headingId = useId();
  const [showAll, setShowAll] = useState(false);
  const [selectedAction, setSelectedAction] = useState<InspectionAction>();
  const [readingActionId, setReadingActionId] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const visibleActions = showAll ? actions : actions.slice(0, 3);
  const accessibleNames = inspectionActionAccessibleNames(actions);
  const openAction = async (action: InspectionAction) => {
    setReadError(undefined);
    if (!onReadInspection) {
      setSelectedAction(action);
      return;
    }
    setReadingActionId(action.id);
    try {
      setSelectedAction(await onReadInspection(action));
    } catch (caught: unknown) {
      setReadError(caught instanceof Error ? caught.message : "The project check could not be loaded.");
    } finally {
      setReadingActionId(undefined);
    }
  };
  return ( <Card asChild><section className="surface inspection-panel" aria-labelledby={headingId}><div className="inspection-panel-heading"><div><span className="eyebrow">Project plan checks</span><h2 id={headingId}>Stock checks</h2><p>Check the listed stock. Review each result before saving.</p></div>{actions.length > 3 && ( <Button variant="ghost" type="button" className="text-button" aria-expanded={showAll} onClick={() => { setShowAll((current) => { if (!current) onViewAll?.(); return !current; }); }}>{showAll ? "Show less" : "View all"}{" "} <Icon name={showAll ? "arrow-left" : "arrow-right"} size={14} /></Button> )}</div>{(readError ?? loadError) && ( <Alert asChild><p className="inspection-panel-error" role="alert"><Icon name="warning" size={15} />{readError ?? loadError}</p></Alert> )}{actions.length === 0 ? ( <div className="inspection-empty"><Icon name="check-circle" size={17} /><span>{loadError ? "The current project checks could not be loaded." : "No open physical checks are recorded for this revision."}</span></div> ) : ( <div className="inspection-action-list">{visibleActions.map((action, index) => ( <article className="inspection-action" key={action.id}><div className="inspection-action-icon"><Icon name="tool" size={16} /></div><div className="inspection-action-body"><strong>{action.question}</strong><span className="inspection-candidate">Candidate: <b>{action.candidate.name}</b></span><span className="inspection-action-meta">{action.lineIds.length} affected requirement{action.lineIds.length === 1 ? "" : "s"}</span>{expert && ( <Disclosure className="inspection-trace"><DisclosureTrigger>Technical trace</DisclosureTrigger><DisclosureContent><div className="inspection-trace-grid"><span>Action ID</span><code>{action.id}</code><span>Affected lines</span><code>{lineReferences(action)}</code><span>Item</span><code>{action.itemId} · v{action.itemVersion}</code><span>Evidence</span><code>{[action.candidate.evidence.state, action.candidate.evidence.source].filter(Boolean).join(" · ") || "Not recorded"}</code><span>Predicate</span><code>{action.normalizedPredicate}</code><span>Unit</span><code>{action.expectedUnit}</code><span>Effects</span><code>{effectsLabel(action.effects)}</code></div></DisclosureContent></Disclosure> )}</div><Button variant="outline" type="button" className="button button-secondary inspection-action-button" aria-label={readingActionId === action.id ? `Loading check for ${action.candidate.name}` : accessibleNames[index]} onClick={() => { void openAction(action); }} disabled={readingActionId === action.id}>{readingActionId === action.id ? "Loading…" : "Check this item"}{" "} <Icon name="arrow-right" size={15} /></Button></article>))}</div> )}{selectedAction && ( <InspectionResultDialog action={selectedAction} expert={expert} onClose={() => setSelectedAction(undefined)} onPreviewInspection={onPreviewInspection} onConfirmInspection={onConfirmInspection} /> )}</section></Card> );
}
