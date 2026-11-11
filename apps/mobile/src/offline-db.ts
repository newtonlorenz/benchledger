import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";
import { Image } from "expo-image";
import { Directory, Paths } from "expo-file-system";
import { OfflinePersistence, OfflineStore, type WorkspacePersistence } from "./offline-store";
import type { QueueEntry, QueueStorage } from "./stock-queue";

/**
 * Device bindings for the offline store: one SQLite file in the app sandbox.
 * It holds cached responses and unsent stock changes, never the API token.
 */
let opening: Promise<OfflinePersistence> | undefined;
function device(): Promise<OfflinePersistence> {
  opening ??= (async () => {
    const db = await SQLite.openDatabaseAsync("benchledger-offline.db");
    await db.execAsync("PRAGMA journal_mode = WAL;");
    const store = new OfflineStore(db);
    await store.init();
    return new OfflinePersistence(store, (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value));
  })();
  // A failed open is retried on the next call rather than cached forever.
  opening.catch(() => { opening = undefined; });
  return opening;
}

export const devicePersistence: WorkspacePersistence = {
  remembered: async (server) => (await device()).remembered(server),
  scopeOf: async (server, actor) => (await device()).scopeOf(server, actor),
  open: async (server, scope) => (await device()).open(server, scope),
  clearCache: async (scope) => (await device()).clearCache(scope),
  wipe: async () => {
    await (await device()).wipe();
    // Authenticated item photos are disk-cached by expo-image; remove them too.
    await Promise.all([Image.clearDiskCache(), Image.clearMemoryCache()]).catch(() => undefined);
    // Leftover picker/resize copies from an interrupted upload.
    for (const name of ["ImagePicker", "ImageManipulator"]) {
      try { const folder = new Directory(Paths.cache, name); if (folder.exists) folder.delete(); } catch { /* best effort */ }
    }
  }
};

export function deviceQueueStorage(scope: string): QueueStorage {
  return {
    load: async () => (await device()).store.loadEntries<QueueEntry>(scope),
    save: async (entry) => (await device()).store.saveEntry(scope, entry),
    remove: async (id) => (await device()).store.deleteEntry(scope, id)
  };
}
/** Used only when local storage is unavailable; entries last for this session. */
export function memoryQueueStorage(): QueueStorage {
  const rows = new Map<string, QueueEntry>();
  return {
    load: async () => [...rows.values()].sort((a, b) => a.seq - b.seq),
    save: async (entry) => { rows.set(entry.id, entry); },
    remove: async (id) => { rows.delete(id); }
  };
}
