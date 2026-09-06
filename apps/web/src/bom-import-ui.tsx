import { useState, useEffect } from "react";
import type { BomImportPreview, BomLine } from "@benchledger/api-contract";
import { parseBomTable, mapBomTable, suggestBomMapping, MAX_BOM_INTAKE_BYTES } from "@benchledger/domain/bom-intake";
import type { BomColumn, BomColumnMapping, BomIntakeUnit } from "@benchledger/domain/bom-intake";
import type { Project } from "./domain";
import { workflowRequest } from "./api";
import { mutationValue, revisionWorkflowPath, useWorkflowCommand } from "./workflow-ui";
const fields: [BomColumn, string][] = [["name", "Name"], ["quantity", "Quantity"], ["unit", "Unit"], ["role", "Use"], ["optional", "Optional"], ["notes", "Notes"], ["itemId", "Exact inventory ID"]];
export function ExistingBomImport({ project, onRefresh, onBusy }: { project: Project; onRefresh(): Promise<boolean>; onBusy?: ((busy: boolean) => void) | undefined }) {
  const [text, setText] = useState(""), [delimiter, setDelimiter] = useState<"," | ";" | "\t">(","), [decimal, setDecimal] = useState<"dot" | "comma">("dot");
  const [table, setTable] = useState<ReturnType<typeof parseBomTable>>(), [mapping, setMapping] = useState<BomColumnMapping>({});
  const [unit, setUnit] = useState<BomIntakeUnit>("each"), [role, setRole] = useState<"consumed" | "reusable">("consumed"), [duplicates, setDuplicates] = useState(false);
  const [preview, setPreview] = useState<BomImportPreview>(), [saved, setSaved] = useState<number>(), [error, setError] = useState<string>(), [previewBusy, setPreviewBusy] = useState(false);
  const command = useWorkflowCommand();
  useEffect(() => { onBusy?.(command.busy || command.uncertain); return () => onBusy?.(false); }, [command.busy, command.uncertain, onBusy]);
  const root = project.serverRevisionId ? revisionWorkflowPath(project.id, project.serverRevisionId) : undefined;
  const parse = () => { try { const value = parseBomTable(text, delimiter); setTable(value); setMapping(suggestBomMapping(value.headers)); setError(undefined); } catch (failure) { setError((failure as Error).message); } };
  const review = async () => {
    if (!table || !root || previewBusy) return; setError(undefined); setPreviewBusy(true);
    try { const mapped = mapBomTable(table, mapping, { unit, role, decimal }); if (mapped.issues.length) throw new Error(mapped.issues.map((issue) => `Row ${issue.row}, ${issue.field}: ${issue.message}`).join("\n"));
      const result = await workflowRequest<BomImportPreview>(`${root}/bom-import/previews`, "POST", { rows: mapped.rows.map((row) => ({ ...row, constraints: {}, alternatives: [] })), allowDuplicateNames: duplicates });
      if (!result.id || result.projectRevisionId !== project.serverRevisionId || !Array.isArray(result.rows) || !result.contentSha256) throw new Error("The server did not return a valid import preview."); setPreview(result);
    } catch (failure) { setError((failure as Error).message); } finally { setPreviewBusy(false); }
  };
  const commit = async () => {
    if (!preview || !root) return;
    try { const result = await command.execute(`${root}/bom-import/commit`, "POST", { previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmed: true }, (value) => mutationValue<{ lines: BomLine[]; previewId: string }>(value, ["lines", "previewId"])); setSaved(result.lines.length); if (!await onRefresh()) setError("The import was saved, but readiness could not refresh. Reload the project; do not re-import."); } catch { /* retry the same command without losing the reviewed rows */ }
  };
  if (!root || project.status === "archived") return null;
  if (saved !== undefined) return <section role="status"><h3>{saved} requirements imported</h3><p>Existing requirements and stock were not replaced.</p>{error && <p role="alert">{error}</p>}<button className="button button-quiet" onClick={() => { void onRefresh(); }}>Refresh imported requirements</button></section>;
  return <section className="surface bom-import" aria-label="Import requirements"><h2>Append requirements from CSV</h2><p>Import up to 24 rows. Check the column mapping and units, then review the import. Existing requirements and stock records are not replaced.</p>
    {preview ? <section><h3>Review {preview.rows.length} new requirements</h3>{preview.rows.map((row) => <p key={row.id}><strong>{row.name}</strong>: {row.requiredQuantity} {row.unit} · {row.role} · {row.optional ? "optional" : "required"}</p>)}{preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}<div className="dialog-actions"><button type="button" className="button button-quiet" disabled={command.busy || command.uncertain} onClick={() => setPreview(undefined)}>Back to import mapping</button><button type="button" className="button button-primary" disabled={command.busy} onClick={() => { void commit(); }}>{command.uncertain ? "Retry unchanged import" : "Confirm append requirements"}</button></div></section> : <fieldset className="correction-fields" disabled={previewBusy}>
      <input type="file" accept=".csv,.tsv,text/csv" aria-label="Choose requirements CSV" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; void (async () => { try { if (file.size > MAX_BOM_INTAKE_BYTES) throw new Error("The CSV exceeds 256 KiB."); setText(await file.text()); setTable(undefined); } catch (failure) { setError((failure as Error).message); } })(); }} />
      <label className="form-field"><span>Requirements CSV text</span><textarea data-autofocus rows={5} value={text} onChange={(event) => { setText(event.target.value); setTable(undefined); }} /></label>
      <label className="form-field"><span>CSV delimiter</span><select aria-label="Import delimiter" value={delimiter} onChange={(event) => { setDelimiter(event.target.value as typeof delimiter); setTable(undefined); }}><option value=",">Comma</option><option value=";">Semicolon</option><option value="\t">Tab</option></select></label><button type="button" className="button button-secondary" onClick={parse}>Map import columns</button>
      {table && <section className="csv-mapping"><h3>{table.rows.length} rows to map</h3>{fields.map(([key, label]) => <label className="form-field" key={key}><span>{label}</span><select aria-label={`Import ${label} column`} value={mapping[key] ?? ""} onChange={(event) => setMapping((current) => { const next = { ...current }; if (!event.target.value) delete next[key]; else next[key] = Number(event.target.value); return next; })}><option value="">Not mapped</option>{table.headers.map((header, index) => <option key={index} value={index}>{header}</option>)}</select></label>)}
        <label className="form-field"><span>Default unit for an unmapped unit column</span><select aria-label="Import default unit" value={unit} onChange={(event) => setUnit(event.target.value as BomIntakeUnit)}>{["each", "gram", "metre", "millimetre", "millilitre", "set"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="form-field"><span>Default use for an unmapped use column</span><select aria-label="Import default use" value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="consumed">Part or material</option><option value="reusable">Reusable tool</option></select></label>
        <label className="form-field"><span>Decimal convention</span><select aria-label="Import decimal convention" value={decimal} onChange={(event) => setDecimal(event.target.value as typeof decimal)}><option value="dot">Decimal point</option><option value="comma">Decimal comma</option></select></label>
        <label className="check-field"><input type="checkbox" checked={duplicates} onChange={(event) => setDuplicates(event.target.checked)} /><span>I reviewed and allow duplicate requirement names</span></label><p>Inventory ID columns are not auto-mapped. Map one only for existing stock in this workspace.</p><button type="button" className="button button-primary" onClick={() => { void review(); }}>{previewBusy ? "Reviewing…" : "Preview requirement append"}</button>
      </section>}
    </fieldset>}{(error || command.error) && <p className="form-error workflow-error" role="alert">{command.error ?? error}</p>}
  </section>;
}
