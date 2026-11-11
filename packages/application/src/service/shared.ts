import { ApplicationError } from "../errors.js";
import type { ApplicationPorts, RequestContext } from "../ports.js";
import { idSchema, isUnitCompatibleWithItemKind, unitCorrectionReason } from "@benchledger/api-contract";
import type { InventoryItem, StockReceivingPolicy } from "@benchledger/api-contract";
import { createHash } from "node:crypto";

export const INVENTORY_SCAN_PAGE_SIZE = 200;

export function inventoryWithUnitStatus(item: InventoryItem): InventoryItem {
  const reason = unitCorrectionReason(item.kind, item.unit);
  const { unitStatus: _storedStatus, unitCorrectionReason: _storedReason, ...withoutStoredStatus } = item;
  return {
    ...withoutStoredStatus,
    unitStatus: reason === undefined ? "compatible" : "needs_correction",
    ...(reason === undefined ? {} : { unitCorrectionReason: reason })
  };
}

export function assertCompatibleInventoryUnit(item: Pick<InventoryItem, "kind" | "unit" | "id">, action: string): void {
  if (!isUnitCompatibleWithItemKind(item.kind, item.unit)) {
    const reason = unitCorrectionReason(item.kind, item.unit) ?? `unit '${item.unit}' is not recognized for kind '${item.kind}'`;
    throw new ApplicationError("validation", `${action}: inventory item '${item.id}' needs unit correction. ${reason}`);
  }
}

/**
 * Inventory is a shared pool, so BOM evaluation must never make an allocation
 * decision from a truncated page. Follow the adapter's cursor until it says
 * the scan is complete, while rejecting contradictory or non-progressing
 * pagination rather than silently evaluating a partial snapshot.
 */
export async function listAllInventory(inventory: ApplicationPorts["inventory"]): Promise<readonly InventoryItem[]> {
  const values: InventoryItem[] = [];
  const seenItemIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let expectedTotal: number | undefined;

  for (;;) {
    const current = await inventory.listItems(cursor === undefined
      ? { limit: INVENTORY_SCAN_PAGE_SIZE }
      : { limit: INVENTORY_SCAN_PAGE_SIZE, cursor });
    if (current.total !== undefined) {
      if (!Number.isSafeInteger(current.total) || current.total < 0) {
        throw new ApplicationError("integrity_error", "Inventory pagination returned an invalid total");
      }
      if (expectedTotal === undefined) expectedTotal = current.total;
      else if (current.total !== expectedTotal) throw new ApplicationError("integrity_error", "Inventory pagination returned inconsistent totals");
    }
    for (const item of current.data) {
      if (seenItemIds.has(item.id)) throw new ApplicationError("integrity_error", "Inventory pagination returned a duplicate item");
      seenItemIds.add(item.id);
      values.push(item);
    }
    if (expectedTotal !== undefined && values.length > expectedTotal) {
      throw new ApplicationError("integrity_error", "Inventory pagination returned more items than its total");
    }

    const nextCursor = current.nextCursor;
    if (nextCursor === undefined) {
      if (expectedTotal !== undefined && values.length !== expectedTotal) {
        throw new ApplicationError("integrity_error", "Inventory pagination ended before its total was read");
      }
      // A full page without a total or continuation cursor is ambiguous: it
      // may be a truncated adapter response. Fail closed instead of making a
      // BOM recommendation from an unknown inventory suffix.
      if (expectedTotal === undefined && current.data.length >= INVENTORY_SCAN_PAGE_SIZE) {
        throw new ApplicationError("integrity_error", "Inventory pagination ended without a continuation cursor");
      }
      return values;
    }
    if (nextCursor.length === 0 || seenCursors.has(nextCursor) || nextCursor === cursor) {
      throw new ApplicationError("integrity_error", "Inventory pagination did not make progress");
    }
    if (expectedTotal !== undefined && values.length >= expectedTotal) {
      throw new ApplicationError("integrity_error", "Inventory pagination returned a cursor after its total was read");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function commandContext(ctx: RequestContext, scope: string, input: unknown): RequestContext {
  if (ctx.fingerprint !== undefined) return ctx;
  return { ...ctx, fingerprint: createHash("sha256").update(JSON.stringify(canonicalize({ scope, input }))).digest("hex") };
}

export function requireId(value: string, label: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new ApplicationError("validation", `${label} is invalid`);
  return parsed.data;
}

export function buildConfigurationPort(ports: ApplicationPorts): NonNullable<ApplicationPorts["buildConfigurations"]> {
  if (ports.buildConfigurations === undefined) throw new ApplicationError("integrity_error", "This runtime does not support build configuration snapshots");
  return ports.buildConfigurations;
}

export function boundedLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new ApplicationError("validation", `${label} must be an integer between 1 and 200`);
  }
  return limit;
}

export function boundedCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 200 || !/^[A-Za-z0-9._~-]+$/.test(value)) throw new ApplicationError("validation", "cursor is invalid");
  return value;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

/** Reservation rule wording that matches the workspace receiving policy. */
export function inStockReservationRule(policy: StockReceivingPolicy): string {
  if (policy === "on_purchase") return "Only bought, delivered or physically confirmed stock can be reserved (receiving policy: when bought)";
  if (policy === "on_delivery") return "Only delivered or physically confirmed stock can be reserved (receiving policy: when delivered)";
  return "Only physically confirmed stock can be reserved";
}

/** Quantity wording for the stock that counts under the receiving policy. */
export function inStockQuantityLabel(policy: StockReceivingPolicy): string {
  return policy === "on_receipt" ? "confirmed stock" : "in-stock quantity";
}
