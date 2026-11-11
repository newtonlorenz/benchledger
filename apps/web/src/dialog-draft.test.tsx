// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dialog } from "./App";
import { useDialogDraft } from "./dialog-draft";

afterEach(cleanup);

function DraftForm() {
  const [value, setValue] = useState("");
  useDialogDraft(value.trim().length > 0);
  return <input aria-label="Name" value={value} onChange={(event) => setValue(event.target.value)} />;
}

function renderDialog() {
  const onClose = vi.fn();
  const view = render(<Dialog title="New project" onClose={onClose}><DraftForm /></Dialog>);
  const scrim = view.container.querySelector(".dialog-scrim") as HTMLElement;
  return { onClose, scrim };
}

describe("draft-aware dialogs", () => {
  it("closes on scrim click and Escape when nothing was typed", () => {
    const { onClose, scrim } = renderDialog();
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("ignores scrim clicks once the form has typed input", () => {
    const { onClose, scrim } = renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Desk lamp" } });
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Desk lamp");
  });

  it("asks before discarding on Escape or the close button", () => {
    const { onClose } = renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Desk lamp" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Discard what you typed?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard what you typed?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
