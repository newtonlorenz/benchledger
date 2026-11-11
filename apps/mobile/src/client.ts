import { z } from "zod/v3";
import {
  bomLineSchema, createProjectWithInitialRevisionSchema, healthSchema, idSchema,
  inventoryItemSchema, projectRevisionSchema, projectSchema, projectWithInitialRevisionSchema,
  updateInventoryItemSchema, workItemSchema
} from "@benchledger/api-contract";
import type { InventoryItem, Project } from "@benchledger/api-contract";
import { ClientError, validateConnection, type Connection } from "./connection";
import { tolerant } from "./tolerant";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const sessionSchema = z.object({
  authenticated: z.literal(true), actor: z.string(), scopes: z.array(z.enum(["read", "write", "admin"])),
  projectIds: z.array(idSchema).optional()
});
export type Session = z.infer<typeof sessionSchema>;
export type Page<T> = { data: T[]; nextCursor?: string; total?: number; limit: number };
const page = <T extends z.ZodTypeAny>(item: T) => z.object({
  data: z.array(item), nextCursor: z.string().max(200).optional(),
  total: z.number().int().nonnegative().optional(), limit: z.number().int().positive()
});
const detailSchema = z.object({ project: projectSchema, workItems: z.array(workItemSchema) });
// Reads strip unknown keys at every depth so a newer server can add fields
// (list enrichments, new metadata) without breaking this installed app. The
// canonical refinements, such as quantity invariants, still apply.
const read = {
  health: tolerant(healthSchema), session: tolerant(sessionSchema), item: tolerant(inventoryItemSchema),
  project: tolerant(projectSchema), detail: tolerant(detailSchema), revision: tolerant(projectRevisionSchema),
  bom: tolerant(z.array(bomLineSchema)), updated: tolerant(z.object({ data: inventoryItemSchema })),
  created: tolerant(z.object({ data: projectWithInitialRevisionSchema })),
  capabilities: z.object({ protocol: z.string().max(80).optional() })
};
/** Server limit for the `q` search parameter on /inventory and /projects. */
export const SEARCH_MAX_LENGTH = 200;
/** REST protocols this app understands; advertised by /capabilities. */
export const SUPPORTED_PROTOCOLS = ["rest-v1"] as const;
export type ProjectDetail = z.infer<typeof detailSchema>;
export type InventoryEdit = { name: string; location: string; description: string };

/** The server's origin check (or CSRF) refused the request, rather than a scope. */
async function isCrossOriginRefusal(response: Response): Promise<boolean> {
  try {
    const body = await response.clone().json() as { error?: { code?: unknown; message?: unknown } };
    const code = body?.error?.code; const message = body?.error?.message;
    return code === "csrf" || (code === "forbidden" && typeof message === "string" && /cross-origin|origin is not allowed/iu.test(message));
  } catch { return false; }
}

export class BenchLedgerClient {
  onUnauthorised?: () => void;
  readonly connection: Connection;
  private readonly lifetime = new AbortController();
  constructor(connection: Connection, private readonly fetcher: Fetcher, private readonly timeoutMs = 15000) {
    this.connection = validateConnection(connection);
  }
  dispose() { this.lifetime.abort(); }

  private async request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, options: {
    public?: boolean; method?: string; body?: unknown; key?: string; version?: number
  } = {}): Promise<T> {
    if (this.lifetime.signal.aborted) throw new ClientError("This connection has been closed.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.connection.server}/api/v1${path}`, {
        method: options.method ?? "GET", redirect: "error", credentials: "omit",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(!options.public ? { Authorization: `Bearer ${this.connection.token}` } : {}),
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(options.key ? { "Idempotency-Key": options.key } : {}),
          ...(options.version !== undefined ? { "If-Match": String(options.version) } : {})
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new ClientError("The server redirected the request. Enter its final HTTPS address.");
      }
      if (!response.ok) {
        if (response.status === 401 && !options.public) this.onUnauthorised?.();
        if (response.status === 421) {
          const host = new URL(this.connection.server).hostname;
          throw new ClientError(`This server doesn't accept this address. Add ${host} to BENCHLEDGER_ALLOWED_HOSTS on the server, or connect using its public address.`, 421, "configuration");
        }
        if (response.status === 403 && await isCrossOriginRefusal(response)) {
          throw new ClientError("The server refused this request as cross-origin. Check the server address and any proxy in front of it.", 403, "configuration");
        }
        const messages: Record<number, string> = {
          400: "The server could not accept these details. Check the fields and try again.",
          401: "Your API token is invalid or expired. Reconnect in Server settings.",
          403: "This token does not have permission for this action.",
          404: "This record or API route is unavailable. Refresh or check the server version.",
          409: "The record changed, or this operation conflicts with existing data. Refresh before editing again.",
          428: "The server needs the record's current version for this change. Refresh and try again.",
          429: "Too many requests. Wait a moment and try again."
        };
        throw new ClientError(messages[response.status] ?? "The server is unavailable. Try again shortly.", response.status, response.status >= 500 ? "unreachable" : "http");
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new ClientError("This address did not return the BenchLedger API. Check the server address.");
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) throw new ClientError("The server response is incompatible with this app. Check both versions.");
      return parsed.data;
    } catch (error) {
      if (error instanceof ClientError) throw error;
      throw new ClientError(controller.signal.aborted
        ? "The request timed out or was cancelled. Check your connection and try again."
        : "Could not reach the server. Check Wi-Fi, the address, local-network permission and its HTTPS certificate.", 0, "unreachable");
    } finally {
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", abort);
    }
  }

  async connect(): Promise<{ health: z.infer<typeof healthSchema>; session: Session; warning?: string }> {
    const health = await this.request("/health", read.health, { public: true });
    if (health.service.toLowerCase() !== "benchledger") throw new ClientError("This address is not a BenchLedger server.");
    await this.checkProtocol();
    const session = await this.request("/auth/session", read.session);
    if (!session.scopes.some((scope) => scope === "read" || scope === "write" || scope === "admin")) {
      throw new ClientError("Use an API token with read access.");
    }
    // Degraded health is reported, not blocking: reads may still work and the
    // user may need the app most while the server is partly unhealthy.
    return health.status === "ok" ? { health, session } : {
      health, session, warning: "The server reports degraded health. Some information may be unavailable or out of date."
    };
  }
  /** Public, token-free API protocol check. Older servers without the route are accepted. */
  private async checkProtocol() {
    let protocol: string | undefined;
    try { protocol = (await this.request("/capabilities", read.capabilities, { public: true })).protocol; }
    catch (error) { if (error instanceof ClientError && error.status === 404) return; throw error; }
    if (protocol && !(SUPPORTED_PROTOCOLS as readonly string[]).includes(protocol)) {
      throw new ClientError(`This server uses API version ${protocol}, which this app does not support. Update the app.`, 0, "incompatible");
    }
  }

  inventory(q = "", cursor?: string): Promise<Page<InventoryItem>> {
    return this.request(`/inventory?${this.query(q, cursor)}`, page(read.item));
  }
  async item(id: string) { return this.request(`/inventory/${recordId(id)}`, read.item); }
  projects(q = "", cursor?: string): Promise<Page<Project>> {
    return this.request(`/projects?${this.query(q, cursor)}`, page(read.project));
  }
  async project(id: string) { return this.request(`/projects/${recordId(id)}`, read.detail); }
  async revision(id: string) { return this.request(`/project-revisions/${recordId(id)}`, read.revision); }
  async bom(id: string) { return this.request(`/project-revisions/${recordId(id)}/bom`, read.bom); }

  async updateItem(item: InventoryItem, input: InventoryEdit, key: string) {
    const body = updateInventoryItemSchema.parse(input);
    const result = await this.request(`/inventory/${recordId(item.id)}`, read.updated, {
      method: "PATCH", body, key, version: item.version
    });
    return result.data;
  }
  async createProject(name: string, description: string, key: string) {
    const body = createProjectWithInitialRevisionSchema.parse({
      project: { name: name.trim(), description: description.trim(), status: "idea" },
      revision: { name: "Initial plan", status: "concept", fabricationRoute: "undecided" }
    });
    const result = await this.request("/projects/with-initial-revision", read.created, {
      method: "POST", body, key
    });
    return result.data.project;
  }
  private query(q: string, cursor?: string) {
    const params = new URLSearchParams({ limit: "50" });
    // The server rejects q longer than SEARCH_MAX_LENGTH (inventory and projects).
    const search = q.trim().slice(0, SEARCH_MAX_LENGTH).trim();
    if (search) params.set("q", search);
    if (cursor) params.set("cursor", cursor);
    return params;
  }
}

/** Deep links and route params are untrusted; reject malformed IDs before any request. */
function recordId(id: string): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new ClientError("This link does not point to a valid BenchLedger record.", 0, "invalid");
  return parsed.data;
}

export function canWriteWorkspace(session: Session): boolean {
  return session.projectIds === undefined && (session.scopes.includes("write") || session.scopes.includes("admin"));
}
