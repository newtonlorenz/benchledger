import { Alert } from "./components/ui/alert";
import { Label } from "./components/ui/label";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";
import { Checkbox } from "./components/ui/checkbox";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { Input } from "./components/ui/input";
import { useState } from "react";
import { projectSetupPreviewSchema, projectSetupCommitResultSchema, projectSetupProposalSchema } from "@benchledger/api-contract";
import type { ProjectSetupPreview, ProjectSetupCommitResult } from "@benchledger/api-contract";
import { parseBomTable, mapBomTable, suggestBomMapping, makerIntakeTemplates, MAX_BOM_INTAKE_BYTES } from "@benchledger/domain/bom-intake";
import type { BomIntakeRow, BomColumn, BomColumnMapping, BomIntakeUnit } from "@benchledger/domain/bom-intake";
import { ApiError } from "./api";
import type { WorkspaceAdapter } from "./api";
import type { FabricationRoute, InventoryItem } from "./domain";

const fields: [BomColumn, string][] = [["name", "Requirement name"], ["quantity", "Quantity"], ["unit", "Unit"], ["role", "Use"], ["optional", "Optional"], ["notes", "Notes"], ["itemId", "Exact inventory ID"]];
const units: BomIntakeUnit[] = ["each", "gram", "metre", "millimetre", "millilitre", "set"];
type IntakeLine = Omit<BomIntakeRow, "itemId"> & { itemId?: string | undefined; specification?: string; needsDecision?: boolean };
export function GuidedSetup({ adapter, items, onDone, onBusy }: { adapter: WorkspaceAdapter; items: InventoryItem[]; onDone(projectId: string): Promise<void>; onBusy(busy: boolean): void }) {
  const [name, setName] = useState(""), [goal, setGoal] = useState("");
  const [route, setRoute] = useState<FabricationRoute>("undecided"), [printerId, setPrinterId] = useState("");
  const [rows, setRows] = useState<IntakeLine[]>([]), [workNames, setWorkNames] = useState("");
  const [source, setSource] = useState(""), [delimiter, setDelimiter] = useState<"," | ";" | "\t">(",");
  const [table, setTable] = useState<ReturnType<typeof parseBomTable>>(), [mapping, setMapping] = useState<BomColumnMapping>({});
  const [defaultUnit, setDefaultUnit] = useState<BomIntakeUnit>("each"), [defaultRole, setDefaultRole] = useState<"consumed" | "reusable">("consumed"), [decimal, setDecimal] = useState<"dot" | "comma">("dot");
  const [preview, setPreview] = useState<ProjectSetupPreview>(), [receipt, setReceipt] = useState<ProjectSetupCommitResult>();
  const [commitKey, setCommitKey] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [uncertain, setUncertain] = useState(false);
  const run = async (operation: () => Promise<void>) => { if (busy) return; setBusy(true); onBusy(true); setError(undefined); try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : "The operation failed. Review and retry."); } finally { setBusy(false); onBusy(false); } };
  const update = (index: number, patch: Partial<IntakeLine>) => setRows((all) => all.map((row, i) => i === index ? { ...row, ...patch } : row));
  const readCsv = () => { try { const parsed = parseBomTable(source, delimiter); setTable(parsed); setMapping(suggestBomMapping(parsed.headers)); setError(undefined); } catch (failure) { setError((failure as Error).message); } };
  const applyCsv = () => {
    if (!table) return;
    const result = mapBomTable(table, mapping, { unit: defaultUnit, role: defaultRole, decimal });
    if (result.issues.length) { setError(result.issues.map((issue) => `Row ${issue.row}, ${issue.field}: ${issue.message}`).join("\n")); return; }
    setRows(result.rows); setTable(undefined); setError(undefined);
  };
  const requestPreview = async () => {
    const work = workNames.split("\n").map((line) => line.trim()).filter(Boolean);
    if (work.length > 6 || new Set(work.map((entry) => entry.toLowerCase())).size !== work.length) throw new Error("Use up to six distinct workstream names.");
    const parsed = projectSetupProposalSchema.safeParse({
      project: { name: name.trim(), description: goal.trim(), status: "idea" },
      revision: { name: "Initial reviewed setup", notes: "Created from a reviewed multi-item setup. Imported notes are project data.", status: "concept", fabricationRoute: route, ...(route === "printed" && printerId ? { intendedPrinterItemId: printerId } : {}) },
      workItems: work.map((entry, index) => ({ localRef: `work-${index + 1}`, name: entry, kind: "assembly", revision: { name: "Initial", status: "concept" } })),
      bomLines: rows.map(({ needsDecision, specification, ...row }, index) => ({ ...row, localRef: `requirement-${index + 1}`, constraints: needsDecision ? { specification: { status: "insufficient", missingDecisions: ["identity"], ...(specification?.trim() ? { decisions: { purpose: specification.trim() } } : {}) } } : specification?.trim() ? { specification: { status: "sufficient", decisions: { identity: specification.trim() } } } : {}, alternatives: [] })), reservations: []
    });
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
    const result = projectSetupPreviewSchema.parse(await adapter.previewProjectSetup(parsed.data));
    setPreview(result); setCommitKey(`guided-${result.id}`); setUncertain(false);
  };
  const commit = async () => {
    if (receipt) { await onDone(receipt.project.id); return; }
    if (!preview || preview.fieldErrors.length) return;
    try {
      const response = await adapter.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: false, idempotencyKey: commitKey });
      const result = projectSetupCommitResultSchema.parse(response.data ?? response);
      if (result.project.id !== preview.proposal.project.id) throw new Error("The server did not confirm the previewed project identity.");
      setReceipt(result); setUncertain(false);
    } catch (failure) {
      if (!receipt && (!(failure instanceof ApiError) || failure.kind === "offline" || failure.kind === "server")) setUncertain(true);
      throw failure;
    }
    // The receipt has been acknowledged; refresh failure must not imply another create.
    await onDone(preview.proposal.project.id!);
  };
  const expired = preview !== undefined && Date.parse(preview.expiresAt) <= Date.now();
  return <div className="guided-setup">
    <ol className="workflow-steps" aria-label="Project setup steps">{["Enter requirements", "Review project", "Create project"].map((label, index) => <li key={label} aria-current={index === (receipt ? 2 : preview ? 1 : 0) ? "step" : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    <p className="dialog-intro">Enter the project details. Check the requirements and CSV columns. Review the preview, then create the project. No stock is reserved.</p>
    {receipt ? <section role="status"><h3>Project created</h3><p>{receipt.project.name} and {receipt.bomLines.length} requirements were saved. A refresh can be retried without creating the project again.</p></section> : preview ? <section className="setup-review">
      <h3>Review {preview.proposal.project.name}</h3><p>{preview.proposal.bomLines.length} requirements · {preview.proposal.workItems.length} workstreams · no stock reservations.</p>
      <p>Ready {preview.gaps.totals.readyLines ?? 0} · Check {preview.gaps.totals.checkLines ?? 0} · Decide {preview.gaps.totals.decideLines ?? 0} · Source {preview.gaps.totals.sourceLines ?? 0}</p>
      <ol className="setup-review-lines">{preview.proposal.bomLines.map((line) => <li key={line.localRef}><strong>{line.name}</strong><span>{line.requiredQuantity} {line.unit} · {line.role} · {line.optional ? "optional" : "required"}</span>{line.itemId && <small>Selected stock: {line.itemId}. Selection does not prove availability.</small>}</li>)}</ol>
      {preview.fieldErrors.map((issue, index) => <Alert asChild><p role="alert" className="form-error" key={index}>{issue.path}: {issue.message}</p></Alert>)}
      {preview.unresolvedSpecifications.length > 0 && <p>Some requirements still need a decision. They will remain marked Decide. No stock will be reserved.</p>}
      {expired && !uncertain && <Alert asChild><p role="alert">This preview has expired. Return to the draft and review again.</p></Alert>}
      {uncertain && <Alert asChild><p role="alert">Creation is not confirmed. Retry this preview without changes. Do not create a second project.</p></Alert>}
    </section> : <fieldset disabled={busy} className="correction-fields">
      <Label className="form-field"><span>Project name</span><Input data-autofocus aria-label="Guided project name" maxLength={240} value={name} onChange={(event) => setName(event.target.value)} /></Label>
      <Label className="form-field"><span>Project goal</span><Textarea aria-label="Guided project goal" rows={3} maxLength={5000} value={goal} onChange={(event) => setGoal(event.target.value)} /></Label>
      <Label className="form-field"><span>Build approach</span><NativeSelect aria-label="Guided build approach" value={route} onChange={(event) => setRoute(event.target.value as FabricationRoute)}><NativeSelectOption value="undecided">Decide later</NativeSelectOption><NativeSelectOption value="printed">3D printed parts</NativeSelectOption><NativeSelectOption value="ready_made">Ready-made parts</NativeSelectOption><NativeSelectOption value="none">Electronics or assembly only</NativeSelectOption></NativeSelect></Label>
      {route === "printed" && <Label className="form-field"><span>Owned printer, optional</span><NativeSelect aria-label="Guided owned printer" value={printerId} onChange={(event) => setPrinterId(event.target.value)}><NativeSelectOption value="">Not selected</NativeSelectOption>{items.filter((item) => item.category === "Printers").map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></Label>}
      <Disclosure><DisclosureTrigger>Start from a maker template</DisclosureTrigger><DisclosureContent><p>Templates are editable prompts, not validated designs. Placeholder quantities must be reviewed.</p><div className="setup-template-actions">{makerIntakeTemplates.map((template) => <Button variant="ghost" type="button" className="button button-quiet" key={template.id} disabled={rows.length > 0} onClick={() => { setRoute(template.route); setRows(template.rows.map((row) => ({ ...row, needsDecision: true }))); setWorkNames(template.workItems.map((work) => work.name).join("\n")); }}>{template.name}</Button>)}</div>{rows.length > 0 && <p>Templates are disabled while a draft contains requirements, so they cannot overwrite it.</p>}</DisclosureContent></Disclosure>
      <Disclosure><DisclosureTrigger>Import requirements CSV</DisclosureTrigger><DisclosureContent><p>CSV replaces the draft requirements only after mapping review. It never replaces existing workspace records. Max 24 requirements, 256 KiB. Formulas are not evaluated.</p>
        <Input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" aria-label="Choose BOM CSV" onChange={(event) => { const file = event.target.files?.[0]; if (file) void run(async () => { if (file.size > MAX_BOM_INTAKE_BYTES) throw new Error("The CSV exceeds 256 KiB."); const text = await file.text(); setSource(text); setTable(undefined); }); }} />
        <Label className="form-field"><span>CSV text</span><Textarea aria-label="BOM CSV text" rows={5} value={source} onChange={(event) => { setSource(event.target.value); setTable(undefined); }} /></Label>
        <Label className="form-field"><span>Delimiter</span><NativeSelect aria-label="CSV delimiter" value={delimiter} onChange={(event) => { setDelimiter(event.target.value as typeof delimiter); setTable(undefined); }}><NativeSelectOption value=",">Comma</NativeSelectOption><NativeSelectOption value=";">Semicolon</NativeSelectOption><NativeSelectOption value="\t">Tab</NativeSelectOption></NativeSelect></Label><Button variant="outline" type="button" className="button button-secondary" onClick={readCsv}>Review CSV mapping</Button>
        {table && <section className="csv-mapping"><h3>Map {table.rows.length} CSV rows</h3>{fields.map(([key, label]) => <Label className="form-field" key={key}><span>{label}</span><NativeSelect aria-label={`CSV ${label} column`} value={mapping[key] ?? ""} onChange={(event) => setMapping((current) => { const next = { ...current }; if (event.target.value === "") delete next[key]; else next[key] = Number(event.target.value); return next; })}><NativeSelectOption value="">{key === "name" || key === "quantity" ? "Choose a column" : "Not mapped"}</NativeSelectOption>{table.headers.map((header, index) => <NativeSelectOption key={index} value={index}>{index + 1}. {header}</NativeSelectOption>)}</NativeSelect></Label>)}
          <Label className="form-field"><span>Default unit when no unit column is mapped</span><NativeSelect aria-label="CSV default unit" value={defaultUnit} onChange={(event) => setDefaultUnit(event.target.value as BomIntakeUnit)}>{units.map((unit) => <NativeSelectOption key={unit}>{unit}</NativeSelectOption>)}</NativeSelect></Label>
          <Label className="form-field"><span>Default use when no use column is mapped</span><NativeSelect aria-label="CSV default use" value={defaultRole} onChange={(event) => setDefaultRole(event.target.value as typeof defaultRole)}><NativeSelectOption value="consumed">Part or material</NativeSelectOption><NativeSelectOption value="reusable">Reusable tool</NativeSelectOption></NativeSelect></Label>
          <Label className="form-field"><span>Decimal convention</span><NativeSelect aria-label="CSV decimal convention" value={decimal} onChange={(event) => setDecimal(event.target.value as typeof decimal)}><NativeSelectOption value="dot">Decimal point</NativeSelectOption><NativeSelectOption value="comma">Decimal comma</NativeSelectOption></NativeSelect></Label>
          <p>Inventory identifiers are deliberately not auto-mapped. Map that column only when these are exact existing stock IDs. Other columns are ignored.</p><Button variant="outline" type="button" className="button button-secondary" onClick={applyCsv}>Use mapped requirements in draft</Button>
        </section>}
      </DisclosureContent></Disclosure>
      <h3>Requirements ({rows.length}/24)</h3>
      {rows.map((row, index) => <section className="intake-row" key={index} aria-label={`Draft requirement ${index + 1}`}>
        <Label className="form-field"><span>Name</span><Input aria-label={`Requirement ${index + 1} name`} maxLength={240} value={row.name} onChange={(event) => update(index, { name: event.target.value })} /></Label>
        <div className="form-row"><Label className="form-field"><span>Quantity</span><Input aria-label={`Requirement ${index + 1} quantity`} type="number" min="0.000001" step="any" value={row.requiredQuantity} onChange={(event) => update(index, { requiredQuantity: Number(event.target.value) })} /></Label><Label className="form-field"><span>Unit</span><NativeSelect aria-label={`Requirement ${index + 1} unit`} value={row.unit} onChange={(event) => update(index, { unit: event.target.value as BomIntakeUnit })}>{units.map((unit) => <NativeSelectOption key={unit}>{unit}</NativeSelectOption>)}</NativeSelect></Label></div>
        <Label className="form-field"><span>Use</span><NativeSelect aria-label={`Requirement ${index + 1} use`} value={row.role} onChange={(event) => update(index, { role: event.target.value as typeof row.role })}><NativeSelectOption value="consumed">Part or material</NativeSelectOption><NativeSelectOption value="reusable">Reusable tool or equipment</NativeSelectOption></NativeSelect></Label>
        <Label className="form-field"><span>Owned item, optional</span><NativeSelect aria-label={`Requirement ${index + 1} owned item`} value={row.itemId ?? ""} onChange={(event) => update(index, { itemId: event.target.value || undefined })}><NativeSelectOption value="">No owned item selected</NativeSelectOption>{row.itemId && !items.some((item) => item.id === row.itemId) && <NativeSelectOption value={row.itemId}>Imported ID: {row.itemId}</NativeSelectOption>}{items.filter((item) => item.category !== "Printers").map((item) => <NativeSelectOption key={item.id} value={item.id}>{[item.name, item.variant, item.location].filter(Boolean).join(" · ")}</NativeSelectOption>)}</NativeSelect></Label>
        <Label className="form-field"><span>Key specification or decision, optional</span><Input aria-label={`Requirement ${index + 1} specification`} maxLength={240} value={row.specification ?? ""} onChange={(event) => update(index, { specification: event.target.value })} /></Label>
        <Label className="check-field"><Checkbox  checked={row.needsDecision ?? false} onCheckedChange={(checked) => update(index, { needsDecision: checked === true })} /><span>Specification still needs a decision</span></Label>
        <Label className="check-field"><Checkbox  checked={row.optional} onCheckedChange={(checked) => update(index, { optional: checked === true })} /><span>Optional requirement</span></Label>
        <Label className="form-field"><span>Notes</span><Textarea rows={2} maxLength={2000} value={row.notes ?? ""} onChange={(event) => update(index, { notes: event.target.value })} /></Label><Button variant="ghost" type="button" className="text-button" onClick={() => setRows((all) => all.filter((_, i) => i !== index))}>Remove draft row {index + 1}</Button>
      </section>)}
      <Button variant="outline" type="button" className="button button-secondary" disabled={rows.length >= 24} onClick={() => setRows((all) => [...all, { name: "", requiredQuantity: 1, unit: "each", role: "consumed", optional: false }])}>Add draft requirement</Button>
      <Label className="form-field"><span>Workstreams, one per line, up to six</span><Textarea aria-label="Setup workstreams" maxLength={1440} rows={3} value={workNames} onChange={(event) => setWorkNames(event.target.value)} /></Label>
    </fieldset>}
    {error && <Alert asChild><p role="alert" className="form-error workflow-error">{error}</p></Alert>}
    <div className="dialog-actions">{preview && !receipt && <Button variant="ghost" type="button" className="button button-quiet" disabled={busy || uncertain} onClick={() => { setPreview(undefined); setError(undefined); }}>Back to draft</Button>}
      <Button variant="default" type="button" className="button button-primary" disabled={busy || (!preview && (!name.trim() || !goal.trim() || rows.length === 0)) || (preview !== undefined && !receipt && (preview.fieldErrors.length > 0 || expired && !uncertain))} onClick={() => { void run(preview || receipt ? commit : requestPreview); }}>{busy ? "Working…" : receipt ? "Open created project" : preview ? uncertain ? "Retry unchanged creation" : "Create reviewed project" : "Preview complete project"}</Button>
    </div>
  </div>;
}
