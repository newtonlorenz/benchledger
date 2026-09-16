// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AssemblyInspection } from "@benchledger/api-contract";
import { PcbWorkspace } from "./pcb-ui";
import { workflowRequest } from "./api";
import { projects } from "./mock-data";
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), workflowRequest: vi.fn() }));
vi.mock("./assembly-canvas", () => ({ default: (p: { hidden: Set<string>; view: string }) => <div aria-label="Synthetic PCB canvas" data-hidden={[...p.hidden].join()} data-view={p.view} /> }));
afterEach(() => { cleanup(); vi.mocked(workflowRequest).mockReset(); });
const file = { id: "file-board", name: "synthetic-board.kicad_pcb", role: "Editable CAD" as const, revision: "r01", size: "2 KB", hash: "a".repeat(64), updated: "2026-09-16", status: "candidate" as const, projectRevisionId: "synthetic-revision" };
const project = { ...structuredClone(projects[0]!), id: "synthetic-project", serverRevisionId: "synthetic-revision", artifacts: [file], allArtifacts: [file] };
const result: AssemblyInspection = {
  sources: [{ artifactId: file.id, sha256: file.hash, unit: "millimetre", upAxis: "z" }], warnings: ["External component bodies are not loaded."],
  parts: ["board", "copper", "footprint"].map((kind, i) => ({ id: `part-${i}`, artifactId: file.id, nodeId: `node-${i}`, name: kind === "footprint" ? "R1 · footprint outline" : kind, group: "", color: "#aaaaaa", position: [0,0,0], rotation: [0,0,0], explode: [0,0,0], material: "", notes: "" })),
  geometry: (["board", "copper", "footprint"] as const).map((kind, i) => ({ artifactId: file.id, nodeId: `node-${i}`, name: kind, group: "", color: "#aaaaaa", positions: [0,0,0,1,0,0,0,1,0], indices: [0,1,2], pcb: { kind, side: "top", ...(kind === "footprint" ? { reference: "R1", value: "1k", footprint: "Synthetic:R", modelStatus: "missing" } as const : {}) } }))
};
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const renderViewer = (p = project) => render(<PcbWorkspace project={p} onFiles={() => {}} onAssembly={() => {}} />);
it("uses fixed native coordinates and toggles actual source categories with component details", async () => {
  vi.mocked(workflowRequest).mockResolvedValue(result); renderViewer();
  fireEvent.change(screen.getByLabelText("Board source"), { target: { value: file.id } });
  expect(screen.queryByLabelText("Units")).toBeNull(); click("Open PCB");
  const canvas = await screen.findByLabelText("Synthetic PCB canvas");
  expect(vi.mocked(workflowRequest).mock.calls[0]?.[2]).toEqual({ sources: result.sources });
  click("Bottom"); expect(canvas.getAttribute("data-view")).toBe("bottom");
  fireEvent.click(screen.getByLabelText("Copper", { exact: true })); expect(canvas.getAttribute("data-hidden")).toBe("part-1");
  fireEvent.click(screen.getByLabelText("Component outlines")); expect(canvas.getAttribute("data-hidden")).toContain("part-2");
  click("R1 · footprint outline"); expect(screen.getByRole("heading", { name: "R1" })).toBeTruthy(); expect(screen.getByText("1k")).toBeTruthy();
  click("Isolate selection"); expect(canvas.getAttribute("data-hidden")).toBe("part-0,part-1"); click("Show all"); expect(canvas.getAttribute("data-hidden")).toBe("");
  fireEvent.change(screen.getByLabelText("Find a component or part"), { target: { value: "unknown" } }); expect(screen.getByText("No matching parts.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Save/ })).toBeNull(); expect(vi.mocked(workflowRequest).mock.calls.every(c => c[0].endsWith("/inspect") && c[1] === "POST")).toBe(true);
});
it("discards stale responses after changing source or revision and exposes inspect failures", async () => {
  let resolve!: (v: AssemblyInspection) => void;
  vi.mocked(workflowRequest).mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockRejectedValueOnce(new Error("Source hash differs"));
  const ui = renderViewer(); fireEvent.change(screen.getByLabelText("Board source"), { target: { value: file.id } }); click("Open PCB");
  fireEvent.change(screen.getByLabelText("Board source"), { target: { value: "" } }); resolve(result);
  await waitFor(() => expect(screen.queryByLabelText("Synthetic PCB canvas")).toBeNull());
  fireEvent.change(screen.getByLabelText("Board source"), { target: { value: file.id } }); click("Open PCB"); expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Source hash differs");
  vi.mocked(workflowRequest).mockResolvedValue(result); click("Open PCB"); await screen.findByLabelText("Synthetic PCB canvas");
  ui.rerender(<PcbWorkspace project={{ ...project, artifacts: [{ ...file, hash: "b".repeat(64) }], allArtifacts: [{ ...file, hash: "b".repeat(64) }] }} onFiles={() => {}} onAssembly={() => {}} />);
  expect(screen.queryByLabelText("Synthetic PCB canvas")).toBeNull();
});
it("keeps export units explicit and does not invent layer classifications", async () => {
  const glb = { ...file, name: "board.glb" }; vi.mocked(workflowRequest).mockResolvedValue(result);
  renderViewer({ ...project, artifacts: [glb], allArtifacts: [glb] }); fireEvent.change(screen.getByLabelText("Board source"), { target: { value: file.id } });
  expect(screen.getByLabelText("Units")).toHaveProperty("value", "metre"); expect(screen.getByLabelText("Up axis")).toHaveProperty("value", "y");
  click("Open PCB"); await screen.findByLabelText("Synthetic PCB canvas"); expect(screen.queryByRole("group", { name: "Visibility" })).toBeNull();
});
it("offers files and assembly without writing, and requires an exact revision", () => {
  const files = vi.fn(), assembly = vi.fn(); const ui = render(<PcbWorkspace project={{ ...project, artifacts: [], allArtifacts: [] }} onFiles={files} onAssembly={assembly} />);
  click("Add PCB files"); click("Assembly guide"); expect(files).toHaveBeenCalledOnce(); expect(assembly).toHaveBeenCalledOnce();
  const { serverRevisionId: _, ...noRevision } = project; ui.rerender(<PcbWorkspace project={noRevision} onFiles={files} onAssembly={assembly} />); expect(screen.getByText(/Create a project revision/)).toBeTruthy();
});
