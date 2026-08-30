import type { AuditRecord } from "@benchledger/domain";
import { auditFromRow, jsonValue } from "./serializers.js";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";

export class AuditRepository {
  constructor(private readonly database: BenchDatabase) {}

  append(record: AuditRecord): AuditRecord {
    this.database.run("INSERT INTO audit_log (id, action, entity_type, entity_id, actor_json, source_surface, occurred_at, correlation_id, before_version, after_version, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.action, record.entityType, record.entityId, jsonValue(record.actor) as string, record.sourceSurface, record.occurredAt, record.correlationId, record.beforeVersion ?? null, record.afterVersion ?? null, jsonValue(record.metadata)]);
    return record;
  }

  list(entityId?: string): readonly AuditRecord[] {
    const rows = entityId === undefined
      ? this.database.all<SqliteRow>("SELECT * FROM audit_log ORDER BY occurred_at, id", [])
      : this.database.all<SqliteRow>("SELECT * FROM audit_log WHERE entity_id = ? ORDER BY occurred_at, id", [entityId]);
    return rows.map(auditFromRow);
  }
}
