import { calculateProjectSummary } from "./domain";
import type { Project, InventoryItem } from "./domain";
import { matchesInventorySearch } from "@benchledger/domain/inventory-search";
export type HomeTaskKind = "setup" | "requirements" | "decide" | "check" | "source" | "files" | "refresh" | "review";
export interface HomeTask { id: string; projectId: string; projectName: string; kind: HomeTaskKind; label: string; detail: string; count: number }
export interface HomeProject { project: Project; tasks: HomeTask[]; ready: number; required: number; unknown: boolean }
export type HomeFilter = "active" | "attention" | "pinned" | "complete" | "all";
export interface HomePreferences { pins: string[]; recent: string[]; filter: HomeFilter; sort: "recent" | "name" | "attention" }
export const defaultHomePreferences: HomePreferences = { pins: [], recent: [], filter: "active", sort: "recent" };
const ids = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 240))].slice(0, 100) : [];
export function parseHomePreferences(raw: string | null): HomePreferences {
  try { const data: unknown = JSON.parse(raw ?? "null"); if (!data || typeof data !== "object" || Array.isArray(data)) return { ...defaultHomePreferences };
    const value = data as Record<string, unknown>;
    return { pins: ids(value.pins), recent: ids(value.recent).slice(0, 12), filter: ["active", "attention", "pinned", "complete", "all"].includes(String(value.filter)) ? value.filter as HomeFilter : "active", sort: ["recent", "name", "attention"].includes(String(value.sort)) ? value.sort as HomePreferences["sort"] : "recent" };
  } catch { return { ...defaultHomePreferences }; }
}
export function homePreferenceKey(sample: boolean): string { return `benchledger.home.v1.${sample ? "sample" : "workspace"}`; }
export function readHomePreferences(sample = false): HomePreferences { try { return parseHomePreferences(localStorage.getItem(homePreferenceKey(sample))); } catch { return { ...defaultHomePreferences }; } }
export function writeHomePreferences(value: HomePreferences, sample = false): void { try { localStorage.setItem(homePreferenceKey(sample), JSON.stringify(value)); } catch { /* Local controls still work when storage is blocked. */ } }
export function recordOpenedProject(id: string, sample = false): void { const old = readHomePreferences(sample); writeHomePreferences({ ...old, recent: [id, ...old.recent.filter((entry) => entry !== id)].slice(0, 12) }, sample); }
export function deriveHomeProjects(projects: readonly Project[], items: InventoryItem[]): HomeProject[] {
  return projects.filter((project) => project.status !== "archived").map((project) => {
    const summary = calculateProjectSummary(project, items);
    const lines = summary.lineStatuses.filter((line) => !line.line.optional);
    const unknown = project.readinessUnavailable === true || summary.readinessUnavailable;
    const required = project.bom.filter((line) => !line.optional).length;
    const route = project.fabricationRoute ?? (project.intendedPrinterItemId !== undefined ? project.intendedPrinterItemId ? "printed" : "undecided" : project.buildConfigSnapshot?.printerItemId ? "printed" : "undecided");
    const tasks: HomeTask[] = [];
    const add = (kind: HomeTaskKind, label: string, detail: string, count = 1) => tasks.push({ id: `${project.id}:${kind}`, projectId: project.id, projectName: project.name, kind, label, detail, count });
    if (project.status !== "complete") {
      if (unknown) add("refresh", "Refresh stock results", "The current stock result is unavailable.");
      if (route === "undecided") add("setup", "Set build approach", "Choose how this project will be made.");
      if (!project.bom.length) add("requirements", "Add requirements", "Record the parts, materials or tools required.");
      if (!unknown) for (const kind of ["decide", "check", "source"] as const) {
        const count = lines.filter((line) => line.decision === kind).length;
        if (count) add(kind, kind === "decide" ? "Review requirements" : kind === "check" ? "Check stock" : "Review sourcing", `${count} required ${count === 1 ? "line" : "lines"} ${kind === "source" ? count === 1 ? "has a stock gap" : "have stock gaps" : `${count === 1 ? "needs" : "need"} ${kind === "decide" ? "more detail" : "a physical or compatibility check"}`}.`, count);
      }
      const currentWork = new Map((project.workItems ?? []).map((item) => [item.id, item.currentRevisionId ?? item.currentRevision?.id]));
      const hasDesign = (project.allArtifacts ?? project.artifacts).some((file) => ["STL", "STEP", "Build plate", "Editable CAD"].includes(file.role) && (file.workItemId ? Boolean(file.workItemRevisionId) && currentWork.get(file.workItemId) === file.workItemRevisionId : Boolean(project.serverRevisionId) && file.projectRevisionId === project.serverRevisionId));
      if (route === "printed" && !hasDesign) add("files", "Add design files", "No design file is attached to a current project or work-item revision.");
    }
    return { project, tasks, required, ready: unknown ? 0 : lines.filter((line) => line.decision === "ready").length, unknown };
  });
}
export function filterHomeProjects(rows: readonly HomeProject[], query: string, preferences: HomePreferences): HomeProject[] {
  const filtered = rows.filter(({ project, tasks }) => matchesInventorySearch([project.name, project.description, project.currentRevision], query) && (preferences.filter === "all" || preferences.filter === "pinned" && preferences.pins.includes(project.id) || preferences.filter === "complete" && project.status === "complete" || preferences.filter === "active" && project.status !== "complete" || preferences.filter === "attention" && tasks.length > 0));
  const compareDate = (value: string) => { const date = Date.parse(value); return Number.isFinite(date) ? date : 0; };
  return [...filtered].sort((a, b) => {
    const pin = Number(preferences.pins.includes(b.project.id)) - Number(preferences.pins.includes(a.project.id));
    if (pin) return pin;
    if (preferences.sort === "attention") { const tasks = b.tasks.length - a.tasks.length; if (tasks) return tasks; }
    if (preferences.sort === "recent") {
      const ar = preferences.recent.indexOf(a.project.id), br = preferences.recent.indexOf(b.project.id);
      if (ar !== br && (ar >= 0 || br >= 0)) return ar < 0 ? 1 : br < 0 ? -1 : ar - br;
      const date = compareDate(b.project.updated) - compareDate(a.project.updated); if (date) return date;
    }
    return a.project.name.localeCompare(b.project.name) || a.project.id.localeCompare(b.project.id);
  });
}
