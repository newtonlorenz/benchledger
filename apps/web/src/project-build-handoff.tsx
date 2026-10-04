import { useState } from "react";
import type { BuildPlan } from "@benchledger/api-contract";
import { fetchArtifactDownload } from "./api";
import type { Artifact, Project } from "./domain";
import { buildFileGroup, buildFileGroups, buildPlanChecks, currentBuildFiles } from "./project-library";
import { Alert } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Icon } from "./icons";
import { revisionWorkflowPath, useWorkflowRead } from "./workflow-ui";

export function BuildFileDownload({ file, compact = false }: { file: Artifact; compact?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const download = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const blob = await fetchArtifactDownload(file.id, file.hash);
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = file.name;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The file could not be downloaded. Refresh and retry."); }
    finally { setBusy(false); }
  };
  return <div className="build-file-download">
    <Button variant="outline" disabled={busy} onClick={() => { void download(); }} aria-label={`Download ${file.name}`} title={file.name}><Icon name="download" size={16} />{busy ? "Downloading…" : compact ? "Download 3MF" : file.name}</Button>
    {!compact && <small>{file.size} · {file.workItemId ? "Current work item" : "Current project revision"}</small>}
    {error && <Alert asChild><p role="alert">{error}</p></Alert>}
  </div>;
}

export function ProjectBuildHandoff({ project, onFiles, onRefresh }: { project: Project; onFiles?: (() => void) | undefined; onRefresh?: (() => Promise<boolean>) | undefined }) {
  const root = project.serverRevisionId ? revisionWorkflowPath(project.id, project.serverRevisionId) : undefined;
  const source = useWorkflowRead<BuildPlan | null>(root ? `${root}/build-plan` : undefined);
  const [refreshing, setRefreshing] = useState(false), [refreshError, setRefreshError] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true); setRefreshError(false);
    try {
      if (onRefresh && !await onRefresh()) { setRefreshError(true); return; }
      source.reload();
    } catch { setRefreshError(true); }
    finally { setRefreshing(false); }
  };
  const files = currentBuildFiles(project);
  const groups = buildFileGroups.map((group) => ({ ...group, files: files.filter((file) => buildFileGroup(file) === group.id) })).filter((group) => group.files.length);
  const checks = source.data ? buildPlanChecks(project, source.data) : [];
  return <section className="project-build-handoff" aria-label="Build handoff">
    <div className="home-section-title"><div><h2>Start this build</h2><p>{project.currentRevision} · Current project and work-item files</p></div><Button variant="ghost" disabled={source.loading || refreshing} onClick={() => { void refresh(); }}>{refreshing ? "Refreshing handoff…" : "Refresh build handoff"}</Button></div>
    {refreshError && <Alert asChild><p role="alert">The build files could not refresh. The previous records remain visible. Retry before using this handoff.</p></Alert>}
    <p>Review the files and checks here, then continue in your slicer, CAD or CAM tool.</p>
    {groups.map((group) => <section className="handoff-file-group" key={group.id}><h3>{group.label}</h3><p>{group.detail}</p><div className="handoff-files">{group.files.map((file) => <BuildFileDownload key={file.id} file={file} />)}</div></section>)}
    {!groups.length && <p>No current build files are attached. Add print, fabrication or instruction files to the current revision in Files.</p>}
    {source.loading && <p role="status">Loading the current build plan…</p>}{source.error && <Alert asChild><p role="alert">{source.error} Retry before relying on the plan.</p></Alert>}
    {source.data && <div className="handoff-plan"><strong>{source.data.name} · version {source.data.version}</strong><p>{source.data.parts.length} parts · {source.data.plates.reduce((sum, plate) => sum + plate.copies, 0)} planned print runs</p>{source.data.notes && <p>{source.data.notes}</p>}</div>}
    {!source.loading && !source.error && !source.data && <p>No build plan is recorded. Use the parts, plates and workstreams below, or ask your MCP agent to prepare them.</p>}
    {checks.length > 0 && <Alert asChild><section className="handoff-checks"><h3>Checks before building</h3><ul>{checks.map((check) => <li key={check}>{check}</li>)}</ul></section></Alert>}
    <div className="handoff-actions">{onFiles && <Button variant="outline" onClick={onFiles}>Manage project files</Button>}</div>
    <p className="handoff-boundary">A file or plan does not confirm manufacturing readiness. Downloading does not start a printer or machine. Record the actual build and checks after you complete them.</p>
  </section>;
}
