import type { BuildPlan } from "@benchledger/api-contract";
import type { Artifact, Project } from "./domain";

/** Only files attached to a current project or work-item revision can be selected. */
export function currentBuildFiles(project: Project): Artifact[] {
  const revisions = new Map((project.workItems ?? []).map((item) => [item.id, item.currentRevisionId ?? item.currentRevision?.id]));
  return (project.allArtifacts ?? project.artifacts).filter((file) => file.status !== "superseded" &&
    (file.workItemId ? Boolean(file.workItemRevisionId) && revisions.get(file.workItemId) === file.workItemRevisionId
      : Boolean(project.serverRevisionId) && file.projectRevisionId === project.serverRevisionId));
}

export function productCover(project: Project): Artifact | undefined {
  const presentation = project.presentation;
  if (!presentation?.coverArtifactId || presentation.projectId !== project.id || presentation.projectRevisionId !== project.serverRevisionId) return undefined;
  return currentBuildFiles(project).find((file) => file.id === presentation.coverArtifactId && file.hash === presentation.coverSha256 && isProductImage(file));
}

export function isProductImage(file: Artifact): boolean {
  return ["image/png", "image/jpeg", "image/webp"].includes(file.mediaType ?? "") &&
    (file.byteSize ?? Infinity) <= 20 * 1024 * 1024;
}

export type BuildFileGroup = "print" | "board" | "components" | "instructions";
export const buildFileGroups: { id: BuildFileGroup; label: string; detail: string }[] = [
  { id: "print", label: "3D print", detail: "Download a 3MF for Bambu Studio or your slicer. Review the printer, material and plate settings, then slice as needed. STL files need slicer setup." },
  { id: "board", label: "PCB and fabrication", detail: "Open the board, fabrication exports or toolpaths in the matching CAD or CAM tool. Review dimensions, materials and toolpaths before manufacture." },
  { id: "components", label: "Components and firmware", detail: "Use the component designs and firmware with the recorded build steps. Check fit, connections and the target hardware." },
  { id: "instructions", label: "Build instructions", detail: "Read the recorded assembly steps, checks and revision notes before starting." },
];

export function buildFileGroup(file: Artifact): BuildFileGroup | undefined {
  const name = file.name.toLocaleLowerCase();
  if (/\.(?:3mf|stl|gcode)$/u.test(name)) return "print";
  if (/\.(?:kicad_pcb|kicad_sch|gbr|gerber|gbl|gtl|gbs|gts|gbo|gto|drl|nc|cnc|tap)$/u.test(name) || /gerber.*\.zip$/u.test(name)) return "board";
  if (["Editable CAD", "STEP", "Firmware"].includes(file.role) || /\.(?:step|stp|fcstd|scad|bin|hex|uf2)$/u.test(name)) return "components";
  if (["Notes", "Document", "Drawing", "Validation"].includes(file.role) || /\.(?:md|txt|pdf|csv|svg|json)$/u.test(name)) return "instructions";
  return undefined;
}

export function preferredPrintFile(project: Project): Artifact | undefined {
  return currentBuildFiles(project).filter((file) => /\.3mf$/iu.test(file.name))
    .sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name))[0];
}

export function buildPlanChecks(project: Project, plan: BuildPlan): string[] {
  const files = currentBuildFiles(project);
  const checks = [...plan.warnings];
  if (plan.projectId !== project.id || plan.projectRevisionId !== project.serverRevisionId) checks.push("This plan belongs to another revision. Refresh the current build plan.");
  for (const basis of plan.artifactBasis) {
    if (!files.some((file) => file.id === basis.id && file.hash === basis.sha256)) checks.push("A file in the plan is no longer current. Review the plan against the current files.");
  }
  return [...new Set(checks)];
}
