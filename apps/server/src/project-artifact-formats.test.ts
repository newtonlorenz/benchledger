import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact, BeginUpload, UploadSession } from "@benchledger/api-contract";
import { describe, expect, it } from "vitest";
import { bearerRecord, createApp } from "./app.js";
import { ArtifactTransferManager } from "./artifact-transfer.js";

const projectId = "synthetic-format-project";
const projectRevisionId = "synthetic-format-revision";
const workItemId = "synthetic-format-work-item";
const workItemRevisionId = "synthetic-format-work-revision";
const authorization = (token: string) => ({ authorization: `Bearer ${token}` });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Valid, stored ZIP with notes.json and ../archive-must-stay-opaque.txt.
// Its members are deliberately never extracted, including in this test.
const archive = Buffer.from("UEsDBBQAAAAAAAAAIVwwHKAXEwAAABMAAAAKAAAAbm90ZXMuanNvbnsic3ludGhldGljIjp0cnVlfQpQSwMEFAAAAAAAAAAhXM7niq0aAAAAGgAAAB8AAAAuLi9hcmNoaXZlLW11c3Qtc3RheS1vcGFxdWUudHh0c3ludGhldGljIHRyYXZlcnNhbCBlbnRyeQpQSwECFAMUAAAAAAAAACFcMBygFxMAAAATAAAACgAAAAAAAAAAAAAAgAEAAAAAbm90ZXMuanNvblBLAQIUAxQAAAAAAAAAIVzO54qtGgAAABoAAAAfAAAAAAAAAAAAAACAATsAAAAuLi9hcmNoaXZlLW11c3Qtc3RheS1vcGFxdWUudHh0UEsFBgAAAAACAAIAhQAAAJIAAAAAAA==", "base64");
const formats = [
  { filename: "source.zip", mediaType: "application/zip", role: "other", bytes: archive },
  { filename: "source-alias.ZIP", mediaType: "application/x-zip-compressed", role: "validation", bytes: archive },
  { filename: "source-fallback.zip", mediaType: "application/octet-stream", role: "other", bytes: archive },
  { filename: "drawing.svg", mediaType: "image/svg+xml", role: "other", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.syntheticEvent=true"><script>window.syntheticScript=true</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Synthetic drawing</div></foreignObject></svg>') },
  { filename: "settings.json", mediaType: "application/json", role: "text", bytes: Buffer.from('{"synthetic":true,"literal":"<script>window.syntheticJson=true</script>"}\n') },
] as const;

const scopes = [
  { input: { projectRevisionId }, query: `projectRevisionId=${projectRevisionId}`, revisionId: projectRevisionId },
  { input: { workItemId, workItemRevisionId }, query: `workItemId=${workItemId}&workItemRevisionId=${workItemRevisionId}`, revisionId: workItemRevisionId },
] as const;

type App = Awaited<ReturnType<typeof createApp>>;
type Response = Awaited<ReturnType<App["inject"]>>;

async function openApp(dataDir: string, manager: ArtifactTransferManager) {
  return createApp({
    demo: false, dataDir, logger: false, publicBaseUrl: "http://format.example.test",
    artifactTransferManager: manager,
    auth: {
      sessionSecret: "synthetic-artifact-format-session-secret".repeat(2),
      bearerTokens: [
        bearerRecord("setup", ["read", "write"]),
        bearerRecord("writer", ["read", "write"], [projectId]),
        bearerRecord("reader", ["read"], [projectId]),
        bearerRecord("wrong-project", ["read", "write"], ["synthetic-other-project"]),
      ],
    },
  });
}

const post = (app: App, path: string, payload?: object, token = "writer") => app.inject({
  method: "POST", url: `/api/v1${path}`,
  headers: { ...authorization(token), "idempotency-key": randomUUID() },
  ...(payload === undefined ? {} : { payload }),
});

async function seed(app: App) {
  const operations = [
    ["/projects/with-initial-revision", { project: { id: projectId, name: "Synthetic file formats", status: "building" }, revision: { id: projectRevisionId, name: "Initial", status: "concept", fabricationRoute: "none" } }],
    [`/projects/${projectId}/work-items`, { id: workItemId, name: "Synthetic drawings", kind: "document" }],
    [`/work-items/${workItemId}/revisions`, { id: workItemRevisionId, name: "Initial drawing", status: "concept" }],
  ] as const;
  for (const [path, body] of operations) {
    const response = await post(app, path, body, "setup");
    expect(response.statusCode, response.body).toBe(201);
  }
}

function uploadInput(format: typeof formats[number], scope: typeof scopes[number]): BeginUpload {
  return { projectId, ...scope.input, role: format.role, filename: format.filename, mediaType: format.mediaType, byteSize: format.bytes.length, sha256: digest(format.bytes) };
}

async function upload(app: App, input: BeginUpload, bytes: Buffer) {
  const begun = await post(app, "/artifacts/uploads", input);
  expect(begun.statusCode, begun.body).toBe(201);
  const session = begun.json<{ data: UploadSession }>().data;
  const written = await app.inject({ method: "PUT", url: `/api/v1/artifacts/uploads/${session.id}`, headers: { ...authorization("writer"), "content-type": "application/octet-stream" }, payload: bytes });
  expect(written.statusCode, written.body).toBe(200);
  const finalized = await post(app, `/artifacts/uploads/${session.id}/finalize`);
  expect(finalized.statusCode, finalized.body).toBe(200);
  return finalized.json<{ data: Artifact }>().data;
}

function expectProtectedDownload(response: Response, input: BeginUpload, bytes: Buffer) {
  expect(response.statusCode, response.body).toBe(200);
  expect(response.rawPayload).toEqual(bytes);
  expect(digest(response.rawPayload)).toBe(input.sha256);
  expect(response.headers["content-type"]).toContain(input.mediaType);
  expect(response.headers["content-disposition"]).toBe(`attachment; filename="${input.filename}"; filename*=UTF-8''${input.filename}`);
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["content-security-policy"]).toBe("sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

describe("persistent project artifact formats", () => {
  it("retains ZIP, SVG and JSON bytes in their exact revision scopes across restart and protects both download routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "benchledger-artifact-formats-"));
    const dataDir = join(directory, "data");
    const manager = new ArtifactTransferManager("http://format.example.test");
    let app = await openApp(dataDir, manager);
    try {
      await seed(app);
      const saved: { artifact: Artifact; input: BeginUpload; bytes: Buffer }[] = [];
      for (const scope of scopes) {
        for (const format of formats) {
          const input = uploadInput(format, scope);
          const artifact = await upload(app, input, format.bytes);
          expect(artifact).toMatchObject({ projectId, revisionId: scope.revisionId, role: format.role, filename: format.filename, mediaType: format.mediaType, byteSize: format.bytes.length, sha256: input.sha256 });
          expect(artifact.workItemId).toBe("workItemId" in scope.input ? workItemId : undefined);
          saved.push({ artifact, input, bytes: format.bytes });
        }
      }

      await app.close();
      app = await openApp(dataDir, manager);
      for (const scope of scopes) {
        const listed = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/artifacts?${scope.query}`, headers: authorization("reader") });
        expect(listed.statusCode, listed.body).toBe(200);
        expect(listed.json<Artifact[]>().sort((left, right) => left.id.localeCompare(right.id))).toEqual(saved.filter(({ artifact }) => artifact.revisionId === scope.revisionId).map(({ artifact }) => artifact).sort((left, right) => left.id.localeCompare(right.id)));
      }
      for (const { artifact, input, bytes } of saved) {
        const downloaded = await app.inject({ method: "GET", url: `/api/v1/artifacts/${artifact.id}/download`, headers: authorization("reader") });
        expectProtectedDownload(downloaded, input, bytes);
        const ticket = manager.issueDownload({ artifactId: artifact.id, projectId, actor: "synthetic-format-agent", byteLength: bytes.length, sha256: input.sha256 });
        const transferred = await app.inject({ method: "GET", url: new URL(ticket.downloadUrl).pathname, headers: ticket.requiredHeaders });
        expectProtectedDownload(transferred, input, bytes);
      }
      const files = await readdir(directory, { recursive: true });
      expect(files.some((file) => file.endsWith("archive-must-stay-opaque.txt") || file.endsWith("notes.json"))).toBe(false);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps new formats behind authentication, project scope and write authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "benchledger-artifact-format-auth-"));
    const manager = new ArtifactTransferManager("http://format.example.test");
    const app = await openApp(join(directory, "data"), manager);
    try {
      await seed(app);
      const format = formats[3];
      const input = uploadInput(format, scopes[1]);
      for (const token of [undefined, "reader", "wrong-project"]) {
        const denied = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", ...(token ? { headers: authorization(token) } : {}), payload: input });
        expect(denied.statusCode, denied.body).toBe(token ? 403 : 401);
      }
      const begun = await post(app, "/artifacts/uploads", input);
      expect(begun.statusCode, begun.body).toBe(201);
      const session = begun.json<{ data: UploadSession }>().data;
      for (const token of [undefined, "reader", "wrong-project"]) {
        const headers = token ? authorization(token) : {};
        const put = await app.inject({ method: "PUT", url: `/api/v1/artifacts/uploads/${session.id}`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: format.bytes });
        expect(put.statusCode, put.body).toBe(token ? 403 : 401);
        const finalize = await app.inject({ method: "POST", url: `/api/v1/artifacts/uploads/${session.id}/finalize`, headers });
        expect(finalize.statusCode, finalize.body).toBe(token ? 403 : 401);
      }
      const artifact = await upload(app, input, format.bytes);
      for (const suffix of ["", "/download"]) {
        for (const token of [undefined, "wrong-project"]) {
          const denied = await app.inject({ method: "GET", url: `/api/v1/artifacts/${artifact.id}${suffix}`, ...(token ? { headers: authorization(token) } : {}) });
          expect(denied.statusCode, denied.body).toBe(token ? 403 : 401);
        }
      }
      expectProtectedDownload(await app.inject({ method: "GET", url: `/api/v1/artifacts/${artifact.id}/download`, headers: authorization("reader") }), input, format.bytes);
      const ticket = manager.issueDownload({ artifactId: artifact.id, projectId, actor: "synthetic-format-agent", byteLength: artifact.byteSize, sha256: artifact.sha256 });
      const url = new URL(ticket.downloadUrl).pathname;
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/api/v1/transfers/artifacts/another-artifact/download", headers: ticket.requiredHeaders })).statusCode).toBe(403);
      expectProtectedDownload(await app.inject({ method: "GET", url, headers: ticket.requiredHeaders }), input, format.bytes);
      expect((await app.inject({ method: "GET", url, headers: ticket.requiredHeaders })).statusCode).toBe(403);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
