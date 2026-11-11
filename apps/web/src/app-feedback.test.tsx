// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "./api";
import { formatUpdatedAgo, isAmbiguousMutation, SessionExpiredOverlay, SyncBanner, SyncStatusNote, ToastRegion, useRevalidateOnFocus, useToast, writeFailureMessage } from "./app-feedback";
import type { ToastTone } from "./app-feedback";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function ToastHarness() {
  const [route, setRoute] = useState("a");
  const toast = useToast(route);
  const show = (tone: ToastTone) => () => toast.show(`${tone} message`, tone);
  return <>
    <button onClick={show("success")}>success</button><button onClick={show("info")}>info</button><button onClick={show("error")}>error</button><button onClick={show("warning")}>warning</button>
    <button onClick={() => setRoute((current) => current + "x")}>route</button>
    <button onClick={() => { setRoute((current) => current + "y"); toast.show("created and opened", "success"); }}>navigate with toast</button>
    <ToastRegion toast={toast.toast} onDismiss={toast.dismiss} />
  </>;
}

describe("toasts", () => {
  it("keeps errors until dismissed and announces them as alerts", () => {
    vi.useFakeTimers();
    render(<ToastHarness />);
    fireEvent.click(screen.getByText("error"));
    act(() => { vi.advanceTimersByTime(60_000); });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("error message");
    expect(alert.getAttribute("aria-live")).toBeNull();
    fireEvent.click(screen.getByLabelText("Dismiss notification"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("auto-dismisses success/info after about five seconds as status messages", () => {
    vi.useFakeTimers();
    render(<ToastHarness />);
    fireEvent.click(screen.getByText("info"));
    expect(screen.getByRole("status").textContent).toContain("info message");
    act(() => { vi.advanceTimersByTime(5100); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("treats warnings as alerts that persist", () => {
    vi.useFakeTimers();
    render(<ToastHarness />);
    fireEvent.click(screen.getByText("warning"));
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByRole("alert").className).toContain("toast-warning");
  });

  it("keeps a confirmation raised in the same update as the navigation", () => {
    render(<ToastHarness />);
    fireEvent.click(screen.getByText("navigate with toast"));
    expect(screen.getByRole("status").textContent).toContain("created and opened");
  });

  it("clears transient toasts on route change but keeps errors", () => {
    render(<ToastHarness />);
    fireEvent.click(screen.getByText("success"));
    fireEvent.click(screen.getByText("route"));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByText("error"));
    fireEvent.click(screen.getByText("route"));
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

describe("write failure wording", () => {
  it("asks for a reload on a stale conflict instead of blaming the values", () => {
    const stale = new ApiError("Project version changed since it was loaded", { kind: "conflict", status: 409, code: "conflict" });
    expect(writeFailureMessage(stale, "saving that project")).toBe("This changed elsewhere — reload to see the latest.");
    expect(isAmbiguousMutation(stale)).toBe(false);
  });

  it("shows the server's message for a business-rule conflict", () => {
    const rule = new ApiError("Reserved stock cannot be retired", { kind: "conflict", status: 409, code: "conflict" });
    expect(writeFailureMessage(rule, "deleting that item")).toContain("Reserved stock cannot be retired");
  });

  it("distinguishes a reused idempotency key", () => {
    const reused = new ApiError("Idempotency key was used with a different request", { kind: "conflict", status: 409, code: "idempotency_conflict" });
    expect(writeFailureMessage(reused, "saving")).toContain("did not match the original request");
  });

  it("lists the server's validation issues instead of a generic hint", () => {
    const invalid = new ApiError("Request validation failed", { kind: "validation", status: 400, code: "validation", issues: [{ path: "name", message: "Name is required" }, { path: "quantity", message: "Must be positive" }] });
    expect(writeFailureMessage(invalid, "saving that item")).toBe("Cannot complete saving that item. Name is required. Must be positive.");
  });

  it("treats a missing version precondition like a stale conflict", () => {
    const missing = new ApiError("If-Match is required", { kind: "conflict", status: 428, code: "precondition_required" });
    expect(writeFailureMessage(missing, "saving")).toBe("This changed elsewhere — reload to see the latest.");
  });

  it("never claims nothing was saved for an unconfirmed server or network failure", () => {
    for (const kind of ["server", "offline"] as const) {
      const failure = new ApiError("boom", { kind, status: kind === "server" ? 500 : 0 });
      expect(isAmbiguousMutation(failure)).toBe(true);
      expect(writeFailureMessage(failure, "saving")).toContain("We couldn't confirm whether this saved.");
      expect(writeFailureMessage(failure, "saving")).not.toContain("Nothing was saved");
    }
  });
});

describe("sync status", () => {
  it("formats relative update times", () => {
    expect(formatUpdatedAgo(undefined, 0)).toBe("not updated yet");
    expect(formatUpdatedAgo(0, 10_000)).toBe("updated just now");
    expect(formatUpdatedAgo(0, 5 * 60_000)).toBe("updated 5m ago");
    expect(formatUpdatedAgo(0, 3 * 3_600_000)).toBe("updated 3h ago");
  });

  it("shows the real connection state and a retry banner after a failed sync", () => {
    const onRetry = vi.fn();
    const offline = new ApiError("down", { kind: "offline" });
    render(<><SyncStatusNote sampleMode={false} error={offline} lastSyncedAt={0} now={120_000} /><SyncBanner error={offline} lastSyncedAt={0} now={120_000} retrying={false} onRetry={onRetry} /></>);
    expect(screen.getByText("Not syncing")).toBeTruthy();
    expect(screen.getAllByText(/2m ago/u).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("does not show the banner for validation failures", () => {
    render(<SyncBanner error={new ApiError("bad", { kind: "validation", status: 400 })} lastSyncedAt={0} now={0} retrying={false} onRetry={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

function FocusHarness({ onRevalidate, enabled = true }: { onRevalidate: () => void; enabled?: boolean }) {
  useRevalidateOnFocus(onRevalidate, { enabled, minIntervalMs: 1000 });
  return null;
}

describe("focus revalidation", () => {
  it("revalidates on focus at most once per interval", () => {
    vi.useFakeTimers();
    const onRevalidate = vi.fn();
    render(<FocusHarness onRevalidate={onRevalidate} />);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(onRevalidate).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1500); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); });
    expect(onRevalidate).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled", () => {
    vi.useFakeTimers();
    const onRevalidate = vi.fn();
    render(<FocusHarness onRevalidate={onRevalidate} enabled={false} />);
    act(() => { vi.advanceTimersByTime(5000); window.dispatchEvent(new Event("focus")); });
    expect(onRevalidate).not.toHaveBeenCalled();
  });
});

describe("session expiry overlay", () => {
  it("keeps the overlay open with an error when sign-in fails", async () => {
    const onLogin = vi.fn().mockRejectedValueOnce(new ApiError("no", { kind: "unauthenticated", status: 401 })).mockResolvedValueOnce(undefined);
    render(<SessionExpiredOverlay onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText("Workspace password"), { target: { value: "pw" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign in" })); });
    expect(screen.getByRole("alert").textContent).toContain("not accepted");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign in" })); });
    expect(onLogin).toHaveBeenCalledTimes(2);
  });
});
