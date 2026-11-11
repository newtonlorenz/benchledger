import { lazy, Suspense } from "react";
import type { Artifact } from "./domain";

/**
 * The previewer pulls in the Markdown stack, so it loads on first use. The
 * extension check stays synchronous (it decides whether a Preview button is
 * shown) and must match artifactPreviewKind in artifact-preview.tsx; a test
 * keeps the two in step.
 */
const ArtifactPreview = lazy(() => import("./artifact-preview").then((module) => ({ default: module.ArtifactPreview })));

const previewableExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "log", "gcode", "scad", "stl"]);

export function canPreviewArtifact(name: string): boolean {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return previewableExtensions.has(extension);
}

export function LazyArtifactPreview({ file, onClose }: { file: Artifact; onClose: () => void }) {
  return <Suspense fallback={<div className="artifact-preview-backdrop" role="status" aria-live="polite"><p className="artifact-preview-loading">Opening preview…</p></div>}><ArtifactPreview file={file} onClose={onClose} /></Suspense>;
}
