import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, bearerRecord } from "./app.js";

describe("professional sourcing search", () => {
  for (const durable of [false, true]) it(`filters the complete revision before pagination (${durable ? "SQLite" : "memory"})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "benchledger-sourcing-filter-"));
    const app = await createApp({ demo: !durable, ...(durable ? { dataDir: directory, publicBaseUrl: "http://127.0.0.1:8792" } : {}), logger: false, auth: { sessionSecret: "s".repeat(48), bearerTokens: [bearerRecord("test-writer", ["read", "write"]), bearerRecord("test-reader", ["read"], ["search-project"])] } });
    let command = 0;
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object, token = "test-writer") => app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}`, "idempotency-key": `search-smoke-${++command}` }, ...(payload ? { payload } : {}) });
    const value = (response: { statusCode: number; body: string; json(): any }) => { expect(response.statusCode, response.body).toBeLessThan(300); return response.json(); };
    try {
      value(await call("POST", "/projects/with-initial-revision", { project: { id: "search-project", name: "Synthetic sourcing review", status: "planned" }, revision: { id: "search-revision", name: "Initial", status: "concept", fabricationRoute: "none" } }));
      for (let i = 0; i < 24; i++) value(await call("POST", "/project-revisions/search-revision/bom", { name: `Ordinary requirement ${i}`, requiredQuantity: 1, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [] }));
      const line = value(await call("POST", "/project-revisions/search-revision/bom", { name: "Café rear-panel connector", requiredQuantity: 8, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [] })).data;
      const root = "/projects/search-project/revisions/search-revision";
      const quote = value(await call("POST", `${root}/requirement-offers`, { bomLineId: line.id, expectedBomLineVersion: 1, supplier: "Synthetic maker supplier", title: "Six-pack connector", url: "https://supplier.example/connector", packageQuantity: 6, packageUnit: "each", priceMinor: 400, currency: "EUR", shippingMinor: 100, taxIncluded: "yes", observedAt: "2026-09-07T00:00:00Z" })).data;
      value(await call("PUT", `${root}/offer-choice`, { bomLineId: line.id, expectedBomLineVersion: 1, expectedVersion: 0, offerId: quote.id, confirmedFit: true }));
      const found = value(await call("GET", `${root}/sourcing?limit=2&filter=source&query=connector%20cafe`, undefined, "test-reader"));
      expect(found.data.map((row: any) => row.line.id)).toEqual([line.id]); expect(found.total).toBe(1); expect(found.revisionTotal).toBe(25); expect(found.nextCursor).toBeUndefined(); expect(found.totals.EUR.knownMinor).toBe(900);
      const none = value(await call("GET", `${root}/sourcing?filter=review`)); expect(none.data).toEqual([]); expect(none.totals).toEqual(found.totals);
      const rpc = value(await call("POST", "/mcp", { jsonrpc: "2.0", id: "filter-test", method: "tools/call", params: { name: "read_requirement_sourcing", arguments: { projectId: "search-project", projectRevisionId: "search-revision", query: "supplier connector", filter: "source", limit: 2 } } }, "test-reader"));
      expect(rpc.result.isError, JSON.stringify(rpc)).toBe(false); expect(rpc.result.structuredContent.data.map((row: any) => row.line.id)).toEqual([line.id]);
      expect((await call("GET", `${root}/sourcing?filter=unknown`)).statusCode).toBe(400);
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
