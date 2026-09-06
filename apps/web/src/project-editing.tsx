import { createContext, useContext, useEffect, useState } from "react";
import type { BomLine, BomLineStatus, InventoryItem, Project } from "./domain";
import { ApiError } from "./api";
import type { BomUpdateInput, ProjectEditInput } from "./api";
import { matchesInventorySearch } from "@benchledger/domain/inventory-search";
import { inventoryCandidateText } from "./inventory-identity";
import { saveProjectHandoff } from "./project-handoff";

export const ProjectEditingContext = createContext<{
  project: Project;
  editRequirement(line: BomLine): void;
  editProject(): void;
  listRemoved(): Promise<BomLine[]>;
  restore(line: BomLine): Promise<void>;
} | null>(null);

const ambiguous = (error: unknown) => error instanceof ApiError && (error.kind === "offline" || error.kind === "server");
function correctionError(error: unknown): string {
  if (ambiguous(error)) return "The save was not confirmed. Your draft is kept. Retry unchanged to check the same request, or reload the project before making a different change.";
  return error instanceof Error ? error.message : "The change was not saved. Review the project and retry.";
}

export function RequirementEditAction({ line }: { line: BomLine }) {
  const actions = useContext(ProjectEditingContext);
  if (!actions || actions.project.status === "archived") return null;
  return <button type="button" className="text-button requirement-edit-action" aria-label={`Edit requirement ${line.label}`} onClick={() => actions.editRequirement(line)}>Edit requirement</button>;
}

export function ProjectManagementBar() {
  const actions = useContext(ProjectEditingContext);
  const [error, setError] = useState<string>();
  if (!actions) return null;
  const { project } = actions;
  const download = (format: "json" | "csv") => { try { saveProjectHandoff(project, format); setError(undefined); } catch { setError("The export could not be created. Retry in this browser."); } };
  return <section className="project-management-bar" aria-label="Project management">
    <span className="project-stage">Stage: <strong>{project.status.charAt(0).toUpperCase() + project.status.slice(1)}</strong></span>
    {project.status !== "archived" && <button type="button" className="button button-quiet" onClick={actions.editProject}>Edit project</button>}
    <details className="project-export"><summary>Export project</summary><div className="project-export-options"><p>Includes project names, notes and identifiers. Review before sharing. These are snapshots, not backups.</p><button type="button" className="button button-quiet" onClick={() => download("csv")}>Download requirements CSV</button><button type="button" className="button button-quiet" onClick={() => download("json")}>Download project brief JSON</button></div></details>
    {error && <p role="alert" className="form-error">{error}</p>}
  </section>;
}

export function RemovedRequirements() {
  const actions = useContext(ProjectEditingContext);
  const [open, setOpen] = useState(false), [rows, setRows] = useState<BomLine[]>([]);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState<string>(), [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const projectId = actions?.project.id, revisionId = actions?.project.serverRevisionId, lineCount = actions?.project.bom.length;
  useEffect(() => {
    if (!open || !actions) return;
    let active = true; setLoading(true); setError(undefined);
    void actions.listRemoved().then((items) => { if (active) setRows(items); }).catch((failure: unknown) => { if (active) setError(correctionError(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, projectId, revisionId, lineCount, refresh]);
  if (!actions) return null;
  const restore = async (line: BomLine) => {
    setBusy(line.id); setError(undefined);
    try { await actions.restore(line); setRows((current) => current.filter((entry) => entry.id !== line.id)); }
    catch (failure) { setError(correctionError(failure)); }
    finally { setBusy(undefined); }
  };
  return <details className="removed-requirements surface" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Removed requirements</summary>
    <p>Removed requirements keep their history. Restoring one does not reserve or consume stock.</p>
    {loading ? <p role="status">Loading removed requirements…</p> : rows.length ? rows.map((line) => <div className="removed-requirement" key={line.id}><span>{line.label}</span><button type="button" className="button button-quiet" disabled={busy !== undefined || actions.project.status === "archived"} onClick={() => { void restore(line); }} aria-label={`Restore requirement ${line.label}`}>{busy === line.id ? "Restoring…" : "Restore"}</button></div>) : !error && <p>No removed requirements in this revision.</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <button type="button" className="text-button" disabled={loading || busy !== undefined} onClick={() => setRefresh((value) => value + 1)}>Refresh removed requirements</button>
  </details>;
}

export function RequirementEditForm({ line, items, onSave, onRetire, onClose, onBusy }: { line: BomLine; items: InventoryItem[]; onSave(input: BomUpdateInput): Promise<void>; onRetire(): Promise<void>; onClose(): void; onBusy(value: boolean): void }) {
  const [name, setName] = useState(line.label), [quantity, setQuantity] = useState(String(line.required));
  const [unit, setUnit] = useState(line.unit), [role, setRole] = useState(line.role ?? "");
  const [itemId, setItemId] = useState(line.itemId ?? ""), [query, setQuery] = useState("");
  const [optional, setOptional] = useState(line.optional ?? false), [note, setNote] = useState(line.note ?? "");
  const [busy, setBusy] = useState(false), [confirmRemove, setConfirmRemove] = useState(false), [error, setError] = useState<string>();
  const [uncertainOperation, setUncertainOperation] = useState<"save" | "remove">();
  const eligible = items.filter((item) => item.category !== "Printers" && (item.id === itemId || matchesInventorySearch([item.name, item.manufacturer, item.variant, item.location, item.sku], query)));
  const run = async (kind: "save" | "remove", operation: () => Promise<void>) => {
    if (busy) return; setBusy(true); onBusy(true); setError(undefined);
    try { await operation(); }
    catch (failure) { setError(correctionError(failure)); setUncertainOperation(ambiguous(failure) ? kind : undefined); }
    finally { setBusy(false); onBusy(false); }
  };
  const save = () => {
    if (uncertainOperation === "remove") { void run("remove", onRetire); return; }
    const amount = Number(quantity);
    if (!name.trim() || !Number.isFinite(amount) || amount <= 0) { setError("Enter a requirement name and a quantity greater than zero."); return; }
    const input: BomUpdateInput = {
      ...(name.trim() === line.label ? {} : { name: name.trim() }), ...(amount === line.required ? {} : { requiredQuantity: amount }),
      ...(unit === line.unit ? {} : { unit }), ...(role === (line.role ?? "") || !role ? {} : { role: role as "consumed" | "reusable" }),
      ...(itemId === (line.itemId ?? "") ? {} : { itemId: itemId || null }), ...(optional === (line.optional ?? false) ? {} : { optional }), ...(note === (line.note ?? "") ? {} : { note }),
    };
    if (!Object.keys(input).length) { onClose(); return; }
    void run("save", () => onSave(input));
  };
  return <form onSubmit={(event) => { event.preventDefault(); save(); }} className="correction-form">
    <p className="dialog-intro">Correct this requirement without replacing its history. Reserved stock must be released before its planning details change.</p>
    <fieldset disabled={busy || uncertainOperation !== undefined} className="correction-fields">
      <label className="form-field"><span>Requirement name</span><input autoFocus required maxLength={240} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div className="form-row"><label className="form-field"><span>Required quantity</span><input type="number" required min="0.000001" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><label className="form-field"><span>Requirement unit</span><select aria-label="Requirement unit" value={unit} onChange={(event) => setUnit(event.target.value as BomLine["unit"])}>{[["each", "pieces"], ["g", "grams"], ["m", "metres"], ["millimetre", "millimetres"], ["millilitre", "millilitres"], ["set", "sets"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <label className="form-field"><span>How it is used</span><select aria-label="How it is used" value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="" disabled>Review use</option><option value="consumed">Part or material, used up or built in</option><option value="reusable">Reusable tool or equipment</option></select></label>
      <label className="form-field"><span>Find owned stock</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, maker, colour or location" /></label>
      <label className="form-field"><span>Selected owned item</span><select aria-label="Selected owned item" value={itemId} onChange={(event) => setItemId(event.target.value)}><option value="">No selected item</option>{itemId && !eligible.some((item) => item.id === itemId) && <option value={itemId}>Previously selected item, not in the loaded inventory</option>}{eligible.map((item) => <option value={item.id} key={item.id}>{inventoryCandidateText(item, items)}</option>)}</select></label>
      <p className="form-hint">Selecting an item is a planning choice, not proof of compatibility or available stock. Clearing it preserves other recorded alternatives and specifications.</p>
      <label className="form-field"><span>Requirement note</span><textarea rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <label className="check-field"><input type="checkbox" checked={optional} onChange={(event) => setOptional(event.target.checked)} /><span>Optional requirement</span></label>
    </fieldset>
    {error && <p className="form-error" role="alert">{error}</p>}
    <details className="requirement-removal"><summary>Remove requirement</summary><p>This hides the requirement from the active plan, not its history. Restore it from Removed requirements. Reserved stock is never silently released.</p><label className="check-field"><input type="checkbox" checked={confirmRemove} onChange={(event) => setConfirmRemove(event.target.checked)} disabled={busy || uncertainOperation !== undefined} /><span>I want to remove this requirement from the plan</span></label><button type="button" className="button button-danger" disabled={busy || !confirmRemove || uncertainOperation !== undefined} onClick={() => { void run("remove", onRetire); }}>Remove from plan</button></details>
    <div className="dialog-actions"><button type="button" className="button button-quiet" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={busy} aria-busy={busy}>{busy ? "Saving…" : uncertainOperation === "remove" ? "Retry unchanged removal" : uncertainOperation === "save" ? "Retry unchanged save" : "Save requirement"}</button></div>
  </form>;
}

export function ProjectEditForm({ project, onSave, onClose, onBusy }: { project: Project; onSave(input: ProjectEditInput): Promise<void>; onClose(): void; onBusy(value: boolean): void }) {
  const [name, setName] = useState(project.name), [description, setDescription] = useState(project.description);
  const [status, setStatus] = useState<ProjectEditInput["status"]>(project.status === "archived" ? "idea" : project.status);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [uncertain, setUncertain] = useState(false);
  const save = async () => {
    if (busy) return; setBusy(true); onBusy(true); setError(undefined);
    try { await onSave({ name: name.trim(), description, status }); }
    catch (failure) { setError(correctionError(failure)); setUncertain(ambiguous(failure)); }
    finally { setBusy(false); onBusy(false); }
  };
  return <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="correction-form">
    <fieldset disabled={busy || uncertain} className="correction-fields"><label className="form-field"><span>Project name</span><input autoFocus required maxLength={240} value={name} onChange={(event) => setName(event.target.value)} /></label><label className="form-field"><span>Project goal and brief</span><textarea maxLength={5000} rows={5} value={description} onChange={(event) => setDescription(event.target.value)} /></label><label className="form-field"><span>Project stage</span><select aria-label="Project stage" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>{["idea", "planned", "ready", "building", "validating", "complete"].map((value) => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></label></fieldset>
    <p className="form-hint">The stage records your progress. It does not certify readiness, validate a design, change stock or operate equipment. Record actual stock use separately.</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="dialog-actions"><button type="button" className="button button-quiet" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={busy || !name.trim()} aria-busy={busy}>{busy ? "Saving…" : uncertain ? "Retry unchanged save" : "Save project"}</button></div>
  </form>;
}

export type RequirementFilter = "all" | "attention" | "ready" | "check" | "decide" | "source" | "optional";
export function matchesRequirementFilter(line: BomLineStatus, query: string, filter: RequirementFilter): boolean {
  if (!matchesInventorySearch([line.line.label, line.line.note, line.item?.name, line.item?.variant], query)) return false;
  if (filter === "all") return true;
  if (filter === "optional") return line.line.optional === true;
  if (line.line.optional) return false;
  return filter === "attention" ? line.decision !== "ready" : line.decision === filter;
}
