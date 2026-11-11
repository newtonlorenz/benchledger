import { ClientError } from "./connection";
import { adjustmentPreview, type StockKind } from "./stock-adjust";

/**
 * Stock counts and receipts recorded at the bench, kept on the device until
 * the server confirms them. Each entry carries one idempotency key for its
 * whole life, so a retry after an ambiguous failure is replayed by the server
 * instead of applied twice. Entries replay strictly in the order recorded;
 * a conflict or refusal holds later changes to the same item for the user.
 *
 * Every send carries the item version the change was based on. Current
 * servers check it atomically (409 `version_conflict`, nothing recorded) and
 * replay an already-applied key before checking it. For older servers, which
 * ignore it, a never-sent change first re-reads the item instead.
 */
export type QueueStatus = "pending" | "sending" | "sent" | "conflict" | "failed";
export type QueueEntry = {
  id: string; seq: number; itemId: string; itemName: string; unit: string;
  kind: StockKind; quantity: number; before: number; after: number;
  /** Item version the change was based on; sent with every attempt. */
  baseVersion: number;
  /** An earlier unsent change to the same item this one builds on. */
  chainedTo?: string;
  key: string; createdAt: string; status: QueueStatus; attempts: number;
  message?: string; serverQuantity?: number; serverVersion?: number; sentAt?: string;
};
export interface QueueStorage {
  load(): Promise<QueueEntry[]>;
  save(entry: QueueEntry): Promise<void>;
  remove(id: string): Promise<void>;
}
export type StockItem = { id: string; version: number; quantity: number; unit: string };
export interface StockApi {
  item(id: string): Promise<StockItem>;
  recordCount(itemId: string, quantity: number, key: string, expectedVersion?: number): Promise<StockItem>;
  recordReceipt(itemId: string, quantity: number, unit: string, key: string, expectedVersion?: number): Promise<StockItem>;
  /** The server checks `expectedVersion` atomically; no client-side re-read is needed. */
  readonly atomicStockVersionCheck?: boolean;
}
export type ReplayResult = { sent: StockItem[]; offline: boolean; stopped?: "unauthorised" };
export type EnqueueInput = {
  itemId: string; itemName: string; unit: string; kind: StockKind; quantity: number;
  item: { quantity: number; version: number };
};

const SENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const unsentStatuses = new Set<QueueStatus>(["pending", "sending", "conflict", "failed"]);
const ambiguous = "Not confirmed yet. It will be resent with the same request, so it cannot be applied twice.";
const changedOnServer = "This item changed on the server since you recorded this.";

type Outcome = "offline" | "unauthorised" | "conflict" | "failed";
function classify(error: unknown): { outcome: Outcome; message: string } {
  if (!(error instanceof ClientError)) return { outcome: "offline", message: ambiguous };
  if (error.status === 401) return { outcome: "unauthorised", message: error.message };
  if (error.status === 409) return { outcome: "conflict", message: error.message };
  if (error.reason === "unreachable" || error.status === 0 || error.status === 429 || error.status >= 500) return { outcome: "offline", message: error.message };
  return { outcome: "failed", message: error.message };
}

export class StockQueue {
  private list: QueueEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private running: Promise<ReplayResult> | undefined;
  private readonly now: () => Date;
  constructor(private readonly storage: QueueStorage, private readonly options: { newKey(): string; now?(): Date }) {
    this.now = options.now ?? (() => new Date());
  }

  get entries(): readonly QueueEntry[] { return this.list; }
  getSnapshot = () => this.list;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** Changes not yet confirmed by the server, optionally for one item. */
  unsent(itemId?: string) { return this.list.filter((e) => unsentStatuses.has(e.status) && (!itemId || e.itemId === itemId)).length; }

  private publish() { this.list = [...this.list]; for (const listener of [...this.listeners]) listener(); }
  private async put(entry: QueueEntry) {
    await this.storage.save(entry);
    const index = this.list.findIndex((e) => e.id === entry.id);
    if (index >= 0) this.list[index] = entry; else this.list.push(entry);
    this.publish();
  }

  async load() {
    const cutoff = this.now().getTime() - SENT_RETENTION_MS;
    const loaded: QueueEntry[] = [];
    for (const entry of await this.storage.load()) {
      if (entry.status === "sent" && Date.parse(entry.sentAt ?? entry.createdAt) < cutoff) { await this.storage.remove(entry.id); continue; }
      // Interrupted mid-send: the server may or may not have applied it.
      loaded.push(entry.status === "sending" ? { ...entry, status: "pending", message: ambiguous } : entry);
    }
    this.list = loaded.sort((a, b) => a.seq - b.seq);
    this.publish();
  }

  /** Persist a change before any network request. */
  async enqueue(input: EnqueueInput): Promise<QueueEntry> {
    const previous = [...this.list].reverse().find((e) => e.itemId === input.itemId && unsentStatuses.has(e.status));
    const before = previous ? previous.after : input.item.quantity;
    const entry: QueueEntry = {
      id: this.options.newKey(), seq: Math.max(0, ...this.list.map((e) => e.seq)) + 1,
      itemId: input.itemId, itemName: input.itemName, unit: input.unit, kind: input.kind, quantity: input.quantity,
      before, after: adjustmentPreview(input.kind, before, input.quantity).after,
      baseVersion: previous ? previous.baseVersion : input.item.version, ...(previous ? { chainedTo: previous.id } : {}),
      key: this.options.newKey(), createdAt: this.now().toISOString(), status: "pending", attempts: 0
    };
    await this.put(entry);
    return entry;
  }

  /** Send unsent changes in order. Concurrent callers share one run. */
  replay(api: StockApi): Promise<ReplayResult> {
    this.running ??= this.run(api).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run(api: StockApi): Promise<ReplayResult> {
    const sent: StockItem[] = [];
    const held = new Set<string>();
    for (const snapshot of [...this.list]) {
      const entry = this.list.find((e) => e.id === snapshot.id);
      if (!entry || entry.status === "sent") continue;
      if (entry.status !== "pending" || held.has(entry.itemId) || entry.chainedTo) {
        if (entry.status === "pending" && (held.has(entry.itemId) || entry.chainedTo)) {
          await this.put({ ...entry, message: "Waiting for an earlier change to this item." });
        }
        held.add(entry.itemId);
        continue;
      }
      // Fallback for servers that ignore the version: a never-sent change must
      // still match the record it was based on.
      if (entry.attempts === 0 && !api.atomicStockVersionCheck) {
        let current: StockItem;
        try { current = await api.item(entry.itemId); }
        catch (error) {
          const { outcome, message } = classify(error);
          if (outcome === "offline") return { sent, offline: true };
          if (outcome === "unauthorised") return { sent, offline: false, stopped: "unauthorised" };
          await this.put({ ...entry, status: "failed", message }); held.add(entry.itemId); continue;
        }
        if (current.version !== entry.baseVersion) {
          await this.put({ ...entry, status: "conflict", serverQuantity: current.quantity, serverVersion: current.version,
            message: changedOnServer });
          held.add(entry.itemId); continue;
        }
      }
      const sending: QueueEntry = { ...entry, status: "sending", attempts: entry.attempts + 1 };
      await this.put(sending);
      try {
        const result = entry.kind === "count"
          ? await api.recordCount(entry.itemId, entry.quantity, entry.key, entry.baseVersion)
          : await api.recordReceipt(entry.itemId, entry.quantity, entry.unit, entry.key, entry.baseVersion);
        const { message: _message, ...rest } = sending;
        await this.put({ ...rest, status: "sent", after: result.quantity, sentAt: this.now().toISOString() });
        sent.push(result);
        // The next change to this item now builds on the confirmed version.
        for (const next of this.list.filter((e) => e.chainedTo === entry.id)) {
          const { chainedTo: _chain, message: _note, ...unchained } = next;
          await this.put({ ...unchained, baseVersion: result.version });
        }
      } catch (error) {
        const { outcome, message } = classify(error);
        if (outcome === "offline") { await this.put({ ...sending, status: "pending", message: ambiguous }); return { sent, offline: true }; }
        if (outcome === "unauthorised") { await this.put({ ...sending, status: "pending", message }); return { sent, offline: false, stopped: "unauthorised" }; }
        if (outcome === "conflict") {
          // Nothing was recorded. Show the latest record so the user can decide.
          const stop = await this.resolveConflict(api, sending, error);
          if (stop) return { sent, ...stop };
        } else await this.put({ ...sending, status: outcome, message });
        held.add(entry.itemId);
      }
    }
    return { sent, offline: false };
  }

  /**
   * A refused (409) send: a version conflict, or the item moved meanwhile on
   * an older server, needs the user's decision with the latest figures; any
   * other refusal is shown as not accepted.
   */
  private async resolveConflict(api: StockApi, sending: QueueEntry, error: unknown): Promise<Omit<ReplayResult, "sent"> | undefined> {
    const message = error instanceof Error ? error.message : changedOnServer;
    let current: StockItem;
    try { current = await api.item(sending.itemId); }
    catch (readError) {
      const read = classify(readError);
      if (read.outcome === "offline") { await this.put({ ...sending, status: "pending", message: `${changedOnServer} Waiting to read the latest record.` }); return { offline: true }; }
      if (read.outcome === "unauthorised") { await this.put({ ...sending, status: "pending", message: read.message }); return { offline: false, stopped: "unauthorised" }; }
      await this.put({ ...sending, status: "failed", message: read.message });
      return undefined;
    }
    const versionConflict = error instanceof ClientError && error.code === "version_conflict";
    if (versionConflict || current.version !== sending.baseVersion) {
      await this.put({ ...sending, status: "conflict", serverQuantity: current.quantity, serverVersion: current.version, message: changedOnServer });
    } else await this.put({ ...sending, status: "failed", message });
    return undefined;
  }

  /** Apply a conflicted change on top of the latest server record. */
  async accept(id: string) {
    const entry = this.list.find((e) => e.id === id);
    if (!entry || entry.status !== "conflict" || entry.serverVersion === undefined || entry.serverQuantity === undefined) return;
    const { message: _message, serverQuantity, serverVersion, ...rest } = entry;
    await this.put({ ...rest, status: "pending", baseVersion: serverVersion, before: serverQuantity,
      after: adjustmentPreview(entry.kind, serverQuantity, entry.quantity).after });
    await this.rechain(entry.itemId);
  }
  async retry(id: string) {
    const entry = this.list.find((e) => e.id === id);
    if (!entry || (entry.status !== "failed" && entry.status !== "conflict")) return;
    const { message: _message, ...rest } = entry;
    await this.put({ ...rest, status: "pending" });
  }
  async discard(id: string) {
    const entry = this.list.find((e) => e.id === id);
    if (!entry || entry.status === "sending") return;
    for (const next of this.list.filter((e) => e.chainedTo === id)) {
      const { chainedTo: _chain, ...rest } = next;
      await this.put(entry.chainedTo ? { ...rest, chainedTo: entry.chainedTo } : { ...rest, baseVersion: entry.baseVersion,
        before: entry.before, after: adjustmentPreview(next.kind, entry.before, next.quantity).after });
    }
    await this.storage.remove(id);
    this.list = this.list.filter((e) => e.id !== id);
    this.publish();
    await this.rechain(entry.itemId);
  }
  async clearSent() {
    for (const entry of this.list.filter((e) => e.status === "sent")) await this.storage.remove(entry.id);
    this.list = this.list.filter((e) => e.status !== "sent");
    this.publish();
  }
  /** Recompute before/after along a chain of unsent changes to one item. */
  private async rechain(itemId: string) {
    let previous: QueueEntry | undefined;
    for (const entry of this.list.filter((e) => e.itemId === itemId && unsentStatuses.has(e.status))) {
      if (previous && entry.chainedTo === previous.id) {
        const after = adjustmentPreview(entry.kind, previous.after, entry.quantity).after;
        if (entry.before !== previous.after || entry.after !== after) await this.put({ ...entry, before: previous.after, after });
      }
      previous = this.list.find((e) => e.id === entry.id);
    }
  }
}
