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
    <p className="dialog-intro">Describe → review the requirements and their field mapping → create one project atomically. This flow never reserves stock, buys parts or certifies a build.</p>
    {receipt ? <section role="status"><h3>Project created</h3><p>{receipt.project.name} and {receipt.bomLines.length} requirements were saved. A refresh can be retried without creating the project again.</p></section> : preview ? <section className="setup-review">
      <h3>Review {preview.proposal.project.name}</h3><p>{preview.proposal.bomLines.length} requirements · {preview.proposal.workItems.length} workstreams · no stock reservations.</p>
      <p>Ready {preview.gaps.totals.readyLines ?? 0} · Check {preview.gaps.totals.checkLines ?? 0} · Decide {preview.gaps.totals.decideLines ?? 0} · Source {preview.gaps.totals.sourceLines ?? 0}</p>
      <ol className="setup-review-lines">{preview.proposal.bomLines.map((line) => <li key={line.localRef}><strong>{line.name}</strong><span>{line.requiredQuantity} {line.unit} · {line.role} · {line.optional ? "optional" : "required"}</span>{line.itemId && <small>Selected stock: {line.itemId}. Selection does not prove availability.</small>}</li>)}</ol>
      {preview.fieldErrors.map((issue, index) => <p role="alert" className="form-error" key={index}>{issue.path}: {issue.message}</p>)}
      {preview.unresolvedSpecifications.length > 0 && <p>Some requirements remain Decide. They will be retained as unresolved, not converted into purchase or reservation authority.</p>}
      {expired && !uncertain && <p role="alert">This preview has expired. Return to the draft and review again.</p>}
      {uncertain && <p role="alert">Creation was not confirmed. Retry this unchanged preview to resolve the same command. Do not create a replacement project.</p>}
    </section> : <fieldset disabled={busy} className="correction-fields">
      <label className="form-field"><span>Project name</span><input aria-label="Guided project name" maxLength={240} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="form-field"><span>Project goal</span><textarea aria-label="Guided project goal" rows={3} maxLength={5000} value={goal} onChange={(event) => setGoal(event.target.value)} /></label>
      <label className="form-field"><span>Build approach</span><select aria-label="Guided build approach" value={route} onChange={(event) => setRoute(event.target.value as FabricationRoute)}><option value="undecided">Decide later</option><option value="printed">3D printed parts</option><option value="ready_made">Ready-made parts</option><option value="none">Electronics or assembly only</option></select></label>
      {route === "printed" && <label className="form-field"><span>Owned printer, optional</span><select aria-label="Guided owned printer" value={printerId} onChange={(event) => setPrinterId(event.target.value)}><option value="">Not selected</option>{items.filter((item) => item.category === "Printers").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <details><summary>Start from a maker template</summary><p>Templates are editable prompts, not validated designs. Placeholder quantities must be reviewed.</p><div className="setup-template-actions">{makerIntakeTemplates.map((template) => <button type="button" className="button button-quiet" key={template.id} disabled={rows.length > 0} onClick={() => { setRoute(template.route); setRows(template.rows.map((row) => ({ ...row, needsDecision: true }))); setWorkNames(template.workItems.map((work) => work.name).join("\n")); }}>{template.name}</button>)}</div>{rows.length > 0 && <p>Templates are disabled while a draft contains requirements, so they cannot overwrite it.</p>}</details>
      <details><summary>Import requirements CSV</summary><p>CSV replaces the draft requirements only after mapping review. It never replaces existing workspace records. Max 24 requirements, 256 KiB. Formulas are not evaluated.</p>
        <input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" aria-label="Choose BOM CSV" onChange={(event) => { const file = event.target.files?.[0]; if (file) void run(async () => { if (file.size > MAX_BOM_INTAKE_BYTES) throw new Error("The CSV exceeds 256 KiB."); const text = await file.text(); setSource(text); setTable(undefined); }); }} />
        <label className="form-field"><span>CSV text</span><textarea aria-label="BOM CSV text" rows={5} value={source} onChange={(event) => { setSource(event.target.value); setTable(undefined); }} /></label>
        <label className="form-field"><span>Delimiter</span><select aria-label="CSV delimiter" value={delimiter} onChange={(event) => { setDelimiter(event.target.value as typeof delimiter); setTable(undefined); }}><option value=",">Comma</option><option value=";">Semicolon</option><option value="\t">Tab</option></select></label><button type="button" className="button button-secondary" onClick={readCsv}>Review CSV mapping</button>
        {table && <section className="csv-mapping"><h3>Map {table.rows.length} CSV rows</h3>{fields.map(([key, label]) => <label className="form-field" key={key}><span>{label}</span><select aria-label={`CSV ${label} column`} value={mapping[key] ?? ""} onChange={(event) => setMapping((current) => { const next = { ...current }; if (event.target.value === "") delete next[key]; else next[key] = Number(event.target.value); return next; })}><option value="">{key === "name" || key === "quantity" ? "Choose a column" : "Not mapped"}</option>{table.headers.map((header, index) => <option key={index} value={index}>{index + 1}. {header}</option>)}</select></label>)}
          <label className="form-field"><span>Default unit when no unit column is mapped</span><select aria-label="CSV default unit" value={defaultUnit} onChange={(event) => setDefaultUnit(event.target.value as BomIntakeUnit)}>{units.map((unit) => <option key={unit}>{unit}</option>)}</select></label>
          <label className="form-field"><span>Default use when no use column is mapped</span><select aria-label="CSV default use" value={defaultRole} onChange={(event) => setDefaultRole(event.target.value as typeof defaultRole)}><option value="consumed">Part or material</option><option value="reusable">Reusable tool</option></select></label>
          <label className="form-field"><span>Decimal convention</span><select aria-label="CSV decimal convention" value={decimal} onChange={(event) => setDecimal(event.target.value as typeof decimal)}><option value="dot">Decimal point</option><option value="comma">Decimal comma</option></select></label>
          <p>Inventory identifiers are deliberately not auto-mapped. Map that column only when these are exact existing stock IDs. Other columns are ignored.</p><button type="button" className="button button-secondary" onClick={applyCsv}>Use mapped requirements in draft</button>
        </section>}
      </details>
      <h3>Requirements ({rows.length}/24)</h3>
      {rows.map((row, index) => <section className="intake-row" key={index} aria-label={`Draft requirement ${index + 1}`}>
        <label className="form-field"><span>Name</span><input aria-label={`Requirement ${index + 1} name`} maxLength={240} value={row.name} onChange={(event) => update(index, { name: event.target.value })} /></label>
        <div className="form-row"><label className="form-field"><span>Quantity</span><input aria-label={`Requirement ${index + 1} quantity`} type="number" min="0.000001" step="any" value={row.requiredQuantity} onChange={(event) => update(index, { requiredQuantity: Number(event.target.value) })} /></label><label className="form-field"><span>Unit</span><select aria-label={`Requirement ${index + 1} unit`} value={row.unit} onChange={(event) => update(index, { unit: event.target.value as BomIntakeUnit })}>{units.map((unit) => <option key={unit}>{unit}</option>)}</select></label></div>
        <label className="form-field"><span>Use</span><select aria-label={`Requirement ${index + 1} use`} value={row.role} onChange={(event) => update(index, { role: event.target.value as typeof row.role })}><option value="consumed">Part or material</option><option value="reusable">Reusable tool or equipment</option></select></label>
        <label className="form-field"><span>Owned item, optional</span><select aria-label={`Requirement ${index + 1} owned item`} value={row.itemId ?? ""} onChange={(event) => update(index, { itemId: event.target.value || undefined })}><option value="">No owned item selected</option>{row.itemId && !items.some((item) => item.id === row.itemId) && <option value={row.itemId}>Imported ID: {row.itemId}</option>}{items.filter((item) => item.category !== "Printers").map((item) => <option key={item.id} value={item.id}>{[item.name, item.variant, item.location].filter(Boolean).join(" · ")}</option>)}</select></label>
        <label className="form-field"><span>Key specification or decision, optional</span><input aria-label={`Requirement ${index + 1} specification`} maxLength={240} value={row.specification ?? ""} onChange={(event) => update(index, { specification: event.target.value })} /></label>
        <label className="check-field"><input type="checkbox" checked={row.needsDecision ?? false} onChange={(event) => update(index, { needsDecision: event.target.checked })} /><span>Specification still needs a decision</span></label>
        <label className="check-field"><input type="checkbox" checked={row.optional} onChange={(event) => update(index, { optional: event.target.checked })} /><span>Optional requirement</span></label>
        <label className="form-field"><span>Notes</span><textarea rows={2} maxLength={2000} value={row.notes ?? ""} onChange={(event) => update(index, { notes: event.target.value })} /></label><button type="button" className="text-button" onClick={() => setRows((all) => all.filter((_, i) => i !== index))}>Remove draft row {index + 1}</button>
      </section>)}
      <button type="button" className="button button-secondary" disabled={rows.length >= 24} onClick={() => setRows((all) => [...all, { name: "", requiredQuantity: 1, unit: "each", role: "consumed", optional: false }])}>Add draft requirement</button>
      <label className="form-field"><span>Workstreams, one per line, up to six</span><textarea aria-label="Setup workstreams" maxLength={1440} rows={3} value={workNames} onChange={(event) => setWorkNames(event.target.value)} /></label>
    </fieldset>}
    {error && <p role="alert" className="form-error workflow-error">{error}</p>}
    <div className="dialog-actions">{preview && !receipt && <button type="button" className="button button-quiet" disabled={busy || uncertain} onClick={() => { setPreview(undefined); setError(undefined); }}>Back to draft</button>}
      <button type="button" className="button button-primary" disabled={busy || (!preview && (!name.trim() || !goal.trim() || rows.length === 0)) || (preview !== undefined && !receipt && (preview.fieldErrors.length > 0 || expired && !uncertain))} onClick={() => { void run(preview || receipt ? commit : requestPreview); }}>{busy ? "Working…" : receipt ? "Open created project" : preview ? uncertain ? "Retry unchanged creation" : "Create reviewed project" : "Preview complete project"}</button>
    </div>
  </div>;
}
