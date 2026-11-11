import type { Project } from "@benchledger/api-contract";
import type { ApplicationPorts, BulkMutation, InventoryBulkUpdateResult, Mutation, RequestContext } from "../ports.js";
import type { ApplicationService } from "../service.js";
import type { CommandRunner, MutationOutcome } from "./command-runner.js";
import type { ProjectAccess } from "./project-access.js";

/** Collaborators shared by every per-area service module. */
export interface ServiceModuleDependencies {
  readonly ports: ApplicationPorts;
  readonly runner: CommandRunner;
  readonly access: ProjectAccess;
  /**
   * The public facade, used for the few cross-area calls (for example a
   * build configuration resolving its project revision). Routing them through
   * the facade keeps one public entry point per use case.
   */
  readonly app: ApplicationService;
}

/**
 * Base for the per-aggregate modules that implement `ApplicationService`.
 * Modules own no state; they share the ports, the audited command runner and
 * the project ancestry guards.
 */
export abstract class ServiceModule {
  protected readonly ports: ApplicationPorts;
  protected readonly app: ApplicationService;
  private readonly runner: CommandRunner;
  private readonly access: ProjectAccess;

  constructor(dependencies: ServiceModuleDependencies) {
    this.ports = dependencies.ports;
    this.app = dependencies.app;
    this.runner = dependencies.runner;
    this.access = dependencies.access;
  }

  protected mutate<T>(ctx: RequestContext, action: string, entityType: string, provisionalEntityId: string, operation: () => Promise<MutationOutcome<T>>): Promise<Mutation<T>> {
    return this.runner.mutate(ctx, action, entityType, provisionalEntityId, operation);
  }

  protected mutateBulk(ctx: RequestContext, operation: () => Promise<InventoryBulkUpdateResult>): Promise<BulkMutation<InventoryBulkUpdateResult>> {
    return this.runner.mutateBulk(ctx, operation);
  }

  protected assertProjectActive(projectId: string): Promise<Project> {
    return this.access.assertProjectActive(projectId);
  }

  protected assertProjectActiveFromRevision(revisionId: string): Promise<Project> {
    return this.access.assertProjectActiveFromRevision(revisionId);
  }

  protected assertProjectReadable(projectId: string): Promise<Project> {
    return this.access.assertProjectReadable(projectId);
  }

  protected assertProjectReadableFromRevision(revisionId: string): Promise<Project> {
    return this.access.assertProjectReadableFromRevision(revisionId);
  }
}
