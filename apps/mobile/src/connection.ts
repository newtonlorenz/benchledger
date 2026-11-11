import { z } from "zod/v3";

/**
 * `unreachable` covers network failures, timeouts and 5xx responses.
 * `configuration` means the server refused this address or origin (421, or a
 * cross-origin 403); retrying without a server or address change cannot help.
 */
export type ClientErrorReason = "unreachable" | "http" | "configuration" | "incompatible" | "invalid" | "other";
export class ClientError extends Error {
  /** `code`: the server's machine-readable reason (`error.details.reason`), when it gave one. */
  constructor(message: string, readonly status = 0, readonly reason: ClientErrorReason = "other", readonly code?: string) { super(message); }
}

const localSuffixes = [".local", ".lan", ".home.arpa"];

function isLocalIPv6(host: string): boolean {
  const address = host.slice(1, -1).toLowerCase();
  if (address === "::1") return true;
  const first = address.split(":")[0];
  if (!first || !/^[0-9a-f]{1,4}$/u.test(first)) return false;
  const hextet = Number.parseInt(first, 16);
  // fe80::/10 link-local and fc00::/7 unique-local addresses.
  return (hextet & 0xffc0) === 0xfe80 || (hextet & 0xfe00) === 0xfc00;
}

/**
 * Hosts that cannot be reached from the public internet: loopback, RFC1918,
 * IPv4 link-local, carrier-grade NAT (100.64.0.0/10, used by Tailscale),
 * local DNS suffixes (.local, .lan, .home.arpa) and IPv6 loopback/link-local/ULA.
 * Single-label names are deliberately excluded: a DNS search domain can resolve
 * them to a public host, which would send the token in cleartext.
 * HTTP is still opt-in for these; every other host requires HTTPS.
 */
export function isLocalHost(input: string): boolean {
  const host = input.toLowerCase();
  if (!host) return false;
  if (host.startsWith("[") && host.endsWith("]")) return isLocalIPv6(host);
  if (host === "localhost" || localSuffixes.some((suffix) => host.endsWith(suffix))) return true;
  const labels = host.split(".");
  if (labels.length !== 4 || labels.some((part) => !/^\d{1,3}$/u.test(part))) return false;
  const parts = labels.map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

/** Keep credentials and redirects out of server addresses, including subpaths. */
export function normaliseServer(input: string, allowLocalHttp = false): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new ClientError("Enter the full server address, starting with https://."); }
  if (url.username || url.password || url.search || url.hash || /[\\\s]/u.test(input.trim())) {
    throw new ClientError("Use a server address without credentials, spaces, a query or a fragment.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname) && allowLocalHttp)) {
    throw new ClientError("Use HTTPS, or allow HTTP for a trusted local server below.");
  }
  // Accept either the workspace root or its documented API base.
  const path = url.pathname.replace(/\/+$/u, "").replace(/\/api\/v1$/u, "");
  if (/%2f|%5c|%2e/iu.test(path)) throw new ClientError("Use the server's plain workspace address.");
  return `${url.origin}${path}`;
}

export const connectionSchema = z.object({
  server: z.string().max(2048),
  token: z.string().trim().min(1).max(4096).regex(/^[A-Za-z0-9._~+\/-]+=*$/u),
  allowLocalHttp: z.boolean()
}).strict();
export type Connection = z.infer<typeof connectionSchema>;

export function validateConnection(value: unknown): Connection {
  const parsed = connectionSchema.safeParse(value);
  if (!parsed.success) throw new ClientError("Enter a server address and a valid API token.");
  return { ...parsed.data, server: normaliseServer(parsed.data.server, parsed.data.allowLocalHttp) };
}

export interface CredentialStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  remove(): Promise<void>;
}

export async function restoreConnection(store: CredentialStore): Promise<Connection | null> {
  const raw = await store.get();
  if (!raw) return null;
  try { return validateConnection(JSON.parse(raw)); }
  catch { await store.remove(); return null; }
}

export function errorMessage(error: unknown): string {
  return error instanceof ClientError ? error.message : "Something went wrong. Try again.";
}
