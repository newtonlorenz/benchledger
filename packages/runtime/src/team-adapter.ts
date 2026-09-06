import type { TeamSecurityPort, TeamMemberSecret } from "@benchledger/application";
import { TeamRepository } from "@benchledger/database";
import { attempt } from "./utils.js";
export class ProductionTeamAdapter implements TeamSecurityPort {
  constructor(private readonly repository: TeamRepository) {}
  status() { return attempt(() => this.repository.status()); }
  enable(expected: number) { return attempt(() => this.repository.enable(expected)); }
  members() { return attempt(() => this.repository.members()); }
  get(id: string) { return attempt(() => this.repository.get(id)); }
  put(member: TeamMemberSecret, expected: number) { return attempt(() => this.repository.put(member, expected)); }
}
