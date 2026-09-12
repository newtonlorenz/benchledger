import { z } from "zod/v3";
import { assemblyInputSchema, inspectAssemblySchema, idSchema, workflowPageSchema, sourcingPageSchema, createRequirementOfferSchema, chooseRequirementOfferSchema, buildPlanInputSchema, workAssignmentInputSchema, createWorkstreamSchema, bomImportInputSchema, bomImportCommitSchema, commandJsonSchema } from "@benchledger/api-contract";
import type { McpToolDefinition, JsonObject, McpRequestContext } from "./types.js";
import { McpAdapterError } from "./errors.js";
import type { ApplicationService } from "@benchledger/application";
import { ApplicationError } from "@benchledger/application";
const project = z.object({ projectId: idSchema }).strict(), revision = project.extend({ projectRevisionId: idSchema }).strict();
export const MAKER_TOOL_SCHEMAS = {
  read_requirement_sourcing: revision.merge(sourcingPageSchema),
  record_requirement_offer: revision.extend({ offer: createRequirementOfferSchema }).strict(),
  choose_requirement_offer: revision.extend({ choice: chooseRequirementOfferSchema }).strict(),
  inspect_assembly_sources: revision.extend({ proposal: inspectAssemblySchema }).merge(workflowPageSchema).strict(),
  read_project_assembly: revision,
  save_project_assembly: revision.extend({ assembly: assemblyInputSchema }).strict(),
  read_assembly_history: revision.merge(workflowPageSchema),
  read_build_plan: revision,
  save_build_plan: revision.extend({ plan: buildPlanInputSchema }).strict(),
  read_build_plan_history: revision.merge(workflowPageSchema),
  list_workstreams: project.merge(workflowPageSchema),
  create_workstream: project.extend({ workstream: createWorkstreamSchema }).strict(),
  update_work_assignment: project.extend({ workItemId: idSchema, assignment: workAssignmentInputSchema }).strict(),
  list_project_revisions: project.merge(workflowPageSchema),
  list_workstream_revisions: project.extend({ workItemId: idSchema }).merge(workflowPageSchema),
  read_project_revision_snapshot: revision,
  preview_bom_import: revision.extend({ proposal: bomImportInputSchema }).strict(),
  commit_bom_import: revision.extend({ confirmation: bomImportCommitSchema }).strict(),
  read_project_team: project
};
export type MakerToolName = keyof typeof MAKER_TOOL_SCHEMAS;
const descriptions: Record<MakerToolName, string> = {
  read_requirement_sourcing: "Read requirement-bound quotes, explicit selections and package-aware estimates. Search and filter the complete revision before paging. total counts matches; revisionTotal and currency totals cover the full revision. Only required Source gaps count; currencies stay separate and unknown shipping/tax remain explicit.",
  record_requirement_offer: "Record an immutable supplier observation against a requirement without creating owned stock. Canonical units are each, gram, metre, millimetre, millilitre or set. No URL is fetched, purchase made or compatibility inferred.",
  choose_requirement_offer: "Explicitly review a quote against the current requirement before selecting it for estimates. Selection is optimistic-versioned and never authorises purchase.",
  inspect_assembly_sources: "Read static STEP, GLB or STL parts from existing, hash-bound files in this project. Returns node identities, names, groups and suggested explosion offsets in millimetres, without triangle buffers. Iterate limit/cursor pages for all parts; total is the full source part count. STEP uses declared units; GLB/STL use the supplied coordinate unit. No uploads or saves are implicit.",
  read_project_assembly: "Read the saved assembly, source hashes, placements, groups, BOM links, separation offsets and build steps for an exact revision, with stale-source warnings.",
  save_project_assembly: "Save one generic assembly for any fabrication route. Supply the full assembly and observed expectedVersion (0 initially), plus a stable command key. Source/node/BOM ancestry is checked. position/explode are millimetres, rotation XYZ degrees. This changes viewing and guidance only, never CAD, stock or physical validation.",
  read_assembly_history: "Read bounded retained assembly version summaries. No geometry buffers or private file contents are returned.",
  read_build_plan: "Read current multi-plate planning quantities, spool estimates, file hashes and unresolved checks. A plan is not manufacturing evidence.",
  save_build_plan: "Save an optimistic-versioned multi-plate plan. Repeated plate copies multiply parts, material grams and time. Exact project/file/printer ancestry is checked. No inventory, printer or physical status changes.",
  read_build_plan_history: "Read retained build-plan snapshots in bounded version order.",
  list_workstreams: "Read bounded workstreams, current revisions and named assignments.",
  create_workstream: "Atomically create one workstream and initial concept revision. Does not certify, reserve or operate equipment.",
  update_work_assignment: "Update a workstream status, due date, notes and optional enabled assignee using its observed version. Work status is separate from manufacturing validation.",
  list_project_revisions: "Read bounded historical planning revisions for one project.",
  list_workstream_revisions: "Read bounded historical revisions for one workstream.",
  read_project_revision_snapshot: "Read the requirements and files of an exact historical project revision without changing the active revision.",
  preview_bom_import: "Preview an append-only batch of 1–24 requirements for the current revision. Duplicate names need explicit permission. Preview stores only actor-owned metadata; no stock or BOM changes.",
  commit_bom_import: "Commit the exact actor-owned, unexpired BOM preview atomically with a stable command key. A stale revision, requirement or selected-stock basis requires re-preview. No stock is created or reserved.",
  read_project_team: "Read the safe name/ID/role directory for enabled members with access to the selected project. Never returns credentials."
};
const writes = new Set<MakerToolName>(["save_project_assembly", "record_requirement_offer", "choose_requirement_offer", "save_build_plan", "create_workstream", "update_work_assignment", "preview_bom_import", "commit_bom_import"]);
export const MAKER_TOOL_DEFINITIONS: readonly McpToolDefinition[] = Object.entries(MAKER_TOOL_SCHEMAS).map(([key, schema]) => {
  const name = key as MakerToolName, mutating = writes.has(name), family = name.includes("offer") || name.includes("sourcing") ? "offers" : name.includes("bom_import") ? "bom" : "projects";
  return { name, description: descriptions[name], requiredScope: `${family}:${mutating ? "write" : "read"}` as McpToolDefinition["requiredScope"], mutating, inputSchema: commandJsonSchema(schema) as JsonObject };
});
export function parseMakerTool(name: MakerToolName, raw: unknown): Record<string, unknown> { const parsed = MAKER_TOOL_SCHEMAS[name].safeParse(raw); if (!parsed.success) throw new McpAdapterError("INVALID_ARGUMENT", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return parsed.data; }
export async function invokeMakerTool(service: ApplicationService, name: MakerToolName, input: Record<string, unknown>, context: McpRequestContext) {
  const projectId = input.projectId as string, revisionId = input.projectRevisionId as string;
  const ctx = { actor: context.actorId, source: "mcp" as const, correlationId: context.correlationId ?? "maker-workflow", scopes: new Set(context.scopes), ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }) };
  const page = { ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) };
  try {
    switch (name) {
      case "read_requirement_sourcing": return await service.makerWorkflows.sourcing(projectId, revisionId, { ...page, ...(input.query === undefined ? {} : { query: input.query }), ...(input.filter === undefined ? {} : { filter: input.filter }) });
      case "record_requirement_offer": return await service.makerWorkflows.recordOffer(projectId, revisionId, input.offer, ctx);
      case "choose_requirement_offer": return await service.makerWorkflows.chooseOffer(projectId, revisionId, input.choice, ctx);
      case "inspect_assembly_sources": { const { geometry: _geometry, ...result } = await service.assemblies.inspect(projectId, revisionId, input.proposal); const offset = Number(input.cursor ?? 0), limit = Number(input.limit ?? 25); return { ...result, parts: result.parts.slice(offset, offset + limit), total: result.parts.length, limit, ...(offset + limit < result.parts.length ? { nextCursor: String(offset + limit) } : {}) }; }
      case "read_project_assembly": return await service.assemblies.read(projectId, revisionId);
      case "save_project_assembly": return await service.assemblies.save(projectId, revisionId, input.assembly, ctx);
      case "read_assembly_history": return await service.assemblies.history(projectId, revisionId, page);
      case "read_build_plan": return { plan: await service.makerWorkflows.buildPlan(projectId, revisionId) };
      case "save_build_plan": return await service.makerWorkflows.saveBuildPlan(projectId, revisionId, input.plan, ctx);
      case "read_build_plan_history": return await service.makerWorkflows.buildPlanHistory(projectId, revisionId, page);
      case "list_workstreams": return await service.makerWorkflows.workstreams(projectId, page);
      case "create_workstream": return await service.makerWorkflows.createWorkstream(projectId, input.workstream, ctx);
      case "update_work_assignment": return await service.makerWorkflows.assignWork(projectId, input.workItemId as string, input.assignment, ctx);
      case "list_project_revisions": return await service.makerWorkflows.revisions(projectId, undefined, page);
      case "list_workstream_revisions": return await service.makerWorkflows.revisions(projectId, input.workItemId as string, page);
      case "read_project_revision_snapshot": return await service.makerWorkflows.revisionSnapshot(projectId, revisionId);
      case "preview_bom_import": return await service.makerWorkflows.previewImport(projectId, revisionId, input.proposal, ctx);
      case "commit_bom_import": return await service.makerWorkflows.commitImport(projectId, revisionId, input.confirmation, ctx);
      case "read_project_team": await service.getProject(projectId); return await service.team.directory([projectId]);
    }
  } catch (error) { if (context.projectIds !== undefined && error instanceof ApplicationError && ["not_found", "forbidden"].includes(error.code)) throw new McpAdapterError("FORBIDDEN", "The project reference is not available to this token."); throw error; }
}
