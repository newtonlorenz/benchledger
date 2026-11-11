// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCallback } from "react";
import { usePage, useRemote } from "./use-remote";
import { ClientError } from "./connection";
import type { Page } from "./client";

vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (effect: () => (() => void) | void) => useEffect(effect, [effect]) };
});
afterEach(cleanup);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Item = { id: string };
const page = (id: string, nextCursor?: string): Page<Item> => ({ data: [{ id }], limit: 50, ...(nextCursor ? { nextCursor } : {}) });

describe("mobile loading lifecycle", () => {
  it("ignores old search results arriving after a new search", async () => {
    const old = deferred<Page<Item>>();
    const latest = deferred<Page<Item>>();
    const { result, rerender } = renderHook(({ query }) => usePage(useCallback(() => query === "old" ? old.promise : latest.promise, [query])), { initialProps: { query: "old" } });
    rerender({ query: "new" });
    await act(async () => latest.resolve(page("new-result")));
    await act(async () => old.resolve(page("stale-result")));
    expect(result.current.page?.data).toEqual([{ id: "new-result" }]);
  });
  it("deduplicates pages and prevents repeated page cursors", async () => {
    const load = vi.fn(async (cursor?: string) => cursor ? page("same-item", "cursor-1") : page("same-item", "cursor-1"));
    const { result } = renderHook(() => usePage(load));
    await waitFor(() => expect(result.current.busy).toBe(false));
    await act(async () => result.current.more());
    expect(result.current.error).toBeTruthy();
    expect(result.current.page?.data).toHaveLength(1);
  });
  it("refresh replaces pagination and drops a late old page", async () => {
    const more = deferred<Page<Item>>();
    let refreshes = 0;
    const load = vi.fn(async (cursor?: string) => cursor ? more.promise : page(`first-${++refreshes}`, "cursor"));
    const { result } = renderHook(() => usePage(load));
    await waitFor(() => expect(result.current.page).toBeTruthy());
    act(() => { void result.current.more(); });
    await act(async () => { await result.current.refresh(); });
    await act(async () => more.resolve(page("late-page")));
    expect(result.current.page?.data).toEqual([{ id: "first-2" }]);
  });
  it("keeps previous details labelled with an error when refreshing fails", async () => {
    const load = vi.fn(async () => "current details");
    const { result } = renderHook(() => useRemote(load));
    await waitFor(() => expect(result.current.data).toBe("current details"));
    load.mockRejectedValueOnce(new ClientError("Server offline"));
    await act(async () => result.current.refresh());
    expect(result.current.data).toBe("current details");
    expect(result.current.error).toBe("Server offline");
    expect(result.current.updatedAt).toBeInstanceOf(Date);
  });
});
