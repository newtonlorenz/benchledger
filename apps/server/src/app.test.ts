import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createApp, bearerRecord } from "./app.js";
import { ArtifactTransferManager, TRANSFER_TOKEN_HEADER } from "./artifact-transfer.js";
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
  it("exposes project setup preview and commit through the same application service", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const proposal = {
      project: { id: "http-setup-project", name: "HTTP setup project", status: "planned" },
      revision: { id: "http-setup-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "requirement", id: "http-setup-line", name: "Unresolved requirement", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
      reservations: []
    };
    const previewResponse = await app.inject({ method: "POST", url: "/api/v1/project-setup/previews", headers: { cookie, "x-csrf-token": csrf }, payload: proposal });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json<{ id: string; version: number; contentSha256: string }>();
    const bodyWithPathIdentity = await app.inject({ method: "POST", url: `/api/v1/project-setup/previews/${preview.id}/commit`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "http-setup-body-id" }, payload: { previewId: "wrong-preview", expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: false } });
    expect(bodyWithPathIdentity.statusCode).toBe(400);
    const commitResponse = await app.inject({ method: "POST", url: `/api/v1/project-setup/previews/${preview.id}/commit`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "http-setup-commit" }, payload: { expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: false } });
    expect(commitResponse.statusCode).toBe(200);
    expect(commitResponse.json()).toMatchObject({ data: { project: { id: "http-setup-project" }, auditIds: [expect.any(String)] } });
    await app.close();
  });

  it("serves the inspection queue through list/read/preview/commit routes with scoped access and safe retries", async () => {
    const runtime = createSyntheticRuntime();
    const app = await createApp({
      demo: true,
      runtime,
      auth: {
        sessionSecret: "s".repeat(48),
        secureCookies: false,
        bearerTokens: [bearerRecord("wrong-inspection-project-token", ["read", "write"], ["other-project"])],
      },
      logger: false,
    });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
      expect(login.statusCode).toBe(200);
      const cookie = cookieHeader(login.headers["set-cookie"]);
      const csrf = login.json<{ csrfToken: string }>().csrfToken;
      const headers = { cookie, "x-csrf-token": csrf };
      const base = "/api/v1/project-revisions/synthetic-revision-lamp-r01/inspections";

      const listed = await app.inject({ method: "GET", url: `${base}?limit=1`, headers: { cookie } });
      expect(listed.statusCode).toBe(200);
      const action = listed.json<{ data: Array<{ id: string; kind: string; candidate: { id: string } }>; revisionId: string }>().data[0];
      expect(action).toMatchObject({ kind: "physical_quantity", candidate: { id: "wire-dupont" } });
      expect(listed.json()).toMatchObject({ revisionId: "synthetic-revision-lamp-r01", limit: 1, total: 1 });

      const read = await app.inject({ method: "GET", url: `${base}/${action?.id}`, headers: { cookie } });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ id: action?.id, projectRevisionId: "synthetic-revision-lamp-r01" });
      expect((await app.inject({ method: "GET", url: `${base}/missing-inspection`, headers: { cookie } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `${base}?limit=0`, headers: { cookie } })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: `${base}?cursor=${"c".repeat(513)}`, headers: { cookie } })).statusCode).toBe(400);

      const wrongProject = await app.inject({ method: "GET", url: base, headers: { authorization: "Bearer wrong-inspection-project-token" } });
      expect(wrongProject.statusCode).toBe(403);

      const actionId = action?.id;
      if (actionId === undefined) throw new Error("expected a synthetic inspection action");
      const stalePreviewResponse = await app.inject({
        method: "POST",
        url: `${base}/${actionId}/completion-preview`,
        headers,
        payload: { result: "confirmed", quantity: 2, unit: "set", source: "physical count", observedAt: "2026-09-02T01:00:00.000Z" },
      });
      expect(stalePreviewResponse.statusCode).toBe(201);
      const stalePreview = stalePreviewResponse.json<{ id: string; version: number; contentSha256: string }>();
      await runtime.inventory.updateItem("wire-dupont", { name: "Wire assortment (updated)" }, 1);
      const staleCommit = await app.inject({
        method: "POST",
        url: `${base}/${actionId}/completion-commit`,
        headers: { ...headers, "idempotency-key": "inspection-stale-commit" },
        payload: { previewId: stalePreview.id, expectedPreviewVersion: stalePreview.version, contentSha256: stalePreview.contentSha256, confirmed: true },
      });
      expect(staleCommit.statusCode).toBe(409);
      expect(staleCommit.json()).toMatchObject({ error: { code: "conflict", details: { reason: "stale_basis" } } });

      const previewResponse = await app.inject({
        method: "POST",
        url: `${base}/${actionId}/completion-preview`,
        headers,
        payload: { result: "inconclusive", source: "physical inspection", observedAt: "2026-09-02T02:00:00.000Z", note: "Count was inconclusive." },
      });
      expect(previewResponse.statusCode).toBe(201);
      const preview = previewResponse.json<{ id: string; version: number; contentSha256: string }>();

      const missingKey = await app.inject({ method: "POST", url: `${base}/${actionId}/completion-commit`, headers, payload: { previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmed: true } });
      expect(missingKey.statusCode).toBe(400);
      const unconfirmed = await app.inject({ method: "POST", url: `${base}/${actionId}/completion-commit`, headers: { ...headers, "idempotency-key": "inspection-unconfirmed" }, payload: { previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmed: false } });
      expect(unconfirmed.statusCode).toBe(400);

      const committed = await app.inject({ method: "POST", url: `${base}/${actionId}/completion-commit`, headers: { ...headers, "idempotency-key": "inspection-inconclusive" }, payload: { previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmed: true } });
      expect(committed.statusCode).toBe(200);
      expect(committed.json()).toMatchObject({ replayed: false, data: { status: "committed", evidence: { result: "inconclusive", actionId } } });
      const retry = await app.inject({ method: "POST", url: `${base}/${actionId}/completion-commit`, headers: { ...headers, "idempotency-key": "inspection-inconclusive" }, payload: { previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmed: true } });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ replayed: true, data: { status: "committed", evidence: { result: "inconclusive", actionId } } });
    } finally {
      await app.close();
    }
  });

  it("seeds the synthetic runtime with a project, revision, and planning BOM", async () => {
    const runtime = createSyntheticRuntime();
    const projects = await runtime.ports.projects.listProjects({ limit: 50 });
    const project = projects.data.find((candidate) => candidate.id === "synthetic-project-lamp");
    expect(project).toMatchObject({ currentRevisionId: "synthetic-revision-lamp-r01", status: "planned" });
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

  it("keeps synthetic category ordering aligned with persisted binary keys", async () => {
    const runtime = createSyntheticRuntime();
    await runtime.inventoryCategories.createCategory({ id: "category-demo-zebra", name: "Zebra", sortOrder: 100 });
    await runtime.inventoryCategories.createCategory({ id: "category-demo-eclair", name: "Éclair", sortOrder: 100 });
    await runtime.inventoryCategories.createCategory({ id: "category-demo-cafe", name: "Café", sortOrder: 101 });
    expect(() => runtime.inventoryCategories.createCategory({ id: "category-demo-cafe-composed", name: "Cafe\u0301", sortOrder: 102 })).toThrow(/already exists|category/i);
    const page = await runtime.inventoryCategories.listCategories({ limit: 200, includeArchived: false });
    expect(page.data.filter((value) => value.sortOrder === 100).map((value) => value.id)).toEqual(["category-demo-zebra", "category-demo-eclair"]);
  });

  it("uses canonical category cursors and rejects malformed cursors in the synthetic runtime", async () => {
    const runtime = createSyntheticRuntime();
    const firstId = "category-" + "a".repeat(151);
    const secondId = "category-" + "b".repeat(151);
    await runtime.inventoryCategories.createCategory({ id: firstId, name: "ﬃ".repeat(120), sortOrder: 0 });
    await runtime.inventoryCategories.createCategory({ id: secondId, name: "G".repeat(120), sortOrder: 0 });

    const first = await runtime.inventoryCategories.listCategories({ limit: 1, includeArchived: false });
    expect(first.data[0]?.id).toBe(firstId);
    expect(first.nextCursor).toBe(Buffer.from(firstId, "utf8").toString("base64url"));
    expect(first.nextCursor?.length).toBeGreaterThan(200);
    const cursor = first.nextCursor;
    if (cursor === undefined) throw new Error("expected a continuation cursor");
    expect((await runtime.inventoryCategories.listCategories({ limit: 1, includeArchived: false, cursor })).data[0]?.id).toBe(secondId);
    expect(() => runtime.inventoryCategories.listCategories({ limit: 1, includeArchived: false, cursor: "1" })).toThrow(/invalid/i);
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

  it("supports managed category CRUD over HTTP with immutable parentage and dedicated archive", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const headers = { cookie, "x-csrf-token": csrf };
    const created = await app.inject({ method: "POST", url: "/api/v1/inventory/categories", headers: { ...headers, "idempotency-key": "http-category-1" }, payload: { id: "http-category", name: "HTTP category", sortOrder: 10 } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ data: { id: "http-category", archived: false, version: 1 } });
    const child = await app.inject({ method: "POST", url: "/api/v1/inventory/categories", headers: { ...headers, "idempotency-key": "http-category-child-1" }, payload: { id: "http-category-child", name: "HTTP child", parentId: "http-category" } });
    expect(child.statusCode).toBe(201);
    const listed = await app.inject({ method: "GET", url: "/api/v1/inventory/categories?limit=200", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ data: Array<{ id: string }> }>().data.some((value) => value.id === "http-category")).toBe(true);
    const missingVersion = await app.inject({ method: "PATCH", url: "/api/v1/inventory/categories/http-category-child", headers, payload: { name: "Should not update" } });
    expect(missingVersion.statusCode).toBe(400);
    const emptyPatch = await app.inject({ method: "PATCH", url: "/api/v1/inventory/categories/http-category-child", headers: { ...headers, "if-match": "1" }, payload: {} });
    expect(emptyPatch.statusCode).toBe(400);
    const renamed = await app.inject({ method: "PATCH", url: "/api/v1/inventory/categories/http-category-child", headers: { ...headers, "if-match": "1" }, payload: { name: "Renamed child", sortOrder: 2 } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ data: { name: "Renamed child", parentId: "http-category", version: 2 } });
    const blockedParentArchive = await app.inject({ method: "POST", url: "/api/v1/inventory/categories/http-category/archive", headers: { ...headers, "if-match": "1" } });
    expect(blockedParentArchive.statusCode).toBe(409);
    const archivedChild = await app.inject({ method: "POST", url: "/api/v1/inventory/categories/http-category-child/archive", headers: { ...headers, "if-match": "2" } });
    expect(archivedChild.statusCode).toBe(200);
    const archivedParent = await app.inject({ method: "POST", url: "/api/v1/inventory/categories/http-category/archive", headers: { ...headers, "if-match": "1" } });
    expect(archivedParent.statusCode).toBe(200);
    const archivedList = await app.inject({ method: "GET", url: "/api/v1/inventory/categories?includeArchived=true&limit=200", headers });
    expect(archivedList.json<{ data: Array<{ id: string; archived: boolean }> }>().data.find((value) => value.id === "http-category")?.archived).toBe(true);
    for (const cursor of ["malformed", "1"]) {
      const malformedCursor = await app.inject({ method: "GET", url: `/api/v1/inventory/categories?cursor=${cursor}`, headers });
      expect(malformedCursor.statusCode).toBe(400);
    }
    await app.close();
  });

  it("pages inventory after server-side filtering and rejects invalid cursors", async () => {
    const { app, cookie } = await loggedIn();
    const first = await app.inject({ method: "GET", url: "/api/v1/inventory?limit=1", headers: { cookie } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ data: [{ id: "printer-h2d" }], limit: 1, total: 4, nextCursor: "1" });
    const second = await app.inject({ method: "GET", url: `/api/v1/inventory?limit=1&cursor=${encodeURIComponent(first.json<{ nextCursor: string }>().nextCursor)}`, headers: { cookie } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ data: [{ id: "filament-petg-hf" }], limit: 1, total: 4, nextCursor: "2" });
    const filtered = await app.inject({ method: "GET", url: "/api/v1/inventory?q=ESP32&kind=electronic&limit=1", headers: { cookie } });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({ data: [{ id: "board-esp32" }], total: 1 });
    for (const cursor of ["-1", "not-a-cursor", "9007199254740992"]) {
      const invalid = await app.inject({ method: "GET", url: `/api/v1/inventory?limit=1&cursor=${encodeURIComponent(cursor)}`, headers: { cookie } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: "invalid_cursor" } });
    }
    await app.close();
  });

  it("binds category If-Match versions into REST idempotency fingerprints", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const baseHeaders = { cookie, "x-csrf-token": csrf };
    const create = await app.inject({ method: "POST", url: "/api/v1/inventory/categories", headers: { ...baseHeaders, "idempotency-key": "http-category-fingerprint-create" }, payload: { id: "http-category-fingerprint", name: "Fingerprint category" } });
    expect(create.statusCode).toBe(201);

    const updateHeaders = { ...baseHeaders, "if-match": "1", "idempotency-key": "http-category-fingerprint-update" };
    const firstUpdate = await app.inject({ method: "PATCH", url: "/api/v1/inventory/categories/http-category-fingerprint", headers: updateHeaders, payload: { name: "Updated once" } });
    expect(firstUpdate.statusCode).toBe(200);
    const replayUpdate = await app.inject({ method: "PATCH", url: "/api/v1/inventory/categories/http-category-fingerprint", headers: updateHeaders, payload: { name: "Updated once" } });
    expect(replayUpdate.statusCode).toBe(200);
    expect(replayUpdate.json()).toMatchObject({ replayed: true, data: { version: 2 } });
    const changedVersionUpdate = await app.inject({ method: "PATCH", url: "/api/v1/inventory/categories/http-category-fingerprint", headers: { ...updateHeaders, "if-match": "2" }, payload: { name: "Updated once" } });
    expect(changedVersionUpdate.statusCode).toBe(409);
    expect(changedVersionUpdate.json()).toMatchObject({ error: { code: "idempotency_conflict" } });

    const archiveCreate = await app.inject({ method: "POST", url: "/api/v1/inventory/categories", headers: { ...baseHeaders, "idempotency-key": "http-category-fingerprint-archive-create" }, payload: { id: "http-category-fingerprint-archive", name: "Archive fingerprint category" } });
    expect(archiveCreate.statusCode).toBe(201);
    const archiveHeaders = { ...baseHeaders, "if-match": "1", "idempotency-key": "http-category-fingerprint-archive" };
    const firstArchive = await app.inject({ method: "POST", url: "/api/v1/inventory/categories/http-category-fingerprint-archive/archive", headers: archiveHeaders });
    expect(firstArchive.statusCode).toBe(200);
    const replayArchive = await app.inject({ method: "POST", url: "/api/v1/inventory/categories/http-category-fingerprint-archive/archive", headers: archiveHeaders });
    expect(replayArchive.statusCode).toBe(200);
    expect(replayArchive.json()).toMatchObject({ replayed: true, data: { version: 2 } });
    const changedVersionArchive = await app.inject({ method: "POST", url: "/api/v1/inventory/categories/http-category-fingerprint-archive/archive", headers: { ...archiveHeaders, "if-match": "2" } });
    expect(changedVersionArchive.statusCode).toBe(409);
    expect(changedVersionArchive.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    await app.close();
  });

  it("accepts exact plain, quoted, and weak If-Match versions and rejects malformed syntax", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const baseHeaders = { cookie, "x-csrf-token": csrf };
    const create = await app.inject({ method: "POST", url: "/api/v1/inventory/categories", headers: { ...baseHeaders, "idempotency-key": "http-category-version-create" }, payload: { id: "http-category-version", name: "Version syntax category" } });
    expect(create.statusCode).toBe(201);
    const update = async (header: string, name: string) => app.inject({ method: "PATCH", url: "/api/v1/inventory/categories/http-category-version", headers: { ...baseHeaders, "if-match": header }, payload: { name } });
    expect((await update("1", "Plain version")).statusCode).toBe(200);
    expect((await update('"2"', "Quoted version")).statusCode).toBe(200);
    expect((await update('W/"3"', "Weak quoted version")).statusCode).toBe(200);
    for (const header of ["1.5", "1junk", '"1.5"', 'W/"1junk"', "W/3", '"1', "0", "1e2"]) {
      expect((await update(header, "Rejected version")).statusCode).toBe(400);
    }
    await app.close();
  });

  it("continues a worst-case production category cursor over HTTP", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-category-cursor-"));
    try {
      const app = await createApp({ dataDir, publicBaseUrl: "http://127.0.0.1:8792", auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("category-cursor-token", ["read", "write"])] }, logger: false });
      const headers = { authorization: "Bearer category-cursor-token" };
      const firstId = "category-" + "a".repeat(151);
      const secondId = "category-" + "b".repeat(151);
      for (const [id, name, key] of [[firstId, "ﬃ".repeat(120), "long-category-a"], [secondId, "G".repeat(120), "long-category-b"]] as const) {
        const created = await app.inject({ method: "POST", url: "/api/v1/inventory/categories", headers: { ...headers, "idempotency-key": key }, payload: { id, name, sortOrder: 0 } });
        expect(created.statusCode).toBe(201);
      }
      const first = await app.inject({ method: "GET", url: "/api/v1/inventory/categories?limit=1", headers });
      expect(first.statusCode).toBe(200);
      const firstPage = first.json<{ data: Array<{ id: string }>; nextCursor?: string }>();
      expect(firstPage.data[0]?.id).toBe(firstId);
      expect(firstPage.nextCursor).toBeDefined();
      expect(firstPage.nextCursor?.length).toBeGreaterThan(200);
      const cursor = firstPage.nextCursor;
      if (cursor === undefined) throw new Error("expected a continuation cursor");
      const second = await app.inject({ method: "GET", url: `/api/v1/inventory/categories?limit=1&cursor=${encodeURIComponent(cursor)}`, headers });
      expect(second.statusCode).toBe(200);
      expect(second.json<{ data: Array<{ id: string }> }>().data[0]?.id).toBe(secondId);
      await app.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
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
    const first = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { ...sharedHeaders, authorization: "Bearer actor-first-token" }, payload: { id: "token-project-first", name: "First token project", status: "planned" } });
    const second = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { ...sharedHeaders, authorization: "Bearer actor-second-token" }, payload: { id: "token-project-second", name: "Second token project", status: "planned" } });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ replayed: false, data: { id: "token-project-first" } });
    expect(second.json()).toMatchObject({ replayed: false, data: { id: "token-project-second" } });

    const replay = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { ...sharedHeaders, authorization: "Bearer actor-first-token" }, payload: { id: "token-project-first", name: "First token project", status: "planned" } });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ replayed: true, data: { id: "token-project-first" } });
    const auditActors = (await runtime.ports.audit.list(50)).data.filter((event) => event.action === "project.create").map((event) => event.actor);
    expect(auditActors).toEqual(expect.arrayContaining(["mcp-token:cad-agent", "mcp-token:inventory-agent"]));
    await app.close();
  });

  it("removes a project with exact confirmation, optimistic concurrency, idempotent replay, and retained history", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const headers = { cookie, "x-csrf-token": csrf };
    const created = await app.inject({ method: "POST", url: "/api/v1/projects", headers, payload: { id: "http-project-removal", name: "HTTP removal fixture", status: "planned" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ data: { id: "http-project-removal", version: 1 } });

    const missingVersion = await app.inject({ method: "DELETE", url: "/api/v1/projects/http-project-removal", headers: { ...headers, "idempotency-key": "http-project-remove-no-version" }, payload: { name: "HTTP removal fixture" } });
    expect(missingVersion.statusCode).toBe(400);
    const wrongName = await app.inject({ method: "DELETE", url: "/api/v1/projects/http-project-removal", headers: { ...headers, "if-match": "1", "idempotency-key": "http-project-remove-wrong-name" }, payload: { name: "http removal fixture" } });
    expect(wrongName.statusCode).toBe(409);

    const removeHeaders = { ...headers, "if-match": "1", "idempotency-key": "http-project-remove" };
    const removed = await app.inject({ method: "DELETE", url: "/api/v1/projects/http-project-removal", headers: removeHeaders, payload: { name: "HTTP removal fixture" } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ replayed: false, data: { id: "http-project-removal", name: "HTTP removal fixture", lastLifecycleStatus: "planned", releasedReservationIds: [], version: 2 }, audit: { action: "project.remove" } });

    const replay = await app.inject({ method: "DELETE", url: "/api/v1/projects/http-project-removal", headers: removeHeaders, payload: { name: "HTTP removal fixture" } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, data: { id: "http-project-removal", version: 2 }, audit: { action: "project.remove" } });
    expect((await app.inject({ method: "GET", url: "/api/v1/projects/http-project-removal", headers })).statusCode).toBe(410);
    expect((await app.inject({ method: "GET", url: "/api/v1/projects", headers })).json<{ data: Array<{ id: string }> }>().data.some((entry) => entry.id === "http-project-removal")).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/v1/projects/removed?limit=10", headers })).json<{ data: Array<{ id: string; name: string }> }>().data).toEqual(expect.arrayContaining([expect.objectContaining({ id: "http-project-removal", name: "HTTP removal fixture" })]));
    const history = await app.inject({ method: "GET", url: "/api/v1/projects/http-project-removal/removed-history", headers });
    expect(history.statusCode).toBe(200);
    expect(history.json<{ data: Array<{ action: string; entityId: string }> }>().data).toEqual(expect.arrayContaining([expect.objectContaining({ action: "project.remove", entityId: "http-project-removal" })]));
    await app.close();
  });

  it("evaluates confirmed and inspect-first BOM stock", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const project = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie, "x-csrf-token": csrf }, payload: { name: "Demo build", status: "planned" } });
    const projectId = project.json<{ data: { id: string } }>().data.id;
    const revision = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/revisions`, headers: { cookie, "x-csrf-token": csrf }, payload: { name: "Initial", status: "concept" } });
    const revisionId = revision.json<{ data: { id: string } }>().data.id;
    const line = await app.inject({ method: "POST", url: `/api/v1/project-revisions/${revisionId}/bom`, headers: { cookie, "x-csrf-token": csrf }, payload: { name: "ESP32", itemId: "board-esp32", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} } });
    expect(line.statusCode).toBe(201);
    const lineData = line.json<{ data: { id: string; version: number } }>().data;
    const undecidedPower = await app.inject({
      method: "POST",
      url: `/api/v1/project-revisions/${revisionId}/bom`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        name: "12 V power supply",
        requiredQuantity: 1,
        unit: "each",
        optional: false,
        alternatives: [],
        constraints: { specification: { status: "insufficient", missingDecisions: ["current_or_load", "connector"] } },
      },
    });
    expect(undecidedPower.statusCode).toBe(201);
    const undecidedPowerId = undecidedPower.json<{ data: { id: string } }>().data.id;
    const gaps = await app.inject({ method: "GET", url: `/api/v1/project-revisions/${revisionId}/gaps`, headers: { cookie } });
    expect(gaps.statusCode).toBe(200);
    const gapBody = gaps.json<{ lines: Array<{ lineId: string; status: string; decision?: string; missingDecisions?: string[]; reasons: string[] }>; totals: Record<string, number> }>();
    expect(gapBody.lines.find((gap) => gap.lineId === lineData.id)?.status).toBe("supplied");
    expect(gapBody.lines.find((gap) => gap.lineId === undecidedPowerId)).toMatchObject({
      status: "specify_first",
      decision: "decide",
      missingDecisions: ["current_or_load", "connector"],
    });
    expect(gapBody.lines.find((gap) => gap.lineId === undecidedPowerId)?.reasons).not.toContain("No confirmed stock covers the remaining quantity.");
    expect(gapBody.totals).toMatchObject({ requiredLines: 2, readyLines: 1, checkLines: 0, decideLines: 1, sourceLines: 0, optionalLines: 0 });
    const retired = await app.inject({ method: "DELETE", url: `/api/v1/bom-lines/${lineData.id}`, headers: { cookie, "x-csrf-token": csrf, "if-match": String(lineData.version) } });
    expect(retired.statusCode).toBe(200);
    expect(retired.json()).toMatchObject({ data: { id: lineData.id, optional: false, version: 2 }, audit: { action: "project.bom_line.retire" } });
    expect(retired.json<{ data: { retiredAt?: string } }>().data.retiredAt).toBeDefined();
    expect((await app.inject({ method: "GET", url: `/api/v1/project-revisions/${revisionId}/bom`, headers: { cookie } })).json()).toEqual([expect.objectContaining({ id: undecidedPowerId })]);
    const allLines = (await app.inject({ method: "GET", url: `/api/v1/project-revisions/${revisionId}/bom?includeRetired=true`, headers: { cookie } })).json<unknown[]>();
    expect(allLines).toHaveLength(2);
    expect(allLines).toEqual(expect.arrayContaining([expect.objectContaining({ id: lineData.id, retiredAt: expect.any(String) }), expect.objectContaining({ id: undecidedPowerId })]));
    const restored = await app.inject({ method: "POST", url: `/api/v1/bom-lines/${lineData.id}/restore`, headers: { cookie, "x-csrf-token": csrf, "if-match": "2" } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ data: { id: lineData.id, optional: false, version: 3 }, audit: { action: "project.bom_line.restore" } });
    expect(restored.json<{ data: Record<string, unknown> }>().data).not.toHaveProperty("retiredAt");
    await app.close();
  });

  it("records reviewed project usage through the project revision route", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const project = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie, "x-csrf-token": csrf }, payload: { name: "Usage review", status: "planned" } });
    const projectId = project.json<{ data: { id: string } }>().data.id;
    const revision = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/revisions`, headers: { cookie, "x-csrf-token": csrf }, payload: { name: "Closeout", status: "concept" } });
    const revisionId = revision.json<{ data: { id: string } }>().data.id;
    const withoutCsrf = await app.inject({ method: "POST", url: `/api/v1/project-revisions/${revisionId}/usage`, headers: { cookie }, payload: { itemId: "board-esp32", quantity: 1, unit: "each" } });
    expect(withoutCsrf.statusCode).toBe(403);

    const usage = await app.inject({ method: "POST", url: `/api/v1/project-revisions/${revisionId}/usage`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "usage-review-1" }, payload: { itemId: "board-esp32", quantity: 1, unit: "each", note: "Installed during final assembly" } });
    expect(usage.statusCode).toBe(201);
    expect(usage.json()).toMatchObject({
      data: {
        event: { type: "consume", itemId: "board-esp32", projectId, actor: "workspace-admin", source: "ui" },
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
    const project = await service.createProject({ id: "reconciliation-http-project", name: "Reconciliation HTTP", status: "planned" }, seedContext);
    const revision = await service.createProjectRevision(project.data.id, { id: "reconciliation-http-revision", name: "Initial", status: "concept" }, seedContext);
    const line = await service.createBomLine(revision.data.id, { id: "reconciliation-http-line", name: "Reconciliation board", itemId: item.data.id, requiredQuantity: 2, unit: "each", optional: false, alternatives: [], constraints: {} }, seedContext);
    const reservation = await service.createReservation(revision.data.id, { id: "reconciliation-http-reservation", lineId: line.data.id, itemId: item.data.id, quantity: 2 }, seedContext);
    const otherProject = await service.createProject({ id: "reconciliation-http-other", name: "Other project", status: "planned" }, seedContext);
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
      const existing = await runtime.ports.projects.createProject({ id: "collision-project", name: "Collision project", status: "planned" }, seedContext);
      await runtime.ports.projects.createProjectRevision(existing.id, { id: "collision-revision", name: "Existing revision", status: "concept" }, seedContext);
      const app = await createApp({ demo: true, runtime, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
      const cookie = cookieHeader(login.headers["set-cookie"]);
      const csrf = login.json<{ csrfToken: string }>().csrfToken;
      const openapi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
      expect(openapi.statusCode).toBe(200);
      const document = openapi.json<{ paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } }>();
      expect(document.paths["/projects/with-initial-revision"]).toBeDefined();
      expect(document.paths["/projects/with-initial-revision"]).toMatchObject({
        post: {
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/CreateProjectWithInitialRevision" } } } },
          responses: { "409": { description: expect.stringMatching(/project ID|revision ID|name|idempotency/i), content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } } }
        }
      });
      expect(document.paths["/project-setup/previews/{id}/commit"]).toMatchObject({
        post: {
          parameters: expect.arrayContaining([expect.objectContaining({ name: "id", in: "path", required: true })]),
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/CommitProjectSetup" } } } }
        }
      });
      expect(document.components.schemas.CommitProjectSetup).toMatchObject({ required: ["expectedPreviewVersion", "contentSha256", "confirmReservations"], additionalProperties: false });
      expect((document.components.schemas.CommitProjectSetup as { properties?: Record<string, unknown> }).properties?.previewId).toBeUndefined();
      expect(document.components.schemas.ProjectCreationConflictDetails).toMatchObject({
        required: ["reason", "field", "id", "retryable", "commitState"],
        additionalProperties: false
      });
      expect(document.paths["/inventory/with-product-profile"]).toMatchObject({ post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/CreateInventoryWithProductProfile" } } } } } });
      expect(document.components.schemas.ArtifactScope).toMatchObject({ oneOf: expect.arrayContaining([
        expect.objectContaining({ required: ["projectRevisionId"], additionalProperties: false }),
        expect.objectContaining({ required: ["workItemId", "workItemRevisionId"], additionalProperties: false })
      ]) });
      expect(document.components.schemas.BeginUpload).toMatchObject({ oneOf: expect.any(Array) });
      expect(document.paths["/projects/{id}/artifacts"]).toMatchObject({ get: { parameters: expect.arrayContaining([expect.objectContaining({ name: "projectRevisionId", in: "query" }), expect.objectContaining({ name: "workItemRevisionId", in: "query" })]) } });
      expect(document.paths["/artifacts/uploads"]).toMatchObject({ post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/BeginUpload" } } } } } });
      expect(document.components.schemas.CreateInventoryWithProductProfile).toMatchObject({ required: ["item", "profile"], additionalProperties: false });
      expect(document.components.schemas.CreateInventoryCategory).toMatchObject({ required: ["name"], additionalProperties: false });
      expect(document.components.schemas.UpdateInventoryCategory).toMatchObject({ minProperties: 1, additionalProperties: false });
      expect(JSON.stringify(document.paths["/inventory/categories"])).toContain('"maxLength":512');
      expect(document.paths["/inventory/categories/{id}"]).toMatchObject({ patch: { parameters: [{ name: "If-Match", in: "header", required: true }] } });
      expect(document.paths["/bom-lines/{id}"]).toMatchObject({ delete: { parameters: [{ name: "If-Match", in: "header", required: true }], responses: { "400": expect.any(Object), "409": expect.any(Object) } } });
      expect(document.paths["/bom-lines/{id}/restore"]).toMatchObject({ post: { parameters: [{ name: "If-Match", in: "header", required: true }], responses: { "400": expect.any(Object), "409": expect.any(Object) } } });
      const inventoryGet = (document.paths["/inventory"] as { get: { description?: string; parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; schema: Record<string, unknown> }>; responses: Record<string, unknown> } }).get;
      expect(inventoryGet).toMatchObject({
        responses: { "200": { description: "Inventory page" } },
        parameters: [
          { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 200 } },
          { name: "kind", in: "query", required: false, schema: { type: "string", enum: ["printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"] } },
          { name: "evidence", in: "query", required: false, schema: { type: "string", enum: ["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"] } },
          { name: "available", in: "query", required: false, schema: { type: "boolean" } },
          { name: "includeRetired", in: "query", required: false, schema: { type: "boolean", default: false } },
          { name: "categoryNodeId", in: "query", required: false, schema: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" } },
          { name: "unassigned", in: "query", required: false, schema: { type: "boolean" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 200 } }
        ]
      });
      expect(inventoryGet.description).toMatch(/categoryNodeId and unassigned=true are mutually exclusive/i);
      expect(document).toMatchObject({ security: [{ bearerAuth: [] }, { cookieAuth: [] }] });
      expect(document.paths["/inventory/bulk"]).toMatchObject({
        patch: {
          parameters: [expect.objectContaining({
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 8, maxLength: 200 }
          })]
        }
      });
      expect(document.paths["/mcp"]).toMatchObject({ post: { security: [{ bearerAuth: [] }] } });
      expect(document.paths["/auth/access"]).toMatchObject({
        patch: {
          security: [{ cookieAuth: [] }],
          parameters: expect.arrayContaining([expect.objectContaining({ in: "header", name: "If-Match", required: false })]),
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  oneOf: expect.arrayContaining([
                    expect.objectContaining({ required: ["operation", "newPassword", "expectedVersion"] }),
                    expect.objectContaining({ required: ["operation", "currentPassword", "expectedVersion"] }),
                    expect.objectContaining({ required: ["operation", "currentPassword", "newPassword", "expectedVersion"] }),
                  ]),
                },
              },
            },
          },
        },
      });
      expect(document.paths["/auth/security"]).toMatchObject({ post: { security: [{ cookieAuth: [] }] } });
      const payload = {
        project: { id: "atomic-project", name: "Atomic project", description: "One command", status: "planned" },
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
        project: { id: "orphan-project", name: "Must not remain", status: "planned" },
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
    const response = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers: { cookie, "x-csrf-token": csrf }, payload: { projectId: "synthetic-project-lamp", projectRevisionId: "synthetic-revision-lamp-r01", role: "cad_source", filename: "../secret.step", mediaType: "model/step", byteSize: 1, sha256: createHash("sha256").update("x").digest("hex") } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("requires one exact revision scope for every HTTP artifact upload", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const headers = { cookie, "x-csrf-token": csrf };
    const common = { projectId: "synthetic-project-lamp", role: "step", filename: "strict.step", mediaType: "model/step", byteSize: 1, sha256: "a".repeat(64) };
    for (const payload of [
      common,
      { ...common, revisionId: "synthetic-revision-lamp-r01" },
      { ...common, projectRevisionId: "synthetic-revision-lamp-r01", workItemId: "work-1", workItemRevisionId: "work-revision-1" },
      { ...common, workItemId: "work-1" },
      { ...common, projectRevisionId: "synthetic-revision-lamp-r01", workItemId: "work-1" },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers, payload });
      expect(response.statusCode).toBe(400);
    }
    const valid = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers, payload: { ...common, projectRevisionId: "synthetic-revision-lamp-r01" } });
    expect(valid.statusCode).toBe(201);
    await app.close();
  });

  it("supports the authenticated browser upload, finalize, and download round trip", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const body = Buffer.from("authenticated-browser-transfer");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const input = {
      projectId: "synthetic-project-lamp",
      projectRevisionId: "synthetic-revision-lamp-r01",
      role: "step",
      filename: "browser-source.step",
      mediaType: "model/step",
      byteSize: body.byteLength,
      sha256,
    } as const;
    const begin = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers: { cookie, "x-csrf-token": csrf }, payload: input });
    expect(begin.statusCode).toBe(201);
    const uploadId = begin.json<{ data: { id: string; status: string } }>().data.id;
    expect(begin.json()).toMatchObject({ data: { id: uploadId, status: "pending" } });

    const write = await app.inject({ method: "PUT", url: `/api/v1/artifacts/uploads/${uploadId}`, headers: { cookie, "x-csrf-token": csrf, "content-type": "application/octet-stream" }, payload: body });
    expect(write.statusCode).toBe(200);
    expect(write.json()).toEqual({ receivedBytes: body.byteLength });
    const finalized = await app.inject({ method: "POST", url: `/api/v1/artifacts/uploads/${uploadId}/finalize`, headers: { cookie, "x-csrf-token": csrf } });
    expect(finalized.statusCode).toBe(200);
    const artifactId = finalized.json<{ data: { id: string; sha256: string } }>().data.id;
    expect(finalized.json()).toMatchObject({ data: { id: artifactId, sha256 } });

    const downloaded = await app.inject({ method: "GET", url: `/api/v1/artifacts/${artifactId}/download`, headers: { cookie } });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("model/step");
    expect(Buffer.from(downloaded.rawPayload).equals(body)).toBe(true);
    await app.close();
  });

  it("fails closed for generic MCP artifact transfer without exposing host capabilities", async () => {
    const app = await createApp({
      demo: true,
      publicBaseUrl: "https://configured-maker.example:8792",
      auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("artifact-agent-token", ["read", "write"])] },
      logger: false,
    });
    const headers = { authorization: "Bearer artifact-agent-token" };
    const body = Buffer.from("step-data");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const mcp = await app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload: { jsonrpc: "2.0", id: "begin", method: "tools/call", params: { name: "begin_artifact_upload", arguments: { projectId: "synthetic-project-lamp", projectRevisionId: "synthetic-revision-lamp-r01", filename: "source.step", role: "step", mediaType: "model/step", byteLength: body.byteLength, sha256 } } } });
    expect(mcp.statusCode).toBe(200);
    expect(mcp.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "HOST_TRANSFER_UNAVAILABLE" } } } });
    const metadata = await app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload: { jsonrpc: "2.0", id: "metadata", method: "tools/call", params: { name: "read_artifact_download_metadata", arguments: { artifactId: "synthetic-artifact-source" } } } });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "HOST_TRANSFER_UNAVAILABLE" } } } });
    expect(JSON.stringify({ mcp: mcp.json(), metadata: metadata.json() })).not.toMatch(/https:\/\/configured-maker|x-bench-transfer-token|authorization|base64/i);
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
      const begin = await app.inject({ method: "POST", url: "/api/v1/mcp", headers: bearerHeaders, payload: { jsonrpc: "2.0", id: "begin-actor-bound", method: "tools/call", params: { name: "begin_artifact_upload", arguments: { projectId: "synthetic-project-lamp", projectRevisionId: "synthetic-revision-lamp-r01", filename: "actor-bound.step", role: "step", mediaType: "model/step", byteLength: body.byteLength, sha256 } } } });
      expect(begin.statusCode).toBe(200);
      expect(begin.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "HOST_TRANSFER_UNAVAILABLE" } } } });

      const audit = await runtime.ports.audit.list(100);
      expect(audit.data.find((event) => event.action === "artifact.upload.begin")).toBeUndefined();
      expect(audit.data.find((event) => event.action === "artifact.upload.finalize")).toBeUndefined();
      expect(idempotencyActors).not.toContain("mcp-token:cad-agent:finalize-actor-1");

      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
      const cookie = cookieHeader(login.headers["set-cookie"]);
      const csrf = login.json<{ csrfToken: string }>().csrfToken;
      const uiBegin = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers: { cookie, "x-csrf-token": csrf }, payload: { projectId: "synthetic-project-lamp", projectRevisionId: "synthetic-revision-lamp-r01", filename: "ui-source.step", role: "step", mediaType: "model/step", byteSize: body.byteLength, sha256 } });
      expect(uiBegin.statusCode).toBe(201);
      const afterUiAudit = await runtime.ports.audit.list(100);
      expect(afterUiAudit.data.filter((event) => event.action === "artifact.upload.begin").slice(-1)[0]).toMatchObject({ actor: "workspace-admin", source: "ui" });
    } finally {
      await app.close();
    }
  });

  it("serves the built SPA shell and keeps MCP bearer-only", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const shell = await app.inject({ method: "GET", url: "/" });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers["content-type"]).toContain("text/html");
    const mcp = await app.inject({ method: "POST", url: "/api/v1/mcp", headers: { cookie, "x-csrf-token": csrf }, payload: {
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" }
    } });
    expect(mcp.statusCode).toBe(401);
    await app.close();
  });

  it("serves one authenticated workspace snapshot and promotes a physical count", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const workspace = await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { cookie } });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json()).toMatchObject({ source: "api", inventory: expect.any(Array), projects: expect.any(Array), offers: expect.any(Array) });
    const project = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie, "x-csrf-token": csrf }, payload: { name: "Workspace aggregate", status: "planned" } });
    const projectId = project.json<{ data: { id: string } }>().data.id;
    const revision = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/revisions`, headers: { cookie, "x-csrf-token": csrf }, payload: { name: "r01", status: "concept" } });
    const revisionId = revision.json<{ data: { id: string } }>().data.id;
    const line = await app.inject({ method: "POST", url: `/api/v1/project-revisions/${revisionId}/bom`, headers: { cookie, "x-csrf-token": csrf }, payload: { name: "ESP32", itemId: "board-esp32", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} } });
    expect(line.statusCode).toBe(201);
    const enriched = await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { cookie } });
    const aggregateProject = enriched.json<{ projects: Array<{ id: string; currentRevision?: { bom: Array<{ id: string }>; artifacts: unknown[]; gapEvaluation: { lines: Array<{ lineId: string; decision: string }>; totals: { readyLines: number } } }; bom: unknown[]; artifacts: unknown[] }> }>().projects.find((entry) => entry.id === projectId);
    expect(aggregateProject).toMatchObject({ currentRevision: { bom: [{ id: expect.any(String) }], artifacts: expect.any(Array), gapEvaluation: { lines: [{ decision: "ready" }], totals: { readyLines: 1 } } }, bom: expect.any(Array), artifacts: expect.any(Array) });
    const count = await app.inject({ method: "POST", url: "/api/v1/inventory/wire-dupont/count", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "count-wire-dupont" }, payload: { quantity: 1, note: "Counted in parts drawer" } });
    expect(count.statusCode).toBe(201);
    expect(count.json()).toMatchObject({ data: { item: { id: "wire-dupont", quantity: 1, availableQuantity: 1, evidence: { state: "physically_counted" } } } });
    await app.close();
  });

  it("exposes commissioning as a versioned append-only inventory command", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/inventory",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        id: "http-commission-item",
        name: "Delivered board",
        kind: "electronic",
        quantity: 4,
        unit: "each",
        tags: [],
        links: [],
        evidence: { state: "delivered_uncounted", source: "delivery", sourceId: "delivery-1", observedAt: "2026-08-30T10:00:00.000Z" }
      }
    });
    expect(created.statusCode).toBe(201);
    const commissioned = await app.inject({
      method: "POST",
      url: "/api/v1/inventory/http-commission-item/commission",
      headers: { cookie, "x-csrf-token": csrf, "if-match": "1", "idempotency-key": "http-commission-1" },
      payload: { quantity: 3, unit: "each", evidence: { state: "commissioned", source: "bench-test", sourceId: "check-1", observedAt: "2026-08-31T10:00:00.000Z" } }
    });
    expect(commissioned.statusCode).toBe(201);
    expect(commissioned.json()).toMatchObject({ data: { item: { quantity: 3, availableQuantity: 3, evidence: { state: "commissioned" }, version: 2 }, event: { type: "count", evidence: { state: "commissioned" } } } });
    const events = await app.inject({ method: "GET", url: "/api/v1/inventory/http-commission-item/stock-events", headers: { cookie } });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toMatchObject({ data: [{ type: "count", evidence: { state: "commissioned", previousEvidence: { state: "delivered_uncounted" } } }] });
    await app.close();
  });

  it("requires commissioning authorization, If-Match, and idempotency, then rejects stale and changed retries", async () => {
    const { app, cookie, csrf } = await loggedIn();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/inventory",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { id: "commission-contract-item", name: "Delivered connector", kind: "accessory", quantity: 4, unit: "each", tags: [], links: [], evidence: { state: "delivered_uncounted", source: "delivery" } }
    });
    expect(create.statusCode).toBe(201);
    const body = { quantity: 3, unit: "each", evidence: { state: "commissioned", source: "bench", observedAt: "2026-08-31T10:00:00.000Z" } };
    const baseHeaders = { cookie, "x-csrf-token": csrf };
    expect((await app.inject({ method: "POST", url: "/api/v1/inventory/commission-contract-item/commission", headers: baseHeaders, payload: body })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/inventory/commission-contract-item/commission", headers: { ...baseHeaders, "if-match": "1" }, payload: body })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/inventory/commission-contract-item/commission", headers: { ...baseHeaders, "idempotency-key": "commission-stale-1", "if-match": "2" }, payload: body })).statusCode).toBe(409);

    const headers = { ...baseHeaders, "if-match": "1", "idempotency-key": "commission-contract-1" };
    const first = await app.inject({ method: "POST", url: "/api/v1/inventory/commission-contract-item/commission", headers, payload: body });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ replayed: false, data: { item: { version: 2 } } });
    const replay = await app.inject({ method: "POST", url: "/api/v1/inventory/commission-contract-item/commission", headers, payload: body });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ replayed: true, data: { item: { version: 2 } } });
    const changed = await app.inject({ method: "POST", url: "/api/v1/inventory/commission-contract-item/commission", headers, payload: { ...body, quantity: 2 } });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    await app.close();

    const readOnly = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("commission-read-only", ["read"])] }, logger: false });
    const denied = await readOnly.inject({ method: "POST", url: "/api/v1/inventory/commission-contract-item/commission", headers: { authorization: "Bearer commission-read-only", "if-match": "1", "idempotency-key": "commission-read-only" }, payload: body });
    expect(denied.statusCode).toBe(403);
    await readOnly.close();
  });

  it("documents the cross-field available-quantity invariant in OpenAPI", async () => {
    const app = await createApp({ demo: true, auth: { sessionSecret: "s".repeat(48), secureCookies: false }, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(response.statusCode).toBe(200);
    const document = response.json<{ components: { schemas: { CreateInventoryItem: { properties: { availableQuantity: { description?: string } } }; }; }; paths: Record<string, any> }>();
    expect(document.components.schemas.CreateInventoryItem.properties.availableQuantity.description).toMatch(/cannot exceed quantity/i);
    expect(document.paths["/inventory/{id}/commission"]).toMatchObject({ post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/CommissionInventoryItem" } } } } } });
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
    const inventoryPage = await app.inject({ method: "GET", url: "/api/v1/inventory?kind=filament&limit=1", headers: { cookie } });
    expect(inventoryPage.statusCode).toBe(200);
    expect(inventoryPage.json()).toMatchObject({ data: [{ id: "filament-petg-hf", productProfile: { id: "profile-filament-petg-hf" }, catalogProduct: { id: "catalog-filament-petg-hf" } }], total: 1 });
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
    await runtime.ports.projects.createProject({ id: "other-snapshot-project", name: "Other snapshot project", status: "planned" }, seedContext);
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
    await runtime.ports.projects.createProject({ id: "other-revision-project", name: "Other revision project", status: "planned" }, seedContext);
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
    await runtime.ports.projects.createProject({ id: "other-create-project", name: "Other create project", status: "planned" }, seedContext);
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
    await runtime.ports.projects.createProject({ id: "other-upload-project", name: "Other upload project", status: "planned" }, seedContext);
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
        projectRevisionId: "synthetic-revision-lamp-r01",
        buildConfigurationSnapshotId,
        role: "step",
        filename: `scoped-${buildConfigurationSnapshotId}.step`,
        mediaType: "model/step",
        byteSize: 1,
        sha256: "a".repeat(64)
      });

      const crossProject = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers, payload: { ...beginUpload("cross-project-upload-snapshot"), projectRevisionId: "synthetic-revision-lamp-r01" } });
      const missing = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers, payload: { ...beginUpload("missing-upload-snapshot"), projectRevisionId: "synthetic-revision-lamp-r01" } });
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
    const inventory = await app.inject({ method: "GET", url: "/api/v1/inventory?limit=1", headers });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()).toMatchObject({ limit: 1, total: 4, nextCursor: "1", data: [{ id: "printer-h2d" }] });
    expect(inventory.json<{ data: Array<Record<string, unknown>> }>().data[0]).not.toHaveProperty("productProfile");
    expect(inventory.json<{ data: Array<Record<string, unknown>> }>().data[0]).not.toHaveProperty("catalogProduct");
    expect((await app.inject({ method: "GET", url: "/api/v1/workspace", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/projects", headers, payload: { name: "Must not create", status: "planned" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/project-revisions/not-a-visible-revision", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/inventory", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/inventory/categories", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/inventory/categories/category-tools", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/inventory/categories", headers, payload: { name: "Must not mutate" } })).statusCode).toBe(403);
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
    expect(begin.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "HOST_TRANSFER_UNAVAILABLE" } } } });
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

  it("replays a header-less MCP bulk metadata call through the application backend", async () => {
    const runtime = createSyntheticRuntime();
    const published: string[] = [];
    runtime.ports.events.subscribe((event) => { if (event.type === "inventory.item.bulk_update") published.push(event.entityId); });
    const app = await createApp({ demo: true, runtime, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("mcp-bulk-writer", ["read", "write"])] }, logger: false });
    const headers = { authorization: "Bearer mcp-bulk-writer" };
    const call = (id: string, argumentsValue: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/mcp", headers, payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "bulk_update_inventory_items", arguments: argumentsValue } } });
    const argumentsValue = {
      targets: [{ itemId: "wire-dupont", expectedVersion: 1 }, { itemId: "board-esp32", expectedVersion: 1 }],
      changes: { location: "  Bulk shelf  ", condition: "good" },
    };

    const first = await call("bulk-first", argumentsValue);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ result: { isError: false, structuredContent: {
      updated: [{ itemId: "board-esp32", version: 2 }, { itemId: "wire-dupont", version: 2 }],
      unchanged: [],
      replayed: false,
      auditIds: expect.any(Array),
      correlationId: expect.any(String),
    } } });

    const replay = await call("bulk-replay", {
      targets: [...argumentsValue.targets].reverse(),
      changes: { location: "Bulk shelf", condition: "good" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ result: { isError: false, structuredContent: {
      updated: [{ itemId: "board-esp32", version: 2 }, { itemId: "wire-dupont", version: 2 }],
      unchanged: [],
      replayed: true,
    } } });

    const changed = await call("bulk-changed", {
      ...argumentsValue,
      changes: { location: "Different shelf", condition: "good" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "CONFLICT" } } } });

    expect(published).toEqual(["board-esp32", "wire-dupont"]);
    const audits = await runtime.ports.audit.list(100);
    expect(audits.data.filter((event) => event.action === "inventory.item.bulk_update")).toHaveLength(2);
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
    const unsupported = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers: { cookie, "x-csrf-token": csrf }, payload: { projectId: "synthetic-project-lamp", projectRevisionId: "synthetic-revision-lamp-r01", filename: "bad.bin", role: "other", mediaType: "application/x-unknown", byteSize: 1, sha256: "a".repeat(64) } });
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
    await runtime.projects.createProject({ id: "scoped-second", name: "Second project", description: "Another reference project", status: "planned" });
    const app = await createApp({ demo: true, runtime, auth: { sessionSecret: "s".repeat(48), secureCookies: false, bearerTokens: [bearerRecord("scoped-query-token", ["read"], ["synthetic-project-lamp", "scoped-second", "missing-project"])] }, logger: false });
    const headers = { authorization: "Bearer scoped-query-token" };
    const descriptionMatch = await app.inject({ method: "GET", url: "/api/v1/projects?q=reference&status=planned&limit=1&cursor=bad", headers });
    expect(descriptionMatch.statusCode).toBe(200);
    expect(descriptionMatch.json<{ data: Array<{ id: string }>; total: number; nextCursor?: string }>().data.map((project) => project.id)).toEqual(["synthetic-project-lamp"]);
    expect(descriptionMatch.json()).toMatchObject({ total: 2, limit: 1, nextCursor: "1" });
    const secondPage = await app.inject({ method: "GET", url: "/api/v1/projects?q=reference&status=planned&limit=1&cursor=1", headers });
    expect(secondPage.json<{ data: Array<{ id: string }> }>().data.map((project) => project.id)).toEqual(["scoped-second"]);
    const emptyPage = await app.inject({ method: "GET", url: "/api/v1/projects?cursor=999", headers });
    expect(emptyPage.statusCode).toBe(200);
    expect(emptyPage.json()).toMatchObject({ data: [], total: 2 });
    expect((await app.inject({ method: "GET", url: "/api/v1/projects/synthetic-project-lamp", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/projects/other-project", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/projects/synthetic-project-lamp/artifacts", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/projects/synthetic-project-lamp/artifacts?projectRevisionId=synthetic-revision-lamp-r01", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/projects/synthetic-project-lamp/artifacts?workItemId=work-1", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/projects/synthetic-project-lamp/artifacts?revisionId=synthetic-revision-lamp-r01", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers, payload: { projectId: "other-project", projectRevisionId: "synthetic-revision-lamp-r01", filename: "x.step", role: "step", mediaType: "model/step", byteSize: 1, sha256: "a".repeat(64) } })).statusCode).toBe(403);
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
    // Direct transfer capabilities are host-owned. Generic MCP deliberately
    // cannot mint these credentials, so exercise the transfer state machine
    // directly rather than extracting secrets from a model result.
    let now = 1_000;
    const manager = new ArtifactTransferManager("https://configured-maker.example:8792", { clock: () => now, uploadTtlMs: 1_000 });
    const body = Buffer.from("transfer-route");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const issued = manager.issueUpload({ uploadId: "upload-route", projectId: "project-1", expiresAt: new Date(now + 500).toISOString(), byteLength: body.byteLength, sha256, actor: "agent" });
    const writeToken = issued.uploadHeaders[TRANSFER_TOKEN_HEADER];
    const finalizeToken = issued.finalizeHeaders[TRANSFER_TOKEN_HEADER];
    expect(manager.preflightUploadWrite(writeToken, "upload-route", body.byteLength)).toMatchObject({ action: "upload_write" });
    expect(() => manager.preflightUploadWrite(writeToken, "upload-route", body.byteLength + 1)).toThrow();
    expect(() => manager.validateFinalize(finalizeToken, "upload-route", { sha256: "bad", byteLength: body.byteLength })).toThrow();
    expect(manager.claimFinalize(finalizeToken, "upload-route", { sha256, byteLength: body.byteLength })).toMatchObject({ action: "upload_finalize" });
    manager.releaseFinalize(finalizeToken, "upload-route");
    expect(manager.claimFinalize(finalizeToken, "upload-route", { sha256, byteLength: body.byteLength })).toMatchObject({ action: "upload_finalize" });
    manager.commitFinalize(finalizeToken, "upload-route");
    expect(() => manager.claimFinalize(finalizeToken, "upload-route", { sha256, byteLength: body.byteLength })).toThrow();
    now = 1_600;
    expect(() => manager.preflight("upload_write", writeToken, "upload-route")).toThrow();
  });

  it("releases a failed transfer write so the same ticket can be retried", async () => {
    const manager = new ArtifactTransferManager("https://configured-maker.example:8792", { clock: () => 1_000 });
    const body = Buffer.from("transfer-write-retry");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const issued = manager.issueUpload({ uploadId: "upload-write-retry", projectId: "project-1", expiresAt: new Date(2_000).toISOString(), byteLength: body.byteLength, sha256, actor: "agent" });
    const token = issued.uploadHeaders[TRANSFER_TOKEN_HEADER];
    let writeCalls = 0;
    const write = () => {
      writeCalls += 1;
      if (writeCalls === 1) throw new Error("transient artifact storage failure");
    };
    expect(() => { manager.claimUploadWrite(token, "upload-write-retry", body); write(); }).toThrow("transient artifact storage failure");
    manager.releaseUploadWrite(token, "upload-write-retry");
    expect(() => { manager.claimUploadWrite(token, "upload-write-retry", body); write(); }).not.toThrow();
    manager.commitUploadWrite(token, "upload-write-retry");
    expect(writeCalls).toBe(2);
    expect(() => manager.claimUploadWrite(token, "upload-write-retry", body)).toThrow();
  });

  it("releases a failed route-level download read for retry, then consumes it once", async () => {
    const runtime = createSyntheticRuntime();
    const service = new ApplicationService(runtime.ports);
    const manager = new ArtifactTransferManager("https://configured-maker.example:8792");
    let readCalls = 0;
    const readArtifact = service.readArtifact.bind(service);
    service.readArtifact = async (artifactId) => {
      readCalls += 1;
      if (readCalls === 1) throw new Error("transient artifact read failure");
      return readArtifact(artifactId);
    };
    const app = await createApp({
      demo: true,
      runtime,
      service,
      artifactTransferManager: manager,
      auth: { sessionSecret: "s".repeat(48), secureCookies: false },
      logger: false,
    });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoPassword } });
      const cookie = cookieHeader(login.headers["set-cookie"]);
      const csrf = login.json<{ csrfToken: string }>().csrfToken;
      const body = Buffer.from("route-level-download");
      const sha256 = createHash("sha256").update(body).digest("hex");
      const begin = await app.inject({ method: "POST", url: "/api/v1/artifacts/uploads", headers: { cookie, "x-csrf-token": csrf }, payload: { projectId: "synthetic-project-lamp", projectRevisionId: "synthetic-revision-lamp-r01", role: "step", filename: "route-level.step", mediaType: "model/step", byteSize: body.byteLength, sha256 } });
      expect(begin.statusCode).toBe(201);
      const uploadId = begin.json<{ data: { id: string } }>().data.id;
      const write = await app.inject({ method: "PUT", url: `/api/v1/artifacts/uploads/${uploadId}`, headers: { cookie, "x-csrf-token": csrf, "content-type": "application/octet-stream" }, payload: body });
      expect(write.statusCode).toBe(200);
      const finalized = await app.inject({ method: "POST", url: `/api/v1/artifacts/uploads/${uploadId}/finalize`, headers: { cookie, "x-csrf-token": csrf } });
      expect(finalized.statusCode).toBe(200);
      const artifactId = finalized.json<{ data: { id: string } }>().data.id;
      const issued = manager.issueDownload({ artifactId, projectId: "synthetic-project-lamp", byteLength: body.byteLength, sha256, actor: "workspace-admin" });
      const token = issued.requiredHeaders[TRANSFER_TOKEN_HEADER];

      const failed = await app.inject({ method: "GET", url: `/api/v1/transfers/artifacts/${artifactId}/download`, headers: { [TRANSFER_TOKEN_HEADER]: token } });
      expect(failed.statusCode).toBe(500);
      const retried = await app.inject({ method: "GET", url: `/api/v1/transfers/artifacts/${artifactId}/download`, headers: { [TRANSFER_TOKEN_HEADER]: token } });
      expect(retried.statusCode).toBe(200);
      expect(Buffer.from(retried.rawPayload).equals(body)).toBe(true);
      const replay = await app.inject({ method: "GET", url: `/api/v1/transfers/artifacts/${artifactId}/download`, headers: { [TRANSFER_TOKEN_HEADER]: token } });
      expect(replay.statusCode).toBe(403);
      expect(readCalls).toBe(2);
    } finally {
      await app.close();
    }
  });
});
