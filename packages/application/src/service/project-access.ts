import { conflict, notFound, projectRemoved } from "../errors.js";
import { requireId } from "./shared.js";
import type { Project } from "@benchledger/api-contract";
import type { ApplicationPorts } from "../ports.js";

/** Central project ancestry guards for descendant reads and writes. */
export class ProjectAccess {
  constructor(private readonly ports: ApplicationPorts) {}

  async assertProjectActive(projectId: string): Promise<Project> {
    const project = await this.assertProjectReadable(projectId);
    if (project.status === "archived") {
      throw conflict(`Project '${project.id}' is archived; restore it before creating or committing work`);
    }
    return project;
  }

  async assertProjectActiveFromRevision(revisionId: string): Promise<Project> {
    const revision = await this.ports.projects.getProjectRevision(requireId(revisionId, "revision id"));
    if (revision === null) throw notFound("Project revision", revisionId);
    return this.assertProjectActive(revision.projectId);
  }

  /** Central ancestry guard for all ordinary descendant reads and writes. */

  async assertProjectReadable(projectId: string): Promise<Project> {
    const parsedProjectId = requireId(projectId, "project id");
    const project = await this.ports.projects.getProject(parsedProjectId);
    if (project === null) throw notFound("Project", parsedProjectId);
    if (project.removedAt !== undefined) {
      throw projectRemoved(project.id, { removedAt: project.removedAt, removedBy: project.removedBy, lastLifecycleStatus: project.lastLifecycleStatus });
    }
    return project;
  }

  async assertProjectReadableFromRevision(revisionId: string): Promise<Project> {
    const parsedRevisionId = requireId(revisionId, "revision id");
    const revision = await this.ports.projects.getProjectRevision(parsedRevisionId);
    if (revision === null) throw notFound("Project revision", parsedRevisionId);
    return this.assertProjectReadable(revision.projectId);
  }
}
