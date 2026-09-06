import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { idSchema, workflowPageSchema, createRequirementOfferSchema, requirementOfferSchema, chooseRequirementOfferSchema, offerChoiceSchema, buildPlanInputSchema, createWorkstreamSchema, workAssignmentInputSchema, bomImportInputSchema, bomImportCommitSchema, createBomLineSchema } from "@benchledger/api-contract";
import type { WorkflowKind, WorkflowRecord, RequirementOffer, OfferChoice, RequirementOfferEstimate, BuildPlan, BuildPlanInput, WorkAssignment, BomImportPreview, BomLine, ProjectRevision } from "@benchledger/api-contract";
import { ApplicationError } from "./errors.js";
import type { ApplicationPorts, RequestContext, Mutation, AuditEvent } from "./ports.js";
import type { ApplicationService } from "./service.js";

export interface AuditedWorkflowWriter { <T>(ctx: RequestContext, action: string, entityType: string, id: string, operation: () => Promise<{ value: T; entityId: string; version?: number; withAudit?: (audit: AuditEvent) => T }>): Promise<Mutation<T>> }
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const now = () => new Date().toISOString();
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("validation", result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return result.data; }
function checkedId(value: string) { return parse(idSchema, value); }
function command(ctx: RequestContext, action: string, data: unknown): RequestContext { if (!ctx.idempotencyKey || ctx.idempotencyKey.length < 8 || ctx.idempotencyKey.length > 200) throw new ApplicationError("validation", "Use one stable 8–200 character Idempotency-Key for this command and unchanged retries."); return { ...ctx, fingerprint: hash({ action, data }) }; }
export class MakerWorkflowService {
  constructor(private readonly ports: ApplicationPorts, private readonly app: ApplicationService, private readonly audited: AuditedWorkflowWriter) {}
  supports(): boolean { return this.ports.makerWorkflows !== undefined; }
  private store() { if (!this.ports.makerWorkflows) throw new ApplicationError("forbidden", "This workspace does not support maker workflows yet."); return this.ports.makerWorkflows; }
  private async revision(projectId: string, revisionId: string, write = false): Promise<ProjectRevision> {
    const project = await this.app.getProject(checkedId(projectId)); const revision = await this.app.getProjectRevision(checkedId(revisionId));
    if (revision.projectId !== project.id) throw new ApplicationError("forbidden", "The revision is not part of the selected project.");
    if (write && project.status === "archived") throw new ApplicationError("conflict", "Restore this project before changing its plan.");
    return revision;
  }
  private async line(projectId: string, revisionId: string, lineId: string, write = false) { await this.revision(projectId, revisionId, write); const line = await this.app.getBomLine(checkedId(lineId)); if (line.revisionId !== revisionId || line.retiredAt) throw new ApplicationError("forbidden", "The requirement is not active in the selected revision."); return line; }
  private async put(kind: WorkflowKind, id: string, projectId: string, revisionId: string | undefined, payload: object, expectedVersion: number) {
    const previous = await this.store().get(kind, id), timestamp = now();
    const record: WorkflowRecord = { kind, id, projectId, ...(revisionId ? { revisionId } : {}), payload: { ...payload }, version: expectedVersion + 1, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp };
    return this.store().put(record, expectedVersion);
  }
  private async all(kind: WorkflowKind, projectId: string, revisionId?: string) {
    const rows: WorkflowRecord[] = []; let cursor: string | undefined;
    do { const page = await this.store().list(kind, projectId, { ...(revisionId ? { revisionId } : {}), limit: 100, ...(cursor ? { cursor } : {}) }); rows.push(...page.data); cursor = page.nextCursor; if (rows.length > 10_000) throw new ApplicationError("quota_exceeded", "This revision has too many records for an aggregate. Use bounded history pages."); } while (cursor);
    return rows;
  }
  async recordOffer(projectId: string, revisionId: string, input: unknown, ctx: RequestContext) {
    const body = parse(createRequirementOfferSchema, input), action = "requirement.offer.record";
    return this.audited(command(ctx, action, { projectId, revisionId, body }), action, "project", projectId, async () => {
      const line = await this.line(projectId, revisionId, body.bomLineId, true);
      if (line.version !== body.expectedBomLineVersion) throw new ApplicationError("conflict", "The requirement changed. Refresh it before recording a quote.");
      if (Date.parse(body.observedAt) > Date.now() + 60_000) throw new ApplicationError("validation", "A supplier observation cannot be in the future.");
      const { expectedBomLineVersion, ...fields } = body;
      const value: RequirementOffer = { ...fields, id: `quote-${randomUUID()}`, projectId, projectRevisionId: revisionId, bomLineVersion: expectedBomLineVersion, createdAt: now(), recordedBy: ctx.actor, version: 1 };
      await this.put("requirement_offer", value.id, projectId, revisionId, value, 0);
      return { value, entityId: projectId, version: 1 };
    });
  }
  async chooseOffer(projectId: string, revisionId: string, input: unknown, ctx: RequestContext) {
    const body = parse(chooseRequirementOfferSchema, input), action = "requirement.offer.choose";
    return this.audited(command(ctx, action, { projectId, revisionId, body }), action, "project", projectId, async () => {
      const line = await this.line(projectId, revisionId, body.bomLineId, true);
      if (line.version !== body.expectedBomLineVersion) throw new ApplicationError("conflict", "The requirement changed. Review the quote against its current specification.");
      if (body.offerId) {
        if (!body.confirmedFit) throw new ApplicationError("validation", "Explicitly confirm that the quote matches the requirement before using it in an estimate.");
        const record = await this.store().get("requirement_offer", body.offerId);
        if (!record || record.projectId !== projectId || record.revisionId !== revisionId || record.payload.bomLineId !== line.id) throw new ApplicationError("forbidden", "The quote is not for this requirement.");
      }
      const value: OfferChoice = { id: line.id, projectId, projectRevisionId: revisionId, bomLineId: line.id, offerId: body.offerId, bomLineVersion: line.version, version: body.expectedVersion + 1, confirmedBy: ctx.actor, updatedAt: now() };
      await this.put("offer_choice", line.id, projectId, revisionId, value, body.expectedVersion);
      return { value, entityId: projectId, version: value.version };
    });
  }
  async sourcing(projectId: string, revisionId: string, options: unknown = {}) {
    const page = parse(workflowPageSchema, options);
    return this.ports.unitOfWork.exclusive(async () => {
      await this.revision(projectId, revisionId);
      const lines = await this.app.listBomLines(revisionId), gaps = await this.app.evaluateBomGaps(revisionId);
      const quotes = (await this.all("requirement_offer", projectId, revisionId)).map((record) => requirementOfferSchema.parse(record.payload));
      const choices = (await this.all("offer_choice", projectId, revisionId)).map((record) => offerChoiceSchema.parse(record.payload));
      const rows = lines.map((line) => {
        const choice = choices.find((entry) => entry.bomLineId === line.id), offers = quotes.filter((entry) => entry.bomLineId === line.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
        const gap = gaps.lines.find((entry) => entry.lineId === line.id), selected = offers.find((entry) => entry.id === choice?.offerId);
        const estimate = estimateRequirementOffer(line, gap?.decision, gap?.missingQuantity ?? 0, selected, choice);
        return { line, decision: gap?.decision ?? "decide", missingQuantity: gap?.missingQuantity ?? 0, offers, choice: choice ?? null, estimate };
      });
      const totals: Record<string, { knownMinor: number; shippingComplete: boolean; taxesComplete: boolean }> = {};
      for (const row of rows) if (row.estimate.status === "estimated" && row.estimate.currency) { const value = totals[row.estimate.currency] ?? { knownMinor: 0, shippingComplete: true, taxesComplete: true }; value.knownMinor += row.estimate.totalMinor ?? 0; value.shippingComplete &&= row.estimate.shippingKnown; value.taxesComplete &&= row.estimate.taxIncluded === "yes"; if (!Number.isSafeInteger(value.knownMinor)) throw new ApplicationError("validation", "The estimate exceeds safe integer limits."); totals[row.estimate.currency] = value; }
      const offset = Number(page.cursor ?? 0); return { data: rows.slice(offset, offset + page.limit), limit: page.limit, total: rows.length, ...(offset + page.limit < rows.length ? { nextCursor: String(offset + page.limit) } : {}), totals, notice: "Recorded supplier observations, not live prices or purchase authority. Shipping is estimated separately per quote; currencies are never combined." };
    });
  }
  async saveBuildPlan(projectId: string, revisionId: string, input: unknown, ctx: RequestContext) {
    const body = parse(buildPlanInputSchema, input), action = "project.build_plan.save";
    return this.audited(command(ctx, action, { projectId, revisionId, body }), action, "project", projectId, async () => {
      const revision = await this.revision(projectId, revisionId, true), warnings: string[] = [], artifactBasis: BuildPlan["artifactBasis"] = [];
      if (revision.fabricationRoute !== "printed" && body.plates.length) throw new ApplicationError("validation", "Choose a printed build approach before assigning print plates. Non-printed work belongs in workstreams.");
      for (const part of body.parts) {
        if (part.workItemId) { const work = await this.app.getWorkItem(part.workItemId); if (work.projectId !== projectId) throw new ApplicationError("forbidden", "A part refers to a workstream in another project."); }
        if (part.workItemRevisionId) { const workRevision = await this.app.getWorkItemRevision(part.workItemRevisionId); if (!part.workItemId || workRevision.workItemId !== part.workItemId || workRevision.projectId !== projectId) throw new ApplicationError("validation", "Select the exact workstream for its revision."); }
        if (part.artifactId) {
          const file = await this.app.getArtifact(part.artifactId);
          if (file.projectId !== projectId || file.retired || (file.workItemId ? file.workItemId !== part.workItemId || file.revisionId !== part.workItemRevisionId : file.revisionId !== revisionId)) throw new ApplicationError("forbidden", "The part file must belong to this exact project or workstream revision and must not be retired.");
          artifactBasis.push({ id: file.id, sha256: file.sha256, ...(file.revisionId ? { revisionId: file.revisionId } : {}) });
        } else warnings.push(`${part.name}: no versioned build file is attached.`);
      }
      const materials = new Map<string, number>(); let minutes = 0, timeComplete = true;
      for (const plate of body.plates) {
        if (plate.printerItemId) { const item = await this.app.getInventoryItem(plate.printerItemId); if (item.kind !== "printer") throw new ApplicationError("validation", "A plate printer must be an owned printer record."); if (!["physically_counted", "commissioned"].includes(item.evidence.state)) warnings.push(`${plate.name}: printer needs commissioning or a physical check.`); }
        else warnings.push(`${plate.name}: choose a printer before slicing.`);
        if (plate.buildConfigurationId) { const configuration = await this.app.getBuildConfiguration(plate.buildConfigurationId); if (configuration.projectRevisionId !== revisionId || plate.printerItemId !== configuration.printerItemSnapshot.itemId) throw new ApplicationError("validation", "A plate configuration must match this revision and its selected printer."); }
        for (const material of plate.materials) { const item = await this.app.getInventoryItem(material.itemId); if (item.kind !== "filament" || item.unit !== "gram") throw new ApplicationError("validation", "Plate materials must be filament stock recorded in grams."); const grams = (materials.get(item.id) ?? 0) + material.grams * plate.copies; if (!Number.isFinite(grams) || grams > 1e12) throw new ApplicationError("validation", "The planned material quantity is too large."); materials.set(item.id, grams); if (!["physically_counted", "commissioned"].includes(item.evidence.state)) warnings.push(`${plate.name}: ${item.name} needs a physical stock check.`); }
        if (!plate.materials.length) warnings.push(`${plate.name}: material estimates are not recorded.`);
        if (plate.minutes === undefined) timeComplete = false; else minutes += plate.minutes * plate.copies;
      }
      for (const [itemId, grams] of materials) { const item = await this.app.getInventoryItem(itemId); if (item.availableQuantity < grams) warnings.push(`${item.name}: planned ${grams} g exceeds currently available ${item.availableQuantity} g. No stock is reserved by this plan.`); }
      const partTotals = body.parts.map((part) => { const planned = body.plates.reduce((total, plate) => total + (plate.parts.find((entry) => entry.partId === part.id)?.quantity ?? 0) * plate.copies, 0); return { id: part.id, required: part.quantity, planned, missing: Math.max(0, part.quantity - planned), excess: Math.max(0, planned - part.quantity) }; });
      if (partTotals.some((part) => !Number.isSafeInteger(part.planned) || part.planned > 1e12)) throw new ApplicationError("validation", "Planned quantities exceed the supported limit.");
      warnings.push("Planning only: dimensions, orientation, supports, machine settings and slicing still require validation. Saving does not reserve filament, mark a print as completed or operate equipment.");
      const { expectedVersion, ...content } = body; const value: BuildPlan = { ...content, id: revisionId, projectId, projectRevisionId: revisionId, version: expectedVersion + 1, contentSha256: hash({ content, artifactBasis }), createdAt: now(), createdBy: ctx.actor, warnings: [...new Set(warnings)], artifactBasis, totals: { parts: partTotals, materialGrams: [...materials].map(([itemId, grams]) => ({ itemId, grams })), minutes, timeComplete } };
      await this.put("build_plan", revisionId, projectId, revisionId, value, expectedVersion); return { value, entityId: projectId, version: value.version };
    });
  }
  async buildPlan(projectId: string, revisionId: string) { return this.ports.unitOfWork.exclusive(async () => { await this.revision(projectId, revisionId); const record = await this.store().get("build_plan", revisionId); return record ? record.payload as unknown as BuildPlan : null; }); }
  async buildPlanHistory(projectId: string, revisionId: string, options: unknown = {}) { const page = parse(workflowPageSchema, options); return this.ports.unitOfWork.exclusive(async () => { await this.revision(projectId, revisionId); const history = await this.store().history("build_plan", revisionId, page.limit, page.cursor); return { ...history, data: history.data.map((record) => record.payload as unknown as BuildPlan) }; }); }
  async createWorkstream(projectId: string, input: unknown, ctx: RequestContext) {
    const body = parse(createWorkstreamSchema, input), action = "project.workstream.create";
    return this.audited(command(ctx, action, { projectId, body }), action, "project", projectId, async () => {
      const project = await this.app.getProject(checkedId(projectId)); if (project.status === "archived") throw new ApplicationError("conflict", "Restore the project before adding workstreams.");
      const current = await this.app.listWorkItems(projectId); if (current.length >= 1000) throw new ApplicationError("quota_exceeded", "This project has reached 1,000 workstreams.");
      if (current.some((work) => work.name.trim().toLowerCase() === body.name.toLowerCase())) throw new ApplicationError("conflict", "A workstream with that name already exists. Open it instead of creating a duplicate.");
      const item = await this.ports.projects.createWorkItem(projectId, { ...body, id: `work-${randomUUID()}` }, ctx);
      const revision = await this.ports.projects.createWorkItemRevision(item.id, { name: "Initial", status: "concept" }, ctx);
      return { value: { item: { ...item, currentRevisionId: revision.id }, revision }, entityId: projectId, version: item.version };
    });
  }
  async workstreams(projectId: string, options: unknown = {}) {
    const page = parse(workflowPageSchema, options); return this.ports.unitOfWork.exclusive(async () => {
      const works = await this.app.listWorkItems(checkedId(projectId)), offset = Number(page.cursor ?? 0); const assignments = await this.all("work_assignment", projectId);
      const data = await Promise.all(works.slice(offset, offset + page.limit).map(async (item) => ({ item, revision: item.currentRevisionId ? await this.app.getWorkItemRevision(item.currentRevisionId) : null, assignment: (assignments.find((record) => record.id === item.id)?.payload ?? null) as unknown as WorkAssignment | null })));
      return { data, limit: page.limit, total: works.length, ...(offset + page.limit < works.length ? { nextCursor: String(offset + page.limit) } : {}) };
    });
  }
  async assignWork(projectId: string, workItemId: string, input: unknown, ctx: RequestContext) {
    const body = parse(workAssignmentInputSchema, input), action = "project.workstream.assign";
    return this.audited(command(ctx, action, { projectId, workItemId, body }), action, "project", projectId, async () => {
      const project = await this.app.getProject(checkedId(projectId)), work = await this.app.getWorkItem(checkedId(workItemId));
      if (work.projectId !== projectId) throw new ApplicationError("forbidden", "The workstream does not belong to the selected project.");
      if (project.status === "archived") throw new ApplicationError("conflict", "Restore the project before changing workstreams.");
      if (body.assigneeId && !await this.app.team.canAssign(body.assigneeId, projectId)) throw new ApplicationError("validation", "Assign an enabled member who has access to this project.");
      const { expectedVersion, ...content } = body; const value: WorkAssignment = { ...content, id: workItemId, projectId, workItemId, version: expectedVersion + 1, updatedAt: now(), updatedBy: ctx.actor };
      await this.put("work_assignment", workItemId, projectId, undefined, value, expectedVersion); return { value, entityId: projectId, version: value.version };
    });
  }
  async revisions(projectId: string, workItemId?: string, options: unknown = {}) {
    const page = parse(workflowPageSchema, options); return this.ports.unitOfWork.exclusive(async () => {
      await this.app.getProject(checkedId(projectId));
      let rows;
      if (workItemId) { const work = await this.app.getWorkItem(checkedId(workItemId)); if (work.projectId !== projectId) throw new ApplicationError("forbidden", "This workstream belongs to another project."); if (!this.ports.projects.listWorkItemRevisions) throw new ApplicationError("forbidden", "Revision history is unavailable on this runtime."); rows = await this.ports.projects.listWorkItemRevisions(workItemId); }
      else { if (!this.ports.projects.listProjectRevisions) throw new ApplicationError("forbidden", "Revision history is unavailable on this runtime."); rows = await this.ports.projects.listProjectRevisions(projectId); }
      const sorted = [...rows].sort((a,b) => b.number - a.number || a.id.localeCompare(b.id)), offset = Number(page.cursor ?? 0);
      return { data: sorted.slice(offset, offset + page.limit), limit: page.limit, total: sorted.length, ...(offset + page.limit < sorted.length ? { nextCursor: String(offset + page.limit) } : {}) };
    });
  }
  async revisionSnapshot(projectId: string, revisionId: string) { return this.ports.unitOfWork.exclusive(async () => { const revision = await this.revision(projectId, revisionId), lines = await this.app.listBomLines(revisionId), files = await this.app.listArtifacts(projectId, { projectRevisionId: revisionId }); return { revision, lines, files, readOnly: true }; }); }
  private async importBasis(revisionId: string, rows: readonly { itemId?: string | undefined }[]) { const revision = await this.app.getProjectRevision(revisionId), lines = await this.app.listBomLines(revisionId, { includeRetired: true }); const inventory = []; for (const id of [...new Set(rows.map((row) => row.itemId).filter((id): id is string => !!id))]) { const item = await this.app.getInventoryItem(id); if (item.kind === "printer") throw new ApplicationError("validation", "Select printers as workshop capabilities, not BOM requirements."); inventory.push({ id, version: item.version, unit: item.unit }); } return hash({ revision, lines: lines.map((line) => [line.id, line.version, line.retiredAt ?? null]), inventory }); }
  async previewImport(projectId: string, revisionId: string, input: unknown, ctx: RequestContext) {
    const body = parse(bomImportInputSchema, input); return this.ports.unitOfWork.run(async () => {
      await this.revision(projectId, revisionId, true); const project = await this.app.getProject(projectId); if (project.currentRevisionId !== revisionId) throw new ApplicationError("conflict", "Import into the current project revision, not a historical one.");
      const existing = await this.app.listBomLines(revisionId), names = new Set(existing.map((line) => line.name.trim().toLowerCase())), duplicates = new Set<string>();
      for (const row of body.rows) { const name = row.name.trim().toLowerCase(); if (names.has(name)) duplicates.add(row.name); names.add(name); }
      if (duplicates.size && !body.allowDuplicateNames) throw new ApplicationError("conflict", `Duplicate requirement names need explicit review: ${[...duplicates].join(", ")}`);
      const rows = body.rows.map((row) => ({ ...row, id: `bom-${randomUUID()}` })), basis = await this.importBasis(revisionId, rows), id = `import-${randomUUID()}`;
      const value: BomImportPreview = { id, projectId, projectRevisionId: revisionId, version: 1, actor: ctx.actor, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), basis, rows, contentSha256: hash({ rows, basis }), status: "active", warnings: duplicates.size ? [`Duplicate names were explicitly allowed: ${[...duplicates].join(", ")}`] : [] };
      await this.put("bom_import_preview", id, projectId, revisionId, value, 0); return value;
    });
  }
  async commitImport(projectId: string, revisionId: string, input: unknown, ctx: RequestContext) {
    const body = parse(bomImportCommitSchema, input), action = "project.bom.import";
    return this.audited(command(ctx, action, { projectId, revisionId, body }), action, "project", projectId, async () => {
      await this.revision(projectId, revisionId, true); const stored = await this.store().get("bom_import_preview", body.previewId), preview = stored?.payload as unknown as BomImportPreview | undefined;
      if (!stored || !preview || stored.projectId !== projectId || stored.revisionId !== revisionId || preview.actor !== ctx.actor) throw new ApplicationError("forbidden", "This import preview is not available to the current actor and revision.");
      if (preview.status !== "active" || preview.version !== body.expectedPreviewVersion || preview.contentSha256 !== body.contentSha256 || Date.parse(preview.expiresAt) <= Date.now()) throw new ApplicationError("conflict", "The import preview changed or expired. Preview again before committing.");
      const project = await this.app.getProject(projectId); if (project.currentRevisionId !== revisionId || await this.importBasis(revisionId, preview.rows) !== preview.basis) throw new ApplicationError("conflict", "The revision, requirements or selected inventory changed after preview. Review a new preview.");
      const lines: BomLine[] = [];
      for (const row of preview.rows) { const checked = await this.app.prepareBomLine(revisionId, parse(createBomLineSchema, row)); lines.push(await this.ports.projects.createBomLine(revisionId, checked, ctx)); }
      const updated = { ...preview, version: preview.version + 1, status: "committed" as const }; await this.put("bom_import_preview", preview.id, projectId, revisionId, updated, preview.version);
      return { value: { projectId, projectRevisionId: revisionId, lines, previewId: preview.id, notice: "Requirements appended atomically. No inventory or reservations were created." }, entityId: projectId, version: updated.version };
    });
  }
}
export function estimateRequirementOffer(line: Pick<BomLine, "id" | "version" | "optional" | "unit">, decision: string | undefined, missing: number, quote?: RequirementOffer, choice?: OfferChoice, timestamp = Date.now()): RequirementOfferEstimate {
  const review = (reason: string): RequirementOfferEstimate => ({ status: "needs_review", reason, shippingKnown: quote?.shippingMinor !== undefined });
  if (line.optional || decision !== "source" || missing <= 0) return review("Only required Source gaps enter a buying estimate.");
  if (!quote || !choice?.offerId || quote.id !== choice.offerId) return review("Choose a reviewed quote; nothing is selected automatically.");
  if (choice.bomLineVersion !== line.version || quote.bomLineId !== line.id) return review("The requirement changed. Review the selected quote again.");
  if (timestamp > Date.parse(quote.observedAt) + quote.validForDays * 86_400_000) return review("The supplier observation is stale. Record a fresh quote.");
  if (quote.packageUnit !== line.unit) return review("Package and requirement units differ. Record the correct package quantity and unit; no conversion is inferred.");
  const packages = Math.ceil(missing / quote.packageQuantity), priceMinor = packages * quote.priceMinor, totalMinor = priceMinor + (quote.shippingMinor ?? 0);
  if (![packages, priceMinor, totalMinor].every(Number.isSafeInteger)) return review("The estimate exceeds safe integer limits.");
  return { status: "estimated", packages, partsSupplied: packages * quote.packageQuantity, priceMinor, ...(quote.shippingMinor === undefined ? {} : { shippingMinor: quote.shippingMinor }), totalMinor, currency: quote.currency, shippingKnown: quote.shippingMinor !== undefined, taxIncluded: quote.taxIncluded };
}
