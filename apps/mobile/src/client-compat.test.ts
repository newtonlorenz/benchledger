import { describe, expect, it, vi } from "vitest";
import { BenchLedgerClient, type Fetcher } from "./client";
import data from "./demo-data.json";

const connection = { server: "https://workspace.example.com", token: "synthetic-mobile-token", allowLocalHttp: false };
const health = { status: "ok", service: "benchledger", version: "1.4.0", demo: false, now: "2026-09-14T00:00:00.000Z" };
const json = (body: unknown, status = 200) => Response.json(body, { status });
function client(routes: Record<string, unknown>) {
  const fetcher = vi.fn<Fetcher>(async (url) => {
    const path = new URL(url).pathname.replace(/^\/api\/v1/u, "");
    const route = routes[path];
    if (route instanceof Response) return route;
    return path in routes ? json(route) : json({ error: { code: "not_found" } }, 404);
  });
  return { client: new BenchLedgerClient(connection, fetcher), fetcher };
}
const session = { authenticated: true, actor: "synthetic", scopes: ["read"] };
const item = { ...data.items["printer-h2d" as keyof typeof data.items] } as Record<string, unknown>;
const [projectId, detail] = Object.entries(data.details)[0]!;
const [revisionId, revision] = Object.entries(data.revisions)[0]!;
const bom = Object.values(data.boms)[0]!;

describe("forward-compatible reads", () => {
  it("ignores unknown fields added by a newer server, including nested ones", async () => {
    const future = { ...item, futureField: "x", evidence: { ...(item.evidence as object), futureEvidence: 1 } };
    const { client: c } = client({
      "/health": { ...health, futureHealth: true }, "/auth/session": { ...session, futureSession: true },
      "/inventory": { data: [future], limit: 50, futureCursorInfo: {} },
      [`/inventory/${item.id}`]: future,
      [`/projects/${projectId}`]: { ...detail, futureDetail: 1, project: { ...detail.project, futureProject: 1 }, workItems: detail.workItems.map((w) => ({ ...w, futureWork: 1 })) },
      "/projects": { data: [{ ...detail.project, futureProject: 1 }], limit: 50 },
      [`/project-revisions/${revisionId}`]: { ...revision, futureRevision: 1 },
      [`/project-revisions/${revisionId}/bom`]: bom.map((line) => ({ ...line, futureLine: 1, constraints: { ...line.constraints, futureConstraint: "y" } }))
    });
    await expect(c.connect()).resolves.toMatchObject({ health: { status: "ok" } });
    const list = await c.inventory();
    expect(list.data[0]).not.toHaveProperty("futureField");
    expect(list.data[0]?.evidence).not.toHaveProperty("futureEvidence");
    expect(await c.item(item.id as string)).not.toHaveProperty("futureField");
    expect((await c.project(projectId)).project).not.toHaveProperty("futureProject");
    expect((await c.projects()).data).toHaveLength(1);
    expect(await c.revision(revisionId)).not.toHaveProperty("futureRevision");
    expect((await c.bom(revisionId))[0]?.constraints).not.toHaveProperty("futureConstraint");
  });
  it("still enforces canonical quantity invariants on tolerant reads", async () => {
    const { client: c } = client({ [`/inventory/${item.id}`]: { ...item, availableQuantity: 5, quantity: 1 } });
    await expect(c.item(item.id as string)).rejects.toThrow("incompatible");
  });
  it("reports an invalid record link without a generic failure", async () => {
    const { client: c, fetcher } = client({});
    await expect(c.item("../etc/passwd")).rejects.toThrow("link");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("server health and API compatibility", () => {
  it("connects with a warning when the server reports degraded health", async () => {
    const { client: c } = client({ "/health": { ...health, status: "degraded" }, "/auth/session": session });
    const result = await c.connect();
    expect(result.warning).toMatch(/degraded/u);
    expect(result.session.actor).toBe("synthetic");
  });
  it("has no warning on a healthy, compatible server", async () => {
    const { client: c } = client({ "/health": health, "/auth/session": session, "/capabilities": { protocol: "rest-v1", version: "1.4.0" } });
    expect((await c.connect()).warning).toBeUndefined();
  });
  it("refuses a server that advertises an unsupported API protocol before sending the token", async () => {
    const { client: c, fetcher } = client({ "/health": health, "/auth/session": session, "/capabilities": { protocol: "rest-v2" } });
    await expect(c.connect()).rejects.toThrow(/API version/u);
    expect(fetcher.mock.calls.every(([, init]) => !new Headers(init.headers).has("Authorization"))).toBe(true);
  });
  it("tolerates older servers without a capabilities route", async () => {
    const { client: c } = client({ "/health": health, "/auth/session": session });
    await expect(c.connect()).resolves.toMatchObject({ session: { actor: "synthetic" } });
  });
});

describe("stock receiving policy and list images", () => {
  const delivered = { ...data.items["wire-dupont" as keyof typeof data.items] } as Record<string, unknown>;
  const id = delivered.id as string;
  const cover = { id: "img-cover", url: `/api/v1/inventory/${id}/images/img-cover/content`, mediaType: "image/webp", width: 640, height: 480 };
  it("reads availability and the primary image from a current server", async () => {
    const { client: c } = client({ "/inventory": { data: [{ ...delivered, availability: "assumed", primaryImage: cover }], limit: 50 } });
    const [row] = (await c.inventory()).data;
    expect(row).toMatchObject({ availability: "assumed", primaryImage: cover });
  });
  it("reads rows from an older server without either field", async () => {
    const { client: c } = client({ "/inventory": { data: [delivered], limit: 50 }, [`/inventory/${id}`]: delivered });
    const [row] = (await c.inventory()).data;
    expect(row).not.toHaveProperty("availability"); expect(row).not.toHaveProperty("primaryImage");
    expect(await c.item(id)).toMatchObject({ id, evidence: { state: "delivered_uncounted" } });
  });
  it("drops an availability value or image reference it does not understand instead of the whole row", async () => {
    const { client: c } = client({ "/inventory": { data: [
      { ...delivered, availability: "future_state", primaryImage: { ...cover, mediaType: "image/avif" } },
      { ...delivered, id: "other-item", primaryImage: { ...cover, url: "https://elsewhere.example/x.webp" } }
    ], limit: 50 } });
    const rows = (await c.inventory()).data;
    expect(rows).toHaveLength(2);
    for (const row of rows) { expect(row).not.toHaveProperty("availability"); expect(row).not.toHaveProperty("primaryImage"); }
  });
  it("reads the workspace receiving policy, and reports none on servers without it", async () => {
    const preferences = { stockReceivingPolicy: "on_delivery", version: 2, updatedAt: "2026-11-01T00:00:00.000Z", future: 1 };
    expect(await client({ "/workspace/preferences": preferences }).client.workspacePreferences()).toEqual({ stockReceivingPolicy: "on_delivery", version: 2, updatedAt: preferences.updatedAt });
    expect(await client({}).client.workspacePreferences()).toBeNull();
  });
  it("uses the atomic server version check only when the server advertises the receiving policy", async () => {
    const current = client({ "/health": health, "/auth/session": session, "/capabilities": { protocol: "rest-v1", stockReceivingPolicy: { default: "on_receipt" } } }).client;
    const older = client({ "/health": health, "/auth/session": session, "/capabilities": { protocol: "rest-v1" } }).client;
    const oldest = client({ "/health": health, "/auth/session": session }).client;
    expect(current.atomicStockVersionCheck).toBe(false);
    await current.connect(); await older.connect(); await oldest.connect();
    expect([current.atomicStockVersionCheck, older.atomicStockVersionCheck, oldest.atomicStockVersionCheck]).toEqual([true, false, false]);
  });
  it("carries the server's conflict reason on a 409", async () => {
    const conflict = () => json({ error: { code: "conflict", message: "changed", details: { reason: "version_conflict", expectedVersion: 3, actualVersion: 4 } } }, 409);
    const { client: c, fetcher } = client({ [`/inventory/${id}/count`]: conflict() });
    await expect(c.recordCount(id, 2, "synthetic-key-1", 3)).rejects.toMatchObject({ status: 409, code: "version_conflict", message: expect.stringMatching(/changed on the server/u) });
    expect(new Headers(fetcher.mock.calls[0]![1].headers).get("If-Match")).toBe("3");
    const refused = client({ [`/inventory/${id}/stock-events`]: json({ error: { code: "conflict", details: { reason: "evidence_not_received" } } }, 409) }).client;
    await expect(refused.recordReceipt(id, 1, "each", "synthetic-key-2", 3)).rejects.toMatchObject({ status: 409, code: "evidence_not_received", message: expect.stringMatching(/count/u) });
    const plain = client({ [`/inventory/${id}/count`]: new Response("conflict", { status: 409 }) }).client;
    await expect(plain.recordCount(id, 2, "synthetic-key-3")).rejects.toMatchObject({ status: 409, code: undefined });
  });
});
