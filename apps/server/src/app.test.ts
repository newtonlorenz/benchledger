import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createApp, bearerRecord } from "./app.js";
import { createSyntheticRuntime } from "./memory-store.js";
import { createProductionRuntime } from "@benchledger/runtime";
import { ApplicationService } from "@benchledger/application";

const demoPassword = "demo-password-please-change";

function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

async function loggedIn() {
  const app = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
  expect(login.statusCode).toBe(200);
  return { app, cookie: cookieHeader(login.headers["set-cookie"]), csrf: login.json<{ csrfToken: string }>().csrfToken };
}

describe("BenchLedger HTTP API", () => {
  it("seeds the synthetic runtime with a project, revision, and planning BOM", async () => {
    const runtime = createSyntheticRuntime();
    const projects = await runtime.ports.projects.listProjects({ limit: 50 });
    const project = projects.data.find((candidate) => candidate.id === "synthetic-project-lamp");
    expect(project).toMatchObject({ currentRevisionId: "synthetic-revision-lamp-r01", status: "planning" });
    const lines = await runtime.ports.projects.listBomLines(project?.currentRevisionId ?? "missing");
    expect(lines.map((line) => line.id).sort()).toEqual([
      "synthetic-bom-board",
      "synthetic-bom-fasteners",
      "synthetic-bom-filament",
      "synthetic-bom-printer",
      "synthetic-bom-wire"
    ]);
    expect(lines.find((line) => line.id === "synthetic-bom-fasteners")).toMatchObject({ optional: false, requiredQuantity: 4, unit: "each" });
  });

  it("keeps health public but protects inventory", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false } });
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", service: "benchledger", demo: true });
    const inventory = await app.inject({ method: "GET", url: "/api/v1/inventory" });
    expect(inventory.statusCode).toBe(401);
    await app.close();
  });

  it("supports a session-protected inventory read and CSRF-protected write", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const list = await app.inject({ method: "GET", url: "/api/v1/inventory?q=ESP32", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: Array<{ id: string }> }>().data[0]?.id).toBe("board-esp32");
    const withoutCsrf = await app.inject({ method: "POST", url: "/api/v1/inventory", headers: { cookie }, payload: { name: "Nope", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } } });
    expect(withoutCsrf.statusCode).toBe(403);
    const input = { name: "Hex key", kind: "tool", quantity: 1, unit: "each", tags: ["hand-tool"], links: [], evidence: { state: "physically_counted" } };
    const first = await app.inject({ method: "POST", url: "/api/v1/inventory", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "create-hex-key-1" }, payload: input });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: "/api/v1/inventory", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "create-hex-key-1" }, payload: input });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ replayed: true, data: { id: first.json().data.id } });
    const changed = await app.inject({ method: "POST", url: "/api/v1/inventory", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "create-hex-key-1" }, payload: { ...input, name: "Different tool" } });
    expect(changed.statusCode).toBe(409);
    await app.close();
  });

  it("binds REST stock-event idempotency to the item route and replays the same logical request", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const headers = { cookie, "x-csrf-token": csrf, "idempotency-key": "stock-event-route-key" };
    const payload = { type: "receipt", quantity: 1, unit: "each" };

    const first = await app.inject({ method: "POST", url: "/api/v1/inventory/board-esp32/stock-events", headers, payload });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ replayed: false, data: { item: { id: "board-esp32" } } });

    const replay = await app.inject({ method: "POST", url: "/api/v1/inventory/board-esp32/stock-events", headers, payload });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ replayed: true, data: { item: { id: "board-esp32" } } });

    const differentItem = await app.inject({ method: "POST", url: "/api/v1/inventory/printer-h2d/stock-events", headers, payload });
    expect(differentItem.statusCode).toBe(409);
    expect(differentItem.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    await app.close();
  });

  it("creates an exact inventory item and reference-only product profile atomically", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const payload = {
      item: {
        id: "ui-compound-spool",
        name: "PETG HF spool",
        kind: "filament",
        quantity: 1000,
        unit: "gram",
        tags: ["petg"],
        links: [],
        evidence: { state: "delivered_uncounted", source: "ui" }
      },
      profile: {
        catalogProductId: "catalog-filament-petg-hf",
        profileType: "filament_spool",
        linkState: "confirmed",
        details: { openedState: "sealed", lot: "LOT-UI-1" }
      }
    };
    const first = await app.inject({ method: "POST", url: "/api/v1/inventory/with-product-profile", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "ui-compound-spool-1" }, payload });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      replayed: false,
      data: {
        item: { id: "ui-compound-spool", kind: "filament" },
        profile: { itemId: "ui-compound-spool", catalogProductId: "catalog-filament-petg-hf", profileType: "filament_spool", linkState: "confirmed" }
      },
      audit: { action: "inventory.item_with_product_profile.create" }
    });
    const replay = await app.inject({ method: "POST", url: "/api/v1/inventory/with-product-profile", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "ui-compound-spool-1" }, payload });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ replayed: true, data: { item: { id: "ui-compound-spool" }, profile: { itemId: "ui-compound-spool" } } });
    await app.close();
  });

  it("serves a scoped bearer token without requiring a CSRF token", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("read-secret-token", ["read"])] } });
    const response = await app.inject({ method: "GET", url: "/api/v1/inventory", headers: { authorization: "Bearer read-secret-token" } });
    expect(response.statusCode).toBe(200);
    const write = await app.inject({ method: "POST", url: "/api/v1/inventory", headers: { authorization: "Bearer read-secret-token" }, payload: { name: "Nope", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } } });
    expect(write.statusCode).toBe(403);
    await app.close();
  });

  it("keeps labeled bearer actors distinct for audit and idempotency namespaces", async () => {
    const runtime = createSyntheticRuntime();
    const app = await createApp({
      demo: true,
      runtime,
      auth: {
        sessionSecret: "s".repeat(48),
        secureCookies: false,
        bearerTokens: [
          bearerRecord("actor-first-token", ["read", "write"], undefined, "cad-agent"),
          bearerRecord("actor-second-token", ["read", "write"], undefined, "inventory-agent")
        ]
      },
      logger: false
    });
    const sharedHeaders = { "idempotency-key": "shared-bearer-key" };
    const first = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { ...sharedHeaders, authorization: "Bearer actor-first-token" }, payload: { id: "token-project-first", name: "First token project", status: "planning" } });
    const second = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { ...sharedHeaders, authorization: "Bearer actor-second-token" }, payload: { id: "token-project-second", name: "Second token project", status: "planning" } });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ replayed: false, data: { id: "token-project-first" } });
    expect(second.json()).toMatchObject({ replayed: false, data: { id: "token-project-second" } });

    const replay = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { ...sharedHeaders, authorization: "Bearer actor-first-token" }, payload: { id: "token-project-first", name: "First token project", status: "planning" } });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ replayed: true, data: { id: "token-project-first" } });
    const auditActors = (await runtime.ports.audit.list(50)).data.filter((event) => event.action === "project.create").map((event) => event.actor);
    expect(auditActors).toEqual(expect.arrayContaining(["mcp-token:cad-agent", "mcp-token:inventory-agent"]));
    await app.close();
  });

  it("evaluates confirmed and inspect-first BOM stock", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const project = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie, "x-csrf-token": csrf }, payload: { name: "Demo build", status: "planning" } });
    const projectId = project.json<{ data: { id: string } }>().data.id;
    const revision = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/revisions`, headers: { cookie, "x-csrf-token": csrf }, payload: { name: "Initial", status: "concept" } });
    const revisionId = revision.json<{ data: { id: string } }>().data.id;
    const line = await app.inject({ method: "POST", url: `/api/v1/project-revisions/${revisionId}/bom`, headers: { cookie, "x-csrf-token": csrf }, payload: { name: "ESP32", itemId: "board-esp32", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} } });
    expect(line.statusCode).toBe(201);
    const gaps = await app.inject({ method: "GET", url: `/api/v1/project-revisions/${revisionId}/gaps`, headers: { cookie } });
    expect(gaps.statusCode).toBe(200);
    expect(gaps.json<{ lines: Array<{ status: string }> }>().lines[0]?.status).toBe("supplied");
    await app.close();
  });

  it("records reviewed project usage through the project revision route", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const project = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie, "x-csrf-token": csrf }, payload: { name: "Usage review", status: "planning" } });
    const projectId = project.json<{ data: { id: string } }>().data.id;
    const revision = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/revisions`, headers: { cookie, "x-csrf-token": csrf }, payload: { name: "Closeout", status: "concept" } });
    const revisionId = revision.json<{ data: { id: string } }>().data.id;
    const withoutCsrf = await app.inject({ method: "POST", url: `/api/v1/project-revisions/${revisionId}/usage`, headers: { cookie }, payload: { itemId: "board-esp32", quantity: 1, unit: "each" } });
    expect(withoutCsrf.statusCode).toBe(403);

    const usage = await app.inject({ method: "POST", url: `/api/v1/project-revisions/${revisionId}/usage`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "usage-review-1" }, payload: { itemId: "board-esp32", quantity: 1, unit: "each", note: "Installed during final assembly" } });
    expect(usage.statusCode).toBe(201);
    expect(usage.json()).toMatchObject({
      data: {
        event: { type: "consume", itemId: "board-esp32", projectId, actor: "admin", source: "ui" },
        item: { id: "board-esp32", quantity: 1, availableQuantity: 1 }
      },
      audit: { action: "project.usage.record" },
      replayed: false
    });
    const replay = await app.inject({ method: "POST", url: `/api/v1/project-revisions/${revisionId}/usage`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "usage-review-1" }, payload: { itemId: "board-esp32", quantity: 1, unit: "each", note: "Installed during final assembly" } });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ replayed: true, data: { item: { id: "board-esp32" } } });
    await app.close();
  });

  it("keeps REST reconciliation drafts review-only, commits atomically, replays retries, and denies another project", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-reconciliation-http-"));
    const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    const seedContext = { actor: "reconciliation-http-seed", source: "api" as const, correlationId: "reconciliation-http-seed", scopes: new Set(["read", "write"]) };
    const service = new ApplicationService(runtime.ports);
    const item = await service.createInventoryItem({ id: "reconciliation-http-item", name: "Reconciliation board", kind: "electronic", quantity: 4, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, seedContext);
    const project = await service.createProject({ id: "reconciliation-http-project", name: "Reconciliation HTTP", status: "planning" }, seedContext);
    const revision = await service.createProjectRevision(project.data.id, { id: "reconciliation-http-revision", name: "Initial", status: "concept" }, seedContext);
    const line = await service.createBomLine(revision.data.id, { id: "reconciliation-http-line", name: "Reconciliation board", itemId: item.data.id, requiredQuantity: 2, unit: "each", optional: false, alternatives: [], constraints: {} }, seedContext);
    const reservation = await service.createReservation(revision.data.id, { id: "reconciliation-http-reservation", lineId: line.data.id, itemId: item.data.id, quantity: 2 }, seedContext);
    const otherProject = await service.createProject({ id: "reconciliation-http-other", name: "Other project", status: "planning" }, seedContext);
    const otherRevision = await service.createProjectRevision(otherProject.data.id, { id: "reconciliation-http-other-revision", name: "Initial", status: "concept" }, seedContext);
    const app = await createApp({ demo: true, runtime, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("reconciliation-http-token", ["read", "write"], [project.data.id])] }, logger: false });
    const headers = { authorization: "Bearer reconciliation-http-token" };
    const reconciliationUrl = `/api/v1/project-revisions/${revision.data.id}/reconciliation`;
    const draftBody = {
      projectRevisionId: revision.data.id,
      lines: [{ bomLineId: line.data.id, outcomes: [{ reservationId: reservation.data.id, itemId: item.data.id, kind: "consumed", quantity: 2, unit: "each", evidence: { state: "physically_counted", source: "bench-check" } }] }]
    };
    try {
      const initial = await app.inject({ method: "GET", url: reconciliationUrl, headers });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toBeNull();

      const beforeItem = await service.getInventoryItem(item.data.id);
      const beforeEvents = await service.listStockEvents(item.data.id);
      const draftResponse = await app.inject({ method: "PUT", url: reconciliationUrl, headers: { ...headers, "idempotency-key": "reconciliation-http-draft" }, payload: draftBody });
      expect(draftResponse.statusCode).toBe(200);
      const draft = draftResponse.json<{ data: { id: string; version: number; status: string } }>().data;
      expect(draft).toMatchObject({ id: expect.any(String), version: 1, status: "draft" });
      await expect(service.getInventoryItem(item.data.id)).resolves.toMatchObject({ quantity: beforeItem.quantity, availableQuantity: beforeItem.availableQuantity, version: beforeItem.version });
      await expect(service.listStockEvents(item.data.id)).resolves.toMatchObject({ data: expect.arrayContaining(Array.from(beforeEvents.data)), total: beforeEvents.total });

      const commitBody = { draftId: draft.id, expectedVersion: draft.version };
      const commitHeaders = { ...headers, "idempotency-key": "reconciliation-http-commit" };
      const committed = await app.inject({ method: "POST", url: `${reconciliationUrl}/commit`, headers: commitHeaders, payload: commitBody });
      expect(committed.statusCode).toBe(200);
      expect(committed.json()).toMatchObject({ replayed: false, data: { id: expect.any(String), draftId: draft.id, status: "committed" } });
      await expect(service.getInventoryItem(item.data.id)).resolves.toMatchObject({ quantity: 2, availableQuantity: 2 });
      await expect(service.listReservations(revision.data.id)).resolves.toMatchObject([{ id: reservation.data.id, status: "settled" }]);

      const replay = await app.inject({ method: "POST", url: `${reconciliationUrl}/commit`, headers: commitHeaders, payload: commitBody });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ replayed: true, data: { draftId: draft.id, status: "committed" } });
      await expect(service.getInventoryItem(item.data.id)).resolves.toMatchObject({ quantity: 2, availableQuantity: 2 });

      const denied = await app.inject({ method: "GET", url: `/api/v1/project-revisions/${otherRevision.data.id}/reconciliation`, headers });
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("creates a project and initial revision atomically and rolls back on a revision failure", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-atomic-server-"));
    const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    try {
      const seedContext = { actor: "test-agent", source: "api" as const, correlationId: "seed-correlation", scopes: new Set(["read", "write"]) };
      const existing = await runtime.ports.projects.createProject({ id: "collision-project", name: "Collision project", status: "planning" }, seedContext);
      await runtime.ports.projects.createProjectRevision(existing.id, { id: "collision-revision", name: "Existing revision", status: "concept" }, seedContext);
      const app = await createApp({ demo: true, runtime, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
      const cookie = cookieHeader(login.headers["set-cookie"]);
      const csrf = login.json<{ csrfToken: string }>().csrfToken;
      const openapi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
      expect(openapi.statusCode).toBe(200);
      const document = openapi.json<{ paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } }>();
      expect(document.paths["/projects/with-initial-revision"]).toBeDefined();
      expect(document.paths["/inventory/with-product-profile"]).toMatchObject({ post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/CreateInventoryWithProductProfile" } } } } } });
      expect(document.components.schemas.CreateInventoryWithProductProfile).toMatchObject({ required: ["item", "profile"], additionalProperties: false });
      const payload = {
        project: { id: "atomic-project", name: "Atomic project", description: "One command", status: "planning" },
        revision: { id: "atomic-revision", name: "Initial", notes: "Starting point", status: "concept" }
      };
      const first = await app.inject({ method: "POST", url: "/api/v1/projects/with-initial-revision", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "atomic-project-1" }, payload });
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ data: { project: { id: "atomic-project", currentRevisionId: "atomic-revision" }, revision: { id: "atomic-revision", projectId: "atomic-project", number: 1 } }, audit: { action: "project.create_with_initial_revision" }, replayed: false });
      const replay = await app.inject({ method: "POST", url: "/api/v1/projects/with-initial-revision", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "atomic-project-1" }, payload });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toMatchObject({ replayed: true, data: { project: { id: "atomic-project" }, revision: { id: "atomic-revision" } } });
      const audit = await runtime.ports.audit.list(50);
      expect(audit.data.filter((event) => event.action === "project.create_with_initial_revision")).toHaveLength(1);

      const failed = await app.inject({ method: "POST", url: "/api/v1/projects/with-initial-revision", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "atomic-failure-1" }, payload: {
        project: { id: "orphan-project", name: "Must not remain", status: "planning" },
        revision: { id: "collision-revision", name: "Fails", status: "concept" }
      } });
      expect(failed.statusCode).toBe(409);
      await expect(runtime.ports.projects.getProject("orphan-project")).resolves.toBeNull();
      expect(runtime.database.get("SELECT id FROM projects WHERE id = ?", ["orphan-project"])).toBeUndefined();
      await app.close();
    } finally {
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects traversal and disallowed artifact uploads", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const response = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers: { cookie, "x-csrf-token": csrf }, payload: { projectId: "project-1", role: "cad_source", filename: "../secret.step", mediaType: "model/step", byteSize: 1, sha256: createHash("sha256").update("x").digest("hex") } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("uses short-lived header capabilities for MCP upload, finalize, and download", async () => {
    const app = await createApp({
      demo: true,
      publicBaseUrl: "https://configured-maker.example:8792",
      auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("artifact-agent-token", ["read", "write"])] },
      logger: false,
    });
    const headers = { authorization: "Bearer artifact-agent-token" };
    const body = Buffer.from("step-data");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const mcp = (id: string, name: string, args: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });

    const begin = await mcp("begin", "begin_artifact_upload", { projectId: "synthetic-project-lamp", filename: "source.step", role: "step", mediaType: "model/step", byteLength: body.byteLength, sha256 });
    expect(begin.statusCode).toBe(200);
    const ticket = begin.json<{ result: { structuredContent: { uploadId: string; uploadUrl: string; requiredHeaders: Record<string, string>; finalizeUrl: string; finalizeHeaders: Record<string, string> } } }>().result.structuredContent;
    expect(ticket.uploadUrl).toBe("https://configured-maker.example:8792/api/v1/transfers/uploads/" + ticket.uploadId);
    expect(ticket.uploadUrl).not.toContain("?");
    expect(ticket.requiredHeaders).toHaveProperty("x-bench-transfer-token");
    expect(ticket.finalizeUrl).toContain("/api/v1/transfers/uploads/" + ticket.uploadId + "/finalize");
    expect(ticket.finalizeHeaders).toHaveProperty("x-bench-transfer-token");

    // Transfer credentials are checked before the JSON-size guard and before
    // Fastify can parse a potentially large request body.
    const oversizedUnauthenticated = await app.inject({
      method: "POST",
      url: new URL(ticket.finalizeUrl).pathname,
      headers: { "x-bench-transfer-token": "x".repeat(32), "content-length": String(3 * 1024 * 1024), "content-type": "application/json" },
      payload: { sha256, byteLength: body.byteLength }
    });
    expect(oversizedUnauthenticated.statusCode).toBe(403);

    const wrongAction = await app.inject({ method: "POST", url: new URL(ticket.finalizeUrl).pathname, headers: { ...ticket.requiredHeaders, host: "poisoned.example" }, payload: { sha256, byteLength: body.byteLength } });
    expect(wrongAction.statusCode).toBe(403);
    const upload = await app.inject({ method: "PUT", url: new URL(ticket.uploadUrl).pathname, headers: { ...ticket.requiredHeaders, host: "poisoned.example", "content-type": "model/step" }, payload: body });
    expect(upload.statusCode).toBe(200);
    const replayWrite = await app.inject({ method: "PUT", url: new URL(ticket.uploadUrl).pathname, headers: { ...ticket.requiredHeaders, "content-type": "model/step" }, payload: body });
    expect(replayWrite.statusCode).toBe(403);

    const finalize = await app.inject({ method: "POST", url: new URL(ticket.finalizeUrl).pathname, headers: { ...ticket.finalizeHeaders, host: "poisoned.example" }, payload: { sha256, byteLength: body.byteLength } });
    expect(finalize.statusCode).toBe(200);
    const artifactId = finalize.json<{ data: { id: string } }>().data.id;
    const metadataResponse = await mcp("metadata", "read_artifact_download_metadata", { artifactId });
    expect(metadataResponse.statusCode).toBe(200);
    const metadata = metadataResponse.json<{ result: { structuredContent: { downloadUrl: string; requiredHeaders: Record<string, string> } } }>().result.structuredContent;
    expect(metadata.downloadUrl).toBe(`https://configured-maker.example:8792/api/v1/transfers/artifacts/${artifactId}/download`);
    expect(metadata.downloadUrl).not.toContain("?");
    expect(metadata.requiredHeaders).toHaveProperty("x-bench-transfer-token");
    expect((await app.inject({ method: "GET", url: `/api/v1/transfers/artifacts/other-artifact/download`, headers: metadata.requiredHeaders })).statusCode).toBe(403);
    const download = await app.inject({ method: "GET", url: new URL(metadata.downloadUrl).pathname, headers: { ...metadata.requiredHeaders, host: "poisoned.example" } });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe(body.toString());
    expect(download.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ method: "GET", url: `/api/v1/artifacts/${artifactId}/download` })).statusCode).toBe(401);
    await app.close();
  });

  it("uses the capability actor for transfer finalization audit and idempotency attribution", async () => {
    const runtime = createSyntheticRuntime();
    const idempotencyActors: string[] = [];
    const originalSet = runtime.ports.idempotency.set.bind(runtime.ports.idempotency);
    runtime.ports.idempotency.set = async (actor, key, value) => {
      idempotencyActors.push(`${actor}:${key}`);
      return originalSet(actor, key, value);
    };
    const app = await createApp({
      demo: true,
      runtime,
      publicBaseUrl: "https://configured-maker.example:8792",
      auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("actor-bound-token", ["read", "write"], undefined, "cad-agent")] },
      logger: false,
    });
    try {
      const bearerHeaders = { authorization: "Bearer actor-bound-token" };
      const body = Buffer.from("actor-bound-transfer");
      const sha256 = createHash("sha256").update(body).digest("hex");
      const begin = await app.inject({ method: "POST", url: "/api/v1/mcp", headers: bearerHeaders, payload: { jsonrpc: "2.0", id: "begin-actor-bound", method: "tools/call", params: { name: "begin_artifact_upload", arguments: { projectId: "synthetic-project-lamp", filename: "actor-bound.step", role: "step", mediaType: "model/step", byteLength: body.byteLength, sha256 } } } });
      expect(begin.statusCode).toBe(200);
      const ticket = begin.json<{ result: { structuredContent: { uploadId: string; uploadUrl: string; requiredHeaders: Record<string, string>; finalizeUrl: string; finalizeHeaders: Record<string, string> } } }>().result.structuredContent;
      const upload = await app.inject({ method: "PUT", url: new URL(ticket.uploadUrl).pathname, headers: { ...ticket.requiredHeaders, "content-type": "model/step" }, payload: body });
      expect(upload.statusCode).toBe(200);
      const finalize = await app.inject({ method: "POST", url: new URL(ticket.finalizeUrl).pathname, headers: { ...ticket.finalizeHeaders, "idempotency-key": "finalize-actor-1" }, payload: { sha256, byteLength: body.byteLength } });
      expect(finalize.statusCode).toBe(200);

      const audit = await runtime.ports.audit.list(100);
      expect(audit.data.find((event) => event.action === "artifact.upload.begin")).toMatchObject({ actor: "mcp-token:cad-agent", source: "mcp" });
      expect(audit.data.find((event) => event.action === "artifact.upload.finalize")).toMatchObject({ actor: "mcp-token:cad-agent", source: "mcp", idempotencyKey: "finalize-actor-1" });
      expect(idempotencyActors).toContain("mcp-token:cad-agent:finalize-actor-1");

      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
      const cookie = cookieHeader(login.headers["set-cookie"]);
      const csrf = login.json<{ csrfToken: string }>().csrfToken;
      const uiBegin = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers: { cookie, "x-csrf-token": csrf }, payload: { projectId: "synthetic-project-lamp", filename: "ui-source.step", role: "step", mediaType: "model/step", byteSize: body.byteLength, sha256 } });
      expect(uiBegin.statusCode).toBe(201);
      const afterUiAudit = await runtime.ports.audit.list(100);
      expect(afterUiAudit.data.filter((event) => event.action === "artifact.upload.begin").slice(-1)[0]).toMatchObject({ actor: "admin", source: "ui" });
    } finally {
      await app.close();
    }
  });

  it("serves the built SPA shell and mounts the authenticated MCP JSON-RPC surface", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const shell = await app.inject({ method: "GET", url: "/" });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers["content-type"]).toContain("text/html");
    const mcp = await app.inject({ method: "POST", url: "/api/v1/mcp", headers: { cookie, "x-csrf-token": csrf }, payload: {
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" }
    } });
    expect(mcp.statusCode).toBe(200);
    expect(mcp.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "benchledger" } } });
    await app.close();
  });

  it("serves one authenticated workspace snapshot and promotes a physical count", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const workspace = await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { cookie } });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json()).toMatchObject({ source: "api", inventory: expect.any(Array), projects: expect.any(Array), offers: expect.any(Array) });
    const project = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie, "x-csrf-token": csrf }, payload: { name: "Workspace aggregate", status: "planning" } });
    const projectId = project.json<{ data: { id: string } }>().data.id;
    const revision = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/revisions`, headers: { cookie, "x-csrf-token": csrf }, payload: { name: "r01", status: "concept" } });
    const revisionId = revision.json<{ data: { id: string } }>().data.id;
    const line = await app.inject({ method: "POST", url: `/api/v1/project-revisions/${revisionId}/bom`, headers: { cookie, "x-csrf-token": csrf }, payload: { name: "ESP32", itemId: "board-esp32", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} } });
    expect(line.statusCode).toBe(201);
    const enriched = await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { cookie } });
    const aggregateProject = enriched.json<{ projects: Array<{ id: string; currentRevision?: { bom: Array<{ id: string }>; artifacts: unknown[] }; bom: unknown[]; artifacts: unknown[] }> }>().projects.find((entry) => entry.id === projectId);
    expect(aggregateProject).toMatchObject({ currentRevision: { bom: [{ id: expect.any(String) }], artifacts: expect.any(Array) }, bom: expect.any(Array), artifacts: expect.any(Array) });
    const count = await app.inject({ method: "POST", url: "/api/v1/inventory/wire-dupont/count", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "count-wire-dupont" }, payload: { quantity: 1, note: "Counted in parts drawer" } });
    expect(count.statusCode).toBe(201);
    expect(count.json()).toMatchObject({ data: { item: { id: "wire-dupont", quantity: 1, availableQuantity: 1, evidence: { state: "physically_counted" } } } });
    await app.close();
  });

  it("rehydrates exact inventory links and the latest build setup after a fresh workspace load", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const revisionId = "synthetic-revision-lamp-r01";
    const snapshot = await app.inject({
      method: "POST",
      url: `/api/v1/project-revisions/${revisionId}/build-configurations`,
      headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "workspace-build-config-1" },
      payload: {
        id: "workspace-build-config-1",
        projectRevisionId: revisionId,
        printerItemSnapshot: { itemId: "printer-h2d", catalogProductId: "catalog-printer-h2d", profileId: "profile-printer-h2d" },
        filamentSelections: [{ itemId: "filament-petg-hf", catalogProductId: "catalog-filament-petg-hf", profileId: "profile-filament-petg-hf", role: "body" }],
        activeHotend: "left",
        nozzle: { diameterMm: 0.4, material: "hardened_steel" },
        plate: "Textured PEI",
        accessories: ["AMS 2 Pro"],
        firmware: "01.08",
        slicer: { name: "Bambu Studio", version: "1.10" },
        profile: "0.20 mm Standard",
        calibration: "checked",
        explicitUnknowns: []
      }
    });
    expect(snapshot.statusCode).toBe(201);

    // A second request represents a browser reload: no client-side cache is
    // involved, so exact IDs must be recoverable from durable references.
    const workspace = await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { cookie } });
    expect(workspace.statusCode).toBe(200);
    type HydratedItem = { id: string; catalogProduct?: { id: string; exactModel?: string; productName?: string }; productProfile?: { id: string; catalogProductId: string; linkState: string } };
    type HydratedConfiguration = { id: string; projectRevisionId: string; printerItemSnapshot: { itemId: string; catalogProductId: string; profileId?: string }; filamentSelections: Array<{ itemId: string; catalogProductId: string; profileId?: string }> };
    type HydratedProject = { id: string; currentRevision?: { buildConfigSnapshot?: HydratedConfiguration } };
    const body = workspace.json() as { inventory: HydratedItem[]; projects: HydratedProject[] };
    const printer = body.inventory.find((item) => item.id === "printer-h2d");
    expect(printer).toMatchObject({
      productProfile: { id: "profile-printer-h2d", catalogProductId: "catalog-printer-h2d", linkState: "confirmed" },
      catalogProduct: { id: "catalog-printer-h2d", exactModel: "H2D" }
    });
    const filament = body.inventory.find((item) => item.id === "filament-petg-hf");
    expect(filament).toMatchObject({
      productProfile: { id: "profile-filament-petg-hf", catalogProductId: "catalog-filament-petg-hf", linkState: "confirmed" },
      catalogProduct: { id: "catalog-filament-petg-hf", productName: "PETG HF" }
    });
    const legacy = body.inventory.find((item) => item.id === "board-esp32");
    expect(legacy).not.toHaveProperty("productProfile");
    expect(legacy).not.toHaveProperty("catalogProduct");
    const project = body.projects.find((entry) => entry.id === "synthetic-project-lamp");
    expect(project?.currentRevision?.buildConfigSnapshot).toMatchObject({
      id: "workspace-build-config-1",
      projectRevisionId: revisionId,
      printerItemSnapshot: { itemId: "printer-h2d", catalogProductId: "catalog-printer-h2d", profileId: "profile-printer-h2d" },
      filamentSelections: [{ itemId: "filament-petg-hf", catalogProductId: "catalog-filament-petg-hf", profileId: "profile-filament-petg-hf" }]
    });
    await app.close();
  });

  it("uses the true latest build setup when a revision has more than one bounded page", async () => {
    const runtime = createSyntheticRuntime();
    const service = new ApplicationService(runtime.ports);
    const revisionId = "synthetic-revision-lamp-r01";
    const seedContext = {
      actor: "latest-snapshot-test",
      source: "api" as const,
      correlationId: "latest-snapshot-test",
      scopes: new Set(["read", "write", "projects:read", "projects:write"]),
    };
    const setup = {
      projectRevisionId: revisionId,
      printerItemSnapshot: { itemId: "printer-h2d", catalogProductId: "catalog-printer-h2d", profileId: "profile-printer-h2d" },
      filamentSelections: [{ itemId: "filament-petg-hf", catalogProductId: "catalog-filament-petg-hf", profileId: "profile-filament-petg-hf", role: "body" }],
      activeHotend: "left",
      nozzle: { diameterMm: 0.4, material: "hardened_steel" },
      plate: "Textured PEI",
      accessories: ["AMS 2 Pro"],
      firmware: "01.08",
      slicer: { name: "Bambu Studio", version: "1.10" },
      profile: "0.20 mm Standard",
      calibration: "checked",
      explicitUnknowns: []
    } as const;
    for (let ordinal = 1; ordinal <= 201; ordinal += 1) {
      await service.createBuildConfiguration(revisionId, {
        ...setup,
        id: `workspace-latest-${String(ordinal).padStart(3, "0")}`,
      }, seedContext);
    }

    const app = await createApp({ demo: true, runtime, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
    const cookie = cookieHeader(login.headers["set-cookie"]);
    const workspace = await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { cookie } });
    expect(workspace.statusCode).toBe(200);
    const project = workspace.json<{ projects: Array<{ id: string; currentRevision?: { buildConfigSnapshot?: { id: string } } }> }>().projects.find((entry) => entry.id === "synthetic-project-lamp");
    expect(project?.currentRevision?.buildConfigSnapshot?.id).toBe("workspace-latest-201");
    await app.close();
  });

  it("does not expose build-configuration existence to a project-scoped REST token", async () => {
    const runtime = createSyntheticRuntime();
    const seedContext = { actor: "seed-agent", source: "api" as const, correlationId: "seed-build-config-access", scopes: new Set(["read", "write"]) };
    const createSnapshotInput = (id: string, projectRevisionId: string) => ({
      id,
      projectRevisionId,
      printerItemSnapshot: { itemId: "printer-h2d", catalogProductId: "catalog-printer-h2d", profileId: "profile-printer-h2d" },
      filamentSelections: [{ itemId: "filament-petg-hf", catalogProductId: "catalog-filament-petg-hf", profileId: "profile-filament-petg-hf", role: "body" }],
      activeHotend: "left",
      nozzle: { diameterMm: 0.4, material: "hardened_steel" },
      plate: "Textured PEI",
      accessories: ["AMS 2 Pro"],
      firmware: "01.08",
      slicer: { name: "Bambu Studio", version: "1.10" },
      profile: "0.20 mm Standard",
      calibration: "checked",
      explicitUnknowns: []
    });
    const service = new ApplicationService(runtime.ports);
    await runtime.ports.projects.createProject({ id: "other-snapshot-project", name: "Other snapshot project", status: "planning" }, seedContext);
    await runtime.ports.projects.createProjectRevision("other-snapshot-project", { id: "other-snapshot-revision", name: "Other snapshot revision", status: "concept" }, seedContext);
    await service.createBuildConfiguration("synthetic-revision-lamp-r01", createSnapshotInput("allowed-build-config", "synthetic-revision-lamp-r01"), seedContext);
    await service.createBuildConfiguration("other-snapshot-revision", createSnapshotInput("denied-build-config", "other-snapshot-revision"), seedContext);

    const app = await createApp({ demo: true, runtime, auth: {
      sessionSecret: "s".repeat(48),
      secureCookies: false,
      bearerTokens: [bearerRecord("snapshot-project-token", ["read"], ["synthetic-project-lamp"])],
    }, logger: false });
    const scopedHeaders = { authorization: "Bearer snapshot-project-token" };
    const allowed = await app.inject({ method: "GET", url: "/api/v1/build-configurations/allowed-build-config", headers: scopedHeaders });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ id: "allowed-build-config", projectRevisionId: "synthetic-revision-lamp-r01" });

    const denied = await app.inject({ method: "GET", url: "/api/v1/build-configurations/denied-build-config", headers: scopedHeaders });
    const missing = await app.inject({ method: "GET", url: "/api/v1/build-configurations/missing-build-config", headers: scopedHeaders });
    expect(denied.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
    expect(denied.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "forbidden" });
    expect(missing.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "forbidden" });
    expect(denied.json<{ error: { message: string } }>().error.message).toBe(missing.json<{ error: { message: string } }>().error.message);

    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
    expect(login.statusCode).toBe(200);
    const unscopedMissing = await app.inject({ method: "GET", url: "/api/v1/build-configurations/missing-build-config", headers: { cookie: cookieHeader(login.headers["set-cookie"]) } });
    expect(unscopedMissing.statusCode).toBe(404);
    await app.close();
  });

  it("normalizes missing and cross-project revisions before scoped route dispatch", async () => {
    const runtime = createSyntheticRuntime();
    const seedContext = { actor: "seed-agent", source: "api" as const, correlationId: "seed-revision-access", scopes: new Set(["read", "write"]) };
    await runtime.ports.projects.createProject({ id: "other-revision-project", name: "Other revision project", status: "planning" }, seedContext);
    await runtime.ports.projects.createProjectRevision("other-revision-project", { id: "other-revision", name: "Other revision", status: "concept" }, seedContext);

    const service = new ApplicationService(runtime.ports);
    const listBomLines = vi.spyOn(service, "listBomLines");
    const app = await createApp({ demo: true, runtime, service, auth: {
      sessionSecret: "s".repeat(48),
      secureCookies: false,
      bearerTokens: [bearerRecord("revision-project-token", ["read"], ["synthetic-project-lamp"])],
    }, logger: false });
    try {
      const scopedHeaders = { authorization: "Bearer revision-project-token" };
      const crossProject = await app.inject({ method: "GET", url: "/api/v1/project-revisions/other-revision/bom", headers: scopedHeaders });
      const missing = await app.inject({ method: "GET", url: "/api/v1/project-revisions/missing-revision/bom", headers: scopedHeaders });
      expect(crossProject.statusCode).toBe(403);
      expect(missing.statusCode).toBe(403);
      expect(crossProject.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "forbidden" });
      expect(missing.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "forbidden" });
      expect(crossProject.json<{ error: { message: string } }>().error.message).toBe(missing.json<{ error: { message: string } }>().error.message);
      expect(listBomLines).not.toHaveBeenCalled();

      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
      expect(login.statusCode).toBe(200);
      const unscopedMissing = await app.inject({ method: "GET", url: "/api/v1/project-revisions/missing-revision/bom", headers: { cookie: cookieHeader(login.headers["set-cookie"]) } });
      expect(unscopedMissing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("normalizes missing and cross-project superseded snapshots before a scoped create dispatch", async () => {
    const runtime = createSyntheticRuntime();
    const seedContext = { actor: "seed-agent", source: "api" as const, correlationId: "seed-scoped-create", scopes: new Set(["read", "write"]) };
    const service = new ApplicationService(runtime.ports);
    await runtime.ports.projects.createProject({ id: "other-create-project", name: "Other create project", status: "planning" }, seedContext);
    await runtime.ports.projects.createProjectRevision("other-create-project", { id: "other-create-revision", name: "Other create revision", status: "concept" }, seedContext);
    await service.createBuildConfiguration("other-create-revision", {
      id: "cross-project-superseded-snapshot",
      projectRevisionId: "other-create-revision",
      printerItemSnapshot: { itemId: "printer-h2d", catalogProductId: "catalog-printer-h2d", profileId: "profile-printer-h2d" },
      filamentSelections: [{ itemId: "filament-petg-hf", catalogProductId: "catalog-filament-petg-hf", profileId: "profile-filament-petg-hf", role: "body" }],
      activeHotend: "left",
      nozzle: { diameterMm: 0.4, material: "hardened_steel" },
      plate: "Textured PEI",
      accessories: ["AMS 2 Pro"],
      firmware: "01.08",
      slicer: { name: "Bambu Studio", version: "1.10" },
      profile: "0.20 mm Standard",
      calibration: "checked",
      explicitUnknowns: []
    }, seedContext);

    const createBuildConfiguration = vi.spyOn(service, "createBuildConfiguration");
    const app = await createApp({ demo: true, runtime, service, auth: {
      sessionSecret: "s".repeat(48),
      secureCookies: false,
      bearerTokens: [bearerRecord("scoped-create-token", ["write"], ["synthetic-project-lamp"])],
    }, logger: false });
    try {
      const headers = { authorization: "Bearer scoped-create-token" };
      const createSnapshot = (supersedesSnapshotId: string) => ({
        id: `scoped-create-${supersedesSnapshotId}`,
        projectRevisionId: "synthetic-revision-lamp-r01",
        printerItemSnapshot: { itemId: "printer-h2d", catalogProductId: "catalog-printer-h2d", profileId: "profile-printer-h2d" },
        filamentSelections: [{ itemId: "filament-petg-hf", catalogProductId: "catalog-filament-petg-hf", profileId: "profile-filament-petg-hf", role: "body" }],
        activeHotend: "left",
        nozzle: { diameterMm: 0.4, material: "hardened_steel" },
        plate: "Textured PEI",
        accessories: ["AMS 2 Pro"],
        firmware: "01.08",
        slicer: { name: "Bambu Studio", version: "1.10" },
        profile: "0.20 mm Standard",
        calibration: "checked",
        explicitUnknowns: [],
        supersedesSnapshotId
      });

      const crossProject = await app.inject({ method: "POST", url: "/api/v1/project-revisions/synthetic-revision-lamp-r01/build-configurations", headers, payload: createSnapshot("cross-project-superseded-snapshot") });
      const missing = await app.inject({ method: "POST", url: "/api/v1/project-revisions/synthetic-revision-lamp-r01/build-configurations", headers, payload: createSnapshot("missing-superseded-snapshot") });
      expect(crossProject.statusCode).toBe(403);
      expect(missing.statusCode).toBe(403);
      expect(crossProject.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "forbidden" });
      expect(missing.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "forbidden" });
      expect(crossProject.json<{ error: { message: string } }>().error.message).toBe(missing.json<{ error: { message: string } }>().error.message);
      expect(createBuildConfiguration).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("normalizes missing and cross-project upload snapshots before a scoped begin dispatch", async () => {
    const runtime = createSyntheticRuntime();
    const seedContext = { actor: "seed-agent", source: "api" as const, correlationId: "seed-scoped-upload", scopes: new Set(["read", "write"]) };
    const service = new ApplicationService(runtime.ports);
    await runtime.ports.projects.createProject({ id: "other-upload-project", name: "Other upload project", status: "planning" }, seedContext);
    await runtime.ports.projects.createProjectRevision("other-upload-project", { id: "other-upload-revision", name: "Other upload revision", status: "concept" }, seedContext);
    await service.createBuildConfiguration("other-upload-revision", {
      id: "cross-project-upload-snapshot",
      projectRevisionId: "other-upload-revision",
      printerItemSnapshot: { itemId: "printer-h2d", catalogProductId: "catalog-printer-h2d", profileId: "profile-printer-h2d" },
      filamentSelections: [{ itemId: "filament-petg-hf", catalogProductId: "catalog-filament-petg-hf", profileId: "profile-filament-petg-hf", role: "body" }],
      activeHotend: "left",
      nozzle: { diameterMm: 0.4, material: "hardened_steel" },
      plate: "Textured PEI",
      accessories: ["AMS 2 Pro"],
      firmware: "01.08",
      slicer: { name: "Bambu Studio", version: "1.10" },
      profile: "0.20 mm Standard",
      calibration: "checked",
      explicitUnknowns: []
    }, seedContext);

    const beginArtifactUpload = vi.spyOn(service, "beginArtifactUpload");
    const app = await createApp({ demo: true, runtime, service, auth: {
      sessionSecret: "s".repeat(48),
      secureCookies: false,
      bearerTokens: [bearerRecord("scoped-upload-token", ["write"], ["synthetic-project-lamp"])],
    }, logger: false });
    try {
      const headers = { authorization: "Bearer scoped-upload-token" };
      const beginUpload = (buildConfigurationSnapshotId: string) => ({
        projectId: "synthetic-project-lamp",
        revisionId: "synthetic-revision-lamp-r01",
        buildConfigurationSnapshotId,
        role: "step",
        filename: `scoped-${buildConfigurationSnapshotId}.step`,
        mediaType: "model/step",
        byteSize: 1,
        sha256: "a".repeat(64)
      });

      const crossProject = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers, payload: beginUpload("cross-project-upload-snapshot") });
      const missing = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers, payload: beginUpload("missing-upload-snapshot") });
      expect(crossProject.statusCode).toBe(403);
      expect(missing.statusCode).toBe(403);
      expect(crossProject.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "forbidden" });
      expect(missing.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "forbidden" });
      expect(crossProject.json<{ error: { message: string } }>().error.message).toBe(missing.json<{ error: { message: string } }>().error.message);
      expect(beginArtifactUpload).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("starts the file-backed runtime and reports readiness before serving production requests", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-server-"));
    try {
      const app = await createApp({ dataDir, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
      const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({ status: "ok", checks: { database: "ok", artifacts: "ok" }, demo: false });
      await app.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps LAN session cookies usable over HTTP and adds Secure only when explicitly enabled", async () => {
    const plain = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    const plainLogin = await plain.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
    expect(String(plainLogin.headers["set-cookie"])).not.toContain("Secure");
    await plain.close();
    const tls = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: true }, logger: false });
    const tlsLogin = await tls.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
    expect(String(tlsLogin.headers["set-cookie"])).toContain("Secure");
    await tls.close();
  });

  it("filters project lists and denies global surfaces for a project-scoped bearer token", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("lamp-project-token", ["read", "write"], ["synthetic-project-lamp"])] }, logger: false });
    const headers = { authorization: "Bearer lamp-project-token" };
    const projects = await app.inject({ method: "GET", url: "/api/v1/projects", headers });
    expect(projects.statusCode).toBe(200);
    expect(projects.json<{ data: Array<{ id: string }> }>().data.map((project) => project.id)).toEqual(["synthetic-project-lamp"]);
    expect((await app.inject({ method: "GET", url: "/api/v1/workspace", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/projects", headers, payload: { name: "Must not create", status: "planning" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/project-revisions/not-a-visible-revision", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/inventory", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/inventory", headers, payload: { name: "Must not mutate", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/offers", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/offers?itemId=board-esp32", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/offers", headers, payload: { itemId: "board-esp32", name: "Nope", supplier: "Example", url: "https://example.test/item", priceMinor: 100, currency: "EUR" } })).statusCode).toBe(403);
    const allowedRevisionCall = await app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload: { jsonrpc: "2.0", id: "allowed-revision", method: "tools/call", params: { name: "read_project_revision", arguments: { revisionId: "synthetic-revision-lamp-r01" } } } });
    expect(allowedRevisionCall.statusCode).toBe(200);
    expect(allowedRevisionCall.json()).toMatchObject({ result: { isError: false, structuredContent: { id: "synthetic-revision-lamp-r01" } } });
    const deniedRevisionCall = await app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload: { jsonrpc: "2.0", id: "denied-revision", method: "tools/call", params: { name: "read_project_revision", arguments: { revisionId: "not-visible" } } } });
    expect(deniedRevisionCall.statusCode).toBe(200);
    expect(deniedRevisionCall.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "FORBIDDEN" } } } });
    await app.close();
  });

  it("authorizes and releases an indirect reservation across separate MCP HTTP requests", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("reservation-project-token", ["read", "write"], ["synthetic-project-lamp"])] }, logger: false });
    const headers = { authorization: "Bearer reservation-project-token" };
    const call = (id: string, name: string, args: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });

    const created = await call("create", "create_reservation", {
      projectRevisionId: "synthetic-revision-lamp-r01",
      bomLineId: "synthetic-bom-board",
      itemId: "board-esp32",
      quantity: { value: 1, unit: "piece" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ result: { isError: false, structuredContent: { id: expect.any(String), projectRevisionId: "synthetic-revision-lamp-r01", quantity: { unit: "piece" } } } });
    const reservationId = created.json<{ result: { structuredContent: { id: string } } }>().result.structuredContent.id;

    const released = await call("release", "release_reservation", { reservationId });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ result: { isError: false, structuredContent: { id: reservationId, projectRevisionId: "synthetic-revision-lamp-r01", bomLineId: "synthetic-bom-board", quantity: { unit: "piece" }, status: "released" } } });
    await app.close();
  });

  it("resolves historical reservations and upload ancestry across separate MCP HTTP requests", async () => {
    const runtime = createSyntheticRuntime();
    const app = await createApp({ demo: true, runtime, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("historical-project-token", ["read", "write"], ["synthetic-project-lamp"])] }, logger: false });
    const headers = { authorization: "Bearer historical-project-token" };
    const call = (id: string, name: string, args: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });
    const historicalRevisionId = "synthetic-revision-lamp-r01";

    const created = await call("create-reservation", "create_reservation", {
      projectRevisionId: historicalRevisionId,
      bomLineId: "synthetic-bom-board",
      itemId: "board-esp32",
      quantity: { value: 1, unit: "piece" },
    });
    expect(created.json()).toMatchObject({ result: { isError: false, structuredContent: { projectRevisionId: historicalRevisionId } } });
    const reservationId = created.json<{ result: { structuredContent: { id: string } } }>().result.structuredContent.id;

    await runtime.ports.projects.createProjectRevision("synthetic-project-lamp", { id: "synthetic-revision-lamp-r02", name: "Current baseline", status: "concept" }, {
      actor: "test-agent", source: "api", correlationId: "historical-current-revision", scopes: new Set(["read", "write"])
    });
    const released = await call("release-reservation", "release_reservation", { reservationId });
    expect(released.json()).toMatchObject({ result: { isError: false, structuredContent: { id: reservationId, projectRevisionId: historicalRevisionId, bomLineId: "synthetic-bom-board", status: "released" } } });

    const body = Buffer.from("historical-step");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const begin = await call("begin-upload", "begin_artifact_upload", { projectId: "synthetic-project-lamp", projectRevisionId: historicalRevisionId, filename: "historical.step", role: "step", mediaType: "model/step", byteLength: body.byteLength, sha256 });
    const ticket = begin.json<{ result: { structuredContent: { uploadId: string; uploadUrl: string; requiredHeaders: Record<string, string> } } }>().result.structuredContent;
    expect(ticket.uploadId).toEqual(expect.any(String));
    const upload = await app.inject({ method: "PUT", url: new URL(ticket.uploadUrl).pathname, headers: { ...ticket.requiredHeaders, "content-type": "model/step" }, payload: body });
    expect(upload.statusCode).toBe(200);
    const finalized = await call("finalize-upload", "finalize_artifact_upload", { uploadId: ticket.uploadId });
    expect(finalized.json()).toMatchObject({ result: { isError: false, structuredContent: { projectId: "synthetic-project-lamp", projectRevisionId: historicalRevisionId, filename: "historical.step" } } });
    await app.close();
  });

  it("exposes the atomic project command through MCP with idempotent replay and no orphan on rollback", async () => {
    const runtime = createSyntheticRuntime();
    const app = await createApp({ demo: true, runtime, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("mcp-project-writer", ["read", "write"])] }, logger: false });
    const headers = { authorization: "Bearer mcp-project-writer", "idempotency-key": "mcp-atomic-project-1" };
    const payload = { jsonrpc: "2.0", id: "create", method: "tools/call", params: { name: "create_project_with_initial_revision", arguments: { projectId: "mcp-atomic-project", revisionId: "mcp-atomic-revision", name: "MCP atomic project", revisionSummary: "Initial plan" } } };
    const first = await app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ result: { isError: false, structuredContent: { project: { id: "mcp-atomic-project" }, revision: { id: "mcp-atomic-revision" }, replayed: false } } });
    const replay = await app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload: { ...payload, id: "retry" } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ result: { isError: false, structuredContent: { project: { id: "mcp-atomic-project" }, revision: { id: "mcp-atomic-revision" }, replayed: true } } });
    const audit = await runtime.ports.audit.list(100);
    expect(audit.data.filter((event) => event.action === "project.create_with_initial_revision")).toHaveLength(1);

    const failedPayload = { jsonrpc: "2.0", id: "failed", method: "tools/call", params: { name: "create_project_with_initial_revision", arguments: { projectId: "mcp-orphan", revisionId: "mcp-atomic-revision", name: "Must roll back", revisionSummary: "Collision" } } };
    const failed = await app.inject({ method: "POST", url: "/api/v1/mcp", headers: { ...headers, "idempotency-key": "mcp-atomic-project-failure" }, payload: failedPayload });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "CONFLICT" } } } });
    await expect(runtime.ports.projects.getProject("mcp-orphan")).resolves.toBeNull();
    await app.close();
  });

  it("rejects malformed login bodies, rate limits repeated failures, and resets an expired window", async () => {
    const invalidPassword = ["wrong", "password"].join("-");
    const app = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    try {
      const malformed = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: "x".repeat(513) } });
      expect(malformed.statusCode).toBe(401);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: invalidPassword } })).statusCode).toBe(401);
      }
      const limited = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: invalidPassword } });
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      await app.close();
    }

    let now = new Date("2026-08-30T12:00:00.000Z").getTime();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const resetApp = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    try {
      expect((await resetApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: invalidPassword } })).statusCode).toBe(401);
      now += 15 * 60 * 1000 + 1;
      expect((await resetApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: invalidPassword } })).statusCode).toBe(401);
    } finally {
      await resetApp.close();
      dateNow.mockRestore();
    }
  });

  it("enforces JSON request limits before authentication and validates session routes and correlation ids", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    const tooLarge = await app.inject({ method: "POST", url: "/api/v1/inventory", headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) }, payload: {} });
    expect(tooLarge.statusCode).toBe(413);
    const malformedLength = await app.inject({ method: "POST", url: "/api/v1/inventory", headers: { "content-type": "application/json", "content-length": "not-a-number" }, payload: {} });
    expect(malformedLength.statusCode).toBe(401);
    const correlation = await app.inject({ method: "GET", url: "/api/v1/health", headers: { "x-correlation-id": "correlation-test-1" } });
    expect(correlation.headers["x-correlation-id"]).toBe("correlation-test-1");
    const invalidCorrelation = await app.inject({ method: "GET", url: "/api/v1/health", headers: { "x-correlation-id": "!" } });
    expect(invalidCorrelation.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/u);

    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
    const cookie = cookieHeader(login.headers["set-cookie"]);
    const csrf = login.json<{ csrfToken: string }>().csrfToken;
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } })).statusCode).toBe(403);
    const loggedOut = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie, "x-csrf-token": csrf } });
    expect(loggedOut.statusCode).toBe(200);
    expect(loggedOut.json()).toMatchObject({ authenticated: false });
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: "forge_session=invalid" } })).statusCode).toBe(401);
    await app.close();
  });

  it("maps route validation, not-found, quota, media, and version errors without leaking internals", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const invalidQuery = await app.inject({ method: "GET", url: "/api/v1/inventory?limit=not-a-number", headers: { cookie } });
    expect(invalidQuery.statusCode).toBe(400);
    expect(invalidQuery.json()).toMatchObject({ error: { code: "validation" } });
    expect((await app.inject({ method: "GET", url: "/api/v1/inventory/missing-item", headers: { cookie } })).statusCode).toBe(404);
    const unsupported = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers: { cookie, "x-csrf-token": csrf }, payload: { projectId: "synthetic-project-lamp", filename: "bad.bin", role: "other", mediaType: "application/x-unknown", byteSize: 1, sha256: "a".repeat(64) } });
    expect(unsupported.statusCode).toBe(415);
    const badVersion = await app.inject({ method: "PATCH", url: "/api/v1/inventory/wire-dupont", headers: { cookie, "x-csrf-token": csrf, "if-match": "not-a-version" }, payload: { name: "Updated wire" } });
    expect(badVersion.statusCode).toBe(400);
    const countBody = await app.inject({ method: "POST", url: "/api/v1/inventory/wire-dupont/count", headers: { cookie, "x-csrf-token": csrf }, payload: { quantity: -1 } });
    expect(countBody.statusCode).toBe(400);
    const unknownApi = await app.inject({ method: "GET", url: "/api/v1/no-such-route", headers: { cookie } });
    expect(unknownApi.statusCode).toBe(404);
    await app.close();
  });

  it("serves SPA fallbacks safely and keeps API paths from becoming file lookups", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    const fallback = await app.inject({ method: "GET", url: "/projects/client-route" });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.headers["content-type"]).toContain("text/html");
    const head = await app.inject({ method: "HEAD", url: "/" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    const assetRoot = fileURLToPath(new URL("../../web/dist/assets/", import.meta.url));
    const assets = await readdir(assetRoot);
    const cssAsset = assets.find((asset) => asset.endsWith(".css"));
    const scriptAsset = assets.find((asset) => asset.endsWith(".js"));
    expect(cssAsset).toEqual(expect.any(String));
    expect(scriptAsset).toEqual(expect.any(String));
    const css = await app.inject({ method: "GET", url: `/assets/${cssAsset}` });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    const script = await app.inject({ method: "GET", url: `/assets/${scriptAsset}` });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");
    expect((await app.inject({ method: "GET", url: "/missing.css" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/not-a-file.js" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/%00" })).statusCode).toBe(200);
    await app.close();
  });

  it("returns degraded readiness and a correlation-safe internal error response", async () => {
    const runtime = createSyntheticRuntime();
    const degradedPorts = { ...runtime.ports, health: { check: async () => ({ database: "failed" as const, artifacts: "ok" as const }) } };
    const degraded = await createApp({ ports: degradedPorts, demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    const health = await degraded.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "degraded", demo: true });
    expect(health.json()).not.toHaveProperty("checks");
    const ready = await degraded.inject({ method: "GET", url: "/api/v1/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: "degraded", checks: { database: "failed" } });
    await degraded.close();

    const service = new ApplicationService(runtime.ports);
    vi.spyOn(service, "health").mockRejectedValue(new Error("private internal detail"));
    const broken = await createApp({ ports: runtime.ports, service, demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    const response = await broken.inject({ method: "GET", url: "/api/v1/health", headers: { "x-correlation-id": "internal-test" } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "internal", correlationId: "internal-test" } });
    expect(response.body).not.toContain("private internal detail");
    await broken.close();
  });

  it("filters scoped project pages and blocks indirect global and project access", async () => {
    const runtime = createSyntheticRuntime();
    await runtime.projects.createProject({ id: "scoped-second", name: "Second project", description: "Another reference project", status: "planning" });
    const app = await createApp({ demo: true, runtime, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("scoped-query-token", ["read"], ["synthetic-project-lamp", "scoped-second", "missing-project"])] }, logger: false });
    const headers = { authorization: "Bearer scoped-query-token" };
    const descriptionMatch = await app.inject({ method: "GET", url: "/api/v1/projects?q=reference&status=planning&limit=1&cursor=bad", headers });
    expect(descriptionMatch.statusCode).toBe(200);
    expect(descriptionMatch.json<{ data: Array<{ id: string }>; total: number; nextCursor?: string }>().data.map((project) => project.id)).toEqual(["synthetic-project-lamp"]);
    expect(descriptionMatch.json()).toMatchObject({ total: 2, limit: 1, nextCursor: "1" });
    const secondPage = await app.inject({ method: "GET", url: "/api/v1/projects?q=reference&status=planning&limit=1&cursor=1", headers });
    expect(secondPage.json<{ data: Array<{ id: string }> }>().data.map((project) => project.id)).toEqual(["scoped-second"]);
    const emptyPage = await app.inject({ method: "GET", url: "/api/v1/projects?cursor=999", headers });
    expect(emptyPage.statusCode).toBe(200);
    expect(emptyPage.json()).toMatchObject({ data: [], total: 2 });
    expect((await app.inject({ method: "GET", url: "/api/v1/projects/synthetic-project-lamp", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/projects/other-project", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/projects/synthetic-project-lamp/artifacts", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers, payload: { projectId: "other-project", filename: "x.step", role: "step", mediaType: "model/step", byteSize: 1, sha256: "a".repeat(64) } })).statusCode).toBe(403);
    await app.close();
  });

  it("includes projects without a current revision in workspace snapshots", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const project = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie, "x-csrf-token": csrf }, payload: { name: "No revision yet", description: "A project awaiting setup", status: "idea" } });
    expect(project.statusCode).toBe(201);
    const projectId = project.json<{ data: { id: string } }>().data.id;
    const workspace = await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { cookie } });
    const entry = workspace.json<{ projects: Array<{ id: string; bom: unknown[]; artifacts: unknown[]; currentRevision?: unknown }> }>().projects.find((candidate) => candidate.id === projectId);
    expect(entry).toMatchObject({ id: projectId, bom: [], artifacts: [] });
    expect(entry).not.toHaveProperty("currentRevision");
    await app.close();
  });

  it("preflights transfer requests before parsing bodies and releases a failed finalize for retry", async () => {
    const app = await createApp({
      demo: true,
      publicBaseUrl: "https://configured-maker.example:8792",
      auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("transfer-route-token", ["read", "write"])] },
      logger: false,
    });
    const headers = { authorization: "Bearer transfer-route-token" };
    const body = Buffer.from("transfer-route");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const call = (id: string, name: string, args: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });
    const begin = await call("begin-route", "begin_artifact_upload", { projectId: "synthetic-project-lamp", filename: "route.step", role: "step", mediaType: "model/step", byteLength: body.byteLength, sha256 });
    const ticket = begin.json<{ result: { structuredContent: { uploadId: string; uploadUrl: string; requiredHeaders: Record<string, string>; finalizeUrl: string; finalizeHeaders: Record<string, string> } } }>().result.structuredContent;
    const uploadPath = new URL(ticket.uploadUrl).pathname;
    const finalizePath = new URL(ticket.finalizeUrl).pathname;
    expect((await app.inject({ method: "POST", url: uploadPath, headers: ticket.requiredHeaders, payload: body })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: finalizePath, headers: ticket.finalizeHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: uploadPath, headers: ticket.requiredHeaders })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: uploadPath, headers: { ...ticket.requiredHeaders, "content-length": String(body.byteLength + 1) }, payload: body })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: uploadPath, headers: { ...ticket.requiredHeaders, "content-length": "not-a-number" }, payload: body })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: uploadPath, headers: { ...ticket.requiredHeaders, "content-length": "9007199254740992" }, payload: body })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/v1/transfers/uploads/%E0%A4%A", headers: ticket.requiredHeaders, payload: body })).statusCode).toBe(400);

    expect((await app.inject({ method: "POST", url: finalizePath, headers: { ...ticket.finalizeHeaders, "content-type": "application/json" }, payload: "null" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: finalizePath, headers: ticket.finalizeHeaders, payload: { sha256: "bad", byteLength: body.byteLength } })).statusCode).toBe(400);
    const failedFinalize = await app.inject({ method: "POST", url: finalizePath, headers: ticket.finalizeHeaders, payload: { sha256, byteLength: body.byteLength } });
    expect(failedFinalize.statusCode).toBe(409);
    const retriedUpload = await app.inject({ method: "PUT", url: uploadPath, headers: { ...ticket.requiredHeaders, "content-type": "model/step" }, payload: body });
    expect(retriedUpload).toMatchObject({ statusCode: 200 });
    const finalized = await app.inject({ method: "POST", url: finalizePath, headers: ticket.finalizeHeaders, payload: { sha256, byteLength: body.byteLength } });
    expect(finalized.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: finalizePath, headers: ticket.finalizeHeaders, payload: { sha256, byteLength: body.byteLength } })).statusCode).toBe(403);
    await app.close();
  });

  it("releases a failed transfer write so the same ticket can be retried", async () => {
    const runtime = createSyntheticRuntime();
    const originalWrite = runtime.ports.artifacts.writeUpload.bind(runtime.ports.artifacts);
    let writeCalls = 0;
    runtime.ports.artifacts.writeUpload = async (sessionId, body) => {
      writeCalls += 1;
      if (writeCalls === 1) throw new Error("transient artifact storage failure");
      return originalWrite(sessionId, body);
    };
    const app = await createApp({
      demo: true,
      runtime,
      publicBaseUrl: "https://configured-maker.example:8792",
      auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("transfer-write-retry-token", ["read", "write"])] },
      logger: false,
    });
    try {
      const headers = { authorization: "Bearer transfer-write-retry-token" };
      const body = Buffer.from("transfer-write-retry");
      const sha256 = createHash("sha256").update(body).digest("hex");
      const begin = await app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload: { jsonrpc: "2.0", id: "begin-write-retry", method: "tools/call", params: { name: "begin_artifact_upload", arguments: { projectId: "synthetic-project-lamp", filename: "retry.step", role: "step", mediaType: "model/step", byteLength: body.byteLength, sha256 } } } });
      expect(begin.statusCode).toBe(200);
      const ticket = begin.json<{ result: { structuredContent: { uploadUrl: string; requiredHeaders: Record<string, string> } } }>().result.structuredContent;
      const uploadPath = new URL(ticket.uploadUrl).pathname;
      const transferHeaders = { ...ticket.requiredHeaders, "content-type": "model/step" };

      const failed = await app.inject({ method: "PUT", url: uploadPath, headers: transferHeaders, payload: body });
      expect(failed.statusCode).toBe(500);
      const retried = await app.inject({ method: "PUT", url: uploadPath, headers: transferHeaders, payload: body });
      expect(retried.statusCode).toBe(200);
      expect(writeCalls).toBe(2);
      const reused = await app.inject({ method: "PUT", url: uploadPath, headers: transferHeaders, payload: body });
      expect(reused.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
