import "./specialist-journey.css";
import { Alert } from "./components/ui/alert";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";
import { Table, TableCaption, TableHeader, TableRow, TableHead, TableBody, TableCell } from "./components/ui/table";
import { Label } from "./components/ui/label";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Checkbox } from "./components/ui/checkbox";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { Input } from "./components/ui/input";
import { useUnsavedWork } from "./unsaved-work";
import { useEffect, useRef, useState } from "react";
import { WorkspaceModal } from "./components/workspace-modal";
import { AlertDialogTitle, AlertDialogDescription } from "./components/ui/alert-dialog";
import type { ArtifactUploadTarget } from "./artifact-scope";
import { isUsableOwnedPrinter, projectIntendedPrinterId, projectFabricationRoute } from "./project-build-readiness";
export type BuildFileUpload = (file: File, role: string, target?: ArtifactUploadTarget) => Promise<void>;
import { buildPlanInputSchema } from "@benchledger/api-contract";
import type { BuildPlan, BuildPlanInput } from "@benchledger/api-contract";
import type { Project, InventoryItem } from "./domain";
import { useWorkflowRead, useWorkflowCommand, mutationValue, revisionWorkflowPath } from "./workflow-ui";
import { ApiError, workflowCommandKey } from "./api";
type Part = BuildPlanInput["parts"][number];
type Plate = BuildPlanInput["plates"][number];

export function BuildPlanning({ project, items, readOnly = false, onUpload, onApproach }: { project: Project; items: InventoryItem[]; readOnly?: boolean; onUpload?: BuildFileUpload | undefined; onApproach?: (() => void) | undefined }) {
  const root = project.serverRevisionId ? revisionWorkflowPath(project.id, project.serverRevisionId) : undefined;
  const source = useWorkflowRead<BuildPlan | null>(root ? `${root}/build-plan` : undefined);
  const [editing, setEditing] = useState(false), [historyOpen, setHistoryOpen] = useState(false), [cursor, setCursor] = useState<string>();
  const editTrigger = useRef<HTMLButtonElement>(null);
  const restoreEditFocus = useRef(false);
  useEffect(() => {
    if (!editing && restoreEditFocus.current && editTrigger.current && !editTrigger.current.disabled) {
      editTrigger.current.focus();
      restoreEditFocus.current = false;
    }
  }, [editing, source.loading, source.error]);
  const history = useWorkflowRead<{ data: BuildPlan[]; nextCursor?: string }>(root && historyOpen ? `${root}/build-plan/history?limit=10${cursor ? `&cursor=${cursor}` : ""}` : undefined, String(source.data?.version));
  if (!root) return <p>A connected revision is required for a build plan.</p>;
  return <section className="surface build-planning"><h2>Parts and build plates</h2><p>Plan repeated parts, plate runs, filament and time. Review each plate in your slicer before printing.</p>
    {source.loading && <p role="status">Loading build plan…</p>}{source.error && <Alert asChild><p role="alert">{source.error}</p></Alert>}
    {editing ? <BuildEditor key={`${project.id}:${source.data?.version ?? 0}`} root={root} project={project} items={items} onUpload={onUpload} onApproach={onApproach} initial={source.data ?? null} onCancel={() => { restoreEditFocus.current = true; setEditing(false); }} onSaved={() => { setEditing(false); source.reload(); }} /> : <>{source.data ? <PlanSummary plan={source.data} items={items} /> : !source.loading && !source.error && <p>Create a plan to arrange repeated parts across plates and estimate material use.</p>}{!readOnly && project.status !== "archived" && <Button ref={editTrigger} variant="outline" type="button" className="button button-secondary" disabled={source.loading || Boolean(source.error)} onClick={() => setEditing(true)}>{source.data ? "Revise build plan" : "Create build plan"}</Button>}</>}
    <Disclosure open={historyOpen} onOpenChange={(open) => setHistoryOpen(open)}><DisclosureTrigger>Build-plan history</DisclosureTrigger><DisclosureContent>{history.loading && <p>Loading versions…</p>}{history.error && <Alert asChild><p role="alert">{history.error}</p></Alert>}{history.data?.data.map((plan) => <Disclosure key={plan.version}><DisclosureTrigger>Version {plan.version}: {plan.name}</DisclosureTrigger><DisclosureContent><PlanSummary plan={plan} items={items} /></DisclosureContent></Disclosure>)}{history.data?.nextCursor && <Button variant="ghost" type="button" className="text-button" onClick={() => setCursor(history.data!.nextCursor)}>Older versions</Button>}{cursor && <Button variant="ghost" type="button" className="text-button" onClick={() => setCursor(undefined)}>Latest versions</Button>}</DisclosureContent></Disclosure>
    <Button variant="ghost" type="button" className="text-button" disabled={editing || source.loading} onClick={source.reload}>Refresh build plan</Button>
  </section>;
}
export function PlanSummary({ plan, items }: { plan: BuildPlan; items: InventoryItem[] }) {
  return <section><h3>{plan.name}</h3><div className="workflow-table-scroll"><Table className="data-table"><TableCaption>Part coverage</TableCaption><TableHeader><TableRow><TableHead>Part</TableHead><TableHead>Required</TableHead><TableHead>Planned</TableHead><TableHead>Missing</TableHead><TableHead>Extra</TableHead></TableRow></TableHeader><TableBody>{plan.totals.parts.map((part) => <TableRow key={part.id}><TableCell>{plan.parts.find((entry) => entry.id === part.id)?.name ?? part.id}</TableCell><TableCell>{part.required}</TableCell><TableCell>{part.planned}</TableCell><TableCell>{part.missing}</TableCell><TableCell>{part.excess}</TableCell></TableRow>)}</TableBody></Table></div>
    <p>{plan.plates.reduce((sum, plate) => sum + plate.copies, 0)} planned runs · {plan.totals.minutes} recorded minutes{plan.totals.timeComplete ? "" : " (some estimates missing)"}</p>{plan.totals.materialGrams.map((entry) => <p key={entry.itemId}>{items.find((item) => item.id === entry.itemId)?.name ?? entry.itemId}: {entry.grams} g planned</p>)}
    <section aria-label="Build checks"><h4>Before you build</h4>{plan.warnings.length ? <ul>{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p>Check printer setup, material, supports and toolpaths in your slicer. This plan records intent; it does not validate a print.</p>}</section><Disclosure><DisclosureTrigger>File evidence and plan details</DisclosureTrigger><DisclosureContent><p>Version {plan.version}</p><p className="identifier-value">Snapshot: {plan.contentSha256}</p>{plan.artifactBasis.map((file) => <p className="identifier-value" key={file.id}>{file.id}: {file.sha256}</p>)}</DisclosureContent></Disclosure>
  </section>;
}

export function BuildEditor({ project, items, initial, root, onCancel, onSaved, onUpload, onApproach }: { project: Project; items: InventoryItem[]; initial: BuildPlan | null; root: string; onCancel(): void; onSaved(): void; onUpload?: BuildFileUpload | undefined; onApproach?: (() => void) | undefined }) {
  const [draft, setDraft] = useState<BuildPlanInput>(() => initial ? { expectedVersion: initial.version, name: initial.name, parts: initial.parts, plates: initial.plates, ...(initial.notes ? { notes: initial.notes } : {}) } : { expectedVersion: 0, name: `${project.name} build plan`, parts: [], plates: [] });
  const [review, setReview] = useState<BuildPlanInput>(), [error, setError] = useState<string>();
  const [discardOpen, setDiscardOpen] = useState(false);
  const planName = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const restoreCancelFocus = useRef(false);
  const keepEditing = () => { restoreCancelFocus.current = true; setDiscardOpen(false); };
  useEffect(() => {
    if (!discardOpen && restoreCancelFocus.current) { cancelButton.current?.focus(); restoreCancelFocus.current = false; }
  }, [discardOpen]);
  useEffect(() => { (review ? reviewHeading.current : planName.current)?.focus(); }, [review]);
  const addPartButton = useRef<HTMLButtonElement>(null);
  const partNameInputs = useRef(new Map<number, HTMLInputElement>());
  const command = useWorkflowCommand();
  const [uploading, setUploading] = useState(false), [uploaded, setUploaded] = useState(false), [uploadUncertain, setUploadUncertain] = useState(false);
  const pendingFile = useRef<File | undefined>(undefined);
  const preferredPrinter = items.find((item) => item.id === projectIntendedPrinterId(project) && isUsableOwnedPrinter(item));
  const preferredSetup = preferredPrinter && project.buildConfigSnapshot?.printerItemId === preferredPrinter.id ? project.buildConfigSnapshot.id : undefined;
  const uploadFile = async (file: File) => {
    if (!onUpload || !project.serverRevisionId || uploading) return;
    const originalFile = pendingFile.current ?? file;
    pendingFile.current = originalFile;
    setUploading(true); setError(undefined); setUploaded(false);
    try {
      const extension = originalFile.name.split(".").pop()?.toLowerCase();
      const role = extension === "stl" ? "STL" : extension === "step" || extension === "stp" ? "STEP" : extension === "3mf" ? "Build plate" : ["scad", "fcstd", "f3d"].includes(extension ?? "") ? "Editable CAD" : "Validation";
      await onUpload(originalFile, role, { kind: "project", projectRevisionId: project.serverRevisionId });
      setUploaded(true); setUploadUncertain(false); pendingFile.current = undefined;
    } catch (failure) {
      const uncertain = uploadUncertain || !(failure instanceof ApiError) || failure.kind === "server" || failure.kind === "offline";
      setUploadUncertain(uncertain);
      if (!uncertain) pendingFile.current = undefined;
      setError(uncertain ? "The file upload was not confirmed. Retry the unchanged file before making other changes." : failure.message);
    }
    finally { setUploading(false); }
  };
  const original: BuildPlanInput = initial ? { expectedVersion: initial.version, name: initial.name, parts: initial.parts, plates: initial.plates, ...(initial.notes ? { notes: initial.notes } : {}) } : { expectedVersion: 0, name: `${project.name} build plan`, parts: [], plates: [] };
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  useUnsavedWork(dirty, "build plan", command.busy || command.uncertain || uploading || uploadUncertain);
  const updatePart = (index: number, patch: Partial<Part>) => setDraft((value) => ({ ...value, parts: value.parts.map((part, i) => i === index ? { ...part, ...patch } : part) }));
  const updatePlate = (index: number, patch: Partial<Plate>) => setDraft((value) => ({ ...value, plates: value.plates.map((plate, i) => i === index ? { ...plate, ...patch } : plate) }));
  const inspect = () => {
    const parsed = buildPlanInputSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.path.length === 1 && issue.path[0] === "parts" && draft.parts.length === 0
        ? "Add at least one required part before reviewing this plan."
        : issue.path[0] === "parts" && typeof issue.path[1] === "number" && issue.path[2] === "name"
          ? `Give part ${issue.path[1] + 1} a name so you can identify it on your plates.`
          : `${issue.path.join(".")}: ${issue.message}`).join("\n"));
      if (draft.parts.length === 0) addPartButton.current?.focus();
      else {
        const missingName = parsed.error.issues.find((issue) => issue.path[0] === "parts" && issue.path[2] === "name");
        if (typeof missingName?.path[1] === "number") partNameInputs.current.get(missingName.path[1])?.focus();
      }
      return;
    }
    setError(undefined);
    setReview(parsed.data);
  };
  const save = async () => { if (!review) return; try { await command.execute(`${root}/build-plan`, "PUT", review, (value) => { const result = mutationValue<BuildPlan>(value, ["id", "version", "contentSha256", "totals"]); if (result.projectRevisionId !== project.serverRevisionId || result.version !== review.expectedVersion + 1) throw new Error("The server did not confirm the saved build plan."); return result; }); onSaved(); } catch { /* retain the exact reviewed draft */ } };
  if (review) return <section className="workflow-review"><h3 ref={reviewHeading} tabIndex={-1}>Review build plan</h3><p>{review.parts.length} parts · {review.plates.length} plate layouts · {review.plates.reduce((sum, plate) => sum + plate.copies, 0)} planned runs</p>{review.plates.map((plate) => <p key={plate.id}>{plate.name}: {plate.copies} runs, with {plate.parts.map((part) => `${part.quantity} × ${review.parts.find((entry) => entry.id === part.partId)?.name}`).join(", ")} per run.</p>)}<p>This records planning intent, not available stock, validated geometry or a completed print.</p>{command.error && <Alert asChild><p role="alert">{command.error}</p></Alert>}<div className="dialog-actions"><Button variant="ghost" type="button" className="button button-quiet" disabled={command.busy || command.uncertain} onClick={() => setReview(undefined)}>Back to build draft</Button><Button variant="default" type="button" className="button button-primary" disabled={command.busy} onClick={() => { void save(); }}>{command.busy ? "Saving…" : command.uncertain ? "Retry unchanged plan" : "Save build plan"}</Button></div></section>;
  const files = (project.allArtifacts ?? project.artifacts).filter((file) => file.status !== "superseded" && (file.workItemRevisionId || file.projectRevisionId === project.serverRevisionId));
  return <><section className="workflow-form" inert={discardOpen || undefined} aria-hidden={discardOpen || undefined}><fieldset className="correction-fields" disabled={uploading || uploadUncertain}><Label className="form-field"><span>Build plan name</span><Input ref={planName} value={draft.name} maxLength={240} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} /></Label>
    {onUpload && <Disclosure className="workflow-extra-fields"><DisclosureTrigger>Add a missing build file</DisclosureTrigger><DisclosureContent><Label className="form-field"><span>Add a missing build file</span><Input type="file" accept=".stl,.step,.stp,.3mf,.scad,.fcstd,.f3d" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadFile(file); }} /></Label><p>This uploads to the current project revision and keeps your build draft. Then choose the uploaded file for its part.</p>{uploading && <p role="status">Uploading build file…</p>}{uploaded && <p role="status">File uploaded. Select it under Design file for the matching part.</p>}</DisclosureContent></Disclosure>}
    <h3>Required parts</h3>{draft.parts.map((part, index) => <div className="intake-row" key={part.id}><Label className="form-field"><span>Part name</span><Input ref={(element) => { if (element) partNameInputs.current.set(index, element); else partNameInputs.current.delete(index); }} aria-label={`Build part ${index + 1} name`} value={part.name} maxLength={240} onChange={(event) => updatePart(index, { name: event.target.value })} /></Label><Label className="form-field"><span>Total required</span><Input aria-label={`Build part ${index + 1} quantity`} type="number" min="1" step="1" value={part.quantity} onChange={(event) => updatePart(index, { quantity: Number(event.target.value) })} /></Label>
      <Label className="form-field"><span>Design file</span><NativeSelect aria-label={`Build part ${index + 1} file`} value={part.artifactId ?? ""} onChange={(event) => { const file = files.find((entry) => entry.id === event.target.value); updatePart(index, { artifactId: file?.id, workItemId: file?.workItemId, workItemRevisionId: file?.workItemRevisionId }); }}><NativeSelectOption value="">Not attached</NativeSelectOption>{part.artifactId && !files.some((file) => file.id === part.artifactId) && <NativeSelectOption value={part.artifactId}>Previously attached file (not loaded)</NativeSelectOption>}{files.map((file) => <NativeSelectOption key={file.id} value={file.id}>{file.name} · {file.revision}</NativeSelectOption>)}</NativeSelect></Label>
      <Button variant="ghost" type="button" className="text-button" onClick={() => setDraft((value) => ({ ...value, parts: value.parts.filter((entry) => entry.id !== part.id), plates: value.plates.map((plate) => ({ ...plate, parts: plate.parts.filter((entry) => entry.partId !== part.id) })) }))}>Remove draft part {index + 1}</Button></div>)}
    <Button ref={addPartButton} variant="outline" type="button" className="button button-secondary" disabled={draft.parts.length >= 100} onClick={() => { setError(undefined); setDraft((value) => ({ ...value, parts: [...value.parts, { id: workflowCommandKey("part"), name: "", quantity: 1 }] })); }}>Add build part</Button>
    <h3>Plate layouts</h3>{projectFabricationRoute(project) !== "printed" && <div><p>Use a printed build approach to add plates. Track other work in task groups, such as wiring or assembly.</p>{onApproach && <Button variant="outline" type="button" onClick={onApproach}>Choose build approach</Button>}</div>}
    {draft.plates.map((plate, index) => <PlateEditor key={plate.id} plate={plate} index={index} parts={draft.parts} project={project} items={items} onChange={(patch) => updatePlate(index, patch)} onRemove={() => setDraft((value) => ({ ...value, plates: value.plates.filter((entry) => entry.id !== plate.id) }))} />)}
    <Button variant="outline" type="button" className="button button-secondary" disabled={draft.plates.length >= 100 || !draft.parts.length || projectFabricationRoute(project) !== "printed"} onClick={() => setDraft((value) => ({ ...value, plates: [...value.plates, { id: workflowCommandKey("plate"), name: `Plate ${value.plates.length + 1}`, copies: 1, ...(preferredPrinter ? { printerItemId: preferredPrinter.id } : {}), ...(preferredSetup ? { buildConfigurationId: preferredSetup } : {}), parts: [{ partId: value.parts[0]!.id, quantity: 1 }], materials: [] }] }))}>Add plate layout</Button>
    <Label className="form-field"><span>Build planning notes</span><Textarea rows={3} maxLength={5000} value={draft.notes ?? ""} onChange={(event) => setDraft((value) => ({ ...value, notes: event.target.value }))} /></Label>
    {error && <Alert asChild><p role="alert" className="form-error workflow-error">{error}</p></Alert>}<div className="dialog-actions"><Button variant="ghost" type="button" className="button button-quiet" ref={cancelButton} onClick={() => { if (dirty) setDiscardOpen(true); else onCancel(); }}>Cancel build draft</Button><Button variant="default" type="button" className="button button-primary" onClick={inspect}>Review build plan</Button></div></fieldset>{uploadUncertain && <Button type="button" disabled={uploading} onClick={() => { if (pendingFile.current) void uploadFile(pendingFile.current); }}>{uploading ? "Retrying upload…" : "Retry unchanged file upload"}</Button>}
  </section>{discardOpen && <WorkspaceModal kind="alertdialog" onClose={keepEditing}><section className="dialog build-discard-dialog"><AlertDialogTitle>Discard build draft?</AlertDialogTitle><AlertDialogDescription>Your unsaved build plan changes will be lost.</AlertDialogDescription><div className="dialog-actions"><Button data-autofocus type="button" variant="outline" onClick={keepEditing}>Keep editing</Button><Button type="button" variant="destructive" onClick={onCancel}>Discard draft</Button></div></section></WorkspaceModal>}</>;
}

function PlateEditor({ plate, index, parts, project, items, onChange, onRemove }: { plate: Plate; index: number; parts: Part[]; project: Project; items: InventoryItem[]; onChange(patch: Partial<Plate>): void; onRemove(): void }) {
  const changeMaterial = (at: number, patch: Partial<Plate["materials"][number]>) => onChange({ materials: plate.materials.map((entry, i) => i === at ? { ...entry, ...patch } : entry) });
  return <Disclosure className="plate-editor" defaultOpen><DisclosureTrigger>Plate {index + 1}: {plate.name}</DisclosureTrigger><DisclosureContent><div className="correction-fields">
    <Label className="form-field"><span>Plate name</span><Input aria-label={`Plate ${index + 1} name`} maxLength={240} value={plate.name} onChange={(event) => onChange({ name: event.target.value })} /></Label>
    <Label className="form-field"><span>Identical runs</span><Input aria-label={`Plate ${index + 1} runs`} type="number" min="1" step="1" value={plate.copies} onChange={(event) => onChange({ copies: Number(event.target.value) })} /></Label>
    <Label className="form-field"><span>Owned printer</span><NativeSelect aria-label={`Plate ${index + 1} printer`} value={plate.printerItemId ?? ""} onChange={(event) => onChange({ printerItemId: event.target.value || undefined, buildConfigurationId: undefined })}><NativeSelectOption value="">Decide later</NativeSelectOption>{items.filter((item) => item.category === "Printers").map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></Label>
    {project.buildConfigSnapshot?.printerItemId === plate.printerItemId && <Label className="check-field"><Checkbox  checked={Boolean(plate.buildConfigurationId)} onCheckedChange={(checked) => onChange({ buildConfigurationId: checked === true ? project.buildConfigSnapshot?.id : undefined })} /><span>Link this revision's recorded printer setup</span></Label>}
    <h4>Parts on one plate</h4>{parts.map((part) => <Label className="form-field" key={part.id}><span>{part.name || "Unnamed part"}</span><Input aria-label={`Plate ${index + 1} quantity ${part.name}`} type="number" min="0" step="1" value={plate.parts.find((entry) => entry.partId === part.id)?.quantity ?? 0} onChange={(event) => { const quantity = Number(event.target.value); onChange({ parts: [...plate.parts.filter((entry) => entry.partId !== part.id), ...(quantity > 0 ? [{ partId: part.id, quantity }] : [])] }); }} /></Label>)}
    <Disclosure className="workflow-extra-fields"><DisclosureTrigger>Material and time estimates</DisclosureTrigger><DisclosureContent><h4>Materials for one run</h4>{plate.materials.map((material, at) => <section className="material-editor" key={at}>
      <Label className="form-field"><span>Filament spool</span><NativeSelect aria-label={`Plate ${index + 1} material ${at + 1}`} value={material.itemId} onChange={(event) => changeMaterial(at, { itemId: event.target.value })}><NativeSelectOption value="">Select owned filament</NativeSelectOption>{items.filter((item) => item.category === "Filament" && item.unit === "g").map((item) => <NativeSelectOption key={item.id} value={item.id}>{[item.name, item.variant, item.location].filter(Boolean).join(" · ")}</NativeSelectOption>)}</NativeSelect></Label>
      <Label className="form-field"><span>Grams per run</span><Input type="number" min="0.01" step="any" value={material.grams} onChange={(event) => changeMaterial(at, { grams: Number(event.target.value) })} /></Label>
      <Label className="form-field"><span>Material role</span><NativeSelect aria-label={`Plate ${index + 1} material role ${at + 1}`} value={material.role} onChange={(event) => changeMaterial(at, { role: event.target.value as typeof material.role })}><NativeSelectOption value="model">Model</NativeSelectOption><NativeSelectOption value="support">Support</NativeSelectOption><NativeSelectOption value="interface">Support interface</NativeSelectOption></NativeSelect></Label>
      <Label className="form-field"><span>Nozzle side</span><NativeSelect aria-label={`Plate ${index + 1} material side ${at + 1}`} value={material.side} onChange={(event) => changeMaterial(at, { side: event.target.value as typeof material.side })}>{["unspecified", "single", "left", "right"].map((value) => <NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect></Label>
      <Button variant="ghost" type="button" className="text-button" onClick={() => onChange({ materials: plate.materials.filter((_, i) => i !== at) })}>Remove material estimate</Button>
    </section>)}
    <Button variant="ghost" type="button" className="button button-quiet" disabled={plate.materials.length >= 16} onClick={() => onChange({ materials: [...plate.materials, { itemId: "", grams: 1, role: "model", side: "unspecified" }] })}>Add material estimate</Button>
    <Label className="form-field"><span>Minutes per run, optional</span><Input type="number" min="0.1" step="any" value={plate.minutes ?? ""} onChange={(event) => onChange({ minutes: event.target.value === "" ? undefined : Number(event.target.value) })} /></Label>
    </DisclosureContent></Disclosure><Button variant="ghost" type="button" className="text-button" onClick={onRemove}>Remove plate {index + 1} from draft</Button>
  </div></DisclosureContent></Disclosure>;
}
