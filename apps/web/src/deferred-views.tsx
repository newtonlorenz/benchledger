import { deferView } from "./deferred-view";
import type { Project } from "./domain";

export const DeferredAssemblyWorkspace = deferView<{ project: Project; onFiles(): void }>(
  () => import("./assembly-ui").then(module => ({ default: module.AssemblyWorkspace })),
  { name: "Assembly explorer", loading: "Opening assembly explorer…", recovery: "You can still use the other project tabs." },
);

export const DeferredPcbWorkspace = deferView<{ project: Project; onFiles(): void; onAssembly(): void }>(
  () => import("./pcb-ui").then(module => ({ default: module.PcbWorkspace })),
  { name: "PCB viewer", loading: "Opening PCB viewer…", recovery: "You can still use the other project tabs." },
);

export const DeferredAssemblyCanvas = deferView(
  () => import("./assembly-canvas"),
  { name: "3D viewer", loading: "Opening 3D viewer…", recovery: "The parts list, notes and edits remain available." },
);

export const DeferredStlPreview = deferView(
  () => import("./stl-preview"),
  { name: "STL preview", loading: "Loading 3D viewer…", recovery: "You can close the preview and download the file to view it locally." },
);

export const DeferredMarkdownPreview = deferView(
  () => import("./markdown-preview"),
  { name: "Document preview", loading: "Opening document preview…", recovery: "You can close the preview and download the file to view it locally." },
);
