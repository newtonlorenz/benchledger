import { canonicalProjectStatus, isFabricationRoute } from "@benchledger/domain";
import type { Dimensions, InventoryItem, InventoryProvenance, StockEvent, Project, WorkItem, ProjectRevision, WorkItemRevision, BomLine, BomAlternative, Reservation, Supplier, OfferSnapshot, AuditRecord, AuditActor } from "@benchledger/domain";
import type { SqliteRow } from "./sqlite.js";

export function jsonValue(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function text(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`database row ${key} is not text`);
  return value;
}

function number(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`database row ${key} is not numeric`);
  return value;
}

function optionalText(row: SqliteRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

/** Distinguish an absent legacy column from a present SQL NULL clear. */
function nullableText(row: SqliteRow, key: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, key)) return undefined;
  const value = row[key];
  return value === null ? null : typeof value === "string" ? value : undefined;
}

function optionalNumber(row: SqliteRow, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" ? value : undefined;
}

export function itemFromRow(row: SqliteRow): InventoryItem {
  const dimensions = parseJson<Dimensions>(row["dimensions_json"]);
  const source = parseJson<InventoryProvenance>(row["source_json"]);
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    category: text(row, "category"),
    ...(optionalText(row, "variant") === undefined ? {} : { variant: optionalText(row, "variant") as string }),
    purchasedQuantity: number(row, "purchased_quantity"),
    unit: text(row, "unit"),
    sourceStatus: text(row, "source_status"),
    reusePolicy: text(row, "reuse_policy") as InventoryItem["reusePolicy"],
    confidence: text(row, "confidence") as InventoryItem["confidence"],
    ...(optionalNumber(row, "reported_quantity") === undefined ? {} : { reportedQuantity: optionalNumber(row, "reported_quantity") as number }),
    ...(optionalText(row, "manufacturer") === undefined ? {} : { manufacturer: optionalText(row, "manufacturer") as string }),
    ...(optionalText(row, "model") === undefined ? {} : { model: optionalText(row, "model") as string }),
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(source === undefined ? {} : { source }),
    ...(optionalText(row, "notes") === undefined ? {} : { notes: optionalText(row, "notes") as string }),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    ...(optionalText(row, "retired_at") === undefined ? {} : { retiredAt: optionalText(row, "retired_at") as string })
  };
}

export function eventFromRow(row: SqliteRow): StockEvent {
  const actor = parseJson<AuditActor>(row["actor_json"]);
  const evidence = parseJson<Record<string, unknown>>(row["evidence_json"]);
  return {
    id: text(row, "id"),
    itemId: text(row, "item_id"),
    kind: text(row, "kind") as StockEvent["kind"],
    semantics: text(row, "semantics") as StockEvent["semantics"],
    quantity: number(row, "quantity"),
    unit: text(row, "unit"),
    reason: text(row, "reason"),
    ...(actor === undefined ? {} : { actor }),
    ...(optionalText(row, "source") === undefined ? {} : { source: optionalText(row, "source") as string }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(optionalText(row, "correlation_id") === undefined ? {} : { correlationId: optionalText(row, "correlation_id") as string }),
    ...(optionalText(row, "idempotency_key") === undefined ? {} : { idempotencyKey: optionalText(row, "idempotency_key") as string }),
    occurredAt: text(row, "occurred_at"),
    createdAt: text(row, "created_at")
  };
}

export function projectFromRow(row: SqliteRow): Project {
  const removedBy = parseJson<AuditActor>(row["removed_by_json"]);
  const removedReservationIds = parseJson<string[]>(row["removed_reservation_ids_json"]);
  const lastLifecycleStatus = optionalText(row, "last_lifecycle_status");
  return {
    id: text(row, "id"), name: text(row, "name"), slug: text(row, "slug"),
    ...(optionalText(row, "description") === undefined ? {} : { description: optionalText(row, "description") as string }),
    status: canonicalProjectStatus(text(row, "status")), visibility: text(row, "visibility") as Project["visibility"],
    createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at"),
    ...(optionalText(row, "retired_at") === undefined ? {} : { retiredAt: optionalText(row, "retired_at") as string }),
    ...(optionalText(row, "removed_at") === undefined ? {} : { removedAt: optionalText(row, "removed_at") as string }),
    ...(removedBy === undefined ? {} : { removedBy }),
    ...(lastLifecycleStatus === undefined ? {} : { lastLifecycleStatus: lastLifecycleStatus as Project["status"] }),
    ...(removedReservationIds === undefined ? {} : { removedReservationIds })
  };
}

export function workItemFromRow(row: SqliteRow): WorkItem {
  return {
    id: text(row, "id"), projectId: text(row, "project_id"), name: text(row, "name"), kind: text(row, "kind") as WorkItem["kind"],
    ...(optionalText(row, "description") === undefined ? {} : { description: optionalText(row, "description") as string }),
    createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at"),
    ...(optionalText(row, "retired_at") === undefined ? {} : { retiredAt: optionalText(row, "retired_at") as string })
  };
}

export function projectRevisionFromRow(row: SqliteRow): ProjectRevision {
  const storedRoute = optionalText(row, "fabrication_route") ?? "undecided";
  if (!isFabricationRoute(storedRoute)) throw new Error(`database row fabrication route is unsupported: ${storedRoute}`);
  const intendedPrinterItemId = nullableText(row, "intended_printer_item_id");
  return {
    id: text(row, "id"), projectId: text(row, "project_id"), number: number(row, "revision_number"), label: text(row, "label"), status: text(row, "status") as ProjectRevision["status"], fabricationRoute: storedRoute,
    ...(intendedPrinterItemId === undefined ? {} : { intendedPrinterItemId }),
    ...(optionalText(row, "machine_id") === undefined ? {} : { machineId: optionalText(row, "machine_id") as string }),
    ...(optionalText(row, "material") === undefined ? {} : { material: optionalText(row, "material") as string }),
    ...(optionalText(row, "notes") === undefined ? {} : { notes: optionalText(row, "notes") as string }),
    createdAt: text(row, "created_at"),
    ...(optionalText(row, "supersedes_revision_id") === undefined ? {} : { supersedesRevisionId: optionalText(row, "supersedes_revision_id") as string })
  };
}

export function workItemRevisionFromRow(row: SqliteRow): WorkItemRevision {
  return {
    id: text(row, "id"), workItemId: text(row, "work_item_id"), number: number(row, "revision_number"), label: text(row, "label"), status: text(row, "status") as WorkItemRevision["status"],
    ...(optionalText(row, "source_path") === undefined ? {} : { sourcePath: optionalText(row, "source_path") as string }),
    createdAt: text(row, "created_at"),
    ...(optionalText(row, "supersedes_revision_id") === undefined ? {} : { supersedesRevisionId: optionalText(row, "supersedes_revision_id") as string })
  };
}

export function bomLineFromRow(row: SqliteRow): BomLine {
  const alternatives = parseJson<string[]>(row["alternative_item_ids_json"]);
  const constraints = parseJson<BomLine["constraints"]>(row["constraints_json"]);
  const storedRole = row["role"];
  if (storedRole !== null && storedRole !== undefined && storedRole !== "consumed" && storedRole !== "reusable") {
    throw new Error(`database row role is unsupported: ${String(storedRole)}`);
  }
  return {
    id: text(row, "id"), revisionId: text(row, "revision_id"), name: text(row, "name"), quantity: number(row, "quantity"), unit: text(row, "unit"),
    role: storedRole === "consumed" || storedRole === "reusable" ? storedRole : null,
    required: number(row, "required") === 1, optional: number(row, "optional") === 1,
    ...(optionalText(row, "item_id") === undefined ? {} : { itemId: optionalText(row, "item_id") as string }),
    ...(alternatives === undefined ? {} : { alternativeItemIds: alternatives }),
    ...(constraints === undefined ? {} : { constraints }),
    ...(optionalText(row, "notes") === undefined ? {} : { notes: optionalText(row, "notes") as string }),
    ...(optionalText(row, "retired_at") === undefined ? {} : { retiredAt: optionalText(row, "retired_at") as string })
  };
}

export function bomAlternativeFromRow(row: SqliteRow): BomAlternative {
  const constraints = parseJson<BomAlternative["constraints"]>(row["constraints_json"]);
  return {
    id: text(row, "id"), bomLineId: text(row, "bom_line_id"), label: text(row, "label"),
    ...(optionalText(row, "item_id") === undefined ? {} : { itemId: optionalText(row, "item_id") as string }),
    ...(constraints === undefined ? {} : { constraints })
  };
}

export function reservationFromRow(row: SqliteRow): Reservation {
  return {
    id: text(row, "id"), projectRevisionId: text(row, "project_revision_id"), bomLineId: text(row, "bom_line_id"), itemId: text(row, "item_id"), quantity: number(row, "quantity"), status: text(row, "status") as Reservation["status"], createdAt: text(row, "created_at"),
    ...(optionalText(row, "released_at") === undefined ? {} : { releasedAt: optionalText(row, "released_at") as string })
  };
}

export function supplierFromRow(row: SqliteRow): Supplier {
  return { id: text(row, "id"), name: text(row, "name"), ...(optionalText(row, "website") === undefined ? {} : { website: optionalText(row, "website") as string }), createdAt: text(row, "created_at") };
}

export function offerFromRow(row: SqliteRow): OfferSnapshot {
  const title = optionalText(row, "title");
  const availability = optionalText(row, "availability");
  const notes = optionalText(row, "notes");
  return { id: text(row, "id"), itemId: text(row, "item_id"), supplierId: text(row, "supplier_id"), url: text(row, "url"), ...(title === undefined ? {} : { title }), packageQuantity: number(row, "package_quantity"), packageUnit: text(row, "package_unit"), priceMinor: number(row, "price_minor"), currency: text(row, "currency"), observedAt: text(row, "observed_at"), ...(availability === undefined ? {} : { availability: availability as NonNullable<OfferSnapshot["availability"]> }), ...(notes === undefined ? {} : { notes }) };
}

export function auditFromRow(row: SqliteRow): AuditRecord {
  const actor = parseJson<AuditActor>(row["actor_json"]);
  const metadata = parseJson<Record<string, unknown>>(row["metadata_json"]);
  if (actor === undefined) throw new Error("audit record actor is malformed");
  return { id: text(row, "id"), action: text(row, "action"), entityType: text(row, "entity_type"), entityId: text(row, "entity_id"), actor, sourceSurface: text(row, "source_surface") as AuditRecord["sourceSurface"], occurredAt: text(row, "occurred_at"), correlationId: text(row, "correlation_id"), ...(optionalNumber(row, "before_version") === undefined ? {} : { beforeVersion: optionalNumber(row, "before_version") as number }), ...(optionalNumber(row, "after_version") === undefined ? {} : { afterVersion: optionalNumber(row, "after_version") as number }), ...(metadata === undefined ? {} : { metadata }) };
}
