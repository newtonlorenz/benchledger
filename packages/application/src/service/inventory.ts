import { ApplicationError, conflict, notFound } from "../errors.js";
import { isConfirmedEvidence, isCommissionableEvidence } from "@benchledger/domain";
import { canonicalInventoryBulkUpdate, inventoryBulkUpdateFingerprint, normalizeInventoryBulkChanges } from "../inventory-bulk.js";
import { parseInventoryCursor } from "../inventory-pagination.js";
import { inventoryImageContentPath } from "../inventory-images.js";
import type { ApplicationPorts, BulkMutation, InventoryBulkUpdateResult, InventoryCategoryListOptions, InventoryCategoryPort, InventoryListOptions, Mutation, Page, RequestContext, StockMutation, UpdateInventoryInput } from "../ports.js";
import { catalogPort } from "./catalog.js";
import { assertCompatibleInventoryUnit, boundedLimit, commandContext, inventoryWithUnitStatus, nowIso, requireId } from "./shared.js";
import { commissionInventoryItemSchema, createInventoryCategorySchema, createInventoryItemSchema, createInventoryWithProductProfileSchema, inventoryBulkUpdateSchema, inventoryItemSchema, inventoryListQuerySchema, inventoryProductProfileSchema, stockEventInputSchema, updateInventoryCategorySchema, updateInventoryItemSchema } from "@benchledger/api-contract";
import type { CommissionInventoryItem, CreateInventoryCategory, CreateInventoryItem, InventoryBulkUpdate, InventoryCategory, InventoryItem, InventoryListQuery, InventoryProductProfile, StockEventInput, UpdateInventoryCategory } from "@benchledger/api-contract";
import { createHash } from "node:crypto";
import { ServiceModule } from "./module.js";

export function inventoryCategoryPort(ports: ApplicationPorts): InventoryCategoryPort {
  if (ports.inventoryCategories === undefined) throw new ApplicationError("integrity_error", "This runtime does not support managed inventory categories");
  return ports.inventoryCategories;
}

export function boundedCategoryCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(value)) throw new ApplicationError("validation", "cursor is invalid");
  return value;
}

export function requiredCategoryVersion(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApplicationError("validation", "expectedVersion is required and must be a positive integer");
  }
  return value;
}

export function categoryListOptions(query: Partial<InventoryCategoryListOptions> | undefined): InventoryCategoryListOptions {
  const includeArchived = query?.includeArchived ?? false;
  if (typeof includeArchived !== "boolean") throw new ApplicationError("validation", "includeArchived must be a boolean");
  const cursor = boundedCategoryCursor(query?.cursor);
  return {
    includeArchived,
    limit: boundedLimit(query?.limit, 50, "limit"),
    ...(cursor === undefined ? {} : { cursor })
  };
}

function assertOptionalVersion(expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
    throw new ApplicationError("validation", "expectedVersion must be a positive integer");
  }
}

/**
 * Optional optimistic check for stock commands. It runs inside the audited
 * unit of work, so no other write can land between the check and the event.
 */
function assertItemVersion(current: InventoryItem, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw conflict(`Inventory item '${current.id}' changed since it was read`, { reason: "version_conflict", expectedVersion, actualVersion: current.version, retryable: true });
  }
}

/** Inventory items, managed categories, stock events, physical counts and commissioning. */
export class InventoryModule extends ServiceModule {
  async listInventory(query: InventoryListQuery): Promise<Page<InventoryItem>> {
    const parsed = inventoryListQuerySchema.parse(query) as InventoryListOptions;
    parseInventoryCursor(parsed.cursor);
    return this.ports.unitOfWork.exclusive(async () => {
      const page = await this.ports.inventory.listItems(parsed);
      const covers = await this.ports.inventoryImages?.primaryImages?.(page.data.map((item) => item.id));
      return {
        ...page,
        data: page.data.map((item) => {
          const cover = covers?.get(item.id);
          const withStatus = inventoryWithUnitStatus(item);
          return cover === undefined ? withStatus : { ...withStatus, primaryImage: { id: cover.id, url: inventoryImageContentPath(item.id, cover.id), mediaType: cover.mediaType, width: cover.width, height: cover.height } };
        })
      };
    });
  }

  async getInventoryItem(id: string): Promise<InventoryItem> {
    return this.ports.unitOfWork.exclusive(async () => {
      const item = await this.ports.inventory.getItem(requireId(id, "item id"));
      if (!item) throw notFound("Inventory item", id);
      return inventoryWithUnitStatus(item);
    });
  }

  async listInventoryCategories(query: Partial<InventoryCategoryListOptions> = {}): Promise<Page<InventoryCategory>> {
    const options = categoryListOptions(query);
    return this.ports.unitOfWork.exclusive(() => inventoryCategoryPort(this.ports).listCategories(options));
  }

  async getInventoryCategory(id: string): Promise<InventoryCategory> {
    const categoryId = requireId(id, "inventory category id");
    return this.ports.unitOfWork.exclusive(async () => {
      const category = await inventoryCategoryPort(this.ports).getCategory(categoryId);
      if (category === null) throw notFound("Inventory category", categoryId);
      return category;
    });
  }

  async createInventoryCategory(input: CreateInventoryCategory, ctx: RequestContext): Promise<Mutation<InventoryCategory>> {
    const parsed = createInventoryCategorySchema.parse(input);
    const commandCtx = commandContext(ctx, "inventory.category.create", parsed);
    return this.mutate(commandCtx, "inventory.category.create", "inventory_category", parsed.id ?? "pending", async () => {
      const category = await inventoryCategoryPort(this.ports).createCategory(parsed, commandCtx);
      return { value: category, entityId: category.id, version: category.version };
    });
  }

  async updateInventoryCategory(id: string, input: unknown, expectedVersion: number, ctx: RequestContext): Promise<Mutation<InventoryCategory>> {
    const categoryId = requireId(id, "inventory category id");
    const parsed = updateInventoryCategorySchema.parse(input) as UpdateInventoryCategory;
    const requiredVersion = requiredCategoryVersion(expectedVersion);
    const commandCtx = commandContext(ctx, "inventory.category.update", { categoryId, input: parsed, expectedVersion: requiredVersion });
    return this.mutate(commandCtx, "inventory.category.update", "inventory_category", categoryId, async () => {
      const category = await inventoryCategoryPort(this.ports).updateCategory(categoryId, parsed, requiredVersion, commandCtx);
      return { value: category, entityId: category.id, version: category.version };
    });
  }

  async archiveInventoryCategory(id: string, expectedVersion: number, ctx: RequestContext): Promise<Mutation<InventoryCategory>> {
    const categoryId = requireId(id, "inventory category id");
    const requiredVersion = requiredCategoryVersion(expectedVersion);
    const commandCtx = commandContext(ctx, "inventory.category.archive", { categoryId, expectedVersion: requiredVersion });
    return this.mutate(commandCtx, "inventory.category.archive", "inventory_category", categoryId, async () => {
      const category = await inventoryCategoryPort(this.ports).archiveCategory(categoryId, requiredVersion, commandCtx);
      return { value: category, entityId: category.id, version: category.version };
    });
  }

  private async validateInventoryCategoryReferences(categoryNodeId: string | null | undefined): Promise<void> {
    if (categoryNodeId === undefined || categoryNodeId === null) return;
    const categories = inventoryCategoryPort(this.ports);
    const category = await categories.getCategory(categoryNodeId);
    if (category === null) throw notFound("Inventory category", categoryNodeId);
    if (category.archived) throw new ApplicationError("validation", "archived categories cannot be assigned to inventory");
  }

  async createInventoryItem(input: CreateInventoryItem, ctx: RequestContext): Promise<Mutation<InventoryItem>> {
    const parsed = createInventoryItemSchema.parse(input);
    return this.mutate(ctx, "inventory.item.create", "inventory_item", parsed.id ?? "pending", async () => {
      await this.validateInventoryCategoryReferences(parsed.categoryNodeId);
      const item = await this.ports.inventory.createItem(parsed, ctx);
      const value = inventoryWithUnitStatus(item);
      return { value, entityId: value.id, version: value.version };
    });
  }

  /**
   * Create an exact inventory item and its physical product profile as one
   * audited command. The profile is deliberately reference-only at the
   * boundary; its itemId is injected only after the inventory adapter returns
   * the durable item identity. Adapters provide narrowly-scoped compensation
   * hooks so a non-transactional boundary cannot leave an orphan item when
   * the profile write fails.
   */

  async createInventoryWithProductProfile(input: unknown, ctx: RequestContext): Promise<Mutation<{ readonly item: InventoryItem; readonly profile: InventoryProductProfile }>> {
    const parsed = createInventoryWithProductProfileSchema.parse(input);
    const parsedItem = parsed.item;
    const parsedProfile = parsed.profile;
    const expectedProfileKind = parsedProfile.profileType === "filament_spool" ? "filament" : "printer";
    if (parsedItem.kind !== expectedProfileKind) {
      throw new ApplicationError("validation", `Profile type '${parsedProfile.profileType}' does not match inventory item kind '${parsedItem.kind}'`);
    }
    const catalog = catalogPort(this.ports);
    const product = await catalog.getProduct(parsedProfile.catalogProductId);
    if (product === null) throw notFound("Catalog product", parsedProfile.catalogProductId);
    if (product.kind !== parsedItem.kind) {
      throw new ApplicationError("validation", `Catalog product kind '${product.kind}' does not match inventory item kind '${parsedItem.kind}'`);
    }
    if (this.ports.inventory.rollbackCreatedItem === undefined || catalog.rollbackCreatedProfile === undefined) {
      throw new ApplicationError("integrity_error", "The inventory/profile adapters cannot compensate a failed compound create");
    }

    // A direct application caller may omit a fingerprint; derive one from the
    // parsed, canonical command so idempotency-key reuse remains safe.
    const commandContext = ctx.fingerprint === undefined
      ? { ...ctx, fingerprint: createHash("sha256").update(JSON.stringify({ item: parsedItem, profile: parsedProfile })).digest("hex") }
      : ctx;
    return this.mutate(commandContext, "inventory.item_with_product_profile.create", "inventory_item", parsedItem.id ?? "pending", async () => {
      await this.validateInventoryCategoryReferences(parsedItem.categoryNodeId);
      let createdItem: InventoryItem | undefined;
      let createdProfile: InventoryProductProfile | undefined;
      const compensate = async (): Promise<void> => {
        if (createdProfile !== undefined) await catalog.rollbackCreatedProfile!(createdProfile.id, createdProfile.itemId);
        if (createdItem !== undefined) await this.ports.inventory.rollbackCreatedItem!(createdItem.id);
      };
      try {
        createdItem = await this.ports.inventory.createItem(parsedItem, commandContext);
        const profile = await catalog.putInventoryProductProfile(createdItem.id, { ...parsedProfile, itemId: createdItem.id }, undefined, commandContext);
        createdProfile = inventoryProductProfileSchema.parse(profile);
        return {
          value: { item: inventoryItemSchema.parse(inventoryWithUnitStatus(createdItem)), profile: createdProfile },
          entityId: createdItem.id,
          version: createdItem.version,
          compensate
        };
      } catch (error: unknown) {
        try {
          await compensate();
        } catch {
          throw new ApplicationError("integrity_error", "The compound inventory/profile create failed and could not be compensated");
        }
        throw error;
      }
    });
  }

  async deleteInventoryItem(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<InventoryItem>> {
    const itemId = requireId(id, "item id");
    if (!Number.isSafeInteger(expectedVersion) || (expectedVersion ?? 0) < 1) throw new ApplicationError("validation", "Reload the item before deleting it; its current version is required");
    const commandCtx = commandContext(ctx, "inventory.item.delete", { itemId, expectedVersion });
    return this.mutate(commandCtx, "inventory.item.delete", "inventory_item", itemId, async () => {
      const item = await this.ports.inventory.retireItem(itemId, expectedVersion!, commandCtx);
      return { value: item, entityId: itemId, version: item.version };
    });
  }

  async updateInventoryItem(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<InventoryItem>> {
    const itemId = requireId(id, "item id");
    const parsed = updateInventoryItemSchema.parse(input) as UpdateInventoryInput;
    return this.mutate(ctx, "inventory.item.update", "inventory_item", itemId, async () => {
      await this.validateInventoryCategoryReferences(parsed.categoryNodeId);
      if (parsed.kind !== undefined) {
        const current = await this.ports.inventory.getItem(itemId);
        if (!current) throw notFound("Inventory item", itemId);
        if (parsed.kind !== current.kind) {
          throw new ApplicationError("validation", "Cannot change inventory kind in place. Create a corrected replacement so reservations, evidence, and history stay attached to the original item");
        }
      }
      const item = await this.ports.inventory.updateItem(itemId, parsed, expectedVersion, ctx);
      const value = inventoryWithUnitStatus(item);
      return { value, entityId: value.id, version: value.version };
    });
  }

  async bulkUpdateInventoryItems(input: unknown, ctx: RequestContext): Promise<BulkMutation<InventoryBulkUpdateResult>> {
    if (ctx.idempotencyKey === undefined) throw new ApplicationError("validation", "Bulk inventory updates require an idempotency key");
    const parsed = inventoryBulkUpdateSchema.parse(input) as InventoryBulkUpdate;
    const execution: InventoryBulkUpdate = {
      targets: [...parsed.targets].sort((left, right) => left.itemId.localeCompare(right.itemId)),
      changes: normalizeInventoryBulkChanges(parsed.changes),
    };
    const canonical = canonicalInventoryBulkUpdate(execution);
    // Bulk retries must hash the parsed canonical command rather than a raw
    // transport body. This keeps whitespace, tag order/duplicates, and target
    // order from changing the meaning of one actor-scoped idempotency key.
    const commandContext = { ...ctx, fingerprint: inventoryBulkUpdateFingerprint(canonical) };
    return this.mutateBulk(commandContext, async () => {
      const result = await this.ports.inventory.bulkUpdateItems(execution, commandContext);
      const updated = result.updated.map((item) => inventoryWithUnitStatus(inventoryItemSchema.parse(item))).sort((left, right) => left.id.localeCompare(right.id));
      const unchanged = result.unchanged.map((item) => inventoryWithUnitStatus(inventoryItemSchema.parse(item))).sort((left, right) => left.id.localeCompare(right.id));
      const targetIds = new Set(execution.targets.map((target) => target.itemId));
      const resultIds = [...updated, ...unchanged].map((item) => item.id);
      const resultIdSet = new Set(resultIds);
      if (resultIds.length !== resultIdSet.size || resultIdSet.size !== targetIds.size || resultIds.some((itemId) => !targetIds.has(itemId))) {
        throw new ApplicationError("integrity_error", "Bulk inventory results must contain each requested item exactly once");
      }
      return { updated, unchanged };
    });
  }

  async recordStockEvent(input: StockEventInput, ctx: RequestContext, expectedVersion?: number): Promise<Mutation<StockMutation>> {
    const parsed = stockEventInputSchema.parse(input);
    assertOptionalVersion(expectedVersion);
    // The generic stock-event path (MCP count_correction) corrects stock that
    // is already counted; it never promotes ordered, delivered or unknown
    // evidence (docs/stock-evidence-semantics.md).
    if (parsed.type === "count") return this.countInventory(parsed.itemId, parsed.quantity, ctx, parsed.unit, parsed.note, true, expectedVersion);
    return this.mutate(ctx, `inventory.stock.${parsed.type}`, "inventory_item", parsed.itemId, async () => {
      const current = await this.ports.inventory.getItem(parsed.itemId);
      if (!current) throw notFound("Inventory item", parsed.itemId);
      assertItemVersion(current, expectedVersion);
      // Delivered/ordered rows carry a recorded (claimed) quantity, not a
      // count. Generic movements would silently adjust that claim, so they
      // require a receiving count first. Reservations and project usage of
      // policy-trusted stock use their own audited paths.
      if (isCommissionableEvidence(current.evidence.state)) {
        throw conflict("Receive this item with a physical count (or commission it) before recording other stock movements", {
          reason: "evidence_not_received",
          itemId: parsed.itemId,
          evidenceState: current.evidence.state,
          recoveryAction: "record_physical_count",
          retryable: false
        });
      }
      assertCompatibleInventoryUnit(current, `Cannot record ${parsed.type}`);
      const mutation = await this.ports.inventory.recordStockEvent(parsed, ctx);
      return { value: { ...mutation, item: inventoryWithUnitStatus(mutation.item) }, entityId: mutation.item.id, version: mutation.item.version };
    });
  }

  async recordPhysicalCount(itemId: string, quantity: number, ctx: RequestContext, unit?: InventoryItem["unit"], note?: string, expectedVersion?: number): Promise<Mutation<StockMutation>> {
    return this.countInventory(itemId, quantity, ctx, unit, note, false, expectedVersion);
  }

  private async countInventory(itemId: string, quantity: number, ctx: RequestContext, unit: InventoryItem["unit"] | undefined, note: string | undefined, correctionOnly: boolean, expectedVersion?: number): Promise<Mutation<StockMutation>> {
    assertOptionalVersion(expectedVersion);
    const parsedId = requireId(itemId, "item id");
    if (!Number.isFinite(quantity) || quantity < 0) throw new ApplicationError("validation", "Physical count must be zero or greater");
    return this.mutate(ctx, "inventory.stock.count", "inventory_item", parsedId, async () => {
      const current = await this.ports.inventory.getItem(parsedId);
      if (!current) throw notFound("Inventory item", parsedId);
      assertItemVersion(current, expectedVersion);
      if (correctionOnly && !isConfirmedEvidence(current.evidence.state)) {
        throw conflict("A count correction cannot establish counted stock; commission the item or record a physical count", {
          reason: "evidence_not_counted",
          itemId: parsedId,
          evidenceState: current.evidence.state,
          recoveryAction: "commission_inventory_item",
          retryable: false
        });
      }
      assertCompatibleInventoryUnit(current, "Cannot record a physical count");
      if (unit !== undefined && unit !== current.unit) throw new ApplicationError("validation", `Unit mismatch: item uses ${current.unit}, count uses ${unit}`);
      // A physical count of delivered or ordered stock is what receiving
      // means: it records `physically_counted` evidence and keeps the prior
      // evidence in the append-only count event.
      const receiving = isCommissionableEvidence(current.evidence.state);
      const value = this.ports.inventory.recordPhysicalCount
        ? await this.ports.inventory.recordPhysicalCount(parsedId, quantity, ctx, note ?? (receiving ? "Received and counted" : undefined))
        : await this.recordPhysicalCountFallback(parsedId, quantity, ctx, note);
      return {
        value: { ...value, item: inventoryWithUnitStatus(value.item) },
        entityId: value.item.id,
        version: value.item.version,
        ...(receiving ? { auditChange: { received: true, evidenceFrom: current.evidence.state, evidenceTo: value.item.evidence.state } } : {})
      };
    });
  }

  /**
   * Promote uncertain delivery/order evidence only through a counted,
   * provenance-bearing ledger command. Generic metadata PATCHes cannot change
   * evidence, so this operation preserves both the new commissioning evidence
   * and the prior evidence in the append-only stock event.
   */

  async commissionInventoryItem(itemId: string, input: CommissionInventoryItem, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<StockMutation>> {
    const parsedId = requireId(itemId, "item id");
    const parsed = commissionInventoryItemSchema.parse(input);
    const commandCtx = commandContext(ctx, "inventory.item.commission", { itemId: parsedId, expectedVersion, input: parsed });
    return this.mutate(commandCtx, "inventory.item.commission", "inventory_item", parsedId, async () => {
      const current = await this.ports.inventory.getItem(parsedId);
      if (!current) throw notFound("Inventory item", parsedId);
      assertCompatibleInventoryUnit(current, "Cannot commission inventory");
      if (!isCommissionableEvidence(current.evidence.state)) {
        throw conflict("Only delivered or ordered inventory can be commissioned; record a physical count for other evidence states");
      }
      if (this.ports.inventory.commissionItem === undefined) {
        throw new ApplicationError("integrity_error", "This runtime does not support inventory commissioning");
      }
      const mutation = await this.ports.inventory.commissionItem(parsedId, parsed, expectedVersion, commandCtx);
      return { value: { ...mutation, item: inventoryWithUnitStatus(mutation.item) }, entityId: mutation.item.id, version: mutation.item.version };
    });
  }

  private async recordPhysicalCountFallback(itemId: string, quantity: number, ctx: RequestContext, note?: string): Promise<StockMutation> {
    const current = await this.ports.inventory.getItem(itemId);
    if (!current) throw notFound("Inventory item", itemId);
    const stock = await this.ports.inventory.recordStockEvent({ itemId, type: "count", quantity, unit: current.unit, ...(note === undefined ? {} : { note }) }, ctx);
    const updated = await this.ports.inventory.updateItem(itemId, { quantity, evidence: { ...current.evidence, state: "physically_counted", observedAt: nowIso() } }, stock.item.version, ctx);
    return { event: stock.event, item: updated };
  }

  async listStockEvents(itemId: string, limit = 50, cursor?: string) {
    return this.ports.unitOfWork.exclusive(() => this.ports.inventory.listStockEvents(requireId(itemId, "item id"), Math.min(Math.max(limit, 1), 200), cursor));
  }
}
