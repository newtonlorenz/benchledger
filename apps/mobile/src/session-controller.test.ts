import { describe, expect, it, vi } from "vitest";
import { ClientError, type Connection, type CredentialStore } from "./connection";
import { SessionController, type SessionClient } from "./session-controller";

const saved: Connection = { server: "https://workspace.example.com", token: "synthetic-token", allowLocalHttp: false };
const session = { authenticated: true as const, actor: "synthetic", scopes: ["read" as const, "write" as const] };
const health = { status: "ok" as const, service: "benchledger", version: "1.4.0", demo: false, now: "2026-09-14T00:00:00.000Z" };
type Result = Awaited<ReturnType<SessionClient["connect"]>>;
function store(value: Connection | null = saved): CredentialStore & { value: string | null } {
  const s = { value: value ? JSON.stringify(value) : null,
    get: vi.fn(async () => s.value), set: vi.fn(async (v: string) => { s.value = v; }), remove: vi.fn(async () => { s.value = null; }) };
  return s;
}
function fakeClient(connect: () => Promise<Result>) {
  return (connection: Connection): SessionClient => ({ connection, connect: vi.fn(connect), dispose: vi.fn() });
}
const ok = async (): Promise<Result> => ({ health, session });
const offline = async (): Promise<Result> => { throw new ClientError("Could not reach the server.", 0, "unreachable"); };
const expired = async (): Promise<Result> => { throw new ClientError("Your API token is invalid or expired.", 401, "http"); };
const demo = () => ({ connection: { ...saved, server: "https://sample.invalid" }, connect: ok, dispose: vi.fn() });

describe("launch and restore", () => {
  it("enters the workspace optimistically and stays there when the server is unreachable", async () => {
    const credentials = store();
    const controller = new SessionController({ store: credentials, createClient: fakeClient(offline), createDemo: demo });
    const restoring = controller.restore();
    await vi.waitFor(() => expect(controller.state.phase).toBe("workspace"));
    await restoring;
    const state = controller.state;
    if (state.phase !== "workspace") throw new Error("expected workspace");
    expect(state.reachability).toBe("offline");
    expect(state.message).toMatch(/reach/u);
    expect(state.provisional).toBe(true);
    expect(state.session.scopes).toEqual(["read"]);
    expect(credentials.remove).not.toHaveBeenCalled();
  });
  it("does not treat a server configuration refusal as offline or retry it automatically", async () => {
    const rejected = async (): Promise<Result> => { throw new ClientError("This server doesn't accept this address.", 421, "configuration"); };
    const credentials = store();
    const controller = new SessionController({ store: credentials, createClient: fakeClient(rejected), createDemo: demo });
    await controller.restore();
    expect(controller.state).toMatchObject({ phase: "workspace", reachability: "rejected", message: expect.stringContaining("doesn't accept") });
    expect(credentials.remove).not.toHaveBeenCalled();
  });
  it("confirms the stored session in the background and unlocks writes", async () => {
    const controller = new SessionController({ store: store(), createClient: fakeClient(ok), createDemo: demo });
    await controller.restore();
    expect(controller.state).toMatchObject({ phase: "workspace", reachability: "online", provisional: false, session, version: "1.4.0" });
  });
  it("clears the saved session only on a definitive 401", async () => {
    const credentials = store();
    const controller = new SessionController({ store: credentials, createClient: fakeClient(expired), createDemo: demo });
    await controller.restore();
    expect(controller.state).toMatchObject({ phase: "signed_out", draft: { server: saved.server, token: "" } });
    expect(credentials.remove).toHaveBeenCalledOnce();
    if (controller.state.phase === "signed_out") expect(controller.state.error).toMatch(/no longer accepted/u);
  });
  it("shows the connect form without a saved session", async () => {
    const controller = new SessionController({ store: store(null), createClient: fakeClient(ok), createDemo: demo });
    await controller.restore();
    expect(controller.state).toMatchObject({ phase: "signed_out", error: "" });
  });
  it("reports locked secure storage without discarding it", async () => {
    const credentials = store(); credentials.get = vi.fn(async () => { throw new Error("locked"); });
    const controller = new SessionController({ store: credentials, createClient: fakeClient(ok), createDemo: demo });
    await controller.restore();
    expect(controller.state).toMatchObject({ phase: "signed_out" });
    if (controller.state.phase === "signed_out") expect(controller.state.error).toMatch(/Unlock/u);
    expect(credentials.remove).not.toHaveBeenCalled();
  });
  it("retries from offline to online", async () => {
    let attempt = 0;
    const controller = new SessionController({ store: store(), createClient: fakeClient(async () => (++attempt === 1 ? offline() : ok())), createDemo: demo });
    await controller.restore();
    expect(controller.state).toMatchObject({ reachability: "offline" });
    await controller.retry();
    expect(controller.state).toMatchObject({ reachability: "online", message: "" });
  });
  it("surfaces degraded health as a warning, not a failure", async () => {
    const controller = new SessionController({ store: store(), createClient: fakeClient(async () => ({ health: { ...health, status: "degraded" }, session, warning: "degraded" })), createDemo: demo });
    await controller.restore();
    expect(controller.state).toMatchObject({ phase: "workspace", reachability: "online", warning: "degraded" });
  });
});

describe("connect, expiry and disconnect", () => {
  it("connects, saves the connection and never keeps the token in the draft", async () => {
    const credentials = store(null);
    const controller = new SessionController({ store: credentials, createClient: fakeClient(ok), createDemo: demo });
    await controller.restore();
    await controller.connect(saved);
    expect(controller.state).toMatchObject({ phase: "workspace", reachability: "online" });
    expect(JSON.parse(credentials.value!)).toEqual(saved);
  });
  it("keeps the form and its error when connecting fails", async () => {
    const credentials = store(null);
    const controller = new SessionController({ store: credentials, createClient: fakeClient(offline), createDemo: demo });
    await controller.restore();
    await controller.connect(saved);
    expect(controller.state).toMatchObject({ phase: "signed_out", busy: false });
    expect(credentials.set).not.toHaveBeenCalled();
  });
  it("signs out when a later request is rejected with 401", async () => {
    const credentials = store();
    const clients: SessionClient[] = [];
    const controller = new SessionController({ store: credentials, createClient: (c) => { const client = fakeClient(ok)(c); clients.push(client); return client; }, createDemo: demo });
    await controller.restore();
    clients[0]!.onUnauthorised?.();
    await vi.waitFor(() => expect(credentials.remove).toHaveBeenCalled());
    expect(controller.state.phase).toBe("signed_out");
  });
  it("ignores a late verification after disconnect", async () => {
    let finish!: (value: Result) => void;
    const credentials = store();
    const controller = new SessionController({ store: credentials, createClient: fakeClient(() => new Promise((done) => { finish = done; })), createDemo: demo });
    const restoring = controller.restore();
    await vi.waitFor(() => expect(controller.state.phase).toBe("workspace"));
    await controller.disconnect();
    finish({ health, session }); await restoring;
    expect(controller.state.phase).toBe("signed_out");
    expect(credentials.value).toBeNull();
  });
  it("opens the sample workspace without touching secure storage", async () => {
    const credentials = store(null);
    const controller = new SessionController({ store: credentials, createClient: fakeClient(ok), createDemo: demo });
    await controller.restore();
    await controller.openDemo();
    expect(controller.state).toMatchObject({ phase: "workspace", demo: true });
    await controller.disconnect();
    expect(credentials.remove).not.toHaveBeenCalled();
  });
});

describe("pairing links", () => {
  it("prefills the connect form and does not connect", async () => {
    const createClient = vi.fn(fakeClient(ok));
    const controller = new SessionController({ store: store(null), createClient, createDemo: demo });
    await controller.restore();
    expect(controller.prefill({ ...saved, server: "http://192.168.1.4:8792", allowLocalHttp: true })).toBe(true);
    expect(controller.state).toMatchObject({ phase: "signed_out", draft: { server: "http://192.168.1.4:8792", allowLocalHttp: true } });
    if (controller.state.phase === "signed_out") expect(controller.state.notice).toMatch(/Check/u);
    expect(createClient).not.toHaveBeenCalled();
  });
  it("is ignored while a workspace is open", async () => {
    const controller = new SessionController({ store: store(), createClient: fakeClient(ok), createDemo: demo });
    await controller.restore();
    expect(controller.prefill(saved)).toBe(false);
    expect(controller.state.phase).toBe("workspace");
  });
});

describe("controller edge cases", () => {
  it("reports secure storage failure when saving a new connection", async () => {
    const credentials = store(null); credentials.set = vi.fn(async () => { throw new Error("locked"); });
    const controller = new SessionController({ store: credentials, createClient: fakeClient(ok), createDemo: demo });
    await controller.restore();
    await controller.connect(saved);
    expect(controller.state).toMatchObject({ phase: "signed_out", error: expect.stringMatching(/securely save/u) });
  });
  it("edits the draft only while signed out and rejects invalid input locally", async () => {
    const createClient = vi.fn(fakeClient(ok));
    const controller = new SessionController({ store: store(null), createClient, createDemo: demo });
    await controller.restore();
    controller.setDraft({ ...saved, server: "http://8.8.8.8" });
    await controller.connect({ ...saved, server: "http://8.8.8.8" });
    expect(controller.state).toMatchObject({ phase: "signed_out", draft: { server: "http://8.8.8.8" }, error: expect.stringMatching(/HTTPS/u) });
    expect(createClient).not.toHaveBeenCalled();
  });
  it("keeps the form when the sample workspace cannot open", async () => {
    const controller = new SessionController({ store: store(null), createClient: fakeClient(ok),
      createDemo: () => ({ connection: saved, connect: offline, dispose: vi.fn() }) });
    await controller.restore();
    await controller.openDemo();
    expect(controller.state).toMatchObject({ phase: "signed_out", busy: false, error: expect.stringMatching(/reach/u) });
  });
  it("notifies subscribers and stops after dispose", async () => {
    const controller = new SessionController({ store: store(null), createClient: fakeClient(ok), createDemo: demo });
    const listener = vi.fn(); const stop = controller.subscribe(listener);
    await controller.restore();
    expect(listener).toHaveBeenCalled(); expect(controller.getSnapshot().phase).toBe("signed_out");
    stop(); controller.dispose();
  });
});
