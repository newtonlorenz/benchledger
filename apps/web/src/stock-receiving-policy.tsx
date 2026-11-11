import { useEffect, useId, useState } from "react";
import type { InventoryItem } from "./domain";
import { Icon } from "./icons";
import { Button } from "./components/ui/button";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";

/** When recorded stock counts as in stock (mirrors the API contract). */
export type StockReceivingPolicy = "on_purchase" | "on_delivery" | "on_receipt";
export type StockPolicyAvailability = "confirmed" | "assumed" | "inspect_first" | "ordered" | "unknown";

export interface WorkspacePreferencesView {
  readonly stockReceivingPolicy: StockReceivingPolicy;
  readonly version: number;
}

export interface StockReceivingImpactRow {
  readonly itemId: string;
  readonly name: string;
  readonly evidenceState: string;
  readonly quantity: number;
  readonly unit: string;
  readonly allocatedQuantity: number;
}

export interface StockReceivingImpact {
  readonly from: StockReceivingPolicy;
  readonly to: StockReceivingPolicy;
  readonly version: number;
  readonly gained: readonly StockReceivingImpactRow[];
  readonly lost: readonly StockReceivingImpactRow[];
  readonly blockedBy: readonly StockReceivingImpactRow[];
  readonly truncated: boolean;
}

export const DEFAULT_STOCK_RECEIVING_POLICY: StockReceivingPolicy = "on_receipt";

export const STOCK_RECEIVING_OPTIONS: readonly { readonly value: StockReceivingPolicy; readonly label: string; readonly description: string }[] = [
  {
    value: "on_purchase",
    label: "When it's bought",
    description: "Ordered and delivered stock counts as in stock right away. Plans can rely on parts that have not arrived yet."
  },
  {
    value: "on_delivery",
    label: "When it's delivered",
    description: "Delivered stock counts without a count. Ordered stock that has not arrived does not count."
  },
  {
    value: "on_receipt",
    label: "When I've received and checked it",
    description: "Ordered and delivered stock waits until you count it. Choose this to manage delivered and received stock separately."
  }
];

export function isStockReceivingPolicy(value: unknown): value is StockReceivingPolicy {
  return value === "on_purchase" || value === "on_delivery" || value === "on_receipt";
}

export function stockReceivingPolicyLabel(policy: StockReceivingPolicy): string {
  return STOCK_RECEIVING_OPTIONS.find((option) => option.value === policy)?.label ?? "When I've received and checked it";
}

/**
 * Honest label for stock that counts only because the receiving policy
 * trusts it. The status still reads "In stock", and the recorded evidence
 * stays visible next to it.
 */
export function assumedStockLabel(item: Pick<InventoryItem, "policyAvailability" | "serverEvidence" | "evidence">): string | undefined {
  if (item.policyAvailability !== "assumed") return undefined;
  const evidence = item.serverEvidence ?? (item.evidence === "ordered" ? "ordered_unverified" : "delivered_uncounted");
  return evidence === "ordered_unverified" ? "In stock · ordered, not yet delivered" : "In stock · delivered, not counted";
}

function itemCount(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

/** Plain-language consequences of a change, computed from current inventory. */
export function stockReceivingImpactSummary(impact: StockReceivingImpact): readonly string[] {
  const lines: string[] = [];
  if (impact.gained.length > 0) lines.push(`${itemCount(impact.gained.length)} will now count as in stock.`);
  if (impact.lost.length > 0) lines.push(`${itemCount(impact.lost.length)} will no longer count as in stock.`);
  if (lines.length === 0) lines.push("No current inventory changes. New orders and deliveries will follow this setting.");
  if (impact.truncated) lines.push("Only the first part of a large inventory was checked.");
  return lines;
}

export interface StockReceivingPolicySectionProps {
  readonly preferences: WorkspacePreferencesView;
  /** False for sample workspaces and members without administrator access. */
  readonly canChange: boolean;
  readonly readOnlyReason?: string | undefined;
  readonly onPreview: (policy: StockReceivingPolicy) => Promise<StockReceivingImpact>;
  readonly onSave: (policy: StockReceivingPolicy, expectedVersion: number) => Promise<WorkspacePreferencesView>;
  readonly onSaved: (preferences: WorkspacePreferencesView) => Promise<void> | void;
}

type Phase = { readonly kind: "idle" } | { readonly kind: "previewing" } | { readonly kind: "review"; readonly impact: StockReceivingImpact } | { readonly kind: "saving"; readonly impact: StockReceivingImpact };

function errorMessage(error: unknown, fallback: string): string {
  const candidate = error as { status?: unknown; reason?: unknown; message?: unknown } | null;
  if (candidate && candidate.reason === "policy_change_strands_reservations") return "Reserved stock would stop counting. Count those items or release their reservations, then try again.";
  if (candidate && candidate.status === 409) return "This setting changed elsewhere. Reload settings and try again.";
  if (candidate && candidate.status === 403) return "Only a workspace administrator can change this setting.";
  return typeof candidate?.message === "string" && candidate.message.length > 0 ? candidate.message : fallback;
}

export function StockReceivingPolicySection({ preferences, canChange, readOnlyReason, onPreview, onSave, onSaved }: StockReceivingPolicySectionProps) {
  const headingId = useId();
  const helpId = useId();
  const [selected, setSelected] = useState<StockReceivingPolicy>(preferences.stockReceivingPolicy);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const current = preferences.stockReceivingPolicy;
  // A refreshed workspace (or another administrator's change) resets an idle choice.
  useEffect(() => { setSelected((value) => phase.kind === "idle" ? current : value); }, [current]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = selected !== current;
  const busy = phase.kind === "previewing" || phase.kind === "saving";

  const choose = (policy: StockReceivingPolicy) => {
    setSelected(policy);
    setPhase({ kind: "idle" });
    setError(undefined);
    setStatus(undefined);
  };

  const review = async () => {
    setError(undefined);
    setStatus(undefined);
    setPhase({ kind: "previewing" });
    try {
      setPhase({ kind: "review", impact: await onPreview(selected) });
    } catch (previewError) {
      setPhase({ kind: "idle" });
      setError(errorMessage(previewError, "The impact could not be checked. Nothing was changed."));
    }
  };

  const save = async (impact: StockReceivingImpact) => {
    setPhase({ kind: "saving", impact });
    setError(undefined);
    try {
      const saved = await onSave(impact.to, impact.version);
      await onSaved(saved);
      setPhase({ kind: "idle" });
      setSelected(saved.stockReceivingPolicy);
      setStatus(`Saved. Stock now counts as in stock ${stockReceivingPolicyLabel(saved.stockReceivingPolicy).replace(/^When/u, "when")}.`);
    } catch (saveError) {
      setPhase({ kind: "review", impact });
      setError(errorMessage(saveError, "The setting was not saved. Reload settings before trying again."));
    }
  };

  return <section className="surface settings-section stock-receiving-section" aria-labelledby={headingId}>
    <div className="section-heading"><div><span className="eyebrow">Inventory</span><h2 id={headingId}>When does stock count as in stock?</h2></div><span className="stock-receiving-current">Current: {stockReceivingPolicyLabel(current)}</span></div>
    <p className="stock-receiving-intro" id={helpId}>This decides which stock projects can use and reserve. Recorded evidence never changes: delivered or ordered items keep showing that they have not been counted.</p>
    <fieldset className="stock-receiving-options" aria-describedby={helpId} disabled={!canChange || busy}>
      <legend className="sr-only">When does stock count as in stock?</legend>
      <RadioGroup name="stock-receiving-policy" value={selected} onValueChange={(value) => choose(value as StockReceivingPolicy)} disabled={!canChange || busy}>
      {STOCK_RECEIVING_OPTIONS.map((option) => (
        <label key={option.value} className={`stock-receiving-option ${selected === option.value ? "is-selected" : ""}`}>
          <RadioGroupItem value={option.value} />
          <span><strong>{option.label}{option.value === DEFAULT_STOCK_RECEIVING_POLICY ? <small> · Default</small> : null}</strong><small>{option.description}</small></span>
        </label>
      ))}
      </RadioGroup>
    </fieldset>
    {!canChange && <p className="stock-receiving-note" role="note">{readOnlyReason ?? "Only a workspace administrator can change this setting."}</p>}
    {canChange && changed && phase.kind !== "review" && phase.kind !== "saving" && (
      <div className="stock-receiving-actions"><Button variant="outline" type="button" className="button button-secondary" onClick={() => { void review(); }} disabled={busy} aria-busy={phase.kind === "previewing" || undefined}>{phase.kind === "previewing" ? "Checking inventory…" : "Review change"}<Icon name="arrow-right" size={16} /></Button><Button variant="ghost" type="button" className="button button-quiet" onClick={() => choose(current)} disabled={busy}>Cancel</Button></div>
    )}
    {(phase.kind === "review" || phase.kind === "saving") && (
      <div className="stock-receiving-review" role="group" aria-label="Confirm stock setting change">
        <strong>Change to “{stockReceivingPolicyLabel(phase.impact.to)}”?</strong>
        <ul className="stock-receiving-impact">{stockReceivingImpactSummary(phase.impact).map((line) => <li key={line}>{line}</li>)}</ul>
        {phase.impact.gained.length > 0 && <Disclosure><DisclosureTrigger>Items that will count</DisclosureTrigger><DisclosureContent><ul>{phase.impact.gained.slice(0, 20).map((row) => <li key={row.itemId}>{row.name} · {row.evidenceState === "ordered_unverified" ? "ordered, not yet delivered" : "delivered, not counted"}</li>)}</ul></DisclosureContent></Disclosure>}
        {phase.impact.lost.length > 0 && <Disclosure><DisclosureTrigger>Items that will stop counting</DisclosureTrigger><DisclosureContent><ul>{phase.impact.lost.slice(0, 20).map((row) => <li key={row.itemId}>{row.name}</li>)}</ul></DisclosureContent></Disclosure>}
        {phase.impact.blockedBy.length > 0 && <p className="form-error" role="alert">{itemCount(phase.impact.blockedBy.length)} with project reservations would stop counting: {phase.impact.blockedBy.map((row) => row.name).join(", ")}. Count them or release their reservations first.</p>}
        <p className="stock-receiving-note">Project readiness, reservations and the shopping list update after you save.</p>
        <div className="stock-receiving-actions"><Button variant="default" type="button" className="button button-primary" onClick={() => { void save(phase.impact); }} disabled={phase.kind === "saving" || phase.impact.blockedBy.length > 0} aria-busy={phase.kind === "saving" || undefined}>{phase.kind === "saving" ? "Saving…" : "Save setting"}</Button><Button variant="ghost" type="button" className="button button-quiet" onClick={() => choose(current)} disabled={phase.kind === "saving"}>Cancel</Button></div>
      </div>
    )}
    {error && <p className="form-error" role="alert">{error}</p>}
    {status && <p className="form-success" role="status">{status}</p>}
  </section>;
}
