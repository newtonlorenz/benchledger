import { createHash } from "node:crypto";
import { z } from "zod/v3";
import type { Artifact, BomLine, BuildConfigurationSnapshot, BuildPlan, Project, ProjectLibraryQuery, ProjectPresentation, ProjectRevision, WorkItem } from "@benchledger/api-contract";
import { ApplicationError } from "./errors.js";
import type { GapEvaluation, Page } from "./ports.js";
import type { ApplicationService } from "./service.js";

export interface ProjectLibraryProject extends Project {
  workItems: readonly WorkItem[];
  bom: readonly BomLine[];
  artifacts: readonly Artifact[];
  currentRevision?: ProjectRevision & { bom: readonly BomLine[]; artifacts: readonly Artifact[]; gapEvaluation: GapEvaluation; buildConfigSnapshot?: BuildConfigurationSnapshot };
  presentation: ProjectPresentation | null;
  buildPlan: BuildPlan | null;
}

/** Shared hydration for the browser workspace and bounded HTTP/MCP library. */
export async function hydrateProject(service: ApplicationService, project: Project, includePlanning = true): Promise<ProjectLibraryProject> {
  const [workItems, artifacts] = await Promise.all([service.listWorkItems(project.id), service.listArtifacts(project.id)]);
  if (project.currentRevisionId === undefined) return { ...project, workItems, artifacts, bom: [], presentation: null, buildPlan: null };
  const revision = await service.getProjectRevision(project.currentRevisionId);
  if (revision.projectId !== project.id) throw new ApplicationError("integrity_error", "The current revision does not belong to this project.");
  const [bom, revisionArtifacts, gapEvaluation, latestConfiguration, presentation, buildPlan] = await Promise.all([
    service.listBomLines(revision.id), service.listArtifacts(project.id, { projectRevisionId: revision.id }), service.evaluateBomGaps(revision.id), service.getLatestBuildConfiguration(revision.id),
    includePlanning && service.makerWorkflows.supports() ? service.makerWorkflows.projectPresentation(project.id, revision.id) : null,
    includePlanning && service.makerWorkflows.supports() ? service.makerWorkflows.buildPlan(project.id, revision.id) : null
  ]);
  return { ...project, workItems, artifacts, bom, currentRevision: { ...revision, bom, artifacts: revisionArtifacts, gapEvaluation, ...(latestConfiguration === null ? {} : { buildConfigSnapshot: latestConfiguration }) }, presentation, buildPlan };
}

const cursorSchema = z.object({ version: z.literal(1), status: z.enum(["active", "archived", "all"]), scope: z.string().length(64), phase: z.enum(["active", "archived", "scoped"]), cursor: z.string().max(1024).optional() }).strict();
type LibraryCursor = z.infer<typeof cursorSchema>;
const encode = (value: LibraryCursor) => Buffer.from(JSON.stringify(value)).toString("base64url");
const invalidCursor = () => new ApplicationError("invalid_cursor", "Use the returned project-library cursor with the same status and account scope.");

/** Pages only project data; no workspace-global inventory, profiles or offers are read. */
export async function projectLibraryPage(service: ApplicationService, query: ProjectLibraryQuery, projectIds?: readonly string[]): Promise<Page<ProjectLibraryProject>> {
  const scopeIds = projectIds === undefined ? undefined : [...new Set(projectIds)].sort();
  const scope = createHash("sha256").update(JSON.stringify(scopeIds ?? null)).digest("hex");
  let cursor: LibraryCursor = { version: 1, status: query.status, scope, phase: scopeIds === undefined ? query.status === "archived" ? "archived" : "active" : "scoped" };
  if (query.cursor !== undefined) {
    try {
      const bytes = Buffer.from(query.cursor, "base64url");
      if (bytes.toString("base64url") !== query.cursor) throw invalidCursor();
      cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (cursor.status !== query.status || cursor.scope !== scope || (scopeIds === undefined) === (cursor.phase === "scoped") || query.status === "active" && cursor.phase === "archived" || query.status === "archived" && cursor.phase === "active") throw invalidCursor();
    } catch { throw invalidCursor(); }
  }
  let selected: Project[];
  let nextCursor: string | undefined;
  if (scopeIds !== undefined) {
    if (cursor.cursor !== undefined && !/^(0|[1-9][0-9]*)$/u.test(cursor.cursor)) throw invalidCursor();
    const offset = Number(cursor.cursor ?? 0);
    if (!Number.isSafeInteger(offset)) throw invalidCursor();
    const projects = await Promise.all(scopeIds.map(async (id) => {
      try { return await service.getProject(id); }
      catch (error) { if (error instanceof ApplicationError && ["not_found", "project_removed"].includes(error.code)) return null; throw error; }
    }));
    const filtered = projects.filter((project): project is Project => project !== null && (query.status === "all" || (project.status === "archived") === (query.status === "archived")));
    selected = filtered.slice(offset, offset + query.limit);
    if (offset + selected.length < filtered.length) nextCursor = encode({ ...cursor, cursor: String(offset + selected.length) });
  } else {
    const page = await service.listProjects({ limit: query.limit, ...(cursor.phase === "archived" ? { status: "archived" as const } : {}), ...(cursor.cursor === undefined ? {} : { cursor: cursor.cursor }) });
    selected = [...page.data];
    if (page.nextCursor !== undefined) nextCursor = encode({ ...cursor, cursor: page.nextCursor });
    else if (query.status === "all" && cursor.phase === "active") {
      // Continue into archived records after the complete active sequence.
      if (selected.length === query.limit) nextCursor = encode({ version: 1, status: query.status, scope, phase: "archived" });
      else {
        const archived = await service.listProjects({ limit: query.limit - selected.length, status: "archived" });
        selected.push(...archived.data);
        if (archived.nextCursor !== undefined) nextCursor = encode({ version: 1, status: query.status, scope, phase: "archived", cursor: archived.nextCursor });
      }
    }
  }
  return { data: await Promise.all(selected.map((project) => hydrateProject(service, project))), limit: query.limit, ...(nextCursor === undefined ? {} : { nextCursor }) };
}
