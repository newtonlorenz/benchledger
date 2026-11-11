import { ApplicationError, conflict, notFound, projectRemoved } from "../errors.js";
import type { AuditEvent, Mutation, Page, ProjectListOptions, RequestContext } from "../ports.js";
import { assertOwnedPrinter } from "./catalog.js";
import { canonicalProjectSetupContext } from "./project-setup.js";
import { boundedCursor, boundedLimit, commandContext, requireId } from "./shared.js";
import { createProjectRevisionSchema, createProjectSchema, createProjectWithInitialRevisionSchema, createWorkItemRevisionSchema, createWorkItemSchema, updateProjectRevisionSchema, updateProjectSchema } from "@benchledger/api-contract";
import type { CreateProject, CreateProjectRevision, CreateProjectWithInitialRevision, CreateWorkItem, CreateWorkItemRevision, Project, ProjectRevision, ProjectTombstone, ProjectWithInitialRevision, UpdateProjectRevision, WorkItem, WorkItemRevision } from "@benchledger/api-contract";
import { ServiceModule } from "./module.js";

/** Projects, lifecycle (archive/restore/removal), work items and revisions. */
export class ProjectModule extends ServiceModule {
  async listProjects(query: ProjectListOptions): Promise<Page<Project>> {
    return this.ports.unitOfWork.exclusive(() => this.ports.projects.listProjects(query));
  }

  async getProject(id: string): Promise<Project> {
    return this.ports.unitOfWork.exclusive(async () => {
      const project = await this.ports.projects.getProject(requireId(id, "project id"));
      if (!project) throw notFound("Project", id);
      if (project.removedAt !== undefined) {
        throw projectRemoved(project.id, { removedAt: project.removedAt, removedBy: project.removedBy, lastLifecycleStatus: project.lastLifecycleStatus });
      }
      return project;
    });
  }

  /** Return retained tombstones without making them ordinary project records. */

  async listRemovedProjects(): Promise<readonly ProjectTombstone[]> {
    return this.ports.unitOfWork.exclusive(async () => {
      const list = this.ports.projects.listRemovedProjects;
      if (list === undefined) throw new ApplicationError("integrity_error", "This runtime does not support removed-project history");
      return list.call(this.ports.projects);
    });
  }

  /** Return a bounded page of retained tombstones. Normal project scope is
   * rejected by the transport boundary before this workspace-global command
   * is dispatched. */

  async listRemovedProjectPage(limit = 50, cursor?: string): Promise<Page<ProjectTombstone>> {
    const bounded = boundedLimit(limit, 50, "limit");
    const boundedPageCursor = boundedCursor(cursor);
    return this.ports.unitOfWork.exclusive(async () => {
      const listPage = this.ports.projects.listRemovedProjectsPage;
      if (listPage !== undefined) return listPage.call(this.ports.projects, bounded, boundedPageCursor);
      const list = this.ports.projects.listRemovedProjects;
      if (list === undefined) throw new ApplicationError("integrity_error", "This runtime does not support removed-project history");
      const data = (await list.call(this.ports.projects)).slice(0, bounded);
      return { data, limit: bounded };
    });
  }

  /** Read append-only project history after verifying the project is removed. */

  async readRemovedProjectHistory(id: string, limit = 50, cursor?: string): Promise<Page<AuditEvent>> {
    const projectId = requireId(id, "project id");
    const bounded = boundedLimit(limit, 50, "limit");
    const boundedPageCursor = boundedCursor(cursor);
    return this.ports.unitOfWork.exclusive(async () => {
      const project = await this.ports.projects.getProject(projectId);
      if (project === null) throw notFound("Project", projectId);
      if (project.removedAt === undefined) throw conflict(`Project '${projectId}' has not been removed`);
      if (this.ports.audit.listEntity !== undefined) {
        return this.ports.audit.listEntity("project", projectId, bounded, boundedPageCursor);
      }
      const all = await this.ports.audit.list(200, boundedPageCursor);
      const data = all.data.filter((event) => event.entityType === "project" && event.entityId === projectId).slice(0, bounded);
      return { data, limit: bounded };
    });
  }

  /** Irreversible removal. The runtime port owns the atomic tombstone/release transaction. */

  async removeProject(id: string, expectedVersion: number | undefined, confirmationName: string, ctx: RequestContext): Promise<Mutation<ProjectTombstone>> {
    const projectId = requireId(id, "project id");
    if (typeof confirmationName !== "string" || confirmationName.length === 0) throw new ApplicationError("validation", "Exact project-name confirmation is required");
    const commandCtx = commandContext(ctx, "project.remove", { projectId, expectedVersion, confirmationName });
    const mutation = await this.mutate(commandCtx, "project.remove", "project", projectId, async () => {
      const current = await this.ports.projects.getProject(projectId);
      if (current === null) throw notFound("Project", projectId);
      if (current.removedAt !== undefined) {
        throw projectRemoved(projectId, { removedAt: current.removedAt, removedBy: current.removedBy, lastLifecycleStatus: current.lastLifecycleStatus });
      }
      if (current.name !== confirmationName) {
        throw conflict("Project removal requires an exact, case-sensitive project-name confirmation", { expectedName: current.name });
      }
      const remove = this.ports.projects.removeProject;
      if (remove === undefined) throw new ApplicationError("integrity_error", "This runtime does not support irreversible project removal");
      const tombstone = await remove.call(this.ports.projects, projectId, expectedVersion, confirmationName, commandCtx);
      const rollback = this.ports.projects.rollbackProjectRemoval;
      return {
        value: tombstone,
        entityId: projectId,
        version: tombstone.version,
        eventMetadata: { releasedReservationCount: tombstone.releasedReservationIds.length },
        ...(rollback === undefined ? {} : { compensate: () => rollback.call(this.ports.projects, projectId) })
      };
    });
    // The audit is created by mutate after the atomic runtime operation. Add
    // its identity to the response while preserving replay determinism.
    await this.ports.projects.commitProjectRemoval?.(projectId);
    return { ...mutation, data: { ...mutation.data, ...(mutation.data.auditId === undefined ? { auditId: mutation.audit.id } : {}) } };
  }

  async createProject(input: CreateProject, ctx: RequestContext): Promise<Mutation<Project>> {
    const parsed = createProjectSchema.parse(input);
    return this.mutate(ctx, "project.create", "project", parsed.id ?? "pending", async () => {
      const project = await this.ports.projects.createProject(parsed, ctx);
      return { value: project, entityId: project.id, version: project.version };
    });
  }

  async updateProject(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Project>> {
    const projectId = requireId(id, "project id");
    const parsed = updateProjectSchema.parse(input) as Partial<CreateProject>;
    if (parsed.status === "archived") return this.archiveProject(projectId, expectedVersion, ctx);
    if (parsed.status === "idea") {
      const current = await this.getProject(projectId);
      if (current.status === "archived") return this.restoreProject(projectId, expectedVersion, ctx);
    }
    return this.mutate(ctx, "project.update", "project", projectId, async () => {
      const project = await this.ports.projects.updateProject(projectId, parsed, expectedVersion, ctx);
      return { value: project, entityId: project.id, version: project.version };
    });
  }

  async archiveProject(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Project>> {
    const projectId = requireId(id, "project id");
    const commandCtx = commandContext(ctx, "project.archive", { projectId, expectedVersion });
    const mutation = await this.mutate(commandCtx, "project.archive", "project", projectId, async () => {
      const archive = this.ports.projects.archiveProject;
      if (archive === undefined) throw new ApplicationError("integrity_error", "This runtime does not support atomic project archiving");
      const project = await archive.call(this.ports.projects, projectId, expectedVersion, commandCtx);
      const rollback = this.ports.projects.rollbackProjectArchive;
      return {
        value: project,
        entityId: project.id,
        version: project.version,
        ...(rollback === undefined ? {} : { compensate: () => rollback.call(this.ports.projects, projectId) })
      };
    });
    // The memory adapter keeps a process-local compensation receipt until the
    // surrounding audit transaction commits. Closing it here ensures a later
    // no-op/audit failure cannot roll back this already committed archive.
    await this.ports.projects.commitProjectArchive?.(projectId);
    return mutation;
  }

  async restoreProject(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Project>> {
    const projectId = requireId(id, "project id");
    const commandCtx = commandContext(ctx, "project.restore", { projectId, expectedVersion });
    return this.mutate(commandCtx, "project.restore", "project", projectId, async () => {
      const restore = this.ports.projects.restoreProject;
      const project = restore === undefined
        ? await this.ports.projects.updateProject(projectId, { status: "idea" }, expectedVersion, commandCtx)
        : await restore.call(this.ports.projects, projectId, expectedVersion, commandCtx);
      return { value: project, entityId: project.id, version: project.version };
    });
  }

  async listWorkItems(projectId: string): Promise<readonly WorkItem[]> {
    const parsedProjectId = requireId(projectId, "project id");
    await this.assertProjectReadable(parsedProjectId);
    return this.ports.unitOfWork.exclusive(() => this.ports.projects.listWorkItems(parsedProjectId));
  }

  async getWorkItem(id: string): Promise<WorkItem> {
    return this.ports.unitOfWork.exclusive(async () => {
      const workItem = await this.ports.projects.getWorkItem(requireId(id, "work item id"));
      if (!workItem) throw notFound("Work item", id);
      await this.assertProjectReadable(workItem.projectId);
      return workItem;
    });
  }

  async createWorkItem(projectId: string, input: CreateWorkItem, ctx: RequestContext): Promise<Mutation<WorkItem>> {
    const parsed = createWorkItemSchema.parse(input);
    const parentId = requireId(projectId, "project id");
    return this.mutate(ctx, "project.work_item.create", "work_item", parsed.id ?? "pending", async () => {
      await this.assertProjectActive(parentId);
      const item = await this.ports.projects.createWorkItem(parentId, parsed, ctx);
      return { value: item, entityId: item.id, version: item.version };
    });
  }

  async createProjectRevision(projectId: string, input: CreateProjectRevision, ctx: RequestContext): Promise<Mutation<ProjectRevision>> {
    const parsed = createProjectRevisionSchema.parse(input);
    const parentId = requireId(projectId, "project id");
    return this.mutate(ctx, "project.revision.create", "project_revision", parsed.id ?? "pending", async () => {
      await this.assertProjectActive(parentId);
      const project = await this.ports.projects.getProject(parentId);
      const predecessor = project?.currentRevisionId === undefined ? null : await this.ports.projects.getProjectRevision(project.currentRevisionId);
      const route = parsed.fabricationRoute ?? predecessor?.fabricationRoute;
      const hasPrinterField = Object.prototype.hasOwnProperty.call(parsed, "intendedPrinterItemId");
      if (hasPrinterField && parsed.intendedPrinterItemId !== undefined && parsed.intendedPrinterItemId !== null && route !== "printed") {
        throw new ApplicationError("validation", "The intended printer requires the printed fabrication route");
      }
      const intendedPrinterItemId = route === "printed"
        ? (hasPrinterField ? parsed.intendedPrinterItemId : predecessor?.intendedPrinterItemId ?? null)
        : null;
      if (intendedPrinterItemId !== undefined && intendedPrinterItemId !== null) await assertOwnedPrinter(this.ports, intendedPrinterItemId);
      const createInput: CreateProjectRevision = {
        ...parsed,
        ...(route === undefined ? {} : { fabricationRoute: route }),
        intendedPrinterItemId
      };
      const revision = await this.ports.projects.createProjectRevision(parentId, createInput, ctx);
      return { value: revision, entityId: revision.id, version: revision.version };
    });
  }

  async updateProjectRevision(id: string, input: UpdateProjectRevision, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<ProjectRevision>> {
    const parsed = updateProjectRevisionSchema.parse(input);
    const revisionId = requireId(id, "revision id");
    return this.mutate(ctx, "project.revision.update", "project_revision", revisionId, async () => {
      const current = await this.ports.projects.getProjectRevision(revisionId);
      if (current === null) throw notFound("Project revision", revisionId);
      await this.assertProjectActive(current.projectId);
      const route = parsed.fabricationRoute ?? current.fabricationRoute ?? "undecided";
      const hasPrinterField = Object.prototype.hasOwnProperty.call(parsed, "intendedPrinterItemId");
      if (hasPrinterField && parsed.intendedPrinterItemId !== undefined && parsed.intendedPrinterItemId !== null && route !== "printed") {
        throw new ApplicationError("validation", "The intended printer requires the printed fabrication route");
      }
      const intendedPrinterItemId = route === "printed"
        ? (hasPrinterField ? parsed.intendedPrinterItemId : current.intendedPrinterItemId ?? null)
        : null;
      if (intendedPrinterItemId !== undefined && intendedPrinterItemId !== null) await assertOwnedPrinter(this.ports, intendedPrinterItemId);
      const update = {
        ...parsed,
        fabricationRoute: route,
        intendedPrinterItemId
      } as UpdateProjectRevision;
      const updateRevision = this.ports.projects.updateProjectRevision;
      if (updateRevision === undefined) throw new ApplicationError("integrity_error", "This project adapter does not support revision planning updates");
      const revision = await updateRevision.call(this.ports.projects, revisionId, update, expectedVersion, ctx);
      return { value: revision, entityId: revision.id, version: revision.version };
    });
  }

  async createProjectWithInitialRevision(input: CreateProjectWithInitialRevision, ctx: RequestContext): Promise<Mutation<ProjectWithInitialRevision>> {
    const parsed = createProjectWithInitialRevisionSchema.parse(input);
    const createAtomic = this.ports.projects.createProjectWithInitialRevision;
    if (createAtomic === undefined) throw new ApplicationError("integrity_error", "This project adapter does not support atomic project creation");
    const action = "project.create_with_initial_revision";
    const effectiveRoute = parsed.revision.fabricationRoute ?? "undecided";
    if (parsed.revision.intendedPrinterItemId !== undefined && parsed.revision.intendedPrinterItemId !== null && effectiveRoute !== "printed") {
      throw new ApplicationError("validation", "The intended printer requires the printed fabrication route");
    }
    if (parsed.revision.intendedPrinterItemId !== undefined && parsed.revision.intendedPrinterItemId !== null) await assertOwnedPrinter(this.ports, parsed.revision.intendedPrinterItemId);
    // The atomic command is also used by MCP hosts without an HTTP request
    // fingerprint. Always derive the digest from the parsed, canonical
    // payload so transport envelope differences cannot change replay
    // semantics and a reused key cannot replay changed command fields.
    const commandCtx = canonicalProjectSetupContext(ctx, parsed);
    return this.mutate(commandCtx, action, "project", parsed.project.id ?? "pending", async () => {
      const created = await createAtomic.call(this.ports.projects, parsed, commandCtx);
      return { value: created, entityId: created.project.id, version: created.project.version };
    });
  }

  /** Build a bounded, actor-owned setup proposal without touching graph data. */

  async getProjectRevision(id: string): Promise<ProjectRevision> {
    return this.ports.unitOfWork.exclusive(async () => {
      const revision = await this.ports.projects.getProjectRevision(requireId(id, "revision id"));
      if (!revision) throw notFound("Project revision", id);
      await this.assertProjectReadable(revision.projectId);
      return revision;
    });
  }

  async createWorkItemRevision(workItemId: string, input: CreateWorkItemRevision, ctx: RequestContext): Promise<Mutation<WorkItemRevision>> {
    const parsed = createWorkItemRevisionSchema.parse(input);
    const parentId = requireId(workItemId, "work item id");
    return this.mutate(ctx, "project.work_item_revision.create", "work_item_revision", parsed.id ?? "pending", async () => {
      const workItem = await this.ports.projects.getWorkItem(parentId);
      if (workItem === null) throw notFound("Work item", parentId);
      await this.assertProjectActive(workItem.projectId);
      const revision = await this.ports.projects.createWorkItemRevision(parentId, parsed, ctx);
      return { value: revision, entityId: revision.id, version: revision.version };
    });
  }

  async getWorkItemRevision(id: string): Promise<WorkItemRevision> {
    return this.ports.unitOfWork.exclusive(async () => {
      const revision = await this.ports.projects.getWorkItemRevision(requireId(id, "work item revision id"));
      if (!revision) throw notFound("Work item revision", id);
      await this.assertProjectReadable(revision.projectId);
      return revision;
    });
  }
}
