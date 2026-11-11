// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useNavigationGuard } from "./unsaved-work";

afterEach(cleanup);

it("protects nested drafts on page navigation while keeping local discard scoped", () => {
  const root = renderHook(() => useNavigationGuard());
  const nested = renderHook(() => useNavigationGuard(root.result.current.registry));
  const closeDrawer = vi.fn(), leavePage = vi.fn();
  act(() => {
    root.result.current.registry.set("requirement", { label: "requirement", unresolved: false });
    nested.result.current.registry.set("count", { label: "stock observation", unresolved: false });
    nested.result.current.registry.request(closeDrawer);
  });
  expect(nested.result.current.pending?.labels).toEqual(["stock observation"]);
  expect(root.result.current.pending).toBeUndefined();
  expect(closeDrawer).not.toHaveBeenCalled();
  act(() => nested.result.current.discard());
  expect(closeDrawer).toHaveBeenCalledOnce();
  nested.unmount();
  act(() => root.result.current.registry.request(leavePage));
  expect(root.result.current.pending?.labels).toEqual(["requirement"]);
  expect(leavePage).not.toHaveBeenCalled();
});

it("blocks page discard for an unresolved nested save and clears it after resolution", () => {
  const root = renderHook(() => useNavigationGuard());
  const nested = renderHook(() => useNavigationGuard(root.result.current.registry));
  const leavePage = vi.fn();
  act(() => {
    nested.result.current.registry.set("count", { label: "stock observation", unresolved: true });
    root.result.current.registry.request(leavePage);
  });
  expect(root.result.current.registry.hasDraft()).toBe(true);
  expect(root.result.current.pending).toMatchObject({ labels: ["stock observation"], unresolved: true });
  act(() => root.result.current.discard());
  expect(leavePage).not.toHaveBeenCalled();
  act(() => {
    root.result.current.cancel();
    nested.result.current.registry.set("count", { label: "stock observation", unresolved: false });
    root.result.current.registry.request(leavePage);
  });
  expect(root.result.current.pending?.unresolved).toBe(false);
  act(() => {
    root.result.current.cancel();
    nested.result.current.registry.set("count");
    root.result.current.registry.request(leavePage);
  });
  expect(root.result.current.registry.hasDraft()).toBe(false);
  expect(root.result.current.pending).toBeUndefined();
  expect(leavePage).toHaveBeenCalledOnce();
});
