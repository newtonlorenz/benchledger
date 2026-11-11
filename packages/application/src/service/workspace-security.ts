import { ApplicationError } from "../errors.js";
import type { ApplicationPorts, Mutation, RequestContext } from "../ports.js";

import { workspaceSecurityMutationSchema, workspaceSecurityStatusSchema } from "@benchledger/api-contract";
import type { WorkspaceSecurityMutation } from "@benchledger/api-contract";
import { ServiceModule } from "./module.js";

export const WORKSPACE_SECURITY_ENTITY_ID = "workspace";

/**
 * Password commands must not derive idempotency data from plaintext or an
 * encoded credential. Hosts must provide an opaque, secret-keyed request
 * fingerprint (for example, a transport-level HMAC digest).
 */
export function workspaceSecurityCommandContext(ctx: RequestContext): RequestContext {
  if (ctx.fingerprint === undefined || ctx.fingerprint.length === 0 || ctx.fingerprint.length > 512) {
    throw new ApplicationError("validation", "Password commands require an opaque request fingerprint");
  }
  return ctx;
}

export function workspaceSecurityPort(ports: ApplicationPorts): NonNullable<ApplicationPorts["workspaceSecurity"]> {
  if (ports.workspaceSecurity === undefined) throw new ApplicationError("integrity_error", "This runtime does not support workspace security settings");
  return ports.workspaceSecurity;
}

/** Workspace access mode and password changes (audited, never exposing hashes). */
export class WorkspaceSecurityModule extends ServiceModule {
  async getWorkspaceSecurityStatus(): Promise<import("@benchledger/api-contract").WorkspaceSecurityStatus> {
    return this.ports.unitOfWork.exclusive(async () => workspaceSecurityStatusSchema.parse(await workspaceSecurityPort(this.ports).getStatus()));
  }

  /** Verify a password at the storage boundary without exposing its hash. */

  async verifyWorkspacePassword(password: string): Promise<boolean> {
    if (typeof password !== "string" || password.length === 0) return false;
    return this.ports.unitOfWork.exclusive(() => workspaceSecurityPort(this.ports).verifyPassword(password));
  }

  /** Hashing happens in the runtime after idempotency lookup. */

  async enableWorkspacePassword(newPassword: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    const commandContext = workspaceSecurityCommandContext(ctx);
    return this.mutate(commandContext, "password_enabled", "workspace_security", WORKSPACE_SECURITY_ENTITY_ID, async () => {
      if (typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 512) {
        throw new ApplicationError("validation", "New password must contain between 12 and 512 characters");
      }
      const status = workspaceSecurityStatusSchema.parse(await workspaceSecurityPort(this.ports).enablePassword(newPassword, expectedVersion));
      return { value: status, entityId: WORKSPACE_SECURITY_ENTITY_ID, version: status.version, eventMetadata: { mode: status.mode } };
    });
  }

  async disableWorkspacePassword(currentPassword: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    const commandContext = workspaceSecurityCommandContext(ctx);
    return this.mutate(commandContext, "password_disabled", "workspace_security", WORKSPACE_SECURITY_ENTITY_ID, async () => {
      if (typeof currentPassword !== "string" || currentPassword.length < 12 || currentPassword.length > 512) {
        throw new ApplicationError("validation", "Current password must contain between 12 and 512 characters");
      }
      const status = workspaceSecurityStatusSchema.parse(await workspaceSecurityPort(this.ports).disablePassword(currentPassword, expectedVersion));
      return { value: status, entityId: WORKSPACE_SECURITY_ENTITY_ID, version: status.version, eventMetadata: { mode: status.mode } };
    });
  }

  /** Change the password at the trusted verification boundary. */

  async changeWorkspacePassword(input: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    const commandContext = workspaceSecurityCommandContext(ctx);
    return this.mutate(commandContext, "password_changed", "workspace_security", WORKSPACE_SECURITY_ENTITY_ID, async () => {
      if (typeof input.currentPassword !== "string" || input.currentPassword.length < 12 || input.currentPassword.length > 512 || typeof input.newPassword !== "string" || input.newPassword.length < 12 || input.newPassword.length > 512) {
        throw new ApplicationError("validation", "Current and new passwords must contain between 12 and 512 characters");
      }
      const status = workspaceSecurityStatusSchema.parse(await workspaceSecurityPort(this.ports).changePassword(input, expectedVersion));
      return { value: status, entityId: WORKSPACE_SECURITY_ENTITY_ID, version: status.version, eventMetadata: { mode: status.mode } };
    });
  }

  /** Canonical public operation dispatcher shared by REST, UI, and agents. */

  async updateWorkspaceSecurity(input: WorkspaceSecurityMutation, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    const parsed = workspaceSecurityMutationSchema.parse(input) as WorkspaceSecurityMutation;
    if (parsed.operation === "enable") return this.enableWorkspacePassword(parsed.newPassword, parsed.expectedVersion, ctx);
    if (parsed.operation === "disable") return this.disableWorkspacePassword(parsed.currentPassword, parsed.expectedVersion, ctx);
    return this.changeWorkspacePassword({ currentPassword: parsed.currentPassword, newPassword: parsed.newPassword }, parsed.expectedVersion, ctx);
  }
}
