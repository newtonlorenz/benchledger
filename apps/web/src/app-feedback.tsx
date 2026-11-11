import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, conflictReason } from "./api";
import { Icon } from "./icons";

/**
 * Shared app-level feedback: toasts, write-failure wording, sync status,
 * focus revalidation and the session-expiry sign-in overlay. Kept out of
 * App.tsx so the behaviour is unit-testable without booting the workspace.
 */

export type ToastTone = "success" | "info" | "warning" | "error";
export interface ToastAction { readonly label: string; readonly run: () => void }
export interface ToastState { readonly message: string; readonly tone: ToastTone; readonly nonce: number; readonly action?: ToastAction }

/** Success/info confirmations fade; warnings and errors wait for the maker. */
export const TOAST_AUTO_DISMISS_MS = 5000;
export function toastAutoDismissMs(tone: ToastTone): number | undefined {
  return tone === "success" || tone === "info" ? TOAST_AUTO_DISMISS_MS : undefined;
}

/**
 * One visible toast. `routeKey` changes clear transient (success/info)
 * toasts so a confirmation never follows the maker to an unrelated page.
 */
export function useToast(routeKey: string) {
  const [toast, setToast] = useState<ToastState>();
  const nonce = useRef(0);
  const show = useCallback((message: string, tone: ToastTone = "success", action?: ToastAction) => {
    nonce.current += 1;
    setToast({ message, tone, nonce: nonce.current, ...(action ? { action } : {}) });
  }, []);
  const dismiss = useCallback(() => setToast(undefined), []);
  useEffect(() => {
    if (!toast) return;
    const delay = toastAutoDismissMs(toast.tone);
    if (delay === undefined) return;
    const timeout = window.setTimeout(() => setToast((current) => current?.nonce === toast.nonce ? undefined : current), delay);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  const previousRoute = useRef(routeKey);
  // Nonce of the toast that was visible before this render committed. A
  // toast raised in the same update as the navigation (for example "Project
  // created" while opening it) belongs to the new route and must survive.
  const committedNonce = useRef(0);
  useEffect(() => {
    if (previousRoute.current === routeKey) return;
    previousRoute.current = routeKey;
    const stale = committedNonce.current;
    setToast((current) => current && current.nonce <= stale && toastAutoDismissMs(current.tone) !== undefined ? undefined : current);
  }, [routeKey]);
  useEffect(() => { committedNonce.current = toast?.nonce ?? committedNonce.current; }, [toast]);
  return { toast, show, dismiss };
}

export function ToastRegion({ toast, onDismiss }: { toast: ToastState | undefined; onDismiss: () => void }) {
  if (!toast) return null;
  const urgent = toast.tone === "error" || toast.tone === "warning";
  const icon = toast.tone === "success" ? "check-circle" : toast.tone === "info" ? "info" : "warning";
  return (
    <div className={`toast toast-${toast.tone} app-toast`} role={urgent ? "alert" : "status"} key={toast.nonce}>
      <Icon name={icon} size={18} />
      <span>{toast.message}</span>
      {toast.action && <button type="button" className="button button-quiet toast-action" onClick={() => { toast.action?.run(); onDismiss(); }}>{toast.action.label}</button>}
      <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={onDismiss}><Icon name="close" size={15} /></button>
    </div>
  );
}

export const ambiguousSaveMessage = "We couldn't confirm whether this saved.";
export const staleConflictMessage = "This changed elsewhere — reload to see the latest.";

/** Explain a failed write without claiming an outcome the browser cannot know. */
export function writeFailureMessage(error: ApiError, action: string): string {
  if (error.kind === "unauthenticated" || error.kind === "csrf") return `Cannot complete ${action}. Sign in again. Nothing was saved.`;
  if (error.kind === "conflict") {
    const reason = conflictReason(error);
    if (reason === "stale") return staleConflictMessage;
    if (reason === "idempotency") return `Cannot complete ${action}. A retry did not match the original request. Reload to see the latest, then try again.`;
    return `Cannot complete ${action}. ${error.message}`;
  }
  if (error.kind === "validation") {
    const issues = error.issues?.map((issue) => issue.message.trim().replace(/\.?$/u, ".")).slice(0, 4);
    return issues?.length ? `Cannot complete ${action}. ${issues.join(" ")}` : `Cannot complete ${action}. Check the values and try again.`;
  }
  if (error.kind === "forbidden") return `Cannot complete ${action}. This account is not allowed to do that. Nothing was saved.`;
  // Offline and server failures can happen after the server committed.
  return `${ambiguousSaveMessage} Reload to check before ${action} again.`;
}

/** Whether a failed write may still have committed on the server. */
export function isAmbiguousMutation(error: ApiError): boolean {
  return !["validation", "conflict", "forbidden", "unauthenticated", "csrf"].includes(error.kind);
}

/** Whether a failure says something about connectivity (shown as sync status). */
export function isSyncFailure(error: ApiError | undefined): error is ApiError {
  return error !== undefined && (error.kind === "offline" || error.kind === "server");
}

export function formatUpdatedAgo(lastSyncedAt: number | undefined, now: number): string {
  if (lastSyncedAt === undefined) return "not updated yet";
  const seconds = Math.max(0, Math.round((now - lastSyncedAt) / 1000));
  if (seconds < 45) return "updated just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.round(hours / 24)}d ago`;
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(interval);
  }, [intervalMs]);
  return now;
}

export function SyncStatusNote({ sampleMode, error, lastSyncedAt, now }: { sampleMode: boolean; error: ApiError | undefined; lastSyncedAt: number | undefined; now: number }) {
  if (sampleMode) return <div className="connection-note"><span className="online-dot" /><span>Sample workspace</span></div>;
  const failed = isSyncFailure(error);
  return (
    <div className={`connection-note${failed ? " is-stale" : ""}`} data-sync-state={failed ? "stale" : "connected"}>
      <span className={failed ? "offline-dot" : "online-dot"} />
      <span>{failed ? "Not syncing" : "Connected"}<small>{formatUpdatedAgo(lastSyncedAt, now)}</small></span>
    </div>
  );
}

/** Non-blocking notice shown while the last sync failed; the data stays usable. */
export function SyncBanner({ error, lastSyncedAt, now, retrying, onRetry }: { error: ApiError | undefined; lastSyncedAt: number | undefined; now: number; retrying: boolean; onRetry: () => void }) {
  if (!isSyncFailure(error)) return null;
  return (
    <div className="sync-banner" role="status">
      <Icon name="warning" size={17} />
      <span><strong>{error.kind === "offline" ? "BenchLedger can't reach the service." : "The service reported a problem."}</strong> Showing what was loaded {formatUpdatedAgo(lastSyncedAt, now).replace(/^updated /u, "")}. Changes may not save.</span>
      <button type="button" className="button button-quiet" disabled={retrying} aria-busy={retrying || undefined} onClick={onRetry}>{retrying ? "Retrying…" : "Retry"}</button>
    </div>
  );
}

/**
 * Re-run `revalidate` when the window regains focus or becomes visible,
 * at most once per `minIntervalMs`. `enabled` lets callers skip it while
 * a draft is open or the session is not usable.
 */
export function useRevalidateOnFocus(revalidate: () => void, { enabled, minIntervalMs = 60_000 }: { enabled: boolean; minIntervalMs?: number }) {
  const latest = useRef(revalidate);
  latest.current = revalidate;
  const lastRun = useRef(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const maybeRun = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastRun.current < minIntervalMs) return;
      lastRun.current = now;
      latest.current();
    };
    window.addEventListener("focus", maybeRun);
    document.addEventListener("visibilitychange", maybeRun);
    return () => { window.removeEventListener("focus", maybeRun); document.removeEventListener("visibilitychange", maybeRun); };
  }, [enabled, minIntervalMs]);
}

/**
 * Sign-in form shown above a still-mounted workspace when the session
 * expires, so open drafts survive re-authentication.
 */
export function SessionExpiredOverlay({ onLogin }: { onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onLogin(password);
    } catch (failure: unknown) {
      setError(failure instanceof ApiError && failure.kind === "unauthenticated" ? "That password was not accepted." : failure instanceof Error ? failure.message : "Sign-in failed.");
      setSubmitting(false);
    }
  };
  return (
    <div className="session-overlay" role="presentation">
      <section className="session-overlay-panel" role="alertdialog" aria-modal="true" aria-labelledby="session-overlay-title" aria-describedby="session-overlay-copy">
        <h2 id="session-overlay-title">Sign in to continue</h2>
        <p id="session-overlay-copy">Your session ended. Anything you were typing is still here; sign in and carry on where you left off.</p>
        <form onSubmit={submit}>
          <label className="field"><span>Workspace password</span><input ref={input} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" className="button button-primary" disabled={!password || submitting} aria-busy={submitting || undefined}>{submitting ? "Signing in…" : "Sign in"}</button>
        </form>
      </section>
    </div>
  );
}
