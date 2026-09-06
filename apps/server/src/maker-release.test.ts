import { describe, it, expect } from "vitest";
import { createApp, bearerRecord } from "./app.js";
const projectId = "synthetic-project-lamp", revisionId = "synthetic-revision-lamp-r01";
const root = `/api/v1/projects/${projectId}`, revision = `${root}/revisions/${revisionId}`;
const offer = { bomLineId: "synthetic-bom-fasteners", expectedBomLineVersion: 1, supplier: "Synthetic supplier", title: "Mounting screw pack", url: "https://supplier.example/screws", packageQuantity: 3, packageUnit: "each", priceMinor: 150, shippingMinor: 250, taxIncluded: "yes", currency: "EUR", observedAt: new Date().toISOString(), validForDays: 30 };

describe("maker release HTTP and MCP acceptance", () => {
  it("exercises all project workflows without altering stock or weakening scope", async () => {
    const app = await createApp({ demo: true, logger: false, auth: { sessionSecret: "synthetic-release-secret-".repeat(3), bearerTokens: [bearerRecord("writer", ["read", "write"]), bearerRecord("scoped", ["read", "write"], [projectId]), bearerRecord("reader", ["read"], [projectId]), bearerRecord("wrong", ["read", "write"], ["other-project"])] } });
    let serial = 0;
    const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object, token = "scoped", key = `release-command-${++serial}`) => app.inject({ method, url, headers: { authorization: `Bearer ${token}`, "idempotency-key": key }, ...(payload === undefined ? {} : { payload }) });
    const ok = (result: { statusCode: number; body: string; json(): any }) => { expect(result.statusCode, result.body).toBeLessThan(300); return result.json(); };
    try {
      const before = ok(await call("GET", "/api/v1/inventory", undefined, "writer"));
      expect((await call("POST", `${revision}/requirement-offers`, offer, "reader")).statusCode).toBe(403);
      expect((await call("GET", `${revision}/sourcing`, undefined, "wrong")).statusCode).toBe(403);
      expect((await call("GET", `${root}/revisions/nonexistent/sourcing`)).statusCode).toBe(403);
      const quote = ok(await call("POST", `${revision}/requirement-offers`, offer, "scoped", "release-quote-once")).data;
      expect(ok(await call("POST", `${revision}/requirement-offers`, offer, "scoped", "release-quote-once")).replayed).toBe(true);
      expect((await call("POST", `${revision}/requirement-offers`, { ...offer, priceMinor: 200 }, "scoped", "release-quote-once")).statusCode).toBe(409);
      ok(await call("PUT", `${revision}/offer-choice`, { bomLineId: offer.bomLineId, offerId: quote.id, expectedVersion: 0, expectedBomLineVersion: 1, confirmedFit: true }));
      const pricing = ok(await call("GET", `${revision}/sourcing?limit=2`)); expect(pricing.totals.EUR.knownMinor).toBe(550); expect(pricing.nextCursor).toBe("2");
      expect(ok(await call("GET", `${revision}/sourcing?limit=2&cursor=2`)).data.some((row: { estimate: { packages?: number } }) => row.estimate.packages === 2)).toBe(true);
      const work = ok(await call("POST", `${root}/workstreams`, { name: "Release electronics", kind: "electronics" })).data;
      ok(await call("PUT", `${root}/workstreams/${work.item.id}/assignment`, { expectedVersion: 0, status: "in_progress", dueDate: "2027-01-02", notes: "Review connectors" }));
      expect(ok(await call("GET", `${root}/workstreams`)).data.some((entry: { assignment?: { status: string } }) => entry.assignment?.status === "in_progress")).toBe(true);
      expect(ok(await call("GET", `${root}/workstreams/${work.item.id}/revisions`)).data).toHaveLength(1);
      expect(ok(await call("GET", `${root}/revision-history`)).data).toHaveLength(1);
      expect(ok(await call("GET", `${revision}/snapshot`)).readOnly).toBe(true);
      const plan = { expectedVersion: 0, name: "Enclosure build", parts: [{ id: "enclosure", name: "Enclosure", quantity: 2 }], plates: [] };
      ok(await call("PUT", `${revision}/build-plan`, plan));
      expect(ok(await call("GET", `${revision}/build-plan`)).version).toBe(1);
      ok(await call("PUT", `${revision}/build-plan`, { ...plan, expectedVersion: 1, name: "Reviewed enclosure" }));
      expect(ok(await call("GET", `${revision}/build-plan/history?limit=1`)).nextCursor).toBe("1");
      expect((await call("PUT", `${revision}/build-plan`, plan)).statusCode).toBe(409);
      const proposal = { rows: [{ name: "Release spacer", requiredQuantity: 2, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [] }] };
      const preview = ok(await call("POST", `${revision}/bom-import/previews`, proposal));
      const confirm = { previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmed: true };
      expect((await call("POST", `${revision}/bom-import/commit`, confirm, "writer")).statusCode).toBe(403);
      const imported = ok(await call("POST", `${revision}/bom-import/commit`, confirm, "scoped", "release-import-once")); expect(imported.data.lines).toHaveLength(1);
      expect(ok(await call("POST", `${revision}/bom-import/commit`, confirm, "scoped", "release-import-once")).replayed).toBe(true);
      expect((await call("POST", `${revision}/bom-import/previews`, proposal)).statusCode).toBe(409);
      expect(ok(await call("GET", "/api/v1/inventory", undefined, "writer"))).toEqual(before);
      const rpc = async (name: string, args: object, token = "scoped") => ok(await call("POST", "/api/v1/mcp", { jsonrpc: "2.0", id: "release", method: "tools/call", params: { name, arguments: args } }, token));
      for (const [name, args] of [
        ["read_requirement_sourcing", { projectId, projectRevisionId: revisionId }], ["read_build_plan", { projectId, projectRevisionId: revisionId }], ["read_build_plan_history", { projectId, projectRevisionId: revisionId }], ["list_workstreams", { projectId }], ["list_project_revisions", { projectId }], ["list_workstream_revisions", { projectId, workItemId: work.item.id }], ["read_project_revision_snapshot", { projectId, projectRevisionId: revisionId }], ["read_project_team", { projectId }],
        ["record_requirement_offer", { projectId, projectRevisionId: revisionId, offer: { ...offer, title: "Agent quote" } }], ["choose_requirement_offer", { projectId, projectRevisionId: revisionId, choice: { bomLineId: offer.bomLineId, offerId: null, expectedVersion: 1, expectedBomLineVersion: 1, confirmedFit: false } }], ["save_build_plan", { projectId, projectRevisionId: revisionId, plan: { ...plan, expectedVersion: 2 } }], ["create_workstream", { projectId, workstream: { name: "Agent workstream", kind: "document" } }], ["update_work_assignment", { projectId, workItemId: work.item.id, assignment: { expectedVersion: 1, status: "blocked" } }],
      ] as [string, object][]) { const result = await rpc(name, args); expect(result.result?.isError, JSON.stringify(result)).not.toBe(true); expect(result.error).toBeUndefined(); }
      expect((await rpc("read_build_plan", { projectId, projectRevisionId: revisionId }, "wrong")).result.isError).toBe(true);
      const openapi = ok(await call("GET", "/api/v1/openapi.json", undefined, "writer")); expect(openapi.paths["/projects/{projectId}/revisions/{revisionId}/build-plan"].put.requestBody).toBeDefined();
    } finally { await app.close(); }
  });
});
