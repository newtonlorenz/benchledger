import { useEffect, useRef, useState } from "react";
import type { ProjectPresentation, ProjectPresentationInput } from "@benchledger/api-contract";
import { fetchArtifactDownload } from "./api";
import type { Artifact, Project } from "./domain";
import { currentBuildFiles, isProductImage, productCover } from "./project-library";
import { Button } from "./components/ui/button";
import { Alert } from "./components/ui/alert";
import { Label } from "./components/ui/label";
import { Input } from "./components/ui/input";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Icon } from "./icons";
import { useUnsavedWork } from "./unsaved-work";
import { mutationValue, revisionWorkflowPath, useWorkflowCommand, useWorkflowRead } from "./workflow-ui";

export const imageKindLabels = { render: "Design render", reference: "Reference image", built_photo: "Built-product photo" } as const;

export function ProductImage({ project, compact = false, onOpen, onChoose }: { project: Project; compact?: boolean; onOpen?: (() => void) | undefined; onChoose?: (() => void) | undefined }) {
  const file = productCover(project);
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!holder.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "100px" });
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, []);
  return <div className={`product-image${compact ? " is-compact" : ""}`} ref={holder}>
    {file && visible ? <VerifiedProductImage key={`${file.id}:${file.hash}`} file={file} onOpen={onOpen} alt={project.presentation?.caption || `${project.name} — ${imageKindLabels[project.presentation!.imageKind]}`} />
      : <div className="product-image-placeholder"><Icon name="layers" size={compact ? 20 : 32} />{!compact && <><span>{file ? "Loading project image…" : project.status === "archived" ? "No project image" : "Add a project image"}</span><small>{file ? "Checking the recorded file" : project.status === "archived" ? "No image selected for this revision" : "Render, sketch or finished photo"}</small></>}{!file && onChoose && <Button variant="ghost" className="project-image-choose" aria-label={`Choose image for ${project.name}`} onClick={onChoose}>{compact ? "Add" : "Add image"}</Button>}</div>}
    {file && !compact && <span className="product-image-kind">{imageKindLabels[project.presentation!.imageKind]}</span>}
  </div>;
}

function VerifiedProductImage({ file, alt, onOpen }: { file: Artifact; alt: string; onOpen?: (() => void) | undefined }) {
  const [url, setUrl] = useState<string>(), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setUrl(undefined); setError(false);
    void fetchArtifactDownload(file.id, file.hash, { signal: controller.signal, maxBytes: 20 * 1024 * 1024 }).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(new Blob([blob], { type: file.mediaType ?? "image/png" }));
      setUrl(objectUrl);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.id, file.hash, file.mediaType, attempt]);
  if (error) return <div className="product-image-placeholder"><Icon name="file" size={28} /><span>Image unavailable</span><Button variant="ghost" onClick={() => setAttempt((value) => value + 1)}>Retry image</Button></div>;
  const picture = url && <img src={url} alt={alt} loading="lazy" onError={() => setError(true)} />;
  return url ? (onOpen ? <Button variant="ghost" type="button" className="product-image-open" onClick={onOpen}>{picture}</Button> : picture) : <div className="product-image-placeholder" role="status">Loading project image…</div>;
}

export function ProjectProductImageEditor({ project, onSaved }: { project: Project; onSaved(): Promise<boolean> }) {
  const root = project.projectLibraryAvailable && project.serverRevisionId ? revisionWorkflowPath(project.id, project.serverRevisionId) : undefined;
  const source = useWorkflowRead<ProjectPresentation | null>(root ? `${root}/presentation` : undefined);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<string>();
  if (!project.projectLibraryAvailable || !root) return null;
  return <section className="project-product-image-editor" aria-label="Project image">
    <h3>Project image</h3><p>Show a render or photo on Projects. Label it so others can tell a design from a finished build.</p>
    {source.loading && <p role="status">Loading image selection…</p>}
    {source.error && <Alert asChild><div role="alert">{source.error}<Button variant="ghost" onClick={source.reload}>Retry image selection</Button></div></Alert>}
    {editing ? <ProductImageForm key={`${project.id}:${source.data?.version ?? 0}`} project={project} root={root} initial={source.data ?? null} onCancel={() => setEditing(false)} onSaved={async () => { setEditing(false); source.reload(); setSaved(await onSaved() ? "Project image saved." : "Image saved. Refresh Projects to load the updated preview."); }} />
      : !source.loading && !source.error && <><p>{source.data?.coverArtifactId ? `${imageKindLabels[source.data.imageKind]} · ${currentBuildFiles(project).find((file) => file.id === source.data!.coverArtifactId)?.name ?? "Recorded image"}` : "No image selected for this revision."}</p>{source.data?.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        {project.status !== "archived" && <Button variant="outline" disabled={source.loading || Boolean(source.error)} onClick={() => { setSaved(undefined); setEditing(true); }}>{source.data?.coverArtifactId ? "Change project image" : "Choose project image"}</Button>}
      </>}
    {saved && <p role="status">{saved}</p>}
  </section>;
}

function ProductImageForm({ project, root, initial, onCancel, onSaved }: { project: Project; root: string; initial: ProjectPresentation | null; onCancel(): void; onSaved(): Promise<void> }) {
  const initialDraft: ProjectPresentationInput = { expectedVersion: initial?.version ?? 0, coverArtifactId: initial?.coverArtifactId ?? null, imageKind: initial?.imageKind ?? "render", caption: initial?.caption ?? "" };
  const [draft, setDraft] = useState(initialDraft);
  const command = useWorkflowCommand();
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft);
  useUnsavedWork(dirty, "project image", command.uncertain);
  const images = currentBuildFiles(project).filter(isProductImage);
  const selectedImage = images.find((file) => file.id === draft.coverArtifactId);
  const save = async () => {
    try {
      await command.execute(`${root}/presentation`, "PUT", draft, (value) => mutationValue<ProjectPresentation>(value, ["projectId", "projectRevisionId", "version", "coverArtifactId"]));
      await onSaved();
    } catch { /* The command retains its exact request for an ambiguous retry. */ }
  };
  return <div className="workflow-form">
    {selectedImage && <div className="product-image project-image-preview"><VerifiedProductImage key={`${selectedImage.id}:${selectedImage.hash}`} file={selectedImage} alt={draft.caption || `Preview of ${project.name}`} /></div>}
    <fieldset disabled={command.busy || command.uncertain} className="correction-fields">
      <Label className="form-field"><span>Project image file</span><NativeSelect autoFocus aria-label="Project image file" value={draft.coverArtifactId ?? ""} onChange={(event) => setDraft((value) => ({ ...value, coverArtifactId: event.target.value || null }))}>
        <NativeSelectOption value="">No project image</NativeSelectOption>{images.map((file) => <NativeSelectOption key={file.id} value={file.id}>{file.name}</NativeSelectOption>)}
      </NativeSelect></Label>
      {!images.length && <p>Upload a PNG, JPEG or WebP in Files first (up to 20 MiB). Images must belong to this revision or a current work item.</p>}
      <Label className="form-field"><span>Image represents</span><NativeSelect aria-label="Image represents" value={draft.imageKind} onChange={(event) => setDraft((value) => ({ ...value, imageKind: event.target.value as ProjectPresentationInput["imageKind"] }))}>
        {Object.entries(imageKindLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
      </NativeSelect></Label>
      <Label className="form-field"><span>Image description</span><Input aria-label="Image description" value={draft.caption ?? ""} maxLength={1000} onChange={(event) => setDraft((value) => ({ ...value, caption: event.target.value }))} /></Label>
    </fieldset>
    {command.error && <Alert asChild><p role="alert">{command.error}</p></Alert>}
    <div className="dialog-actions"><Button variant="ghost" disabled={command.busy || command.uncertain} onClick={onCancel}>Cancel image selection</Button><Button disabled={command.busy || (!dirty && !command.uncertain)} onClick={() => { void save(); }}>{command.busy ? "Saving…" : command.uncertain ? "Retry unchanged image selection" : "Save project image"}</Button></div>
  </div>;
}
