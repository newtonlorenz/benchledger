// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useImperativeHandle, useState, type ReactNode, type Ref } from "react";
import { InventoryPanels } from "./inventory-layout";

const layout = vi.hoisted(() => ({ changed: (_sizes: Record<string, number>) => {}, getSize: vi.fn(() => ({ inPixels: 300 })), resize: vi.fn(), frame: null as FrameRequestCallback | null }));
vi.mock("./components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children, onLayoutChanged }: { children: ReactNode; onLayoutChanged(sizes: Record<string, number>): void }) => { layout.changed = onLayoutChanged; return <div>{children}</div>; },
  ResizablePanel: ({ children, panelRef }: { children: ReactNode; panelRef?: Ref<{ resize: typeof layout.resize; getSize: typeof layout.getSize }> }) => {
    useImperativeHandle(panelRef, () => ({ resize: layout.resize, getSize: layout.getSize }));
    return <div>{children}</div>;
  },
  ResizableHandle: () => <div />,
}));
beforeEach(() => {
  layout.getSize.mockReturnValue({ inPixels: 300 });
  layout.frame = null;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { layout.frame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { layout.frame = null; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("saves settled sizes after rendering for successive parent-reflected drags", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const onChange = vi.fn();
  function ControlledPanels() {
    const [width, setWidth] = useState(300);
    return <><output aria-label="Saved inspector width">{width}</output><InventoryPanels width={width} onChange={next => { onChange(next); setWidth(next); }} register={<button>Stock register</button>} inspector={<aside>Item details</aside>} /></>;
  }
  render(<ControlledPanels />);
  act(() => layout.changed({ "inventory-register": 70, "inventory-inspector-panel": 30 }));
  expect(layout.resize).toHaveBeenCalledExactlyOnceWith(300);

  for (const width of [360, 420]) {
    const previousCalls = onChange.mock.calls.length;
    act(() => {
      layout.changed({ "inventory-register": 100 - width / 10, "inventory-inspector-panel": width / 10 });
    });
    expect(onChange).toHaveBeenCalledTimes(previousCalls);
    // The layout event arrives before the DOM and ResizeObserver have resized.
    layout.getSize.mockReturnValue({ inPixels: width });
    act(() => layout.frame!(0));
    expect(screen.getByLabelText("Saved inspector width").textContent).toBe(String(width));
    expect(onChange).toHaveBeenLastCalledWith(width);
    // The library does not emit a duplicate layout after the parent rerenders.
    expect(layout.resize).toHaveBeenCalledExactlyOnceWith(300);
  }
  expect(onChange.mock.calls).toEqual([[360], [420]]);
});

it("does not restore an old dragged width when reset closes and reopens the inspector", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const onChange = vi.fn();
  const view = render(<InventoryPanels width={388} onChange={onChange} register={<button>Stock register</button>} inspector={<aside>Item details</aside>} />);
  expect(layout.resize).not.toHaveBeenCalled();
  layout.changed({ "inventory-register": 60 });
  expect(layout.resize).not.toHaveBeenCalled();
  layout.changed({ "inventory-register": 60, "inventory-inspector-panel": 40 });
  layout.getSize.mockReturnValue({ inPixels: 388 });
  layout.changed({ "inventory-register": 60, "inventory-inspector-panel": 40 });
  expect(layout.frame).not.toBeNull();
  view.rerender(<InventoryPanels width={300} onChange={onChange} register={<button>Stock register</button>} inspector={null} />);
  expect(layout.frame).toBeNull();
  layout.changed({ "inventory-register": 100 });
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(<InventoryPanels width={300} onChange={onChange} register={<button>Stock register</button>} inspector={<aside>Item details</aside>} />);
  layout.changed({ "inventory-register": 60, "inventory-inspector-panel": 40 });
  expect(layout.resize).toHaveBeenLastCalledWith(300);
  layout.changed({ "inventory-register": 60, "inventory-inspector-panel": 40 });
  layout.getSize.mockReturnValue({ inPixels: 300 });
  act(() => layout.frame!(0));
  expect(onChange).not.toHaveBeenCalled();
  layout.changed({ "inventory-register": 64, "inventory-inspector-panel": 36 });
  layout.getSize.mockReturnValue({ inPixels: 360 });
  act(() => layout.frame!(0));
  expect(onChange).toHaveBeenCalledWith(360);
});
