import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { createTeamMemberSchema, enableTeamSchema, updateTeamMemberSchema, teamPasswordSchema } from "@benchledger/api-contract";
import type { TeamMember, TeamStatus } from "@benchledger/api-contract";
import type { ApplicationPorts, RequestContext, TeamMemberSecret } from "./ports.js";
import { ApplicationError } from "./errors.js";
import type { ApplicationService } from "./service.js";
import type { AuditedWorkflowWriter } from "./maker-workflows.js";
const safe = ({ passwordHash: _secret, ...member }: TeamMemberSecret): TeamMember => member;
const derived = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (error, bytes) => error ? reject(error) : resolve(bytes)));
async function passwordHash(password: string) { const salt = randomBytes(24).toString("hex"); return `scrypt-v1$${salt}$${(await derived(password, salt)).toString("hex")}`; }
async function verify(password: string, encoded?: string) { const parts = encoded?.split("$"); const valid = parts?.length === 3 && parts[0] === "scrypt-v1" && /^[a-f0-9]{48}$/u.test(parts[1]!) && /^[a-f0-9]{64}$/u.test(parts[2]!); const actual = await derived(password, valid ? parts![1]! : "synthetic-constant-time-unknown-member"); const expected = valid ? Buffer.from(parts![2]!, "hex") : Buffer.alloc(32); return timingSafeEqual(actual, expected) && Boolean(valid); }
function owner(ctx: RequestContext) { if (!ctx.scopes.has("admin") || ctx.projectId) throw new ApplicationError("forbidden", "Only a workspace administrator may manage team access."); }
async function command(ctx: RequestContext, action: string, data: unknown) { if (!ctx.idempotencyKey || ctx.idempotencyKey.length < 8 || ctx.idempotencyKey.length > 200) throw new ApplicationError("validation", "A stable Idempotency-Key is required for account changes."); const salt = createHash("sha256").update(`${ctx.actor}:${action}:${ctx.idempotencyKey}`).digest("hex"); return { ...ctx, fingerprint: (await derived(JSON.stringify(data), salt)).toString("hex") }; }
function parsed<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T { if (!result.success) throw new ApplicationError("validation", result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return result.data; }
export class TeamService {
  constructor(private readonly ports: ApplicationPorts, private readonly app: ApplicationService, private readonly audited: AuditedWorkflowWriter) {}
  private store() { if (!this.ports.teamSecurity) throw new ApplicationError("forbidden", "Team access is not supported by this workspace."); return this.ports.teamSecurity; }
  async status(): Promise<TeamStatus> { return this.ports.teamSecurity ? this.ports.unitOfWork.exclusive(() => this.store().status()) : { enabled: false, version: 0 }; }
  async sessionState() { return this.ports.unitOfWork.exclusive(async () => { const status = await this.status(); return { ...status, members: status.enabled ? (await this.store().members()).map(safe) : [] }; }); }
  async directory(projectIds?: readonly string[]) { const state = await this.sessionState(); return { ...state, members: state.members.filter((member) => member.enabled && (projectIds === undefined || member.projectIds === undefined || member.projectIds.some((id) => projectIds.includes(id)))).map(({ id, name, role }) => ({ id, name, role })) }; }
  async adminDirectory(ctx: RequestContext) { owner(ctx); return this.sessionState(); }
  private async projectAccess(role: string, projectIds?: readonly string[]) { if (role === "admin" && projectIds !== undefined) throw new ApplicationError("validation", "Workspace administrators must have workspace-wide access."); if (projectIds && new Set(projectIds).size !== projectIds.length) throw new ApplicationError("validation", "Project assignments must be unique."); for (const projectId of projectIds ?? []) await this.app.getProject(projectId); }
  async verifyMember(username: string, password: string): Promise<TeamMember | null> {
    if (typeof username !== "string" || typeof password !== "string" || password.length > 512) return null;
    const selected = await this.ports.unitOfWork.exclusive(async () => { if (!(await this.status()).enabled) return null; return (await this.store().members()).find((member) => member.username === username.trim().toLowerCase()) ?? null; });
    const valid = await verify(password, selected?.passwordHash);
    if (!selected || !valid || !selected.enabled) return null;
    const fresh = await this.ports.unitOfWork.exclusive(() => this.store().get(selected.id));
    return fresh?.enabled && fresh.version === selected.version ? safe(fresh) : null;
  }
  async canAssign(memberId: string, projectId: string) { const member = await this.ports.unitOfWork.exclusive(() => this.store().get(memberId)); return Boolean(member?.enabled && (member.projectIds === undefined || member.projectIds.includes(projectId))); }
  async enable(input: unknown, ctx: RequestContext) {
    owner(ctx); const body = parsed(enableTeamSchema.safeParse(input)), action = "team.enabled";
    return this.audited(await command(ctx, action, body), action, "team", "workspace", async () => {
      const status = await this.store().status(); if (status.enabled) throw new ApplicationError("conflict", "Named account access is already enabled. Sign in with a member account.");
      const timestamp = new Date().toISOString(); const member: TeamMemberSecret = { id: `member-${randomUUID()}`, username: body.username, name: body.name, role: "admin", enabled: true, version: 1, createdAt: timestamp, updatedAt: timestamp, passwordHash: await passwordHash(body.password) };
      await this.store().put(member, 0); const access = await this.store().enable(status.version); return { value: { ...access, member: safe(member) }, entityId: "workspace", version: access.version };
    });
  }
  async create(input: unknown, ctx: RequestContext) {
    owner(ctx); const body = parsed(createTeamMemberSchema.safeParse(input)), action = "team.member.created";
    return this.audited(await command(ctx, action, body), action, "team", "workspace", async () => {
      if (!(await this.store().status()).enabled) throw new ApplicationError("conflict", "Enable named account access before adding members.");
      const members = await this.store().members(); if (members.length >= 200) throw new ApplicationError("quota_exceeded", "The workspace supports up to 200 named accounts.");
      if (members.some((member) => member.username === body.username)) throw new ApplicationError("conflict", "This username already exists. Update the existing account instead.");
      await this.projectAccess(body.role, body.projectIds); const timestamp = new Date().toISOString(); const { password, ...profile } = body;
      const member = { ...profile, id: `member-${randomUUID()}`, enabled: true, version: 1, createdAt: timestamp, updatedAt: timestamp, passwordHash: await passwordHash(password) };
      await this.store().put(member, 0); return { value: safe(member), entityId: member.id, version: member.version };
    });
  }
  async update(id: string, input: unknown, ctx: RequestContext) {
    owner(ctx); const body = parsed(updateTeamMemberSchema.safeParse(input)), action = "team.member.updated";
    return this.audited(await command(ctx, action, { id, body }), action, "team", id, async () => {
      const current = await this.store().get(id); if (!current) throw new ApplicationError("not_found", "The team member was not found.");
      const projectIds = body.projectIds === null ? undefined : body.projectIds ?? current.projectIds;
      await this.projectAccess(body.role, projectIds);
      if (current.enabled && current.role === "admin" && (!body.enabled || body.role !== "admin") && !(await this.store().members()).some((member) => member.id !== id && member.enabled && member.role === "admin")) throw new ApplicationError("conflict", "Keep at least one enabled workspace administrator.");
      const { projectIds: _prior, ...stable } = current; const member: TeamMemberSecret = { ...stable, name: body.name, role: body.role, enabled: body.enabled, ...(projectIds === undefined ? {} : { projectIds }), version: body.expectedVersion + 1, updatedAt: new Date().toISOString() };
      await this.store().put(member, body.expectedVersion); return { value: safe(member), entityId: id, version: member.version };
    });
  }
  async changePassword(id: string, input: unknown, ctx: RequestContext) {
    const body = parsed(teamPasswordSchema.safeParse(input)), action = "team.member.password_changed";
    const actorId = ctx.actor.startsWith("member:") ? ctx.actor.slice(7) : null;
    if (!actorId || (actorId !== id && !ctx.scopes.has("admin"))) throw new ApplicationError("forbidden", "Sign in with a named administrator or the target account before changing its password.");
    return this.audited(await command(ctx, action, { id, body }), action, "team", id, async () => {
      const actor = await this.store().get(actorId), current = await this.store().get(id);
      if (!actor?.enabled || !current || !await verify(body.currentPassword, actor.passwordHash)) throw new ApplicationError("forbidden", "Current account credentials could not be verified.");
      const member = { ...current, passwordHash: await passwordHash(body.newPassword), version: body.expectedVersion + 1, updatedAt: new Date().toISOString() };
      await this.store().put(member, body.expectedVersion); return { value: safe(member), entityId: id, version: member.version };
    });
  }
}
