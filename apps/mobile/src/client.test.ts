import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, bearerRecord } from "../../server/src/app.js";
import { BenchLedgerClient, canWriteWorkspace, type Fetcher } from "./client";
import { normaliseServer, restoreConnection, validateConnection, type CredentialStore } from "./connection";

const connection = { server: "https://workspace.example.com", token: "synthetic-mobile-token", allowLocalHttp: false };
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function server(scopes: ("read" | "write" | "admin")[] = ["read", "write"], projectIds?: string[]) {
  const app = await createApp({ demo: true, logger: false, auth: {
    sessionSecret: "s".repeat(48), bearerTokens: [bearerRecord(connection.token, scopes, projectIds)]
  } });
  cleanup.push(() => app.close());
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    const target = new URL(url);
    const response = await app.inject({ method: (init.method ?? "GET") as "GET" | "POST" | "PATCH", url: target.pathname + target.search,
      headers: Object.fromEntries(new Headers(init.headers)), ...(typeof init.body === "string" ? { payload: init.body } : {}) });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": response.headers["content-type"] as string } });
  });
  const client = new BenchLedgerClient(connection, fetcher); cleanup.push(() => client.dispose());
  return { app, client, fetcher };
}

describe("mobile server connections", () => {
  it.each([
    ["https://workspace.example.com/", false, "https://workspace.example.com"],
    ["https://workspace.example.com/bench/api/v1/", false, "https://workspace.example.com/bench"],
    ["http://127.0.0.1:8792", true, "http://127.0.0.1:8792"],
    ["http://192.168.10.12:8792", true, "http://192.168.10.12:8792"],
    ["http://workshop.local:8792", true, "http://workshop.local:8792"]
  ])("normalises %s", (address, allow, expected) => expect(normaliseServer(address, allow)).toBe(expected));
  it.each([
    "workspace.example.com", "ftp://workspace.example.com", "http://workspace.example.com", "http://8.8.8.8",
    "https://name:password@workspace.example.com", "https://workspace.example.com/?token=secret", "https://workspace.example.com/#fragment",
    "https://workspace.example.com/path%2Fother", "https://workspace.example.com/a\\b"
  ])("rejects unsafe address %s even with local HTTP consent", (address) => expect(() => normaliseServer(address, true)).toThrow());
  it("requires separate opt-in for local HTTP and rejects malformed tokens", () => {
    expect(() => normaliseServer("http://127.0.0.1:8792")).toThrow();
    expect(() => validateConnection({ ...connection, token: "Bearer copied-with-prefix" })).toThrow();
    expect(() => validateConnection({ ...connection, token: "\nunsafe\rheader" })).toThrow();
  });
  it("restores a valid connection and discards corrupt stored values", async () => {
    const store: CredentialStore = { get: vi.fn(async () => JSON.stringify(connection)), set: vi.fn(), remove: vi.fn() };
    expect(await restoreConnection(store)).toEqual(connection);
    store.get = async () => "not-json";
    expect(await restoreConnection(store)).toBeNull(); expect(store.remove).toHaveBeenCalledOnce();
    store.get = async () => null; expect(await restoreConnection(store)).toBeNull();
  });
  it("does not hide secure-storage failures", async () => {
    const store: CredentialStore = { get: async () => { throw new Error("locked"); }, set: vi.fn(), remove: vi.fn() };
    await expect(restoreConnection(store)).rejects.toThrow("locked");
  });
  it("verifies server identity before sending a token and uses native redirect protection", async () => {
    const { client, fetcher } = await server();
    const result = await client.connect();
    expect(result.health.service).toBe("benchledger"); expect(canWriteWorkspace(result.session)).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", credentials: "omit", headers: { Accept: "application/json" } });
    expect(new Headers(fetcher.mock.calls[0]?.[1].headers).has("Authorization")).toBe(false);
    const sessionCall = fetcher.mock.calls.find(([url]) => url.endsWith("/auth/session"));
    expect(fetcher.mock.calls.filter(([url]) => !url.endsWith("/auth/session")).every(([, init]) => !new Headers(init.headers).has("Authorization"))).toBe(true);
    expect(new Headers(sessionCall?.[1].headers).get("Authorization")).toBe(`Bearer ${connection.token}`);
    expect(fetcher.mock.calls.every(([url]) => !url.includes(connection.token))).toBe(true);
  });
  it("rejects a server that is not BenchLedger before any further request", async () => {
    const fetcher = vi.fn<Fetcher>(async () => Response.json({ status: "ok", service: "other-service", version: "0.1.0", demo: true, now: new Date().toISOString() }));
    await expect(new BenchLedgerClient(connection, fetcher).connect()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects non-JSON and incompatible responses without echoing their content", async () => {
    const client = new BenchLedgerClient(connection, async () => new Response("<html>private diagnostic</html>"));
    await expect(client.connect()).rejects.toThrow("did not return the BenchLedger API");
    const malformed = new BenchLedgerClient(connection, async () => Response.json({ items: "wrong" }));
    await expect(malformed.inventory()).rejects.toThrow("incompatible");
  });
  it("rejects redirects and never sends a second request", async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status: 302, headers: { location: "https://other.example.com" } }));
    await expect(new BenchLedgerClient(connection, fetcher).connect()).rejects.toThrow("redirected");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("cancels timeouts and requests when a connection is closed", async () => {
    const fetcher: Fetcher = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    await expect(new BenchLedgerClient(connection, fetcher, 5).connect()).rejects.toThrow("timed out");
    const client = new BenchLedgerClient(connection, fetcher);
    const pending = client.connect(); client.dispose(); await expect(pending).rejects.toThrow("cancelled");
    await expect(client.inventory()).rejects.toThrow("closed");
  });
  it("reports a rejected Host (421) as a non-retryable configuration problem naming the host", async () => {
    const fetcher: Fetcher = async () => Response.json({ error: { code: "host_not_allowed", message: "x" } }, { status: 421 });
    const error = await new BenchLedgerClient({ ...connection, server: "https://bench.example.com:8443" }, fetcher).connect().catch((e) => e);
    expect(error).toMatchObject({ status: 421, reason: "configuration" });
    expect(error.message).toContain("bench.example.com");
    expect(error.message).toContain("BENCHLEDGER_ALLOWED_HOSTS");
    expect(error.message).not.toMatch(/unavailable/u);
  });
  it("distinguishes a cross-origin refusal from a missing permission", async () => {
    const crossOrigin: Fetcher = async () => Response.json({ error: { code: "forbidden", message: "Cross-origin requests are not allowed" } }, { status: 403 });
    expect(await new BenchLedgerClient(connection, crossOrigin).inventory().catch((e) => e)).toMatchObject({ status: 403, reason: "configuration", message: expect.stringMatching(/proxy|address/u) });
    const denied: Fetcher = async () => Response.json({ error: { code: "forbidden", message: "Scope denied" } }, { status: 403 });
    expect(await new BenchLedgerClient(connection, denied).inventory().catch((e) => e)).toMatchObject({ status: 403, reason: "http", message: expect.stringMatching(/permission/u) });
  });
  it("explains a missing version precondition (428)", async () => {
    const fetcher: Fetcher = async () => Response.json({ error: { code: "precondition_required", message: "x" } }, { status: 428 });
    const error = await new BenchLedgerClient(connection, fetcher).inventory().catch((e) => e);
    expect(error).toMatchObject({ status: 428, reason: "http" });
    expect(error.message).toMatch(/Refresh/u);
    expect(error.message).not.toMatch(/unavailable/u);
  });
  it.each([401, 403, 404, 409, 421, 428, 429, 500])("reports HTTP %s safely", async (status) => {
    const fetcher: Fetcher = async () => Response.json({ error: { message: connection.token } }, { status });
    const client = new BenchLedgerClient(connection, fetcher);
    const expired = vi.fn(); client.onUnauthorised = expired;
    const error = await client.inventory().catch((e) => e);
    expect(error.status).toBe(status); expect(error.message).not.toContain(connection.token);
    expect(expired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });
});

describe("mobile client against the real HTTP application", () => {
  it("keeps long searches within the server's 200-character query limit", async () => {
    const { client, fetcher } = await server();
    const long = `x${"y".repeat(260)}`;
    await expect(client.projects(long)).resolves.toMatchObject({ data: [] });
    await expect(client.inventory(long)).resolves.toMatchObject({ data: [] });
    for (const [url] of fetcher.mock.calls) expect(new URL(url).searchParams.get("q")?.length ?? 0).toBeLessThanOrEqual(200);
  });
  it("reads inventory, searches and follows server cursors", async () => {
    const { client, app } = await server();
    const first = await client.inventory();
    expect(first.data.length).toBeGreaterThan(0);
    const item = first.data[0]!;
    expect(await client.item(item.id)).toEqual(item);
    const search = await client.inventory(item.name);
    expect(search.data.some((value) => value.id === item.id)).toBe(true);
    const tiny = await app.inject({ url: "/api/v1/inventory?limit=1", headers: { authorization: `Bearer ${connection.token}` } });
    const cursor = tiny.json<{ nextCursor: string }>().nextCursor;
    expect(cursor).toBeTruthy();
    expect((await client.inventory("", cursor)).data[0]?.id).not.toBe(tiny.json().data[0].id);
  });
  it("creates the project and initial revision once across retries, then reads its requirements", async () => {
    const { client } = await server();
    const key = randomUUID();
    const project = await client.createProject("Synthetic mobile lamp", "A small desk light", key);
    const replay = await client.createProject("Synthetic mobile lamp", "A small desk light", key);
    expect(replay.id).toBe(project.id);
    const detail = await client.project(project.id);
    expect(detail.project.currentRevisionId).toBeTruthy();
    expect(await client.revision(detail.project.currentRevisionId!)).toMatchObject({ status: "concept", fabricationRoute: "undecided" });
    expect(await client.bom(detail.project.currentRevisionId!)).toEqual([]);
    expect((await client.projects("Synthetic mobile lamp")).data).toHaveLength(1);
  });
  it("edits item metadata with version protection while preserving quantity and evidence", async () => {
    const { client } = await server();
    const item = (await client.inventory()).data[0]!;
    const edit = { name: item.name, location: "Synthetic drawer B", description: "Updated label" };
    const key = randomUUID();
    const updated = await client.updateItem(item, edit, key);
    expect(updated.location).toBe(edit.location); expect(updated.version).toBe(item.version + 1);
    expect(updated.evidence).toEqual(item.evidence); expect(updated.quantity).toBe(item.quantity);
    expect((await client.updateItem(item, edit, key)).id).toBe(item.id);
    await expect(client.updateItem(item, { ...edit, location: "Stale edit" }, randomUUID())).rejects.toMatchObject({ status: 409 });
  });
  it("allows read-only browsing and rejects writes", async () => {
    const { client } = await server(["read"]);
    expect(canWriteWorkspace((await client.connect()).session)).toBe(false);
    expect((await client.projects()).data.length).toBeGreaterThan(0);
    await expect(client.createProject("Read-only attempt", "", randomUUID())).rejects.toMatchObject({ status: 403 });
  });
  it("preserves project-scoped token restrictions", async () => {
    const { client } = await server(["write"], ["project-not-present"]);
    expect(canWriteWorkspace((await client.connect()).session)).toBe(false);
    expect((await client.projects()).data).toEqual([]);
    expect((await client.inventory()).data.length).toBeGreaterThan(0);
    const item = (await client.inventory()).data[0]!;
    await expect(client.updateItem(item, { name: item.name, description: "", location: "Restricted edit" }, randomUUID())).rejects.toMatchObject({ status: 403 });
    await expect(client.createProject("Scoped attempt", "", randomUUID())).rejects.toMatchObject({ status: 403 });
  });
});

describe("quick stock changes and photos", () => {
  // A 1x1 PNG: synthetic, metadata-free test image.
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  async function countable(client: BenchLedgerClient) {
    const items = (await client.inventory()).data;
    return items.find((item) => item.unit === "each" && (item.evidence.state === "physically_counted" || item.evidence.state === "commissioned")) ?? items[0]!;
  }
  it("records a physical count with an idempotency key, and a retry is not applied twice", async () => {
    const { client, fetcher } = await server();
    const item = await countable(client);
    const key = randomUUID();
    const counted = await client.recordCount(item.id, 7, key);
    expect(counted).toMatchObject({ id: item.id, quantity: 7 });
    expect(counted.version).toBeGreaterThan(item.version);
    const replay = await client.recordCount(item.id, 7, key);
    expect(replay.version).toBe(counted.version);
    expect((await client.item(item.id)).version).toBe(counted.version);
    const init = fetcher.mock.calls.at(-2)![1];
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(key);
    expect(JSON.parse(init.body as string)).toEqual({ quantity: 7 });
  });
  it("records a receipt as an append-only stock event", async () => {
    const { client, fetcher } = await server();
    const item = await countable(client);
    const received = await client.recordReceipt(item.id, 3, item.unit, randomUUID());
    expect(received.quantity).toBe(item.quantity + 3);
    const [url, init] = fetcher.mock.calls.at(-1)!;
    expect(url).toMatch(/\/inventory\/[^/]+\/stock-events$/u);
    expect(JSON.parse(init.body as string)).toEqual({ type: "receipt", quantity: 3, unit: item.unit });
  });
  it("refuses stock changes for read-only tokens", async () => {
    const { client } = await server(["read"]);
    const item = await countable(client);
    await expect(client.recordCount(item.id, 1, randomUUID())).rejects.toMatchObject({ status: 403 });
  });
  it("reads the photo gallery and adds a photo against its version", async () => {
    const { client } = await server();
    const item = await countable(client);
    const gallery = await client.gallery(item.id);
    expect(gallery).toMatchObject({ itemId: item.id, images: expect.any(Array) });
    const key = randomUUID();
    const updated = await client.addImage(item.id, { expectedVersion: gallery.version, imageBase64: pixel, filename: "item-photo.png", mediaType: "image/png" }, key);
    expect(updated.images).toHaveLength(gallery.images.length + 1);
    expect(updated.version).toBeGreaterThan(gallery.version);
    const image = updated.images.at(-1)!;
    const source = client.imageSource(item.id, image.id, image.sha256);
    expect(source.uri).toBe(`${connection.server}/api/v1/inventory/${item.id}/images/${image.id}/content`);
    expect(source.headers.Authorization).toBe(`Bearer ${connection.token}`);
    expect(source.cacheKey).toBe(`${image.id}:${image.sha256}`);
    await expect(client.addImage(item.id, { expectedVersion: gallery.version, imageBase64: pixel, filename: "item-photo.png", mediaType: "image/png" }, randomUUID()))
      .rejects.toMatchObject({ status: 409 });
  });
});
