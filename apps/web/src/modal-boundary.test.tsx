// @vitest-environment jsdom
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useModalBoundary } from "./modal-boundary";
beforeEach(() => { vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.style.overflow = ""; });
function Fixture({ active = true, empty = false, onClose = () => undefined }: { active?: boolean; empty?: boolean; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null); useModalBoundary(ref, onClose, active);
  return <><button data-testid="outside">Outside</button><aside data-testid="already" inert>Already disabled</aside><section><button data-testid="sibling">Sibling</button><div ref={ref} role="dialog" tabIndex={-1}>{!empty && <><button data-autofocus>Cancel</button><input type="hidden" /><button disabled>Disabled</button><button>Confirm</button></>}</div></section></>;
}
it("isolates siblings, traps visible controls and restores the original inert states", () => {
  const close = vi.fn(); const view = render(<Fixture onClose={close} />);
  expect(document.activeElement).toBe(screen.getByText("Cancel"));
  expect(screen.getByTestId("outside").hasAttribute("inert")).toBe(true);
  expect(screen.getByTestId("sibling").hasAttribute("inert")).toBe(true);
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(screen.getByText("Confirm"));
  fireEvent.keyDown(document, { key: "Tab" }); expect(document.activeElement).toBe(screen.getByText("Cancel"));
  fireEvent.keyDown(document, { key: "Escape" }); expect(close).toHaveBeenCalledOnce();
  view.rerender(<Fixture active={false} onClose={close} />);
  expect(screen.getByTestId("outside").hasAttribute("inert")).toBe(false);
  expect(screen.getByTestId("already").hasAttribute("inert")).toBe(true);
  expect(document.body.style.overflow).toBe("");
});
it("handles an empty or disabled modal and ignores a modal behind another boundary", () => {
  const close = vi.fn(); const view = render(<Fixture empty onClose={close} />);
  const modal = screen.getByRole("dialog"); fireEvent.keyDown(document, { key: "Tab" }); expect(document.activeElement).toBe(modal);
  modal.setAttribute("inert", ""); fireEvent.keyDown(document, { key: "Escape" }); expect(close).not.toHaveBeenCalled(); modal.removeAttribute("inert");
  view.rerender(<Fixture empty active={false} onClose={close} />); fireEvent.keyDown(document, { key: "Escape" }); expect(close).not.toHaveBeenCalled();
});
it("returns focus to its trigger and uses the latest close callback", () => {
  const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
  const first = vi.fn(), second = vi.fn(); const view = render(<Fixture onClose={first} />);
  view.rerender(<Fixture onClose={second} />); fireEvent.keyDown(document, { key: "Escape" }); expect(second).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
  view.unmount(); expect(document.activeElement).toBe(trigger); trigger.remove();
});
