import type { WorkflowRecord, WorkflowKind } from "@benchledger/api-contract";
import { DomainError } from "@benchledger/domain";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";
export function migrateMakerWorkflowSchema(database: BenchDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS maker_workflow_records (kind TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, revision_id TEXT, version INTEGER NOT NULL CHECK(version > 0), payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE INDEX IF NOT EXISTS maker_workflow_project_idx ON maker_workflow_records(kind,project_id,revision_id,id);
    CREATE TABLE IF NOT EXISTS maker_workflow_history (kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), record_json TEXT NOT NULL, PRIMARY KEY(kind,id,version));`);
}
function read(row: SqliteRow): WorkflowRecord {
  const payload: unknown = JSON.parse(String(row.payload_json));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new DomainError("integrity_error", "Workflow data is invalid");
  return { kind: String(row.kind) as WorkflowKind, id: String(row.id), projectId: String(row.project_id), ...(typeof row.revision_id === "string" ? { revisionId: row.revision_id } : {}), version: Number(row.version), payload: payload as Record<string, unknown>, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
export class MakerWorkflowRepository {
  constructor(private readonly database: BenchDatabase) {}
  get(kind: WorkflowKind, id: string): WorkflowRecord | null { const row = this.database.get("SELECT * FROM maker_workflow_records WHERE kind=? AND id=?", [kind, id]); return row ? read(row) : null; }
  list(kind: WorkflowKind, projectId: string, options: { revisionId?: string; limit: number; cursor?: string }) {
    const offset = Number(options.cursor ?? 0), condition = options.revisionId === undefined ? "" : " AND revision_id=?";
    const args = options.revisionId === undefined ? [kind, projectId] : [kind, projectId, options.revisionId];
    const rows = this.database.all(`SELECT * FROM maker_workflow_records WHERE kind=? AND project_id=?${condition} ORDER BY id LIMIT ? OFFSET ?`, [...args, options.limit + 1, offset]);
    return { data: rows.slice(0, options.limit).map(read), limit: options.limit, ...(rows.length > options.limit ? { nextCursor: String(offset + options.limit) } : {}) };
  }
  put(record: WorkflowRecord, expectedVersion: number): WorkflowRecord {
    return this.database.transaction(() => {
      const prior = this.get(record.kind, record.id);
      if ((prior?.version ?? 0) !== expectedVersion || record.version !== expectedVersion + 1) throw new DomainError("version_conflict", "This workflow changed. Refresh its current version before saving.");
      if (prior && (prior.projectId !== record.projectId || prior.revisionId !== record.revisionId)) throw new DomainError("integrity_error", "Workflow ancestry cannot be changed");
      this.database.run("INSERT INTO maker_workflow_records (kind,id,project_id,revision_id,version,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,payload_json=excluded.payload_json,updated_at=excluded.updated_at", [record.kind, record.id, record.projectId, record.revisionId ?? null, record.version, JSON.stringify(record.payload), record.createdAt, record.updatedAt]);
      this.database.run("INSERT INTO maker_workflow_history(kind,id,version,record_json) VALUES (?,?,?,?)", [record.kind, record.id, record.version, JSON.stringify(record)]);
      return record;
    });
  }
  history(kind: WorkflowKind, id: string, limit: number, cursor?: string) {
    const offset = Number(cursor ?? 0), rows = this.database.all("SELECT record_json FROM maker_workflow_history WHERE kind=? AND id=? ORDER BY version DESC LIMIT ? OFFSET ?", [kind, id, limit + 1, offset]);
    return { data: rows.slice(0, limit).map((row) => JSON.parse(String(row.record_json)) as WorkflowRecord), limit, ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}) };
  }
}
