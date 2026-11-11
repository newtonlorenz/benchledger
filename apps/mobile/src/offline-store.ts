import { QueryCache } from "./query-cache";

/**
 * Persistent last-good responses and the offline stock queue, in one local
 * SQLite database. Every row is keyed by a scope derived from the server
 * address and the authenticated account, so one account never sees another's
 * data. The API token is never written here; it stays in secure storage.
 */
export type SqlValue = string | number | null;
/** The subset of expo-sqlite's async database API this module uses. */
export interface SqlDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: SqlValue[]): Promise<unknown>;
  getAllAsync<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
}
/** Oldest responses beyond this many per scope are evicted. */
export const CACHE_ROW_LIMIT = 300;

const SCHEMA_VERSION = 2;
const schema = `
CREATE TABLE IF NOT EXISTS scopes (scope TEXT PRIMARY KEY NOT NULL, server TEXT NOT NULL, opened_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cache (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (scope, key));
CREATE TABLE IF NOT EXISTS stock_queue (scope TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (scope, id));
`;

export class OfflineStore {
  constructor(private readonly db: SqlDatabase) {}
  async init() {
    // Version 1 only existed in unreleased development builds; it kept the raw account id.
    const [row] = await this.db.getAllAsync<{ user_version: number }>("PRAGMA user_version");
    if ((row?.user_version ?? 0) < SCHEMA_VERSION) {
      await this.db.execAsync("DROP TABLE IF EXISTS scopes; DROP TABLE IF EXISTS cache; DROP TABLE IF EXISTS stock_queue;");
    }
    await this.db.execAsync(`${schema}\nPRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  async readCache(scope: string): Promise<{ key: string; value: unknown; updatedAt: Date }[]> {
    const rows = await this.db.getAllAsync<{ key: string; value: string; updated_at: number }>(
      "SELECT key, value, updated_at FROM cache WHERE scope = ? ORDER BY updated_at", scope);
    const result: { key: string; value: unknown; updatedAt: Date }[] = [];
    for (const row of rows) {
      try { result.push({ key: row.key, value: JSON.parse(row.value), updatedAt: new Date(row.updated_at) }); }
      catch { await this.db.runAsync("DELETE FROM cache WHERE scope = ? AND key = ?", scope, row.key); }
    }
    return result;
  }
  async writeCache(scope: string, key: string, value: unknown, at: Date) {
    await this.db.runAsync("INSERT OR REPLACE INTO cache (scope, key, value, updated_at) VALUES (?, ?, ?, ?)", scope, key, JSON.stringify(value), at.getTime());
    await this.db.runAsync(`DELETE FROM cache WHERE scope = ? AND key NOT IN (SELECT key FROM cache WHERE scope = ? ORDER BY updated_at DESC LIMIT ${CACHE_ROW_LIMIT})`, scope, scope);
  }
  async clearCache(scope: string) { await this.db.runAsync("DELETE FROM cache WHERE scope = ?", scope); }

  /** Only the scope digest is kept; the account identifier itself is never written. */
  async rememberScope(scope: string, server: string) {
    await this.db.runAsync("INSERT OR REPLACE INTO scopes (scope, server, opened_at) VALUES (?, ?, ?)", scope, server, Date.now());
  }
  async rememberedScope(server: string): Promise<string | undefined> {
    const rows = await this.db.getAllAsync<{ scope: string }>("SELECT scope FROM scopes WHERE server = ? ORDER BY opened_at DESC LIMIT 1", server);
    return rows[0]?.scope;
  }
  /** Only one workspace connection exists at a time; other scopes cannot be used again. */
  async purgeOtherScopes(scope: string) {
    for (const table of ["cache", "stock_queue", "scopes"]) await this.db.runAsync(`DELETE FROM ${table} WHERE scope <> ?`, scope);
  }
  async purgeAll() {
    for (const table of ["cache", "stock_queue", "scopes"]) await this.db.runAsync(`DELETE FROM ${table}`);
  }

  async loadEntries<T extends { id: string; seq: number }>(scope: string): Promise<T[]> {
    const rows = await this.db.getAllAsync<{ entry: string }>("SELECT entry FROM stock_queue WHERE scope = ? ORDER BY seq", scope);
    return rows.flatMap((row) => { try { return [JSON.parse(row.entry) as T]; } catch { return []; } });
  }
  async saveEntry(scope: string, entry: { id: string; seq: number }) {
    await this.db.runAsync("INSERT OR REPLACE INTO stock_queue (scope, id, seq, entry) VALUES (?, ?, ?, ?)", scope, entry.id, entry.seq, JSON.stringify(entry));
  }
  async deleteEntry(scope: string, id: string) { await this.db.runAsync("DELETE FROM stock_queue WHERE scope = ? AND id = ?", scope, id); }
}

/**
 * What the session controller needs: open, expire and wipe a workspace's local
 * data. A scope is an opaque digest of the server address and account.
 */
export interface WorkspacePersistence {
  /** The scope last confirmed for this server, if any. */
  remembered(server: string): Promise<string | undefined>;
  scopeOf(server: string, actor: string): Promise<string>;
  /** Open a scope's hydrated cache and discard every other scope. */
  open(server: string, scope: string): Promise<QueryCache>;
  clearCache(scope: string): Promise<void>;
  wipe(): Promise<void>;
}

export class OfflinePersistence implements WorkspacePersistence {
  constructor(readonly store: OfflineStore, private readonly hash: (value: string) => Promise<string>) {}
  scopeOf(server: string, actor: string) { return this.hash(`${server}\n${actor}`); }
  remembered(server: string) { return this.store.rememberedScope(server); }
  async open(server: string, scope: string) {
    await this.store.purgeOtherScopes(scope);
    await this.store.rememberScope(scope, server);
    const cache = new QueryCache({
      // Best effort: a failed disk write leaves the in-memory copy in place.
      write: (key, value, at) => { this.store.writeCache(scope, key, value, at).catch(() => undefined); }
    });
    cache.hydrate(await this.store.readCache(scope));
    return cache;
  }
  clearCache(scope: string) { return this.store.clearCache(scope); }
  wipe() { return this.store.purgeAll(); }
}
