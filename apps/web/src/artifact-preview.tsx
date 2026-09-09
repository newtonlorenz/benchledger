import { Component, lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { fetchArtifactDownload } from "./api";
import type { Artifact } from "./domain";
import { useModalBoundary } from "./modal-boundary";
import "./artifact-preview.css";

const StlPreview = lazy(() => import("./stl-preview"));
class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <p role="alert">This preview could not be displayed. Close it and retry, or download the file to view it locally.</p> : this.props.children; }
}
const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml" };
export function artifactPreviewKind(name: string): "image" | "markdown" | "text" | "stl" | undefined {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (Object.hasOwn(imageTypes, extension)) return "image";
  if (["md", "markdown"].includes(extension)) return "markdown";
  if (["txt", "csv", "tsv", "json", "yaml", "yml", "log", "gcode", "scad"].includes(extension)) return "text";
  if (extension === "stl") return "stl";
  return undefined;
}

export function MarkdownPreview({ text }: { text: string }) {
  // No raw HTML, embedded remote images, or automatically loaded resources.
  return <Markdown skipHtml components={{
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
    a: ({ href, children }) => href && /^https?:\/\//iu.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>,
  }}>{text}</Markdown>;
}

type PreviewData = { text: string } | { url: string } | { bytes: ArrayBuffer };
export function ArtifactPreview({ file, onClose }: { file: Artifact; onClose: () => void }) {
  const modal = useRef<HTMLDivElement>(null);
  const title = useId();
  const [data, setData] = useState<PreviewData>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const kind = artifactPreviewKind(file.name);
  useModalBoundary(modal, onClose);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setData(undefined); setError(undefined);
    if (!kind) { setError("No preview is available for this file type."); return; }
    void (async () => {
      try {
        const blob = await fetchArtifactDownload(file.id, file.hash, { signal: controller.signal, maxBytes: (kind === "text" || kind === "markdown" ? 1 : 20) * 1024 * 1024 });
        if (controller.signal.aborted) return;
        if (kind === "image") {
          const mime = imageTypes[file.name.split(".").pop()!.toLowerCase()]!;
          url = URL.createObjectURL(new Blob([blob], { type: mime }));
          setData({ url });
        } else if (kind === "stl") {
          const bytes = await blob.arrayBuffer();
          if (!controller.signal.aborted) setData({ bytes });
        } else {
          const text = await blob.text();
          if (!controller.signal.aborted) setData({ text });
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "This file could not be previewed. Download it to view it locally.");
      }
    })();
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [file.id, file.hash, file.name, kind, attempt]);
  return <div className="artifact-preview-backdrop">
    <div ref={modal} className="artifact-preview-dialog" role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1}>
      <header><h2 id={title}>{file.name}</h2><button type="button" className="button button-quiet" onClick={onClose}>Close preview</button></header>
      <div className="artifact-preview-content">
        <PreviewBoundary key={attempt}>
        {error ? <div><p role="alert">{error}</p><button type="button" className="button button-quiet" onClick={() => setAttempt(attempt + 1)}>Retry preview</button></div> : !data ? <p role="status">Loading preview…</p> :
          "url" in data ? <img className="artifact-preview-image" src={data.url} alt={file.name} onError={() => setError("This image could not be displayed. Download it to view it locally.")} /> :
          "bytes" in data ? <Suspense fallback={<p role="status">Loading 3D viewer…</p>}><StlPreview bytes={data.bytes} /></Suspense> :
          kind === "markdown" ? <article className="artifact-preview-markdown"><MarkdownPreview text={data.text} /></article> : <pre className="artifact-preview-text">{data.text}</pre>}
        </PreviewBoundary>
      </div>
    </div>
  </div>;
}
