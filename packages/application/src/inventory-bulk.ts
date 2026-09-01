import { createHash } from "node:crypto";
import type {
  InventoryBulkUpdate,
  InventoryBulkUpdateChanges,
  InventoryBulkUpdateTags,
  InventoryItem,
} from "@benchledger/api-contract";
import { ApplicationError } from "./errors.js";

const MAX_INVENTORY_TAGS = 50;
const MAX_INVENTORY_TAG_LENGTH = 80;
const MAX_BULK_LOCATION_LENGTH = 240;
const INVENTORY_BULK_CONDITIONS = new Set(["new", "good", "worn", "needs_repair", "unknown"]);

/**
 * Trim tags and remove case-insensitive duplicates while retaining the first
 * spelling and the caller's stable order. Tag keys are human-entered labels,
 * so case is preserved for display but not treated as a distinct identity.
 */
export function normalizeInventoryTags(tags: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const value = tag.trim();
    if (value.length === 0 || value.length > MAX_INVENTORY_TAG_LENGTH) {
      throw new ApplicationError("validation", `Inventory tags must be between 1 and ${MAX_INVENTORY_TAG_LENGTH} characters`);
    }
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

export function normalizeInventoryBulkTags(tags: InventoryBulkUpdateTags): InventoryBulkUpdateTags {
  const add = normalizeInventoryTags(tags.add ?? []);
  const remove = normalizeInventoryTags(tags.remove ?? []);
  if (add.length > MAX_INVENTORY_TAGS || remove.length > MAX_INVENTORY_TAGS) {
    throw new ApplicationError("validation", `Bulk tag changes cannot contain more than ${MAX_INVENTORY_TAGS} additions or removals`);
  }
  const removed = new Set(remove.map((tag) => tag.toLocaleLowerCase()));
  if (add.length === 0 && remove.length === 0) {
    throw new ApplicationError("validation", "tags.add or tags.remove must contain at least one tag");
  }
  if (add.some((tag) => removed.has(tag.toLocaleLowerCase()))) {
    throw new ApplicationError("validation", "A tag cannot be both added and removed");
  }
  return {
    ...(add.length === 0 ? {} : { add: [...add] }),
    ...(remove.length === 0 ? {} : { remove: [...remove] }),
  };
}

export function normalizeInventoryBulkChanges(changes: InventoryBulkUpdateChanges): InventoryBulkUpdateChanges {
  const tags = changes.tags === undefined ? undefined : normalizeInventoryBulkTags(changes.tags);
  const location = changes.location === undefined ? undefined : changes.location.trim();
  if (location !== undefined && location.length === 0) {
    throw new ApplicationError("validation", "Bulk location must not be empty");
  }
  if (location !== undefined && location.length > MAX_BULK_LOCATION_LENGTH) {
    throw new ApplicationError("validation", `Bulk location cannot exceed ${MAX_BULK_LOCATION_LENGTH} characters`);
  }
  if (changes.condition !== undefined && !INVENTORY_BULK_CONDITIONS.has(changes.condition)) {
    throw new ApplicationError("validation", "Bulk condition is invalid");
  }
  if (location === undefined && changes.condition === undefined && tags === undefined) {
    throw new ApplicationError("validation", "At least one bulk metadata change is required");
  }
  return {
    ...(location === undefined ? {} : { location }),
    ...(changes.condition === undefined ? {} : { condition: changes.condition }),
    ...(tags === undefined ? {} : { tags }),
  };
}

/** Build the stable representation used for actor-scoped idempotency keys. */
export function canonicalInventoryBulkUpdate(input: InventoryBulkUpdate): InventoryBulkUpdate {
  const changes = normalizeInventoryBulkChanges(input.changes);
  const tags = changes.tags === undefined ? undefined : {
    ...(changes.tags.add === undefined ? {} : { add: sortInventoryTags(changes.tags.add) }),
    ...(changes.tags.remove === undefined ? {} : { remove: sortInventoryTags(changes.tags.remove) }),
  };
  return {
    targets: [...input.targets]
      .map((target) => ({ itemId: target.itemId, expectedVersion: target.expectedVersion }))
      .sort((left, right) => left.itemId.localeCompare(right.itemId)),
    changes: {
      ...(changes.location === undefined ? {} : { location: changes.location }),
      ...(changes.condition === undefined ? {} : { condition: changes.condition }),
      ...(tags === undefined ? {} : { tags }),
    },
  };
}

export function inventoryBulkUpdateFingerprint(input: InventoryBulkUpdate): string {
  return createHash("sha256").update(JSON.stringify(canonicalInventoryBulkUpdate(input))).digest("hex");
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function sortInventoryTags(tags: readonly string[]): string[] {
  return [...tags]
    .map((tag) => tag.toLocaleLowerCase())
    .sort((left, right) => left.localeCompare(right));
}

export interface InventoryBulkApplyResult {
  readonly item: InventoryItem;
  readonly changed: boolean;
}

/**
 * Calculate one target's next metadata state without mutating the source.
 * Adapters call this during their preflight/transaction boundary so a batch
 * can classify no-op rows without incrementing their versions.
 */
export function applyInventoryBulkChanges(current: InventoryItem, rawChanges: InventoryBulkUpdateChanges): InventoryBulkApplyResult {
  const changes = normalizeInventoryBulkChanges(rawChanges);
  let nextTags = current.tags;
  if (changes.tags !== undefined) {
    const tags = normalizeInventoryTags(current.tags);
    const remove = new Set((changes.tags.remove ?? []).map((tag) => tag.toLocaleLowerCase()));
    nextTags = tags.filter((tag) => !remove.has(tag.toLocaleLowerCase()));
    const present = new Set(nextTags.map((tag) => tag.toLocaleLowerCase()));
    for (const tag of changes.tags.add ?? []) {
      const key = tag.toLocaleLowerCase();
      if (present.has(key)) continue;
      present.add(key);
      nextTags = [...nextTags, tag];
    }
    if (nextTags.length > MAX_INVENTORY_TAGS) {
      throw new ApplicationError("validation", `Inventory items cannot have more than ${MAX_INVENTORY_TAGS} tags`);
    }
  }

  const next: InventoryItem = {
    ...current,
    ...(changes.location === undefined ? {} : { location: changes.location }),
    ...(changes.condition === undefined ? {} : { condition: changes.condition }),
    ...(changes.tags === undefined ? {} : { tags: [...nextTags] }),
  };
  const changed = (changes.location !== undefined && changes.location !== current.location)
    || (changes.condition !== undefined && changes.condition !== current.condition)
    || (changes.tags !== undefined && !sameTags(current.tags, next.tags));
  return { item: changed ? next : current, changed };
}
