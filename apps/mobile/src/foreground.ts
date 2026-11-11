/**
 * Decide whether an AppState change should revalidate the workspace: only a
 * return to "active", and at most once per interval so rapid app switching
 * does not hammer a home server.
 */
export function foregroundThrottle(minIntervalMs: number, now: () => number = Date.now) {
  let last: number | undefined;
  return (previous: string, next: string): boolean => {
    if (next !== "active" || previous === "active") return false;
    const at = now();
    if (last !== undefined && at - last < minIntervalMs) return false;
    last = at;
    return true;
  };
}
