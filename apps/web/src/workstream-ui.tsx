import { Alert } from "./components/ui/alert";
import { Card } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { Input } from "./components/ui/input";
import { UnsavedWorkContext, useUnsavedWork } from "./unsaved-work";
import { useContext, useState } from "react";
import type { WorkItem, WorkItemRevision, WorkAssignment, ProjectRevision, BomLine, Artifact } from "@benchledger/api-contract";
import type { Project } from "./domain";
import { useWorkflowRead, useWorkflowCommand, mutationValue, revisionWorkflowPath } from "./workflow-ui";
interface WorkRow { item: WorkItem; revision: WorkItemRevision | null; assignment: WorkAssignment | null }
interface WorkPage { data: WorkRow[]; total: number; nextCursor?: string }

export function WorkstreamPlanning({ project, readOnly = false, onProjectRefresh }: { project: Project; readOnly?: boolean; onProjectRefresh?: (() => Promise<boolean>) | undefined }) {
  const root = `/projects/${encodeURIComponent(project.id)}`;
  const navigation = useContext(UnsavedWorkContext);
  const [cursor, setCursor] = useState<string>(), [creating, setCreating] = useState(false);
  const [creationSaved, setCreationSaved] = useState(false), [projectRefreshError, setProjectRefreshError] = useState(false);
  const source = useWorkflowRead<WorkPage>(`${root}/workstreams?limit=20${cursor ? `&cursor=${cursor}` : ""}`);
  const team = useWorkflowRead<{ members: { id: string; name: string }[] }>("/team/directory");
  return <Card asChild><section className="surface workstream-planning" aria-label="Task groups">
    <h2>Task groups</h2><p>Track design, electronics, firmware and assembly separately. A task group marked done does not certify a physical build.</p>
    {creationSaved && <p role="status" className="form-success">Task group created.{projectRefreshError ? " The project context could not refresh. Reload before attaching files to the new task group." : ""}</p>}
    {source.loading && <p role="status">Loading task groups…</p>}{source.error && <Alert asChild><p role="alert">{source.error}</p></Alert>}
    {source.data?.data.map((row) => <WorkstreamRow key={`${row.item.id}:${row.assignment?.version ?? 0}`} row={row} root={root} members={team.data?.members ?? []} readOnly={readOnly || project.status === "archived"} onSaved={source.reload} />)}
    {source.data?.total === 0 && !source.loading && !source.error && !creationSaved && <p>No task groups recorded. Add a task group, such as firmware or assembly.</p>}
    {!readOnly && project.status !== "archived" && (creating ? <NewWorkstream root={root} onCancel={() => setCreating(false)} onSaved={() => { setCreating(false); setCreationSaved(true); source.reload(); if (onProjectRefresh) void onProjectRefresh().then((ok) => setProjectRefreshError(!ok)).catch(() => setProjectRefreshError(true)); }} /> : <Button variant="outline" type="button" className="button button-secondary" disabled={source.loading || Boolean(source.error)} onClick={() => { setCreationSaved(false); setCreating(true); }}>Add task group</Button>)}
    <div className="workflow-pagination">{cursor && <Button variant="ghost" type="button" className="button button-quiet" onClick={() => navigation ? navigation.request(() => setCursor(undefined)) : setCursor(undefined)}>First task groups</Button>}{source.data?.nextCursor && <Button variant="ghost" type="button" className="button button-quiet" onClick={() => navigation ? navigation.request(() => setCursor(source.data!.nextCursor)) : setCursor(source.data!.nextCursor)}>Next task groups</Button>}<Button variant="ghost" type="button" className="text-button" disabled={creating || source.loading} onClick={() => navigation ? navigation.request(source.reload) : source.reload()}>Refresh task groups</Button></div>
    <RevisionHistory project={project} />
  </section></Card>;
}
function NewWorkstream({ root, onCancel, onSaved }: { root: string; onCancel(): void; onSaved(): void }) {
  const [name, setName] = useState(""), [kind, setKind] = useState("assembly");
  const command = useWorkflowCommand();
  useUnsavedWork(Boolean(name.trim()) || kind !== "assembly", "new task group", command.busy || command.uncertain);
  const save = async () => { try { await command.execute(`${root}/workstreams`, "POST", { name: name.trim(), kind }, (value) => mutationValue(value, ["item", "revision"])); onSaved(); } catch { /* keep the draft and command identity */ } };
  return <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><fieldset className="correction-fields" disabled={command.busy || command.uncertain}><Label className="form-field"><span>Task group name</span><Input required maxLength={240} value={name} onChange={(event) => setName(event.target.value)} /></Label><Label className="form-field"><span>Work type</span><NativeSelect aria-label="Task group type" value={kind} onChange={(event) => setKind(event.target.value)}>{["part", "assembly", "electronics", "firmware", "document", "other"].map((value) => <NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect></Label></fieldset>{command.error && <Alert asChild><p role="alert">{command.error}</p></Alert>}<div className="dialog-actions"><Button variant="ghost" type="button" className="button button-quiet" disabled={command.busy || command.uncertain} onClick={onCancel}>Cancel task group</Button><Button variant="default" type="submit" className="button button-primary" disabled={command.busy || !name.trim()}>{command.uncertain ? "Retry unchanged task group" : "Create task group"}</Button></div></form>;
}
function WorkstreamRow({ row, root, members, readOnly, onSaved }: { row: WorkRow; root: string; members: { id: string; name: string }[]; readOnly: boolean; onSaved(): void }) {
  const [status, setStatus] = useState(row.assignment?.status ?? "todo"), [due, setDue] = useState(row.assignment?.dueDate ?? ""), [notes, setNotes] = useState(row.assignment?.notes ?? ""), [assignee, setAssignee] = useState(row.assignment?.assigneeId ?? "");
  const command = useWorkflowCommand();
  const [receipt, setReceipt] = useState<WorkAssignment>();
  const basis = receipt ?? row.assignment;
  const dirty = status !== (basis?.status ?? "todo") || due !== (basis?.dueDate ?? "") || notes !== (basis?.notes ?? "") || assignee !== (basis?.assigneeId ?? "");
  useUnsavedWork(dirty, `task group ${row.item.name}`, command.busy || command.uncertain);
  const save = async () => { try { const result = await command.execute<WorkAssignment>(`${root}/workstreams/${encodeURIComponent(row.item.id)}/assignment`, "PUT", { expectedVersion: basis?.version ?? 0, status, dueDate: due || null, assigneeId: assignee || null, notes }, (value) => { const saved = mutationValue<WorkAssignment>(value, ["id", "version", "status"]); if (saved.workItemId !== row.item.id || saved.version !== (basis?.version ?? 0) + 1) throw new Error("The service did not confirm this task group update."); return saved; }); setReceipt(result); onSaved(); } catch { /* retain the user's edits on conflict */ } };
  return <Disclosure className="workstream-row"><DisclosureTrigger>{row.item.name} · {({ todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done" })[basis?.status ?? "todo"]}</DisclosureTrigger><DisclosureContent><p>{row.item.kind} · revision {row.revision?.number ?? "not recorded"}{row.revision ? `: ${row.revision.name}` : ""}</p>
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}><fieldset className="correction-fields" disabled={readOnly || command.busy || command.uncertain}>
      <Label className="form-field"><span>Task group status</span><NativeSelect aria-label={`Status for ${row.item.name}`} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>{["todo", "in_progress", "blocked", "done"].map((value) => <NativeSelectOption key={value} value={value}>{value.replaceAll("_", " ")}</NativeSelectOption>)}</NativeSelect></Label>
      <Label className="form-field"><span>Due date</span><Input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></Label>
      {members.length > 0 && <Label className="form-field"><span>Assignee</span><NativeSelect aria-label={`Assignee for ${row.item.name}`} value={assignee} onChange={(event) => setAssignee(event.target.value)}><NativeSelectOption value="">Unassigned</NativeSelectOption>{members.map((member) => <NativeSelectOption key={member.id} value={member.id}>{member.name}</NativeSelectOption>)}</NativeSelect></Label>}
      <Label className="form-field"><span>Task group notes</span><Textarea maxLength={5000} rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></Label>
    </fieldset>{command.error && <Alert asChild><p role="alert">{command.error}</p></Alert>}{receipt && !dirty && <p role="status" className="form-success">Task group progress saved.</p>}{!readOnly && <Button variant="outline" type="submit" className="button button-secondary" disabled={command.busy || !dirty && !command.uncertain}>{command.uncertain ? "Retry unchanged assignment" : "Save task group progress"}</Button>}</form>
  </DisclosureContent></Disclosure>;
}
function RevisionHistory({ project }: { project: Project }) {
  const [open, setOpen] = useState(false), [cursor, setCursor] = useState<string>(), [selected, setSelected] = useState<string>();
  const history = useWorkflowRead<{ data: ProjectRevision[]; nextCursor?: string }>(open ? `/projects/${encodeURIComponent(project.id)}/revision-history?limit=10${cursor ? `&cursor=${cursor}` : ""}` : undefined);
  const snapshot = useWorkflowRead<{ revision: ProjectRevision; lines: BomLine[]; files: Artifact[] }>(selected ? `${revisionWorkflowPath(project.id, selected)}/snapshot` : undefined);
  return <Disclosure className="revision-history" open={open} onOpenChange={(open) => setOpen(open)}><DisclosureTrigger>Project revision history</DisclosureTrigger><DisclosureContent><p>Read earlier requirements and file identities without changing the active revision.</p>{history.error && <Alert asChild><p role="alert">{history.error}</p></Alert>}{history.data?.data.map((revision) => <Button variant="ghost" type="button" className="button button-quiet" key={revision.id} onClick={() => setSelected(revision.id)}>Read revision {revision.number}: {revision.name}</Button>)}{history.data?.nextCursor && <Button variant="ghost" type="button" className="text-button" onClick={() => setCursor(history.data!.nextCursor)}>Older revisions</Button>}{cursor && <Button variant="ghost" type="button" className="text-button" onClick={() => setCursor(undefined)}>Latest revisions</Button>}
    {snapshot.loading && <p role="status">Loading revision snapshot…</p>}{snapshot.error && <Alert asChild><p role="alert">{snapshot.error}</p></Alert>}{snapshot.data && <section aria-label="Read-only revision snapshot"><h3>Revision {snapshot.data.revision.number}: {snapshot.data.revision.name}</h3><p>Read-only · {snapshot.data.lines.length} requirements · {snapshot.data.files.length} files</p>{snapshot.data.lines.map((line) => <p key={line.id}>{line.name}: {line.requiredQuantity} {line.unit}</p>)}{snapshot.data.files.map((file) => <p key={file.id}>{file.filename} · {file.role}</p>)}</section>}
  </DisclosureContent></Disclosure>;
}
