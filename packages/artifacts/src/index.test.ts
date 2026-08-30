import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  type ArtifactStoreOptions,
  type BeginUploadInput,
  artifactSha256,
  createRevisionManifest,
  isSafeFilename,
  safeFilename
} from "./index.js";

const stores: ArtifactStore[] = [];

async function makeStore(options: Partial<ArtifactStoreOptions> = {}): Promise<ArtifactStore> {
  const root = await mkdtemp(join(tmpdir(), "benchledger-artifacts-"));
  const store = new ArtifactStore({
    root,
    maxUploadBytes: 1024 * 1024,
    maxStorageBytes: 4 * 1024 * 1024,
    ...options
  });
  stores.push(store);
  return store;
}

function uploadInput(overrides: Partial<BeginUploadInput> = {}): BeginUploadInput {
  return {
    projectId: "lamp",
    workItemId: "shade",
    revisionId: "r01",
    filename: "shade.step",
    mediaType: "model/step",
    role: "cad-source",
    ...overrides
  };
}

function digestBytesForTest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => rm(store.root, { recursive: true, force: true })));
});

describe("safe names and hashing", () => {
  it("accepts ordinary names and rejects path tricks", () => {
    expect(isSafeFilename("front-panel.step")).toBe(true);
    expect(safeFilename("front panel.step")).toBe("front panel.step");
    expect(isSafeFilename("../secrets"), "parent traversal").toBe(false);
    expect(isSafeFilename("a/b.step"), "nested path").toBe(false);
    expect(isSafeFilename("/tmp/file"), "absolute path").toBe(false);
    expect(isSafeFilename("\0bad"), "NUL byte").toBe(false);
    expect(() => safeFilename("../secrets")).toThrowError(/filename/i);
  });

  it("hashes an async stream without buffering the source", async () => {
    const payload = Buffer.from("opaque CAD bytes\n");
    const expected = createHash("sha256").update(payload).digest("hex");
    const result = await artifactSha256(Readable.from([payload.subarray(0, 5), payload.subarray(5)]));
    expect(result.sha256).toBe(expected);
    expect(result.bytes).toBe(payload.byteLength);
  });
});

describe("upload lifecycle", () => {
  it("persists an explicit fifteen-minute expiry and upgrades legacy sessions", async () => {
    let now = Date.parse("2026-08-30T10:00:00.000Z");
    const store = await makeStore({ clock: () => now });
    const session = await store.beginUpload(uploadInput({ projectId: "expiry", workItemId: undefined, revisionId: undefined }));
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(session.value.expiresAt).toBe("2026-08-30T10:15:00.000Z");
    const sessionPath = join(store.root, ".uploads", `${session.value.sessionId}.json`);
    const persisted = JSON.parse(await readFile(sessionPath, "utf8")) as { expiresAt?: string };
    expect(persisted.expiresAt).toBe(session.value.expiresAt);

    await writeFile(sessionPath, JSON.stringify({ ...session.value, version: 1, expiresAt: undefined }));
    now += 1_000;
    const restarted = new ArtifactStore({ root: store.root, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024, clock: () => now });
    stores.push(restarted);
    const recovered = await restarted.recoverUpload(session.value.sessionId);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.expiresAt).toBe("2026-08-30T10:15:00.000Z");
    const upgraded = JSON.parse(await readFile(sessionPath, "utf8")) as { expiresAt?: string };
    expect(upgraded.expiresAt).toBe(recovered.value.expiresAt);
  });

  it("fails closed at the expiry boundary and reclaims stale bytes for every lifecycle path", async () => {
    let now = Date.parse("2026-08-30T10:00:00.000Z");
    const store = await makeStore({ clock: () => now });

    const writeSession = await store.beginUpload(uploadInput({ projectId: "expired-write", workItemId: undefined, revisionId: undefined, expectedBytes: 1 }));
    expect(writeSession.ok).toBe(true);
    if (!writeSession.ok) return;
    now = Date.parse(writeSession.value.expiresAt);
    const expiredWrite = await store.writeUpload(writeSession.value.sessionId, Readable.from(Buffer.from("x")));
    expect(expiredWrite.ok).toBe(false);
    if (!expiredWrite.ok) expect(expiredWrite.error.code).toBe("UPLOAD_STATE");
    const writeRecord = JSON.parse(await readFile(join(store.root, ".uploads", `${writeSession.value.sessionId}.json`), "utf8")) as { status?: string };
    expect(writeRecord.status).toBe("expired");
    expect((await readFile(join(store.root, ".uploads", `${writeSession.value.sessionId}.part`)).catch(() => undefined))).toBeUndefined();

    now = Date.parse("2026-08-30T10:00:00.000Z");
    const finalizeSession = await store.beginUpload(uploadInput({ projectId: "expired-finalize", workItemId: undefined, revisionId: undefined, expectedBytes: 1 }));
    expect(finalizeSession.ok).toBe(true);
    if (!finalizeSession.ok) return;
    await store.writeUpload(finalizeSession.value.sessionId, Readable.from(Buffer.from("x")));
    now = Date.parse(finalizeSession.value.expiresAt);
    const expiredFinalize = await store.finalizeUpload(finalizeSession.value.sessionId);
    expect(expiredFinalize.ok).toBe(false);
    if (!expiredFinalize.ok) expect(expiredFinalize.error.code).toBe("UPLOAD_STATE");
    const finalizeRecord = JSON.parse(await readFile(join(store.root, ".uploads", `${finalizeSession.value.sessionId}.json`), "utf8")) as { status?: string };
    expect(finalizeRecord.status).toBe("expired");
    expect((await readFile(join(store.root, ".uploads", `${finalizeSession.value.sessionId}.part`)).catch(() => undefined))).toBeUndefined();

    now = Date.parse("2026-08-30T10:00:00.000Z");
    const recoverSession = await store.beginUpload(uploadInput({ projectId: "expired-recover", workItemId: undefined, revisionId: undefined, expectedBytes: 1 }));
    expect(recoverSession.ok).toBe(true);
    if (!recoverSession.ok) return;
    await store.writeUpload(recoverSession.value.sessionId, Readable.from(Buffer.from("x")));
    now = Date.parse(recoverSession.value.expiresAt);
    const expiredRecover = await store.recoverUpload(recoverSession.value.sessionId);
    expect(expiredRecover.ok).toBe(false);
    if (!expiredRecover.ok) expect(expiredRecover.error.code).toBe("UPLOAD_STATE");
    const recoverRecord = JSON.parse(await readFile(join(store.root, ".uploads", `${recoverSession.value.sessionId}.json`), "utf8")) as { status?: string };
    expect(recoverRecord.status).toBe("expired");
    expect((await readFile(join(store.root, ".uploads", `${recoverSession.value.sessionId}.part`)).catch(() => undefined))).toBeUndefined();

    now = Date.parse("2026-08-30T10:00:00.000Z");
    const boundary = await store.beginUpload(uploadInput({ projectId: "boundary", workItemId: undefined, revisionId: undefined, expectedBytes: 1 }));
    expect(boundary.ok).toBe(true);
    if (!boundary.ok) return;
    now = Date.parse(boundary.value.expiresAt) - 1;
    expect((await store.writeUpload(boundary.value.sessionId, Readable.from(Buffer.from("x")))).ok).toBe(true);
    now = Date.parse(boundary.value.expiresAt);
    const exactBoundary = await store.writeUpload(boundary.value.sessionId, Readable.from(Buffer.from("y")));
    expect(exactBoundary.ok).toBe(false);
    if (!exactBoundary.ok) expect(exactBoundary.error.code).toBe("UPLOAD_STATE");
  });

  it("validates the injected clock and cleans up already-expired session records", async () => {
    expect(() => new ArtifactStore({ root: "/tmp/clock", maxUploadBytes: 1, maxStorageBytes: 1, clock: 42 as unknown as () => number })).toThrow(/clock/i);
    const invalidClock = await makeStore({ clock: () => Number.NaN });
    const invalidNow = await invalidClock.beginUpload(uploadInput({ projectId: "invalid-clock", workItemId: undefined, revisionId: undefined }));
    expect(invalidNow.ok).toBe(false);
    if (!invalidNow.ok) expect(invalidNow.error.code).toBe("INVALID_INPUT");

    let now = Date.parse("2026-08-30T10:00:00.000Z");
    const store = await makeStore({ clock: () => now });
    const session = await store.beginUpload(uploadInput({ projectId: "already-expired", workItemId: undefined, revisionId: undefined }));
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const sessionPath = join(store.root, ".uploads", `${session.value.sessionId}.json`);
    await writeFile(join(store.root, ".uploads", `${session.value.sessionId}.part`), Buffer.from("stale"));
    await writeFile(sessionPath, JSON.stringify({ ...session.value, version: 1, status: "expired" }));
    const retry = await store.finalizeUpload(session.value.sessionId);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe("UPLOAD_STATE");
    expect((await readFile(join(store.root, ".uploads", `${session.value.sessionId}.part`)).catch(() => undefined))).toBeUndefined();

    now = Date.parse("2026-08-30T10:00:00.000Z");
    const sweepSession = await store.beginUpload(uploadInput({ projectId: "expiry-sweep", workItemId: undefined, revisionId: undefined }));
    expect(sweepSession.ok).toBe(true);
    if (!sweepSession.ok) return;
    await store.writeUpload(sweepSession.value.sessionId, Readable.from(Buffer.from("stale")));
    now = Date.parse(sweepSession.value.expiresAt);
    const swept = await store.expireOrphanUploads({ olderThanMs: Number.MAX_SAFE_INTEGER });
    expect(swept.ok).toBe(true);
    if (swept.ok) expect(swept.value.expiredSessionIds).toContain(sweepSession.value.sessionId);
  });

  it("streams, finalizes atomically, and deduplicates identical bytes", async () => {
    const store = await makeStore();
    const payload = Buffer.from("opaque build file");
    const first = await store.beginUpload(uploadInput({ expectedBytes: payload.length }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const wrote = await store.writeUpload(first.value.sessionId, Readable.from([payload.subarray(0, 4), payload.subarray(4)]));
    expect(wrote.ok).toBe(true);
    const finalized = await store.finalizeUpload(first.value.sessionId);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    expect(finalized.value.sha256).toBe(await artifactSha256(payload).then((value) => value.sha256));
    expect(finalized.value.deduplicated).toBe(false);

    const second = await store.beginUpload(uploadInput({ filename: "copy.step", expectedBytes: payload.length }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await store.writeUpload(second.value.sessionId, Readable.from(payload));
    const duplicate = await store.finalizeUpload(second.value.sessionId);
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) return;
    expect(duplicate.value.deduplicated).toBe(true);
    const usage = await store.getUsage();
    expect(usage.ok).toBe(true);
    if (usage.ok) expect(usage.value.uniqueBytes).toBe(payload.length);
    const bytes = await store.readArtifact(finalized.value.artifactRevisionId);
    expect(bytes.ok).toBe(true);
    if (bytes.ok) expect(bytes.value.bytes.equals(payload)).toBe(true);
  });

  it("cleans up a finalization when persisting the finalized session fails", async () => {
    const store = await makeStore();
    const payload = Buffer.from("session-write failure bytes");
    const session = await store.beginUpload(uploadInput({ expectedBytes: payload.length }));
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    await store.writeUpload(session.value.sessionId, Readable.from(payload));

    type StoreInternals = {
      writeJsonAtomic(path: string, value: unknown): Promise<void>;
    };
    const internals = store as unknown as StoreInternals;
    const originalWriteJsonAtomic = internals.writeJsonAtomic.bind(store);
    const sessionPath = join(store.root, ".uploads", `${session.value.sessionId}.json`);
    let injected = false;
    internals.writeJsonAtomic = async (path, value) => {
      if (!injected && path === sessionPath) {
        injected = true;
        throw new Error("injected finalized-session write failure");
      }
      return originalWriteJsonAtomic(path, value);
    };

    try {
      const failed = await store.finalizeUpload(session.value.sessionId);
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error.message).toContain("finalized-session write failure");
    } finally {
      internals.writeJsonAtomic = originalWriteJsonAtomic;
    }

    expect(injected).toBe(true);
    expect(await store.listArtifactRevisions()).toMatchObject({ ok: true, value: [] });
    expect(await store.getUsage()).toMatchObject({ ok: true, value: { uniqueBytes: 0, blobCount: 0, activeUploadBytes: payload.length } });
    expect(await readFile(join(store.root, "projects", "lamp", "shade", "r01", "artifacts", `${session.value.artifactRevisionId}-shade.step`)).catch(() => undefined)).toBeUndefined();
    expect(await store.recoverUpload(session.value.sessionId)).toMatchObject({ ok: true, value: { status: "open", bytesWritten: payload.length } });

    const retry = await store.finalizeUpload(session.value.sessionId);
    expect(retry).toMatchObject({ ok: true, value: { artifactRevisionId: session.value.artifactRevisionId } });
    if (retry.ok) await expect(store.commitFinalization(session.value.sessionId, retry.value.artifactId)).resolves.toMatchObject({ ok: true });
  });

  it("cleans up a finalization when removing the upload hard link fails", async () => {
    const store = await makeStore();
    const payload = Buffer.from("part unlink failure bytes");
    const session = await store.beginUpload(uploadInput({ expectedBytes: payload.length }));
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    await store.writeUpload(session.value.sessionId, Readable.from(payload));

    type StoreInternals = {
      safeUnlink(path: string): Promise<void>;
    };
    const internals = store as unknown as StoreInternals;
    const originalSafeUnlink = internals.safeUnlink.bind(store);
    const partPath = join(store.root, ".uploads", `${session.value.sessionId}.part`);
    let injected = false;
    internals.safeUnlink = async (path) => {
      if (!injected && path === partPath) {
        injected = true;
        // Exercise the crash-shaped boundary where the hard link is gone but
        // the caller still observes an unlink failure.
        await originalSafeUnlink(path);
        throw new Error("injected upload hard-link unlink failure");
      }
      return originalSafeUnlink(path);
    };

    try {
      const failed = await store.finalizeUpload(session.value.sessionId);
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error.message).toContain("hard-link unlink failure");
    } finally {
      internals.safeUnlink = originalSafeUnlink;
    }

    expect(injected).toBe(true);
    expect(await store.listArtifactRevisions()).toMatchObject({ ok: true, value: [] });
    expect(await store.getUsage()).toMatchObject({ ok: true, value: { uniqueBytes: 0, blobCount: 0, activeUploadBytes: payload.length } });
    expect(await readFile(join(store.root, "projects", "lamp", "shade", "r01", "artifacts", `${session.value.artifactRevisionId}-shade.step`)).catch(() => undefined)).toBeUndefined();
    expect(await store.recoverUpload(session.value.sessionId)).toMatchObject({ ok: true, value: { status: "open", bytesWritten: payload.length } });

    const retry = await store.finalizeUpload(session.value.sessionId);
    expect(retry).toMatchObject({ ok: true, value: { artifactRevisionId: session.value.artifactRevisionId } });
    if (retry.ok) await expect(store.commitFinalization(session.value.sessionId, retry.value.artifactId)).resolves.toMatchObject({ ok: true });
  });

  it("reopens a finalized upload during compensation and protects committed artifacts", async () => {
    const store = await makeStore();
    const payload = Buffer.from("retryable opaque bytes");
    const session = await store.beginUpload(uploadInput({ projectId: "compensate", workItemId: "part", revisionId: "r01", expectedBytes: payload.length, expectedSha256: digestBytesForTest(payload) }));
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    await store.writeUpload(session.value.sessionId, Readable.from(payload));
    const finalized = await store.finalizeUpload(session.value.sessionId);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;

    const rollback = await store.rollbackFinalization(session.value.sessionId);
    expect(rollback).toMatchObject({ ok: true, value: { artifactId: finalized.value.artifactId, artifactRecordRemoved: true, blobRemoved: true, projectionRemoved: true } });
    const afterRollback = await store.listArtifactRevisions();
    expect(afterRollback.ok).toBe(true);
    if (afterRollback.ok) expect(afterRollback.value).toHaveLength(0);
    const reopened = await store.recoverUpload(session.value.sessionId);
    expect(reopened).toMatchObject({ ok: true, value: { status: "open", bytesWritten: payload.length } });

    const retried = await store.finalizeUpload(session.value.sessionId);
    expect(retried).toMatchObject({ ok: true, value: { artifactRevisionId: finalized.value.artifactRevisionId, sha256: finalized.value.sha256 } });
    expect((await store.commitFinalization(session.value.sessionId, finalized.value.artifactId)).ok).toBe(true);
    const refused = await store.rollbackFinalization(session.value.sessionId);
    expect(refused).toMatchObject({ ok: false, error: { code: "UPLOAD_STATE" } });
    const afterCommit = await store.listArtifactRevisions();
    expect(afterCommit.ok).toBe(true);
    if (afterCommit.ok) expect(afterCommit.value).toHaveLength(1);
  });

  it("rejects wrong size or expected digest and leaves no committed record", async () => {
    const store = await makeStore();
    const session = await store.beginUpload(uploadInput({ expectedBytes: 3, expectedSha256: "0".repeat(64) }));
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    await store.writeUpload(session.value.sessionId, Readable.from(Buffer.from("four")));
    const result = await store.finalizeUpload(session.value.sessionId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SIZE_MISMATCH");
    const records = await store.listArtifactRevisions();
    expect(records.ok).toBe(true);
    if (records.ok) expect(records.value).toHaveLength(0);
  });

  it("enforces upload and instance quotas while allowing deduplication", async () => {
    const store = await makeStore({ maxUploadBytes: 4, maxStorageBytes: 5 });
    const tooLarge = await store.beginUpload(uploadInput({ expectedBytes: 5 }));
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.error.code).toBe("UPLOAD_QUOTA_EXCEEDED");
    const one = await store.beginUpload(uploadInput({ expectedBytes: 4 }));
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    await store.writeUpload(one.value.sessionId, Readable.from(Buffer.from("same")));
    expect((await store.finalizeUpload(one.value.sessionId)).ok).toBe(true);
    const two = await store.beginUpload(uploadInput({ filename: "two.step", expectedBytes: 2 }));
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    await store.writeUpload(two.value.sessionId, Readable.from(Buffer.from("xx")));
    const quota = await store.finalizeUpload(two.value.sessionId);
    expect(quota.ok).toBe(false);
    if (!quota.ok) expect(quota.error.code).toBe("STORAGE_QUOTA_EXCEEDED");
  });
});

describe("scoping and recovery", () => {
  it("does not follow symlinked project directories", async () => {
    const store = await makeStore();
    const escape = await mkdtemp(join(tmpdir(), "benchledger-escape-"));
    try {
      await symlink(escape, join(store.root, "projects"));
      const result = await store.beginUpload(uploadInput());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("PATH_UNSAFE");
      expect((await readFile(join(escape, "lamp", "shade", "r01", "artifacts", "shade.step")).catch(() => undefined))).toBeUndefined();
    } finally {
      await rm(escape, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked store root", async () => {
    const target = await mkdtemp(join(tmpdir(), "benchledger-root-target-"));
    const parent = await mkdtemp(join(tmpdir(), "benchledger-root-link-"));
    const linkedRoot = join(parent, "store");
    await symlink(target, linkedRoot);
    const linkedStore = new ArtifactStore({ root: linkedRoot, maxUploadBytes: 1024, maxStorageBytes: 2048 });
    const result = await linkedStore.init();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PATH_UNSAFE");
    await rm(parent, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  it("recovers an interrupted session and expires old orphan data", async () => {
    const store = await makeStore();
    const session = await store.beginUpload(uploadInput());
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    await store.writeUpload(session.value.sessionId, Readable.from(Buffer.from("partial")));
    const restarted = new ArtifactStore({ root: store.root, maxUploadBytes: 1024, maxStorageBytes: 2048 });
    const recovered = await restarted.recoverUpload(session.value.sessionId);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.bytesWritten).toBe(7);
    const expired = await restarted.expireOrphanUploads({ olderThanMs: 0, now: new Date(Date.now() + 10) });
    expect(expired.ok).toBe(true);
    if (expired.ok) expect(expired.value.expiredSessionIds).toContain(session.value.sessionId);
    expect((await restarted.recoverUpload(session.value.sessionId)).ok).toBe(false);
  });
});

describe("immutable manifests and portable bundles", () => {
  it("freezes an immutable revision manifest and exports/restores exact bytes", async () => {
    const store = await makeStore();
    const payload = Buffer.from("binary bytes are opaque\0\xff");
    const session = await store.beginUpload(uploadInput({ filename: "board.bin", mediaType: "application/octet-stream" }));
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    await store.writeUpload(session.value.sessionId, Readable.from(payload));
    const revision = await store.finalizeUpload(session.value.sessionId);
    expect(revision.ok).toBe(true);
    if (!revision.ok) return;
    const manifest = await store.freezeRevision({
      projectId: "lamp",
      workItemId: "shade",
      revisionId: "r01",
      entries: [{ artifactRevisionId: revision.value.artifactRevisionId, role: "cad-source", filename: "board.bin" }]
    });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect((await store.freezeRevision({
      projectId: "lamp",
      workItemId: "shade",
      revisionId: "r01",
      entries: [{ artifactRevisionId: revision.value.artifactRevisionId, role: "cad-source", filename: "board.bin" }]
    })).ok).toBe(true);
    const bundleRoot = await mkdtemp(join(tmpdir(), "benchledger-bundle-"));
    const bundle = await store.exportRevisionBundle({ projectId: "lamp", workItemId: "shade", revisionId: "r01", destination: join(bundleRoot, "bundle") });
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;
    const restoredRoot = await mkdtemp(join(tmpdir(), "benchledger-restored-"));
    const restored = new ArtifactStore({ root: restoredRoot, maxUploadBytes: 1024, maxStorageBytes: 4096 });
    const result = await restored.restoreRevisionBundle(bundle.value.bundlePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const restoredBytes = await restored.readArtifact(result.value.artifactRevisionIds[0]!);
      expect(restoredBytes.ok).toBe(true);
      if (restoredBytes.ok) expect(restoredBytes.value.bytes.equals(payload)).toBe(true);
    }
    await rm(bundleRoot, { recursive: true, force: true });
    await rm(restoredRoot, { recursive: true, force: true });
  });

  it("canonicalizes manifest helper output", () => {
    const a = createRevisionManifest({ projectId: "p", revisionId: "r", entries: [{ artifactRevisionId: "b", role: "source", filename: "b" }, { artifactRevisionId: "a", role: "source", filename: "a" }] });
    const b = createRevisionManifest({ projectId: "p", revisionId: "r", entries: [{ artifactRevisionId: "a", role: "source", filename: "a" }, { artifactRevisionId: "b", role: "source", filename: "b" }] });
    expect(a.canonicalJson).toBe(b.canonicalJson);
    expect(a.sha256).toBe(b.sha256);
    const detailed = createRevisionManifest({ projectId: "p", workItemId: "assembly", revisionId: "r", frozenAt: "2026-01-01T00:00:00.000Z", entries: [{ artifactRevisionId: "b", filename: "b.step", role: "cad" }] });
    expect(detailed.manifest.workItemId).toBe("assembly");
    expect(detailed.manifest.entries[0]?.role).toBe("cad");
    const roleOnly = createRevisionManifest({ projectId: "p", revisionId: "r", entries: [{ artifactRevisionId: "a", role: "notes" }] });
    expect(roleOnly.manifest.entries[0]?.role).toBe("notes");
    const completeEntry = createRevisionManifest({ projectId: "p", revisionId: "r", entries: [{ artifactRevisionId: "c", filename: "c.step", role: "cad", artifactId: "artifact-c", mediaType: "model/step", bytes: 12, sha256: "a".repeat(64), storageKey: "blobs/sha256/aa/" + "a".repeat(64) }] });
    expect(completeEntry.manifest.entries[0]?.sha256).toBe("a".repeat(64));
  });
});

describe("validation, immutable state, and maintenance edges", () => {
  it("covers validation boundaries and reports typed failures", async () => {
    expect(() => new ArtifactStore({ root: "", maxUploadBytes: 1, maxStorageBytes: 1 })).toThrow();
    expect(() => new ArtifactStore({ root: "/tmp/a", maxUploadBytes: 0, maxStorageBytes: 1 })).toThrow();
    expect(() => new ArtifactStore({ root: "/tmp/a", maxUploadBytes: 1, maxStorageBytes: 0 })).toThrow();
    expect(() => new ArtifactStore({ root: "/tmp/a", maxUploadBytes: 2, maxStorageBytes: 1 })).toThrow();
    for (const value of ["", ".", "..", "/absolute", "nested/name", "nested\\name", "a:b", "name.", "CON", "\u0000", "\u0001", "a".repeat(256), "／escape"]) {
      expect(isSafeFilename(value)).toBe(false);
    }
    expect(isSafeFilename(42 as unknown as string)).toBe(false);
    expect(safeFilename("Ｆｒｏｎｔ.step")).toBe("Front.step");
    expect(() => createRevisionManifest({ projectId: "p", revisionId: "r", entries: [{ artifactRevisionId: "a" }, { artifactRevisionId: "a" }] })).toThrow(/duplicate/i);
    expect(() => createRevisionManifest({ projectId: "p", revisionId: "r", entries: [{ artifactRevisionId: "a", role: "" }] })).toThrow(/role/i);
    expect(() => createRevisionManifest({ projectId: "p", revisionId: "r", frozenAt: "not-a-date", entries: [] })).toThrow(/frozenAt/i);
    expect(() => createRevisionManifest({ projectId: "p", revisionId: "r", entries: "not-an-array" as unknown as [] })).toThrow(/entries/i);
    await expect(artifactSha256((async function* () { yield "text"; })() as unknown as AsyncIterable<Uint8Array>)).rejects.toThrow(/non-byte/i);
    const fakeHugeChunk = new Proxy(new Uint8Array(0), { get: (target, property, receiver) => property === "byteLength" ? Number.MAX_SAFE_INTEGER + 1 : Reflect.get(target, property, receiver) });
    await expect(artifactSha256((async function* () { yield fakeHugeChunk; })())).rejects.toThrow(/too large/i);
    const store = await makeStore({ maxUploadBytes: 8, maxStorageBytes: 32 });
    const badInput = await store.beginUpload(uploadInput({ projectId: "../escape" }));
    expect(badInput.ok).toBe(false);
    if (!badInput.ok) expect(badInput.error.code).toBe("INVALID_INPUT");
    const badName = await store.beginUpload(uploadInput({ filename: "../escape" }));
    expect(badName.ok).toBe(false);
    if (!badName.ok) expect(badName.error.code).toBe("PATH_UNSAFE");
    const badDigest = await store.beginUpload(uploadInput({ expectedSha256: "ABC" }));
    expect(badDigest.ok).toBe(false);
    if (!badDigest.ok) expect(badDigest.error.code).toBe("INVALID_INPUT");
    const badCount = await store.beginUpload(uploadInput({ expectedBytes: -1 }));
    expect(badCount.ok).toBe(false);
    if (!badCount.ok) expect(badCount.error.code).toBe("INVALID_INPUT");
    const missing = await store.writeUpload("missing-session", Readable.from(Buffer.from("x")));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");
    const invalidId = await store.finalizeUpload("bad/session");
    expect(invalidId.ok).toBe(false);
    if (!invalidId.ok) expect(invalidId.error.code).toBe("INVALID_INPUT");
    const fileRoot = await mkdtemp(join(tmpdir(), "benchledger-file-root-"));
    const rootFile = join(fileRoot, "not-a-directory");
    await writeFile(rootFile, "file");
    const brokenStore = new ArtifactStore({ root: rootFile, maxUploadBytes: 8, maxStorageBytes: 32 });
    const broken = await brokenStore.init();
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.code).toBe("IO_ERROR");
    await rm(fileRoot, { recursive: true, force: true });
  });

  it("handles optional metadata, aborts, retries, and finalized recovery", async () => {
    const store = await makeStore({ maxUploadBytes: 128, maxStorageBytes: 512 });
    const bare = await store.beginUpload({ projectId: "bare", filename: "empty.bin" });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    const progress = await store.writeUploadStream(bare.value.sessionId, Readable.from([]));
    expect(progress.ok).toBe(true);
    const finalizedBare = await store.finalizeUpload(bare.value.sessionId);
    expect(finalizedBare.ok).toBe(true);
    if (!finalizedBare.ok) return;
    expect(finalizedBare.value.projectPath).toBeUndefined();
    expect((await store.recoverUpload(bare.value.sessionId)).ok).toBe(true);
    expect((await store.finalizeUpload(bare.value.sessionId)).ok).toBe(true);
    const abortFinalized = await store.abortUpload(bare.value.sessionId);
    expect(abortFinalized.ok).toBe(false);
    if (!abortFinalized.ok) expect(abortFinalized.error.code).toBe("UPLOAD_STATE");
    const payload = Buffer.from("all metadata");
    const complete = await store.beginUpload({
      projectId: "complete",
      workItemId: "item",
      revisionId: "r02",
      filename: "source.txt",
      mediaType: "text/plain",
      role: "notes",
      description: "a description",
      source: "manual",
      expectedBytes: payload.length,
      expectedSha256: createHash("sha256").update(payload).digest("hex"),
      artifactId: "artifact-fixed",
      artifactRevisionId: "artifact-revision-fixed"
    });
    expect(complete.ok).toBe(true);
    if (!complete.ok) return;
    await store.writeUpload(complete.value.sessionId, Readable.from(payload));
    const committed = await store.finalizeUpload(complete.value.sessionId);
    expect(committed.ok).toBe(true);
    const aborted = await store.beginUpload({ projectId: "abort", filename: "abort.bin" });
    expect(aborted.ok).toBe(true);
    if (!aborted.ok) return;
    expect((await store.abortUpload(aborted.value.sessionId)).ok).toBe(true);
    const abortedAgain = await store.abortUpload(aborted.value.sessionId);
    expect(abortedAgain.ok).toBe(false);
    if (!abortedAgain.ok) expect(abortedAgain.error.code).toBe("NOT_FOUND");
    const expired = await store.recoverUpload(aborted.value.sessionId);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe("NOT_FOUND");
  });

  it("handles stream errors, digest/size errors, and raw orphan parts", async () => {
    const store = await makeStore({ maxUploadBytes: 4, maxStorageBytes: 32 });
    const tooBig = await store.beginUpload(uploadInput({ filename: "too.bin" }));
    expect(tooBig.ok).toBe(true);
    if (!tooBig.ok) return;
    const oversized = await store.writeUpload(tooBig.value.sessionId, Readable.from(Buffer.from("12345")));
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error.code).toBe("UPLOAD_QUOTA_EXCEEDED");
    const invalidStream = await store.writeUpload(tooBig.value.sessionId, (async function* () { yield "bad"; })() as unknown as AsyncIterable<Uint8Array>);
    expect(invalidStream.ok).toBe(false);
    if (!invalidStream.ok) expect(invalidStream.error.code).toBe("INVALID_INPUT");
    const wrongDigest = await store.beginUpload(uploadInput({ filename: "digest.bin", expectedSha256: "0".repeat(64) }));
    expect(wrongDigest.ok).toBe(true);
    if (!wrongDigest.ok) return;
    await store.writeUpload(wrongDigest.value.sessionId, Readable.from(Buffer.from("x")));
    const digestResult = await store.finalizeUpload(wrongDigest.value.sessionId);
    expect(digestResult.ok).toBe(false);
    if (!digestResult.ok) expect(digestResult.error.code).toBe("DIGEST_MISMATCH");
    const wrongSize = await store.beginUpload(uploadInput({ filename: "size.bin", expectedBytes: 2 }));
    expect(wrongSize.ok).toBe(true);
    if (!wrongSize.ok) return;
    await store.writeUpload(wrongSize.value.sessionId, Readable.from(Buffer.from("x")));
    const sizeResult = await store.finalizeUpload(wrongSize.value.sessionId);
    expect(sizeResult.ok).toBe(false);
    if (!sizeResult.ok) expect(sizeResult.error.code).toBe("SIZE_MISMATCH");
    await mkdir(join(store.root, ".uploads"), { recursive: true });
    const orphanPath = join(store.root, ".uploads", "orphan-part.part");
    await writeFile(orphanPath, Buffer.from("orphan"));
    const old = new Date(Date.now() - 10_000);
    await utimes(orphanPath, old, old);
    const swept = await store.sweepOrphans({ olderThanMs: 1, now: new Date() });
    expect(swept.ok).toBe(true);
    if (swept.ok) expect(swept.value.expiredSessionIds).toContain("orphan-part");
    expect((await readFile(orphanPath).catch(() => undefined))).toBeUndefined();
    const invalidWindow = await store.expireOrphanUploads({ olderThanMs: -1 });
    expect(invalidWindow.ok).toBe(false);
    if (!invalidWindow.ok) expect(invalidWindow.error.code).toBe("INVALID_INPUT");
    const invalidNow = await store.expireOrphanUploads({ olderThanMs: 1, now: new Date(Number.NaN) });
    expect(invalidNow.ok).toBe(false);
    if (!invalidNow.ok) expect(invalidNow.error.code).toBe("INVALID_INPUT");
  });

  it("rejects tampered records and preserves manifest immutability", async () => {
    const store = await makeStore();
    const session = await store.beginUpload(uploadInput({ projectId: "tamper", workItemId: "item", revisionId: "r01", filename: "a.bin" }));
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    await store.writeUpload(session.value.sessionId, Readable.from(Buffer.from("a")));
    const artifact = await store.finalizeUpload(session.value.sessionId);
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;
    const manifest = await store.freezeRevision({ projectId: "tamper", workItemId: "item", revisionId: "r01", entries: [{ artifactRevisionId: artifact.value.artifactRevisionId }] });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const conflict = await store.freezeRevision({ projectId: "tamper", workItemId: "item", revisionId: "r01", entries: [{ artifactRevisionId: artifact.value.artifactRevisionId, filename: "different.bin" }] });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("MANIFEST_IMMUTABLE");
    const recordPath = join(store.root, "records", "artifacts", `${artifact.value.artifactRevisionId}.json`);
    await writeFile(recordPath, "not-json");
    const corrupted = await store.readArtifact(artifact.value.artifactRevisionId);
    expect(corrupted.ok).toBe(false);
    if (!corrupted.ok) expect(corrupted.error.code).toBe("CORRUPT");
  });

  it("supports a no-work-item empty bundle and guards export destinations", async () => {
    const store = await makeStore();
    const frozen = await store.freezeRevision({ projectId: "empty", revisionId: "r01", entries: [], frozenAt: "2026-01-01T00:00:00.000Z" });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const outside = await mkdtemp(join(tmpdir(), "benchledger-empty-bundle-"));
    const destination = join(outside, "bundle");
    const bundle = await store.exportRevisionBundle({ projectId: "empty", revisionId: "r01", destination });
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;
    const second = await store.exportRevisionBundle({ projectId: "empty", revisionId: "r01", destination });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("BUNDLE_EXISTS");
    const inside = await store.exportRevisionBundle({ projectId: "empty", revisionId: "r01", destination: join(store.root, "bad") });
    expect(inside.ok).toBe(false);
    if (!inside.ok) expect(inside.error.code).toBe("PATH_UNSAFE");
    const restoredRoot = await mkdtemp(join(tmpdir(), "benchledger-empty-restored-"));
    const restored = new ArtifactStore({ root: restoredRoot, maxUploadBytes: 1024, maxStorageBytes: 4096 });
    const restoredResult = await restored.restoreRevisionBundle(destination);
    expect(restoredResult.ok).toBe(true);
    await rm(outside, { recursive: true, force: true });
    await rm(restoredRoot, { recursive: true, force: true });
  });

  it("recovers missing data, tolerates maintenance junk, and rejects malformed records", async () => {
    const store = await makeStore();
    const session = await store.beginUpload(uploadInput({ projectId: "edges", workItemId: undefined, revisionId: undefined, mediaType: undefined, role: undefined }));
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    await unlink(join(store.root, ".uploads", `${session.value.sessionId}.part`));
    const missingPart = await store.recoverUpload(session.value.sessionId);
    expect(missingPart.ok).toBe(false);
    if (!missingPart.ok) expect(missingPart.error.code).toBe("NOT_FOUND");
    await writeFile(join(store.root, ".uploads", `${session.value.sessionId}.json`), JSON.stringify({ version: 1, sessionId: session.value.sessionId, status: "unknown" }));
    const badStatusMissingFields = await store.recoverUpload(session.value.sessionId);
    expect(badStatusMissingFields.ok).toBe(false);
    if (!badStatusMissingFields.ok) expect(badStatusMissingFields.error.code).toBe("CORRUPT");
    await writeFile(join(store.root, ".uploads", `${session.value.sessionId}.json`), "null");
    const badObject = await store.recoverUpload(session.value.sessionId);
    expect(badObject.ok).toBe(false);
    if (!badObject.ok) expect(badObject.error.code).toBe("CORRUPT");
    await writeFile(join(store.root, ".uploads", "not-a-session.txt"), "ignore");
    await writeFile(join(store.root, ".uploads", "not-a-session.json"), "ignore");
    expect((await store.listOrphanUploads()).ok).toBe(false);

    const clean = await store.beginUpload(uploadInput({ projectId: "edges", workItemId: undefined, revisionId: undefined }));
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    await writeFile(join(store.root, ".uploads", `${clean.value.sessionId}.json`), JSON.stringify({ ...clean.value, version: 9 }));
    const badVersion = await store.recoverUpload(clean.value.sessionId);
    expect(badVersion.ok).toBe(false);
    if (!badVersion.ok) expect(badVersion.error.code).toBe("CORRUPT");

    const malformedStatus = await store.beginUpload(uploadInput({ projectId: "edges", workItemId: undefined, revisionId: undefined }));
    expect(malformedStatus.ok).toBe(true);
    if (!malformedStatus.ok) return;
    await writeFile(join(store.root, ".uploads", `${malformedStatus.value.sessionId}.json`), JSON.stringify({ ...malformedStatus.value, version: 1, status: "unknown" }));
    const badStatus = await store.recoverUpload(malformedStatus.value.sessionId);
    expect(badStatus.ok).toBe(false);
    if (!badStatus.ok) expect(badStatus.error.code).toBe("CORRUPT");

    const malformedExpiry = await store.beginUpload(uploadInput({ projectId: "edges", workItemId: undefined, revisionId: undefined }));
    expect(malformedExpiry.ok).toBe(true);
    if (!malformedExpiry.ok) return;
    await writeFile(join(store.root, ".uploads", `${malformedExpiry.value.sessionId}.json`), JSON.stringify({ ...malformedExpiry.value, version: 1, expiresAt: "not-a-date" }));
    const badExpiry = await store.recoverUpload(malformedExpiry.value.sessionId);
    expect(badExpiry.ok).toBe(false);
    if (!badExpiry.ok) expect(badExpiry.error.code).toBe("CORRUPT");

    const malformedOptional = await store.beginUpload(uploadInput({ projectId: "edges", workItemId: undefined, revisionId: undefined }));
    expect(malformedOptional.ok).toBe(true);
    if (!malformedOptional.ok) return;
    await writeFile(join(store.root, ".uploads", `${malformedOptional.value.sessionId}.json`), JSON.stringify({ ...malformedOptional.value, version: 1, mediaType: 12 }));
    const badOptional = await store.recoverUpload(malformedOptional.value.sessionId);
    expect(badOptional.ok).toBe(false);
    if (!badOptional.ok) expect(badOptional.error.code).toBe("CORRUPT");

    const malformedNumber = await store.beginUpload(uploadInput({ projectId: "edges", workItemId: undefined, revisionId: undefined }));
    expect(malformedNumber.ok).toBe(true);
    if (!malformedNumber.ok) return;
    await writeFile(join(store.root, ".uploads", `${malformedNumber.value.sessionId}.json`), JSON.stringify({ ...malformedNumber.value, version: 1, bytesWritten: "bad" }));
    const badNumber = await store.recoverUpload(malformedNumber.value.sessionId);
    expect(badNumber.ok).toBe(false);
    if (!badNumber.ok) expect(badNumber.error.code).toBe("CORRUPT");

    const nonFile = await store.beginUpload(uploadInput({ projectId: "edges", workItemId: undefined, revisionId: undefined }));
    expect(nonFile.ok).toBe(true);
    if (!nonFile.ok) return;
    await unlink(join(store.root, ".uploads", `${nonFile.value.sessionId}.part`));
    await mkdir(join(store.root, ".uploads", `${nonFile.value.sessionId}.part`));
    const nonFileResult = await store.recoverUpload(nonFile.value.sessionId);
    expect(nonFileResult.ok).toBe(false);
    if (!nonFileResult.ok) expect(nonFileResult.error.code).toBe("CORRUPT");
  });

  it("rejects malformed manifests, bundles, and filesystem entries", async () => {
    const store = await makeStore();
    await store.init();
    await writeFile(join(store.root, "blobs", "sha256", "zz"), "bad");
    const badPrefix = await store.getUsage();
    expect(badPrefix.ok).toBe(false);
    if (!badPrefix.ok) expect(badPrefix.error.code).toBe("CORRUPT");
    await rm(join(store.root, "blobs", "sha256", "zz"), { recursive: true, force: true });
    const frozen = await store.freezeRevision({ projectId: "malformed", revisionId: "r01", entries: [] });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const manifestPath = join(store.root, "records", "manifests", "malformed", "_project", "r01.json");
    await writeFile(manifestPath, JSON.stringify({ manifest: null, sha256: "0".repeat(64) }));
    const malformed = await store.readRevisionManifest({ projectId: "malformed", revisionId: "r01" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("CORRUPT");
    const badRecordSession = await store.beginUpload(uploadInput({ projectId: "record", workItemId: undefined, revisionId: undefined }));
    expect(badRecordSession.ok).toBe(true);
    if (!badRecordSession.ok) return;
    await store.writeUpload(badRecordSession.value.sessionId, Readable.from(Buffer.from("record")));
    const badRecordArtifact = await store.finalizeUpload(badRecordSession.value.sessionId);
    expect(badRecordArtifact.ok).toBe(true);
    if (!badRecordArtifact.ok) return;
    const badRecordPath = join(store.root, "records", "artifacts", `${badRecordArtifact.value.artifactRevisionId}.json`);
    await writeFile(badRecordPath, JSON.stringify({ version: 1, artifactId: "a", artifactRevisionId: badRecordArtifact.value.artifactRevisionId, projectId: "p", filename: "x", bytes: 1, sha256: "not-a-hash", storageKey: "bad", createdAt: new Date().toISOString() }));
    const badRecord = await store.readArtifact(badRecordArtifact.value.artifactRevisionId);
    expect(badRecord.ok).toBe(false);
    if (!badRecord.ok) expect(badRecord.error.code).toBe("CORRUPT");
    await writeFile(badRecordPath, JSON.stringify({ version: 2 }));
    const badRecordVersion = await store.readArtifact(badRecordArtifact.value.artifactRevisionId);
    expect(badRecordVersion.ok).toBe(false);
    if (!badRecordVersion.ok) expect(badRecordVersion.error.code).toBe("CORRUPT");
    const bundleRoot = await mkdtemp(join(tmpdir(), "benchledger-invalid-bundle-"));
    const bundlePath = join(bundleRoot, "bundle");
    await mkdir(bundlePath, { recursive: true });
    await writeFile(join(bundlePath, "manifest.json"), JSON.stringify({ format: "wrong", version: 1 }));
    const invalidBundle = await store.restoreRevisionBundle(bundlePath);
    expect(invalidBundle.ok).toBe(false);
    if (!invalidBundle.ok) expect(invalidBundle.error.code).toBe("BUNDLE_INVALID");
    await rm(bundleRoot, { recursive: true, force: true });
  });
});
