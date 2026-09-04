import { createBomLine, createId, createProject, createProjectRevision, createWorkItem, createWorkItemRevision, DomainError } from "@benchledger/domain";
import { bomSpecificationSchema } from "@benchledger/api-contract";
import type {
  BomConstraints, BomLine, Project, ProjectRevision, Reservation, WorkItem, WorkItemRevision
} from "@benchledger/domain";
import type {
  BomLine as ApiBomLine, CreateBomLine, CreateProject, CreateProjectRevision, CreateReservation,
  CreateWorkItem, CreateWorkItemRevision, Project as ApiProject, ProjectRevision as ApiProjectRevision,
  ProjectWithInitialRevision as ApiProjectWithInitialRevision, CreateProjectWithInitialRevision,
  Reservation as ApiReservation, WorkItem as ApiWorkItem, WorkItemRevision as ApiWorkItemRevision, ProjectTombstone,
  InventoryItem as ApiInventoryItem, UpdateProjectRevision
} from "@benchledger/api-contract";
import { ApplicationError, matchesBomConstraints, stableCreateConflict, unsupportedBomConstraintKeys } from "@benchledger/application";
import type { ProjectPort, ProjectListOptions, RequestContext, ReservationDetails, StockMutation, UsageInput } from "@benchledger/application";
import { BomRepository, ProjectRepository, ReservationRepository } from "@benchledger/database";
import type { ReservationReleaseOptions } from "@benchledger/database";
import type { BenchDatabase } from "@benchledger/database";
import { RuntimeState } from "./persistence.js";
import {
  apiBomLineFromNative, apiProjectFromNative, apiProjectRevisionFromNative, apiReservationFromNative, apiStockEventFromNative,
  apiWorkItemFromNative, apiWorkItemRevisionFromNative, isConfirmedEvidence, mapApiKindToCategory,
  mapApiUnitToDomain, nativeConstraintsFromApi, nativeProjectStatus
} from "./mappers.js";
import { ProductionInventoryAdapter } from "./inventory-adapter.js";
import { attempt, clone, nowIso, page } from "./utils.js";
import { createStockEvent } from "@benchledger/domain";
import { bomAlternativeSchema } from "@benchledger/api-contract";

const PROJECT = "project";
const WORK_ITEM = "work_item";
const PROJECT_REVISION = "project_revision";
const WORK_ITEM_REVISION = "work_item_revision";
const BOM = "bom_line";
const RESERVATION = "reservation";

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type ApiBomAlternative = ApiBomLine["alternatives"][number];

function canonicalBomAlternatives(value: readonly ApiBomAlternative[]): ApiBomAlternative[] {
  return value.map((alternative) => bomAlternativeSchema.parse(alternative));
}

function bomQuantityConversion(
  line: Pick<ApiBomLine, "unit" | "alternatives">,
  item: Pick<ApiInventoryItem, "id" | "unit">
): NonNullable<ApiBomAlternative["quantityConversion"]> | undefined {
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

export function bomMetadata(value: Readonly<Record<string, unknown>>): { readonly constraints?: ApiBomLine["constraints"]; readonly alternatives?: readonly ApiBomAlternative[]; readonly retired?: boolean; readonly createdAt?: string; readonly updatedAt?: string } {
  const constraintsRecord = record(value.constraints);
  const constraints: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(constraintsRecord)) {
    if (typeof candidate === "string") constraints[key] = candidate;
    else if (key === "specification") {
      if (!bomSpecificationSchema.safeParse(candidate).success) throw new Error("BOM specification decision is malformed");
      constraints[key] = candidate;
    }
  }
  const alternatives: ApiBomLine["alternatives"] | undefined = Array.isArray(value.alternatives)
    ? value.alternatives.flatMap((candidate) => {
      const item = record(candidate);
      if (typeof item.itemId !== "string") return [];
      const compatible = item.compatible === "confirmed" || item.compatible === "conditional" || item.compatible === "unknown" ? item.compatible : "conditional";
      const parsed = bomAlternativeSchema.safeParse({
        itemId: item.itemId,
        ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
        compatible,
        ...(item.quantityConversion === undefined ? {} : { quantityConversion: item.quantityConversion })
      });
      if (!parsed.success) throw new Error("BOM alternative metadata is malformed");
      return [parsed.data];
    })
    : undefined;
  const createdAt = text(value.createdAt);
  const updatedAt = text(value.updatedAt);
  return {
    ...(Object.keys(constraints).length === 0 ? {} : { constraints: constraints as ApiBomLine["constraints"] }),
    ...(alternatives === undefined ? {} : { alternatives }),
    ...(value.retired === true ? { retired: true } : {}),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt })
  };
}

function currentRevisionId(revisions: readonly { readonly id: string; readonly number: number }[]): string | undefined {
  return revisions.slice().sort((a, b) => b.number - a.number || b.id.localeCompare(a.id))[0]?.id;
}

/**
 * Runtime ports still accept legacy persisted BOM maps. The REST/MCP input
 * schemas are strict, while this adapter keeps old records inspectable and
 * relies on the application matcher to fail closed on unknown keys.
 */
type LegacyCreateBomLineInput = Omit<CreateBomLine, "constraints"> & {
  constraints?: ApiBomLine["constraints"];
};

function nativeBomFromApi(revisionId: string, input: CreateBomLine | LegacyCreateBomLineInput, id: string): BomLine {
  const constraints = input.constraints ?? {};
  return createBomLine({
    id,
    revisionId,
    name: input.name,
    quantity: input.requiredQuantity,
    unit: mapApiUnitToDomain(input.unit),
    ...(input.role === undefined ? {} : { role: input.role }),
    required: !input.optional,
    optional: input.optional,
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
    ...(input.alternatives.length === 0 ? {} : { alternativeItemIds: input.alternatives.map((alternative) => alternative.itemId) }),
    ...(Object.keys(constraints).length === 0 ? {} : { constraints: nativeConstraintsFromApi(constraints) }),
    ...(input.notes === undefined ? {} : { notes: input.notes })
  });
}

export class ProductionProjectAdapter implements ProjectPort {
  constructor(
    private readonly database: BenchDatabase,
    private readonly projects: ProjectRepository,
    private readonly boms: BomRepository,
    private readonly reservations: ReservationRepository,
    private readonly inventory: ProductionInventoryAdapter,
    private readonly state: RuntimeState
  ) {}

  async listProjects(options: ProjectListOptions): Promise<{ readonly data: readonly ApiProject[]; readonly nextCursor?: string; readonly limit: number; readonly total: number }> {
    return attempt(() => {
      const values = this.projects.list(true).filter((project) => project.removedAt === undefined).map((project) => this.toApiProject(project)).filter((project) => {
        if (options.status === undefined && project.status === "archived") return false;
        if (options.status !== undefined && project.status !== options.status) return false;
        const query = options.q?.trim().toLocaleLowerCase();
        return query === undefined || query.length === 0 || `${project.name} ${project.description ?? ""}`.toLocaleLowerCase().includes(query);
      }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      return page(values, options.limit, options.cursor);
    });
  }

  async getProject(id: string): Promise<ApiProject | null> {
    return attempt(() => {
      const project = this.projects.get(id);
      return project === undefined ? null : this.toApiProject(project);
    });
  }

  async listRemovedProjects(): Promise<readonly ProjectTombstone[]> {
    return attempt(() => this.projects.listRemoved().map((project) => this.toProjectTombstone(project)));
  }

  async listRemovedProjectsPage(limit: number, cursor?: string) {
    return attempt(() => {
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || (cursor !== undefined && !/^\d+$/.test(cursor))) {
        throw new ApplicationError("validation", "cursor is invalid");
      }
      const result = this.projects.listRemovedPage(limit, offset);
      const data = result.data.map((project) => this.toProjectTombstone(project));
      const nextOffset = offset + data.length;
      return { data, limit, total: result.total, ...(nextOffset < result.total ? { nextCursor: String(nextOffset) } : {}) };
    });
  }

  async createProject(input: CreateProject, _ctx: RequestContext): Promise<ApiProject> {
    return attempt(() => {
      const id = input.id ?? createId("project");
      const now = nowIso();
      const native = createProject({ id, name: input.name, ...(input.description === undefined ? {} : { description: input.description }), status: nativeProjectStatus(input.status), createdAt: now, updatedAt: now });
      return this.database.transaction(() => {
        const created = this.projects.create(native);
        this.state.setInitialVersion(PROJECT, created.id);
        return this.toApiProject(created);
      });
    });
  }

  async createProjectWithInitialRevision(input: CreateProjectWithInitialRevision, ctx: RequestContext): Promise<ApiProjectWithInitialRevision> {
    return attempt(() => {
      const projectId = input.project.id ?? createId("project");
      const revisionId = input.revision.id ?? createId("project-revision");
      const now = nowIso();
      const fabricationRoute = input.revision.fabricationRoute ?? "undecided";
      const nativeProject = createProject({
        id: projectId,
        name: input.project.name,
        ...(input.project.description === undefined ? {} : { description: input.project.description }),
        status: nativeProjectStatus(input.project.status),
        createdAt: now,
        updatedAt: now
      });
      const nativeRevision = createProjectRevision({
        id: revisionId,
        projectId,
        number: 1,
        label: input.revision.name,
        status: input.revision.status,
        fabricationRoute,
        intendedPrinterItemId: input.revision.intendedPrinterItemId ?? null,
        ...(input.revision.notes === undefined ? {} : { notes: input.revision.notes }),
        createdAt: now
      });
      return this.database.transaction(() => {
        if (this.projects.hasProjectId(projectId)) {
          throw stableCreateConflict("project_id_exists", "projectId", projectId, "The project ID is already in use; read the existing project or choose a different project ID.", ctx.idempotencyKey);
        }
        if (this.projects.hasRevisionId(revisionId)) {
          throw stableCreateConflict("revision_id_exists", "revisionId", revisionId, "The revision ID is already in use; choose a different revision ID.", ctx.idempotencyKey);
        }
        if (this.projects.hasProjectSlug(nativeProject.slug)) {
          throw stableCreateConflict("project_name_exists", "projectName", nativeProject.slug, "A project with this name already exists; read the existing project or choose a different project name.", ctx.idempotencyKey);
        }
        const createdProject = this.projects.create(nativeProject);
        this.state.setInitialVersion(PROJECT, createdProject.id);
        const createdRevision = this.projects.createRevision(nativeRevision);
        this.state.setInitialVersion(PROJECT_REVISION, createdRevision.id);
        this.state.setMetadata(PROJECT, createdProject.id, { currentRevisionId: createdRevision.id });
        return {
          project: apiProjectFromNative(createdProject, 1, {}, createdRevision.id),
          revision: apiProjectRevisionFromNative(createdRevision, 1)
        };
      });
    });
  }

  async updateProject(id: string, input: Partial<CreateProject>, expectedVersion: number | undefined, ctx: RequestContext): Promise<ApiProject> {
    return attempt(() => {
      const native = this.projects.get(id);
      if (native === undefined) throw new DomainError("project_not_found", `project ${id} does not exist`);
      if (native.removedAt !== undefined) throw new DomainError("project_removed", `project ${id} has been removed from the workspace`);
      if (nativeProjectStatus(input.status ?? native.status) === "archived") return this.archiveProject(id, expectedVersion, ctx);
      return this.database.transaction(() => {
        this.state.ensureVersion(PROJECT, id, expectedVersion);
        const current = this.toApiProject(native);
        const status = input.status ?? current.status;
        const updatedAt = nowIso();
        const canonicalStatus = nativeProjectStatus(status);
        this.database.run("UPDATE projects SET name = ?, description = ?, status = ?, updated_at = ?, retired_at = ? WHERE id = ?", [input.name ?? native.name, input.description ?? native.description ?? null, canonicalStatus, updatedAt, canonicalStatus === "archived" ? updatedAt : null, id]);
        const { retiredAt: _retiredAt, ...nativeWithoutRetirement } = native;
        const updated: Project = { ...nativeWithoutRetirement, name: input.name ?? native.name, ...(input.description === undefined && native.description === undefined ? {} : { description: input.description ?? native.description }), status: canonicalStatus, updatedAt, ...(canonicalStatus === "archived" ? { retiredAt: updatedAt } : {}) };
        const version = this.state.bumpVersion(PROJECT, id);
        return apiProjectFromNative(updated, version, {}, this.latestProjectRevisionId(id));
      });
    });
  }

  async archiveProject(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<ApiProject> {
    return attempt(() => {
      const native = this.projects.get(id);
      if (native === undefined) throw new DomainError("project_not_found", `project ${id} does not exist`);
      if (native.removedAt !== undefined) throw new DomainError("project_removed", `project ${id} has been removed from the workspace`);
      return this.database.transaction(() => {
        this.state.ensureVersion(PROJECT, id, expectedVersion);
        if (native.status === "archived") return this.toApiProject(native);
        const archivedAt = nowIso();
        const projectRevisionIds = new Set(this.projects.listRevisions(id).map((revision) => revision.id));
        const actor = {
          type: ctx.source === "mcp" ? "agent" : ctx.source === "import" ? "import" : ctx.source === "system" ? "system" : "human",
          id: ctx.actor
        } as const;
        const releaseOptions = (reservationId: string): ReservationReleaseOptions => ({
          actor,
          source: ctx.source,
          correlationId: ctx.correlationId,
          evidence: { projectId: id, projectArchive: true, reservationId },
          idempotencyKey: `project:${id}:archive:${reservationId}`,
          occurredAt: archivedAt,
          reason: `Archive project ${id}`
        });
        for (const reservation of this.reservations.list()) {
          if (reservation.status !== "active" || !projectRevisionIds.has(reservation.projectRevisionId)) continue;
          const released = this.reservations.release(reservation.id, releaseOptions(reservation.id));
          const reservationVersion = this.state.bumpVersion(RESERVATION, reservation.id);
          const itemVersion = this.state.bumpVersion("inventory_item", reservation.itemId);
          this.state.setMetadata("stock_event", `reservation-${reservation.id}-release`, { apiItemVersion: itemVersion });
          // Keep the local result/version read authoritative for adapters that
          // inspect the release while the enclosing transaction is open.
          void released;
          void reservationVersion;
        }
        this.database.run("UPDATE projects SET status = ?, updated_at = ?, retired_at = ? WHERE id = ?", ["archived", archivedAt, archivedAt, id]);
        const updated: Project = { ...native, status: "archived", updatedAt: archivedAt, retiredAt: archivedAt };
        const version = this.state.bumpVersion(PROJECT, id);
        return apiProjectFromNative(updated, version, {}, this.latestProjectRevisionId(id));
      });
    });
  }

  async restoreProject(id: string, expectedVersion: number | undefined, _ctx: RequestContext): Promise<ApiProject> {
    return attempt(() => {
      const native = this.projects.get(id);
      if (native === undefined) throw new DomainError("project_not_found", `project ${id} does not exist`);
      if (native.removedAt !== undefined) throw new DomainError("project_removed", `project ${id} has been removed from the workspace`);
      return this.database.transaction(() => {
        this.state.ensureVersion(PROJECT, id, expectedVersion);
        if (native.status !== "archived") return this.toApiProject(native);
        const restoredAt = nowIso();
        this.database.run("UPDATE projects SET status = ?, updated_at = ?, retired_at = NULL WHERE id = ?", ["idea", restoredAt, id]);
        const { retiredAt: _retiredAt, ...withoutRetirement } = native;
        const restored: Project = { ...withoutRetirement, status: "idea", updatedAt: restoredAt };
        const version = this.state.bumpVersion(PROJECT, id);
        return apiProjectFromNative(restored, version, {}, this.latestProjectRevisionId(id));
      });
    });
  }

  async removeProject(id: string, expectedVersion: number | undefined, confirmationName: string, ctx: RequestContext): Promise<ProjectTombstone> {
    return attempt(() => {
      const native = this.projects.get(id);
      if (native === undefined) throw new DomainError("project_not_found", `project ${id} does not exist`);
      if (native.removedAt !== undefined) return this.toProjectTombstone(native);
      if (native.name !== confirmationName) throw new DomainError("invalid_project_name_confirmation", "project name confirmation does not match");
      return this.database.transaction(() => {
        this.state.ensureVersion(PROJECT, id, expectedVersion);
        const removedAt = nowIso();
        const actor = {
          type: ctx.source === "mcp" ? "agent" : ctx.source === "import" ? "import" : ctx.source === "system" ? "system" : "human",
          id: ctx.actor
        } as const;
        const projectRevisionIds = new Set(this.projects.listRevisions(id).map((revision) => revision.id));
        const releasedReservationIds: string[] = [];
        for (const reservation of this.reservations.list()) {
          if (reservation.status !== "active" || !projectRevisionIds.has(reservation.projectRevisionId)) continue;
          this.reservations.release(reservation.id, {
            actor,
            source: ctx.source,
            correlationId: ctx.correlationId,
            evidence: { projectId: id, projectRemoval: true, reservationId: reservation.id },
            idempotencyKey: `project:${id}:remove:${reservation.id}`,
            occurredAt: removedAt,
            reason: `Remove project ${id}`
          });
          this.state.bumpVersion(RESERVATION, reservation.id);
          this.state.bumpVersion("inventory_item", reservation.itemId);
          this.state.setMetadata("stock_event", `reservation-${reservation.id}-release`, { apiItemVersion: this.state.getVersion("inventory_item", reservation.itemId) });
          releasedReservationIds.push(reservation.id);
        }
        this.database.run("UPDATE projects SET removed_at = ?, removed_by_json = ?, last_lifecycle_status = ?, removed_reservation_ids_json = ?, updated_at = ? WHERE id = ?", [removedAt, JSON.stringify(actor), native.status, JSON.stringify(releasedReservationIds), removedAt, id]);
        const removed: Project = {
          ...native,
          removedAt,
          removedBy: actor,
          lastLifecycleStatus: native.status,
          removedReservationIds: releasedReservationIds,
          updatedAt: removedAt
        };
        const version = this.state.bumpVersion(PROJECT, id);
        return this.toProjectTombstone(removed, version);
      });
    });
  }

  async createWorkItem(projectId: string, input: CreateWorkItem, _ctx: RequestContext): Promise<ApiWorkItem> {
    return attempt(() => {
      this.assertProjectActive(projectId);
      const now = nowIso();
      const native = createWorkItem({ id: input.id ?? createId("work"), projectId, name: input.name, kind: input.kind, ...(input.description === undefined ? {} : { description: input.description }), createdAt: now, updatedAt: now });
      const created = this.projects.createWorkItem(native);
      this.state.setInitialVersion(WORK_ITEM, created.id);
      return apiWorkItemFromNative(created, 1, undefined);
    });
  }

  async getWorkItem(id: string): Promise<ApiWorkItem | null> {
    return attempt(() => {
      const workItem = this.projects.getWorkItem(id);
      return workItem === undefined ? null : apiWorkItemFromNative(workItem, this.state.getVersion(WORK_ITEM, id), this.latestWorkItemRevisionId(id));
    });
  }

  async listWorkItems(projectId: string): Promise<readonly ApiWorkItem[]> {
    return attempt(() => this.projects.listWorkItems(projectId).map((item) => apiWorkItemFromNative(item, this.state.getVersion(WORK_ITEM, item.id), this.latestWorkItemRevisionId(item.id))));
  }

  async createProjectRevision(projectId: string, input: CreateProjectRevision, _ctx: RequestContext): Promise<ApiProjectRevision> {
    return attempt(() => {
      this.assertProjectActive(projectId);
      const previous = this.projects.listRevisions(projectId);
      const predecessor = previous.slice().sort((left, right) => right.number - left.number || right.id.localeCompare(left.id))[0];
      const inheritedRoute = input.fabricationRoute ?? predecessor?.fabricationRoute;
      const effectiveRoute = inheritedRoute ?? "undecided";
      const hasPrinterField = Object.prototype.hasOwnProperty.call(input, "intendedPrinterItemId");
      if (input.intendedPrinterItemId !== undefined && input.intendedPrinterItemId !== null && effectiveRoute !== "printed") {
        throw new DomainError("invalid_printer_route", "an intended printer requires the printed fabrication route");
      }
      const intendedPrinterItemId = effectiveRoute === "printed"
        ? (hasPrinterField ? input.intendedPrinterItemId ?? null : predecessor?.intendedPrinterItemId ?? null)
        : null;
      const revision = createProjectRevision({
        id: input.id ?? createId("project-revision"),
        projectId,
        number: Math.max(0, ...previous.map((candidate) => candidate.number)) + 1,
        label: input.name,
        status: input.status,
        fabricationRoute: effectiveRoute,
        intendedPrinterItemId,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        createdAt: nowIso()
      });
      const created = this.projects.createRevision(revision);
      this.state.setInitialVersion(PROJECT_REVISION, created.id);
      const metadata = this.state.getMetadata(PROJECT, projectId);
      this.state.setMetadata(PROJECT, projectId, { ...metadata, currentRevisionId: created.id });
      return apiProjectRevisionFromNative(created, 1);
    });
  }

  async getProjectRevision(id: string): Promise<ApiProjectRevision | null> {
    return attempt(() => {
      const found = this.findProjectRevision(id);
      return found === undefined ? null : apiProjectRevisionFromNative(found.revision, this.state.getVersion(PROJECT_REVISION, id));
    });
  }

  async updateProjectRevision(id: string, input: UpdateProjectRevision, _expectedVersion: number | undefined, _ctx: RequestContext): Promise<ApiProjectRevision> {
    return attempt(() => {
      const found = this.findProjectRevision(id);
      if (found === undefined) throw new DomainError("project_revision_not_found", `project revision ${id} does not exist`);
      // Route changes are intentionally narrow. A non-printed route cannot
      // retain a printer assignment, because that would look actionable on a
      // later read even though the revision no longer plans to print.
      const route = (input.fabricationRoute ?? found.revision.fabricationRoute ?? "undecided") as NonNullable<ProjectRevision["fabricationRoute"]>;
      const hasPrinterField = Object.prototype.hasOwnProperty.call(input, "intendedPrinterItemId");
      if (hasPrinterField && input.intendedPrinterItemId !== undefined && input.intendedPrinterItemId !== null && route !== "printed") {
        throw new DomainError("invalid_printer_route", "an intended printer requires the printed fabrication route");
      }
      const intendedPrinterItemId = route === "printed"
        ? (hasPrinterField ? input.intendedPrinterItemId ?? null : found.revision.intendedPrinterItemId ?? null)
        : null;
      if (intendedPrinterItemId !== undefined && intendedPrinterItemId !== null && route !== "printed") {
        throw new DomainError("invalid_printer_route", "an intended printer requires the printed fabrication route");
      }
      const { intendedPrinterItemId: _priorPrinter, ...withoutPriorPrinter } = found.revision;
      const updated: ProjectRevision = { ...withoutPriorPrinter, fabricationRoute: route, intendedPrinterItemId };
      return this.database.transaction(() => {
        this.state.ensureVersion(PROJECT_REVISION, id, _expectedVersion);
        const created = this.projects.updateRevision(updated);
        const version = this.state.bumpVersion(PROJECT_REVISION, id);
        return apiProjectRevisionFromNative(created, version);
      });
    });
  }

  async createWorkItemRevision(workItemId: string, input: CreateWorkItemRevision, _ctx: RequestContext): Promise<ApiWorkItemRevision> {
    return attempt(() => {
      const work = this.findWorkItem(workItemId);
      if (work === undefined) throw new DomainError("work_item_not_found", `work item ${workItemId} does not exist`);
      this.assertProjectActive(work.projectId);
      const previous = this.projects.listWorkItemRevisions(workItemId);
      const revision = createWorkItemRevision({ id: input.id ?? createId("work-revision"), workItemId, number: Math.max(0, ...previous.map((candidate) => candidate.number)) + 1, label: input.name, status: input.status, ...(input.notes === undefined ? {} : { sourcePath: input.notes }), createdAt: nowIso() });
      const created = this.projects.createWorkItemRevision(revision);
      this.state.setInitialVersion(WORK_ITEM_REVISION, created.id);
      return apiWorkItemRevisionFromNative(created, work.projectId, 1);
    });
  }

  async getWorkItemRevision(id: string): Promise<ApiWorkItemRevision | null> {
    return attempt(() => {
      const found = this.findWorkItemRevision(id);
      return found === undefined ? null : apiWorkItemRevisionFromNative(found.revision, found.projectId, this.state.getVersion(WORK_ITEM_REVISION, id));
    });
  }

  async listBomLines(revisionId: string, options?: { readonly includeRetired?: boolean }): Promise<readonly ApiBomLine[]> {
    return attempt(() => this.boms.listLines(revisionId, options?.includeRetired === true).map((line) => this.toApiBom(line)));
  }

  async getBomLine(id: string): Promise<ApiBomLine | null> {
    return attempt(() => {
      const line = this.boms.getLine(id);
      return line === undefined ? null : this.toApiBom(line);
    });
  }

  async createBomLine(revisionId: string, input: CreateBomLine | LegacyCreateBomLineInput, _ctx: RequestContext): Promise<ApiBomLine> {
    return attempt(() => {
      const revision = this.findProjectRevision(revisionId);
      if (revision === undefined) throw new DomainError("project_revision_not_found", `project revision ${revisionId} does not exist`);
      this.assertProjectActive(revision.revision.projectId);
      const alternatives = canonicalBomAlternatives(input.alternatives);
      const canonicalInput = { ...input, alternatives };
      if (canonicalInput.constraints?.kind === "printer") {
        throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
      }
      for (const itemId of [canonicalInput.itemId, ...alternatives.map((alternative) => alternative.itemId)].filter((value): value is string => value !== undefined)) {
        const item = this.inventory.native(itemId);
        if (item !== undefined && item.category === "printer") {
          throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
        }
      }
      const native = nativeBomFromApi(revisionId, canonicalInput, input.id ?? createId("bom"));
      const created = this.boms.createLine(native);
      this.state.setInitialVersion(BOM, created.id);
      this.state.setMetadata(BOM, created.id, { constraints: canonicalInput.constraints, alternatives, createdAt: nowIso(), updatedAt: nowIso() });
      return this.toApiBom(created, 1);
    });
  }

  async updateBomLine(id: string, input: Partial<CreateBomLine>, expectedVersion: number | undefined, _ctx: RequestContext): Promise<ApiBomLine> {
    return attempt(() => {
      const native = this.boms.getLine(id);
      if (native === undefined) throw new DomainError("bom_line_not_found", `BOM line ${id} does not exist`);
      return this.database.transaction(() => {
        this.state.ensureVersion(BOM, id, expectedVersion);
        const current = this.toApiBom(native);
        if (Object.prototype.hasOwnProperty.call(input, "role") && (input.role === "reusable" || (current.role === "consumed" && input.role !== "consumed"))
          && this.reservations.list().some((reservation) => reservation.bomLineId === id && reservation.status === "active")) {
          throw new ApplicationError("conflict", "Release or reconcile active reservations before changing this requirement from a part or material", { lineId: id });
        }
        const optional = input.optional ?? current.optional;
        const alternatives = canonicalBomAlternatives(input.alternatives ?? current.alternatives);
        const constraints = input.constraints ?? current.constraints;
        if (constraints.kind === "printer") {
          throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
        }
        for (const itemId of [input.itemId ?? current.itemId, ...alternatives.map((alternative) => alternative.itemId)].filter((value): value is string => value !== undefined)) {
          const item = this.inventory.native(itemId);
          if (item !== undefined && item.category === "printer") {
            throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
          }
        }
        const updatedAt = nowIso();
      const updated: BomLine = {
        ...native,
        name: input.name ?? native.name,
        quantity: input.requiredQuantity ?? native.quantity,
        unit: input.unit === undefined ? native.unit : mapApiUnitToDomain(input.unit),
        ...(input.role === undefined
          ? (native.role === undefined ? {} : { role: native.role })
          : { role: input.role }),
        required: !optional,
          optional,
          ...(input.itemId === undefined && native.itemId === undefined ? {} : { itemId: input.itemId ?? native.itemId }),
          alternativeItemIds: alternatives.map((alternative) => alternative.itemId),
          constraints: nativeConstraintsFromApi(constraints),
          ...(input.notes === undefined && native.notes === undefined ? {} : { notes: input.notes ?? native.notes })
        };
        this.database.run("UPDATE bom_lines SET name = ?, quantity = ?, unit = ?, role = ?, required = ?, optional = ?, item_id = ?, alternative_item_ids_json = ?, constraints_json = ?, notes = ? WHERE id = ?", [updated.name, updated.quantity, updated.unit, updated.role ?? null, updated.required ? 1 : 0, updated.optional === true ? 1 : 0, updated.itemId ?? null, JSON.stringify(updated.alternativeItemIds ?? []), JSON.stringify(updated.constraints ?? {}), updated.notes ?? null, id]);
        const version = this.state.bumpVersion(BOM, id);
        this.state.setMetadata(BOM, id, { ...this.state.getMetadata(BOM, id), constraints, alternatives, updatedAt });
        return this.toApiBom(updated, version);
      });
    });
  }

  async retireBomLine(id: string, expectedVersion: number | undefined, _ctx: RequestContext): Promise<ApiBomLine> {
    return attempt(async () => {
      const native = this.boms.getLine(id);
      if (native === undefined) throw new DomainError("bom_line_not_found", `BOM line ${id} does not exist`);
      if (this.reservations.list().some((reservation) => reservation.bomLineId === id && reservation.status === "active")) {
        throw new DomainError("active_reservation_conflict", "release active reservations before retiring this BOM line");
      }
      return this.database.transaction(() => {
        this.state.ensureVersion(BOM, id, expectedVersion);
        if (native.retiredAt !== undefined) return this.toApiBom(native);
        const retiredAt = nowIso();
        this.database.run("UPDATE bom_lines SET retired_at = ? WHERE id = ?", [retiredAt, id]);
        const retired = { ...native, retiredAt };
        const version = this.state.bumpVersion(BOM, id);
        this.state.setMetadata(BOM, id, { ...this.state.getMetadata(BOM, id), retired: true, updatedAt: retiredAt });
        return this.toApiBom(retired, version);
      });
    });
  }

  async restoreBomLine(id: string, expectedVersion: number | undefined, _ctx: RequestContext): Promise<ApiBomLine> {
    return attempt(() => {
      const native = this.boms.getLine(id);
      if (native === undefined) throw new DomainError("bom_line_not_found", `BOM line ${id} does not exist`);
      return this.database.transaction(() => {
        this.state.ensureVersion(BOM, id, expectedVersion);
        if (native.retiredAt === undefined) return this.toApiBom(native);
        const updatedAt = nowIso();
        this.database.run("UPDATE bom_lines SET retired_at = NULL WHERE id = ?", [id]);
        const { retiredAt: _retiredAt, ...restored } = native;
        const version = this.state.bumpVersion(BOM, id);
        const metadata = { ...this.state.getMetadata(BOM, id), retired: false, updatedAt };
        this.state.setMetadata(BOM, id, metadata);
        return this.toApiBom(restored, version);
      });
    });
  }

  async createReservation(revisionId: string, input: CreateReservation, _ctx: RequestContext): Promise<ApiReservation> {
    return attempt(() => {
      const revision = this.findProjectRevision(revisionId);
      if (revision === undefined) throw new DomainError("project_revision_not_found", `project revision ${revisionId} does not exist`);
      this.assertProjectActive(revision.revision.projectId);
      const line = this.boms.getLine(input.lineId);
      if (line === undefined || line.revisionId !== revisionId) throw new DomainError("bom_line_not_found", `BOM line ${input.lineId} does not exist in revision ${revisionId}`);
      const apiLine = this.toApiBom(line);
      const unsupported = unsupportedBomConstraintKeys(apiLine.constraints);
      if (unsupported.length > 0) throw new DomainError("invalid_bom_constraint", `unsupported BOM constraint key(s): ${unsupported.join(", ")}`);
      const nativeItem = this.inventory.native(input.itemId);
      if (nativeItem === undefined) throw new DomainError("inventory_not_found", `inventory item ${input.itemId} does not exist`);
      const item = this.inventory.toApi(nativeItem);
      if (apiLine.role !== "consumed") {
        throw new DomainError(apiLine.role === "reusable" ? "reusable_requirement_not_reservable" : "bom_line_role_required", apiLine.role === "reusable" ? "Reusable requirements do not reserve consumable stock" : "Review the BOM line requirement role before reservation");
      }
      const exact = apiLine.itemId === input.itemId;
      const approvedAlternative = apiLine.alternatives.some((alternative) => alternative.itemId === input.itemId && alternative.compatible === "confirmed");
      if (!exact && !approvedAlternative) throw new DomainError("invalid_reservation_reference", "reservation item must be the exact BOM item or an approved alternative");
      if (!matchesBomConstraints(item, apiLine.constraints)) throw new DomainError("invalid_reservation_reference", "inventory item does not satisfy the BOM constraints");
      const conversion = bomQuantityConversion(apiLine, item);
      if (item.unit !== this.apiUnit(line.unit) && conversion === undefined) throw new DomainError("invalid_reservation_reference", "reservation unit does not match the BOM line and has no valid quantity conversion");
      if (!isConfirmedEvidence(item.evidence.state)) throw new DomainError("insufficient_stock", "only physically confirmed stock can be reserved");
      const factor = conversion?.requirement.quantity ?? 1;
      const reservedForLine = this.reservations.list()
        .filter((reservation) => reservation.status === "active" && reservation.projectRevisionId === revisionId && reservation.bomLineId === input.lineId)
        .reduce((total, reservation) => {
          const reservedNative = this.inventory.native(reservation.itemId);
          if (reservedNative === undefined) throw new DomainError("inventory_not_found", `inventory item ${reservation.itemId} does not exist`);
          const reservedItem = this.inventory.toApi(reservedNative);
          const reservedConversion = bomQuantityConversion(apiLine, reservedItem);
          if (reservedItem.unit !== this.apiUnit(line.unit) && reservedConversion === undefined) throw new DomainError("invalid_reservation_reference", "existing reservation has no valid quantity conversion");
          return total + reservation.quantity * (reservedConversion?.requirement.quantity ?? 1);
        }, 0);
      const remainingCoverage = Math.max(0, line.quantity - reservedForLine);
      const maximumInventoryUnits = Math.ceil(remainingCoverage / factor);
      if (input.quantity > maximumInventoryUnits) throw new DomainError("insufficient_stock", `cannot reserve beyond the BOM requirement of ${line.quantity} ${this.apiUnit(line.unit)}; ${input.quantity} inventory unit(s) would exceed whole-unit coverage`);
      if (item.availableQuantity < input.quantity) throw new DomainError("insufficient_stock", `cannot reserve ${input.quantity}; only ${item.availableQuantity} unallocated unit(s) remain`);
      const reservation = this.reservations.create({ ...(input.id === undefined ? {} : { id: input.id }), projectRevisionId: revisionId, bomLineId: input.lineId, itemId: input.itemId, quantity: input.quantity, createdAt: nowIso() });
      this.state.setInitialVersion(RESERVATION, reservation.id);
      const itemVersion = this.state.bumpVersion("inventory_item", input.itemId);
      this.state.setMetadata("stock_event", `reservation-${reservation.id}-allocate`, { apiItemVersion: itemVersion });
      return apiReservationFromNative(reservation, 1);
    });
  }

  async releaseReservation(id: string, expectedVersion: number | undefined, _ctx: RequestContext): Promise<ApiReservation> {
    return attempt(() => {
      const current = this.reservations.get(id);
      if (current === undefined) throw new DomainError("reservation_not_found", `reservation ${id} does not exist`);
      this.state.ensureVersion(RESERVATION, id, expectedVersion);
      const released = this.reservations.release(id);
      const version = this.state.bumpVersion(RESERVATION, id);
      const itemVersion = this.state.bumpVersion("inventory_item", current.itemId);
      this.state.setMetadata("stock_event", `reservation-${id}-release`, { apiItemVersion: itemVersion });
      return apiReservationFromNative(released, version);
    });
  }

  async listReservations(revisionId: string): Promise<readonly ApiReservation[]> {
    return attempt(() => this.reservations.list().filter((reservation) => reservation.projectRevisionId === revisionId).map((reservation) => apiReservationFromNative(reservation, this.state.getVersion(RESERVATION, reservation.id))));
  }

  async getReservationDetails(id: string): Promise<ReservationDetails | null> {
    return attempt(() => {
      const reservation = this.reservations.get(id);
      if (reservation === undefined) return null;
      const bomLine = this.boms.getLine(reservation.bomLineId);
      if (bomLine === undefined || bomLine.revisionId !== reservation.projectRevisionId) return null;
      const projectRevision = this.projects.getRevision(reservation.projectRevisionId);
      if (projectRevision === undefined) return null;
      return {
        reservation: apiReservationFromNative(reservation, this.state.getVersion(RESERVATION, reservation.id)),
        projectId: projectRevision.projectId,
        projectRevisionId: reservation.projectRevisionId,
        bomLine: this.toApiBom(bomLine)
      };
    });
  }

  async recordUsage(input: UsageInput, ctx: RequestContext): Promise<StockMutation> {
    return attempt(() => {
      const project = this.projects.get(input.projectId);
      if (project === undefined) throw new DomainError("project_not_found", `project ${input.projectId} does not exist`);
      if (project.status === "archived") throw new DomainError("project_archived", `project ${input.projectId} is archived`);
      const nativeItem = this.inventory.native(input.itemId);
      if (nativeItem === undefined) throw new DomainError("inventory_not_found", `inventory item ${input.itemId} does not exist`);
      if (nativeItem.unit !== mapApiUnitToDomain(input.unit)) throw new DomainError("invalid_unit", `unit mismatch: item uses ${nativeItem.unit}, usage uses ${input.unit}`);
      if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new DomainError("invalid_usage_quantity", "usage quantity must be greater than zero");
      if (input.reservationId === undefined) throw new DomainError("reservation_required", "Usage requires a reservation for a consumed BOM requirement");

      const reservation = this.reservations.get(input.reservationId);
      if (reservation === undefined) throw new DomainError("reservation_not_found", `reservation ${input.reservationId} does not exist`);
      if (reservation.status !== "active") throw new DomainError("reservation_not_active", `reservation ${input.reservationId} is no longer active`);
      if (reservation.itemId !== input.itemId) throw new DomainError("invalid_usage_reference", "usage item does not match the reservation");
      const revision = this.findProjectRevision(reservation.projectRevisionId);
      if (revision === undefined || revision.projectId !== project.id) throw new DomainError("invalid_usage_reference", "reservation belongs to a different project revision");
      const bomLine = this.boms.getLine(reservation.bomLineId);
      if (bomLine === undefined) throw new DomainError("bom_line_not_found", `BOM line ${reservation.bomLineId} does not exist`);
      if (bomLine.role !== "consumed") {
        throw new DomainError(bomLine.role === "reusable" ? "reusable_requirement_not_consumable" : "bom_line_role_required", bomLine.role === "reusable" ? "Reusable requirements remain owned and cannot be consumed" : "Review the BOM line requirement role before usage");
      }
      const usageEvent = createStockEvent({
        id: createId("usage"),
        itemId: input.itemId,
        kind: "consume",
        quantity: input.quantity,
        unit: nativeItem.unit,
        reason: input.note ?? `Consume reservation ${input.reservationId}`,
        actor: { type: ctx.source === "mcp" ? "agent" : ctx.source === "import" ? "import" : ctx.source === "system" ? "system" : "human", id: ctx.actor },
        source: ctx.source,
        evidence: { projectId: project.id, reservationId: input.reservationId, ...(input.note === undefined ? {} : { note: input.note }) },
        correlationId: ctx.correlationId,
        ...(ctx.idempotencyKey === undefined ? {} : { idempotencyKey: ctx.idempotencyKey })
      });
      const consumed = this.reservations.consume(input.reservationId, input.quantity, usageEvent);
      this.state.bumpVersion(RESERVATION, input.reservationId);
      const releaseVersion = this.state.bumpVersion("inventory_item", input.itemId);
      this.state.setMetadata("stock_event", consumed.releaseEvent.id, { apiItemVersion: releaseVersion });
      const usageVersion = this.state.bumpVersion("inventory_item", input.itemId);
      this.state.setMetadata("stock_event", consumed.usage.event.id, { apiItemVersion: usageVersion });
      const currentItem = this.inventory.native(input.itemId);
      if (currentItem === undefined) throw new DomainError("inventory_not_found", `inventory item ${input.itemId} does not exist`);
      return { event: apiStockEventFromNative(consumed.usage.event, usageVersion), item: this.inventory.toApi(currentItem, usageVersion) };
    });
  }

  private toApiProject(project: Project): ApiProject {
    const revisions = this.projects.listRevisions(project.id);
    return apiProjectFromNative(project, this.state.getVersion(PROJECT, project.id), {}, currentRevisionId(revisions));
  }

  private toProjectTombstone(project: Project, version = this.state.getVersion(PROJECT, project.id)): ProjectTombstone {
    if (project.removedAt === undefined || project.removedBy === undefined || project.lastLifecycleStatus === undefined) {
      throw new Error(`project ${project.id} is missing removal tombstone metadata`);
    }
    return {
      id: project.id,
      name: project.name,
      removedAt: project.removedAt,
      removedBy: project.removedBy.id,
      lastLifecycleStatus: project.lastLifecycleStatus,
      releasedReservationIds: [...(project.removedReservationIds ?? [])],
      version
    };
  }

  private toApiBom(line: BomLine, version = this.state.getVersion(BOM, line.id)): ApiBomLine {
    const metadata = bomMetadata(this.state.getMetadata(BOM, line.id));
    return apiBomLineFromNative(line, metadata, version);
  }

  private latestProjectRevisionId(projectId: string): string | undefined {
    return currentRevisionId(this.projects.listRevisions(projectId));
  }

  private assertProjectActive(projectId: string): void {
      const project = this.projects.get(projectId);
      if (project === undefined) throw new DomainError("project_not_found", `project ${projectId} does not exist`);
      if (project.removedAt !== undefined) throw new DomainError("project_removed", `project ${projectId} has been removed from the workspace`);
      if (project.status === "archived") throw new DomainError("project_archived", `project ${projectId} is archived`);
  }

  private latestWorkItemRevisionId(workItemId: string): string | undefined {
    return currentRevisionId(this.projects.listWorkItemRevisions(workItemId));
  }

  private findProjectRevision(id: string): { readonly revision: ProjectRevision; readonly projectId: string } | undefined {
    const revision = this.projects.getRevision(id);
    return revision === undefined ? undefined : { revision, projectId: revision.projectId };
  }

  private findWorkItem(workItemId: string): WorkItem | undefined {
    return this.projects.getWorkItem(workItemId);
  }

  private findWorkItemRevision(id: string): { readonly revision: WorkItemRevision; readonly projectId: string } | undefined {
    return this.projects.getWorkItemRevision(id);
  }

  private apiUnit(unit: BomLine["unit"]): ApiBomLine["unit"] {
    switch (unit) {
      case "gram": return "gram";
      case "millimetre": return "millimetre";
      case "millilitre": return "millilitre";
      case "meter":
      case "metre": return "metre";
      case "set": return "set";
      default: return "each";
    }
  }
}
