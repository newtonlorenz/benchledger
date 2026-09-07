import { commandJsonSchema, createRequirementOfferSchema, chooseRequirementOfferSchema, buildPlanInputSchema, workAssignmentInputSchema, createWorkstreamSchema, bomImportInputSchema, bomImportCommitSchema } from "@benchledger/api-contract";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApplicationService, RequestContext } from "@benchledger/application";
import { ApplicationError } from "@benchledger/application";
export interface MakerRouteAccess { check(request: FastifyRequest, write: boolean): void; context(request: FastifyRequest): RequestContext }
export function registerMakerWorkflowRoutes(app: FastifyInstance, service: ApplicationService, access: MakerRouteAccess): void {
  const root = "/api/v1/projects/:projectId", revision = `${root}/revisions/:revisionId`;
  type Params = { projectId: string; revisionId: string; workItemId: string };
  const query = (request: FastifyRequest) => { const value = request.query as { limit?: string; cursor?: string }; return { ...(value.limit === undefined ? {} : { limit: Number(value.limit) }), ...(value.cursor === undefined ? {} : { cursor: value.cursor }) }; };
  const guarded = (write: boolean, action: (request: FastifyRequest, params: Params) => Promise<unknown>) => async (request: FastifyRequest) => {
    access.check(request, write);
    const params = request.params as Params;
    try { return await action(request, params); }
    catch (error) {
      if (request.principal?.projectIds && error instanceof ApplicationError && ["not_found", "forbidden"].includes(error.code)) throw new ApplicationError("forbidden", "This project reference is not available to the current account.");
      throw error;
    }
  };
  app.get(`${root}/revision-history`, guarded(false, (request, p) => service.makerWorkflows.revisions(p.projectId, undefined, query(request))));
  app.get(`${root}/workstreams/:workItemId/revisions`, guarded(false, (request, p) => service.makerWorkflows.revisions(p.projectId, p.workItemId, query(request))));
  app.get(`${revision}/snapshot`, guarded(false, (_request, p) => service.makerWorkflows.revisionSnapshot(p.projectId, p.revisionId)));
  app.get(`${revision}/sourcing`, guarded(false, (request, p) => service.makerWorkflows.sourcing(p.projectId, p.revisionId, { ...query(request), ...((request.query as Record<string, unknown>).query === undefined ? {} : { query: (request.query as Record<string, unknown>).query }), ...((request.query as Record<string, unknown>).filter === undefined ? {} : { filter: (request.query as Record<string, unknown>).filter }) })));
  app.post(`${revision}/requirement-offers`, guarded(true, (request, p) => service.makerWorkflows.recordOffer(p.projectId, p.revisionId, request.body, access.context(request))));
  app.put(`${revision}/offer-choice`, guarded(true, (request, p) => service.makerWorkflows.chooseOffer(p.projectId, p.revisionId, request.body, access.context(request))));
  app.get(`${revision}/build-plan`, guarded(false, (_request, p) => service.makerWorkflows.buildPlan(p.projectId, p.revisionId)));
  app.put(`${revision}/build-plan`, guarded(true, (request, p) => service.makerWorkflows.saveBuildPlan(p.projectId, p.revisionId, request.body, access.context(request))));
  app.get(`${revision}/build-plan/history`, guarded(false, (request, p) => service.makerWorkflows.buildPlanHistory(p.projectId, p.revisionId, query(request))));
  app.get(`${root}/workstreams`, guarded(false, (request, p) => service.makerWorkflows.workstreams(p.projectId, query(request))));
  app.post(`${root}/workstreams`, guarded(true, (request, p) => service.makerWorkflows.createWorkstream(p.projectId, request.body, access.context(request))));
  app.put(`${root}/workstreams/:workItemId/assignment`, guarded(true, (request, p) => service.makerWorkflows.assignWork(p.projectId, p.workItemId, request.body, access.context(request))));
  app.post(`${revision}/bom-import/previews`, guarded(true, (request, p) => service.makerWorkflows.previewImport(p.projectId, p.revisionId, request.body, access.context(request))));
  app.post(`${revision}/bom-import/commit`, guarded(true, (request, p) => service.makerWorkflows.commitImport(p.projectId, p.revisionId, request.body, access.context(request))));
}
export function makerWorkflowOpenApi(): Record<string, unknown> {
  const scope = "/projects/{projectId}", revision = `${scope}/revisions/{revisionId}`;
  const params = (work: boolean, rev: boolean) => ["projectId", ...(rev ? ["revisionId"] : []), ...(work ? ["workItemId"] : [])].map((name) => ({ name, in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 160 } }));
  const method = (summary: string, write: boolean, rev = true, work = false) => ({ summary, description: write ? "Project-scoped write. Strict canonical maker-workflow contract; stable Idempotency-Key is required for writes other than preview. No stock, purchasing or physical execution effects." : "Project-scoped read. Bounded pagination uses limit (1–100) and the returned cursor where applicable.", parameters: [...params(work, rev), ...(write ? [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } }] : [])], responses: { "200": { description: "Typed workflow result or audited mutation" }, "400": { description: "Invalid input" }, "403": { description: "Scope denied" }, "409": { description: "Stale version, preview or conflicting command" } } });
  const body = (schema: Parameters<typeof commandJsonSchema>[0]) => ({ requestBody: { required: true, content: { "application/json": { schema: commandJsonSchema(schema) } } } });
  return {
    [`${revision}/sourcing`]: { get: { ...method("Search requirement quotes across the complete revision before pagination", false), parameters: [...params(false, true), { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } }, { name: "cursor", in: "query", schema: { type: "string", maxLength: 12 } }, { name: "query", in: "query", schema: { type: "string", maxLength: 200 } }, { name: "filter", in: "query", schema: { type: "string", enum: ["all", "source", "review", "optional"], default: "all" } }] } },
    [`${revision}/requirement-offers`]: { post: { ...method("Record an immutable supplier quote without creating inventory", true), ...body(createRequirementOfferSchema) } },
    [`${revision}/offer-choice`]: { put: { ...method("Select a quote only after explicit fit review", true), ...body(chooseRequirementOfferSchema) } },
    [`${revision}/build-plan`]: { get: method("Read the current versioned multi-plate plan", false), put: { ...method("Save a reviewed multi-plate planning snapshot", true), ...body(buildPlanInputSchema) } },
    [`${revision}/build-plan/history`]: { get: method("Read retained build-plan versions", false) },
    [`${scope}/workstreams`]: { get: method("Read workstreams and assignments", false, false), post: { ...method("Create a workstream and its initial revision atomically", true, false), ...body(createWorkstreamSchema) } },
    [`${scope}/workstreams/{workItemId}/assignment`]: { put: { ...method("Assign a workstream with optimistic versioning", true, false, true), ...body(workAssignmentInputSchema) } },
    [`${revision}/bom-import/previews`]: { post: { ...method("Preview an append-only requirements import", true), ...body(bomImportInputSchema) } },
    [`${revision}/bom-import/commit`]: { post: { ...method("Commit an exact actor-owned requirements preview atomically", true), ...body(bomImportCommitSchema) } }
  };
}
