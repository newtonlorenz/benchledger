import { DomainError, consumeReservation, createReservation, createStockEvent, releaseReservation } from "@benchledger/domain";
import type { AuditActor, BomAlternative, BomLine, Project, ProjectRevision, Reservation, StockEvent, WorkItem, WorkItemRevision } from "@benchledger/domain";
import { bomAlternativeFromRow, bomLineFromRow, projectFromRow, projectRevisionFromRow, reservationFromRow, workItemFromRow, workItemRevisionFromRow, jsonValue } from "./serializers.js";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";
import type { AppendStockEventResult } from "./inventory-repository.js";

export class ProjectRepository {
  constructor(private readonly database: BenchDatabase) {}

  create(project: Project): Project {
    this.database.run("INSERT INTO projects (id, name, slug, description, status, visibility, created_at, updated_at, retired_at, removed_at, removed_by_json, last_lifecycle_status, removed_reservation_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [project.id, project.name, project.slug, project.description ?? null, project.status, project.visibility, project.createdAt, project.updatedAt, project.retiredAt ?? null, project.removedAt ?? null, jsonValue(project.removedBy), project.lastLifecycleStatus ?? null, jsonValue(project.removedReservationIds)]);
    return project;
  }

  get(id: string): Project | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM projects WHERE id = ?", [id]);
    return row === undefined ? undefined : projectFromRow(row);
  }

  /** Read-only collision checks used inside the atomic project-create transaction. */
  hasProjectId(id: string): boolean {
    return this.database.get<SqliteRow>("SELECT id FROM projects WHERE id = ?", [id]) !== undefined;
  }

  hasProjectSlug(slug: string): boolean {
    return this.database.get<SqliteRow>("SELECT slug FROM projects WHERE slug = ?", [slug]) !== undefined;
  }

  list(includeRetired = false): readonly Project[] {
    const where = includeRetired ? "" : "WHERE retired_at IS NULL AND removed_at IS NULL";
    return this.database.all<SqliteRow>(`SELECT * FROM projects ${where} ORDER BY updated_at DESC, id`, []).map(projectFromRow);
  }

  listRemoved(): readonly Project[] {
    return this.database.all<SqliteRow>("SELECT * FROM projects WHERE removed_at IS NOT NULL ORDER BY removed_at DESC, id", []).map(projectFromRow);
  }

  /** Bounded retained-history query for workspace-global pagination. */
  listRemovedPage(limit: number, offset: number): { readonly data: readonly Project[]; readonly total: number } {
    const totalRow = this.database.get<SqliteRow>("SELECT COUNT(*) AS total FROM projects WHERE removed_at IS NOT NULL", []);
    const total = typeof totalRow?.total === "number" ? totalRow.total : Number(totalRow?.total ?? 0);
    const data = this.database.all<SqliteRow>(
      "SELECT * FROM projects WHERE removed_at IS NOT NULL ORDER BY removed_at DESC, id LIMIT ? OFFSET ?",
      [limit, offset]
    ).map(projectFromRow);
    return { data, total };
  }

  createWorkItem(workItem: WorkItem): WorkItem {
    if (this.get(workItem.projectId) === undefined) throw new DomainError("project_not_found", `project ${workItem.projectId} does not exist`);
    this.database.run("INSERT INTO work_items (id, project_id, name, kind, description, created_at, updated_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [workItem.id, workItem.projectId, workItem.name, workItem.kind, workItem.description ?? null, workItem.createdAt, workItem.updatedAt, workItem.retiredAt ?? null]);
    return workItem;
  }

  listWorkItems(projectId: string): readonly WorkItem[] {
    return this.database.all<SqliteRow>("SELECT * FROM work_items WHERE project_id = ? AND retired_at IS NULL ORDER BY name, id", [projectId]).map(workItemFromRow);
  }

  /** Read one work item by identity without enumerating its owning project. */
  getWorkItem(id: string): WorkItem | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM work_items WHERE id = ?", [id]);
    return row === undefined ? undefined : workItemFromRow(row);
  }

  createRevision(revision: ProjectRevision): ProjectRevision {
    if (this.get(revision.projectId) === undefined) throw new DomainError("project_not_found", `project ${revision.projectId} does not exist`);
    this.database.run("INSERT INTO project_revisions (id, project_id, revision_number, label, status, fabrication_route, intended_printer_item_id, machine_id, material, notes, created_at, supersedes_revision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [revision.id, revision.projectId, revision.number, revision.label, revision.status, revision.fabricationRoute ?? "undecided", revision.intendedPrinterItemId ?? null, revision.machineId ?? null, revision.material ?? null, revision.notes ?? null, revision.createdAt, revision.supersedesRevisionId ?? null]);
    return revision;
  }

  listRevisions(projectId: string): readonly ProjectRevision[] {
    return this.database.all<SqliteRow>("SELECT * FROM project_revisions WHERE project_id = ? ORDER BY revision_number, id", [projectId]).map(projectRevisionFromRow);
  }

  /** Read one project revision by identity, including historical revisions. */
  getRevision(id: string): ProjectRevision | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM project_revisions WHERE id = ?", [id]);
    return row === undefined ? undefined : projectRevisionFromRow(row);
  }

  hasRevisionId(id: string): boolean {
    return this.database.get<SqliteRow>("SELECT id FROM project_revisions WHERE id = ?", [id]) !== undefined;
  }

  updateRevision(revision: ProjectRevision): ProjectRevision {
    if (this.getRevision(revision.id) === undefined) throw new DomainError("project_revision_not_found", `project revision ${revision.id} does not exist`);
    this.database.run(
      "UPDATE project_revisions SET fabrication_route = ?, intended_printer_item_id = ? WHERE id = ?",
      [revision.fabricationRoute ?? "undecided", revision.intendedPrinterItemId ?? null, revision.id]
    );
    return revision;
  }

  createWorkItemRevision(revision: WorkItemRevision): WorkItemRevision {
    const row = this.database.get<SqliteRow>("SELECT id FROM work_items WHERE id = ?", [revision.workItemId]);
    if (row === undefined) throw new DomainError("work_item_not_found", `work item ${revision.workItemId} does not exist`);
    this.database.run("INSERT INTO work_item_revisions (id, work_item_id, revision_number, label, status, source_path, created_at, supersedes_revision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [revision.id, revision.workItemId, revision.number, revision.label, revision.status, revision.sourcePath ?? null, revision.createdAt, revision.supersedesRevisionId ?? null]);
    return revision;
  }

  listWorkItemRevisions(workItemId: string): readonly WorkItemRevision[] {
    return this.database.all<SqliteRow>("SELECT * FROM work_item_revisions WHERE work_item_id = ? ORDER BY revision_number, id", [workItemId]).map(workItemRevisionFromRow);
  }

  /** Read one work-item revision and its project ancestry by identity. */
  getWorkItemRevision(id: string): { readonly revision: WorkItemRevision; readonly projectId: string } | undefined {
    const row = this.database.get<SqliteRow>("SELECT wir.*, wi.project_id AS owning_project_id FROM work_item_revisions AS wir JOIN work_items AS wi ON wi.id = wir.work_item_id WHERE wir.id = ?", [id]);
    if (row === undefined) return undefined;
    const projectId = row.owning_project_id;
    if (typeof projectId !== "string") throw new Error("work-item revision row is missing project ancestry");
    return { revision: workItemRevisionFromRow(row), projectId };
  }
}

export class BomRepository {
  constructor(private readonly database: BenchDatabase) {}

  createLine(line: BomLine): BomLine {
    this.database.run("INSERT INTO bom_lines (id, revision_id, name, quantity, unit, role, required, optional, item_id, alternative_item_ids_json, constraints_json, notes, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [line.id, line.revisionId, line.name, line.quantity, line.unit, line.role ?? null, line.required ? 1 : 0, line.optional === true ? 1 : 0, line.itemId ?? null, jsonValue(line.alternativeItemIds), jsonValue(line.constraints), line.notes ?? null, line.retiredAt ?? null]);
    return line;
  }

  getLine(id: string): BomLine | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM bom_lines WHERE id = ?", [id]);
    return row === undefined ? undefined : bomLineFromRow(row);
  }

  listLines(revisionId: string, includeRetired = false): readonly BomLine[] {
    const retired = includeRetired ? "" : " AND retired_at IS NULL";
    return this.database.all<SqliteRow>(`SELECT * FROM bom_lines WHERE revision_id = ?${retired} ORDER BY id`, [revisionId]).map(bomLineFromRow);
  }

  createAlternative(alternative: BomAlternative): BomAlternative {
    if (this.getLine(alternative.bomLineId) === undefined) throw new DomainError("bom_line_not_found", `BOM line ${alternative.bomLineId} does not exist`);
    this.database.run("INSERT INTO bom_alternatives (id, bom_line_id, item_id, label, constraints_json) VALUES (?, ?, ?, ?, ?)", [alternative.id, alternative.bomLineId, alternative.itemId ?? null, alternative.label, jsonValue(alternative.constraints)]);
    return alternative;
  }

  listAlternatives(bomLineId: string): readonly BomAlternative[] {
    return this.database.all<SqliteRow>("SELECT * FROM bom_alternatives WHERE bom_line_id = ? ORDER BY id", [bomLineId]).map(bomAlternativeFromRow);
  }
}

export class ReservationRepository {
  constructor(private readonly database: BenchDatabase, private readonly inventory: import("./inventory-repository.js").InventoryRepository) {}

  list(itemId?: string): readonly Reservation[] {
    const rows = itemId === undefined
      ? this.database.all<SqliteRow>("SELECT * FROM reservations ORDER BY created_at, id", [])
      : this.database.all<SqliteRow>("SELECT * FROM reservations WHERE item_id = ? ORDER BY created_at, id", [itemId]);
    return rows.map(reservationFromRow);
  }

  get(id: string): Reservation | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM reservations WHERE id = ?", [id]);
    return row === undefined ? undefined : reservationFromRow(row);
  }

  create(input: Parameters<typeof createReservation>[0]): Reservation {
    const item = this.inventory.get(input.itemId);
    if (item === undefined) throw new DomainError("inventory_not_found", `inventory item ${input.itemId} does not exist`);
    const line = this.database.get<SqliteRow>("SELECT role FROM bom_lines WHERE id = ?", [input.bomLineId]);
    if (line !== undefined && line.role !== "consumed") {
      throw new DomainError(line.role === "reusable" ? "reusable_requirement_not_reservable" : "bom_line_role_required", line.role === "reusable" ? "Reusable requirements do not reserve consumable stock" : "Review the BOM line requirement role before reservation");
    }
    const balance = this.inventory.balance(input.itemId);
    const existing = this.list(input.itemId);
    const reservation = createReservation(input, balance, existing);
    this.database.transaction(() => {
      this.database.run("INSERT INTO reservations (id, project_revision_id, bom_line_id, item_id, quantity, status, created_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [reservation.id, reservation.projectRevisionId, reservation.bomLineId, reservation.itemId, reservation.quantity, reservation.status, reservation.createdAt, null]);
      this.inventory.appendStockEvent(createStockEvent({ id: `reservation-${reservation.id}-allocate`, itemId: reservation.itemId, kind: "allocate", quantity: reservation.quantity, unit: item.unit, reason: `Reservation ${reservation.id}`, idempotencyKey: `reservation:${reservation.id}:allocate`, occurredAt: reservation.createdAt, createdAt: reservation.createdAt }));
    });
    return reservation;
  }

  /**
   * Consume a reservation and its stock in one transaction. A reservation is
   * an allocation event, so consuming it first releases that allocation and
   * then records the consumption; otherwise the stock ledger would still
   * count consumed units as allocated and could leave an invalid balance.
   *
   * The API currently models reservations as all-or-nothing. Requiring the
   * usage quantity to equal the reservation quantity prevents a partial use
   * from silently leaving an active reservation with no remaining quantity.
   */
  consume(id: string, quantity: number, usageEvent: StockEvent): { readonly reservation: Reservation; readonly releaseEvent: StockEvent; readonly usage: AppendStockEventResult } {
    if (!Number.isFinite(quantity) || quantity <= 0) throw new DomainError("invalid_usage_quantity", "usage quantity must be greater than zero");
    return this.database.transaction(() => {
      const current = this.get(id);
      if (current === undefined) throw new DomainError("reservation_not_found", `reservation ${id} does not exist`);
      if (current.status !== "active") throw new DomainError("reservation_not_active", `reservation ${id} is no longer active`);
      if (current.itemId !== usageEvent.itemId) throw new DomainError("invalid_usage_reference", "usage item does not match the reservation");
      if (current.quantity !== quantity) throw new DomainError("invalid_usage_quantity", "partial reservation usage is not supported; consume the reserved quantity in full");
      const item = this.inventory.get(current.itemId);
      if (item === undefined) throw new DomainError("inventory_not_found", `inventory item ${current.itemId} does not exist`);
      const releaseEvent = createStockEvent({
        id: `reservation-${id}-consume-release`,
        itemId: current.itemId,
        kind: "release",
        quantity: current.quantity,
        unit: item.unit,
        reason: `Consume reservation ${id}`,
        ...(usageEvent.actor === undefined ? {} : { actor: usageEvent.actor }),
        ...(usageEvent.source === undefined ? {} : { source: usageEvent.source }),
        evidence: { ...(usageEvent.evidence ?? {}), reservationId: id },
        ...(usageEvent.correlationId === undefined ? {} : { correlationId: usageEvent.correlationId }),
        idempotencyKey: `reservation:${id}:consume-release`,
        occurredAt: usageEvent.occurredAt,
        createdAt: usageEvent.createdAt
      });
      const release = this.inventory.appendStockEvent(releaseEvent);
      const usage = this.inventory.appendStockEvent(usageEvent);
      const consumed = consumeReservation(current);
      this.database.run("UPDATE reservations SET status = ?, released_at = ? WHERE id = ?", [consumed.status, null, id]);
      return { reservation: consumed, releaseEvent: release.event, usage };
    });
  }

  release(id: string, options: ReservationReleaseOptions = {}): Reservation {
    const reservation = this.get(id);
    if (reservation === undefined) throw new DomainError("reservation_not_found", `reservation ${id} does not exist`);
    const released = releaseReservation(reservation);
    const releasedAt = released.releasedAt ?? new Date().toISOString();
    const item = this.inventory.get(reservation.itemId);
    if (item === undefined) throw new DomainError("inventory_not_found", `inventory item ${reservation.itemId} does not exist`);
    this.database.transaction(() => {
      this.database.run("UPDATE reservations SET status = ?, released_at = ? WHERE id = ?", [released.status, releasedAt, id]);
      this.inventory.appendStockEvent(createStockEvent({
        id: `reservation-${id}-release`,
        itemId: reservation.itemId,
        kind: "release",
        quantity: reservation.quantity,
        unit: item.unit,
        reason: options.reason ?? `Release reservation ${id}`,
        ...(options.actor === undefined ? {} : { actor: options.actor }),
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
        ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
        idempotencyKey: options.idempotencyKey ?? `reservation:${id}:release`,
        occurredAt: options.occurredAt ?? releasedAt,
        createdAt: releasedAt
      }));
    });
    return released;
  }
}

export interface ReservationReleaseOptions {
  readonly actor?: AuditActor;
  readonly source?: string;
  readonly evidence?: Record<string, unknown>;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly occurredAt?: string;
  readonly reason?: string;
}
