import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type {
  Artifact, BomLine, CreateBomLine, CreateInventoryItem, CreateOffer, CreateProject,
  CreateProjectRevision, CreateReservation, CreateWorkItem, CreateWorkItemRevision,
  CreateProjectWithInitialRevision, InventoryItem, Offer, Project, ProjectRevision, ProjectWithInitialRevision, Reservation, StockEvent,
  StockEventInput, UploadSession, WorkItem, WorkItemRevision, CatalogProduct, CreateCatalogProduct,
  UpdateCatalogProduct, InventoryProductProfile, CreateInventoryProductProfile,
  UpdateInventoryProductProfile, BuildConfigurationSnapshot, CreateBuildConfigurationSnapshot, ProjectTombstone,
  ArtifactBuildConfigurationBinding, CommissionInventoryItem, InventoryCategory, CreateInventoryCategory, UpdateInventoryCategory,
  CommitProjectSetup, ProjectSetupCommitResult, ProjectSetupPreview, BomAlternative, InspectionCompletionPreview, InspectionEvidence, InspectionObservation
} from "@benchledger/api-contract";
import { bomAlternativeSchema, buildConfigurationSnapshotSchema, buildConfigurationSnapshotStorageInputSchema } from "@benchledger/api-contract";
import { ApplicationError, applyInventoryBulkChanges, bomSpecification, conflict, matchesBomConstraints, normalizeInventoryBulkChanges, parseInventoryCursor, stableCreateConflict } from "@benchledger/application";
import type {
  ApplicationPorts, ArtifactDownload, ArtifactPort, AuditEvent, AuditInput, AuditPort,
  BeginUploadInput, EventBusEvent, EventBusPort, HealthPort, IdempotencyPort,
  BuildConfigurationListOptions, BuildConfigurationPort, CatalogPort, CatalogProductListOptions,
  InventoryCategoryListOptions, InventoryCategoryPort, InventoryListOptions, InventoryPort, OfferPort, Page, ProjectListOptions, ProjectPort, ProjectSetupPort, RequestContext,
  InspectionCommitInput, InspectionCommitReceipt, InspectionPort,
  InventoryBulkUpdate, InventoryBulkUpdateResult, ReservationDetails, StockMutation, UnitOfWorkOperation, UnitOfWorkPort, UpdateInventoryInput, UploadSessionDetails, UsageInput
} from "@benchledger/application";
import { BUILTIN_INVENTORY_CATEGORIES, canonicalProjectStatus, compareInventoryCategoryKeys, normalizeInventoryCategoryKey, normalizeInventoryCategoryName, slugify } from "@benchledger/domain";
import { computeBuildConfigurationContentSha256 } from "@benchledger/runtime";

const clone = <T>(value: T): T => structuredClone(value);

function parseMemoryBuildConfigurationSnapshot(value: unknown): BuildConfigurationSnapshot {
  try {
    const snapshot = buildConfigurationSnapshotSchema.parse(value);
    if (computeBuildConfigurationContentSha256(snapshot) !== snapshot.contentSha256) {
      throw new ApplicationError("integrity_error", `Build configuration snapshot '${snapshot.id}' content hash does not match its configuration`);
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("integrity_error", "Stored build configuration snapshot failed integrity validation");
  }
}

const MAX_CATEGORY_CURSOR_LENGTH = 512;
const MAX_INVENTORY_QUERY_LENGTH = 200;
const MAX_INVENTORY_PAGE_SIZE = 200;
const MAX_INVENTORY_CURSOR_LENGTH = 200;
const CATEGORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function iso(): string {
  return new Date().toISOString();
}

function id(prefix: string, counter: number): string {
  return `${prefix}-${counter.toString(36)}-${Date.now().toString(36)}`;
}

function page<T>(items: readonly T[], limit: number, cursor?: string): Page<T> {
  const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const selected = items.slice(safeOffset, safeOffset + limit);
  const next = safeOffset + selected.length < items.length ? String(safeOffset + selected.length) : undefined;
  return { data: clone(selected), limit, ...(next ? { nextCursor: next } : {}), total: items.length };
}

function encodeCategoryCursor(categoryId: string): string {
  return Buffer.from(categoryId, "utf8").toString("base64url");
}

function decodeCategoryCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length === 0 || value.length > MAX_CATEGORY_CURSOR_LENGTH) throw new Error("cursor length out of bounds");
    // Match the production repository's strict, unpadded base64url contract;
    // Buffer.from alone accepts punctuation and non-canonical encodings.
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw new Error("invalid base64url");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical base64url");
    const decoded = bytes.toString("utf8");
    let categoryId = decoded;
    // Preserve cursors emitted by the superseded JSON form while new cursors
    // remain compact and contain only the immutable category ID.
    if (decoded.startsWith("{")) {
      const parsed: unknown = JSON.parse(decoded);
      if (parsed === null || typeof parsed !== "object") throw new Error("not object");
      const candidate = parsed as Record<string, unknown>;
      categoryId = typeof candidate.id === "string" ? candidate.id : "";
    }
    if (!CATEGORY_ID_PATTERN.test(categoryId) || categoryId.length > 160) throw new Error("invalid fields");
    return categoryId;
  } catch {
    throw new ApplicationError("validation", "cursor is invalid or expired");
  }
}

function compareInventoryCategories(left: InventoryCategory, right: InventoryCategory): number {
  return left.sortOrder - right.sortOrder
    || compareInventoryCategoryKeys(left.name, right.name)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function catalogSearchText(product: CatalogProduct): string {
  const fields = product.kind === "filament"
    ? [product.id, product.kind, product.manufacturer, product.productName, product.sku, product.materialFamily, product.materialSubtype, product.colourName, product.colourCode, product.diameterMm, product.nominalNetMassG, product.nominalLengthM, product.lengthBasis, product.densityGcm3]
    : [product.id, product.kind, product.manufacturer, product.exactModel, product.exactVariant, product.technology, product.buildVolumeMm.x, product.buildVolumeMm.y, product.buildVolumeMm.z];
  return fields.filter((value) => value !== undefined).join(" ").toLocaleLowerCase();
}

const FILAMENT_FACT_FIELDS = [
  "manufacturer",
  "productName",
  "sku",
  "materialFamily",
  "materialSubtype",
  "colourName",
  "colourCode",
  "diameterMm",
  "nominalNetMassG",
  "nominalLengthM",
  "lengthBasis",
  "densityGcm3",
] as const;

const PRINTER_FACT_FIELDS = [
  "manufacturer",
  "exactModel",
  "exactVariant",
  "technology",
  "buildVolumeMm",
] as const;

function stableCatalogFact(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCatalogFact).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableCatalogFact(record[key])}`).join(",")}}`;
}

function sameCatalogFact(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || stableCatalogFact(left) === stableCatalogFact(right);
}

/** A corrected identity/specification fact invalidates the old verification. */
function catalogFactsChanged(current: CatalogProduct, changes: Record<string, unknown>): boolean {
  const currentRecord = current as unknown as Record<string, unknown>;
  const fields = current.kind === "filament" ? FILAMENT_FACT_FIELDS : PRINTER_FACT_FIELDS;
  return fields.some((field) => Object.hasOwn(changes, field) && !sameCatalogFact(currentRecord[field], changes[field]));
}
function canCount(evidence: InventoryItem["evidence"]["state"]): boolean {
  return evidence === "physically_counted" || evidence === "commissioned";
}

function ensureVersion(actual: number, expected: number | undefined, entity: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new ApplicationError("conflict", `${entity} changed since it was read`, { expectedVersion: expected, actualVersion: actual });
  }
}

function ensurePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new ApplicationError("validation", `${label} must be positive`);
}

type QuantityConversion = NonNullable<BomAlternative["quantityConversion"]>;

function canonicalBomAlternatives(value: readonly BomAlternative[]): BomAlternative[] {
  return value.map((alternative) => bomAlternativeSchema.parse(alternative));
}

function bomQuantityConversion(line: Pick<BomLine, "unit" | "alternatives">, item: Pick<InventoryItem, "id" | "unit">): QuantityConversion | undefined {
  if (item.unit === line.unit) return undefined;
  const conversions = line.alternatives
    .filter((alternative) => alternative.itemId === item.id)
    .flatMap((alternative) => {
      const conversion = alternative.quantityConversion;
      return conversion !== undefined && conversion.inventory.unit === item.unit && conversion.requirement.unit === line.unit
        ? [conversion]
        : [];
    });
  const factors = new Set(conversions.map((conversion) => conversion.requirement.quantity));
  return factors.size === 1 ? conversions[0] : undefined;
}

function normalizeInventoryListOptions(options: InventoryListOptions): InventoryListOptions {
  if (options.q !== undefined && typeof options.q !== "string") {
    throw new ApplicationError("validation", "q must be a string");
  }
  if (options.q !== undefined && options.q.length > MAX_INVENTORY_QUERY_LENGTH) {
    throw new ApplicationError("validation", `q must be at most ${MAX_INVENTORY_QUERY_LENGTH} characters`);
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_INVENTORY_PAGE_SIZE) {
    throw new ApplicationError("validation", `limit must be an integer between 1 and ${MAX_INVENTORY_PAGE_SIZE}`);
  }
  if (options.cursor !== undefined && typeof options.cursor !== "string") {
    throw new ApplicationError("validation", "cursor must be a string");
  }
  if (options.cursor !== undefined && options.cursor.length > MAX_INVENTORY_CURSOR_LENGTH) {
    throw new ApplicationError("validation", `cursor must be at most ${MAX_INVENTORY_CURSOR_LENGTH} characters`);
  }
  if (options.categoryNodeId !== undefined && options.unassigned === true) {
    throw new ApplicationError("validation", "categoryNodeId and unassigned cannot be combined");
  }
  return options.q === undefined ? options : { ...options, q: options.q.trim() };
}

function ensureItemUnit(item: InventoryItem, unit: InventoryItem["unit"]): void {
  if (item.unit !== unit) throw new ApplicationError("validation", `Unit mismatch: item uses ${item.unit}, event uses ${unit}`);
}

function ensureDescriptiveUpdate(input: UpdateInventoryInput): void {
  const controlledField = Object.keys(input).find((field) => ["quantity", "availableQuantity", "evidence", "unit"].includes(field));
  if (controlledField !== undefined) throw new ApplicationError("validation", `${controlledField} is controlled by stock events`);
}

class MemoryInventory implements InventoryPort {
  readonly items = new Map<string, InventoryItem>();
  readonly events = new Map<string, StockEvent[]>();
  private sequence = 100;

  constructor(seed: readonly InventoryItem[] = []) {
    for (const item of seed) this.items.set(item.id, clone(item));
  }

  snapshotState() {
    return {
      items: [...this.items].map(([key, value]) => [key, clone(value)] as const),
      events: [...this.events].map(([key, value]) => [key, clone(value)] as const),
      sequence: this.sequence
    };
  }

  restoreState(snapshot: ReturnType<MemoryInventory["snapshotState"]>): void {
    this.items.clear(); for (const [key, value] of snapshot.items) this.items.set(key, clone(value));
    this.events.clear(); for (const [key, value] of snapshot.events) this.events.set(key, clone(value));
    this.sequence = snapshot.sequence;
  }

  async listItems(options: InventoryListOptions): Promise<Page<InventoryItem>> {
    const normalizedOptions = normalizeInventoryListOptions(options);
    const normalized = normalizedOptions.q?.toLocaleLowerCase();
    const items = [...this.items.values()].filter((item) => {
      if (!normalizedOptions.includeRetired && item.retiredAt !== undefined) return false;
      if (normalizedOptions.kind && item.kind !== normalizedOptions.kind) return false;
      if (normalizedOptions.evidence && item.evidence.state !== normalizedOptions.evidence) return false;
      if (normalizedOptions.available !== undefined && (item.availableQuantity > 0) !== normalizedOptions.available) return false;
      if (normalizedOptions.categoryNodeId !== undefined && item.categoryNodeId !== normalizedOptions.categoryNodeId) return false;
      if (normalizedOptions.unassigned === true && item.categoryNodeId !== undefined) return false;
      if (!normalized) return true;
      return [item.name, item.description, item.manufacturer, item.model, item.sku, item.location, ...item.tags].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalized);
    }).sort((a, b) => a.name.trim().toLocaleLowerCase().localeCompare(b.name.trim().toLocaleLowerCase()) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const offset = parseInventoryCursor(normalizedOptions.cursor);
    const selected = items.slice(offset, offset + normalizedOptions.limit);
    const nextOffset = offset + selected.length < items.length ? offset + selected.length : undefined;
    return { data: clone(selected), limit: normalizedOptions.limit, total: items.length, ...(nextOffset === undefined ? {} : { nextCursor: String(nextOffset) }) };
  }

  getItem(itemId: string): Promise<InventoryItem | null> {
    const item = this.items.get(itemId);
    return Promise.resolve(item ? clone(item) : null);
  }

  createItem(input: CreateInventoryItem): Promise<InventoryItem> {
    const itemId = input.id ?? id("item", ++this.sequence);
    if (this.items.has(itemId)) throw new ApplicationError("conflict", `Inventory item '${itemId}' already exists`);
    const createdAt = iso();
    const evidence = input.evidence;
    const item: InventoryItem = {
      id: itemId, name: input.name.trim(), kind: input.kind,
      ...(input.categoryNodeId === undefined ? {} : { categoryNodeId: input.categoryNodeId }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.manufacturer === undefined ? {} : { manufacturer: input.manufacturer }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.sku === undefined ? {} : { sku: input.sku }),
      quantity: input.quantity, availableQuantity: canCount(evidence.state) ? Math.min(input.quantity, input.availableQuantity ?? input.quantity) : 0,
      unit: input.unit,
      ...(input.location === undefined ? {} : { location: input.location }),
      ...(input.condition === undefined ? {} : { condition: input.condition }),
      ...(input.dimensions === undefined ? {} : { dimensions: clone(input.dimensions) }),
      tags: [...input.tags], links: clone(input.links), evidence: clone(evidence), createdAt, updatedAt: createdAt, version: 1
    };
    this.items.set(itemId, item);
    if (canCount(evidence.state)) {
      const initialEvents: StockEvent[] = [{
        id: `${itemId}-initial-count`, itemId, type: "count", quantity: input.quantity, unit: input.unit,
        actor: "system", source: "import", evidence: { bootstrap: true }, createdAt, itemVersion: 1
      }];
      const initiallyAllocated = input.quantity - (input.availableQuantity ?? input.quantity);
      if (initiallyAllocated > 0) initialEvents.push({
        id: `${itemId}-initial-allocation`, itemId, type: "allocate", quantity: initiallyAllocated, unit: input.unit,
        actor: "system", source: "import", evidence: { bootstrap: true }, createdAt, itemVersion: 1
      });
      this.events.set(itemId, initialEvents);
    }
    return Promise.resolve(clone(item));
  }

  /** Internal compensation for the atomic inventory/profile command. */
  rollbackCreatedItem(itemId: string): Promise<void> {
    const current = this.items.get(itemId);
    if (current === undefined) return Promise.resolve();
    if (current.version !== 1) throw new ApplicationError("integrity_error", "Created inventory item is no longer compensatable");
    this.items.delete(itemId);
    this.events.delete(itemId);
    return Promise.resolve();
  }

  updateItem(itemId: string, input: UpdateInventoryInput, expectedVersion: number | undefined): Promise<InventoryItem> {
    ensureDescriptiveUpdate(input);
    const current = this.items.get(itemId);
    if (!current) throw new ApplicationError("not_found", `Inventory item '${itemId}' was not found`);
    ensureVersion(current.version, expectedVersion, "Inventory item");
    const nextCategoryNodeId = input.categoryNodeId === null ? undefined : input.categoryNodeId ?? current.categoryNodeId;
    const next = {
      ...current,
      ...input,
      ...(nextCategoryNodeId === undefined ? { categoryNodeId: undefined } : { categoryNodeId: nextCategoryNodeId }),
      ...(input.tags ? { tags: [...input.tags] } : {}),
      ...(input.links ? { links: clone(input.links) } : {}),
      ...(input.dimensions ? { dimensions: clone(input.dimensions) } : {}),
      updatedAt: iso(), version: current.version + 1
    } as InventoryItem;
    this.items.set(itemId, next);
    return Promise.resolve(clone(next));
  }

  bulkUpdateItems(input: InventoryBulkUpdate, _ctx: RequestContext): Promise<InventoryBulkUpdateResult> {
    if (!Number.isSafeInteger(input.targets.length) || input.targets.length < 1 || input.targets.length > 100) {
      throw new ApplicationError("validation", "Bulk inventory updates require between 1 and 100 targets");
    }
    const changes = normalizeInventoryBulkChanges(input.changes);
    const targets = [...input.targets].sort((left, right) => left.itemId.localeCompare(right.itemId));
    const seen = new Set<string>();
    const staleTargets: Array<{ readonly itemId: string; readonly expectedVersion: number; readonly actualVersion: number }> = [];
    const prepared = targets.map((target) => {
      if (seen.has(target.itemId)) throw new ApplicationError("validation", "Bulk targets must contain unique item ids");
      seen.add(target.itemId);
      if (!Number.isSafeInteger(target.expectedVersion) || target.expectedVersion <= 0) throw new ApplicationError("validation", "Bulk targets require a positive expected version");
      const current = this.items.get(target.itemId);
      if (current === undefined || current.retiredAt !== undefined) throw new ApplicationError("not_found", `Inventory item '${target.itemId}' was not found`);
      if (current.version !== target.expectedVersion) {
        staleTargets.push({ itemId: target.itemId, expectedVersion: target.expectedVersion, actualVersion: current.version });
      }
      const applied = applyInventoryBulkChanges(current, changes);
      return { target, current, applied };
    });
    if (staleTargets.length > 0) {
      throw new ApplicationError("conflict", "One or more inventory items changed since they were read", { staleTargets });
    }
    const updated: InventoryItem[] = [];
    const unchanged: InventoryItem[] = [];
    for (const entry of prepared) {
      if (!entry.applied.changed) {
        unchanged.push(clone(entry.current));
        continue;
      }
      const now = iso();
      const next = { ...entry.applied.item, updatedAt: now, version: entry.current.version + 1 };
      this.items.set(entry.current.id, next);
      updated.push(clone(next));
    }
    return Promise.resolve({ updated: updated.sort((left, right) => left.id.localeCompare(right.id)), unchanged: unchanged.sort((left, right) => left.id.localeCompare(right.id)) });
  }

  async recordPhysicalCount(itemId: string, quantity: number, ctx: RequestContext, note?: string): Promise<StockMutation> {
    return this.recordCount(itemId, quantity, ctx, undefined, "physically_counted", undefined, note);
  }

  /** Internal inspection path that preserves the observation's provenance in
   * both the current item evidence and its append-only count event. */
  async recordPhysicalInspection(itemId: string, quantity: number, observation: InspectionObservation, ctx: RequestContext): Promise<StockMutation> {
    return this.recordCount(itemId, quantity, ctx, undefined, "physically_counted", undefined, observation.note, {
      state: "physically_counted",
      source: observation.source,
      ...(observation.sourceId === undefined ? {} : { sourceId: observation.sourceId }),
      observedAt: observation.observedAt,
      ...(observation.note === undefined ? {} : { note: observation.note })
    });
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
    note?: string,
    observedEvidence?: InventoryItem["evidence"]
  ): Promise<StockMutation> {
    const current = this.items.get(itemId);
    if (!current) throw new ApplicationError("not_found", `Inventory item '${itemId}' was not found`);
    if (!Number.isFinite(quantity) || quantity < 0) throw new ApplicationError("validation", "Physical count must be zero or greater");
    if (evidenceState === "commissioned" && canCount(current.evidence.state)) {
      throw new ApplicationError("conflict", "Inventory item is already confirmed; record a physical count if the quantity changed");
    }
    ensureItemUnit(current, commissioning?.unit ?? current.unit);
    ensureVersion(current.version, expectedVersion, "Inventory item");
    const allocated = canCount(current.evidence.state) ? current.quantity - current.availableQuantity : 0;
    if (quantity < allocated) throw new ApplicationError("conflict", "Physical count cannot be below allocated quantity");
    const now = iso();
    const evidence = commissioning?.evidence ?? observedEvidence ?? { ...current.evidence, state: "physically_counted" as const, observedAt: now };
    const updated: InventoryItem = {
      ...current,
      quantity,
      availableQuantity: quantity - allocated,
      evidence: clone(evidence),
      updatedAt: now,
      version: current.version + 1
    };
    const event: StockEvent = {
      itemId,
      type: "count",
      quantity,
      unit: current.unit,
      note: evidence.note ?? note,
      evidence: {
        state: evidenceState,
        previousEvidence: current.evidence,
        ...(evidence.source === undefined ? {} : { source: evidence.source }),
        ...(evidence.sourceId === undefined ? {} : { sourceId: evidence.sourceId }),
        ...(evidence.observedAt === undefined ? {} : { observedAt: evidence.observedAt }),
      },
      id: id("stock", ++this.sequence),
      actor: ctx.actor,
      source: ctx.source === "system" ? "api" : ctx.source,
      createdAt: now,
      itemVersion: updated.version
    };
    this.items.set(itemId, updated);
    const events = this.events.get(itemId) ?? [];
    this.events.set(itemId, [...events, event]);
    return { event: clone(event), item: clone(updated) };
  }

  recordStockEvent(input: StockEventInput, ctx: RequestContext): Promise<StockMutation> {
    const current = this.items.get(input.itemId);
    if (!current) throw new ApplicationError("not_found", `Inventory item '${input.itemId}' was not found`);
    ensureItemUnit(current, input.unit);
    if (input.type === "count") return this.recordCount(input.itemId, input.quantity, ctx, undefined, "physically_counted");
    ensurePositive(input.quantity, "Event quantity");
    let quantity = current.quantity;
    let availableQuantity = current.availableQuantity;
    let evidence = current.evidence;
    if (["receipt", "return"].includes(input.type)) {
      quantity += input.quantity;
      if (canCount(current.evidence.state)) availableQuantity += input.quantity;
    } else if (["allocate", "consume", "loss", "dispose"].includes(input.type)) {
      if (input.quantity > availableQuantity) throw new ApplicationError("conflict", "Stock event would make available quantity negative");
      availableQuantity -= input.quantity;
      if (["consume", "loss", "dispose"].includes(input.type)) quantity -= input.quantity;
    } else if (input.type === "release") {
      availableQuantity = Math.min(quantity, availableQuantity + input.quantity);
    } else if (input.type === "correction") {
      quantity += input.quantity;
      if (canCount(current.evidence.state)) availableQuantity += input.quantity;
    }
    const updated: InventoryItem = { ...current, quantity, availableQuantity, evidence, updatedAt: iso(), version: current.version + 1 };
    const event: StockEvent = {
      ...input,
      id: id("stock", ++this.sequence),
      actor: ctx.actor,
      source: ctx.source === "system" ? "api" : ctx.source,
      createdAt: iso(),
      itemVersion: updated.version
    };
    this.items.set(input.itemId, updated);
    const events = this.events.get(input.itemId) ?? [];
    this.events.set(input.itemId, [...events, event]);
    return Promise.resolve({ event: clone(event), item: clone(updated) });
  }

  listStockEvents(itemId: string, limit: number, cursor?: string): Promise<Page<StockEvent>> {
    return Promise.resolve(page(this.events.get(itemId) ?? [], limit, cursor));
  }
}

class MemoryInventoryCategories implements InventoryCategoryPort {
  readonly categories = new Map<string, InventoryCategory>();
  private sequence = 700;

  constructor(private readonly inventory: MemoryInventory, seed: readonly InventoryCategory[] = []) {
    for (const category of seed) this.categories.set(category.id, clone(category));
  }

  listCategories(options: InventoryCategoryListOptions): Promise<Page<InventoryCategory>> {
    const all = [...this.categories.values()].sort(compareInventoryCategories);
    const cursorId = decodeCategoryCursor(options.cursor);
    const cursorCategory = cursorId === undefined ? undefined : this.categories.get(cursorId);
    if (cursorId !== undefined && cursorCategory === undefined) throw new ApplicationError("validation", "cursor is invalid or expired");
    const visible = all.filter((category) => (options.includeArchived || !category.archived) && (cursorCategory === undefined || compareInventoryCategories(category, cursorCategory) > 0));
    const total = all.filter((category) => options.includeArchived || !category.archived).length;
    const selected = visible.slice(0, options.limit);
    const last = selected.at(-1);
    return Promise.resolve({ data: clone(selected), limit: options.limit, total, ...(visible.length > selected.length && last !== undefined ? { nextCursor: encodeCategoryCursor(last.id) } : {}) });
  }

  getCategory(categoryId: string): Promise<InventoryCategory | null> {
    const category = this.categories.get(categoryId);
    return Promise.resolve(category === undefined ? null : clone(category));
  }

  getItemCategoryNode(itemId: string): Promise<string | null> {
    return Promise.resolve(this.inventory.items.get(itemId)?.categoryNodeId ?? null);
  }

  assignItemCategory(itemId: string, categoryNodeId: string | null): Promise<void> {
    const current = this.inventory.items.get(itemId);
    if (current === undefined) throw new ApplicationError("not_found", `Inventory item '${itemId}' was not found`);
    const next = categoryNodeId === null ? { ...current, categoryNodeId: undefined } : { ...current, categoryNodeId };
    this.inventory.items.set(itemId, clone(next));
    return Promise.resolve();
  }

  createCategory(input: CreateInventoryCategory): Promise<InventoryCategory> {
    const parent = input.parentId === undefined ? undefined : this.categories.get(input.parentId);
    if (input.parentId !== undefined && parent === undefined) throw new ApplicationError("not_found", `Inventory category '${input.parentId}' was not found`);
    if (parent?.parentId !== undefined) throw new ApplicationError("validation", "Categories support only one level of subcategories");
    if (parent?.archived) throw new ApplicationError("validation", "An archived category cannot receive subcategories");
    const name = normalizeInventoryCategoryName(input.name);
    this.assertSiblingUnique(name, input.parentId, input.id);
    const createdAt = iso();
    const category: InventoryCategory = {
      id: input.id ?? id("category", ++this.sequence), name,
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      sortOrder: input.sortOrder ?? 0, archived: false, createdAt, updatedAt: createdAt, version: 1
    };
    if (this.categories.has(category.id)) throw new ApplicationError("conflict", `Inventory category '${category.id}' already exists`);
    this.categories.set(category.id, clone(category));
    return Promise.resolve(clone(category));
  }

  updateCategory(categoryId: string, input: UpdateInventoryCategory, expectedVersion: number): Promise<InventoryCategory> {
    const current = this.categories.get(categoryId);
    if (current === undefined) throw new ApplicationError("not_found", `Inventory category '${categoryId}' was not found`);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new ApplicationError("validation", "expectedVersion is required and must be a positive integer");
    ensureVersion(current.version, expectedVersion, "Inventory category");
    const name = input.name === undefined ? current.name : normalizeInventoryCategoryName(input.name);
    this.assertSiblingUnique(name, current.parentId, categoryId);
    const updated: InventoryCategory = { ...current, name, sortOrder: input.sortOrder ?? current.sortOrder, updatedAt: iso(), version: current.version + 1 };
    this.categories.set(categoryId, clone(updated));
    return Promise.resolve(clone(updated));
  }

  archiveCategory(categoryId: string, expectedVersion: number): Promise<InventoryCategory> {
    const current = this.categories.get(categoryId);
    if (current === undefined) throw new ApplicationError("not_found", `Inventory category '${categoryId}' was not found`);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new ApplicationError("validation", "expectedVersion is required and must be a positive integer");
    ensureVersion(current.version, expectedVersion, "Inventory category");
    if ([...this.categories.values()].some((candidate) => candidate.parentId === categoryId && !candidate.archived)) {
      throw new ApplicationError("conflict", `Inventory category '${categoryId}' has active subcategories`);
    }
    if ([...this.inventory.items.values()].some((item) => item.retiredAt === undefined && item.categoryNodeId === categoryId)) {
      throw new ApplicationError("conflict", `Inventory category '${categoryId}' is referenced by active inventory`);
    }
    const updated: InventoryCategory = { ...current, archived: true, updatedAt: iso(), version: current.version + 1 };
    this.categories.set(categoryId, clone(updated));
    return Promise.resolve(clone(updated));
  }

  private assertSiblingUnique(name: string, parentId: string | undefined, selfId: string | undefined): void {
    const normalized = normalizeInventoryCategoryKey(name);
    if ([...this.categories.values()].some((candidate) => candidate.id !== selfId && (candidate.parentId ?? "") === (parentId ?? "") && normalizeInventoryCategoryKey(candidate.name) === normalized)) {
      throw new ApplicationError("conflict", `A category named '${name}' already exists beside this category`);
    }
  }
}

class MemoryProjects implements ProjectPort {
  readonly projects = new Map<string, Project>();
  /** Original generated slugs are immutable identities, even after rename. */
  private readonly projectSlugs = new Map<string, string>();
  readonly workItems = new Map<string, WorkItem>();
  readonly projectRevisions = new Map<string, ProjectRevision>();
  readonly workItemRevisions = new Map<string, WorkItemRevision>();
  readonly bomLines = new Map<string, BomLine>();
  readonly reservations = new Map<string, Reservation>();
  private sequence = 200;
  private readonly archiveSnapshots = new Map<string, {
    readonly project: Project;
    readonly reservations: readonly (readonly [string, Reservation])[];
    readonly items: readonly (readonly [string, InventoryItem])[];
    readonly events: readonly (readonly [string, StockEvent[] | undefined])[];
  }>();
  private readonly removalSnapshots = new Map<string, {
    readonly projects: readonly (readonly [string, Project])[];
    readonly reservations: readonly (readonly [string, Reservation])[];
    readonly items: readonly (readonly [string, InventoryItem])[];
    readonly events: readonly (readonly [string, StockEvent[]])[];
  }>();

  constructor(private readonly inventory: MemoryInventory) {}

  snapshotState() {
    return {
      projects: [...this.projects].map(([key, value]) => [key, clone(value)] as const),
      projectSlugs: [...this.projectSlugs].map(([key, value]) => [key, value] as const),
      workItems: [...this.workItems].map(([key, value]) => [key, clone(value)] as const),
      projectRevisions: [...this.projectRevisions].map(([key, value]) => [key, clone(value)] as const),
      workItemRevisions: [...this.workItemRevisions].map(([key, value]) => [key, clone(value)] as const),
      bomLines: [...this.bomLines].map(([key, value]) => [key, clone(value)] as const),
      reservations: [...this.reservations].map(([key, value]) => [key, clone(value)] as const),
      sequence: this.sequence
    };
  }

  restoreState(snapshot: ReturnType<MemoryProjects["snapshotState"]>): void {
    this.projects.clear(); for (const [key, value] of snapshot.projects) this.projects.set(key, clone(value));
    this.projectSlugs.clear(); for (const [key, value] of snapshot.projectSlugs) this.projectSlugs.set(key, value);
    this.workItems.clear(); for (const [key, value] of snapshot.workItems) this.workItems.set(key, clone(value));
    this.projectRevisions.clear(); for (const [key, value] of snapshot.projectRevisions) this.projectRevisions.set(key, clone(value));
    this.workItemRevisions.clear(); for (const [key, value] of snapshot.workItemRevisions) this.workItemRevisions.set(key, clone(value));
    this.bomLines.clear(); for (const [key, value] of snapshot.bomLines) this.bomLines.set(key, clone(value));
    this.reservations.clear(); for (const [key, value] of snapshot.reservations) this.reservations.set(key, clone(value));
    this.sequence = snapshot.sequence;
  }

  listProjects(options: ProjectListOptions): Promise<Page<Project>> {
    const q = options.q?.trim().toLowerCase();
    const values = [...this.projects.values()].filter((project) => project.removedAt === undefined && (options.status === undefined ? project.status !== "archived" : project.status === options.status) && (!q || `${project.name} ${project.description ?? ""}`.toLowerCase().includes(q)));
    return Promise.resolve(page(values, options.limit, options.cursor));
  }
  getProject(idValue: string): Promise<Project | null> { const value = this.projects.get(idValue); return Promise.resolve(value ? clone(value) : null); }
  listRemovedProjects(): Promise<readonly ProjectTombstone[]> {
    return Promise.resolve(clone([...this.projects.values()].filter((project) => project.removedAt !== undefined).map((project) => this.projectTombstone(project))));
  }
  listRemovedProjectsPage(limit: number, cursor?: string): Promise<Page<ProjectTombstone>> {
    const values = [...this.projects.values()].filter((project) => project.removedAt !== undefined).map((project) => this.projectTombstone(project));
    return Promise.resolve(page(values, limit, cursor));
  }
  createProject(input: CreateProject): Promise<Project> {
    const projectId = input.id ?? id("project", ++this.sequence);
    if (this.projects.has(projectId)) throw new ApplicationError("conflict", `Project '${projectId}' already exists`);
    const createdAt = iso();
    const project: Project = { id: projectId, name: input.name.trim(), ...(input.description === undefined ? {} : { description: input.description }), status: canonicalProjectStatus(input.status), createdAt, updatedAt: createdAt, version: 1 };
    this.projects.set(projectId, project);
    this.projectSlugs.set(projectId, slugify(project.name));
    return Promise.resolve(clone(project));
  }
  /** Seed synthetic fixtures while keeping the same immutable slug index. */
  seedProject(project: Project): void {
    this.projects.set(project.id, clone(project));
    this.projectSlugs.set(project.id, slugify(project.name));
  }
  async createProjectWithInitialRevision(input: CreateProjectWithInitialRevision, ctx?: RequestContext): Promise<ProjectWithInitialRevision> {
    const projects = new Map([...this.projects].map(([key, value]) => [key, clone(value)] as const));
    const projectSlugs = new Map(this.projectSlugs);
    const revisions = new Map([...this.projectRevisions].map(([key, value]) => [key, clone(value)] as const));
    try {
      const projectId = input.project.id;
      const revisionId = input.revision.id;
      if (projectId !== undefined && this.projects.has(projectId)) {
        throw stableCreateConflict("project_id_exists", "projectId", projectId, "The project ID is already in use; read the existing project or choose a different project ID.", ctx?.idempotencyKey);
      }
      if (revisionId !== undefined && this.projectRevisions.has(revisionId)) {
        throw stableCreateConflict("revision_id_exists", "revisionId", revisionId, "The revision ID is already in use; choose a different revision ID.", ctx?.idempotencyKey);
      }
      const projectSlug = slugify(input.project.name);
      if ([...this.projectSlugs.values()].some((slug) => slug === projectSlug)) {
        throw stableCreateConflict("project_name_exists", "projectName", projectSlug, "A project with this name already exists; read the existing project or choose a different project name.", ctx?.idempotencyKey);
      }
      const project = await this.createProject(input.project);
      const revision = await this.createProjectRevision(project.id, input.revision);
      const currentProject = this.projects.get(project.id);
      if (currentProject === undefined) throw new ApplicationError("integrity_error", "Atomic project creation did not return its project");
      return { project: clone(currentProject), revision: clone(revision) };
    } catch (error: unknown) {
      this.projects.clear();
      for (const [key, value] of projects) this.projects.set(key, value);
      this.projectSlugs.clear();
      for (const [key, value] of projectSlugs) this.projectSlugs.set(key, value);
      this.projectRevisions.clear();
      for (const [key, value] of revisions) this.projectRevisions.set(key, value);
      throw error;
    }
  }
  updateProject(projectId: string, input: Partial<CreateProject>, expectedVersion: number | undefined): Promise<Project> {
    const current = this.projects.get(projectId); if (!current) throw new ApplicationError("not_found", `Project '${projectId}' was not found`);
    if (current.removedAt !== undefined) throw new ApplicationError("project_removed", `Project '${projectId}' has been removed from the workspace`);
    if (input.status === "archived") return this.archiveProject(projectId, expectedVersion, { actor: "system", source: "system", correlationId: `project:${projectId}:archive`, scopes: new Set() });
    if (input.status === "idea" && current.status === "archived") return this.restoreProject(projectId, expectedVersion, { actor: "system", source: "system", correlationId: `project:${projectId}:restore`, scopes: new Set() });
    ensureVersion(current.version, expectedVersion, "Project");
    const next: Project = { ...current, ...(input.name === undefined ? {} : { name: input.name }), ...(input.description === undefined ? {} : { description: input.description }), ...(input.status === undefined ? {} : { status: canonicalProjectStatus(input.status) }), updatedAt: iso(), version: current.version + 1 }; this.projects.set(projectId, next); return Promise.resolve(clone(next));
  }
  archiveProject(projectId: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Project> {
    const current = this.projects.get(projectId); if (!current) throw new ApplicationError("not_found", `Project '${projectId}' was not found`); ensureVersion(current.version, expectedVersion, "Project");
    if (current.removedAt !== undefined) throw new ApplicationError("project_removed", `Project '${projectId}' has been removed from the workspace`);
    // A no-op is a fresh read, never an opportunity to reuse a compensation
    // receipt from an earlier committed archive.
    if (current.status === "archived") {
      this.archiveSnapshots.delete(projectId);
      return Promise.resolve(clone(current));
    }
    const revisionIds = new Set([...this.projectRevisions.values()].filter((revision) => revision.projectId === projectId).map((revision) => revision.id));
    const lineIds = new Set([...this.bomLines.values()].filter((line) => revisionIds.has(line.revisionId)).map((line) => line.id));
    const active = [...this.reservations.values()].filter((reservation) => reservation.status === "active" && lineIds.has(reservation.lineId));
    // Preflight every dependency before changing reservations, stock, or
    // events. This keeps an incomplete reservation graph fail-closed.
    for (const reservation of active) {
      if (this.inventory.items.get(reservation.itemId) === undefined) {
        throw new ApplicationError("integrity_error", `Reservation '${reservation.id}' refers to missing inventory item`);
      }
    }
    const affectedItemIds = [...new Set(active.map((reservation) => reservation.itemId))];
    const snapshot = {
      project: clone(current),
      reservations: active.map((reservation) => [reservation.id, clone(reservation)] as const),
      items: affectedItemIds.map((itemId) => [itemId, clone(this.inventory.items.get(itemId)!)] as const),
      events: affectedItemIds.map((itemId) => [itemId, this.inventory.events.has(itemId) ? clone(this.inventory.events.get(itemId)!) : undefined] as const)
    };
    this.archiveSnapshots.set(projectId, snapshot);
    try {
      const archivedAt = iso();
      const actor = ctx.actor;
      for (const reservation of active) {
        const item = this.inventory.items.get(reservation.itemId)!;
        const updatedReservation: Reservation = { ...reservation, status: "released", updatedAt: archivedAt, version: reservation.version + 1 };
        this.reservations.set(reservation.id, updatedReservation);
        this.inventory.items.set(item.id, { ...item, availableQuantity: Math.min(item.quantity, item.availableQuantity + reservation.quantity), updatedAt: archivedAt, version: item.version + 1 });
        const event: StockEvent = {
          id: `reservation-${reservation.id}-release`, itemId: reservation.itemId, type: "release", quantity: reservation.quantity, unit: item.unit,
          actor, source: ctx.source === "system" ? "api" : ctx.source, evidence: { projectId, projectArchive: true, reservationId: reservation.id }, correlationId: ctx.correlationId,
          createdAt: archivedAt, itemVersion: item.version + 1
        };
        this.inventory.events.set(item.id, [...(this.inventory.events.get(item.id) ?? []), event]);
      }
      const next: Project = { ...current, status: "archived", updatedAt: archivedAt, version: current.version + 1 };
      this.projects.set(projectId, next);
      return Promise.resolve(clone(next));
    } catch (error: unknown) {
      this.projects.set(projectId, clone(snapshot.project));
      for (const [idValue, value] of snapshot.reservations) this.reservations.set(idValue, clone(value));
      for (const [idValue, value] of snapshot.items) this.inventory.items.set(idValue, clone(value));
      for (const [idValue, value] of snapshot.events) {
        if (value === undefined) this.inventory.events.delete(idValue);
        else this.inventory.events.set(idValue, clone(value));
      }
      this.archiveSnapshots.delete(projectId);
      throw error;
    }
  }
  restoreProject(projectId: string, expectedVersion: number | undefined, _ctx: RequestContext): Promise<Project> {
    const current = this.projects.get(projectId); if (!current) throw new ApplicationError("not_found", `Project '${projectId}' was not found`); ensureVersion(current.version, expectedVersion, "Project");
    if (current.removedAt !== undefined) throw new ApplicationError("project_removed", `Project '${projectId}' has been removed from the workspace`);
    if (current.status !== "archived") return Promise.resolve(clone(current));
    const restored: Project = { ...current, status: "idea", updatedAt: iso(), version: current.version + 1 };
    this.projects.set(projectId, restored);
    this.archiveSnapshots.delete(projectId);
    return Promise.resolve(clone(restored));
  }
  rollbackProjectArchive(projectId: string): Promise<void> {
    const snapshot = this.archiveSnapshots.get(projectId);
    if (snapshot === undefined) return Promise.resolve();
    this.projects.set(projectId, clone(snapshot.project));
    for (const [idValue, value] of snapshot.reservations) this.reservations.set(idValue, clone(value));
    for (const [idValue, value] of snapshot.items) this.inventory.items.set(idValue, clone(value));
    for (const [idValue, value] of snapshot.events) {
      if (value === undefined) this.inventory.events.delete(idValue);
      else this.inventory.events.set(idValue, clone(value));
    }
    this.archiveSnapshots.delete(projectId);
    return Promise.resolve();
  }
  commitProjectArchive(projectId: string): Promise<void> {
    this.archiveSnapshots.delete(projectId);
    return Promise.resolve();
  }
  removeProject(projectId: string, expectedVersion: number | undefined, confirmationName: string, ctx: RequestContext): Promise<ProjectTombstone> {
    const current = this.projects.get(projectId);
    if (!current) throw new ApplicationError("not_found", `Project '${projectId}' was not found`);
    if (current.removedAt !== undefined) return Promise.resolve(this.projectTombstone(current));
    if (current.name !== confirmationName) throw new ApplicationError("conflict", "Project removal requires an exact, case-sensitive project-name confirmation", { expectedName: current.name });
    ensureVersion(current.version, expectedVersion, "Project");

    // MemoryRuntime has no database transaction. Snapshot every affected map
    // before releasing stock so an injected failure cannot leave a partial
    // removal visible to a subsequent request.
    const snapshot = {
      projects: [...this.projects].map(([key, value]) => [key, clone(value)] as const),
      reservations: [...this.reservations].map(([key, value]) => [key, clone(value)] as const),
      items: [...this.inventory.items].map(([key, value]) => [key, clone(value)] as const),
      events: [...this.inventory.events].map(([key, value]) => [key, clone(value)] as const)
    };
    const restoreSnapshot = () => {
      this.projects.clear(); for (const [key, value] of snapshot.projects) this.projects.set(key, clone(value));
      this.reservations.clear(); for (const [key, value] of snapshot.reservations) this.reservations.set(key, clone(value));
      this.inventory.items.clear(); for (const [key, value] of snapshot.items) this.inventory.items.set(key, clone(value));
      this.inventory.events.clear(); for (const [key, value] of snapshot.events) this.inventory.events.set(key, clone(value));
    };
    try {
      const revisionIds = new Set([...this.projectRevisions.values()].filter((revision) => revision.projectId === projectId).map((revision) => revision.id));
      const lineIds = new Set([...this.bomLines.values()].filter((line) => revisionIds.has(line.revisionId)).map((line) => line.id));
      const active = [...this.reservations.values()].filter((reservation) => reservation.status === "active" && lineIds.has(reservation.lineId));
      const removedAt = iso();
      const releasedReservationIds: string[] = [];
      for (const reservation of active) {
        const item = this.inventory.items.get(reservation.itemId);
        if (item === undefined) throw new ApplicationError("integrity_error", `Reservation '${reservation.id}' refers to missing inventory item`);
        const released: Reservation = { ...reservation, status: "released", updatedAt: removedAt, version: reservation.version + 1 };
        this.reservations.set(reservation.id, released);
        const itemVersion = item.version + 1;
        this.inventory.items.set(item.id, { ...item, availableQuantity: Math.min(item.quantity, item.availableQuantity + reservation.quantity), updatedAt: removedAt, version: itemVersion });
        const event: StockEvent = {
          id: `reservation-${reservation.id}-release`, itemId: reservation.itemId, type: "release", quantity: reservation.quantity, unit: item.unit,
          actor: ctx.actor, source: ctx.source === "system" ? "api" : ctx.source,
          evidence: { projectId, projectRemoval: true, reservationId: reservation.id }, correlationId: ctx.correlationId,
          idempotencyKey: `project:${projectId}:remove:${reservation.id}`, createdAt: removedAt, itemVersion
        };
        this.inventory.events.set(item.id, [...(this.inventory.events.get(item.id) ?? []), event]);
        releasedReservationIds.push(reservation.id);
      }
      const removed: Project = { ...current, removedAt, removedBy: ctx.actor, lastLifecycleStatus: current.status, removedReservationIds: releasedReservationIds, updatedAt: removedAt, version: current.version + 1 };
      this.projects.set(projectId, removed);
      this.archiveSnapshots.delete(projectId);
      this.removalSnapshots.set(projectId, snapshot);
      return Promise.resolve(this.projectTombstone(removed));
    } catch (error: unknown) {
      restoreSnapshot();
      throw error;
    }
  }
  rollbackProjectRemoval(projectId: string): Promise<void> {
    const snapshot = this.removalSnapshots.get(projectId);
    if (snapshot === undefined) return Promise.resolve();
    this.projects.clear(); for (const [key, value] of snapshot.projects) this.projects.set(key, clone(value));
    this.reservations.clear(); for (const [key, value] of snapshot.reservations) this.reservations.set(key, clone(value));
    this.inventory.items.clear(); for (const [key, value] of snapshot.items) this.inventory.items.set(key, clone(value));
    this.inventory.events.clear(); for (const [key, value] of snapshot.events) this.inventory.events.set(key, clone(value));
    this.removalSnapshots.delete(projectId);
    return Promise.resolve();
  }
  commitProjectRemoval(projectId: string): Promise<void> {
    this.removalSnapshots.delete(projectId);
    return Promise.resolve();
  }
  createWorkItem(projectId: string, input: CreateWorkItem): Promise<WorkItem> {
    this.assertProjectActive(projectId);
    const item: WorkItem = { id: input.id ?? id("work", ++this.sequence), projectId, name: input.name.trim(), kind: input.kind, ...(input.description === undefined ? {} : { description: input.description }), createdAt: iso(), updatedAt: iso(), version: 1 };
    this.workItems.set(item.id, item); return Promise.resolve(clone(item));
  }
  getWorkItem(idValue: string): Promise<WorkItem | null> { const value = this.workItems.get(idValue); return Promise.resolve(value ? clone(value) : null); }
  listWorkItems(projectId: string): Promise<readonly WorkItem[]> { return Promise.resolve(clone([...this.workItems.values()].filter((item) => item.projectId === projectId))); }
  createProjectRevision(projectId: string, input: CreateProjectRevision): Promise<ProjectRevision> {
    this.assertProjectActive(projectId);
    const number = [...this.projectRevisions.values()].filter((revision) => revision.projectId === projectId).length + 1;
    const revision: ProjectRevision = { id: input.id ?? id("revision", ++this.sequence), projectId, number, name: input.name, ...(input.notes === undefined ? {} : { notes: input.notes }), status: input.status, createdAt: iso(), version: 1 };
    if (this.projectRevisions.has(revision.id)) throw new ApplicationError("conflict", `Project revision '${revision.id}' already exists`);
    this.projectRevisions.set(revision.id, revision);
    const project = this.projects.get(projectId);
    if (project !== undefined) this.projects.set(projectId, { ...project, currentRevisionId: revision.id, updatedAt: revision.createdAt });
    return Promise.resolve(clone(revision));
  }
  getProjectRevision(idValue: string): Promise<ProjectRevision | null> { const value = this.projectRevisions.get(idValue); return Promise.resolve(value ? clone(value) : null); }
  createWorkItemRevision(workItemId: string, input: CreateWorkItemRevision): Promise<WorkItemRevision> {
    const work = this.workItems.get(workItemId); if (!work) throw new ApplicationError("not_found", `Work item '${workItemId}' was not found`);
    this.assertProjectActive(work.projectId);
    const number = [...this.workItemRevisions.values()].filter((revision) => revision.workItemId === workItemId).length + 1;
    const revision: WorkItemRevision = { id: input.id ?? id("work-revision", ++this.sequence), workItemId, projectId: work.projectId, number, name: input.name, ...(input.notes === undefined ? {} : { notes: input.notes }), status: input.status, createdAt: iso(), version: 1 };
    this.workItemRevisions.set(revision.id, revision);
    this.workItems.set(workItemId, { ...work, currentRevisionId: revision.id, updatedAt: revision.createdAt });
    return Promise.resolve(clone(revision));
  }
  getWorkItemRevision(idValue: string): Promise<WorkItemRevision | null> { const value = this.workItemRevisions.get(idValue); return Promise.resolve(value ? clone(value) : null); }
  listBomLines(revisionId: string, options?: { readonly includeRetired?: boolean }): Promise<readonly BomLine[]> { return Promise.resolve(clone([...this.bomLines.values()].filter((line) => line.revisionId === revisionId && (options?.includeRetired === true || line.retiredAt === undefined)))); }
  getBomLine(idValue: string): Promise<BomLine | null> { const value = this.bomLines.get(idValue); return Promise.resolve(value ? clone(value) : null); }
  createBomLine(revisionId: string, input: CreateBomLine): Promise<BomLine> {
    const revision = this.projectRevisions.get(revisionId); if (!revision) throw new ApplicationError("not_found", `Project revision '${revisionId}' was not found`);
    this.assertProjectActive(revision.projectId);
    const line = {
      id: input.id ?? id("bom", ++this.sequence),
      revisionId,
      name: input.name,
      ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      requiredQuantity: input.requiredQuantity,
      unit: input.unit,
      optional: input.optional,
      constraints: clone(input.constraints ?? {}),
      alternatives: canonicalBomAlternatives(input.alternatives ?? []),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      createdAt: iso(),
      updatedAt: iso(),
      version: 1
    } as BomLine;
    this.bomLines.set(line.id, line); return Promise.resolve(clone(line));
  }
  updateBomLine(lineId: string, input: Partial<CreateBomLine>, expectedVersion: number | undefined): Promise<BomLine> {
    const current = this.bomLines.get(lineId); if (!current) throw new ApplicationError("not_found", `BOM line '${lineId}' was not found`); ensureVersion(current.version, expectedVersion, "BOM line");
    const next = {
      ...current,
      ...input,
      ...(input.alternatives === undefined ? {} : { alternatives: canonicalBomAlternatives(input.alternatives) }),
      ...(input.constraints === undefined ? {} : { constraints: clone(input.constraints) }),
      updatedAt: iso(),
      version: current.version + 1
    } as BomLine;
    this.bomLines.set(lineId, next); return Promise.resolve(clone(next));
  }
  retireBomLine(lineId: string, expectedVersion: number | undefined): Promise<BomLine> {
    const current = this.bomLines.get(lineId); if (!current) throw new ApplicationError("not_found", `BOM line '${lineId}' was not found`); ensureVersion(current.version, expectedVersion, "BOM line");
    if ([...this.reservations.values()].some((reservation) => reservation.lineId === lineId && reservation.status === "active")) throw new ApplicationError("conflict", "Release active reservations before retiring this BOM line");
    if (current.retiredAt !== undefined) return Promise.resolve(clone(current));
    const retiredAt = iso(); const next = { ...current, retiredAt, updatedAt: retiredAt, version: current.version + 1 }; this.bomLines.set(lineId, next); return Promise.resolve(clone(next));
  }
  restoreBomLine(lineId: string, expectedVersion: number | undefined): Promise<BomLine> {
    const current = this.bomLines.get(lineId); if (!current) throw new ApplicationError("not_found", `BOM line '${lineId}' was not found`); ensureVersion(current.version, expectedVersion, "BOM line");
    if (current.retiredAt === undefined) return Promise.resolve(clone(current));
    const { retiredAt: _retiredAt, ...active } = current; const next = { ...active, updatedAt: iso(), version: current.version + 1 }; this.bomLines.set(lineId, next); return Promise.resolve(clone(next));
  }
  createReservation(revisionId: string, input: CreateReservation): Promise<Reservation> {
    const revision = this.projectRevisions.get(revisionId); if (!revision) throw new ApplicationError("not_found", `Project revision '${revisionId}' was not found`);
    this.assertProjectActive(revision.projectId);
    const line = this.bomLines.get(input.lineId); if (!line || line.revisionId !== revisionId) throw new ApplicationError("not_found", `BOM line '${input.lineId}' was not found in this revision`);
    const item = this.inventory.items.get(input.itemId); if (!item) throw new ApplicationError("not_found", `Inventory item '${input.itemId}' was not found`);
    const conversion = bomQuantityConversion(line, item);
    if (item.unit !== line.unit && conversion === undefined) throw new ApplicationError("validation", `Unit mismatch: BOM uses ${line.unit}, item uses ${item.unit}; no valid quantity conversion is recorded`);
    if (conversion !== undefined && !Number.isSafeInteger(input.quantity)) throw new ApplicationError("validation", "Converted reservations must use a whole number of sets");
    const approved = line.itemId === item.id || line.alternatives.some((alternative) => alternative.itemId === item.id && alternative.compatible === "confirmed");
    if (!approved) throw new ApplicationError("validation", "Reservation item must be the exact BOM item or an approved alternative");
    if (!matchesBomConstraints(item, line.constraints)) throw new ApplicationError("validation", "Inventory item does not satisfy the BOM constraints");
    if (!canCount(item.evidence.state)) throw new ApplicationError("conflict", "Only physically confirmed stock can be reserved");
    ensurePositive(input.quantity, "Reservation quantity");
    const factor = conversion?.requirement.quantity ?? 1;
    const reservedCoverage = [...this.reservations.values()]
      .filter((reservation) => reservation.status === "active" && reservation.lineId === input.lineId)
      .reduce((total, reservation) => {
        const reservedItem = this.inventory.items.get(reservation.itemId);
        if (reservedItem === undefined) throw new ApplicationError("integrity_error", `Reservation '${reservation.id}' refers to missing inventory item`);
        const reservedConversion = bomQuantityConversion(line, reservedItem);
        if (reservedItem.unit !== line.unit && reservedConversion === undefined) throw new ApplicationError("integrity_error", "Existing reservation has no valid quantity conversion");
        if (reservedConversion !== undefined && !Number.isSafeInteger(reservation.quantity)) throw new ApplicationError("integrity_error", "Existing converted reservation is not a whole number of sets");
        return total + reservation.quantity * (reservedConversion?.requirement.quantity ?? 1);
      }, 0);
    const remainingCoverage = Math.max(0, line.requiredQuantity - reservedCoverage);
    const maximumInventoryUnits = Math.ceil(remainingCoverage / factor);
    if (input.quantity > maximumInventoryUnits) throw new ApplicationError("conflict", `Cannot reserve beyond the BOM requirement of ${line.requiredQuantity} ${line.unit}; whole-unit coverage would be exceeded`);
    if (item.availableQuantity < input.quantity) throw new ApplicationError("conflict", "Not enough confirmed stock to reserve");
    const reservation: Reservation = { id: input.id ?? id("reservation", ++this.sequence), lineId: input.lineId, itemId: input.itemId, quantity: input.quantity, status: "active", createdAt: iso(), updatedAt: iso(), version: 1 };
    this.reservations.set(reservation.id, reservation);
    this.inventory.items.set(item.id, { ...item, availableQuantity: item.availableQuantity - input.quantity, updatedAt: iso(), version: item.version + 1 });
    return Promise.resolve(clone(reservation));
  }
  releaseReservation(reservationId: string, expectedVersion: number | undefined): Promise<Reservation> {
    const current = this.reservations.get(reservationId); if (!current) throw new ApplicationError("not_found", `Reservation '${reservationId}' was not found`); ensureVersion(current.version, expectedVersion, "Reservation");
    if (current.status !== "active") throw new ApplicationError("conflict", "Reservation is no longer active");
    const item = this.inventory.items.get(current.itemId); if (item) this.inventory.items.set(item.id, { ...item, availableQuantity: item.availableQuantity + current.quantity, updatedAt: iso(), version: item.version + 1 });
    const next: Reservation = { ...current, status: "released", updatedAt: iso(), version: current.version + 1 }; this.reservations.set(reservationId, next); return Promise.resolve(clone(next));
  }
  listReservations(revisionId: string): Promise<readonly Reservation[]> {
    const lineIds = new Set([...this.bomLines.values()].filter((line) => line.revisionId === revisionId).map((line) => line.id));
    return Promise.resolve(clone([...this.reservations.values()].filter((reservation) => lineIds.has(reservation.lineId))));
  }
  getReservationDetails(idValue: string): Promise<ReservationDetails | null> {
    const reservation = this.reservations.get(idValue);
    if (reservation === undefined) return Promise.resolve(null);
    const bomLine = this.bomLines.get(reservation.lineId);
    if (bomLine === undefined) return Promise.resolve(null);
    const revision = this.projectRevisions.get(bomLine.revisionId);
    if (revision === undefined) return Promise.resolve(null);
    return Promise.resolve(clone({ reservation, projectId: revision.projectId, projectRevisionId: bomLine.revisionId, bomLine }));
  }
  recordUsage(input: UsageInput, ctx: RequestContext): Promise<StockMutation> {
    this.assertProjectActive(input.projectId);
    return this.inventory.recordStockEvent({ itemId: input.itemId, type: "consume", quantity: input.quantity, unit: input.unit, ...(input.note ? { note: input.note } : {}), projectId: input.projectId }, ctx);
  }
  private assertProjectActive(projectId: string): void {
    const project = this.projects.get(projectId);
    if (!project) throw new ApplicationError("not_found", `Project '${projectId}' was not found`);
    if (project.removedAt !== undefined) throw new ApplicationError("project_removed", `Project '${projectId}' has been removed from the workspace`);
    if (project.status === "archived") throw new ApplicationError("conflict", `Project '${projectId}' is archived`);
  }
  private projectTombstone(project: Project): ProjectTombstone {
    if (project.removedAt === undefined || project.removedBy === undefined || project.lastLifecycleStatus === undefined) throw new ApplicationError("integrity_error", `Project '${project.id}' is missing removal tombstone metadata`);
    return { id: project.id, name: project.name, removedAt: project.removedAt, removedBy: project.removedBy, lastLifecycleStatus: project.lastLifecycleStatus, releasedReservationIds: [...(project.removedReservationIds ?? [])], version: project.version };
  }
}

/**
 * MemoryRuntime has no database transaction, so setup commit keeps an
 * explicit snapshot until the surrounding audited mutation has completed.
 * This mirrors SQLite rollback for graph, allocation, preview, audit, and
 * idempotency state instead of leaving a partially committed demo record.
 */
class MemoryProjectSetup implements ProjectSetupPort {
  private readonly previews = new Map<string, { readonly actor: string; readonly preview: ProjectSetupPreview }>();
  private lastSnapshot: ReturnType<MemoryProjectSetup["snapshotState"]> | undefined;

  constructor(
    private readonly projects: MemoryProjects,
    private readonly inventory: MemoryInventory,
    private readonly audit: MemoryAudit,
    private readonly idempotency: MemoryIdempotency
  ) {}

  private snapshotState() {
    return {
      projects: this.projects.snapshotState(),
      inventory: this.inventory.snapshotState(),
      previews: [...this.previews].map(([key, value]) => [key, clone(value)] as const),
      audit: this.audit.snapshotState(),
      idempotency: this.idempotency.snapshotState()
    };
  }

  private restoreState(snapshot: ReturnType<MemoryProjectSetup["snapshotState"]>): void {
    this.projects.restoreState(snapshot.projects);
    this.inventory.restoreState(snapshot.inventory);
    this.previews.clear(); for (const [key, value] of snapshot.previews) this.previews.set(key, clone(value));
    this.audit.restoreState(snapshot.audit);
    this.idempotency.restoreState(snapshot.idempotency);
  }

  async savePreview(preview: ProjectSetupPreview, actor: string): Promise<ProjectSetupPreview> {
    const value = clone(preview);
    this.previews.set(preview.id, { actor, preview: value });
    return clone(value);
  }

  async getPreview(idValue: string, actor: string): Promise<ProjectSetupPreview | null> {
    const value = this.previews.get(idValue);
    return value === undefined || value.actor !== actor ? null : clone(value.preview);
  }

  async commitPreview(input: {
    readonly preview: ProjectSetupPreview;
    readonly command: CommitProjectSetup;
    readonly actor: string;
    readonly source: RequestContext["source"];
    readonly correlationId: string;
  }): Promise<ProjectSetupCommitResult> {
    const { preview } = input;
    // Any prior successful setup has already passed its enclosing audit and
    // must never remain available as a compensation receipt for this command.
    this.lastSnapshot = undefined;
    if (preview.fieldErrors.length > 0) throw new ApplicationError("validation", "Project setup preview contains semantic field errors");

    const staleItems: string[] = [];
    for (const basis of preview.affectedInventory) {
      const current = await this.inventory.getItem(basis.itemId);
      const allocated = current === null ? undefined : current.allocatedQuantity ?? Math.max(0, current.quantity - current.availableQuantity);
      if (current === null || current.version !== basis.before.version || current.quantity !== basis.before.quantity || current.availableQuantity !== basis.before.availableQuantity || allocated !== basis.before.allocatedQuantity || current.unit !== basis.unit || JSON.stringify(current.evidence) !== JSON.stringify(basis.evidenceBasis)) staleItems.push(basis.itemId);
    }
    if (staleItems.length > 0) throw conflict("Project setup inventory basis is stale", { reason: "stale_basis", staleItems, recoveryAction: "preview_project_setup", retryable: false, commitState: "not_committed" });

    // Re-run identity and reservation preflight at commit time. The preview
    // is an untrusted persisted document and inventory may have changed.
    const proposal = preview.proposal;
    if (await this.projects.getProject(proposal.project.id as string) !== null) throw conflict("Project ID is already in use", { reason: "project_id_exists", field: "projectId", id: proposal.project.id, retryable: false, commitState: "not_committed" });
    if (await this.projects.getProjectRevision(proposal.revision.id as string) !== null) throw conflict("Revision ID is already in use", { reason: "revision_id_exists", field: "revisionId", id: proposal.revision.id, retryable: false, commitState: "not_committed" });
    for (const item of proposal.workItems) {
      if (await this.projects.getWorkItem(item.id as string) !== null) throw conflict("Work-item ID is already in use", { reason: "work_item_id_exists", field: "workItemId", id: item.id, retryable: false, commitState: "not_committed" });
      if (await this.projects.getWorkItemRevision(item.revision.id as string) !== null) throw conflict("Work-item revision ID is already in use", { reason: "work_item_revision_id_exists", field: "workItemRevisionId", id: item.revision.id, retryable: false, commitState: "not_committed" });
    }
    for (const line of proposal.bomLines) if (await this.projects.getBomLine(line.id as string) !== null) throw conflict("BOM line ID is already in use", { reason: "bom_line_id_exists", field: "bomLineId", id: line.id, retryable: false, commitState: "not_committed" });
    for (const reservation of proposal.reservations) if (await this.projects.getReservationDetails(reservation.id as string) !== null) throw conflict("Reservation ID is already in use", { reason: "reservation_id_exists", field: "reservationId", id: reservation.id, retryable: false, commitState: "not_committed" });

    const lineByRef = new Map(proposal.bomLines.map((line) => [line.localRef, line]));
    const reservedByLine = new Map<string, number>();
    const reservedByItem = new Map<string, number>();
    for (const reservation of proposal.reservations) {
      const line = lineByRef.get(reservation.bomLineLocalRef);
      const item = await this.inventory.getItem(reservation.itemId);
      if (line === undefined || item === null) throw new ApplicationError("validation", `Reservation '${reservation.localRef}' references missing setup data`);
      if (!bomSpecification(line).sufficient) throw new ApplicationError("validation", "Resolve the BOM specification decisions before reserving stock");
      const approved = item.id === line.itemId || line.alternatives.some((alternative) => alternative.itemId === item.id && alternative.compatible === "confirmed");
      const conversion = bomQuantityConversion(line, item);
      if (!approved || (item.unit !== line.unit && conversion === undefined) || (reservation.unit !== undefined && reservation.unit !== item.unit) || !matchesBomConstraints(item, line.constraints) || !["physically_counted", "commissioned"].includes(item.evidence.state)) throw conflict("Reservation preflight no longer passes", { reason: "reservation_preflight", itemId: item.id, retryable: false, commitState: "not_committed", recoveryAction: "preview_project_setup" });
      if (conversion !== undefined && !Number.isSafeInteger(reservation.quantity)) throw conflict("Converted reservation quantity is not a whole number of sets", { reason: "reservation_preflight", itemId: item.id, retryable: false, commitState: "not_committed", recoveryAction: "preview_project_setup" });
      const factor = conversion?.requirement.quantity ?? 1;
      const priorCoverage = reservedByLine.get(line.localRef) ?? 0;
      const remainingCoverage = Math.max(0, line.requiredQuantity - priorCoverage);
      const maximumInventoryUnits = Math.ceil(remainingCoverage / factor);
      if (reservation.quantity > maximumInventoryUnits) throw conflict("Reservation exceeds BOM requirement", { reason: "reservation_requirement", itemId: item.id, retryable: false, commitState: "not_committed", recoveryAction: "preview_project_setup" });
      reservedByLine.set(line.localRef, priorCoverage + reservation.quantity * factor);
      reservedByItem.set(item.id, (reservedByItem.get(item.id) ?? 0) + reservation.quantity);
    }
    for (const [itemId, quantity] of reservedByItem) {
      const item = await this.inventory.getItem(itemId);
      if (item === null || quantity > item.availableQuantity) throw conflict("Reservation stock is no longer available", { reason: "reservation_stock", staleItems: [itemId], recoveryAction: "preview_project_setup", retryable: false, commitState: "not_committed" });
    }

    const snapshot = this.snapshotState();
    this.lastSnapshot = snapshot;
    try {
      const created = await this.projects.createProjectWithInitialRevision({ project: proposal.project, revision: proposal.revision });
      const workItems: ProjectSetupCommitResult["workItems"] = [];
      const workItemRevisions: ProjectSetupCommitResult["workItemRevisions"] = [];
      for (const item of proposal.workItems) {
        const workItem = await this.projects.createWorkItem(created.project.id, { id: item.id, name: item.name, kind: item.kind, ...(item.description === undefined ? {} : { description: item.description }) });
        const workRevision = await this.projects.createWorkItemRevision(workItem.id, item.revision);
        workItems.push(workItem); workItemRevisions.push(workRevision);
      }
      const bomLines: ProjectSetupCommitResult["bomLines"] = [];
      for (const line of proposal.bomLines) {
        bomLines.push(await this.projects.createBomLine(created.revision.id, { id: line.id, name: line.name, ...(line.itemId === undefined ? {} : { itemId: line.itemId }), requiredQuantity: line.requiredQuantity, unit: line.unit, optional: line.optional, constraints: line.constraints, alternatives: line.alternatives, ...(line.notes === undefined ? {} : { notes: line.notes }) }));
      }
      const reservations: ProjectSetupCommitResult["reservations"] = [];
      for (const reservation of proposal.reservations) {
        const line = lineByRef.get(reservation.bomLineLocalRef);
        if (line === undefined) throw new ApplicationError("validation", `Reservation '${reservation.localRef}' references an unknown BOM line`);
        const bomLine = bomLines.find((candidate) => candidate.id === line.id);
        if (bomLine === undefined) throw new ApplicationError("integrity_error", "Project setup graph mapping is incomplete");
        const createdReservation = await this.projects.createReservation(created.revision.id, { id: reservation.id, lineId: bomLine.id, itemId: reservation.itemId, quantity: reservation.quantity });
        reservations.push(createdReservation);
        const item = this.inventory.items.get(reservation.itemId);
        if (item === undefined) throw new ApplicationError("integrity_error", "Reservation allocation item disappeared");
        const event: StockEvent = { id: `reservation-${createdReservation.id}-allocate`, itemId: item.id, type: "allocate", quantity: createdReservation.quantity, unit: item.unit, actor: input.actor, source: input.source === "system" ? "api" : input.source, evidence: { projectId: created.project.id, reservationId: createdReservation.id }, correlationId: input.correlationId, idempotencyKey: `reservation:${createdReservation.id}:allocate`, createdAt: createdReservation.createdAt, itemVersion: item.version };
        this.inventory.events.set(item.id, [...(this.inventory.events.get(item.id) ?? []), event]);
      }
      this.previews.set(preview.id, { actor: input.actor, preview: { ...clone(preview), status: "committed", version: preview.version + 1, updatedAt: iso() } });
      const project = await this.projects.getProject(created.project.id);
      if (project === null) throw new ApplicationError("integrity_error", "Committed project could not be read back");
      return { project, revision: created.revision, workItems, workItemRevisions, bomLines, reservations, auditIds: [], context: { previewId: preview.id, contentSha256: preview.contentSha256 }, gaps: preview.gaps, nextAction: "Review the committed project setup and resolve any remaining gaps." };
    } catch (error: unknown) {
      this.restoreState(snapshot); this.lastSnapshot = undefined; throw error;
    }
  }

  async rollbackLastCommit(): Promise<void> {
    if (this.lastSnapshot === undefined) return;
    this.restoreState(this.lastSnapshot); this.lastSnapshot = undefined;
  }
}

/** Memory counterpart of the narrow inspection evidence adapter. */
class MemoryInspections implements InspectionPort {
  private readonly previews = new Map<string, { readonly actor: string; readonly preview: InspectionCompletionPreview }>();
  private readonly evidence: InspectionEvidence[] = [];
  private lastInventorySnapshot: ReturnType<MemoryInventory["snapshotState"]> | undefined;
  private lastProjectsSnapshot: ReturnType<MemoryProjects["snapshotState"]> | undefined;
  private lastEvidenceLength: number | undefined;

  constructor(private readonly inventory: MemoryInventory, private readonly projects: MemoryProjects) {}

  async savePreview(preview: InspectionCompletionPreview): Promise<InspectionCompletionPreview> {
    this.previews.set(preview.id, { actor: preview.actor, preview: clone(preview) });
    return clone(preview);
  }

  async getPreview(idValue: string, actor: string): Promise<InspectionCompletionPreview | null> {
    const stored = this.previews.get(idValue);
    return stored === undefined || stored.actor !== actor ? null : clone(stored.preview);
  }

  async commit(input: InspectionCommitInput, ctx: RequestContext): Promise<InspectionCommitReceipt> {
    const current = await this.inventory.getItem(input.action.itemId);
    if (current === null || current.retiredAt !== undefined) throw new ApplicationError("not_found", `Inventory item '${input.action.itemId}' was not found`);
    if (current.version !== input.basis.itemVersion) throw conflict("Inspection inventory basis changed", { reason: "stale_basis", recoveryAction: "list_inspections" });
    for (const reference of input.basis.lineVersions) {
      const line = this.projects.bomLines.get(reference.lineId);
      if (line === undefined || line.version !== reference.version) throw conflict("Inspection BOM basis changed", { reason: "stale_basis", recoveryAction: "list_inspections" });
    }
    const idValue = `inspection-${createHash("sha256").update(`${input.preview.id}\u0000${ctx.idempotencyKey ?? ctx.correlationId}`).digest("hex").slice(0, 40)}`;
    const existing = this.evidence.find((candidate) => candidate.id === idValue);
    if (existing !== undefined) return { id: idValue, evidence: clone(existing), ...(input.action.kind === "physical_quantity" ? { item: current } : {}) };
    this.lastInventorySnapshot = this.inventory.snapshotState();
    this.lastProjectsSnapshot = this.projects.snapshotState();
    this.lastEvidenceLength = this.evidence.length;
    try {
      const beforeLines = input.preview.before.lines;
      const afterLines = input.preview.after.lines;
      for (const before of beforeLines) {
        const currentLine = this.projects.bomLines.get(before.id);
        if (currentLine === undefined || JSON.stringify(currentLine) !== JSON.stringify(before)) {
          throw conflict("Inspection BOM basis changed", { reason: "stale_basis", recoveryAction: "list_inspections" });
        }
      }
      let updated: InventoryItem | undefined;
      if (input.action.kind === "physical_quantity" && input.observation.result === "confirmed") {
        if (input.observation.quantity === undefined || input.observation.unit !== current.unit) throw new ApplicationError("validation", "Physical inspection quantity does not match the inventory unit");
        const count = await this.inventory.recordPhysicalInspection(current.id, input.observation.quantity, input.observation, ctx);
        updated = count.item;
      }
      if (input.observation.result === "confirmed" && input.action.kind !== "physical_quantity") {
        if (afterLines.length !== beforeLines.length) throw new ApplicationError("integrity_error", "Inspection preview line changes are incomplete");
        for (const after of afterLines) {
          const before = beforeLines.find((candidate) => candidate.id === after.id);
          if (before === undefined || after.version !== before.version + 1) throw new ApplicationError("integrity_error", "Inspection preview line version is invalid");
          this.projects.bomLines.set(after.id, clone(after));
        }
      }
      const recorded: InspectionEvidence = {
        id: idValue,
        projectRevisionId: input.projectRevisionId,
        actionId: input.action.id,
        itemId: input.action.itemId,
        kind: input.action.kind,
        result: input.observation.result,
        source: input.observation.source,
        ...(input.observation.sourceId === undefined ? {} : { sourceId: input.observation.sourceId }),
        observedAt: input.observation.observedAt,
        recordedAt: input.committedAt,
        ...(input.observation.note === undefined ? {} : { note: input.observation.note }),
        ...(input.observation.quantity === undefined ? {} : { quantity: input.observation.quantity }),
        ...(input.observation.unit === undefined ? {} : { unit: input.observation.unit }),
        ...(input.observation.conversion === undefined ? {} : { conversion: input.observation.conversion })
      };
      this.evidence.push(clone(recorded));
      return { id: idValue, evidence: clone(recorded), ...(updated === undefined ? {} : { item: updated }) };
    } catch (error: unknown) {
      this.inventory.restoreState(this.lastInventorySnapshot);
      this.projects.restoreState(this.lastProjectsSnapshot);
      this.evidence.splice(this.lastEvidenceLength);
      this.lastInventorySnapshot = undefined;
      this.lastProjectsSnapshot = undefined;
      this.lastEvidenceLength = undefined;
      throw error;
    }
  }

  async rollbackLastCommit(): Promise<void> {
    if (this.lastInventorySnapshot !== undefined) this.inventory.restoreState(this.lastInventorySnapshot);
    if (this.lastProjectsSnapshot !== undefined) this.projects.restoreState(this.lastProjectsSnapshot);
    if (this.lastEvidenceLength !== undefined) this.evidence.splice(this.lastEvidenceLength);
    this.lastInventorySnapshot = undefined;
    this.lastProjectsSnapshot = undefined;
    this.lastEvidenceLength = undefined;
  }
}

class MemoryOffers implements OfferPort {
  readonly offers = new Map<string, Offer>(); private sequence = 300;
  listOffers(itemId: string | undefined, limit: number, cursor?: string): Promise<Page<Offer>> { return Promise.resolve(page([...this.offers.values()].filter((offer) => !itemId || offer.itemId === itemId), limit, cursor)); }
  createOffer(input: CreateOffer): Promise<Offer> { const offer: Offer = { ...input, id: input.id ?? id("offer", ++this.sequence), observedAt: input.observedAt ?? iso(), staleAfterDays: input.staleAfterDays ?? 30, version: 1 }; this.offers.set(offer.id, offer); return Promise.resolve(clone(offer)); }
}

class MemoryCatalog implements CatalogPort {
  readonly products = new Map<string, CatalogProduct>();
  readonly profiles = new Map<string, InventoryProductProfile>();
  private sequence = 600;

  listProducts(options: CatalogProductListOptions): Promise<Page<CatalogProduct>> {
    const needle = options.q?.trim().toLocaleLowerCase();
    const values = [...this.products.values()]
      .filter((product) => (options.kind === undefined || product.kind === options.kind) && (needle === undefined || catalogSearchText(product).includes(needle)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return Promise.resolve(page(values, options.limit, options.cursor));
  }

  getProduct(productId: string): Promise<CatalogProduct | null> {
    const product = this.products.get(productId);
    return Promise.resolve(product === undefined ? null : clone(product));
  }

  createProduct(input: CreateCatalogProduct): Promise<CatalogProduct> {
    const idValue = (input as Record<string, unknown>).id;
    const productId = typeof idValue === "string" ? idValue : id("catalog", ++this.sequence);
    if (this.products.has(productId)) throw new ApplicationError("conflict", `Catalog product '${productId}' already exists`);
    const now = iso();
    const product = { ...input, id: productId, createdAt: now, updatedAt: now, version: 1 } as CatalogProduct;
    this.products.set(productId, clone(product));
    return Promise.resolve(clone(product));
  }

  updateProduct(productId: string, input: UpdateCatalogProduct, expectedVersion?: number): Promise<CatalogProduct> {
    const current = this.products.get(productId);
    if (current === undefined) throw new ApplicationError("not_found", `Catalog product '${productId}' was not found`);
    ensureVersion(current.version, expectedVersion, "Catalog product");
    if ((input as Record<string, unknown>).kind !== undefined && (input as Record<string, unknown>).kind !== current.kind) throw new ApplicationError("validation", "Catalog product kind cannot change");
    const changedRecord = input as Record<string, unknown>;
    const mergedCandidate = { ...current, ...input, id: current.id, createdAt: current.createdAt, updatedAt: iso(), version: current.version + 1 };
    const next = (catalogFactsChanged(current, changedRecord)
      ? Object.fromEntries(Object.entries(mergedCandidate).filter(([key]) => key !== "provenance"))
      : mergedCandidate) as CatalogProduct;
    this.products.set(productId, clone(next));
    return Promise.resolve(clone(next));
  }

  getInventoryProductProfile(itemId: string): Promise<InventoryProductProfile | null> {
    const profile = this.profiles.get(itemId);
    return Promise.resolve(profile === undefined ? null : clone(profile));
  }

  putInventoryProductProfile(itemId: string, input: CreateInventoryProductProfile | UpdateInventoryProductProfile, expectedVersion?: number): Promise<InventoryProductProfile> {
    const current = this.profiles.get(itemId);
    if (current !== undefined) {
      ensureVersion(current.version, expectedVersion, "Inventory product profile");
      if ((input as Record<string, unknown>).profileType !== undefined && (input as Record<string, unknown>).profileType !== current.profileType) throw new ApplicationError("validation", "Profile type cannot change");
      const next = { ...current, ...input, id: current.id, itemId, createdAt: current.createdAt, updatedAt: iso(), version: current.version + 1 } as InventoryProductProfile;
      this.profiles.set(itemId, clone(next));
      return Promise.resolve(clone(next));
    }
    const inputRecord = input as Record<string, unknown>;
    const profileId = typeof inputRecord.id === "string" ? inputRecord.id : id("profile", ++this.sequence);
    const now = iso();
    const profile = { ...input, id: profileId, itemId, createdAt: now, updatedAt: now, version: 1 } as InventoryProductProfile;
    this.profiles.set(itemId, clone(profile));
    return Promise.resolve(clone(profile));
  }

  /** Internal compensation for the atomic inventory/profile command. */
  rollbackCreatedProfile(profileId: string, itemId: string): Promise<void> {
    const current = this.profiles.get(itemId);
    if (current === undefined) return Promise.resolve();
    if (current.id !== profileId || current.version !== 1) throw new ApplicationError("integrity_error", "Created inventory profile is no longer compensatable");
    this.profiles.delete(itemId);
    return Promise.resolve();
  }
}

class MemoryBuildConfigurations implements BuildConfigurationPort {
  readonly snapshots = new Map<string, BuildConfigurationSnapshot>();
  private sequence = 700;

  async listBuildConfigurations(revisionId: string, options: BuildConfigurationListOptions): Promise<Page<BuildConfigurationSnapshot>> {
    const values = [...this.snapshots.values()]
      .map((snapshot) => parseMemoryBuildConfigurationSnapshot(snapshot))
      .filter((snapshot) => snapshot.projectRevisionId === revisionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return page(values, options.limit, options.cursor);
  }

  async getLatestBuildConfiguration(revisionId: string): Promise<BuildConfigurationSnapshot | null> {
    const latest = [...this.snapshots.values()]
      .map((snapshot) => parseMemoryBuildConfigurationSnapshot(snapshot))
      .filter((snapshot) => snapshot.projectRevisionId === revisionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .at(-1);
    return latest === undefined ? null : clone(latest);
  }

  async getBuildConfiguration(configurationId: string): Promise<BuildConfigurationSnapshot | null> {
    const snapshot = this.snapshots.get(configurationId);
    return snapshot === undefined ? null : clone(parseMemoryBuildConfigurationSnapshot(snapshot));
  }

  async createBuildConfiguration(input: CreateBuildConfigurationSnapshot): Promise<BuildConfigurationSnapshot> {
    const candidate = input as unknown as Record<string, unknown>;
    const { contentSha256: _contentSha256, createdAt: _createdAt, ...draft } = candidate;
    const parsed = buildConfigurationSnapshotStorageInputSchema.parse(draft);
    const snapshot = parseMemoryBuildConfigurationSnapshot({
      ...parsed,
      id: parsed.id ?? id("build-config", ++this.sequence),
      createdAt: iso(),
      contentSha256: computeBuildConfigurationContentSha256(parsed as unknown as Partial<BuildConfigurationSnapshot>),
    });
    if (this.snapshots.has(snapshot.id)) throw new ApplicationError("conflict", `Build configuration '${snapshot.id}' already exists`);
    this.snapshots.set(snapshot.id, clone(snapshot));
    return clone(snapshot);
  }
}

interface UploadState { readonly input: BeginUploadInput; readonly session: UploadSession; readonly body: Uint8Array; }

function matchesArtifactScope(
  artifact: Pick<Artifact, "projectId" | "workItemId" | "revisionId">,
  projectId: string,
  workItemId: string | undefined,
  revisionId: string | undefined,
): boolean {
  if (artifact.projectId !== projectId) return false;
  if (workItemId !== undefined) {
    return artifact.workItemId === workItemId && (revisionId === undefined || artifact.revisionId === revisionId);
  }
  if (revisionId !== undefined) {
    // A revision-only query names a project revision. Work-item artifacts are
    // a separate namespace even if they carry the same revision string.
    return artifact.workItemId === undefined && artifact.revisionId === revisionId;
  }
  // With no ancestry filter, retain the historical all-project view,
  // including records created before revision/work-item binding existed.
  return true;
}

class MemoryArtifacts implements ArtifactPort {
  readonly artifacts = new Map<string, Artifact>();
  readonly bindings = new Map<string, ArtifactBuildConfigurationBinding>();
  private readonly uploads = new Map<string, UploadState>(); private sequence = 400;
  listArtifacts(projectId: string, workItemId?: string, revisionId?: string): Promise<readonly Artifact[]> { return Promise.resolve(clone([...this.artifacts.values()].filter((artifact) => matchesArtifactScope(artifact, projectId, workItemId, revisionId)))); }
  getArtifact(idValue: string): Promise<Artifact | null> { const artifact = this.artifacts.get(idValue); return Promise.resolve(artifact ? clone(artifact) : null); }
  getUploadSessionDetails(idValue: string): Promise<UploadSessionDetails | null> { const upload = this.uploads.get(idValue); return Promise.resolve(upload ? clone({ session: upload.session, projectId: upload.input.projectId, ...(upload.input.workItemId === undefined ? {} : { workItemId: upload.input.workItemId }), ...(upload.input.revisionId === undefined ? {} : { revisionId: upload.input.revisionId }), ...(upload.input.buildConfigurationSnapshotId === undefined ? {} : { buildConfigurationSnapshotId: upload.input.buildConfigurationSnapshotId }) }) : null); }
  beginUpload(input: BeginUploadInput): Promise<UploadSession> { const artifactId = id("artifact", ++this.sequence); const sessionId = id("upload", ++this.sequence); const session: UploadSession = { id: sessionId, artifactId, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), maxBytes: input.byteSize, uploadUrl: `/api/v1/artifacts/uploads/${sessionId}`, status: "pending" }; this.uploads.set(sessionId, { input: clone(input), session, body: new Uint8Array() }); return Promise.resolve(clone(session)); }
  writeUpload(sessionId: string, body: Uint8Array): Promise<{ readonly receivedBytes: number }> { const upload = this.uploads.get(sessionId); if (!upload || upload.session.status !== "pending" || Date.parse(upload.session.expiresAt) <= Date.now()) throw new ApplicationError("upload_expired", "Upload session is missing or expired"); if (body.byteLength > upload.input.byteSize) throw new ApplicationError("quota_exceeded", "Upload body exceeds declared size"); this.uploads.set(sessionId, { ...upload, body: new Uint8Array(body) }); return Promise.resolve({ receivedBytes: body.byteLength }); }
  abortUpload(sessionId: string): Promise<void> { this.uploads.delete(sessionId); return Promise.resolve(); }
  finalizeUpload(sessionId: string): Promise<Artifact> { const upload = this.uploads.get(sessionId); if (!upload || upload.session.status !== "pending" || Date.parse(upload.session.expiresAt) <= Date.now()) throw new ApplicationError("upload_expired", "Upload session is missing or expired"); if (upload.body.byteLength !== upload.input.byteSize) throw new ApplicationError("integrity_error", "Uploaded byte size does not match declaration"); const actualSha = createHash("sha256").update(upload.body).digest("hex"); if (actualSha !== upload.input.sha256) throw new ApplicationError("integrity_error", "Uploaded SHA-256 does not match declaration"); const artifact: Artifact = { id: upload.session.artifactId, projectId: upload.input.projectId, ...(upload.input.workItemId ? { workItemId: upload.input.workItemId } : {}), ...(upload.input.revisionId ? { revisionId: upload.input.revisionId } : {}), role: upload.input.role, filename: upload.input.filename, mediaType: upload.input.mediaType, byteSize: upload.input.byteSize, sha256: actualSha, ...(upload.input.author ? { author: upload.input.author } : {}), ...(upload.input.source ? { source: upload.input.source } : {}), currentCandidate: true, retired: false, createdAt: iso(), version: 1 }; this.artifacts.set(artifact.id, artifact); this.uploads.set(sessionId, { ...upload, session: { ...upload.session, status: "finalized" } }); return Promise.resolve(clone(artifact)); }
  rollbackFinalization(sessionId: string, artifactId: string): Promise<void> { const upload = this.uploads.get(sessionId); if (!upload || upload.session.artifactId !== artifactId) throw new ApplicationError("integrity_error", "Artifact finalization compensation targeted a different artifact"); this.artifacts.delete(artifactId); this.uploads.set(sessionId, { ...upload, session: { ...upload.session, status: "pending" } }); return Promise.resolve(); }
  commitFinalization(_sessionId: string, _artifactId: string): Promise<void> { return Promise.resolve(); }
  bindBuildConfiguration(input: { readonly artifactId: string; readonly buildConfigurationSnapshotId: string; readonly projectRevisionId: string }): Promise<ArtifactBuildConfigurationBinding> { const binding: ArtifactBuildConfigurationBinding = { id: id("artifact-binding", ++this.sequence), ...input, createdAt: iso() }; this.bindings.set(binding.id, clone(binding)); return Promise.resolve(clone(binding)); }
  readArtifact(idValue: string): Promise<ArtifactDownload> { const artifact = this.artifacts.get(idValue); if (!artifact) throw new ApplicationError("not_found", `Artifact '${idValue}' was not found`); const upload = [...this.uploads.values()].find((candidate) => candidate.session.artifactId === idValue); return Promise.resolve({ artifact: clone(artifact), body: upload ? new Uint8Array(upload.body) : new Uint8Array() }); }
  retireArtifact(idValue: string, expectedVersion: number | undefined): Promise<Artifact> { const artifact = this.artifacts.get(idValue); if (!artifact) throw new ApplicationError("not_found", `Artifact '${idValue}' was not found`); ensureVersion(artifact.version, expectedVersion, "Artifact"); const next = { ...artifact, retired: true, currentCandidate: false, version: artifact.version + 1 }; this.artifacts.set(idValue, next); return Promise.resolve(clone(next)); }
}

class MemoryAudit implements AuditPort {
  readonly events: AuditEvent[] = []; private sequence = 500;
  snapshotState() { return { events: clone(this.events), sequence: this.sequence }; }
  restoreState(snapshot: ReturnType<MemoryAudit["snapshotState"]>): void { this.events.splice(0, this.events.length, ...clone(snapshot.events)); this.sequence = snapshot.sequence; }
  append(input: AuditInput): Promise<AuditEvent> { const event: AuditEvent = { ...input, id: id("audit", ++this.sequence), createdAt: iso() }; this.events.push(event); return Promise.resolve(clone(event)); }
  list(limit: number, cursor?: string): Promise<Page<AuditEvent>> { return Promise.resolve(page(this.events, limit, cursor)); }
  listEntity(entityType: string, entityId: string, limit: number, cursor?: string): Promise<Page<AuditEvent>> { return Promise.resolve(page(this.events.filter((event) => event.entityType === entityType && event.entityId === entityId), limit, cursor)); }
}

class MemoryEvents implements EventBusPort {
  private readonly listeners = new Set<(event: EventBusEvent) => void>();
  publish(event: EventBusEvent): void { for (const listener of this.listeners) listener(clone(event)); }
  subscribe(listener: (event: EventBusEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

class MemoryIdempotency implements IdempotencyPort {
  private readonly values = new Map<string, unknown>();
  snapshotState() { return [...this.values].map(([key, value]) => [key, clone(value)] as const); }
  restoreState(snapshot: ReturnType<MemoryIdempotency["snapshotState"]>): void { this.values.clear(); for (const [key, value] of snapshot) this.values.set(key, clone(value)); }
  get(actor: string, key: string): Promise<unknown | null> { return Promise.resolve(this.values.has(`${actor}:${key}`) ? clone(this.values.get(`${actor}:${key}`)) : null); }
  set(actor: string, key: string, value: unknown): Promise<void> { this.values.set(`${actor}:${key}`, clone(value)); return Promise.resolve(); }
}

class MemoryHealth implements HealthPort { check(): Promise<Readonly<Record<string, "ok" | "degraded" | "failed">>> { return Promise.resolve({ database: "ok", artifacts: "ok" }); } }

/**
 * Application transaction boundary for the demo adapter.
 *
 * The memory ports mutate Maps and arrays directly, so they do not have a
 * database transaction to provide. They still need the same coordination
 * contract as the production adapter: operations are FIFO-serialized, while
 * nested calls made by an operation execute in its existing scope instead of
 * waiting on themselves. The async-local marker keeps the latter property
 * across awaited port calls without exposing a lock to application code.
 */
export class MemoryUnitOfWork implements UnitOfWorkPort {
  private readonly scope = new AsyncLocalStorage<true>();
  private tail: Promise<void> = Promise.resolve();

  private enqueue<T>(operation: UnitOfWorkOperation<T>): Promise<T> {
    if (this.scope.getStore() === true) return Promise.resolve().then(operation);
    const run = () => this.scope.run(true, () => Promise.resolve().then(operation));
    const next = this.tail.then(run, run);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  run<T>(operation: UnitOfWorkOperation<T>): Promise<T> {
    return this.enqueue(operation);
  }

  transactional<T>(operation: UnitOfWorkOperation<T>): Promise<T> {
    return this.enqueue(operation);
  }

  exclusive<T>(operation: UnitOfWorkOperation<T>): Promise<T> {
    return this.enqueue(operation);
  }
}

export interface MemoryRuntime {
  readonly ports: ApplicationPorts;
  readonly inventory: MemoryInventory;
  readonly projects: MemoryProjects;
  readonly catalog: MemoryCatalog;
  readonly inventoryCategories: MemoryInventoryCategories;
  readonly buildConfigurations: MemoryBuildConfigurations;
  readonly inspections: InspectionPort;
  readonly unitOfWork: UnitOfWorkPort;
}

export function createMemoryRuntime(seed: readonly InventoryItem[] = []): MemoryRuntime {
  const inventory = new MemoryInventory(seed);
  const inventoryCategories = new MemoryInventoryCategories(inventory, BUILTIN_INVENTORY_CATEGORIES);
  const projects = new MemoryProjects(inventory);
  const catalog = new MemoryCatalog();
  const buildConfigurations = new MemoryBuildConfigurations();
  const unitOfWork = new MemoryUnitOfWork();
  const audit = new MemoryAudit();
  const idempotency = new MemoryIdempotency();
  const projectSetups = new MemoryProjectSetup(projects, inventory, audit, idempotency);
  const inspections = new MemoryInspections(inventory, projects);
  const ports: ApplicationPorts = { inventory, inventoryCategories, projects, projectSetups, inspections, offers: new MemoryOffers(), artifacts: new MemoryArtifacts(), catalog, buildConfigurations, audit, events: new MemoryEvents(), idempotency, unitOfWork, health: new MemoryHealth() };
  return { ports, inventory, inventoryCategories, projects, catalog, buildConfigurations, inspections, unitOfWork };
}

function seedItem(item: Omit<InventoryItem, "createdAt" | "updatedAt" | "version">): InventoryItem {
  const timestamp = "2026-08-30T00:00:00.000Z";
  return { ...item, createdAt: timestamp, updatedAt: timestamp, version: 1 };
}

function seedSyntheticProject(runtime: MemoryRuntime): void {
  const timestamp = "2026-08-30T00:00:00.000Z";
  const revision: ProjectRevision = {
    id: "synthetic-revision-lamp-r01",
    projectId: "synthetic-project-lamp",
    number: 1,
    name: "Initial concept",
    notes: "Synthetic reference project for the guided planning flow.",
    status: "concept",
    createdAt: timestamp,
    version: 1
  };
  const project: Project = {
    id: revision.projectId,
    name: "Synthetic H2D desk lamp",
    description: "Synthetic reference project covering reuse, inspect-first stock, and a missing requirement.",
    status: "planned",
    currentRevisionId: revision.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1
  };
  const lines: readonly BomLine[] = [
    { id: "synthetic-bom-printer", revisionId: revision.id, name: "Bambu Lab H2D", itemId: "printer-h2d", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: timestamp, updatedAt: timestamp, version: 1 },
    { id: "synthetic-bom-filament", revisionId: revision.id, name: "Bambu PETG HF", itemId: "filament-petg-hf", requiredQuantity: 250, unit: "gram", optional: false, constraints: {}, alternatives: [], notes: "Representative material allowance for the first prototype.", createdAt: timestamp, updatedAt: timestamp, version: 1 },
    { id: "synthetic-bom-board", revisionId: revision.id, name: "ESP32 development board", itemId: "board-esp32", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: timestamp, updatedAt: timestamp, version: 1 },
    { id: "synthetic-bom-wire", revisionId: revision.id, name: "Dupont jumper wire assortment", itemId: "wire-dupont", requiredQuantity: 1, unit: "set", optional: false, constraints: {}, alternatives: [], notes: "Delivery is recorded; physical count is still required.", createdAt: timestamp, updatedAt: timestamp, version: 1 },
    { id: "synthetic-bom-fasteners", revisionId: revision.id, name: "M3 mounting screws", requiredQuantity: 4, unit: "each", optional: false, constraints: { kind: "fastener" }, alternatives: [], notes: "Synthetic missing line to exercise shopping guidance.", createdAt: timestamp, updatedAt: timestamp, version: 1 }
  ];
  runtime.projects.seedProject(project);
  runtime.projects.projectRevisions.set(revision.id, clone(revision));
  for (const line of lines) runtime.projects.bomLines.set(line.id, clone(line));
}

function seedSyntheticCatalog(runtime: MemoryRuntime): void {
  const timestamp = "2026-08-30T00:00:00.000Z";
  const printer: CatalogProduct = {
    id: "catalog-printer-h2d", kind: "printer", manufacturer: "Bambu Lab", exactModel: "H2D",
    technology: "fff", buildVolumeMm: { x: 325, y: 320, z: 325 }, createdAt: timestamp, updatedAt: timestamp, version: 1
  };
  const filament: CatalogProduct = {
    id: "catalog-filament-petg-hf", kind: "filament", manufacturer: "Bambu Lab", productName: "PETG HF",
    materialFamily: "PETG", colourName: "Black", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown",
    createdAt: timestamp, updatedAt: timestamp, version: 1
  };
  runtime.catalog.products.set(printer.id, clone(printer));
  runtime.catalog.products.set(filament.id, clone(filament));
  runtime.catalog.profiles.set("printer-h2d", clone({
    id: "profile-printer-h2d", itemId: "printer-h2d", catalogProductId: printer.id, profileType: "printer_asset",
    linkState: "confirmed", details: { assetLabel: "Synthetic H2D" }, createdAt: timestamp, updatedAt: timestamp, version: 1
  } as InventoryProductProfile));
  runtime.catalog.profiles.set("filament-petg-hf", clone({
    id: "profile-filament-petg-hf", itemId: "filament-petg-hf", catalogProductId: filament.id, profileType: "filament_spool",
    linkState: "confirmed", details: { openedState: "sealed" }, createdAt: timestamp, updatedAt: timestamp, version: 1
  } as InventoryProductProfile));
}

export function createSyntheticRuntime(): MemoryRuntime {
  const runtime = createMemoryRuntime([
    seedItem({ id: "printer-h2d", name: "Bambu Lab H2D", kind: "printer", quantity: 1, availableQuantity: 1, unit: "each", tags: ["3d-printing", "bambu"], links: [], evidence: { state: "commissioned", source: "synthetic-demo" } }),
    seedItem({ id: "filament-petg-hf", name: "Bambu PETG HF", kind: "filament", quantity: 1000, availableQuantity: 1000, unit: "gram", tags: ["petg", "bambu"], links: [], evidence: { state: "physically_counted", source: "synthetic-demo" } }),
    seedItem({ id: "board-esp32", name: "ESP32 development board", kind: "electronic", quantity: 2, availableQuantity: 2, unit: "each", tags: ["esp32", "microcontroller"], links: [], evidence: { state: "physically_counted", source: "synthetic-demo" } }),
    seedItem({ id: "wire-dupont", name: "Dupont jumper wire assortment", kind: "wire", quantity: 1, availableQuantity: 0, unit: "set", tags: ["wire", "electronics"], links: [], evidence: { state: "delivered_uncounted", source: "synthetic-demo" } })
  ]);
  seedSyntheticProject(runtime);
  seedSyntheticCatalog(runtime);
  return runtime;
}
