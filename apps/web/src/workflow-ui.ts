import { useEffect, useRef, useState } from "react";
import { ApiError, workflowRequest, workflowCommandKey } from "./api";
export function useWorkflowRead<T>(path: string | undefined, dependency = "") {
  const identity = JSON.stringify([path, dependency]);
  const [state, setState] = useState<{ identity: string; data?: T; loading: boolean; error?: string }>({ identity, loading: Boolean(path) });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    if (!path) { setState({ identity, loading: false }); return; }
    // Retain the last confirmed snapshot during a refresh, never across another scope.
    setState((current) => ({ identity, loading: true, ...(current.identity === identity && current.data !== undefined ? { data: current.data } : {}) }));
    void workflowRequest<T>(path).then((data) => { if (active) setState({ identity, data, loading: false }); }).catch((failure: unknown) => {
      if (active) setState((current) => {
        const denied = failure instanceof ApiError && (failure.status === 401 || failure.status === 403);
        return { ...(denied ? {} : current), identity, loading: false, error: failure instanceof Error ? failure.message : "This workspace could not be loaded." };
      });
    });
    return () => { active = false; };
  }, [path, identity, nonce]);
  const current: typeof state = state.identity === identity ? state : { identity, loading: Boolean(path) };
  return { data: current.data, loading: current.loading, error: current.error, reload: () => setNonce((value) => value + 1) };
}
export function useWorkflowCommand() {
  const pending = useRef<{ signature: string; key: string } | undefined>(undefined);
  const running = useRef(false);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState<string>();
  const execute = async <T>(path: string, method: "POST" | "PUT" | "PATCH", body: unknown, validate: (value: unknown) => T): Promise<T> => {
    if (running.current) throw new ApiError("Wait for the current save to finish.", { kind: "validation", status: 409 });
    const signature = JSON.stringify({ path, method, body });
    if (pending.current && pending.current.signature !== signature) throw new ApiError("The previous save was not confirmed. Retry unchanged or reload before making another change.", { kind: "validation", status: 409 });
    pending.current ??= { signature, key: workflowCommandKey("maker") }; running.current = true; setBusy(true); setError(undefined);
    try { const value = validate(await workflowRequest(path, method, body, pending.current.key)); pending.current = undefined; setUncertain(false); return value; }
    catch (failure) { const ambiguous = !(failure instanceof ApiError) || failure.kind === "server" || failure.kind === "offline"; setUncertain(ambiguous); if (!ambiguous) pending.current = undefined; setError(ambiguous ? "The save was not confirmed. Retry the unchanged request; do not create a replacement." : failure.message); throw failure; }
    finally { running.current = false; setBusy(false); }
  };
  return { execute, busy, uncertain, error, clear: () => { if (!running.current && !uncertain) setError(undefined); } };
}
export function mutationValue<T>(value: unknown, required: readonly string[]): T {
  if (!value || typeof value !== "object" || !("data" in value)) throw new ApiError("The service did not confirm the saved record.", { kind: "server", status: 502 });
  const data = (value as { data: unknown }).data;
  if (!data || typeof data !== "object" || required.some((key) => !(key in data))) throw new ApiError("The service did not confirm the saved record.", { kind: "server", status: 502 });
  return data as T;
}
export function quotedMoney(minor: number, currency: string): string { const digits = new Intl.NumberFormat("en-GB", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 10 ** digits); }
export function quotedMinor(input: string, currency: string): number {
  const digits = new Intl.NumberFormat("en-GB", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  if (!/^\d+(?:\.\d+)?$/u.test(input.trim()) || (input.split(".")[1]?.length ?? 0) > digits) throw new Error(`Use a non-negative price with at most ${digits} decimal places for ${currency}.`);
  const result = Math.round(Number(input) * 10 ** digits); if (!Number.isSafeInteger(result)) throw new Error("The price is too large."); return result;
}
export const revisionWorkflowPath = (projectId: string, revisionId: string) => `/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}`;
