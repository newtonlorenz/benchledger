// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssemblyWorkspace } from "./assembly-ui";
import { ApiError, workflowRequest } from "./api";
import { projects } from "./mock-data";
import type { AssemblyInput, ProjectAssembly } from "@benchledger/api-contract";
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), workflowRequest: vi.fn() }));
vi.mock("./assembly-canvas", () => ({ default: () => <div aria-label="Synthetic model canvas" /> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(workflowRequest).mockReset(); });
const project = { ...structuredClone(projects[0]!), id: "synthetic-project", serverRevisionId: "synthetic-revision", artifacts: [{ id: "file-1", name: "enclosure.glb", role: "File" as const, revision: "r01", size: "1 KB", hash: "a".repeat(64), updated: "2026-09-12", status: "candidate" as const, projectRevisionId: "synthetic-revision" }] };
project.allArtifacts = project.artifacts;
const source = { artifactId: "file-1", sha256: "a".repeat(64), unit: "metre" as const, upAxis: "y" as const };
const part = { id: "part-1", artifactId: "file-1", nodeId: "mesh-0", name: "Cover", group: "Enclosure", color: "#aabbcc", position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], explode: [0, 0, 20] as [number, number, number], material: "", notes: "" };
const inspection = { sources: [source], parts: [part], geometry: [{ ...part, positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }], warnings: ["Synthetic viewing warning"] };
const saved: ProjectAssembly = { id: "synthetic-revision", projectId: project.id, projectRevisionId: project.serverRevisionId, version: 1, contentSha256: "b".repeat(64), name: "Saved assembly", sources: [source], parts: [part], steps: [], notes: "", updatedAt: "2026-09-12T00:00:00Z", updatedBy: "synthetic" };
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
it("imports with explicit units, edits shared parts/steps and replays an uncertain save unchanged", async () => {
  let persisted: ProjectAssembly | null = null, saves = 0;
  vi.mocked(workflowRequest).mockImplementation(async (path, method, body) => {
    if (path.endsWith("/inspect")) return inspection;
    if (method === "PUT") { if (++saves === 1) throw new ApiError("Disconnected", { kind: "offline" }); persisted = { ...saved, ...body as AssemblyInput }; return { data: persisted }; }
    return { assembly: persisted, warnings: [] };
  });
  render(<AssemblyWorkspace project={project} onFiles={() => {}} />);
  await screen.findByRole("button", { name: "Open assembly" }); fireEvent.click(screen.getByLabelText("enclosure.glb"));
  expect((screen.getByLabelText("Coordinate units for enclosure.glb") as HTMLSelectElement).value).toBe("metre"); expect((screen.getByLabelText("Up axis for enclosure.glb") as HTMLSelectElement).value).toBe("y");
  click("Open assembly"); await screen.findByRole("button", { name: "Cover" }); click("Cover"); click("Edit assembly");
  fireEvent.change(screen.getByLabelText("Fixing notes"), { target: { value: "Fit after wiring." } });
  fireEvent.change(screen.getByLabelText("Separation (mm) Z"), { target: { value: "35" } });
  vi.stubGlobal("crypto", undefined);
  click("Use this separation for group"); click("Add another placement"); click("Build order"); click("Add build step");
  fireEvent.change(screen.getByLabelText("Step title"), { target: { value: "Fit cover" } });
  click("Save assembly"); await screen.findByRole("button", { name: "Retry unchanged assembly" });
  expect(screen.getByLabelText("Step title").matches(":disabled")).toBe(true); click("Retry unchanged assembly"); await screen.findByText(/Saved version 1/);
  const calls = vi.mocked(workflowRequest).mock.calls.filter(c => c[1] === "PUT"); expect(calls).toHaveLength(2); expect(calls[0]![2]).toEqual(calls[1]![2]); expect(calls[0]![3]).toBe(calls[1]![3]);
  expect((calls[1]![2] as AssemblyInput).parts).toHaveLength(2); expect((calls[1]![2] as AssemblyInput).steps[0]!.name).toBe("Fit cover");
});
it("keeps notes accessible when geometry is unavailable and prohibits archived editing", async () => {
  vi.mocked(workflowRequest).mockImplementation(async path => { if (path.endsWith("/inspect")) throw new ApiError("Source unavailable", { kind: "validation", status: 409 }); return { assembly: saved, warnings: ["Source retired"] }; });
  render(<AssemblyWorkspace project={{ ...project, status: "archived" }} onFiles={() => {}} />);
  await screen.findByText("Source unavailable"); click("Cover"); expect(screen.getByRole("heading", { name: "Cover" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit assembly" })).toBeNull(); expect(screen.getByText("Source retired")).toBeTruthy();
});
it("waits for saved geometry before allowing edits that import completion could overwrite", async () => {
  let complete!: (value: typeof inspection) => void;
  const pending = new Promise<typeof inspection>(resolve => { complete = resolve; });
  vi.mocked(workflowRequest).mockImplementation(async path => path.endsWith("/inspect") ? pending : { assembly: saved, warnings: [] });
  render(<AssemblyWorkspace project={project} onFiles={() => {}} />);
  const edit = await screen.findByRole("button", { name: "Edit assembly" });
  expect(edit.matches(":disabled")).toBe(true);
  complete(inspection);
  await waitFor(() => expect(edit.matches(":disabled")).toBe(false));
});
it("retains a conflicting draft and reloads only after an explicit discard", async () => {
  vi.mocked(workflowRequest).mockImplementation(async (path, method) => { if (path.endsWith("/inspect")) return inspection; if (method === "PUT") throw new ApiError("Assembly changed. Reload.", { kind: "validation", status: 409 }); return { assembly: saved, warnings: [] }; });
  render(<AssemblyWorkspace project={project} onFiles={() => {}} />);
  await screen.findByLabelText("Synthetic model canvas"); click("Edit assembly"); fireEvent.change(screen.getByLabelText("Assembly name"), { target: { value: "My unsaved edit" } }); click("Save assembly");
  await screen.findByText("Assembly changed. Reload."); expect((screen.getByLabelText("Assembly name") as HTMLInputElement).value).toBe("My unsaved edit");
  click("Discard edits and reload saved assembly"); await waitFor(() => expect((screen.getByLabelText("Assembly name") as HTMLInputElement).value).toBe("Saved assembly"));
});
it("offers Files when no model is available and requires a revision", async () => {
  vi.mocked(workflowRequest).mockResolvedValue({ assembly: null, warnings: [] }); const onFiles = vi.fn();
  const view = render(<AssemblyWorkspace project={{ ...project, artifacts: [], allArtifacts: [] }} onFiles={onFiles} />); await screen.findByRole("button", { name: "Add model files in Files" }); click("Add model files in Files"); expect(onFiles).toHaveBeenCalledOnce();
  const { serverRevisionId: _revision, ...withoutRevision } = project; view.rerender(<AssemblyWorkspace project={withoutRevision} onFiles={onFiles} />); expect(screen.getByText("Create a project revision to attach an assembly.")).toBeTruthy();
});
it("opens large imports in viewing mode and searches without hiding the selected controls", async () => {
  const parts = Array.from({ length: 26 }, (_, i) => ({ ...part, id: `part-${i}`, name: `Panel ${i + 1}`, group: "Panels" }));
  vi.mocked(workflowRequest).mockImplementation(async path => path.endsWith("/inspect") ? { ...inspection, parts } : { assembly: null, warnings: [] });
  render(<AssemblyWorkspace project={project} onFiles={() => {}} />);
  await screen.findByRole("button", { name: "Select all files" }); click("Select all files");
  expect(screen.getByLabelText("enclosure.glb")).toHaveProperty("checked", true);
  click("Clear selection"); expect(screen.getByRole("button", { name: "Open assembly" }).matches(":disabled")).toBe(true);
  click("Select all files"); click("Open assembly"); await screen.findByRole("button", { name: "Panel 26" });
  expect(screen.queryByLabelText("Assembly name")).toBeNull(); expect(screen.getByRole("button", { name: "Save assembly" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Find a part"), { target: { value: "Panel 26" } });
  expect(screen.queryByRole("button", { name: "Panel 1" })).toBeNull(); click("Panel 26");
  fireEvent.change(screen.getByLabelText("Find a part"), { target: { value: "no match" } });
  expect(screen.getByText("No matching parts.")).toBeTruthy(); expect(screen.getByRole("button", { name: "Isolate part" })).toBeTruthy();
  click("Edit assembly"); expect(screen.getByLabelText("Fixing notes")).toBeTruthy(); click("Done editing"); expect(screen.queryByLabelText("Fixing notes")).toBeNull();
});
