import { artifactScopeChoices, artifactScopeKey, defaultArtifactScope } from "./artifact-scope";
import type { Artifact, Project } from "./domain";

export const projectFileGroups = [
  { id: "print", label: "3D print", guidance: "Check printer, material, supports and toolpaths in your slicer." },
  { id: "electronics", label: "Electronics", guidance: "Review board files and fabrication settings before use." },
  { id: "cad", label: "CAD & firmware", guidance: "Editable sources, component models and firmware." },
  { id: "instructions", label: "Instructions", guidance: "Build guides, drawings, images and check records." }
] as const;

/** Classification changes presentation only; ancestry and download checks stay authoritative. */
export function groupProjectFiles(files: readonly Artifact[]) {
  const groupFor = (file: Artifact): typeof projectFileGroups[number]["id"] => {
    const name = file.name.toLowerCase();
    if (/\.(3mf|stl|gcode|bgcode|obj)$/.test(name) || file.role === "Build plate" || file.role === "STL") return "print";
    if (/\.(kicad_pcb|kicad_sch|kicad_pro|gbr|gerber|drl)$/.test(name) || /(?:pcb|gerber|fabrication)(?:[-_ .].*)?\.zip$/.test(name)) return "electronics";
    if (["Editable CAD", "STEP", "Firmware"].includes(file.role) || /\.(step|stp|f3d|fcstd|scad|ino|hex|bin|uf2|cpp|c|py)$/.test(name)) return "cad";
    return "instructions";
  };
  return projectFileGroups.map(group => ({ ...group, files: files.filter(file => groupFor(file) === group.id) }));
}

/** Browsing preferences only. File objects and pending uploads stay in the Files panel. */
export interface ProjectFilesViewState {
  projectId: string;
  revisionId: string | undefined;
  scopeKey: string;
  query: string;
  showImages?: boolean;
}

export function projectFilesView(project: Project, saved?: ProjectFilesViewState): ProjectFilesViewState {
  const fallback: ProjectFilesViewState = {
    projectId: project.id,
    revisionId: project.serverRevisionId,
    scopeKey: artifactScopeKey(defaultArtifactScope(project)),
    query: ""
  };
  if (!saved || saved.projectId !== project.id || saved.revisionId !== project.serverRevisionId) return fallback;
  return artifactScopeChoices(project).some(choice => choice.key === saved.scopeKey && !choice.disabled) ? saved : fallback;
}
