import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bearerRecord, createApp } from "./app.js";

it("recovers lost and partial PUT acknowledgements against persistent storage with scoped offset checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "benchledger-upload-recovery-"));
  const projectId = "upload-project", revisionId = "upload-revision";
  const app = await createApp({ demo: false, dataDir: directory, publicBaseUrl: "http://127.0.0.1", logger: false, auth: { sessionSecret: randomUUID().repeat(2), bearerTokens: [bearerRecord("writer", ["read", "write"]), bearerRecord("reader", ["read"], [projectId]), bearerRecord("wrong", ["read"], ["other-project"]), bearerRecord("write-only", ["write"], [projectId])] } });
  const post = (path: string, payload?: object) => app.inject({ method: "POST", url: `/api/v1${path}`, headers: { authorization: "Bearer writer", "idempotency-key": randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  try {
    expect((await post("/projects/with-initial-revision", { project: { id: projectId, name: "Synthetic upload recovery", status: "building" }, revision: { id: revisionId, name: "Initial", status: "concept", fabricationRoute: "none" } })).statusCode).toBe(201);
    const bytes = Buffer.from("synthetic build bytes");
    for (const partial of [false, true]) {
      const begun = await post("/artifacts/uploads", { projectId, projectRevisionId: revisionId, role: "step", filename: `recovery-${partial}.step`, mediaType: "model/step", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), source: "web" });
      expect(begun.statusCode, begun.body).toBe(201);
      const session = begun.json().data;
      const url = `/api/v1/artifacts/uploads/${session.id}`;
      for (const token of ["wrong"]) expect((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url, headers: { authorization: "Bearer write-only" } })).statusCode).toBe(200); // Write scope implies read.
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      const put = (body: Buffer, offset: number) => app.inject({ method: "PUT", url, headers: { authorization: "Bearer writer", "content-type": "application/octet-stream", "upload-offset": String(offset) }, payload: body });
      const first = partial ? bytes.subarray(0, 4) : bytes;
      // The client loses this response after the durable write completes.
      expect((await put(first, 0)).statusCode).toBe(200);
      expect((await put(bytes, 0)).statusCode).toBe(409);
      const progress = await app.inject({ method: "GET", url, headers: { authorization: "Bearer reader" } });
      expect(progress.statusCode, progress.body).toBe(200);
      expect(progress.json()).toMatchObject({ id: session.id, receivedBytes: first.length, status: "pending" });
      if (partial) expect((await put(bytes.subarray(progress.json().receivedBytes), progress.json().receivedBytes)).statusCode).toBe(200);
      const finalized = await post(`/artifacts/uploads/${session.id}/finalize`);
      expect(finalized.statusCode, finalized.body).toBe(200);
      expect(finalized.json().data).toMatchObject({ id: session.artifactId, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      const downloaded = await app.inject({ method: "GET", url: `/api/v1/artifacts/${session.artifactId}/download`, headers: { authorization: "Bearer reader" } });
      expect(downloaded.rawPayload).toEqual(bytes);
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
