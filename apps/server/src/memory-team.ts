import type { TeamMemberSecret, TeamSecurityPort } from "@benchledger/application";
import { ApplicationError } from "@benchledger/application";
export class MemoryTeam implements TeamSecurityPort {
  private records = new Map<string, TeamMemberSecret>(); private state = { enabled: false, version: 1 };
  snapshot() { const records = structuredClone(this.records), state = { ...this.state }; return () => { this.records = records; this.state = state; }; }
  async status() { return { ...this.state }; }
  async enable(expected: number) { if (this.state.enabled || this.state.version !== expected) throw new ApplicationError("conflict", "Team access changed."); this.state = { enabled: true, version: expected + 1 }; return { ...this.state }; }
  async members() { return structuredClone([...this.records.values()]); }
  async get(id: string) { return structuredClone(this.records.get(id) ?? null); }
  async put(member: TeamMemberSecret, expected: number) { const current = this.records.get(member.id); if ((current?.version ?? 0) !== expected || member.version !== expected + 1) throw new ApplicationError("conflict", "Member version changed."); if ([...this.records.values()].some((entry) => entry.id !== member.id && entry.username === member.username)) throw new ApplicationError("conflict", "That username already exists."); this.records.set(member.id, structuredClone(member)); return structuredClone(member); }
}
