# `@benchledger/artifacts`

The BenchLedger artifact package is a small, filesystem-backed content-addressed
store for project files. CAD, firmware, slicer projects, build files, photos,
and validation reports are treated as opaque bytes: the package does not parse,
execute, extract, or unpack them.

## Guarantees

- Uploads are streamed to a private temporary session and hashed with SHA-256.
- Finalization uses an atomic hard-link into `blobs/sha256/<prefix>/<digest>`.
- Identical bytes share one blob and do not consume another unique-byte quota.
- Per-upload and instance-wide unique storage quotas are enforced at finalize.
- IDs and filenames are validated before they become path segments.
- Generated paths are checked with `lstat`; symlink components are rejected.
- Session metadata, including an explicit 15-minute `expiresAt`, survives a
  process restart and can be recovered or expired. Writes, recovery, and
  finalization at or after the deadline fail closed and reclaim stale bytes.
- Frozen revision manifests are immutable and hash-checked.
- Portable bundles are ordinary directories with a manifest and verified files;
  no archive is extracted during restore.

## Minimal usage

```ts
const store = new ArtifactStore({
  root: "/srv/benchledger/data/artifacts",
  maxUploadBytes: 512 * 1024 * 1024,
  maxStorageBytes: 20 * 1024 * 1024 * 1024
});

const session = await store.beginUpload({
  projectId: "lamp",
  workItemId: "shade",
  revisionId: "r01",
  filename: "shade.step",
  mediaType: "model/step",
  role: "cad-source"
});

if (session.ok) {
  await store.writeUpload(session.value.sessionId, readableStream);
  const artifact = await store.finalizeUpload(session.value.sessionId);
}
```

`ArtifactStoreOptions.clock` is an optional millisecond clock for deterministic
tests; production callers should omit it and use the system clock. The
persisted session deadline is authoritative across restarts.

All store methods return a discriminated `Result<T>` so HTTP and MCP adapters
can preserve stable error codes and actionable details. The application layer
should keep the returned artifact IDs, hashes, provenance, and manifest hash in
its database. Do not expose the store root or arbitrary host paths to clients.
