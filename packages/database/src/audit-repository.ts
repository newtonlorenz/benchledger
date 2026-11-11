import type { AuditRecord } from "@benchledger/domain";
import { auditFromRow, jsonValue } from "./serializers.js";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";

export class AuditRepository {
  constructor(private readonly database: BenchDatabase) {}

  append(record: AuditRecord): AuditRecord {
    this.database.run("INSERT INTO audit_log (id, action, entity_type, entity_id, actor_json, source_surface, occurred_at, correlation_id, before_version, after_version, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.action, record.entityType, record.entityId, jsonValue(record.actor) as string, record.sourceSurface, record.occurredAt, record.correlationId, record.beforeVersion ?? null, record.afterVersion ?? null, jsonValue(record.metadata)]);
    return record;
  }

  /**
   * One page of audit history, oldest first, with ordering, filtering and
   * LIMIT/OFFSET in SQL. An entity filter always uses both type and id so the
   * (entity_type, entity_id, occurred_at, id) index serves it.
   */
  page(options: { readonly limit: number; readonly offset: number; readonly entity?: { readonly type: string; readonly id: string } }): { readonly records: readonly AuditRecord[]; readonly total: number } {
    const where = options.entity === undefined ? "" : "WHERE entity_type = ? AND entity_id = ?";
    const parameters = options.entity === undefined ? [] : [options.entity.type, options.entity.id];
    const total = Number(this.database.get<SqliteRow>(`SELECT COUNT(*) AS total FROM audit_log ${where}`, parameters)?.total ?? 0);
    const rows = this.database.all<SqliteRow>(`SELECT * FROM audit_log ${where} ORDER BY occurred_at, id LIMIT ? OFFSET ?`, [...parameters, options.limit, options.offset]);
    return { records: rows.map(auditFromRow), total };
  }

  list(entityId?: string): readonly AuditRecord[] {
    const rows = entityId === undefined
      ? this.database.all<SqliteRow>("SELECT * FROM audit_log ORDER BY occurred_at, id", [])
      : this.database.all<SqliteRow>("SELECT * FROM audit_log WHERE entity_id = ? ORDER BY occurred_at, id", [entityId]);
    return rows.map(auditFromRow);
  }
}
