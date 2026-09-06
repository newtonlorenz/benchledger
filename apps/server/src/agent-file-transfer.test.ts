import { mkdtemp, readFile, writeFile, rm, symlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createApp, bearerRecord } from "./app.js";
import { ArtifactTransferManager } from "./artifact-transfer.js";
// Host-only JavaScript CLI; deliberately outside the server/MCP runtime.
// @ts-expect-error standalone script has no declaration file
import { transferArtifact } from "../../../scripts/artifact-transfer.mjs";

describe("host artifact helper", () => {
  it("round trips exact revision bytes with allowlisted bearer and rejects wrong scope, read-only writes and overwrite", async () => {
    const manager = new ArtifactTransferManager("http://localhost");
    const app = await createApp({ demo: true, logger: false, artifactTransferManager: manager, auth: { sessionSecret: "s".repeat(48), bearerTokens: [bearerRecord("writer", ["read", "write"], ["synthetic-project-lamp"]), bearerRecord("reader", ["read"], ["synthetic-project-lamp"]), bearerRecord("wrong", ["read", "write"], ["different-project"])] } });
    const dir = await mkdtemp(join(tmpdir(), "bench-transfer-test-"));
    try {
      const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
      const file = join(dir, "日本語.step");
      await writeFile(file, "ISO-10303-21; synthetic test");
      const options = { baseUrl, token: "writer", projectId: "synthetic-project-lamp", projectRevisionId: "synthetic-revision-lamp-r01", role: "step", file, mediaType: "model/step" };
      const pending = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers: { authorization: "Bearer writer" }, payload: { projectId: options.projectId, projectRevisionId: options.projectRevisionId, role: "step", filename: "pending.step", mediaType: "model/step", byteSize: 1, sha256: createHash("sha256").update("x").digest("hex") } });
      const uploadId = pending.json().data.id;
      for (const token of ["wrong", "reader"]) {
        expect((await app.inject({ method: "PUT", url: `/api/v1/artifacts/uploads/${uploadId}`, headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, payload: Buffer.from("x") })).statusCode).toBe(403);
        expect((await app.inject({ method: "POST", url: `/api/v1/artifacts/uploads/${uploadId}/finalize`, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
      }
      await expect(transferArtifact({ ...options, token: "reader", operation: "upload" })).rejects.toThrow(/403/);
      await expect(transferArtifact({ ...options, token: "wrong", operation: "upload" })).rejects.toThrow(/403/);
      const result = await transferArtifact({ ...options, operation: "upload" });
      const expectedDisposition = "attachment; filename=\"___.step\"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.step";
      const raw = await fetch(`${baseUrl}/api/v1/artifacts/${result.artifactId}/download`, { headers: { authorization: "Bearer reader" } });
      expect(raw.status).toBe(200);
      expect(raw.headers.get("content-disposition")).toBe(expectedDisposition);
      expect(await raw.text()).toBe(await readFile(file, "utf8"));
      const ticket = manager.issueDownload({ artifactId: result.artifactId, projectId: options.projectId, byteLength: result.byteSize, sha256: result.sha256, actor: "agent" });
      const capabilityDownload = await fetch(`${baseUrl}/api/v1/transfers/artifacts/${result.artifactId}/download`, { headers: ticket.requiredHeaders });
      expect(capabilityDownload.status).toBe(200);
      expect(capabilityDownload.headers.get("content-disposition")).toBe(expectedDisposition);
      expect(await capabilityDownload.text()).toBe(await readFile(file, "utf8"));
      const output = join(dir, "saved.step");
      await transferArtifact({ ...options, operation: "download", artifactId: result.artifactId, file: output });
      expect(await readFile(output, "utf8")).toBe(await readFile(file, "utf8"));
      await expect(transferArtifact({ ...options, operation: "download", artifactId: result.artifactId, file: output })).rejects.toThrow(/exists/);
      await expect(transferArtifact({ ...options, operation: "download", artifactId: result.artifactId, file: join(dir, "wrong.step"), projectRevisionId: "wrong-revision" })).rejects.toThrow(/scope/);
      for (const suffix of ["", "/download"]) {
        const denied = await fetch(`${baseUrl}/api/v1/artifacts/${result.artifactId}${suffix}`, { headers: { authorization: "Bearer wrong" } });
        expect(denied.status).toBe(403);
      }
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects redirects without forwarding credentials, corrupt bytes and invalid local scope", async () => {
    let received = 0;
    const trap = createServer((_req, res) => { received++; res.end("unexpected"); });
    await new Promise<void>((done) => trap.listen(0, "127.0.0.1", done));
    const trapPort = (trap.address() as { port: number }).port;
    let redirect = true;
    const server = createServer((req, res) => {
      if (redirect) { res.writeHead(302, { location: `http://127.0.0.1:${trapPort}/private` }); res.end(); return; }
      if (req.url?.endsWith("/download")) { res.end("bad"); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "artifact-1", projectId: "project-1", revisionId: "revision-1", role: "step", byteSize: 3, sha256: "a".repeat(64) }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const dir = await mkdtemp(join(tmpdir(), "bench-transfer-negative-"));
    try {
      const options = { operation: "download", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "private-test-token", projectId: "project-1", projectRevisionId: "revision-1", role: "step", artifactId: "artifact-1", file: join(dir, "saved.step") };
      await expect(transferArtifact(options)).rejects.toThrow(/Transfer failed/);
      expect(received).toBe(0);
      redirect = false;
      await expect(transferArtifact(options)).rejects.toThrow(/SHA-256/);
      await expect(readFile(options.file)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(transferArtifact({ ...options, workItemId: "mixed" })).rejects.toThrow(/exactly one/);
      await expect(transferArtifact({ ...options, token: "" })).rejects.toThrow(/BENCHLEDGER_TOKEN/);
      await expect(transferArtifact({ ...options, baseUrl: "https://user:secret@example.test" })).rejects.toThrow(/Base URL/);
      const empty = join(dir, "empty.step");
      await writeFile(empty, "");
      await expect(transferArtifact({ ...options, operation: "upload", file: empty, mediaType: "model/step" })).rejects.toThrow(/nonempty/);
      const large = await open(empty, "w");
      await large.truncate(100 * 1024 * 1024 + 1);
      await large.close();
      await expect(transferArtifact({ ...options, operation: "upload", file: empty, mediaType: "model/step" })).rejects.toThrow(/100 MiB/);
      const link = join(dir, "link.step");
      await symlink(empty, link);
      await expect(transferArtifact({ ...options, operation: "upload", file: link, mediaType: "model/step" })).rejects.toThrow(/Transfer failed/);
    } finally {
      await Promise.all([new Promise<void>((done) => server.close(() => done())), new Promise<void>((done) => trap.close(() => done()))]);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
