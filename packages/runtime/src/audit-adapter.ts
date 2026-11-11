import { createAuditRecord, createId } from "@benchledger/domain";
import type { AuditActor, AuditRecord } from "@benchledger/domain";
import type { AuditEvent, AuditInput, AuditPort, Page, RequestSource, UnitOfWorkPort } from "@benchledger/application";
import { AuditRepository } from "@benchledger/database";
import type { BenchDatabase } from "@benchledger/database";
import { RuntimeState } from "./persistence.js";
import { attempt, parseOffsetCursor } from "./utils.js";

function actorType(source: RequestSource): AuditActor["type"] {
  switch (source) {
    case "mcp": return "agent";
    case "import": return "import";
    case "system": return "system";
    case "ui":
    case "api": return "human";
  }
}

/** Read back only the scalar change summary shape written by `append`. */
function auditChange(value: unknown): AuditEvent["change"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string | number | boolean] => typeof entry[1] === "string" || typeof entry[1] === "boolean" || (typeof entry[1] === "number" && Number.isFinite(entry[1])));
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export class ProductionAuditAdapter implements AuditPort {
  constructor(private readonly repository: AuditRepository, private readonly database: BenchDatabase, private readonly state: RuntimeState, private readonly unitOfWork: Pick<UnitOfWorkPort, "exclusive">) {}

  async append(input: AuditInput): Promise<AuditEvent> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const native = createAuditRecord({
        id: createId("audit"),
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        actor: { type: actorType(input.source), id: input.actor },
        sourceSurface: input.source,
        correlationId: input.correlationId,
        ...(input.version === undefined ? {} : { afterVersion: input.version }),
        ...(input.idempotencyKey === undefined && input.change === undefined ? {} : { metadata: {
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
          ...(input.change === undefined ? {} : { change: { ...input.change } })
        } })
      });
      const stored = this.repository.append(native);
      if (input.idempotencyKey !== undefined) this.state.setMetadata("audit", stored.id, { idempotencyKey: input.idempotencyKey });
      return {
        id: stored.id,
        action: stored.action,
        actor: stored.actor.id,
        source: stored.sourceSurface,
        correlationId: stored.correlationId,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        entityType: stored.entityType,
        entityId: stored.entityId,
        ...(stored.afterVersion === undefined ? {} : { version: stored.afterVersion }),
        ...(input.change === undefined ? {} : { change: { ...input.change } }),
        createdAt: stored.occurredAt
      };
    }));
  }

  async list(limit: number, cursor?: string): Promise<Page<AuditEvent>> {
    return this.unitOfWork.exclusive(() => attempt(() => this.pageOf(limit, cursor)));
  }

  async listEntity(entityType: string, entityId: string, limit: number, cursor?: string): Promise<Page<AuditEvent>> {
    return this.unitOfWork.exclusive(() => attempt(() => this.pageOf(limit, cursor, { type: entityType, id: entityId })));
  }

  private pageOf(limit: number, cursor: string | undefined, entity?: { readonly type: string; readonly id: string }): Page<AuditEvent> {
    const offset = parseOffsetCursor(cursor);
    const { records, total } = this.repository.page({ limit, offset, ...(entity === undefined ? {} : { entity }) });
    const data = records.map((record) => this.toEvent(record));
    const nextOffset = offset + data.length;
    return { data, limit, ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}), total };
  }

  private toEvent(record: AuditRecord): AuditEvent {
    // The audit row carries the key in its own metadata; older rows stored it
    // only in runtime metadata, so read that per returned row as a fallback.
    const own = record.metadata?.idempotencyKey;
    const idempotencyKey = typeof own === "string" ? own : this.state.getMetadata("audit", record.id).idempotencyKey;
    const change = auditChange(record.metadata?.change);
    return {
      id: record.id,
      action: record.action,
      actor: record.actor.id,
      source: record.sourceSurface,
      correlationId: record.correlationId,
      ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
      entityType: record.entityType,
      entityId: record.entityId,
      ...(record.afterVersion === undefined ? {} : { version: record.afterVersion }),
      ...(change === undefined ? {} : { change }),
      createdAt: record.occurredAt
    } satisfies AuditEvent;
  }
}
