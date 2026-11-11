import type { Session } from "./client";
import { ClientError, errorMessage, restoreConnection, validateConnection, type Connection, type CredentialStore } from "./connection";
import type { WorkspacePersistence } from "./offline-store";
import { QueryCache } from "./query-cache";

/** The subset of BenchLedgerClient the session lifecycle depends on. */
export interface SessionClient {
  readonly connection: Connection;
  onUnauthorised?: () => void;
  connect(): Promise<{ health: { version: string; status: string }; session: Session; warning?: string }>;
  dispose(): void;
}
/** `rejected`: the server refused this address/origin; only a configuration change helps. */
export type Reachability = "checking" | "online" | "offline" | "rejected";
export type WorkspaceState = {
  phase: "workspace"; client: SessionClient; session: Session; version: string; cache: QueryCache;
  /** True until the server has confirmed the stored token; writes stay disabled. */
  provisional: boolean; reachability: Reachability; message: string; warning?: string; demo?: boolean;
  /** Persistent server+account scope for cached responses and queued writes; absent while in memory only. */
  scope?: string;
};
export type SignedOutState = { phase: "signed_out"; draft: Connection; error: string; busy: boolean; notice?: string };
export type SessionState = { phase: "restoring" } | SignedOutState | WorkspaceState;

export const emptyConnection: Connection = { server: "", token: "", allowLocalHttp: false };
// Read-only until the server confirms the scopes behind a restored token.
const provisionalSession: Session = { authenticated: true, actor: "", scopes: ["read"] };
const expiredMessage = "Your token is no longer accepted. Enter a valid API token to reconnect.";
const storageMessage = "Could not securely save this connection. Unlock the device and try again.";

/**
 * Connection lifecycle without React: restore, optimistic offline launch,
 * background verification, retry, 401 expiry, pairing prefill and disconnect.
 * Only a definitive 401 clears the saved session; network failures keep the
 * workspace open with an explicit "can't reach" state.
 */
export class SessionController {
  private current: SessionState = { phase: "restoring" };
  private readonly listeners = new Set<() => void>();
  private attempt = 0;
  private active: SessionClient | undefined;
  constructor(private readonly deps: {
    store: CredentialStore;
    createClient(connection: Connection): SessionClient;
    createDemo(): SessionClient;
    /** Persistent last-good responses; omitted in tests and for in-memory use. */
    persistence?: WorkspacePersistence;
  }) {}

  get state(): SessionState { return this.current; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.current;
  private set(next: SessionState) { this.current = next; for (const listener of [...this.listeners]) listener(); }
  private patchWorkspace(id: number, patch: Partial<WorkspaceState>) {
    if (id !== this.attempt || this.current.phase !== "workspace") return;
    this.set({ ...this.current, ...patch });
  }
  private replaceClient(client: SessionClient | undefined) {
    if (this.active && this.active !== client) this.active.dispose();
    this.active = client;
  }
  private watch(client: SessionClient, connection: Connection) {
    client.onUnauthorised = () => { if (this.active === client) void this.expire(connection); };
  }

  async restore() {
    const id = ++this.attempt;
    let value: Connection | null;
    try { value = await restoreConnection(this.deps.store); }
    catch {
      if (id === this.attempt) this.set({ phase: "signed_out", draft: emptyConnection, busy: false, error: "Could not read the saved connection. Unlock the device and reconnect." });
      return;
    }
    if (id !== this.attempt) return;
    if (!value) { this.set({ phase: "signed_out", draft: emptyConnection, busy: false, error: "" }); return; }
    // Show the last synced data for the account this server was last confirmed with.
    let remembered: string | undefined;
    try { remembered = await this.deps.persistence?.remembered(value.server); } catch { remembered = undefined; }
    const opened = remembered ? await this.openScope(value.server, remembered) : undefined;
    if (id !== this.attempt) return;
    const client = this.deps.createClient(value);
    this.replaceClient(client); this.watch(client, value);
    this.set({ phase: "workspace", client, session: provisionalSession, version: "", cache: opened?.cache ?? new QueryCache(),
      provisional: true, reachability: "checking", message: "", ...(opened ? { scope: opened.scope } : {}) });
    await this.verify(id, client, value);
  }

  /** Confirm the open workspace in the background. */
  async retry() {
    if (this.current.phase !== "workspace" || this.current.demo || this.current.reachability === "checking") return;
    const id = this.attempt;
    this.patchWorkspace(id, { reachability: "checking" });
    await this.verify(id, this.current.client, this.current.client.connection);
  }

  private async verify(id: number, client: SessionClient, connection: Connection) {
    try {
      const { health, session, warning } = await client.connect();
      if (id !== this.attempt || this.active !== client) return;
      // A different account than the cached one must never see that account's data.
      const current = this.current.phase === "workspace" ? this.current : undefined;
      const confirmed = await this.scopeFor(connection.server, session.actor);
      const switching = !!confirmed && current?.scope !== confirmed;
      const opened = switching ? await this.openScope(connection.server, confirmed) : undefined;
      if (id !== this.attempt || this.active !== client) return;
      const scope: Partial<WorkspaceState> = opened ? { cache: opened.cache, scope: opened.scope }
        : switching && current?.scope ? { cache: new QueryCache(), scope: undefined } : {};
      this.patchWorkspace(id, { session, version: health.version, provisional: false, reachability: "online", message: "", warning, ...scope });
      if (this.current.phase === "workspace") this.current.cache.revalidate();
    } catch (error) {
      if (id !== this.attempt || this.active !== client) return;
      if (error instanceof ClientError && error.status === 401) { await this.expire(connection); return; }
      // A configuration refusal is not an outage: do not auto-retry it on resume.
      const reachability = error instanceof ClientError && error.reason === "configuration" ? "rejected" : "offline";
      this.patchWorkspace(id, { reachability, message: errorMessage(error) });
    }
  }

  private async expire(connection: Connection) {
    const scope = this.current.phase === "workspace" ? this.current.scope : undefined;
    const id = ++this.attempt;
    this.replaceClient(undefined);
    let error = expiredMessage;
    try { await this.deps.store.remove(); }
    catch { error = `${expiredMessage} Secure storage could not be cleared; reconnect and disconnect to retry.`; }
    // Cached responses go with the token. Unsent stock changes stay for this
    // account until it reconnects; connecting another account discards them.
    if (scope) await this.deps.persistence?.clearCache(scope).catch(() => undefined);
    if (id !== this.attempt) return;
    this.set({ phase: "signed_out", draft: { ...connection, token: "" }, busy: false, error });
  }

  async connect(input: Connection) {
    if (this.current.phase !== "signed_out" || this.current.busy) return;
    const id = ++this.attempt;
    const draft = input;
    this.set({ phase: "signed_out", draft, busy: true, error: "" });
    let client: SessionClient | undefined;
    try {
      const value = validateConnection(input);
      client = this.deps.createClient(value);
      this.replaceClient(client);
      const { health, session, warning } = await client.connect();
      if (id !== this.attempt) return;
      try { await this.deps.store.set(JSON.stringify(value)); }
      catch { throw new Error(storageMessage); }
      if (id !== this.attempt) return;
      const confirmed = await this.scopeFor(value.server, session.actor);
      const opened = confirmed ? await this.openScope(value.server, confirmed) : undefined;
      if (id !== this.attempt) return;
      this.watch(client, value);
      this.set({ phase: "workspace", client, session, version: health.version, cache: opened?.cache ?? new QueryCache(),
        provisional: false, reachability: "online", message: "", warning, ...(opened ? { scope: opened.scope } : {}) });
    } catch (error) {
      if (id !== this.attempt) return;
      if (client && this.active === client) this.replaceClient(undefined);
      this.set({ phase: "signed_out", draft, busy: false,
        error: error instanceof Error && error.message === storageMessage ? storageMessage : errorMessage(error) });
    }
  }

  async openDemo() {
    if (this.current.phase !== "signed_out" || this.current.busy) return;
    const id = ++this.attempt;
    const previous = this.current;
    this.set({ ...previous, busy: true, error: "" });
    const client = this.deps.createDemo();
    try {
      const { health, session } = await client.connect();
      if (id !== this.attempt) { client.dispose(); return; }
      this.replaceClient(client);
      this.set({ phase: "workspace", client, session, version: health.version, cache: new QueryCache(),
        provisional: false, reachability: "online", message: "", demo: true });
    } catch (error) {
      client.dispose();
      if (id === this.attempt) this.set({ ...previous, busy: false, error: errorMessage(error) });
    }
  }

  /** Throws when secure storage cannot be cleared, leaving the workspace open. */
  async disconnect() {
    const demo = this.current.phase === "workspace" && this.current.demo;
    if (!demo) await this.deps.store.remove();
    this.attempt++;
    this.replaceClient(undefined);
    let error = "";
    if (!demo && this.deps.persistence) {
      try { await this.deps.persistence.wipe(); }
      catch { error = "Signed out, but cached workspace data could not be removed from this device. It is removed the next time you connect."; }
    }
    this.set({ phase: "signed_out", draft: emptyConnection, busy: false, error });
  }

  private async scopeFor(server: string, actor: string) {
    try { return await this.deps.persistence?.scopeOf(server, actor); } catch { return undefined; }
  }
  private async openScope(server: string, scope: string) {
    try {
      const cache = await this.deps.persistence?.open(server, scope);
      return cache ? { scope, cache } : undefined;
    } catch { return undefined; }
  }

  setDraft(draft: Connection) {
    if (this.current.phase === "signed_out") this.set({ ...this.current, draft });
  }

  /** A pairing link only fills the form; the user must review and connect. */
  prefill(draft: Connection): boolean {
    if (this.current.phase !== "signed_out" || this.current.busy) return false;
    this.set({ phase: "signed_out", draft, busy: false, error: "",
      notice: "Check this server address before connecting. Only use pairing links from your own BenchLedger server." });
    return true;
  }

  dispose() { this.attempt++; this.replaceClient(undefined); this.listeners.clear(); }
}
