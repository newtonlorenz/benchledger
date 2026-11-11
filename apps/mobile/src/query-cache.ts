/**
 * In-memory responses for the current connection only. Nothing is written to
 * disk; disconnecting or switching server drops the cache with the session.
 * `revalidate()` asks every focused screen to refresh in the background.
 */
export class QueryCache {
  private readonly entries = new Map<string, { value: unknown; updatedAt: Date }>();
  private readonly listeners = new Set<() => void>();
  get<T>(key: string): { value: T; updatedAt: Date } | undefined {
    return this.entries.get(key) as { value: T; updatedAt: Date } | undefined;
  }
  set(key: string, value: unknown, updatedAt = new Date()) { this.entries.set(key, { value, updatedAt }); }
  delete(key: string) { this.entries.delete(key); }
  clear() { this.entries.clear(); }
  onRevalidate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  revalidate() { for (const listener of [...this.listeners]) listener(); }
}
export type CacheScope = { cache: QueryCache; key: string };
