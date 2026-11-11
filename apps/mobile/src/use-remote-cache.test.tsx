// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCallback } from "react";
import { mergeFirstPage, usePage, useRemote } from "./use-remote";
import { QueryCache } from "./query-cache";
import type { Page } from "./client";

// Simulate React Navigation focus: each `focus()` re-runs the focus effect.
const focus = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect, useReducer } = await import("react");
  return { useFocusEffect: (effect: () => (() => void) | void) => {
    const [tick, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => { focus.listeners.add(bump); return () => { focus.listeners.delete(bump); }; }, []);
    useEffect(effect, [effect, tick]);
  } };
});
const refocus = () => act(() => { for (const listener of focus.listeners) listener(); });
afterEach(cleanup);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Item = { id: string };
const items = (...ids: string[]) => ids.map((id) => ({ id }));
const page = (ids: string[], nextCursor?: string): Page<Item> => ({ data: items(...ids), limit: 2, ...(nextCursor ? { nextCursor } : {}) });

describe("stale-while-revalidate details", () => {
  it("keeps data visible while revalidating on focus and reports updating", async () => {
    const next = deferred<string>();
    const load = vi.fn<() => Promise<string>>().mockResolvedValueOnce("first").mockReturnValueOnce(next.promise);
    const { result } = renderHook(() => useRemote(load));
    await waitFor(() => expect(result.current.data).toBe("first"));
    refocus();
    expect(result.current.data).toBe("first");
    expect(result.current.updating).toBe(true);
    await act(async () => next.resolve("second"));
    expect(result.current.data).toBe("second");
    expect(result.current.updating).toBe(false);
  });
  it("renders cached data instantly when a screen is opened again", async () => {
    const cache = new QueryCache();
    const load = vi.fn(async () => "details");
    const first = renderHook(() => useRemote(load, { cache, key: "item:1" }));
    await waitFor(() => expect(first.result.current.data).toBe("details"));
    first.unmount();
    const pending = deferred<string>(); load.mockReturnValueOnce(pending.promise);
    const second = renderHook(() => useRemote(load, { cache, key: "item:1" }));
    expect(second.result.current.data).toBe("details");
    expect(second.result.current.updatedAt).toBeInstanceOf(Date);
    await act(async () => pending.resolve("fresh"));
    expect(second.result.current.data).toBe("fresh");
  });
  it("does not show one record's cached details for another", async () => {
    const cache = new QueryCache(); cache.set("item:1", "one");
    const pending = deferred<string>();
    const { result } = renderHook(() => useRemote(() => pending.promise, { cache, key: "item:2" }));
    expect(result.current.data).toBeUndefined();
  });
  it("revalidates focused screens when the cache is asked to", async () => {
    const cache = new QueryCache();
    const load = vi.fn(async () => "value");
    renderHook(() => useRemote(load, { cache, key: "k" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => cache.revalidate());
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("stale-while-revalidate lists", () => {
  it("keeps loaded pages on focus and refreshes the first page in place", async () => {
    const load = vi.fn(async (cursor?: string) => cursor ? page(["c", "d"]) : page(["a", "b"], "p2"));
    const { result } = renderHook(() => usePage(load));
    await waitFor(() => expect(result.current.page?.data).toHaveLength(2));
    await act(async () => result.current.more());
    expect(result.current.page?.data.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    const next = deferred<Page<Item>>(); load.mockReturnValueOnce(next.promise);
    refocus();
    expect(result.current.page?.data).toHaveLength(4);
    expect(result.current.updating).toBe(true);
    await act(async () => next.resolve(page(["a2", "b"], "p2")));
    expect(result.current.page?.data.map((i) => i.id)).toEqual(["a2", "b", "c", "d"]);
  });
  it("restores the cached list for the same query", async () => {
    const cache = new QueryCache();
    const load = vi.fn(async () => page(["a"]));
    const first = renderHook(() => usePage(load, { cache, key: "inventory:" }));
    await waitFor(() => expect(first.result.current.page).toBeTruthy());
    first.unmount();
    load.mockReturnValueOnce(new Promise(() => undefined));
    const second = renderHook(() => usePage(load, { cache, key: "inventory:" }));
    expect(second.result.current.page?.data).toEqual([{ id: "a" }]);
  });
  it("guards automatic loading at the end of the list", async () => {
    const more = deferred<Page<Item>>();
    const load = vi.fn(async (cursor?: string) => cursor ? more.promise : page(["a", "b"], "p2"));
    const { result } = renderHook(() => usePage(load));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => { result.current.endReached(); result.current.endReached(); });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => more.resolve(page(["c"])));
    expect(result.current.hasMore).toBe(false);
    act(() => result.current.endReached());
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("does not auto-retry a failed page at the end of the list", async () => {
    const load = vi.fn(async (cursor?: string) => { if (cursor) throw new Error("offline"); return page(["a", "b"], "p2"); });
    const { result } = renderHook(() => usePage(load));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    await act(async () => result.current.endReached());
    await act(async () => result.current.endReached());
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeTruthy();
  });
});

describe("first page merge", () => {
  it("replaces a single page", () => expect(mergeFirstPage(page(["a"]), page(["b"]), 1).data).toEqual(items("b")));
  it("keeps later pages and their cursor, without duplicates", () => {
    const merged = mergeFirstPage({ data: items("a", "b", "c", "d"), limit: 2, nextCursor: "p3" }, page(["x", "c"], "p2"), 2);
    expect(merged.data).toEqual(items("x", "c", "d")); expect(merged.nextCursor).toBe("p3");
  });
  it("drops later pages when the list now fits on one page", () => {
    expect(mergeFirstPage({ data: items("a", "b", "c"), limit: 2, nextCursor: "p3" }, page(["a"]), 2)).toEqual(page(["a"]));
  });
});
