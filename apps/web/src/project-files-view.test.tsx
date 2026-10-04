// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { ProjectFiles, ProjectPage } from "./App";
import * as api from "./api";
import { projects } from "./mock-data";
import type { Project } from "./domain";
import { groupProjectFiles, type ProjectFilesViewState } from "./project-files-view";
import { UnsavedWorkContext, useNavigationGuard } from "./unsaved-work";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const project: Project = {
  ...projects[0]!, id: "files-project", serverRevisionId: "project-r1",
  workItems: [{ id: "body", name: "Body", kind: "part", currentRevisionId: "body-r1" }],
  allArtifacts: [{ id: "body-file", name: "body.step", role: "STEP", revision: "r01", size: "1 B", hash: "a".repeat(64), updated: "2026-10-01", status: "candidate", workItemId: "body", workItemRevisionId: "body-r1" }]
};
function Harness({ current = project, upload = vi.fn(async () => undefined) }: { current?: Project; upload?: (file: File, role: string, target?: import("./artifact-scope").ArtifactUploadTarget) => Promise<void> }) {
  const [view, setView] = useState<ProjectFilesViewState>();
  const [files, setFiles] = useState(true);
  const guard = useNavigationGuard();
  return <UnsavedWorkContext.Provider value={guard.registry}>
    <button onClick={() => guard.registry.request(() => setFiles(!files))}>{files ? "Open Plan" : "Open Files"}</button>
    {files && <ProjectFiles onProjectRefresh={async () => true} key={`${current.id}:${current.serverRevisionId}`} project={current} expert={false} sampleMode={false} onUpload={upload} viewState={view} onViewStateChange={setView} />}
    {guard.pending && <div role="alertdialog"><button onClick={guard.cancel}>Keep files</button><button onClick={guard.discard}>Discard files</button></div>}
  </UnsavedWorkContext.Provider>;
}
function chooseBody() {
  fireEvent.change(screen.getByLabelText("Choose file scope"), { target: { value: "work-item:body:body-r1" } });
  fireEvent.change(screen.getByLabelText("Search project files"), { target: { value: "body" } });
}

it("restores scope and search after leaving Files without creating a draft guard", () => {
  render(<Harness />); chooseBody();
  fireEvent.click(screen.getByText("Open Plan"));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  fireEvent.click(screen.getByText("Open Files"));
  expect(screen.getByLabelText("Choose file scope")).toHaveProperty("value", "work-item:body:body-r1");
  expect(screen.getByLabelText("Search project files")).toHaveProperty("value", "body");
  expect(screen.getByText("body.step", { selector: "strong" })).toBeTruthy();
});

for (const change of ["project", "revision"] as const) {
  it(`does not carry Files browsing or staged files into a different ${change}`, () => {
    const view = render(<Harness />); chooseBody();
    fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [new File(["test"], "staged.step")] } });
    const current = { ...project, ...(change === "project" ? { id: "other-project" } : { serverRevisionId: "project-r2" }) };
    view.rerender(<Harness current={current} />);
    expect(screen.getByLabelText("Choose file scope")).toHaveProperty("value", `project:${current.serverRevisionId}`);
    expect(screen.queryByRole("button", { name: "Add 1 file" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Choose file scope"), { target: { value: "work-item:body:body-r1" } });
    expect(screen.getByLabelText("Search project files")).toHaveProperty("value", "");
  });
}

for (const workItems of [[], [{ id: "body", name: "Body", kind: "part" }], [{ id: "body", name: "Body", kind: "part", currentRevisionId: "body-r2" }]]) {
  it("falls back safely when the selected workstream scope disappears or changes revision", async () => {
    const upload = vi.fn(async () => undefined);
    const view = render(<Harness upload={upload} />); chooseBody();
    fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [new File(["test"], "old-scope.step")] } });
    view.rerender(<Harness current={{ ...project, workItems }} upload={upload} />);
    expect(screen.getByText(`Current revision · ${project.currentRevision}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add 1 file" })).toBeNull();
    const file = new File(["test"], "new.step");
    fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [file] } });
    expect(screen.getByLabelText("Choose file scope")).toHaveProperty("value", "project:project-r1");
    fireEvent.click(screen.getByRole("button", { name: "Add 1 file" }));
    await waitFor(() => expect(upload).toHaveBeenCalledWith(file, "STEP", { kind: "project", projectRevisionId: "project-r1" }));
  });
}

it("keeps staged-file navigation guarded and remembers browsing after an explicit discard", () => {
  render(<Harness />); chooseBody();
  fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [new File(["test"], "staged.step")] } });
  fireEvent.click(screen.getByText("Open Plan"));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  fireEvent.click(screen.getByText("Keep files"));
  expect(screen.getByRole("button", { name: "Add 1 file" })).toBeTruthy();
  fireEvent.click(screen.getByText("Open Plan")); fireEvent.click(screen.getByText("Discard files"));
  fireEvent.click(screen.getByText("Open Files"));
  expect(screen.getByLabelText("Choose file scope")).toHaveProperty("value", "work-item:body:body-r1");
  expect(screen.getByLabelText("Search project files")).toHaveProperty("value", "body");
  expect(screen.queryByRole("button", { name: "Add 1 file" })).toBeNull();
});

it("keeps single-revision browsing clear and reveals exact upload scope when files are staged", () => {
  render(<Harness current={{ ...project, workItems: [] }}/>);
  expect(screen.getByText(`Current revision · ${project.currentRevision}`)).toBeTruthy();
  expect(screen.queryByLabelText("Choose file scope")).toBeNull();
  expect(screen.queryByText("New files will be saved with this project revision.")).toBeNull();
  fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [new File(["test"], "new.step")] } });
  expect(screen.getByLabelText("Choose file scope")).toHaveProperty("value", "project:project-r1");
  expect(screen.getByText("New files will be saved with this project revision.")).toBeTruthy();
});

it("groups current handoff files by task and keeps superseded files in history", () => {
  const base = project.allArtifacts![0]!;
  const { workItemId: _workItemId, workItemRevisionId: _workItemRevisionId, ...projectFile } = base;
  const current: Project = { ...project, allArtifacts: [
    { ...projectFile, id: "print", name: "enclosure.3mf", role: "Build plate", projectRevisionId: "project-r1" },
    { ...base, id: "board", name: "controller.kicad_pcb", role: "File" },
    { ...base, id: "cad", name: "enclosure.step", role: "STEP" },
    { ...base, id: "instructions", name: "assembly.md", role: "Notes" },
    { ...base, id: "previous", name: "previous.stl", role: "STL", status: "superseded" }
  ] };
  render(<Harness current={current}/>);
  expect(screen.getByRole("region", { name: "3D print" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Electronics" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "CAD & firmware" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Instructions" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Details for previous.stl" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Details for enclosure.3mf" }));
  expect(screen.getByRole("complementary", { name: "File details: enclosure.3mf" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Check in your slicer" })).toBeTruthy();
  expect(screen.getByText(/browser preview is unavailable/)).toBeTruthy();
  expect(document.querySelector(".project-file-details img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View history" }));
  expect(screen.getByRole("button", { name: "Details for previous.stl" })).toBeTruthy();
  expect(screen.getByLabelText("Choose files to upload")).toHaveProperty("disabled", true);
});

it("classifies supported fabrication and source files without treating an image as their preview", () => {
  const base = project.allArtifacts![0]!;
  const groups = groupProjectFiles([
    { ...base, id: "print", name: "part.gcode", role: "File" },
    { ...base, id: "pcb", name: "fabrication_package.zip", role: "File" },
    { ...base, id: "firmware", name: "controller.uf2", role: "File" },
    { ...base, id: "photo", name: "reference.png", role: "Photo" }
  ]);
  expect(groups.map(group => group.files.map(file => file.id))).toEqual([["print"], ["pcb"], ["firmware"], ["photo"]]);
});

it("opens and focuses only a new matching image request while ordinary Files stays collapsed", async () => {
  vi.spyOn(api, "workflowRequest").mockResolvedValue(null);
  const handled = vi.fn();
  const props: ComponentProps<typeof ProjectPage> = {
    project, projects: [project], projectView: "active", archivedProjectCount: 0, items: [], offers: [], tab: "files", expert: false, sampleMode: false,
    pcbSupported: false, assemblySupported: false, makerWorkflowsSupported: false, reconciliationSupported: false,
    onImportBom: vi.fn(), onNewInventory: vi.fn(), onTabChange: vi.fn(), onSelectProject: vi.fn(), onProjectViewChange: vi.fn(), onOpenItem: vi.fn(), onNavigate: vi.fn(), onToast: vi.fn(), onNewProject: vi.fn(), onArchive: vi.fn(), onRestore: vi.fn(), onRemove: vi.fn(), onNewRevision: vi.fn(), onEditBuildApproach: vi.fn(), onAddBom: vi.fn(), onResolveBomRole: vi.fn(), onUpload: vi.fn(), onReadReconciliation: vi.fn(), onSaveReconciliation: vi.fn(), onCommitReconciliation: vi.fn(), onRefreshWorkspace: vi.fn(), onListInspections: vi.fn(), onReadInspection: vi.fn(), onPreviewInspection: vi.fn(), onConfirmInspection: vi.fn(), onImageIntentHandled: handled
  };
  const view = render(<ProjectPage {...props}/>);
  const disclosure = screen.getByRole("button", { name: "Project image" });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  view.rerender(<ProjectPage {...props} imageIntent={{ projectId: "another-project", request: 1 }}/>);
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(handled).not.toHaveBeenCalled();

  const imageIntent = { projectId: project.id, request: 2 };
  view.rerender(<ProjectPage {...props} imageIntent={imageIntent}/>);
  await waitFor(() => expect(disclosure.getAttribute("aria-expanded")).toBe("true"));
  expect(document.activeElement).toBe(disclosure);
  expect(handled).toHaveBeenCalledExactlyOnceWith(2);
  fireEvent.click(disclosure);
  view.rerender(<ProjectPage {...props} project={{ ...project }} imageIntent={imageIntent}/>);
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(handled).toHaveBeenCalledOnce();

  view.rerender(<ProjectPage {...props} imageIntent={{ projectId: project.id, request: 3 }}/>);
  await waitFor(() => expect(disclosure.getAttribute("aria-expanded")).toBe("true"));
  expect(handled).toHaveBeenLastCalledWith(3);
});
