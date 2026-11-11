import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { CACHE_ROW_LIMIT, OfflinePersistence, OfflineStore, type SqlDatabase, type SqlValue } from "./offline-store";

/** The expo-sqlite async API subset, backed by Node's built-in SQLite. */
function memoryDb(): SqlDatabase & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  return {
    raw,
    execAsync: async (sql: string) => { raw.exec(sql); },
    runAsync: async (sql: string, ...params: SqlValue[]) => { raw.prepare(sql).run(...params); },
    getAllAsync: async <T>(sql: string, ...params: SqlValue[]) => raw.prepare(sql).all(...params) as T[]
  };
}
const hash = async (value: string) => createHash("sha256").update(value).digest("hex");
async function setup() {
  const db = memoryDb();
  const store = new OfflineStore(db);
  await store.init();
  const persistence = new OfflinePersistence(store, hash);
  // Open by account, as the session controller does.
  const open = async (server: string, actor: string) => {
    const scope = await persistence.scopeOf(server, actor);
    return { scope, cache: await persistence.open(server, scope) };
  };
  return { db, store, persistence: Object.assign(persistence, { openAccount: open }) };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("offline cache scoping", () => {
  it("scopes cached responses to the server and account and hydrates them on reopen", async () => {
    const { persistence } = await setup();
    const first = await persistence.openAccount("https://bench.example", "alice");
    first.cache.set("inventory?q=", { page: { data: [{ id: "item-1" }], limit: 50 }, firstLength: 1 }, new Date("2026-11-01T10:00:00Z"));
    await flush();
    const reopened = await persistence.openAccount("https://bench.example", "alice");
    expect(reopened.scope).toBe(first.scope);
    expect(reopened.cache.get("inventory?q=")).toEqual({ value: { page: { data: [{ id: "item-1" }], limit: 50 }, firstLength: 1 }, updatedAt: new Date("2026-11-01T10:00:00Z") });
    expect(reopened.cache.lastSyncedAt()).toEqual(new Date("2026-11-01T10:00:00Z"));
    expect(await persistence.remembered("https://bench.example")).toBe(first.scope);
    expect(await persistence.remembered("https://other.example")).toBeUndefined();
  });
  it("never shows one account's data to another and purges the previous scope", async () => {
    const { persistence } = await setup();
    const alice = await persistence.openAccount("https://bench.example", "alice");
    alice.cache.set("item/item-1", { name: "Alice's part" });
    await flush();
    const bob = await persistence.openAccount("https://bench.example", "bob");
    expect(bob.scope).not.toBe(alice.scope);
    expect(bob.cache.get("item/item-1")).toBeUndefined();
    const aliceAgain = await persistence.openAccount("https://bench.example", "alice");
    expect(aliceAgain.cache.get("item/item-1")).toBeUndefined();
  });
  it("keeps data across reopen of the same schema and resets an older one", async () => {
    const { db, store } = await setup();
    await store.saveEntry("s", { id: "q1", seq: 1 });
    await new OfflineStore(db).init();
    expect(await store.loadEntries("s")).toHaveLength(1);
    db.raw.exec("PRAGMA user_version = 1");
    await new OfflineStore(db).init();
    expect(await store.loadEntries("s")).toEqual([]);
  });
  it("never writes the account identifier itself", async () => {
    const { persistence, db } = await setup();
    await persistence.openAccount("https://bench.example", "mcp-token:token-secret-derived");
    expect(JSON.stringify(db.raw.prepare("SELECT * FROM scopes").all())).not.toContain("token-secret-derived");
  });
  it("wipes every scope, queue entry and remembered account on sign-out", async () => {
    const { persistence, store, db } = await setup();
    const opened = await persistence.openAccount("https://bench.example", "alice");
    opened.cache.set("item/item-1", { name: "Part" });
    await store.saveEntry(opened.scope, { id: "q1", seq: 1 });
    await flush();
    await persistence.wipe();
    for (const table of ["cache", "stock_queue", "scopes"]) {
      expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(await persistence.remembered("https://bench.example")).toBeUndefined();
  });
  it("clears cached responses on token expiry but keeps unsent stock changes for that account", async () => {
    const { persistence, store } = await setup();
    const opened = await persistence.openAccount("https://bench.example", "alice");
    opened.cache.set("item/item-1", { name: "Part" });
    await store.saveEntry(opened.scope, { id: "q1", seq: 1 });
    await flush();
    await persistence.clearCache(opened.scope);
    expect((await persistence.openAccount("https://bench.example", "alice")).cache.get("item/item-1")).toBeUndefined();
    expect(await store.loadEntries(opened.scope)).toEqual([{ id: "q1", seq: 1 }]);
  });
  it("bounds disk use by evicting the oldest responses", async () => {
    const { persistence, store } = await setup();
    const opened = await persistence.openAccount("https://bench.example", "alice");
    for (let index = 0; index <= CACHE_ROW_LIMIT; index++) await store.writeCache(opened.scope, `item/${index}`, { index }, new Date(1_000 + index));
    const rows = await store.readCache(opened.scope);
    expect(rows).toHaveLength(CACHE_ROW_LIMIT);
    expect(rows.some((row) => row.key === "item/0")).toBe(false);
  });
  it("drops corrupt rows instead of failing the launch", async () => {
    const { persistence, db } = await setup();
    const opened = await persistence.openAccount("https://bench.example", "alice");
    db.raw.prepare("INSERT INTO cache (scope, key, value, updated_at) VALUES (?, ?, ?, ?)").run(opened.scope, "broken", "{not json", 1);
    const reopened = await persistence.openAccount("https://bench.example", "alice");
    expect(reopened.cache.get("broken")).toBeUndefined();
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM cache WHERE key = 'broken'").get()).toEqual({ n: 0 });
  });
  it("keeps the in-memory cache working when a disk write fails", async () => {
    const { persistence, store } = await setup();
    const opened = await persistence.openAccount("https://bench.example", "alice");
    vi.spyOn(store, "writeCache").mockRejectedValue(new Error("disk full"));
    opened.cache.set("item/item-1", { name: "Part" });
    await flush();
    expect(opened.cache.get("item/item-1")?.value).toEqual({ name: "Part" });
  });
  it("orders queue entries by sequence and updates them in place", async () => {
    const { store } = await setup();
    await store.saveEntry("s", { id: "b", seq: 2 });
    await store.saveEntry("s", { id: "a", seq: 1 });
    await store.saveEntry("s", { id: "b", seq: 2, status: "sent" });
    expect(await store.loadEntries("s")).toEqual([{ id: "a", seq: 1 }, { id: "b", seq: 2, status: "sent" }]);
    await store.deleteEntry("s", "a");
    expect(await store.loadEntries("s")).toEqual([{ id: "b", seq: 2, status: "sent" }]);
    expect(await store.loadEntries("other")).toEqual([]);
  });
});
