import { createCorrelationId, createId, nowIso } from "./ids.js";
import type { AuditActor, AuditRecord } from "./types.js";

export interface NewAuditRecord {
  id?: string;
  action: string;
  entityType: string;
  entityId: string;
  actor: AuditActor;
  sourceSurface: AuditRecord["sourceSurface"];
  occurredAt?: string;
  correlationId?: string;
  beforeVersion?: number;
  afterVersion?: number;
  metadata?: Record<string, unknown>;
}

export function createAuditRecord(input: NewAuditRecord): AuditRecord {
  const occurredAt = input.occurredAt ?? nowIso();
  return {
    id: input.id ?? createId("audit"),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    actor: { ...input.actor },
    sourceSurface: input.sourceSurface,
    occurredAt,
    correlationId: input.correlationId ?? createCorrelationId(),
    ...(input.beforeVersion === undefined ? {} : { beforeVersion: input.beforeVersion }),
    ...(input.afterVersion === undefined ? {} : { afterVersion: input.afterVersion }),
    ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } })
  };
}
