import { Alert } from "./components/ui/alert";
import { Label } from "./components/ui/label";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Checkbox } from "./components/ui/checkbox";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { useEffect, useRef, useState } from "react";
import type { AssemblyInspection, AssemblySource } from "@benchledger/api-contract";
import type { Project } from "./domain";
import { workflowRequest } from "./api";
import { revisionWorkflowPath } from "./workflow-ui";
import "./assembly.css";
import "./pcb.css";
import { DeferredAssemblyCanvas as Canvas } from "./deferred-views";

export function PcbWorkspace({ project, onFiles, onAssembly }: { project: Project; onFiles(): void; onAssembly(): void }) {
  const files = (project.allArtifacts ?? project.artifacts).filter(f => f.status !== "superseded" && /\.(kicad_pcb|step|stp|glb)$/iu.test(f.name) && (f.projectRevisionId === project.serverRevisionId || f.workItemId && f.workItemRevisionId));
  const workspace = useRef<HTMLElement>(null);
  const [fileId, setFileId] = useState(""), [unit, setUnit] = useState<AssemblySource["unit"]>("millimetre"), [axis, setAxis] = useState<"y" | "z">("z");
  const [result, setResult] = useState<AssemblyInspection>(), [error, setError] = useState<string>(), [loading, setLoading] = useState(false);
  const [view, setView] = useState<"iso" | "top" | "bottom">("iso"), [fit, setFit] = useState(0), [selected, setSelected] = useState<string>(), [query, setQuery] = useState("");
  const [hidden, setHidden] = useState(new Set<string>()), sequence = useRef(0);
  const file = files.find(f => f.id === fileId), native = Boolean(file?.name.toLowerCase().endsWith(".kicad_pcb"));
  const source = result?.sources[0];
  const current = source && file && source.artifactId === file.id && source.sha256 === file.hash ? result : undefined;
  useEffect(() => { sequence.current++; setResult(undefined); setLoading(false); setError(undefined); return () => { sequence.current++; }; }, [project.id, project.serverRevisionId, fileId, file?.hash, file?.status, unit, axis]);
  const choose = (id: string) => { const f = files.find(v => v.id === id); setFileId(id); setUnit(f?.name.toLowerCase().endsWith(".glb") ? "metre" : "millimetre"); setAxis(f?.name.toLowerCase().endsWith(".glb") ? "y" : "z"); };
  const inspect = async () => {
    if (!file || !project.serverRevisionId) return;
    const request = ++sequence.current; setLoading(true); setError(undefined); setResult(undefined);
    try {
      const data = await workflowRequest<AssemblyInspection>(`${revisionWorkflowPath(project.id, project.serverRevisionId)}/assembly/inspect`, "POST", { sources: [{ artifactId: file.id, sha256: file.hash, unit, upAxis: axis }] });
      if (request !== sequence.current) return;
      if (!data.parts.length || !data.geometry.length) throw new Error("No supported PCB geometry was returned. Export a STEP or GLB from KiCad.");
      setResult(data); setHidden(new Set()); setSelected(undefined); setQuery(""); setView("iso"); setFit(v => v + 1); requestAnimationFrame(() => workspace.current?.scrollIntoView?.({ block: "start" }));
    } catch (e) { if (request === sequence.current) setError(e instanceof Error ? e.message : "The PCB could not be opened."); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  const info = (id: string) => { const part = current?.parts.find(p => p.id === id); return current?.geometry.find(g => g.nodeId === part?.nodeId && g.artifactId === part?.artifactId)?.pcb; };
  const toggle = (ids: string[], visible: boolean) => setHidden(prev => { const next = new Set(prev); ids.forEach(id => visible ? next.delete(id) : next.add(id)); return next; });
  const selectedPart = current?.parts.find(p => p.id === selected), selectedInfo = selected ? info(selected) : undefined;
  const boardInfo = current?.geometry.find(g => g.pcb?.kind === "board")?.pcb;
  const parts = current?.parts.filter(p => `${p.name} ${info(p.id)?.value ?? ""} ${info(p.id)?.footprint ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  return <section ref={workspace} className="assembly-workspace pcb-workspace" aria-label="PCB viewer">
    <header className="assembly-heading"><div><h2>PCB viewer</h2><p>Review board geometry and component placement for this revision. This view does not confirm electrical or fabrication readiness.</p></div><div className="assembly-heading-actions"><Button variant="ghost" type="button" onClick={onFiles}>Files & downloads</Button><Button variant="ghost" type="button" onClick={onAssembly}>Assembly guide</Button></div></header>
    {!project.serverRevisionId ? <p className="assembly-message">Create a project revision before adding a PCB.</p> : <>
      {files.length > 0 && <div className="pcb-source-controls"><Label>Board source<NativeSelect value={fileId} onChange={e => choose(e.target.value)}><NativeSelectOption value="">Choose a KiCad PCB, STEP or GLB file</NativeSelectOption>{files.map(f => <NativeSelectOption key={f.id} value={f.id}>{f.name} · {f.workItemRevisionId ? `workstream ${f.revision}` : f.revision}</NativeSelectOption>)}</NativeSelect></Label>
        {file && !native && <Disclosure className="pcb-coordinate-options"><DisclosureTrigger>Coordinate settings</DisclosureTrigger><DisclosureContent><Label>Units<NativeSelect value={unit} disabled={/\.st(e)?p$/iu.test(file.name)} onChange={e => setUnit(e.target.value as AssemblySource["unit"])}>{["millimetre", "centimetre", "metre", "inch"].map(u => <NativeSelectOption key={u} value={u}>{u}</NativeSelectOption>)}</NativeSelect></Label><Label>Up axis<NativeSelect value={axis} onChange={e => setAxis(e.target.value as "y" | "z")}><NativeSelectOption value="z">Z up (CAD)</NativeSelectOption><NativeSelectOption value="y">Y up (glTF)</NativeSelectOption></NativeSelect></Label></DisclosureContent></Disclosure>}
        <Button variant="default" type="button" className="button button-primary" disabled={!file || loading} onClick={() => void inspect()}>{loading ? "Opening PCB…" : "Open PCB"}</Button>
      </div>}
      {!files.length && <div className="assembly-empty"><h3>Add your board files</h3><p>Upload a native .kicad_pcb or a self-contained STEP/GLB export in Files. Keep the source PCB alongside exports so you can trace each file back to the board design.</p><Button type="button" onClick={onFiles}>Add PCB files</Button></div>}
      {file && <p className="assembly-placement-note">{native ? "KiCad uses millimetres with front copper facing +Z. External component models are never loaded." : "The export supplies the geometry and part names. Copper and components cannot be classified reliably from an arbitrary export; use individual part visibility."}</p>}
      {error && <Alert asChild><p role="alert" className="assembly-message">{error}</p></Alert>}{loading && <p role="status" className="assembly-message">Reading the exact source file…</p>}
      {current && <>
        <div className="assembly-layout"><div className="assembly-stage">
          <div role="group" aria-label="PCB views" className="assembly-toolbar">{(["iso", "top", "bottom"] as const).map(v => <Button variant="ghost" key={v} type="button" aria-pressed={view === v} onClick={() => { setView(v); setFit(n => n + 1); }}>{v === "iso" ? "3D" : v === "top" ? "Top" : "Bottom"}</Button>)}<Button variant="ghost" type="button" onClick={() => setFit(n => n + 1)}>Fit board</Button><Button variant="ghost" type="button" onClick={() => { setHidden(new Set()); setFit(n => n + 1); }}>Show all</Button></div>
          <Canvas geometry={current.geometry} parts={current.parts} hidden={hidden} selected={selected} explosion={0} view={view} fit={fit} onSelect={setSelected} />
          <p className="assembly-gestures">Drag to orbit · scroll or pinch to zoom · select a part to inspect</p>
          {boardInfo && <p className="pcb-board-facts">{boardInfo.thicknessMm} mm substrate · {boardInfo.holeCount} drill openings · footprint outlines only</p>}
        </div><aside className="assembly-guide" aria-label="PCB layers and components">
          {native && <fieldset className="pcb-layers"><legend>Visibility</legend>{([['board', 'Board'], ['copper', 'Copper'], ['footprint', 'Component outlines']] as const).map(([kind, name]) => { const ids = current.parts.filter(p => info(p.id)?.kind === kind).map(p => p.id); return <Label key={kind}><Checkbox  disabled={!ids.length} checked={ids.length > 0 && ids.some(id => !hidden.has(id))} onCheckedChange={checked => toggle(ids, checked === true)} />{name}</Label>; })}</fieldset>}
          <Label className="assembly-search">Find a component or part<Input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Reference, value or name" /></Label>
          <div className="assembly-parts" role="region" aria-label="PCB parts" tabIndex={0}>{parts.map(p => <div key={p.id} className={`assembly-part ${p.id === selected ? "selected" : ""}`}><Checkbox  aria-label={`Show ${p.name}`} checked={!hidden.has(p.id)} onCheckedChange={checked => toggle([p.id], checked === true)} /><Button variant="ghost" type="button" aria-pressed={p.id === selected} onClick={() => setSelected(p.id)}><span className="assembly-swatch" style={{ background: p.color }} />{p.name}</Button></div>)}{!parts.length && <div className="specialist-no-results"><p>No matching parts.</p><Button variant="ghost" onClick={() => setQuery("")}>Clear search</Button></div>}</div>
          {selectedPart && <div className="assembly-detail"><h3>{selectedInfo?.reference || selectedPart.name}</h3>{selectedInfo?.value && <p>{selectedInfo.value}</p>}{selectedInfo?.footprint && <p>{selectedInfo.footprint}</p>}{selectedInfo && <p>{selectedInfo.side === "both" ? "Both sides" : `${selectedInfo.side === "top" ? "Front" : "Back"} side`}{selectedInfo.modelStatus ? " · No component body loaded" : ""}</p>}<p>{selectedPart.notes}</p><Button variant="ghost" type="button" onClick={() => { setHidden(new Set(current.parts.filter(p => p.id !== selected).map(p => p.id))); setFit(n => n + 1); }}>Isolate selection</Button></div>}
        </aside></div>
        <Disclosure className="assembly-evidence"><DisclosureTrigger>Source and viewing limits</DisclosureTrigger><DisclosureContent><p>{file?.name} · Project revision: {project.serverRevisionId}{file?.workItemRevisionId ? ` · Workstream revision: ${file.workItemRevisionId}` : ""}</p><p>SHA-256: <code>{source?.sha256}</code></p><ul>{current.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></DisclosureContent></Disclosure>
      </>}
    </>}
  </section>;
}
