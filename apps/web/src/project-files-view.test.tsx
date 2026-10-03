// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ProjectFiles } from "./App";
import { projects } from "./mock-data";
import type { Project } from "./domain";
import type { ProjectFilesViewState } from "./project-files-view";
import { UnsavedWorkContext, useNavigationGuard } from "./unsaved-work";

afterEach(cleanup);
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
    {files && <ProjectFiles key={`${current.id}:${current.serverRevisionId}`} project={current} expert={false} sampleMode={false} onUpload={upload} viewState={view} onViewStateChange={setView} />}
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
    expect(screen.getByLabelText("Choose file scope")).toHaveProperty("value", "project:project-r1");
    expect(screen.queryByRole("button", { name: "Add 1 file" })).toBeNull();
    const file = new File(["test"], "new.step");
    fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [file] } });
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
