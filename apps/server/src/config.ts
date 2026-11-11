import { isIPv4, isIPv6 } from "node:net";

export function positiveIntegerFromEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string
): number | undefined {
  const raw = environment[name];
  if (raw === undefined || raw.length === 0) return undefined;
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} exceeds JavaScript's safe integer range`);
  }
  return value;
}

/**
 * Resolve the externally reachable origin used in capability links. The
 * request Host header is intentionally never a source for this value: a
 * forged Host must not redirect an agent to an attacker-controlled endpoint.
 */
export function publicBaseUrlFromEnvironment(
  configured: string | undefined,
  demo = false,
): string {
  const raw = configured ?? (demo ? "http://127.0.0.1:8792" : undefined);
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error("BENCHLEDGER_PUBLIC_BASE_URL must be an absolute HTTP(S) URL outside demo mode");
  }
  if (raw !== raw.trim()) {
    throw new Error("BENCHLEDGER_PUBLIC_BASE_URL must not contain surrounding whitespace");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("BENCHLEDGER_PUBLIC_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("BENCHLEDGER_PUBLIC_BASE_URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || /[?#]/u.test(raw) || parsed.pathname !== "/") {
    throw new Error("BENCHLEDGER_PUBLIC_BASE_URL must contain only an HTTP(S) origin");
  }
  if (parsed.hostname.length === 0 || parsed.origin === "null") {
    throw new Error("BENCHLEDGER_PUBLIC_BASE_URL must include a host");
  }
  return parsed.origin;
}

export type TrustProxySetting = false | number | readonly string[];

const TRUST_PROXY_NAMES = new Set(["loopback", "linklocal", "uniquelocal"]);

/** An IPv4/IPv6 address or CIDR, or a proxy-addr named range. */
function validTrustProxyEntry(entry: string): boolean {
  if (TRUST_PROXY_NAMES.has(entry.toLowerCase())) return true;
  const slash = entry.indexOf("/");
  const address = slash < 0 ? entry : entry.slice(0, slash);
  const prefix = slash < 0 ? undefined : entry.slice(slash + 1);
  const maximum = isIPv4(address) ? 32 : isIPv6(address) ? 128 : undefined;
  if (maximum === undefined) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/u.test(prefix) && Number(prefix) <= maximum;
}

/**
 * Parse BENCHLEDGER_TRUST_PROXY. Forwarded client addresses are spoofable
 * unless only known proxies are trusted, so the default is off. Accepts a hop
 * count (the number of reverse proxies in front of BenchLedger) or a
 * comma-separated list of proxy IPv4/IPv6 addresses/CIDRs (validated here so a
 * typo fails with a clear message rather than inside proxy-addr). The legacy
 * value `true` now means one hop (the nearest proxy), not every forwarder.
 */
export function trustProxyFromEnvironment(environment: NodeJS.ProcessEnv = process.env): TrustProxySetting {
  const raw = environment.BENCHLEDGER_TRUST_PROXY?.trim();
  if (raw === undefined || raw === "" || raw === "false" || raw === "0") return false;
  if (raw === "true") return 1;
  if (/^[1-9]\d?$/u.test(raw)) return Number(raw);
  const entries = raw.split(",").map((entry) => entry.trim());
  const invalid = entries.filter((entry) => !validTrustProxyEntry(entry));
  if (entries.length === 0 || invalid.length > 0) {
    throw new Error(`BENCHLEDGER_TRUST_PROXY must be false, true (one hop), a proxy hop count (1-99), or comma-separated IPv4/IPv6 addresses or CIDRs; invalid entr${invalid.length === 1 ? "y" : "ies"}: ${invalid.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }
  return entries;
}

const HOST_NAME = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/u;

/**
 * Optional extra Host names (without scheme or port) accepted in addition to
 * the BENCHLEDGER_PUBLIC_BASE_URL host and loopback names. Used to block DNS
 * rebinding: a browser tricked into resolving an attacker name to this server
 * still sends the attacker's name in Host.
 */
export function allowedHostsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = environment.BENCHLEDGER_ALLOWED_HOSTS;
  if (raw === undefined || raw.trim() === "") return [];
  const entries = raw.split(",").map((entry) => entry.trim().toLowerCase());
  if (entries.some((entry) => !HOST_NAME.test(entry))) {
    throw new Error("BENCHLEDGER_ALLOWED_HOSTS must be comma-separated host names or IP addresses without scheme, port or path");
  }
  return entries;
}
