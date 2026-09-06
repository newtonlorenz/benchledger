import { createProductionRuntime } from "@benchledger/runtime";
import { ApplicationService } from "@benchledger/application";
import { createSyntheticRuntime } from "./memory-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createApp, bearerRecord } from "./app.js";

for (const durable of [false, true]) describe(`customer correction workflows (${durable ? "SQLite" : "memory"})`, () => {
  it("lets a scoped owner correct, unlink, retire and restore a requirement without changing stock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchledger-cx-test-"));
    const projectId = "cx-test-project", revisionId = "cx-test-revision";
    const app = await createApp({ demo: !durable, ...(durable ? { dataDir: dir, publicBaseUrl: "http://127.0.0.1:8792" } : {}), logger: false,
      auth: { sessionSecret: "s".repeat(48), bearerTokens: [bearerRecord("owner", ["read", "write"]), bearerRecord("scoped", ["read", "write"], [projectId]), bearerRecord("wrong", ["read", "write"], ["other-project"]), bearerRecord("reader", ["read"], [projectId])] } });
    const headers = { authorization: "Bearer owner" };
    try {
      const created = await app.inject({ method: "POST", url: "/api/v1/projects/with-initial-revision", headers, payload: { project: { id: projectId, name: "Synthetic correction project", status: "idea" }, revision: { id: revisionId, name: "First design", status: "concept", fabricationRoute: "none" } } });
      expect(created.statusCode, created.body).toBe(201);
      const item = await app.inject({ method: "POST", url: "/api/v1/inventory", headers, payload: { id: "cx-led", name: "Café LED heat-shrink kit", manufacturer: "Maker", kind: "electronic", quantity: 2, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } } });
      expect(item.statusCode, item.body).toBe(201);
      const line = await app.inject({ method: "POST", url: `/api/v1/project-revisions/${revisionId}/bom`, headers, payload: { name: "LED for enclosure", itemId: "cx-led", role: "consumed", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] } });
      expect(line.statusCode, line.body).toBe(201);
      const id = line.json().data.id;
      const held = await app.inject({ method: "POST", url: `/api/v1/project-revisions/${revisionId}/reservations`, headers, payload: { lineId: id, itemId: "cx-led", quantity: 1 } });
      expect(held.statusCode, held.body).toBe(201);
      for (const payload of [{ itemId: null }, { requiredQuantity: 3 }, { unit: "set" }, { role: "reusable" }, { optional: true }, { constraints: { manufacturer: "Different" } }]) {
        const denied = await app.inject({ method: "PATCH", url: `/api/v1/bom-lines/${id}`, headers: { ...headers, "if-match": "1" }, payload });
        expect(denied.statusCode, JSON.stringify(payload)).toBe(409);
      }
      const release = await app.inject({ method: "POST", url: `/api/v1/reservations/${held.json().data.id}/release`, headers: { ...headers, "if-match": "1" } });
      expect(release.statusCode, release.body).toBe(200);
      const patch = (token: string, payload: object, version = 1) => app.inject({ method: "PATCH", url: `/api/v1/bom-lines/${id}`, headers: { authorization: `Bearer ${token}`, "if-match": String(version) }, payload });
      expect((await patch("wrong", { name: "Not allowed" })).statusCode).toBe(403);
      expect((await patch("reader", { name: "Not allowed" })).statusCode).toBe(403);
      const updated = await patch("scoped", { name: "Corrected LED", requiredQuantity: 2, itemId: null, notes: "Needs a different connector" });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json().data).toMatchObject({ name: "Corrected LED", requiredQuantity: 2, version: 2 });
      expect(updated.json().data.itemId).toBeUndefined();
      expect((await patch("scoped", { name: "Stale edit" })).statusCode).toBe(409);
      const retired = await app.inject({ method: "DELETE", url: `/api/v1/bom-lines/${id}`, headers: { authorization: "Bearer scoped", "if-match": "2" } });
      expect(retired.statusCode, retired.body).toBe(200);
      const restored = await app.inject({ method: "POST", url: `/api/v1/bom-lines/${id}/restore`, headers: { authorization: "Bearer scoped", "if-match": "3" } });
      expect(restored.statusCode, restored.body).toBe(200);
      expect(restored.json().data.retiredAt).toBeUndefined();
      const rpc = async (arguments_: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/mcp", headers: { authorization: "Bearer scoped" }, payload: { jsonrpc: "2.0", id: "cx-mcp", method: "tools/call", params: { name: "update_bom_line", arguments: { bomLineId: id, ...arguments_ } } } });
      expect((await rpc({ itemId: "cx-led", expectedVersion: 4 })).json().result.isError).not.toBe(true);
      const cleared = await rpc({ itemId: null, expectedVersion: 5 });
      expect(cleared.json().result.isError, cleared.body).not.toBe(true);
      const checked = await app.inject({ method: "GET", url: `/api/v1/project-revisions/${revisionId}/bom`, headers });
      expect(checked.statusCode, checked.body).toBe(200);
      expect(checked.json().find((entry: { id: string }) => entry.id === id).itemId).toBeUndefined();
      const inventory = await app.inject({ method: "GET", url: "/api/v1/inventory/cx-led", headers });
      expect(inventory.json()).toMatchObject({ quantity: 2, availableQuantity: 2 });
      const denied = await app.inject({ method: "PATCH", url: "/api/v1/bom-lines/nonexistent", headers: { authorization: "Bearer scoped", "if-match": "1" }, payload: { name: "No oracle" } });
      expect(denied.statusCode).toBe(403);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it("finds inventory with reordered words, punctuation and accents without treating search as compatibility", async () => {
    const dir = await mkdtemp(join(tmpdir(), "benchledger-cx-search-"));
    const app = await createApp({ demo: !durable, ...(durable ? { dataDir: dir, publicBaseUrl: "http://127.0.0.1:8792" } : {}), logger: false, auth: { sessionSecret: "s".repeat(48), bearerTokens: [bearerRecord("owner", ["read", "write"])] } });
    const headers = { authorization: "Bearer owner" };
    try {
      const created = await app.inject({ method: "POST", url: "/api/v1/inventory", headers, payload: { id: "cx-search-led", name: "Café heat-shrink LED kit", manufacturer: "Maker", kind: "electronic", quantity: 2, unit: "each", tags: ["red"], links: [], evidence: { state: "unknown" } } });
      expect(created.statusCode, created.body).toBe(201);
      for (const query of ["LED cafe", "heat shrink", "maker LED red", "CAFÉ kit"]) {
        const response = await app.inject({ method: "GET", url: `/api/v1/inventory?q=${encodeURIComponent(query)}`, headers });
        expect(response.statusCode).toBe(200);
        expect(response.json().data.some((item: { id: string }) => item.id === "cx-search-led"), query).toBe(true);
      }
      const item = await app.inject({ method: "GET", url: "/api/v1/inventory/cx-search-led", headers });
      expect(item.json().evidence.state).toBe("unknown");
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

for (const durable of [false, true]) it(`direct ${durable ? "SQLite" : "memory"} adapter preserves reservation assumptions`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "benchledger-cx-direct-"));
  const runtime = durable ? await createProductionRuntime({ dataDir: dir }) : createSyntheticRuntime();
  const context = { actor: "synthetic-review", source: "api" as const, correlationId: "cx-direct", scopes: new Set(["read", "write"]) };
  const service = new ApplicationService(runtime.ports);
  try {
    const item = await service.createInventoryItem({ id: "direct-stock", name: "Synthetic connector", kind: "electronic", quantity: 4, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context);
    const project = await service.createProject({ name: "Synthetic direct adapter project", status: "idea" }, context);
    const revision = await service.createProjectRevision(project.data.id, { name: "Initial", status: "concept", fabricationRoute: "none" }, context);
    const line = await service.createBomLine(revision.data.id, { name: "Connector", itemId: item.data.id, role: "consumed", requiredQuantity: 2, unit: "each", optional: false, constraints: {}, alternatives: [] }, context);
    await service.createReservation(revision.data.id, { lineId: line.data.id, itemId: item.data.id, quantity: 1 }, context);
    for (const changes of [{ itemId: null }, { requiredQuantity: 3 }, { optional: true }]) {
      await expect(Promise.resolve().then(() => runtime.ports.projects.updateBomLine(line.data.id, changes, line.data.version, context))).rejects.toMatchObject({ code: "conflict" });
    }
    await expect(runtime.ports.projects.updateBomLine(line.data.id, { notes: "A harmless descriptive correction" }, line.data.version, context)).resolves.toMatchObject({ requiredQuantity: 2, itemId: item.data.id });
  } finally { if ("close" in runtime) await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});
