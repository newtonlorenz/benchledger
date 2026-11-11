import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import type { Page } from "./client";
import { errorMessage } from "./connection";
import type { CacheScope } from "./query-cache";

/**
 * Stale-while-revalidate details. Focus, foreground and cache revalidation keep
 * the current data visible (`updating`) instead of clearing the screen. Late
 * results are rejected after blur, a key/search change, disconnect or server switch.
 */
export function useRemote<T>(load: () => Promise<T>, scope?: CacheScope) {
  const generation = useRef(0);
  const cached = scope?.cache.get<T>(scope.key);
  const [data, setData] = useState<T | undefined>(cached?.value);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | undefined>(cached?.updatedAt);
  const loadedFor = useRef(load);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setBusy(true); setError("");
    try {
      const result = await load();
      if (current !== generation.current) return;
      const at = new Date();
      setData(result); setUpdatedAt(at);
      scope?.cache.set(scope.key, result, at);
    } catch (e) { if (current === generation.current) setError(errorMessage(e)); }
    finally { if (current === generation.current) setBusy(false); }
  }, [load, scope?.cache, scope?.key]);
  useFocusEffect(useCallback(() => {
    if (loadedFor.current !== load) {
      // A different record or query: never show the previous one's data.
      loadedFor.current = load;
      const entry = scope?.cache.get<T>(scope.key);
      setData(entry?.value); setUpdatedAt(entry?.updatedAt);
    }
    void refresh();
    const stop = scope?.cache.onRevalidate(() => { void refresh(); });
    return () => { generation.current++; stop?.(); };
  }, [refresh]));
  return { data, error, busy, updating: busy && data !== undefined, refresh, updatedAt };
}

type CachedPage<T> = { page: Page<T>; firstLength: number };

/**
 * Replace the first page with a fresh copy while keeping later loaded pages,
 * so a background revalidation does not collapse a scrolled list.
 */
export function mergeFirstPage<T extends { id: string }>(old: Page<T> | undefined, fresh: Page<T>, firstLength: number): Page<T> {
  if (!old || !fresh.nextCursor || old.data.length <= firstLength) return fresh;
  const ids = new Set(fresh.data.map((item) => item.id));
  const tail = old.data.slice(firstLength).filter((item) => !ids.has(item.id));
  return { ...fresh, data: [...fresh.data, ...tail], ...(old.nextCursor ? { nextCursor: old.nextCursor } : { nextCursor: undefined }) };
}

export function usePage<T extends { id: string }>(load: (cursor?: string) => Promise<Page<T>>, scope?: CacheScope) {
  const generation = useRef(0);
  const locked = useRef(false);
  const seen = useRef(new Set<string>());
  const cached = scope?.cache.get<CachedPage<T>>(scope.key)?.value;
  const pageRef = useRef<Page<T> | undefined>(cached?.page);
  const firstLength = useRef(cached?.firstLength ?? 0);
  const loadedFor = useRef(load);
  const [page, setPage] = useState<Page<T> | undefined>(cached?.page);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const commit = useCallback((next: Page<T>) => {
    pageRef.current = next; setPage(next);
    scope?.cache.set(scope.key, { page: next, firstLength: firstLength.current } satisfies CachedPage<T>);
  }, [scope?.cache, scope?.key]);
  const request = useCallback(async (cursor?: string, mode: "replace" | "append" | "revalidate" = cursor ? "append" : "replace") => {
    if (locked.current) return;
    locked.current = true;
    const current = generation.current;
    setBusy(true); setError("");
    try {
      const next = await load(cursor);
      if (current !== generation.current) return;
      if (cursor && next.nextCursor && (next.nextCursor === cursor || seen.current.has(next.nextCursor))) {
        throw new Error("Repeated page cursor");
      }
      if (cursor) {
        seen.current.add(cursor);
        const old = pageRef.current;
        commit({ ...next, data: old ? [...new Map([...old.data, ...next.data].map((item) => [item.id, item])).values()] : next.data });
      } else if (mode === "revalidate") {
        const merged = mergeFirstPage(pageRef.current, next, firstLength.current);
        firstLength.current = next.data.length;
        if (merged === next) seen.current.clear();
        commit(merged);
      } else {
        seen.current.clear(); firstLength.current = next.data.length; commit(next);
      }
    } catch (e) { if (current === generation.current) setError(errorMessage(e)); }
    finally { if (current === generation.current) { locked.current = false; setBusy(false); } }
  }, [load, commit]);
  /** Explicit pull to refresh: start again from the first page. */
  const refresh = useCallback(() => { generation.current++; locked.current = false; seen.current.clear(); return request(); }, [request]);
  /** Background refresh that keeps loaded pages and scroll position. */
  const revalidate = useCallback(() => request(undefined, pageRef.current ? "revalidate" : "replace"), [request]);
  useFocusEffect(useCallback(() => {
    if (loadedFor.current !== load) {
      loadedFor.current = load;
      const entry = scope?.cache.get<CachedPage<T>>(scope.key)?.value;
      pageRef.current = entry?.page; firstLength.current = entry?.firstLength ?? 0;
      seen.current.clear(); setPage(entry?.page);
    }
    void revalidate();
    const stop = scope?.cache.onRevalidate(() => { void revalidate(); });
    return () => { generation.current++; locked.current = false; stop?.(); };
  }, [revalidate]));
  const hasMore = !!page?.nextCursor;
  const more = useCallback(() => request(pageRef.current?.nextCursor), [request]);
  /** FlatList onEndReached: never re-enter, never auto-retry a failure. */
  const endReached = useCallback(() => {
    if (locked.current || error || !pageRef.current?.nextCursor) return;
    void more();
  }, [error, more]);
  return { page, busy, updating: busy && page !== undefined, error, refresh, more, endReached, hasMore };
}
