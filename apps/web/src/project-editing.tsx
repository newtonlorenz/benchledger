import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "./components/ui/dropdown-menu";
import { Alert } from "./components/ui/alert";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";
import { Label } from "./components/ui/label";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Checkbox } from "./components/ui/checkbox";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { Input } from "./components/ui/input";
import { UnsavedWorkContext, useUnsavedWork } from "./unsaved-work";
import { Icon } from "./icons";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { BomLine, BomLineStatus, InventoryItem, Project } from "./domain";
import { ApiError } from "./api";
import type { BomUpdateInput, ProjectEditInput } from "./api";
import { matchesInventorySearch } from "@benchledger/domain/inventory-search";
import { RequirementOwnedItems, type OwnedItemSearch } from "./requirement-owned-items";
import { formatQuantity } from "./domain";
import { saveProjectHandoff } from "./project-handoff";

export const ProjectEditingContext = createContext<{
  project: Project;
  editRequirement(line: BomLine, focus?: "stock"): void;
  editProject(): void;
  refreshProject?: (() => Promise<boolean>) | undefined;
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
  return <Button variant="ghost" type="button" className="text-button requirement-edit-action" aria-label={`Edit requirement ${line.label}`} onClick={() => actions.editRequirement(line)}>Edit requirement</Button>;
}

export function ProjectManagementBar() {
  const actions = useContext(ProjectEditingContext);
  const [error, setError] = useState<string>();
  const navigation = useContext(UnsavedWorkContext);
  const [refreshing, setRefreshing] = useState(false), [refreshed, setRefreshed] = useState(false);
  useEffect(() => { setError(undefined); setRefreshed(false); }, [actions?.project.id]);
  const refresh = async () => {
    if (!actions?.refreshProject || refreshing) return;
    setRefreshing(true); setError(undefined); setRefreshed(false);
    try { if (await actions.refreshProject()) setRefreshed(true); else setError("Project refresh failed. Previous records remain visible. Retry before using stock."); }
    catch { setError("Project refresh failed. Previous records remain visible. Retry before using stock."); }
    finally { setRefreshing(false); }
  };
  if (!actions) return null;
  const { project } = actions;
  const download = (format: "json" | "csv") => { try { saveProjectHandoff(project, format); setError(undefined); } catch { setError("The export could not be created. Retry in this browser."); } };
  return <section className="project-management-bar" aria-label="Project management">
    <span className="project-stage">Stage: <strong>{project.status.charAt(0).toUpperCase() + project.status.slice(1)}</strong></span>
    {actions.refreshProject && <Button variant="ghost" type="button" className="button button-quiet" disabled={refreshing} onClick={() => navigation ? navigation.request(() => { void refresh(); }) : void refresh()} aria-label="Refresh project"><Icon name="refresh" size={15} />{refreshing ? "Refreshing…" : "Refresh"}</Button>}
    {project.status !== "archived" && <Button variant="ghost" type="button" className="button button-quiet" onClick={actions.editProject}>Edit project</Button>}
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline">Export project</Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="max-w-xs"><DropdownMenuLabel>Review before sharing</DropdownMenuLabel><p className="px-2 py-1 text-xs text-muted-foreground">Includes project names, notes and identifiers. These are snapshots, not backups.</p><DropdownMenuSeparator/><DropdownMenuItem onSelect={() => download("csv")}>Download requirements CSV</DropdownMenuItem><DropdownMenuItem onSelect={() => download("json")}>Download project brief JSON</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    {error && <Alert asChild><p role="alert" className="form-error">{error}</p></Alert>}
    {refreshed && !refreshing && !error && <p role="status" className="project-refresh-status">Project refreshed from the workspace.</p>}
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
  return <Disclosure className="removed-requirements surface" open={open} onOpenChange={(open) => setOpen(open)}><DisclosureTrigger>Removed requirements</DisclosureTrigger><DisclosureContent>
    <p>Removed requirements keep their history. Restoring one does not reserve or consume stock.</p>
    {loading ? <p role="status">Loading removed requirements…</p> : rows.length ? rows.map((line) => <div className="removed-requirement" key={line.id}><span>{line.label}</span><Button variant="ghost" type="button" className="button button-quiet" disabled={busy !== undefined || actions.project.status === "archived"} onClick={() => { void restore(line); }} aria-label={`Restore requirement ${line.label}`}>{busy === line.id ? "Restoring…" : "Restore"}</Button></div>) : !error && <p>No removed requirements in this revision.</p>}
    {error && <Alert asChild><p role="alert" className="form-error">{error}</p></Alert>}
    <Button variant="ghost" type="button" className="text-button" disabled={loading || busy !== undefined} onClick={() => setRefresh((value) => value + 1)}>Refresh removed requirements</Button>
  </DisclosureContent></Disclosure>;
}

export function RequirementEditForm({ line, items, initialFocus, initialItemId, onSave, onRetire, onClose, onBusy, onSearchOwnedItems }: { onSearchOwnedItems?: OwnedItemSearch | undefined; line: BomLine; items: InventoryItem[]; initialFocus?: "stock" | undefined; initialItemId?: string | undefined; onSave(input: BomUpdateInput): Promise<void>; onRetire(): Promise<void>; onClose(): void; onBusy(value: boolean): void }) {
  const [name, setName] = useState(line.label), [quantity, setQuantity] = useState(String(line.required));
  const [unit, setUnit] = useState(line.unit), [role, setRole] = useState(line.role ?? "");
  const [itemId, setItemId] = useState(initialItemId ?? line.itemId ?? ""), [query, setQuery] = useState<string>();
  const [optional, setOptional] = useState(line.optional ?? false), [note, setNote] = useState(line.note ?? "");
  const [busy, setBusy] = useState(false), [confirmRemove, setConfirmRemove] = useState(false), [error, setError] = useState<string>();
  const [uncertainOperation, setUncertainOperation] = useState<"save" | "remove">();
  const pendingSave = useRef<BomUpdateInput | undefined>(undefined);
  const dirty = name.trim() !== line.label || Number(quantity) !== line.required || unit !== line.unit || role !== (line.role ?? "") || itemId !== (line.itemId ?? "") || optional !== (line.optional ?? false) || note !== (line.note ?? "");
  useUnsavedWork(dirty, "requirement changes", busy || uncertainOperation !== undefined);
  const run = async (kind: "save" | "remove", operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); onBusy(true); setError(undefined);
    try { await operation(); pendingSave.current = undefined; setUncertainOperation(undefined); }
    catch (failure) {
      setError(correctionError(failure));
      if (uncertainOperation || ambiguous(failure)) setUncertainOperation(kind);
      else { pendingSave.current = undefined; setUncertainOperation(undefined); }
    }
    finally { setBusy(false); onBusy(false); }
  };
  const save = () => {
    if (uncertainOperation === "remove") { void run("remove", onRetire); return; }
    if (pendingSave.current) { const input = pendingSave.current; void run("save", () => onSave(input)); return; }
    const amount = Number(quantity);
    if (!name.trim() || !Number.isFinite(amount) || amount <= 0) { setError("Enter a requirement name and a quantity greater than zero."); return; }
    const input: BomUpdateInput = {
      ...(name.trim() === line.label ? {} : { name: name.trim() }), ...(amount === line.required ? {} : { requiredQuantity: amount }),
      ...(unit === line.unit ? {} : { unit }), ...(role === (line.role ?? "") || !role ? {} : { role: role as "consumed" | "reusable" }),
      ...(itemId === (line.itemId ?? "") ? {} : { itemId: itemId || null }), ...(optional === (line.optional ?? false) ? {} : { optional }), ...(note === (line.note ?? "") ? {} : { note }),
    };
    if (!Object.keys(input).length) { onClose(); return; }
    pendingSave.current = input;
    void run("save", () => onSave(input));
  };
  const disabled = busy || uncertainOperation !== undefined;
  const ownedItems = <RequirementOwnedItems onSearch={onSearchOwnedItems} items={items} requirementName={name} selectedId={itemId} onSelect={setItemId} unit={unit} onUnitChange={setUnit} queryOverride={query} onQueryChange={setQuery} disabled={disabled} focusSearch={initialFocus === "stock"} />;
  return <form onSubmit={(event) => { event.preventDefault(); save(); }} className="correction-form">
    <p className="dialog-intro">{initialFocus === "stock" ? `${name || line.label} · ${Number.isFinite(Number(quantity)) ? formatQuantity(Number(quantity), unit) : "Review quantity"} required. Review an owned item before sourcing.` : "Update this requirement and review any owned stock you plan to use."}</p>
    <fieldset disabled={disabled} className="correction-fields">
      {initialFocus === "stock" && ownedItems}
      <Disclosure defaultOpen={initialFocus !== "stock"}><DisclosureTrigger>Requirement details</DisclosureTrigger><DisclosureContent>
        <Label className="form-field"><span>Requirement name</span><Input autoFocus={initialFocus !== "stock"} required maxLength={240} value={name} onChange={(event) => setName(event.target.value)} /></Label>
        <div className="form-row requirement-quantity-row"><Label className="form-field"><span>Required quantity</span><Input type="number" required min="0.000001" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Label><Label className="form-field"><span>Requirement unit</span><NativeSelect aria-label="Requirement unit" value={unit} onChange={(event) => setUnit(event.target.value as BomLine["unit"])}>{[["each", "pieces"], ["g", "grams"], ["m", "metres"], ["millimetre", "millimetres"], ["millilitre", "millilitres"], ["set", "sets"]].map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Label></div>
        <Label className="form-field"><span>How it is used</span><NativeSelect aria-label="How it is used" value={role} onChange={(event) => setRole(event.target.value)}><NativeSelectOption value="" disabled>Review use</NativeSelectOption><NativeSelectOption value="consumed">Part or material, used up or built in</NativeSelectOption><NativeSelectOption value="reusable">Reusable tool or equipment</NativeSelectOption></NativeSelect></Label>
      </DisclosureContent></Disclosure>
      {initialFocus !== "stock" && ownedItems}
      <Disclosure className="requirement-details"><DisclosureTrigger>More requirement details{optional ? " · optional" : ""}{note ? " · has a note" : ""}</DisclosureTrigger><DisclosureContent>
        <Label className="form-field"><span>Requirement note</span><Textarea rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></Label>
        <Label className="check-field"><Checkbox checked={optional} onCheckedChange={(checked) => setOptional(checked === true)} /><span>Optional requirement</span></Label>
      </DisclosureContent></Disclosure>
    </fieldset>
    <p className="form-hint">Selecting an item is a planning choice, not proof of compatibility or available stock. Other recorded alternatives and specifications are retained. Reserved stock must be released before planning details change.</p>
    {error && <Alert asChild><p className="form-error" role="alert">{error}</p></Alert>}
    <Disclosure className="requirement-removal"><DisclosureTrigger>Remove requirement</DisclosureTrigger><DisclosureContent><p>This hides the requirement from the active plan, not its history. Restore it from Removed requirements. Reserved stock is never silently released.</p><Label className="check-field"><Checkbox checked={confirmRemove} onCheckedChange={(checked) => setConfirmRemove(checked === true)} disabled={disabled} /><span>I want to remove this requirement from the plan</span></Label><Button variant="destructive" type="button" className="button button-danger" disabled={disabled || !confirmRemove} onClick={() => { void run("remove", onRetire); }}>Remove from plan</Button></DisclosureContent></Disclosure>
    <div className="dialog-actions"><Button variant="ghost" type="button" className="button button-quiet" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="default" type="submit" className="button button-primary" disabled={busy} aria-busy={busy}>{busy ? "Saving…" : uncertainOperation === "remove" ? "Retry unchanged removal" : uncertainOperation === "save" ? "Retry unchanged save" : "Save requirement"}</Button></div>
  </form>;
}

export function ProjectEditForm({ project, onSave, onClose, onBusy, onDraftChange }: { project: Project; onDraftChange?: (state: { dirty: boolean; unresolved: boolean }) => void; onSave(input: ProjectEditInput): Promise<void>; onClose(): void; onBusy(value: boolean): void }) {
  const [name, setName] = useState(project.name), [description, setDescription] = useState(project.description);
  const [status, setStatus] = useState<ProjectEditInput["status"]>(project.status === "archived" ? "idea" : project.status);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [uncertain, setUncertain] = useState(false);
  const pendingSave = useRef<ProjectEditInput | undefined>(undefined);
  const dirty = name.trim() !== project.name || description !== project.description || status !== (project.status === "archived" ? "idea" : project.status);
  useUnsavedWork(dirty, "project changes", busy || uncertain);
  useEffect(() => { onDraftChange?.({ dirty, unresolved: busy || uncertain }); }, [dirty, busy, uncertain, onDraftChange]);
  useEffect(() => () => onDraftChange?.({ dirty: false, unresolved: false }), [onDraftChange]);
  const save = async () => {
    if (busy) return; setBusy(true); onBusy(true); setError(undefined);
    try { const input = pendingSave.current ?? { name: name.trim(), description, status }; pendingSave.current = input; await onSave(input); pendingSave.current = undefined; setUncertain(false); }
    catch (failure) { setError(correctionError(failure)); if (uncertain || ambiguous(failure)) setUncertain(true); else { pendingSave.current = undefined; setUncertain(false); } }
    finally { setBusy(false); onBusy(false); }
  };
  return <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="correction-form">
    <fieldset disabled={busy || uncertain} className="correction-fields"><Label className="form-field"><span>Project name</span><Input autoFocus required maxLength={240} value={name} onChange={(event) => setName(event.target.value)} /></Label><Label className="form-field"><span>Project goal and brief</span><Textarea maxLength={5000} rows={5} value={description} onChange={(event) => setDescription(event.target.value)} /></Label><Label className="form-field"><span>Project stage</span><NativeSelect aria-label="Project stage" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>{["idea", "planned", "ready", "building", "validating", "complete"].map((value) => <NativeSelectOption key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</NativeSelectOption>)}</NativeSelect></Label></fieldset>
    <p className="form-hint">The stage records your progress. It does not certify readiness, validate a design, change stock or operate equipment. Record actual stock use separately.</p>
    {error && <Alert asChild><p role="alert" className="form-error">{error}</p></Alert>}
    <div className="dialog-actions"><Button variant="ghost" type="button" className="button button-quiet" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="default" type="submit" className="button button-primary" disabled={busy || !name.trim()} aria-busy={busy}>{busy ? "Saving…" : uncertain ? "Retry unchanged save" : "Save project"}</Button></div>
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
