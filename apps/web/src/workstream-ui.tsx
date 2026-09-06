import { useState } from "react";
import type { WorkItem, WorkItemRevision, WorkAssignment, ProjectRevision, BomLine, Artifact } from "@benchledger/api-contract";
import type { Project } from "./domain";
import { useWorkflowRead, useWorkflowCommand, mutationValue, revisionWorkflowPath } from "./workflow-ui";
interface WorkRow { item: WorkItem; revision: WorkItemRevision | null; assignment: WorkAssignment | null }
interface WorkPage { data: WorkRow[]; total: number; nextCursor?: string }

export function WorkstreamPlanning({ project, readOnly = false }: { project: Project; readOnly?: boolean }) {
  const root = `/projects/${encodeURIComponent(project.id)}`;
  const [cursor, setCursor] = useState<string>(), [creating, setCreating] = useState(false);
  const source = useWorkflowRead<WorkPage>(`${root}/workstreams?limit=20${cursor ? `&cursor=${cursor}` : ""}`);
  const team = useWorkflowRead<{ members: { id: string; name: string }[] }>("/team/directory");
  return <section className="surface workstream-planning" aria-label="Workstreams">
    <h2>Workstreams</h2><p>Track design, electronics, firmware and assembly separately. A workstream marked done does not certify a physical build.</p>
    {source.loading && <p role="status">Loading workstreams…</p>}{source.error && <p role="alert">{source.error}</p>}
    {source.data?.data.map((row) => <WorkstreamRow key={`${row.item.id}:${row.assignment?.version ?? 0}`} row={row} root={root} members={team.data?.members ?? []} readOnly={readOnly || project.status === "archived"} onSaved={source.reload} />)}
    {source.data?.total === 0 && <p>No workstreams yet. Add a bounded piece of work to start.</p>}
    {!readOnly && project.status !== "archived" && (creating ? <NewWorkstream root={root} onCancel={() => setCreating(false)} onSaved={() => { setCreating(false); source.reload(); }} /> : <button type="button" className="button button-secondary" onClick={() => setCreating(true)}>Add workstream</button>)}
    <div className="workflow-pagination">{cursor && <button type="button" className="button button-quiet" onClick={() => setCursor(undefined)}>First workstreams</button>}{source.data?.nextCursor && <button type="button" className="button button-quiet" onClick={() => setCursor(source.data!.nextCursor)}>Next workstreams</button>}<button type="button" className="text-button" onClick={source.reload}>Refresh workstreams</button></div>
    <RevisionHistory project={project} />
  </section>;
}
function NewWorkstream({ root, onCancel, onSaved }: { root: string; onCancel(): void; onSaved(): void }) {
  const [name, setName] = useState(""), [kind, setKind] = useState("assembly");
  const command = useWorkflowCommand();
  const save = async () => { try { await command.execute(`${root}/workstreams`, "POST", { name: name.trim(), kind }, (value) => mutationValue(value, ["item", "revision"])); onSaved(); } catch { /* keep the draft and command identity */ } };
  return <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><fieldset className="correction-fields" disabled={command.busy || command.uncertain}><label className="form-field"><span>Workstream name</span><input required maxLength={240} value={name} onChange={(event) => setName(event.target.value)} /></label><label className="form-field"><span>Work type</span><select aria-label="Workstream type" value={kind} onChange={(event) => setKind(event.target.value)}>{["part", "assembly", "electronics", "firmware", "document", "other"].map((value) => <option key={value}>{value}</option>)}</select></label></fieldset>{command.error && <p role="alert">{command.error}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" disabled={command.busy || command.uncertain} onClick={onCancel}>Cancel workstream</button><button type="submit" className="button button-primary" disabled={command.busy || !name.trim()}>{command.uncertain ? "Retry unchanged workstream" : "Create workstream"}</button></div></form>;
}
function WorkstreamRow({ row, root, members, readOnly, onSaved }: { row: WorkRow; root: string; members: { id: string; name: string }[]; readOnly: boolean; onSaved(): void }) {
  const [status, setStatus] = useState(row.assignment?.status ?? "todo"), [due, setDue] = useState(row.assignment?.dueDate ?? ""), [notes, setNotes] = useState(row.assignment?.notes ?? ""), [assignee, setAssignee] = useState(row.assignment?.assigneeId ?? "");
  const command = useWorkflowCommand();
  const save = async () => { try { await command.execute(`${root}/workstreams/${encodeURIComponent(row.item.id)}/assignment`, "PUT", { expectedVersion: row.assignment?.version ?? 0, status, dueDate: due || null, assigneeId: assignee || null, notes }, (value) => mutationValue(value, ["id", "version", "status"])); onSaved(); } catch { /* retain the user's edits on conflict */ } };
  return <details className="workstream-row"><summary>{row.item.name} · {(row.assignment?.status ?? "todo").replaceAll("_", " ")}</summary><p>{row.item.kind} · revision {row.revision?.number ?? "not recorded"}{row.revision ? `: ${row.revision.name}` : ""}</p>
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}><fieldset className="correction-fields" disabled={readOnly || command.busy || command.uncertain}>
      <label className="form-field"><span>Workstream status</span><select aria-label={`Status for ${row.item.name}`} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>{["todo", "in_progress", "blocked", "done"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
      <label className="form-field"><span>Due date</span><input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>
      {members.length > 0 && <label className="form-field"><span>Assignee</span><select aria-label={`Assignee for ${row.item.name}`} value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
      <label className="form-field"><span>Workstream notes</span><textarea maxLength={5000} rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    </fieldset>{command.error && <p role="alert">{command.error}</p>}{!readOnly && <button type="submit" className="button button-secondary" disabled={command.busy}>{command.uncertain ? "Retry unchanged assignment" : "Save workstream progress"}</button>}</form>
  </details>;
}
function RevisionHistory({ project }: { project: Project }) {
  const [open, setOpen] = useState(false), [cursor, setCursor] = useState<string>(), [selected, setSelected] = useState<string>();
  const history = useWorkflowRead<{ data: ProjectRevision[]; nextCursor?: string }>(open ? `/projects/${encodeURIComponent(project.id)}/revision-history?limit=10${cursor ? `&cursor=${cursor}` : ""}` : undefined);
  const snapshot = useWorkflowRead<{ revision: ProjectRevision; lines: BomLine[]; files: Artifact[] }>(selected ? `${revisionWorkflowPath(project.id, selected)}/snapshot` : undefined);
  return <details className="revision-history" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Project revision history</summary><p>Read earlier requirements and file identities without changing the active revision.</p>{history.error && <p role="alert">{history.error}</p>}{history.data?.data.map((revision) => <button type="button" className="button button-quiet" key={revision.id} onClick={() => setSelected(revision.id)}>Read revision {revision.number}: {revision.name}</button>)}{history.data?.nextCursor && <button type="button" className="text-button" onClick={() => setCursor(history.data!.nextCursor)}>Older revisions</button>}{cursor && <button type="button" className="text-button" onClick={() => setCursor(undefined)}>Latest revisions</button>}
    {snapshot.loading && <p role="status">Loading revision snapshot…</p>}{snapshot.error && <p role="alert">{snapshot.error}</p>}{snapshot.data && <section aria-label="Read-only revision snapshot"><h3>Revision {snapshot.data.revision.number}: {snapshot.data.revision.name}</h3><p>Read-only · {snapshot.data.lines.length} requirements · {snapshot.data.files.length} files</p>{snapshot.data.lines.map((line) => <p key={line.id}>{line.name}: {line.requiredQuantity} {line.unit}</p>)}{snapshot.data.files.map((file) => <p key={file.id}>{file.filename} · {file.role}</p>)}</section>}
  </details>;
}
