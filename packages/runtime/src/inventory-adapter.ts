import { createId, createStockEvent, DomainError } from "@benchledger/domain";
import type { CommissionInventoryItem, InventoryItem as ApiInventoryItem, CreateInventoryItem, StockEvent as ApiStockEvent, StockEventInput } from "@benchledger/api-contract";
import type { InventoryItem, StockEvent } from "@benchledger/domain";
import { parseInventoryCursor } from "@benchledger/application";
import type { InventoryListOptions, InventoryPort, Page, RequestContext, StockMutation, UnitOfWorkPort, UpdateInventoryInput } from "@benchledger/application";
import { InventoryRepository } from "@benchledger/database";
import type { BenchDatabase, InventoryCategoryRepository } from "@benchledger/database";
import { RuntimeState } from "./persistence.js";
import {
  apiInventoryFromNative, apiStockEventFromNative, isConfirmedEvidence, mapApiUnitToDomain,
  nativeItemFromApi, nativeStockEventFromApi, readInventoryMetadata
} from "./mappers.js";
import { attempt, clone, nowIso, page } from "./utils.js";

const ENTITY = "inventory_item";

function ensureDescriptiveUpdate(input: UpdateInventoryInput): void {
  const controlledField = Object.keys(input).find((field) => ["quantity", "availableQuantity", "evidence", "unit"].includes(field));
  if (controlledField !== undefined) throw new DomainError("invalid_update", `${controlledField} is controlled by stock events`);
}

function isSearchMatch(item: ApiInventoryItem, query: string | undefined): boolean {
  if (query === undefined || query.trim().length === 0) return true;
  const needle = query.trim().toLocaleLowerCase();
  return [item.name, item.description, item.manufacturer, item.model, item.sku, item.location, ...item.tags]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle);
}

function compareInventoryItems(left: Pick<ApiInventoryItem, "name" | "id">, right: Pick<ApiInventoryItem, "name" | "id">): number {
  return left.name.trim().toLocaleLowerCase().localeCompare(right.name.trim().toLocaleLowerCase())
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}

function mergeInventoryInput(current: ApiInventoryItem, input: UpdateInventoryInput): CreateInventoryItem {
  return {
    ...(current.id === undefined ? {} : { id: current.id }),
    name: input.name ?? current.name,
    kind: input.kind ?? current.kind,
    ...(input.categoryNodeId === undefined && current.categoryNodeId === undefined ? {} : { categoryNodeId: input.categoryNodeId === null ? undefined : input.categoryNodeId ?? current.categoryNodeId }),
    ...(input.description === undefined && current.description === undefined ? {} : { description: input.description ?? current.description }),
    ...(input.manufacturer === undefined && current.manufacturer === undefined ? {} : { manufacturer: input.manufacturer ?? current.manufacturer }),
    ...(input.model === undefined && current.model === undefined ? {} : { model: input.model ?? current.model }),
    ...(input.sku === undefined && current.sku === undefined ? {} : { sku: input.sku ?? current.sku }),
    quantity: input.quantity ?? current.quantity,
    unit: input.unit ?? current.unit,
    ...(input.location === undefined && current.location === undefined ? {} : { location: input.location ?? current.location }),
    ...(input.condition === undefined && current.condition === undefined ? {} : { condition: input.condition ?? current.condition }),
    ...(input.dimensions === undefined && current.dimensions === undefined ? {} : { dimensions: input.dimensions ?? current.dimensions }),
    tags: input.tags?.slice() ?? current.tags.slice(),
    links: input.links?.slice() ?? current.links.slice(),
    evidence: input.evidence ?? current.evidence
  };
}

function initialCountEvent(item: InventoryItem, quantity: number, version: number): StockEvent {
  return createStockEvent({
    id: `${item.id}-initial-count`,
    itemId: item.id,
    kind: "count",
    quantity,
    unit: item.unit,
    reason: "Initial inventory record",
    source: "import",
    evidence: { apiItemVersion: version, bootstrap: true },
    idempotencyKey: `inventory:${item.id}:initial-count`,
    occurredAt: item.createdAt,
    createdAt: item.createdAt
  });
}

function initialAllocationEvent(item: InventoryItem, quantity: number, version: number): StockEvent {
  return createStockEvent({
    id: `${item.id}-initial-allocation`,
    itemId: item.id,
    kind: "allocate",
    quantity,
    unit: item.unit,
    reason: "Initial inventory allocation",
    source: "import",
    evidence: { apiItemVersion: version, bootstrap: true },
    idempotencyKey: `inventory:${item.id}:initial-allocation`,
    occurredAt: item.createdAt,
    createdAt: item.createdAt
  });
}

export class ProductionInventoryAdapter implements InventoryPort {
  constructor(
    private readonly database: BenchDatabase,
    private readonly repository: InventoryRepository,
    private readonly state: RuntimeState,
    private readonly unitOfWork: Pick<UnitOfWorkPort, "exclusive">,
    private readonly categoryAssignments?: InventoryCategoryRepository,
  ) {}

  async listItems(options: InventoryListOptions): Promise<Page<ApiInventoryItem>> {
    return this.unitOfWork.exclusive(() => attempt(async () => {
      const offset = parseInventoryCursor(options.cursor);
      const records = this.repository.list({ includeRetired: true });
      const items = records.map((item) => this.toApi(item)).filter((item) => {
        if (!options.includeRetired && item.retiredAt !== undefined) return false;
        if (options.kind !== undefined && item.kind !== options.kind) return false;
        if (options.evidence !== undefined && item.evidence.state !== options.evidence) return false;
        if (options.available !== undefined && (item.availableQuantity > 0) !== options.available) return false;
        if (options.categoryNodeId !== undefined && item.categoryNodeId !== options.categoryNodeId) return false;
        if (options.unassigned === true && item.categoryNodeId !== undefined) return false;
        return isSearchMatch(item, options.q);
      }).sort(compareInventoryItems);
      const data = items.slice(offset, offset + options.limit);
      const nextOffset = offset + data.length < items.length ? offset + data.length : undefined;
      return {
        data,
        limit: options.limit,
        total: items.length,
        ...(nextOffset === undefined ? {} : { nextCursor: String(nextOffset) })
      };
    }));
  }

  async getItem(id: string): Promise<ApiInventoryItem | null> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const item = this.repository.get(id);
      return item === undefined || item.retiredAt !== undefined ? null : this.toApi(item);
    }));
  }

  async createItem(input: CreateInventoryItem): Promise<ApiInventoryItem> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const id = input.id ?? createId("item");
      const now = nowIso();
      const native = nativeItemFromApi(input, id, now);
      return this.database.transaction(() => {
        const created = this.repository.create(native);
        this.state.setInitialVersion(ENTITY, created.id);
        if (this.categoryAssignments !== undefined && input.categoryNodeId !== undefined) this.categoryAssignments.setItemCategoryNode(created.id, input.categoryNodeId, created.createdAt);
        if (isConfirmedEvidence(input.evidence.state)) {
          const count = initialCountEvent(created, input.quantity, 1);
          this.repository.appendStockEvent(count);
          const availableQuantity = input.availableQuantity ?? input.quantity;
          const initiallyAllocated = input.quantity - availableQuantity;
          if (initiallyAllocated > 0) this.repository.appendStockEvent(initialAllocationEvent(created, initiallyAllocated, 1));
        }
        return this.toApi(created);
      });
    }));
  }

  /**
   * Remove only a just-created item during the compound item/profile command.
   * Stock events are owned by the item and must be removed first to satisfy
   * the database foreign key. This is an internal compensation path, not a
   * general inventory deletion API.
   */
  async rollbackCreatedItem(itemId: string): Promise<void> {
    await this.unitOfWork.exclusive(() => attempt(() => {
      const current = this.repository.get(itemId);
      if (current === undefined) return;
      if (this.state.getVersion(ENTITY, itemId) !== 1) throw new Error("created inventory item is no longer at version 1");
      this.database.transaction(() => {
        this.database.run("DELETE FROM stock_events WHERE item_id = ?", [itemId]);
        const result = this.database.run("DELETE FROM inventory_items WHERE id = ?", [itemId]) as { readonly changes?: number | bigint };
        const removed = typeof result.changes === "number" ? result.changes === 1 : typeof result.changes === "bigint" ? result.changes === 1n : this.repository.get(itemId) === undefined;
        if (!removed) throw new Error("created inventory item compensation did not remove the item");
      });
      this.state.deleteMetadata(ENTITY, itemId);
      this.state.deleteVersion(ENTITY, itemId);
    }));
  }

  async updateItem(id: string, input: UpdateInventoryInput, expectedVersion: number | undefined): Promise<ApiInventoryItem> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      ensureDescriptiveUpdate(input);
      const current = this.repository.get(id);
      if (current === undefined || current.retiredAt !== undefined) throw new DomainError("inventory_not_found", `inventory item ${id} does not exist`);
      const currentApi = this.toApi(current);
      const merged = mergeInventoryInput(currentApi, input);
      return this.database.transaction(() => {
        this.state.ensureVersion(ENTITY, id, expectedVersion);
        const updated = nativeItemFromApi(merged, id, nowIso(), current);
        this.repository.upsert(updated);
        if (this.categoryAssignments !== undefined && input.categoryNodeId !== undefined) this.categoryAssignments.setItemCategoryNode(id, input.categoryNodeId ?? undefined, updated.updatedAt);
        const nextVersion = this.state.bumpVersion(ENTITY, id);
        return this.toApi(updated, nextVersion);
      });
    }));
  }

  async recordPhysicalCount(itemId: string, quantity: number, ctx: RequestContext, note?: string): Promise<StockMutation> {
    return this.recordCount(itemId, quantity, ctx, undefined, "physically_counted", undefined, note);
  }

  async commissionItem(itemId: string, input: CommissionInventoryItem, expectedVersion: number | undefined, ctx: RequestContext): Promise<StockMutation> {
    return this.recordCount(itemId, input.quantity, ctx, input, "commissioned", expectedVersion);
  }

  private async recordCount(
    itemId: string,
    quantity: number,
    ctx: RequestContext,
    commissioning: CommissionInventoryItem | undefined,
    evidenceState: "physically_counted" | "commissioned",
    expectedVersion?: number,
    note?: string
  ): Promise<StockMutation> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const current = this.repository.get(itemId);
      if (current === undefined || current.retiredAt !== undefined) throw new DomainError("inventory_not_found", `inventory item ${itemId} does not exist`);
      if (!Number.isFinite(quantity) || quantity < 0) throw new DomainError("invalid_quantity", "physical count must be zero or greater");
      const currentApi = this.toApi(current);
      if (evidenceState === "commissioned" && isConfirmedEvidence(currentApi.evidence.state)) {
        throw new DomainError("invalid_evidence_transition", "inventory item is already confirmed");
      }
      if (commissioning !== undefined && mapApiUnitToDomain(commissioning.unit) !== current.unit) {
        throw new DomainError("invalid_unit", `unit mismatch: item uses ${current.unit}, count uses ${commissioning.unit}`);
      }
      const idempotencyKey = ctx.idempotencyKey === undefined ? undefined : `${evidenceState === "commissioned" ? "commission" : "physical-count"}:${itemId}:${ctx.idempotencyKey}`;
      const existing = idempotencyKey === undefined ? undefined : this.repository.listStockEvents(itemId).find((event) => event.idempotencyKey === idempotencyKey);
      if (existing !== undefined) {
        const version = this.state.getVersion(ENTITY, itemId);
        const item = this.repository.get(itemId);
        if (item === undefined) throw new DomainError("inventory_not_found", `inventory item ${itemId} does not exist`);
        return { event: this.toApiStockEvent(existing, version), item: this.toApi(item, version) };
      }
      return this.database.transaction(() => {
        this.state.ensureVersion(ENTITY, itemId, expectedVersion);
        const now = nowIso();
        const balance = this.repository.balance(itemId);
        if (quantity < balance.allocated) throw new DomainError("over_allocation", "physical count cannot be below allocated quantity");
        const evidence = commissioning?.evidence ?? { ...currentApi.evidence, state: "physically_counted" as const, observedAt: now };
        const updated = nativeItemFromApi({
          name: currentApi.name,
          kind: currentApi.kind,
          ...(currentApi.description === undefined ? {} : { description: currentApi.description }),
          ...(currentApi.manufacturer === undefined ? {} : { manufacturer: currentApi.manufacturer }),
          ...(currentApi.model === undefined ? {} : { model: currentApi.model }),
          ...(currentApi.sku === undefined ? {} : { sku: currentApi.sku }),
          quantity,
          unit: currentApi.unit,
          ...(currentApi.location === undefined ? {} : { location: currentApi.location }),
          ...(currentApi.condition === undefined ? {} : { condition: currentApi.condition }),
          ...(currentApi.dimensions === undefined ? {} : { dimensions: currentApi.dimensions }),
          tags: currentApi.tags,
          links: currentApi.links,
          evidence
        }, itemId, now, current);
        this.repository.upsert(updated);
        const nextVersion = this.state.getVersion(ENTITY, itemId) + 1;
        const event = createStockEvent({
          id: `${itemId}-${evidenceState === "commissioned" ? "commission" : "physical-count"}-${nextVersion}`,
          itemId,
          kind: "count",
          quantity,
          unit: updated.unit,
          reason: commissioning?.evidence.note ?? note ?? "Physical inventory count",
          actor: { type: ctx.source === "mcp" ? "agent" : "human", id: ctx.actor },
          source: ctx.source,
          evidence: {
            apiItemVersion: nextVersion,
            state: evidenceState,
            previousEvidence: currentApi.evidence,
            ...(commissioning === undefined || commissioning.evidence.source === undefined ? {} : { source: commissioning.evidence.source }),
            ...(commissioning === undefined || commissioning.evidence.sourceId === undefined ? {} : { sourceId: commissioning.evidence.sourceId }),
            ...(commissioning === undefined || commissioning.evidence.observedAt === undefined ? {} : { observedAt: commissioning.evidence.observedAt }),
            ...(commissioning?.evidence.note === undefined && note === undefined ? {} : { note: commissioning?.evidence.note ?? note })
          },
          correlationId: ctx.correlationId,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          occurredAt: now,
          createdAt: now
        });
        const appended = this.repository.appendStockEvent(event);
        if (!appended.inserted) {
          const storedVersion = this.state.getVersion(ENTITY, itemId);
          return { event: this.toApiStockEvent(appended.event, storedVersion), item: this.toApi(this.repository.get(itemId) ?? updated, storedVersion) };
        }
        this.state.setVersion(ENTITY, itemId, nextVersion);
        return { event: this.toApiStockEvent(appended.event, nextVersion), item: this.toApi(updated, nextVersion) };
      });
    }));
  }

  async recordStockEvent(input: StockEventInput, ctx: RequestContext): Promise<StockMutation> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const nativeItem = this.repository.get(input.itemId);
      if (nativeItem === undefined || nativeItem.retiredAt !== undefined) throw new DomainError("inventory_not_found", `inventory item ${input.itemId} does not exist`);
      const expectedUnit = mapApiUnitToDomain(input.unit);
      if (nativeItem.unit !== expectedUnit) throw new DomainError("invalid_unit", `unit mismatch: item uses ${nativeItem.unit}, event uses ${expectedUnit}`);
      const idempotencyKey = input.idempotencyKey ?? ctx.idempotencyKey;
      const normalized: StockEventInput = idempotencyKey === undefined ? input : { ...input, idempotencyKey };
      return this.database.transaction(() => {
        const nextVersion = this.state.getVersion(ENTITY, input.itemId) + 1;
        const event = nativeStockEventFromApi(normalized, ctx, nativeItem.unit, nextVersion);
        const appended = this.repository.appendStockEvent(event);
        if (appended.inserted) this.state.setVersion(ENTITY, input.itemId, nextVersion);
        const current = this.repository.get(input.itemId);
        if (current === undefined) throw new DomainError("inventory_not_found", `inventory item ${input.itemId} does not exist`);
        const version = this.state.getVersion(ENTITY, input.itemId);
        return { event: this.toApiStockEvent(appended.event, version), item: this.toApi(current, version) };
      });
    }));
  }

  async listStockEvents(itemId: string, limit: number, cursor?: string): Promise<Page<ApiStockEvent>> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const events = this.repository.listStockEvents(itemId);
      const fallback = this.state.getVersion(ENTITY, itemId);
      return page(events.map((event) => this.toApiStockEvent(event, fallback)), limit, cursor);
    }));
  }

  native(id: string): InventoryItem | undefined {
    return this.repository.get(id);
  }

  balance(id: string): { readonly onHand: number; readonly available: number } {
    const balance = this.repository.balance(id);
    return { onHand: balance.onHand, available: balance.available };
  }

  version(id: string): number {
    return this.state.getVersion(ENTITY, id);
  }

  toApi(item: InventoryItem, version = this.state.getVersion(ENTITY, item.id)): ApiInventoryItem {
    const assigned = this.categoryAssignments?.getItemCategoryNode(item.id);
    const withCategory = assigned === undefined ? item : { ...item, categoryNodeId: assigned };
    const balance = this.repository.balance(item.id);
    return clone(apiInventoryFromNative(withCategory, balance, version));
  }

  metadata(id: string): ReturnType<typeof readInventoryMetadata> {
    const native = this.repository.get(id);
    return readInventoryMetadata(native?.source);
  }

  private toApiStockEvent(event: StockEvent, fallbackVersion: number): ApiStockEvent {
    const metadata = this.state.getMetadata("stock_event", event.id);
    const storedVersion = typeof metadata.apiItemVersion === "number" && Number.isInteger(metadata.apiItemVersion)
      ? metadata.apiItemVersion
      : fallbackVersion;
    return apiStockEventFromNative(event, storedVersion);
  }
}
