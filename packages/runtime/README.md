# BenchLedger production runtime

`@benchledger/runtime` composes the domain repositories and the content-addressed artifact store behind `ApplicationPorts`. It is intentionally separate from the demo in-memory server adapter.

Application mutations run through a required unit-of-work port. The production
implementation serializes mutations, consistent reads, uploads, and backups
with one FIFO re-entrant barrier, then wraps the SQLite portion of a mutation
in an outer `BEGIN IMMEDIATE` transaction. Repository-level synchronous
transactions compose as SQLite savepoints. Events are delivered only after a
successful commit.

## Persistent layout

Pass an absolute `dataDir` outside the source checkout to `createProductionRuntime`. The runtime creates `benchledger.sqlite` and `artifacts/` below that directory, applies the versioned runtime metadata migration, and initializes the artifact store before returning. `maxUploadBytes` and `maxStorageBytes` are required to be positive safe integers; environment fallbacks are `BENCHLEDGER_MAX_UPLOAD_BYTES` and `BENCHLEDGER_MAX_STORAGE_BYTES`.

## Backup and restore

Backups are directory bundles. SQLite is copied with `VACUUM INTO`; the artifact directory is copied as opaque content-addressed files; `benchledger-backup.json` records the SQLite digest and every artifact revision's byte count and SHA-256 digest.

The backup is assembled in a same-parent `.partial-*` directory while the
runtime barrier freezes writes, including raw upload writes. The staged bundle
is independently verified with the runtime's configured upload and storage
quotas, then atomically renamed into place. Failed or interrupted staging is
removed and is never reported as a completed backup. SQLite/audit/idempotency
records are atomic together; filesystem artifact work is a separate store and
can leave recoverable orphan upload data after a database rollback. Startup and
the artifact store's orphan-recovery path are responsible for retry/reclaim.

From a Node ESM script:

```js
import { backupProductionRuntime, restoreProductionBackup, verifyProductionBackup } from "@benchledger/runtime";

const backup = await backupProductionRuntime(runtime, "/var/backups/benchledger/2026-08-30");
await verifyProductionBackup("/var/backups/benchledger/2026-08-30");
const restored = await restoreProductionBackup(
  "/var/backups/benchledger/2026-08-30",
  "/var/lib/benchledger-restore-check"
);
await restored.close();
console.log(backup.databaseSha256);
```

The restore function refuses an existing destination, copies the SQLite file and artifact records, opens the restored runtime, and verifies all recorded hashes before returning it. It does not replace a live data directory. No artifact URL is fetched during backup or restore.
