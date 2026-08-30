import { DomainError, createStockEvent, deriveStockBalance } from "@benchledger/domain";
import type { InventoryItem, StockBalance, StockEvent } from "@benchledger/domain";
import { eventFromRow, itemFromRow, jsonValue } from "./serializers.js";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";

export interface InventoryListFilter {
  query?: string;
  category?: string;
  confidence?: InventoryItem["confidence"];
  includeRetired?: boolean;
}

export interface AppendStockEventResult {
  event: StockEvent;
  inserted: boolean;
  balance: StockBalance;
}

export class InventoryRepository {
  constructor(private readonly database: BenchDatabase) {}

  create(item: InventoryItem): InventoryItem {
    this.database.run(
      `INSERT INTO inventory_items
       (id, name, category, variant, purchased_quantity, unit, source_status, reuse_policy, confidence, reported_quantity, manufacturer, model, dimensions_json, source_json, notes, created_at, updated_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [item.id, item.name, item.category, item.variant ?? null, item.purchasedQuantity, item.unit, item.sourceStatus, item.reusePolicy, item.confidence, item.reportedQuantity ?? null, item.manufacturer ?? null, item.model ?? null, jsonValue(item.dimensions), jsonValue(item.source), item.notes ?? null, item.createdAt, item.updatedAt, item.retiredAt ?? null]
    );
    return item;
  }

  upsert(item: InventoryItem): InventoryItem {
    this.database.run(
      `INSERT INTO inventory_items
       (id, name, category, variant, purchased_quantity, unit, source_status, reuse_policy, confidence, reported_quantity, manufacturer, model, dimensions_json, source_json, notes, created_at, updated_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, category = excluded.category, variant = excluded.variant,
         purchased_quantity = excluded.purchased_quantity, unit = excluded.unit,
         source_status = excluded.source_status, reuse_policy = excluded.reuse_policy,
         confidence = excluded.confidence, reported_quantity = excluded.reported_quantity,
         manufacturer = excluded.manufacturer, model = excluded.model,
         dimensions_json = excluded.dimensions_json, source_json = excluded.source_json,
         notes = excluded.notes, updated_at = excluded.updated_at, retired_at = excluded.retired_at`,
      [item.id, item.name, item.category, item.variant ?? null, item.purchasedQuantity, item.unit, item.sourceStatus, item.reusePolicy, item.confidence, item.reportedQuantity ?? null, item.manufacturer ?? null, item.model ?? null, jsonValue(item.dimensions), jsonValue(item.source), item.notes ?? null, item.createdAt, item.updatedAt, item.retiredAt ?? null]
    );
    return item;
  }

  get(id: string): InventoryItem | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM inventory_items WHERE id = ?", [id]);
    return row === undefined ? undefined : itemFromRow(row);
  }

  list(filter: InventoryListFilter = {}): readonly InventoryItem[] {
    const conditions: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.includeRetired !== true) conditions.push("retired_at IS NULL");
    if (filter.category !== undefined) {
      conditions.push("category = ?");
      params.push(filter.category);
    }
    if (filter.confidence !== undefined) {
      conditions.push("confidence = ?");
      params.push(filter.confidence);
    }
    if (filter.query !== undefined && filter.query.trim()) {
      conditions.push("(name LIKE ? ESCAPE '\\' OR variant LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
      const query = `%${filter.query.replace(/[\\%_]/g, "\\$&")}%`;
      params.push(query, query, query);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    return this.database.all<SqliteRow>(`SELECT * FROM inventory_items ${where} ORDER BY category, name, id`, params).map(itemFromRow);
  }

  retire(id: string, retiredAt: string): InventoryItem {
    const item = this.get(id);
    if (item === undefined) throw new DomainError("inventory_not_found", `inventory item ${id} does not exist`);
    const updated = { ...item, retiredAt, updatedAt: retiredAt };
    this.database.run("UPDATE inventory_items SET retired_at = ?, updated_at = ? WHERE id = ?", [retiredAt, retiredAt, id]);
    return updated;
  }

  listStockEvents(itemId: string): readonly StockEvent[] {
    return this.database.all<SqliteRow>("SELECT * FROM stock_events WHERE item_id = ? ORDER BY occurred_at, created_at, rowid", [itemId]).map(eventFromRow);
  }

  appendStockEvent(event: StockEvent): AppendStockEventResult {
    const item = this.get(event.itemId);
    if (item === undefined) throw new DomainError("inventory_not_found", `inventory item ${event.itemId} does not exist`);
    if (event.idempotencyKey !== undefined) {
      const existingRow = this.database.get<SqliteRow>("SELECT * FROM stock_events WHERE idempotency_key = ?", [event.idempotencyKey]);
      if (existingRow !== undefined) {
        const existing = eventFromRow(existingRow);
        return { event: existing, inserted: false, balance: this.balance(item.id) };
      }
    }
    const nextBalance = deriveStockBalance(item, this.listStockEvents(item.id).concat(event));
    this.database.run(
      `INSERT INTO stock_events
       (id, item_id, kind, semantics, quantity, unit, reason, actor_json, source, evidence_json, correlation_id, idempotency_key, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.itemId, event.kind, event.semantics, event.quantity, event.unit, event.reason, jsonValue(event.actor), event.source ?? null, jsonValue(event.evidence), event.correlationId ?? null, event.idempotencyKey ?? null, event.occurredAt, event.createdAt]
    );
    return { event, inserted: true, balance: nextBalance };
  }

  balance(itemId: string): StockBalance {
    const item = this.get(itemId);
    if (item === undefined) throw new DomainError("inventory_not_found", `inventory item ${itemId} does not exist`);
    return deriveStockBalance(item, this.listStockEvents(itemId));
  }
}
