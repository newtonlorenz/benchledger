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
