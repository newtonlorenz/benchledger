import type { TeamMember, TeamStatus } from "@benchledger/api-contract";
import { teamMemberSchema } from "@benchledger/api-contract";
import { DomainError } from "@benchledger/domain";
import type { BenchDatabase } from "./sqlite.js";
export interface StoredTeamMember extends TeamMember { passwordHash: string }
export function migrateTeamSchema(database: BenchDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS maker_team_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
    INSERT OR IGNORE INTO maker_team_settings(id,enabled,version) VALUES(1,0,1);
    CREATE TABLE IF NOT EXISTS maker_team_members (id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL UNIQUE COLLATE NOCASE, version INTEGER NOT NULL, public_json TEXT NOT NULL, password_hash TEXT NOT NULL);`);
}
export class TeamRepository {
  constructor(private readonly db: BenchDatabase) {}
  status(): TeamStatus { const row = this.db.get("SELECT enabled,version FROM maker_team_settings WHERE id=1"); if (!row) throw new DomainError("integrity_error", "Team settings are missing"); return { enabled: row.enabled === 1, version: Number(row.version) }; }
  enable(expected: number): TeamStatus { const current = this.status(); if (current.version !== expected || current.enabled) throw new DomainError("version_conflict", "Team access changed; refresh the security settings."); this.db.run("UPDATE maker_team_settings SET enabled=1,version=version+1 WHERE id=1", []); return this.status(); }
  members(): StoredTeamMember[] { return this.db.all("SELECT public_json,password_hash FROM maker_team_members ORDER BY username LIMIT 201").map((row) => ({ ...teamMemberSchema.parse(JSON.parse(String(row.public_json))), passwordHash: String(row.password_hash) })); }
  get(id: string): StoredTeamMember | null { const row = this.db.get("SELECT public_json,password_hash FROM maker_team_members WHERE id=?", [id]); return row ? { ...teamMemberSchema.parse(JSON.parse(String(row.public_json))), passwordHash: String(row.password_hash) } : null; }
  put(member: StoredTeamMember, expected: number): StoredTeamMember {
    return this.db.transaction(() => { const prior = this.get(member.id); if ((prior?.version ?? 0) !== expected || member.version !== expected + 1) throw new DomainError("version_conflict", "This member changed. Refresh before editing."); const { passwordHash, ...safe } = member;
      this.db.run("INSERT INTO maker_team_members(id,username,version,public_json,password_hash) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,public_json=excluded.public_json,password_hash=excluded.password_hash", [member.id, member.username, member.version, JSON.stringify(safe), passwordHash]); return member; });
  }
}
