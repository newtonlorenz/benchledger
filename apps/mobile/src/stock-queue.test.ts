import { describe, expect, it, vi } from "vitest";
import { ClientError } from "./connection";
import { StockQueue, type QueueEntry, type QueueStorage, type StockApi, type StockItem } from "./stock-queue";

function memoryStorage(initial: QueueEntry[] = []): QueueStorage & { rows: Map<string, QueueEntry> } {
  const rows = new Map(initial.map((entry) => [entry.id, entry]));
  return {
    rows,
    load: vi.fn(async () => [...rows.values()].sort((a, b) => a.seq - b.seq).map((entry) => ({ ...entry }))),
    save: vi.fn(async (entry: QueueEntry) => { rows.set(entry.id, { ...entry }); }),
    remove: vi.fn(async (id: string) => { rows.delete(id); })
  };
}
/**
 * A fake server that applies counts and receipts and bumps the version, like
 * the real one. `atomic` servers check If-Match after idempotent replay.
 */
function fakeServer(items: Record<string, StockItem>, atomic = false) {
  const applied: { key: string; itemId: string; kind: string; quantity: number }[] = [];
  const byKey = new Map<string, StockItem>();
  const apply = (itemId: string, key: string, kind: string, quantity: number, expectedVersion?: number) => {
    const replay = byKey.get(key);
    if (replay) return { ...replay };
    const current = items[itemId]!;
    if (atomic && expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new ClientError("This item changed on the server since you recorded this.", 409, "http", "version_conflict");
    }
    const next = { ...current, version: current.version + 1, quantity: kind === "count" ? quantity : current.quantity + quantity };
    items[itemId] = next; byKey.set(key, next); applied.push({ key, itemId, kind, quantity });
    return { ...next };
  };
  const api = {
    item: vi.fn(async (id: string) => ({ ...items[id]! })),
    recordCount: vi.fn(async (itemId: string, quantity: number, key: string, expectedVersion?: number) => apply(itemId, key, "count", quantity, expectedVersion)),
    recordReceipt: vi.fn(async (itemId: string, quantity: number, _unit: string, key: string, expectedVersion?: number) => apply(itemId, key, "receipt", quantity, expectedVersion)),
    atomicStockVersionCheck: atomic
  } satisfies StockApi;
  return { api, applied, items };
}
const offline = () => new ClientError("Could not reach the server.", 0, "unreachable");
let counter = 0;
const newQueue = (storage = memoryStorage()) => new StockQueue(storage, { newKey: () => `key-${++counter}`, now: () => new Date("2026-11-11T10:00:00Z") });
const screws = { id: "item-screws", version: 3, quantity: 40, unit: "each" };
const pla = { id: "item-pla", version: 7, quantity: 1000, unit: "gram" };
const count = (item: StockItem, quantity: number) => ({ itemId: item.id, itemName: item.id, unit: item.unit, kind: "count" as const, quantity, item });
const receipt = (item: StockItem, quantity: number) => ({ ...count(item, quantity), kind: "receipt" as const });

describe("offline stock queue", () => {
  it("saves a change on the device before any network request, with before and after", async () => {
    const storage = memoryStorage(); const queue = newQueue(storage);
    const entry = await queue.enqueue(count(screws, 36));
    expect(entry).toMatchObject({ status: "pending", before: 40, after: 36, baseVersion: 3, attempts: 0 });
    expect(storage.rows.get(entry.id)).toMatchObject({ status: "pending", key: entry.key });
  });
  it("replays queued changes in order once back online", async () => {
    const { api, applied } = fakeServer({ [screws.id]: { ...screws }, [pla.id]: { ...pla } });
    const queue = newQueue();
    await queue.enqueue(count(screws, 36)); await queue.enqueue(receipt(pla, 250));
    const result = await queue.replay(api);
    expect(applied.map((a) => a.itemId)).toEqual([screws.id, pla.id]);
    expect(result).toMatchObject({ offline: false });
    expect(result.sent.map((item) => item.quantity)).toEqual([36, 1250]);
    expect(queue.entries.map((e) => e.status)).toEqual(["sent", "sent"]);
  });
  it("reuses the idempotency key after an ambiguous failure and never double-applies", async () => {
    const server = fakeServer({ [pla.id]: { ...pla } });
    const queue = newQueue();
    const entry = await queue.enqueue(receipt(pla, 250));
    // The request reaches the server, but the response is lost.
    const reachServer = server.api.recordReceipt.getMockImplementation()!;
    server.api.recordReceipt.mockImplementationOnce(async (itemId, quantity, unit, key) => {
      await reachServer(itemId, quantity, unit, key); throw offline();
    });
    expect(await queue.replay(server.api)).toMatchObject({ offline: true });
    expect(queue.entries[0]).toMatchObject({ status: "pending", attempts: 1, message: expect.stringMatching(/same request/u) });
    // The version moved because of our own write; an ambiguous retry must not report a conflict.
    await queue.replay(server.api);
    expect(server.api.recordReceipt.mock.calls.map((call) => call[3])).toEqual([entry.key, entry.key]);
    expect(server.applied).toHaveLength(1);
    expect(server.items[pla.id]!.quantity).toBe(1250);
    expect(queue.entries[0]!.status).toBe("sent");
  });
  it("stops at the first network failure and keeps later entries pending", async () => {
    const { api } = fakeServer({ [screws.id]: { ...screws }, [pla.id]: { ...pla } });
    api.item.mockRejectedValue(offline());
    const queue = newQueue();
    await queue.enqueue(count(screws, 36)); await queue.enqueue(count(pla, 900));
    expect(await queue.replay(api)).toMatchObject({ offline: true, sent: [] });
    expect(api.recordCount).not.toHaveBeenCalled();
    expect(queue.entries.map((e) => [e.status, e.attempts])).toEqual([["pending", 0], ["pending", 0]]);
  });
  it("flags a change made on the server meanwhile as a conflict and holds later changes to that item", async () => {
    const server = fakeServer({ [screws.id]: { ...screws }, [pla.id]: { ...pla } });
    const queue = newQueue();
    await queue.enqueue(count(screws, 36)); await queue.enqueue(receipt(screws, 10)); await queue.enqueue(count(pla, 900));
    server.items[screws.id] = { ...screws, version: 4, quantity: 38 };
    await queue.replay(server.api);
    expect(queue.entries.map((e) => e.status)).toEqual(["conflict", "pending", "sent"]);
    expect(queue.entries[0]).toMatchObject({ serverQuantity: 38, serverVersion: 4, message: expect.stringMatching(/changed on the server/u) });
    expect(queue.entries[1]!.message).toMatch(/earlier change/u);
    expect(server.api.recordCount).toHaveBeenCalledTimes(1);
  });
  it("applies a conflicted change on top of the latest server quantity when the user accepts it", async () => {
    const server = fakeServer({ [screws.id]: { ...screws } });
    const queue = newQueue();
    const first = await queue.enqueue(receipt(screws, 10)); await queue.enqueue(receipt(screws, 5));
    server.items[screws.id] = { ...screws, version: 4, quantity: 38 };
    await queue.replay(server.api);
    await queue.accept(first.id);
    expect(queue.entries.map((e) => [e.before, e.after])).toEqual([[38, 48], [48, 53]]);
    await queue.replay(server.api);
    expect(queue.entries.map((e) => e.status)).toEqual(["sent", "sent"]);
    expect(server.items[screws.id]!.quantity).toBe(53);
  });
  it("chains offline changes to one item without reporting a false conflict", async () => {
    const server = fakeServer({ [screws.id]: { ...screws } });
    const queue = newQueue();
    await queue.enqueue(count(screws, 36));
    const second = await queue.enqueue(receipt(screws, 10));
    expect(second).toMatchObject({ before: 36, after: 46 });
    await queue.replay(server.api);
    expect(queue.entries.map((e) => e.status)).toEqual(["sent", "sent"]);
    expect(server.items[screws.id]).toMatchObject({ quantity: 46, version: 5 });
  });
  it("discarding an earlier change recalculates the later one", async () => {
    const queue = newQueue();
    const first = await queue.enqueue(receipt(screws, 10)); await queue.enqueue(receipt(screws, 5));
    await queue.discard(first.id);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]).toMatchObject({ before: 40, after: 45, baseVersion: 3 });
    expect(queue.entries[0]!.chainedTo).toBeUndefined();
  });
  it("marks server refusals and conflicts for the user instead of dropping them", async () => {
    const server = fakeServer({ [screws.id]: { ...screws }, [pla.id]: { ...pla } });
    server.api.recordCount.mockRejectedValueOnce(new ClientError("This token does not have permission for this action.", 403, "http"));
    server.api.recordReceipt.mockRejectedValueOnce(new ClientError("The record changed.", 409, "http", "version_conflict"));
    const queue = newQueue();
    const failed = await queue.enqueue(count(screws, 36)); await queue.enqueue(receipt(pla, 1));
    await queue.replay(server.api);
    expect(queue.entries.map((e) => e.status)).toEqual(["failed", "conflict"]);
    expect(queue.entries[0]!.message).toMatch(/permission/u);
    await queue.retry(failed.id);
    expect(queue.entries[0]).toMatchObject({ status: "pending" });
    await queue.replay(server.api);
    expect(queue.entries[0]!.status).toBe("sent");
  });
  it("stops without changing entries when the token is rejected", async () => {
    const { api } = fakeServer({ [screws.id]: { ...screws } });
    api.recordCount.mockRejectedValueOnce(new ClientError("expired", 401, "http"));
    const queue = newQueue();
    await queue.enqueue(count(screws, 36));
    expect(await queue.replay(api)).toMatchObject({ stopped: "unauthorised" });
    expect(queue.entries[0]).toMatchObject({ status: "pending", attempts: 1 });
  });
  it("treats an entry interrupted mid-send as ambiguous after a restart", async () => {
    const storage = memoryStorage([{ id: "q1", seq: 1, itemId: screws.id, itemName: "Screws", unit: "each", kind: "count", quantity: 36, before: 40, after: 36, baseVersion: 3, key: "stable-key", createdAt: "2026-11-11T09:00:00Z", status: "sending", attempts: 1 }]);
    const server = fakeServer({ [screws.id]: { ...screws, version: 9 } });
    const queue = newQueue(storage);
    await queue.load();
    expect(queue.entries[0]).toMatchObject({ status: "pending" });
    await queue.replay(server.api);
    expect(server.api.item).not.toHaveBeenCalled();
    expect(server.api.recordCount).toHaveBeenCalledWith(screws.id, 36, "stable-key", 3);
  });
  it("runs one replay at a time", async () => {
    const { api, applied } = fakeServer({ [screws.id]: { ...screws } });
    const queue = newQueue();
    await queue.enqueue(count(screws, 36));
    await Promise.all([queue.replay(api), queue.replay(api)]);
    expect(applied).toHaveLength(1);
  });
  it("reports pending work, notifies subscribers and clears sent entries", async () => {
    const { api } = fakeServer({ [screws.id]: { ...screws } });
    const storage = memoryStorage(); const queue = newQueue(storage);
    const listener = vi.fn(); const stop = queue.subscribe(listener);
    await queue.enqueue(count(screws, 36));
    expect(queue.unsent()).toBe(1); expect(queue.unsent("item-other")).toBe(0);
    await queue.replay(api);
    expect(queue.unsent()).toBe(0);
    await queue.clearSent();
    expect(queue.getSnapshot()).toEqual([]); expect(storage.rows.size).toBe(0);
    expect(listener).toHaveBeenCalled(); stop();
  });
  it("prunes sent entries older than a day on load", async () => {
    const old: QueueEntry = { id: "old", seq: 1, itemId: "a", itemName: "A", unit: "each", kind: "count", quantity: 1, before: 0, after: 1, baseVersion: 1, key: "k-old-entry", createdAt: "2026-11-01T00:00:00Z", status: "sent", attempts: 1, sentAt: "2026-11-01T00:00:00Z" };
    const storage = memoryStorage([old]); const queue = newQueue(storage);
    await queue.load();
    expect(queue.entries).toEqual([]); expect(storage.remove).toHaveBeenCalledWith("old");
  });
});

describe("server-side version check", () => {
  it("sends the version the change was based on and skips the client re-read on current servers", async () => {
    const server = fakeServer({ [screws.id]: { ...screws }, [pla.id]: { ...pla } }, true);
    const queue = newQueue();
    await queue.enqueue(count(screws, 36)); await queue.enqueue(receipt(screws, 4)); await queue.enqueue(receipt(pla, 250));
    await queue.replay(server.api);
    expect(server.api.item).not.toHaveBeenCalled();
    expect(server.api.recordCount).toHaveBeenCalledWith(screws.id, 36, expect.any(String), 3);
    // The chained receipt builds on the version the count produced.
    expect(server.api.recordReceipt.mock.calls.map((call) => call[4])).toEqual([4, 7]);
    expect(queue.entries.map((e) => e.status)).toEqual(["sent", "sent", "sent"]);
    expect(server.items[screws.id]).toMatchObject({ quantity: 40, version: 5 });
  });
  it("maps a 409 version_conflict into the needs-your-decision flow with the latest server figures", async () => {
    const server = fakeServer({ [screws.id]: { ...screws }, [pla.id]: { ...pla } }, true);
    const queue = newQueue();
    const first = await queue.enqueue(count(screws, 36)); await queue.enqueue(receipt(screws, 10)); await queue.enqueue(count(pla, 900));
    server.items[screws.id] = { ...screws, version: 4, quantity: 38 };
    await queue.replay(server.api);
    expect(queue.entries.map((e) => e.status)).toEqual(["conflict", "pending", "sent"]);
    expect(queue.entries[0]).toMatchObject({ serverQuantity: 38, serverVersion: 4, attempts: 1, message: expect.stringMatching(/changed on the server/u) });
    expect(server.applied.map((a) => a.itemId)).toEqual([pla.id]);
    // Accepting resends the same request ID against the version the user has now seen.
    await queue.accept(first.id);
    await queue.replay(server.api);
    expect(server.api.recordCount.mock.calls.filter((call) => call[0] === screws.id).map((call) => [call[2], call[3]])).toEqual([[first.key, 3], [first.key, 4]]);
    expect(queue.entries.map((e) => e.status)).toEqual(["sent", "sent", "sent"]);
    expect(server.items[screws.id]!.quantity).toBe(46);
  });
  it("replays an ambiguous retry from the server even though the version moved", async () => {
    const server = fakeServer({ [pla.id]: { ...pla } }, true);
    const queue = newQueue();
    await queue.enqueue(receipt(pla, 250));
    const reachServer = server.api.recordReceipt.getMockImplementation()!;
    server.api.recordReceipt.mockImplementationOnce(async (...args) => { await reachServer(...args); throw offline(); });
    await queue.replay(server.api);
    await queue.replay(server.api);
    expect(server.applied).toHaveLength(1);
    expect(queue.entries[0]!.status).toBe("sent");
  });
  it("keeps a conflict pending when the latest record cannot be read yet", async () => {
    const server = fakeServer({ [screws.id]: { ...screws, version: 9 } }, true);
    server.api.item.mockRejectedValueOnce(offline());
    const queue = newQueue();
    await queue.enqueue(count(screws, 36));
    expect(await queue.replay(server.api)).toMatchObject({ offline: true });
    expect(queue.entries[0]).toMatchObject({ status: "pending" });
    await queue.replay(server.api);
    expect(queue.entries[0]).toMatchObject({ status: "conflict", serverVersion: 9 });
  });
  it("shows any other 409 as not accepted when the item itself has not changed", async () => {
    const server = fakeServer({ [screws.id]: { ...screws } }, true);
    server.api.recordReceipt.mockRejectedValueOnce(new ClientError("The server adds received stock only after this item has been counted.", 409, "http", "evidence_not_received"));
    const queue = newQueue();
    await queue.enqueue(receipt(screws, 5));
    await queue.replay(server.api);
    expect(queue.entries[0]).toMatchObject({ status: "failed", message: expect.stringMatching(/counted/u) });
  });
  it("treats an unexplained 409 from an older server as a conflict when the item moved", async () => {
    const server = fakeServer({ [screws.id]: { ...screws } });
    server.api.recordCount.mockImplementationOnce(async () => { server.items[screws.id] = { ...screws, version: 5, quantity: 12 }; throw new ClientError("conflict", 409, "http"); });
    const queue = newQueue();
    await queue.enqueue(count(screws, 36));
    await queue.replay(server.api);
    expect(queue.entries[0]).toMatchObject({ status: "conflict", serverQuantity: 12, serverVersion: 5 });
  });
});
