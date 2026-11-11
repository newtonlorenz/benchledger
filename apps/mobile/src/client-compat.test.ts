import { describe, expect, it, vi } from "vitest";
import { BenchLedgerClient, type Fetcher } from "./client";
import data from "./demo-data.json";

const connection = { server: "https://workspace.example.com", token: "synthetic-mobile-token", allowLocalHttp: false };
const health = { status: "ok", service: "benchledger", version: "1.4.0", demo: false, now: "2026-09-14T00:00:00.000Z" };
const json = (body: unknown, status = 200) => Response.json(body, { status });
function client(routes: Record<string, unknown>) {
  const fetcher = vi.fn<Fetcher>(async (url) => {
    const path = new URL(url).pathname.replace(/^\/api\/v1/u, "");
    return path in routes ? json(routes[path]) : json({ error: { code: "not_found" } }, 404);
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
