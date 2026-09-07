// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UnsavedWorkContext, useNavigationGuard, useUnsavedWork } from "./unsaved-work";
import { useWorkflowRead } from "./workflow-ui";
import { ApiError, workflowRequest } from "./api";
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), workflowRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function Editor({ unresolved }: { unresolved: boolean }) { const [text, setText] = useState(""); useUnsavedWork(Boolean(text), "test draft", unresolved); return <input aria-label="Draft" value={text} onChange={(event) => setText(event.target.value)} />; }
function Guard({ unresolved = false }: { unresolved?: boolean }) {
  const guard = useNavigationGuard(); const [page, setPage] = useState("editor");
  return <UnsavedWorkContext.Provider value={guard.registry}>{page === "editor" ? <Editor unresolved={unresolved} /> : <p>Destination</p>}<button onClick={() => guard.registry.request(() => setPage("destination"))}>Navigate</button>{guard.pending && <section aria-label="Navigation decision"><p>{guard.pending.labels.join(",")}</p><button onClick={guard.cancel}>Stay</button><button onClick={guard.discard}>Discard</button></section>}</UnsavedWorkContext.Provider>;
}
it("keeps a dirty draft until a confirmed navigation unmounts the editor", () => {
  render(<Guard />); fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Do not lose this" } }); fireEvent.click(screen.getByText("Navigate"));
  expect(screen.getByLabelText("Navigation decision")).toBeTruthy(); fireEvent.click(screen.getByText("Stay")); expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("Do not lose this");
  const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByText("Navigate")); fireEvent.click(screen.getByText("Discard")); expect(screen.getByText("Destination")).toBeTruthy();
  const after = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
});
it("cannot discard an unresolved mutation, while clean navigation proceeds", () => {
  const component = render(<Guard unresolved />); fireEvent.click(screen.getByText("Navigate")); fireEvent.click(screen.getByText("Discard")); expect(screen.queryByText("Destination")).toBeNull();
  component.unmount(); render(<Guard />); fireEvent.click(screen.getByText("Navigate")); expect(screen.getByText("Destination")).toBeTruthy();
});
function Read({ path }: { path?: string }) { const state = useWorkflowRead<{ name: string }>(path); return <><p>{state.data?.name}</p>{state.loading && <p>Loading</p>}{state.error && <p role="alert">{state.error}</p>}<button onClick={state.reload}>Refresh</button></>; }
it("retains same-scope confirmed data during a failed refresh but never shows it in another scope", async () => {
  vi.mocked(workflowRequest).mockResolvedValueOnce({ name: "Saved workstream" }).mockRejectedValueOnce(new Error("Read failed"));
  const view = render(<Read path="/first" />); await screen.findByText("Saved workstream"); fireEvent.click(screen.getByText("Refresh")); await screen.findByRole("alert"); expect(screen.getByText("Saved workstream")).toBeTruthy();
  let finish: (value: unknown) => void = () => undefined;
  vi.mocked(workflowRequest).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  view.rerender(<Read path="/second" />); expect(screen.queryByText("Saved workstream")).toBeNull(); expect(screen.getByText("Loading")).toBeTruthy();
  await act(async () => finish({ name: "Second scope" })); await screen.findByText("Second scope");
  view.rerender(<Read />); await waitFor(() => expect(screen.queryByText("Loading")).toBeNull()); expect(screen.queryByText("Second scope")).toBeNull();
});
it("ignores a late response for a scope that has already been closed", async () => {
  let finish: (value: unknown) => void = () => undefined;
  vi.mocked(workflowRequest).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce({ name: "Current scope" });
  const view = render(<Read path="/old" />); view.rerender(<Read path="/current" />); await screen.findByText("Current scope");
  await act(async () => finish({ name: "Stale scope" })); expect(screen.queryByText("Stale scope")).toBeNull(); expect(screen.getByText("Current scope")).toBeTruthy();
});

for (const status of [401, 403]) it(`clears retained workflow records when access is denied (${status})`, async () => {
  vi.mocked(workflowRequest).mockResolvedValueOnce({ name: "Private record" }).mockRejectedValueOnce(new ApiError("Access no longer allowed", { kind: status === 401 ? "unauthenticated" : "forbidden", status })).mockResolvedValueOnce({ name: "Access restored" });
  render(<Read path="/private" />); await screen.findByText("Private record");
  fireEvent.click(screen.getByText("Refresh")); await screen.findByRole("alert");
  expect(screen.queryByText("Private record")).toBeNull();
  fireEvent.click(screen.getByText("Refresh")); await screen.findByText("Access restored");
});
