import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type {
  Artifact, BomLine, CreateBomLine, CreateInventoryItem, CreateOffer, CreateProject,
  CreateProjectRevision, CreateReservation, CreateWorkItem, CreateWorkItemRevision,
  CreateProjectWithInitialRevision, InventoryItem, Offer, Project, ProjectRevision, ProjectWithInitialRevision, Reservation, StockEvent,
  StockEventInput, UploadSession, WorkItem, WorkItemRevision, CatalogProduct, CreateCatalogProduct,
  UpdateCatalogProduct, InventoryProductProfile, CreateInventoryProductProfile,
  UpdateInventoryProductProfile, BuildConfigurationSnapshot, CreateBuildConfigurationSnapshot,
  ArtifactBuildConfigurationBinding, InventoryCategory, CreateInventoryCategory, UpdateInventoryCategory
} from "@benchledger/api-contract";
import { ApplicationError } from "@benchledger/application";
import type {
  ApplicationPorts, ArtifactDownload, ArtifactPort, AuditEvent, AuditInput, AuditPort,
  BeginUploadInput, EventBusEvent, EventBusPort, HealthPort, IdempotencyPort,
  BuildConfigurationListOptions, BuildConfigurationPort, CatalogPort, CatalogProductListOptions,
  InventoryCategoryListOptions, InventoryCategoryPort, InventoryListOptions, InventoryPort, OfferPort, Page, ProjectListOptions, ProjectPort, RequestContext,
  ReservationDetails, StockMutation, UnitOfWorkOperation, UnitOfWorkPort, UpdateInventoryInput, UploadSessionDetails, UsageInput
} from "@benchledger/application";
import { BUILTIN_INVENTORY_CATEGORIES, compareInventoryCategoryKeys, normalizeInventoryCategoryKey, normalizeInventoryCategoryName } from "@benchledger/domain";

const clone = <T>(value: T): T => structuredClone(value);

const MAX_CATEGORY_CURSOR_LENGTH = 512;
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

function ensureItemUnit(item: InventoryItem, unit: InventoryItem["unit"]): void {
  if (item.unit !== unit) throw new ApplicationError("validation", `Unit mismatch: item uses ${item.unit}, event uses ${unit}`);
}

class MemoryInventory implements InventoryPort {
  readonly items = new Map<string, InventoryItem>();
  readonly events = new Map<string, StockEvent[]>();
  private sequence = 100;

  constructor(seed: readonly InventoryItem[] = []) {
    for (const item of seed) this.items.set(item.id, clone(item));
  }

  listItems(options: InventoryListOptions): Promise<Page<InventoryItem>> {
    const normalized = options.q?.trim().toLowerCase();
    const items = [...this.items.values()].filter((item) => {
      if (options.kind && item.kind !== options.kind) return false;
      if (options.evidence && item.evidence.state !== options.evidence) return false;
      if (options.available !== undefined && (item.availableQuantity > 0) !== options.available) return false;
      if (!normalized) return true;
      return [item.name, item.description, item.manufacturer, item.model, item.sku, ...item.tags].filter(Boolean).join(" ").toLowerCase().includes(normalized);
    }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return Promise.resolve(page(items, options.limit, options.cursor));
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
    const current = this.items.get(itemId);
    if (!current) throw new ApplicationError("not_found", `Inventory item '${itemId}' was not found`);
    ensureVersion(current.version, expectedVersion, "Inventory item");
    const evidence = input.evidence ?? current.evidence;
    const quantity = input.quantity ?? current.quantity;
    const availableQuantity = input.quantity !== undefined || input.evidence !== undefined
      ? (canCount(evidence.state) ? quantity : 0)
      : current.availableQuantity;
    const nextCategoryNodeId = input.categoryNodeId === null ? undefined : input.categoryNodeId ?? current.categoryNodeId;
    const next = {
      ...current,
      ...input,
      ...(nextCategoryNodeId === undefined ? { categoryNodeId: undefined } : { categoryNodeId: nextCategoryNodeId }),
      ...(input.tags ? { tags: [...input.tags] } : {}),
      ...(input.links ? { links: clone(input.links) } : {}),
      ...(input.dimensions ? { dimensions: clone(input.dimensions) } : {}),
      evidence: clone(evidence), quantity, availableQuantity,
      updatedAt: iso(), version: current.version + 1
    } as InventoryItem;
    this.items.set(itemId, next);
    return Promise.resolve(clone(next));
  }

  async recordPhysicalCount(itemId: string, quantity: number, ctx: RequestContext, note?: string): Promise<StockMutation> {
    const current = this.items.get(itemId);
    if (!current) throw new ApplicationError("not_found", `Inventory item '${itemId}' was not found`);
    if (!Number.isFinite(quantity) || quantity < 0) throw new ApplicationError("validation", "Physical count must be zero or greater");
    const stock = await this.recordStockEvent({ itemId, type: "count", quantity, unit: current.unit, ...(note === undefined ? {} : { note }) }, ctx);
    const evidence = { ...current.evidence, state: "physically_counted" as const, observedAt: iso() };
    const updated = await this.updateItem(itemId, { evidence }, stock.item.version);
    return { event: stock.event, item: updated };
  }

  recordStockEvent(input: StockEventInput, ctx: RequestContext): Promise<StockMutation> {
    const current = this.items.get(input.itemId);
    if (!current) throw new ApplicationError("not_found", `Inventory item '${input.itemId}' was not found`);
    ensureItemUnit(current, input.unit);
    if (input.type === "count") {
      if (!Number.isFinite(input.quantity) || input.quantity < 0) throw new ApplicationError("validation", "Count must be zero or greater");
    } else ensurePositive(input.quantity, "Event quantity");
    let quantity = current.quantity;
    let availableQuantity = current.availableQuantity;
    if (input.type === "count") {
      quantity = input.quantity;
      availableQuantity = canCount(current.evidence.state) ? input.quantity : 0;
    } else if (["receipt", "return"].includes(input.type)) {
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
    const updated: InventoryItem = { ...current, quantity, availableQuantity, updatedAt: iso(), version: current.version + 1 };
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
  readonly workItems = new Map<string, WorkItem>();
  readonly projectRevisions = new Map<string, ProjectRevision>();
  readonly workItemRevisions = new Map<string, WorkItemRevision>();
  readonly bomLines = new Map<string, BomLine>();
  readonly reservations = new Map<string, Reservation>();
  private sequence = 200;

  constructor(private readonly inventory: MemoryInventory) {}

  listProjects(options: ProjectListOptions): Promise<Page<Project>> {
    const q = options.q?.trim().toLowerCase();
    const values = [...this.projects.values()].filter((project) => (!options.status || project.status === options.status) && (!q || `${project.name} ${project.description ?? ""}`.toLowerCase().includes(q)));
    return Promise.resolve(page(values, options.limit, options.cursor));
  }
  getProject(idValue: string): Promise<Project | null> { const value = this.projects.get(idValue); return Promise.resolve(value ? clone(value) : null); }
  createProject(input: CreateProject): Promise<Project> {
    const projectId = input.id ?? id("project", ++this.sequence);
    if (this.projects.has(projectId)) throw new ApplicationError("conflict", `Project '${projectId}' already exists`);
    const createdAt = iso();
    const project: Project = { id: projectId, name: input.name.trim(), ...(input.description === undefined ? {} : { description: input.description }), status: input.status, createdAt, updatedAt: createdAt, version: 1 };
    this.projects.set(projectId, project); return Promise.resolve(clone(project));
  }
  async createProjectWithInitialRevision(input: CreateProjectWithInitialRevision): Promise<ProjectWithInitialRevision> {
    const projects = new Map([...this.projects].map(([key, value]) => [key, clone(value)] as const));
    const revisions = new Map([...this.projectRevisions].map(([key, value]) => [key, clone(value)] as const));
    try {
      const project = await this.createProject(input.project);
      const revision = await this.createProjectRevision(project.id, input.revision);
      const currentProject = this.projects.get(project.id);
      if (currentProject === undefined) throw new ApplicationError("integrity_error", "Atomic project creation did not return its project");
      return { project: clone(currentProject), revision: clone(revision) };
    } catch (error: unknown) {
      this.projects.clear();
      for (const [key, value] of projects) this.projects.set(key, value);
      this.projectRevisions.clear();
      for (const [key, value] of revisions) this.projectRevisions.set(key, value);
      throw error;
    }
  }
  updateProject(projectId: string, input: Partial<CreateProject>, expectedVersion: number | undefined): Promise<Project> {
    const current = this.projects.get(projectId); if (!current) throw new ApplicationError("not_found", `Project '${projectId}' was not found`); ensureVersion(current.version, expectedVersion, "Project");
    const next = { ...current, ...input, updatedAt: iso(), version: current.version + 1 } as Project; this.projects.set(projectId, next); return Promise.resolve(clone(next));
  }
  createWorkItem(projectId: string, input: CreateWorkItem): Promise<WorkItem> {
    if (!this.projects.has(projectId)) throw new ApplicationError("not_found", `Project '${projectId}' was not found`);
    const item: WorkItem = { id: input.id ?? id("work", ++this.sequence), projectId, name: input.name.trim(), kind: input.kind, ...(input.description === undefined ? {} : { description: input.description }), createdAt: iso(), updatedAt: iso(), version: 1 };
    this.workItems.set(item.id, item); return Promise.resolve(clone(item));
  }
  getWorkItem(idValue: string): Promise<WorkItem | null> { const value = this.workItems.get(idValue); return Promise.resolve(value ? clone(value) : null); }
  listWorkItems(projectId: string): Promise<readonly WorkItem[]> { return Promise.resolve(clone([...this.workItems.values()].filter((item) => item.projectId === projectId))); }
  createProjectRevision(projectId: string, input: CreateProjectRevision): Promise<ProjectRevision> {
    if (!this.projects.has(projectId)) throw new ApplicationError("not_found", `Project '${projectId}' was not found`);
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
    const number = [...this.workItemRevisions.values()].filter((revision) => revision.workItemId === workItemId).length + 1;
    const revision: WorkItemRevision = { id: input.id ?? id("work-revision", ++this.sequence), workItemId, projectId: work.projectId, number, name: input.name, ...(input.notes === undefined ? {} : { notes: input.notes }), status: input.status, createdAt: iso(), version: 1 };
    this.workItemRevisions.set(revision.id, revision); return Promise.resolve(clone(revision));
  }
  getWorkItemRevision(idValue: string): Promise<WorkItemRevision | null> { const value = this.workItemRevisions.get(idValue); return Promise.resolve(value ? clone(value) : null); }
  listBomLines(revisionId: string): Promise<readonly BomLine[]> { return Promise.resolve(clone([...this.bomLines.values()].filter((line) => line.revisionId === revisionId))); }
  getBomLine(idValue: string): Promise<BomLine | null> { const value = this.bomLines.get(idValue); return Promise.resolve(value ? clone(value) : null); }
  createBomLine(revisionId: string, input: CreateBomLine): Promise<BomLine> {
    const line = { id: input.id ?? id("bom", ++this.sequence), revisionId, name: input.name, ...(input.itemId === undefined ? {} : { itemId: input.itemId }), requiredQuantity: input.requiredQuantity, unit: input.unit, optional: input.optional, constraints: input.constraints ?? {}, alternatives: input.alternatives ?? [], ...(input.notes === undefined ? {} : { notes: input.notes }), createdAt: iso(), updatedAt: iso(), version: 1 } as BomLine;
    this.bomLines.set(line.id, line); return Promise.resolve(clone(line));
  }
  updateBomLine(lineId: string, input: Partial<CreateBomLine>, expectedVersion: number | undefined): Promise<BomLine> {
    const current = this.bomLines.get(lineId); if (!current) throw new ApplicationError("not_found", `BOM line '${lineId}' was not found`); ensureVersion(current.version, expectedVersion, "BOM line");
    const next = { ...current, ...input, ...(input.alternatives ? { alternatives: clone(input.alternatives) } : {}), ...(input.constraints ? { constraints: clone(input.constraints) } : {}), updatedAt: iso(), version: current.version + 1 } as BomLine; this.bomLines.set(lineId, next); return Promise.resolve(clone(next));
  }
  retireBomLine(lineId: string, expectedVersion: number | undefined): Promise<BomLine> { return this.updateBomLine(lineId, { optional: true, notes: "Retired" }, expectedVersion); }
  createReservation(revisionId: string, input: CreateReservation): Promise<Reservation> {
    const line = this.bomLines.get(input.lineId); if (!line || line.revisionId !== revisionId) throw new ApplicationError("not_found", `BOM line '${input.lineId}' was not found in this revision`);
    const item = this.inventory.items.get(input.itemId); if (!item) throw new ApplicationError("not_found", `Inventory item '${input.itemId}' was not found`); if (line.unit !== item.unit) throw new ApplicationError("validation", `Unit mismatch: BOM uses ${line.unit}, item uses ${item.unit}`); ensurePositive(input.quantity, "Reservation quantity");
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
    return this.inventory.recordStockEvent({ itemId: input.itemId, type: "consume", quantity: input.quantity, unit: input.unit, ...(input.note ? { note: input.note } : {}), projectId: input.projectId }, ctx);
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
      .filter((product) => (options.kind === undefined || product.kind === options.kind) && (needle === undefined || JSON.stringify(product).toLocaleLowerCase().includes(needle)))
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
    const next = { ...current, ...input, id: current.id, createdAt: current.createdAt, updatedAt: iso(), version: current.version + 1 } as CatalogProduct;
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

  listBuildConfigurations(revisionId: string, options: BuildConfigurationListOptions): Promise<Page<BuildConfigurationSnapshot>> {
    const values = [...this.snapshots.values()].filter((snapshot) => snapshot.projectRevisionId === revisionId).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return Promise.resolve(page(values, options.limit, options.cursor));
  }

  getLatestBuildConfiguration(revisionId: string): Promise<BuildConfigurationSnapshot | null> {
    const latest = [...this.snapshots.values()]
      .filter((snapshot) => snapshot.projectRevisionId === revisionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .at(-1);
    return Promise.resolve(latest === undefined ? null : clone(latest));
  }

  getBuildConfiguration(configurationId: string): Promise<BuildConfigurationSnapshot | null> {
    const snapshot = this.snapshots.get(configurationId);
    return Promise.resolve(snapshot === undefined ? null : clone(snapshot));
  }

  createBuildConfiguration(input: CreateBuildConfigurationSnapshot): Promise<BuildConfigurationSnapshot> {
    const snapshot = input as BuildConfigurationSnapshot;
    if (this.snapshots.has(snapshot.id)) throw new ApplicationError("conflict", `Build configuration '${snapshot.id}' already exists`);
    this.snapshots.set(snapshot.id, clone(snapshot));
    return Promise.resolve(clone(snapshot));
  }
}

interface UploadState { readonly input: BeginUploadInput; readonly session: UploadSession; readonly body: Uint8Array; }
class MemoryArtifacts implements ArtifactPort {
  readonly artifacts = new Map<string, Artifact>();
  readonly bindings = new Map<string, ArtifactBuildConfigurationBinding>();
  private readonly uploads = new Map<string, UploadState>(); private sequence = 400;
  listArtifacts(projectId: string, workItemId?: string, revisionId?: string): Promise<readonly Artifact[]> { return Promise.resolve(clone([...this.artifacts.values()].filter((artifact) => artifact.projectId === projectId && (!workItemId || artifact.workItemId === workItemId) && (!revisionId || artifact.revisionId === revisionId)))); }
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
  append(input: AuditInput): Promise<AuditEvent> { const event: AuditEvent = { ...input, id: id("audit", ++this.sequence), createdAt: iso() }; this.events.push(event); return Promise.resolve(clone(event)); }
  list(limit: number, cursor?: string): Promise<Page<AuditEvent>> { return Promise.resolve(page(this.events, limit, cursor)); }
}

class MemoryEvents implements EventBusPort {
  private readonly listeners = new Set<(event: EventBusEvent) => void>();
  publish(event: EventBusEvent): void { for (const listener of this.listeners) listener(clone(event)); }
  subscribe(listener: (event: EventBusEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

class MemoryIdempotency implements IdempotencyPort {
  private readonly values = new Map<string, unknown>();
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
  readonly unitOfWork: UnitOfWorkPort;
}

export function createMemoryRuntime(seed: readonly InventoryItem[] = []): MemoryRuntime {
  const inventory = new MemoryInventory(seed);
  const inventoryCategories = new MemoryInventoryCategories(inventory, BUILTIN_INVENTORY_CATEGORIES);
  const projects = new MemoryProjects(inventory);
  const catalog = new MemoryCatalog();
  const buildConfigurations = new MemoryBuildConfigurations();
  const unitOfWork = new MemoryUnitOfWork();
  const ports: ApplicationPorts = { inventory, inventoryCategories, projects, offers: new MemoryOffers(), artifacts: new MemoryArtifacts(), catalog, buildConfigurations, audit: new MemoryAudit(), events: new MemoryEvents(), idempotency: new MemoryIdempotency(), unitOfWork, health: new MemoryHealth() };
  return { ports, inventory, inventoryCategories, projects, catalog, buildConfigurations, unitOfWork };
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
    status: "planning",
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
  runtime.projects.projects.set(project.id, clone(project));
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
