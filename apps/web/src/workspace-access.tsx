import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "./api";
import type { WorkspaceAccess, WorkspaceAccessRetry, WorkspaceAccessUpdateInput, WorkspaceAccessUpdateOptions, WorkspaceAccessUpdateResult } from "./api";
import { Icon } from "./icons";

export const LAN_OPEN_WARNING = "Anyone who can reach this BenchLedger address can view inventory, change records, and change workspace security settings. Use LAN-open mode only on a trusted network. Enable a password before using guest Wi-Fi, port forwarding, internet exposure, or a public reverse proxy.";

export interface WorkspaceAccessSectionProps {
  access: WorkspaceAccess;
  onUpdate: (input: WorkspaceAccessUpdateInput, expectedVersion?: number, options?: WorkspaceAccessUpdateOptions) => Promise<WorkspaceAccessUpdateResult>;
  onChanged: (access: WorkspaceAccess) => void;
  onRebootstrap: () => Promise<void> | void;
  pendingRetry?: WorkspaceAccessRetry | undefined;
  onClearRetry?: () => void;
}

type AccessAction = "enable" | "change" | "disable";

function accessError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.code === "invalid_credentials") return "The current password is not correct.";
    if (error.status === 409 || error.code === "version_conflict" || error.code === "stale_settings") return "Workspace security settings changed elsewhere. Reload settings and try again.";
    if (error.kind === "offline") return "We could not confirm the change. It may have been saved; reload settings before trying again.";
    if (error.kind === "csrf" || error.kind === "unauthenticated") return "Your session expired. Reload settings and sign in again before changing workspace security.";
    return error.message;
  }
  return "We could not change workspace security. Nothing was confirmed; reload settings before trying again.";
}

function actionLabel(action: AccessAction): string {
  if (action === "enable") return "Enable password";
  if (action === "disable") return "Disable password protection";
  return "Change password";
}

function PasswordField({ label, id, value, onChange, autoComplete, required = true }: { label: string; id: string; value: string; onChange: (value: string) => void; autoComplete: string; required?: boolean }) {
  return <label className="form-field"><span>{label}</span><input id={id} type="password" value={value} required={required} minLength={12} autoComplete={autoComplete} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function WorkspaceAccessSection({ access, onUpdate, onChanged, onRebootstrap, pendingRetry, onClearRetry }: WorkspaceAccessSectionProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [action, setAction] = useState<AccessAction>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [reloading, setReloading] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(pendingRetry !== undefined);
  const pendingAction: AccessAction | undefined = pendingRetry?.operation === "change_password" ? "change" : pendingRetry?.operation;

  const clearForm = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    setError(undefined);
  };

  const startNewChange = () => {
    onClearRetry?.();
    setRetryAvailable(false);
    clearForm();
    setStatus("Enter the credentials for a new security change.");
  };

  const submit = async (event: FormEvent, requestedAction: Exclude<AccessAction, "disable">) => {
    event.preventDefault();
    if (newPassword.length < 12) { setError("Use at least 12 characters for the new password."); return; }
    if (newPassword !== confirmation) { setError("The new passwords do not match."); return; }
    if (requestedAction === "change" && !currentPassword) { setError("Enter the current password to change it."); return; }
    setAction(requestedAction);
    setError(undefined);
    setStatus(undefined);
    try {
      const input: WorkspaceAccessUpdateInput = requestedAction === "change"
        ? { operation: "change_password", currentPassword, newPassword }
        : { operation: "enable", newPassword };
      const retryingThisAction = retryAvailable && pendingAction === requestedAction;
      const expectedVersion = retryingThisAction ? pendingRetry?.expectedVersion : access.version;
      const result = await onUpdate(input, expectedVersion, { retry: retryingThisAction });
      onChanged(result.access);
      clearForm();
      setRetryAvailable(false);
      setStatus(requestedAction === "enable" ? "Password protection is enabled." : "Password changed. Your current session remains active.");
    } catch (updateError) {
      setError(accessError(updateError));
      if (updateError instanceof ApiError && updateError.kind === "offline") setRetryAvailable(true);
      if (updateError instanceof ApiError && (updateError.kind === "offline" || updateError.status === 409)) setStatus(undefined);
    } finally {
      setAction(undefined);
    }
  };

  const disable = async () => {
    if (!currentPassword) { setError("Enter the current password to disable protection."); return; }
    setAction("disable");
    setError(undefined);
    setStatus(undefined);
    try {
      const retryingThisAction = retryAvailable && pendingAction === "disable";
      const expectedVersion = retryingThisAction ? pendingRetry?.expectedVersion : access.version;
      const result = await onUpdate({ operation: "disable", currentPassword }, expectedVersion, { retry: retryingThisAction });
      onChanged(result.access);
      clearForm();
      setRetryAvailable(false);
      setStatus("Password protection is disabled. BenchLedger is LAN open.");
    } catch (updateError) {
      setError(accessError(updateError));
      if (updateError instanceof ApiError && updateError.kind === "offline") setRetryAvailable(true);
    } finally {
      setAction(undefined);
    }
  };

  const rebootstrap = async () => {
    setReloading(true);
    setError(undefined);
    setStatus(undefined);
    try { await onRebootstrap(); } catch (reloadError) { setError(accessError(reloadError)); } finally { setReloading(false); }
  };

  const passwordMode = access.mode === "password";
  return <section className="surface settings-section workspace-access-section" aria-labelledby="workspace-access-title">
    <div className="section-heading"><div><span className="eyebrow">Security</span><h2 id="workspace-access-title">Workspace access</h2></div><span className={`access-mode-badge ${passwordMode ? "is-password" : "is-lan-open"}`}>{passwordMode ? "Password required" : "LAN open"}</span></div>
    {!passwordMode && !(retryAvailable && pendingAction === "disable") && <>
      <p className="workspace-access-warning" role="alert">{LAN_OPEN_WARNING}</p>
      <p className="workspace-access-intro">Anyone on this trusted LAN can use the workspace. Enable a password when this address could be reached by someone you do not trust.</p>
      <form className="workspace-access-form" aria-label="Enable workspace password" onSubmit={(event) => { void submit(event, "enable"); }}>
        <PasswordField label="New workspace password" id="new-workspace-password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
        <PasswordField label="Confirm new workspace password" id="confirm-workspace-password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" />
        <button className="button button-primary" type="submit" disabled={action !== undefined}>{action === "enable" ? "Enabling…" : "Enable password"}<Icon name="arrow-right" size={16} /></button>
      </form>
    </>}
    {passwordMode && retryAvailable && pendingAction === "enable" && <>
      <p className="workspace-access-intro">A previous password-enable request may have succeeded before the response was lost. Sign in with that new password, then re-enter it here to safely replay the same request.</p>
      <form className="workspace-access-form" aria-label="Retry enabling workspace password" onSubmit={(event) => { void submit(event, "enable"); }}>
        <PasswordField label="New workspace password" id="retry-new-workspace-password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
        <PasswordField label="Confirm new workspace password" id="retry-confirm-workspace-password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" />
        <button className="button button-primary" type="submit" disabled={action !== undefined}>{action === "enable" ? "Retrying…" : "Retry enable"}<Icon name="arrow-right" size={16} /></button>
      </form>
    </>}
    {passwordMode && !(retryAvailable && pendingAction === "enable") && <>
      <p className="workspace-access-intro">A password is required before anyone can open this workspace. Bearer tokens for MCP agents remain required and are not changed here.</p>
      <form className="workspace-access-form" aria-label="Change workspace password" onSubmit={(event) => { void submit(event, "change"); }}>
        <PasswordField label="Current workspace password" id="current-workspace-password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
        <PasswordField label="New workspace password" id="new-workspace-password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
        <PasswordField label="Confirm new workspace password" id="confirm-workspace-password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" />
        <button className="button button-primary" type="submit" disabled={action !== undefined}>{action === "change" ? "Changing…" : "Change password"}<Icon name="arrow-right" size={16} /></button>
      </form>
      <div className="workspace-access-disable"><p>Disable the password only when this address is on a trusted LAN.</p><PasswordField label="Current workspace password to disable protection" id="disable-workspace-password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" /><button className="button button-quiet" type="button" onClick={() => { void disable(); }} disabled={action !== undefined}>{action === "disable" ? "Disabling…" : actionLabel("disable")}</button></div>
    </>}
    {!passwordMode && retryAvailable && pendingAction === "disable" && <div className="workspace-access-disable workspace-access-recovery"><p>A previous disable request may have succeeded before the response was lost. Re-enter the current password to safely replay it.</p><PasswordField label="Current workspace password to retry disabling protection" id="retry-disable-workspace-password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" /><button className="button button-quiet" type="button" onClick={() => { void disable(); }} disabled={action !== undefined}>{action === "disable" ? "Retrying…" : "Retry disable"}</button></div>}
    {error && <p className="form-error workspace-access-error" role="alert">{error}</p>}
    {status && <p className="workspace-access-status" role="status">{status}</p>}
    {retryAvailable && <p className="workspace-access-retry-note" role="status">A previous request was not confirmed. Re-enter the same credentials to retry it with the same safe request key.</p>}
    {retryAvailable && <button className="text-button workspace-access-new" type="button" onClick={startNewChange}>Start a new security change</button>}
    {(error?.includes("Reload") || error?.includes("confirm")) && <button className="text-button workspace-access-reload" type="button" onClick={() => { void rebootstrap(); }} disabled={reloading}><Icon name="refresh" size={15} />{reloading ? "Reloading settings…" : "Reload settings"}</button>}
  </section>;
}
