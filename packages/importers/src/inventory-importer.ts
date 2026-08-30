import { createAuditRecord, createStockEvent, confidenceFromSourceStatus, type AuditRecord, type InventoryItem, type InventoryProvenance, type StockEvent } from "@benchledger/domain";
import type { QuantityUnit } from "@benchledger/domain";

export interface SourceInventoryItem {
  id: string;
  category: string;
  name: string;
  variant?: string;
  purchasedQuantity: number;
  unit: string;
  status: string;
  reusePolicy: InventoryItem["reusePolicy"];
  source?: Record<string, unknown>;
  notes?: string;
}

export interface SourceInventoryDocument {
  schemaVersion: number;
  asOf?: string;
  currency: string;
  items: readonly SourceInventoryItem[];
}

export interface ImportPlan {
  sourceKey: string;
  items: readonly InventoryItem[];
  events: readonly StockEvent[];
  auditRecords: readonly AuditRecord[];
}

export interface InventoryImportTarget {
  get(id: string): InventoryItem | undefined;
  upsert(item: InventoryItem): unknown;
  appendStockEvent(event: StockEvent): { inserted: boolean; event: StockEvent } | StockEvent | boolean;
  appendAuditRecord?(record: AuditRecord): unknown;
}

export interface ImportOptions {
  sourceKey?: string;
  importedAt?: string;
  actorId?: string;
}

export interface ImportResult {
  sourceKey: string;
  createdItems: number;
  updatedItems: number;
  insertedEvents: number;
  duplicateEvents: number;
  auditRecords: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`inventory item ${key} must be a non-empty string`);
  return value.trim();
}

function optionalText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`inventory item ${key} must be a string when present`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`inventory item ${key} must be a finite non-negative number`);
  return value;
}

function parseSource(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("inventory item source must be an object when present");
  return { ...value };
}

function normalizeRawItem(value: unknown): SourceInventoryItem {
  if (!isRecord(value)) throw new Error("inventory item must be an object");
  const reusePolicy = value["reuse_policy"];
  const allowedReuse: readonly InventoryItem["reusePolicy"][] = ["available", "inspect_first", "machine_specific"];
  const normalizedReuse = typeof reusePolicy === "string" && allowedReuse.includes(reusePolicy as InventoryItem["reusePolicy"]) ? reusePolicy as InventoryItem["reusePolicy"] : "inspect_first";
  const variant = optionalText(value, "variant");
  const notes = optionalText(value, "notes");
  return {
    id: requiredText(value, "id"),
    category: requiredText(value, "category"),
    name: requiredText(value, "name"),
    ...(variant === undefined ? {} : { variant }),
    purchasedQuantity: requiredNumber(value, "purchased_qty"),
    unit: requiredText(value, "unit"),
    status: requiredText(value, "status"),
    reusePolicy: normalizedReuse,
    ...(parseSource(value["source"]) === undefined ? {} : { source: parseSource(value["source"]) as Record<string, unknown> }),
    ...(notes === undefined ? {} : { notes })
  };
}

export function parseInventoryDocument(value: unknown): SourceInventoryDocument {
  if (!isRecord(value)) throw new Error("inventory document must be an object");
  const rawItems = value["items"];
  if (!Array.isArray(rawItems)) throw new Error("inventory document items must be an array");
  const schemaVersion = value["schema_version"];
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error("inventory document schema_version must be a positive integer");
  const currency = value["currency"];
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new Error("inventory document currency must be an ISO 4217 code");
  const asOf = optionalText(value, "as_of");
  const items = rawItems.map(normalizeRawItem);
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`duplicate inventory item id ${item.id}`);
    ids.add(item.id);
  }
  return { schemaVersion, ...(asOf === undefined ? {} : { asOf }), currency, items };
}

function unitPriceMinor(source: Record<string, unknown> | undefined): number | undefined {
  const value = source?.["unit_price"] ?? source?.["unitPrice"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 100);
}

function provenance(source: Record<string, unknown> | undefined, currency: string): InventoryProvenance | undefined {
  if (source === undefined) return undefined;
  const price = unitPriceMinor(source);
  return {
    ...source,
    ...(price === undefined ? {} : { unitPriceMinor: price }),
    currency
  };
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "source";
}

export function buildImportPlan(value: unknown, options: ImportOptions = {}): ImportPlan {
  const document = parseInventoryDocument(value);
  const sourceKey = options.sourceKey ?? `inventory-json-v${document.schemaVersion}:${document.asOf ?? "undated"}`;
  const importedAt = options.importedAt ?? new Date().toISOString();
  const actorId = options.actorId ?? "inventory-importer";
  const items: InventoryItem[] = [];
  const events: StockEvent[] = [];
  const auditRecords: AuditRecord[] = [];
  for (const raw of document.items) {
    const confidence = confidenceFromSourceStatus(raw.status);
    const source = provenance(raw.source, document.currency);
    const item: InventoryItem = {
      id: raw.id,
      name: raw.name,
      category: raw.category,
      ...(raw.variant === undefined ? {} : { variant: raw.variant }),
      purchasedQuantity: raw.purchasedQuantity,
      unit: raw.unit as QuantityUnit,
      sourceStatus: raw.status,
      reusePolicy: raw.reusePolicy,
      confidence,
      reportedQuantity: raw.purchasedQuantity,
      ...(source === undefined ? {} : { source }),
      ...(raw.notes === undefined ? {} : { notes: raw.notes }),
      createdAt: importedAt,
      updatedAt: importedAt
    };
    items.push(item);
    const eventId = `import-${safePart(sourceKey)}-${safePart(raw.id)}-stock`;
    const event = confidence === "confirmed"
      ? createStockEvent({ id: eventId, itemId: raw.id, kind: "receipt", quantity: raw.purchasedQuantity, unit: raw.unit as QuantityUnit, reason: `Imported ${raw.status} stock evidence`, source: sourceKey, evidence: { sourceStatus: raw.status, reportedQuantity: raw.purchasedQuantity }, actor: { type: "import", id: actorId }, idempotencyKey: `inventory-import:${sourceKey}:${raw.id}`, occurredAt: importedAt, createdAt: importedAt })
      : createStockEvent({ id: eventId, itemId: raw.id, kind: "evidence", quantity: 0, unit: raw.unit as QuantityUnit, reason: `Imported ${raw.status} evidence; physical count required`, source: sourceKey, evidence: { sourceStatus: raw.status, reportedQuantity: raw.purchasedQuantity }, actor: { type: "import", id: actorId }, idempotencyKey: `inventory-import:${sourceKey}:${raw.id}`, occurredAt: importedAt, createdAt: importedAt });
    events.push(event);
    auditRecords.push(createAuditRecord({ id: `audit-${safePart(sourceKey)}-${safePart(raw.id)}`, action: "inventory.imported", entityType: "inventory_item", entityId: raw.id, actor: { type: "import", id: actorId }, sourceSurface: "import", occurredAt: importedAt, correlationId: sourceKey, metadata: { sourceStatus: raw.status, confidence } }));
  }
  return { sourceKey, items, events, auditRecords };
}

function appendResultInserted(value: ReturnType<InventoryImportTarget["appendStockEvent"]>): boolean {
  if (typeof value === "boolean") return value;
  if ("inserted" in value) return value.inserted;
  return true;
}

export function importInventory(value: unknown, target: InventoryImportTarget, options: ImportOptions = {}): ImportResult {
  const plan = buildImportPlan(value, options);
  let createdItems = 0;
  let updatedItems = 0;
  for (const item of plan.items) {
    if (target.get(item.id) === undefined) createdItems += 1;
    else updatedItems += 1;
    target.upsert(item);
  }
  let insertedEvents = 0;
  let duplicateEvents = 0;
  for (const event of plan.events) {
    if (appendResultInserted(target.appendStockEvent(event))) insertedEvents += 1;
    else duplicateEvents += 1;
  }
  let auditRecords = 0;
  if (target.appendAuditRecord !== undefined) {
    for (const record of plan.auditRecords) {
      target.appendAuditRecord(record);
      auditRecords += 1;
    }
  }
  return { sourceKey: plan.sourceKey, createdItems, updatedItems, insertedEvents, duplicateEvents, auditRecords };
}
