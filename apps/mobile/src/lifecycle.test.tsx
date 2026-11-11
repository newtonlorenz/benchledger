// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ErrorBoundary } from "./error-boundary";
import { foregroundThrottle } from "./foreground";

afterEach(cleanup);

describe("foreground revalidation throttle", () => {
  it("revalidates on the first foreground and at most once per interval", () => {
    let now = 1_000;
    const should = foregroundThrottle(30_000, () => now);
    expect(should("background", "active")).toBe(true);
    now += 5_000; expect(should("background", "active")).toBe(false);
    now += 30_000; expect(should("background", "active")).toBe(true);
  });
  it("ignores transitions that are not a return to the foreground", () => {
    const should = foregroundThrottle(0, () => 0);
    expect(should("active", "background")).toBe(false);
    expect(should("active", "active")).toBe(false);
    expect(should("inactive", "active")).toBe(true);
  });
});

describe("error boundary", () => {
  it("renders a recovery action and remounts the tree", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onError = vi.fn();
    let fail = true;
    function Fragile() { if (fail) throw new Error("render failed"); return <p>Recovered</p>; }
    render(<ErrorBoundary onError={onError} fallback={(reset) => <button onClick={() => { fail = false; reset(); }}>Try again</button>}><Fragile /></ErrorBoundary>);
    expect(onError).toHaveBeenCalledOnce();
    act(() => screen.getByText("Try again").click());
    expect(screen.getByText("Recovered")).toBeTruthy();
  });
  it("resets when its reset key changes", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let fail = true;
    function Fragile() { if (fail) throw new Error("x"); return <p>Fine</p>; }
    function Host() { const [key, setKey] = useState(0); return <><button onClick={() => { fail = false; setKey(key + 1); }}>switch</button>
      <ErrorBoundary resetKey={key} fallback={() => <p>Failed</p>}><Fragile /></ErrorBoundary></>; }
    render(<Host />);
    expect(screen.getByText("Failed")).toBeTruthy();
    act(() => screen.getByText("switch").click());
    expect(screen.getByText("Fine")).toBeTruthy();
  });
});
