import type { InventoryCreateInput, WorkspaceAdapter } from "./api";
import type { InventoryItem } from "./domain";

export interface InventoryCreateOutcome {
  readonly item: InventoryItem;
  /** True when the maker ticked "I've counted this now" and the count saved. */
  readonly counted: boolean;
  /** The count failed after the item was created; the item still exists. */
  readonly countError?: unknown;
}

/**
 * Create an inventory record and, only when the maker confirms they counted
 * it now, record that physical count with the existing count API in the same
 * submit. A failed count never hides the created record.
 */
export async function createInventoryWithCount(adapter: Pick<WorkspaceAdapter, "createInventoryItem" | "recordCount">, input: InventoryCreateInput, countedNow: boolean): Promise<InventoryCreateOutcome> {
  const created = await adapter.createInventoryItem(input);
  if (!countedNow) return { item: created, counted: false };
  try {
    return { item: await adapter.recordCount(created.id, input.quantity), counted: true };
  } catch (countError: unknown) {
    return { item: created, counted: false, countError };
  }
}
