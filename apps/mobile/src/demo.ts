import { BenchLedgerClient, type Fetcher } from "./client";
import data from "./demo-data.json";

// Synthetic API responses from createApp({ demo: true }). This transport never
// calls fetch or stores credentials; it is available to everyone, including review.
export const demoFetcher: Fetcher = async (input, init) => {
  const url = new URL(input);
  if (url.origin !== "https://sample.invalid" || (init.method ?? "GET") !== "GET") {
    return new Response(null, { status: 403 });
  }
  const path = url.pathname.replace(/^\/api\/v1/u, "");
  const records: Record<string, unknown> = {
    "/health": { status: "ok", service: "benchledger", version: "Sample workspace", demo: true, now: "2026-09-14T00:00:00.000Z" },
    "/auth/session": { authenticated: true, actor: "sample-workspace", scopes: ["read"] },
    "/workspace/preferences": { stockReceivingPolicy: "on_receipt", version: 1, updatedAt: "2026-09-14T00:00:00.000Z" },
    ...Object.fromEntries(Object.entries(data.items).map(([id, value]) => [`/inventory/${id}`, value])),
    ...Object.fromEntries(Object.entries(data.details).map(([id, value]) => [`/projects/${id}`, value])),
    ...Object.fromEntries(Object.entries(data.revisions).map(([id, value]) => [`/project-revisions/${id}`, value])),
    ...Object.fromEntries(Object.entries(data.boms).map(([id, value]) => [`/project-revisions/${id}/bom`, value]))
  };
  for (const [route, source] of [["/inventory", data.inventory], ["/projects", data.projects]] as const) {
    if (path !== route) continue;
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const filtered = source.data.filter((item) => `${item.name} ${"description" in item ? item.description : ""}`.toLowerCase().includes(q));
    records[route] = { data: filtered, total: filtered.length, limit: 100 };
  }
  if (!(path in records)) return new Response(null, { status: 404 });
  return new Response(JSON.stringify(records[path]), { headers: { "Content-Type": "application/json" } });
};

export function createDemoClient() {
  return new BenchLedgerClient({ server: "https://sample.invalid", token: "synthetic-local-only", allowLocalHttp: false }, demoFetcher);
}
