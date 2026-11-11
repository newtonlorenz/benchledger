/**
 * Responses for the current connection. A persistent workspace passes a
 * `write` sink that copies each response to the scoped offline store, and
 * hydrates the last-good copies on launch; the sample workspace and tests
 * stay in memory. Disconnecting or switching server drops the cache with the
 * session. `revalidate()` asks every focused screen to refresh in the background.
 */
export type CacheSink = { write(key: string, value: unknown, updatedAt: Date): void };
export class QueryCache {
  private readonly entries = new Map<string, { value: unknown; updatedAt: Date }>();
  private readonly listeners = new Set<() => void>();
  private readonly watchers = new Set<() => void>();
  constructor(private readonly sink?: CacheSink) {}
  get<T>(key: string): { value: T; updatedAt: Date } | undefined {
    return this.entries.get(key) as { value: T; updatedAt: Date } | undefined;
  }
  set(key: string, value: unknown, updatedAt = new Date()) {
    this.entries.set(key, { value, updatedAt });
    this.sink?.write(key, value, updatedAt);
    this.changed();
  }
  /** Load persisted entries without writing them back. */
  hydrate(rows: Iterable<{ key: string; value: unknown; updatedAt: Date }>) {
    for (const { key, value, updatedAt } of rows) this.entries.set(key, { value, updatedAt });
    this.changed();
  }
  /** The most recent successful response, for "Last synced" labels. */
  lastSyncedAt(): Date | undefined {
    let latest: Date | undefined;
    for (const { updatedAt } of this.entries.values()) if (!latest || updatedAt > latest) latest = updatedAt;
    return latest;
  }
  get persistent() { return this.sink !== undefined; }
  delete(key: string) { this.entries.delete(key); this.changed(); }
  clear() { this.entries.clear(); this.changed(); }
  /** Notified after any entry changes, e.g. to refresh a "Last synced" label. */
  onChange = (listener: () => void): (() => void) => {
    this.watchers.add(listener);
    return () => { this.watchers.delete(listener); };
  };
  private changed() { for (const watcher of [...this.watchers]) watcher(); }
  onRevalidate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  revalidate() { for (const listener of [...this.listeners]) listener(); }
}
export type CacheScope = { cache: QueryCache; key: string };
