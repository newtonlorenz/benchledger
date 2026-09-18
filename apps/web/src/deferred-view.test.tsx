// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { deferView } from "./deferred-view";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const options = { name: "Model viewer", loading: "Opening model…", recovery: "Your notes remain available." };

it("loads only on use, shares successful loads and keeps new props without remounting", async () => {
  const loaded = vi.fn(() => Promise.resolve({ default: ({ title }: { title: string }) => {
    const [count, setCount] = useState(0);
    return <button onClick={() => setCount(value => value + 1)}>{title}: {count}</button>;
  } }));
  const View = deferView(loaded, options);
  expect(loaded).not.toHaveBeenCalled();
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<View title="First" />); });
  fireEvent.click(await screen.findByRole("button", { name: "First: 0" }));
  view.rerender(<View title="Second" />);
  expect(screen.getByRole("button", { name: "Second: 1" })).toBeTruthy();
  view.unmount(); render(<View title="Reopened" />);
  await screen.findByRole("button", { name: "Reopened: 0" });
  expect(loaded).toHaveBeenCalledOnce();
});

it("contains a failed code load and explains safe recovery without losing a surrounding draft", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const loaded = vi.fn().mockRejectedValue(new Error("Synthetic network failure"));
  const View = deferView(loaded, options);
  function Editor() {
    const [notes, setNotes] = useState("");
    return <><label>Notes<input value={notes} onChange={event => setNotes(event.target.value)} /></label><View /></>;
  }
  render(<Editor />);
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Keep this unsaved instruction" } });
  expect((await screen.findByRole("alert")).textContent).toBe("Model viewer could not be opened.");
  expect(screen.queryByText("Synthetic network failure")).toBeNull();
  expect(screen.getByText(/save any open work, then refresh/u)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry model viewer" })).toBeNull();
  expect(screen.getByLabelText("Notes")).toHaveProperty("value", "Keep this unsaved instruction");
  expect(loaded).toHaveBeenCalledOnce();
});

it("contains rendering failures and retries without downloading a successful module again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let fail = true;
  const loaded = vi.fn(async () => ({ default: () => { if (fail) throw new Error("Synthetic render failure"); return <p>Model restored</p>; } }));
  const View = deferView(loaded, options);
  render(<View />); await screen.findByRole("alert");
  fail = false; fireEvent.click(screen.getByRole("button", { name: "Retry model viewer" }));
  await screen.findByText("Model restored"); expect(loaded).toHaveBeenCalledOnce();
});

it("closing a view during loading does not reopen it when the download finishes", async () => {
  let resolve!: (value: { default: () => React.JSX.Element }) => void;
  const View = deferView(() => new Promise<{ default: () => React.JSX.Element }>(value => { resolve = value; }), options);
  const view = render(<View />);
  expect(screen.getByRole("status").textContent).toBe("Opening model…");
  view.unmount();
  await act(async () => { resolve({ default: () => <p>Late model</p> }); });
  expect(screen.queryByText("Late model")).toBeNull();
});
