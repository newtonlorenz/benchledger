import { ApplicationError } from "../errors.js";
import type { ApplicationPorts, AuditEvent, AuditInput, BulkMutation, EventBusEvent, InventoryBulkUpdateResult, Mutation, RequestContext } from "../ports.js";
import { createHash } from "node:crypto";

/** The single-entity outcome an audited command operation returns. */
export interface MutationOutcome<T> {
  readonly value: T;
  readonly entityId: string;
  readonly version?: number;
  readonly eventMetadata?: Readonly<Record<string, unknown>>;
  /** Allow an aggregate result to include the single audit identity. */
  readonly withAudit?: (audit: AuditEvent) => T;
  /** Cleanup for filesystem state if the audited mutation cannot commit. */
  readonly compensate?: () => Promise<void>;
}

/**
 * Shared audited command runner. Every application mutation goes through
 * `mutate` (or `mutateBulk` for the inventory batch): it runs inside the
 * unit of work, replays idempotent retries, appends the audit event, stores
 * the idempotent result, and publishes the post-commit event.
 */
export class CommandRunner {
  constructor(private readonly ports: ApplicationPorts) {}

  async mutate<T>(
    ctx: RequestContext,
    action: string,
    entityType: string,
    provisionalEntityId: string,
    operation: () => Promise<MutationOutcome<T>>
  ): Promise<Mutation<T>> {
    const fingerprint = ctx.fingerprint ?? `${action}:${entityType}:${provisionalEntityId}`;
    let compensate: (() => Promise<void>) | undefined;
    let committed: { readonly mutation: Mutation<T>; readonly event: EventBusEvent | undefined };
    try {
      committed = await this.ports.unitOfWork.run(async () => {
        if (ctx.idempotencyKey) {
          const prior = await this.ports.idempotency.get(ctx.actor, ctx.idempotencyKey);
          if (prior !== null) {
            const stored = prior as { readonly action?: string; readonly fingerprint?: string; readonly mutation?: Mutation<T> };
            if (stored.mutation) {
              if (stored.action !== action || (stored.fingerprint !== undefined && stored.fingerprint !== fingerprint)) {
                throw new ApplicationError("idempotency_conflict", "Idempotency key was already used for a different command", {
                  reason: "idempotency_key_reused",
                  field: "idempotencyKey",
                  id: ctx.idempotencyKey,
                  retryable: false,
                  commitState: "not_committed",
                  commandId: ctx.idempotencyKey,
                });
              }
              return { mutation: { ...stored.mutation, replayed: true }, event: undefined };
            }
            return { mutation: { ...(prior as Mutation<T>), replayed: true }, event: undefined };
          }
        }
        const result = await operation();
        compensate = result.compensate;
        const auditInput: AuditInput = {
          action,
          actor: ctx.actor,
          source: ctx.source,
          correlationId: ctx.correlationId,
          ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
          entityType,
          entityId: result.entityId || provisionalEntityId,
          ...(result.version !== undefined ? { version: result.version } : {})
        };
        const audit = await this.ports.audit.append(auditInput);
        const mutation: Mutation<T> = { data: result.withAudit?.(audit) ?? result.value, audit, correlationId: ctx.correlationId, replayed: false };
        if (ctx.idempotencyKey) await this.ports.idempotency.set(ctx.actor, ctx.idempotencyKey, { action, fingerprint, mutation });
        const event: EventBusEvent = {
          id: audit.id,
          type: action,
          entityType,
          entityId: result.entityId || provisionalEntityId,
          ...(result.version !== undefined ? { version: result.version } : {}),
          correlationId: ctx.correlationId,
          at: audit.createdAt,
          ...(result.eventMetadata === undefined ? {} : { metadata: { ...result.eventMetadata } })
        };
        return { mutation, event };
      });
    } catch (error: unknown) {
      if (compensate !== undefined) {
        try {
          await compensate();
        } catch {
          throw new ApplicationError("integrity_error", "The mutation failed and artifact state could not be compensated");
        }
      }
      throw error;
    }
    if (committed.event !== undefined) {
      // Event delivery is deliberately post-commit. A listener is an
      // integration boundary and must not turn a durable mutation into a
      // failed/retryable command after SQLite has committed it.
      try {
        this.ports.events.publish(committed.event);
      } catch {
        // Event subscribers are best-effort; the committed audit/idempotency
        // record remains the source of truth for replay and reconciliation.
      }
    }
    return committed.mutation;
  }

  /**
   * Audited orchestration for one atomic inventory batch. The inventory port
   * owns the all-or-nothing state transition; this layer adds one idempotency
   * record and one audit/event pair for each actually changed item.
   */

  async mutateBulk(
    ctx: RequestContext,
    operation: () => Promise<InventoryBulkUpdateResult>,
  ): Promise<BulkMutation<InventoryBulkUpdateResult>> {
    const action = "inventory.item.bulk_update";
    const fingerprint = ctx.fingerprint ?? action;
    let committed: {
      readonly mutation: BulkMutation<InventoryBulkUpdateResult>;
      readonly events: readonly EventBusEvent[];
    };
    committed = await this.ports.unitOfWork.run(async () => {
      if (ctx.idempotencyKey) {
        const prior = await this.ports.idempotency.get(ctx.actor, ctx.idempotencyKey);
        if (prior !== null) {
          const stored = prior as { readonly action?: string; readonly fingerprint?: string; readonly mutation?: BulkMutation<InventoryBulkUpdateResult> };
          if (stored.mutation) {
            if (stored.action !== action || (stored.fingerprint !== undefined && stored.fingerprint !== fingerprint)) {
              throw new ApplicationError("idempotency_conflict", "Idempotency key was already used for a different command");
            }
            return { mutation: { ...stored.mutation, replayed: true }, events: [] };
          }
          throw new ApplicationError("idempotency_conflict", "Idempotency key belongs to a different mutation shape");
        }
      }

      const data = await operation();
      const audits: AuditEvent[] = [];
      for (const item of data.updated) {
        const auditIdempotencyKey = ctx.idempotencyKey === undefined
          ? undefined
          : `bulk:${createHash("sha256").update(`${ctx.actor}:${ctx.idempotencyKey}:${item.id}`).digest("hex")}`;
        audits.push(await this.ports.audit.append({
          action,
          actor: ctx.actor,
          source: ctx.source,
          correlationId: ctx.correlationId,
          ...(auditIdempotencyKey === undefined ? {} : { idempotencyKey: auditIdempotencyKey }),
          entityType: "inventory_item",
          entityId: item.id,
          version: item.version,
        }));
      }
      const mutation: BulkMutation<InventoryBulkUpdateResult> = { data, audits, correlationId: ctx.correlationId, replayed: false };
      if (ctx.idempotencyKey) await this.ports.idempotency.set(ctx.actor, ctx.idempotencyKey, { action, fingerprint, mutation });
      const events = audits.map((audit) => ({
        id: audit.id,
        type: action,
        entityType: audit.entityType,
        entityId: audit.entityId,
        ...(audit.version === undefined ? {} : { version: audit.version }),
        correlationId: ctx.correlationId,
        at: audit.createdAt,
      } satisfies EventBusEvent));
      return { mutation, events };
    });

    for (const event of committed.events) {
      try {
        this.ports.events.publish(event);
      } catch {
        // Delivery is post-commit and best-effort, matching single-item
        // mutation semantics.
      }
    }
    return committed.mutation;
  }
}
