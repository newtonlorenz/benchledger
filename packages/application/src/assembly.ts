import { createHash } from "node:crypto";
import { assemblyInputSchema, inspectAssemblySchema, workflowPageSchema, idSchema } from "@benchledger/api-contract";
import type { AssemblyGeometry, AssemblyInspection, AssemblyRead, AssemblySource, ProjectAssembly } from "@benchledger/api-contract";
import { suggestAssemblyExplosion } from "@benchledger/domain/assembly";
import type { z } from "zod/v3";
import { ApplicationError } from "./errors.js";
import type { ApplicationPorts, RequestContext } from "./ports.js";
import type { ApplicationService } from "./service.js";
import type { AuditedWorkflowWriter } from "./maker-workflows.js";
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) throw new ApplicationError("validation", result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")); return result.data; }
export class AssemblyService {
  constructor(private readonly ports: ApplicationPorts, private readonly app: ApplicationService, private readonly audited: AuditedWorkflowWriter) {}
  supports() { return Boolean(this.ports.makerWorkflows && this.ports.assemblyImporter); }
  private store() { if (!this.supports()) throw new ApplicationError("forbidden", "Assembly viewing is unavailable on this host."); return this.ports.makerWorkflows!; }
  private async revision(projectId: string, revisionId: string, write = false) {
    this.store(); const project = await this.app.getProject(parse(idSchema, projectId)), revision = await this.app.getProjectRevision(parse(idSchema, revisionId));
    if (revision.projectId !== project.id) throw new ApplicationError("forbidden", "The revision belongs to another project.");
    if (write && project.status === "archived") throw new ApplicationError("conflict", "Restore this project before editing its assembly.");
  }
  private async source(projectId: string, revisionId: string, source: AssemblySource, write = false) {
    const file = await this.app.getArtifact(source.artifactId);
    if (file.projectId !== projectId) throw new ApplicationError("forbidden", "Assembly files must belong to this project.");
    if (file.workItemId) {
      const work = await this.app.getWorkItem(file.workItemId);
      const revision = file.revisionId ? await this.app.getWorkItemRevision(file.revisionId) : null;
      if (work.projectId !== projectId || revision?.workItemId !== work.id || revision.projectId !== projectId) throw new ApplicationError("forbidden", "Select an exact workstream revision file.");
    } else if (file.revisionId !== revisionId) throw new ApplicationError("forbidden", "The file must belong to this exact project revision.");
    if (file.sha256 !== source.sha256) throw new ApplicationError("conflict", "The source hash differs. Inspect the exact file before saving.");
    if (write && file.retired) throw new ApplicationError("conflict", "A source was retired. Choose an active file before saving.");
    if (!/\.(glb|stl|step|stp)$/iu.test(file.filename)) throw new ApplicationError("validation", "Use a STEP, GLB or STL source file.");
    if (file.byteSize > 20 * 1024 * 1024) throw new ApplicationError("quota_exceeded", "Assembly files are limited to 20 MB each.");
    return file;
  }
  async inspect(projectId: string, revisionId: string, input: unknown): Promise<AssemblyInspection> {
    const body = parse(inspectAssemblySchema, input);
    return this.ports.unitOfWork.exclusive(async () => { await this.revision(projectId, revisionId); return this.inspectSources(projectId, revisionId, body.sources); });
  }
  private async inspectSources(projectId: string, revisionId: string, sources: AssemblySource[], write = false): Promise<AssemblyInspection> {
    const geometry: AssemblyGeometry[] = [], warnings = new Set<string>(); let bytes = 0, triangles = 0;
    // Preflight every reference before opening any private file.
    const files = await Promise.all(sources.map(s => this.source(projectId, revisionId, s, write)));
    for (const file of files) { bytes += file.byteSize; if (bytes > 40 * 1024 * 1024) throw new ApplicationError("quota_exceeded", "An assembly is limited to 40 MB of source files."); }
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!, file = files[index]!;
      const download = await this.ports.artifacts.readArtifact(file.id);
      if (createHash("sha256").update(download.body).digest("hex") !== source.sha256) throw new ApplicationError("conflict", "Stored source bytes do not match their hash.");
      let result;
      try { result = await this.ports.assemblyImporter!(download.body, file.filename, source.unit, source.upAxis); }
      catch (error) { throw new ApplicationError("validation", error instanceof Error ? error.message : "Unable to read the assembly source."); }
      for (const mesh of result.meshes) { triangles += mesh.indices.length / 3; geometry.push({ ...mesh, artifactId: file.id }); }
      if (triangles > 250_000 || geometry.length > 300) throw new ApplicationError("quota_exceeded", "An assembly is limited to 300 parts and 250,000 triangles across all files.");
      result.warnings.forEach(w => warnings.add(w));
      if (file.retired) warnings.add(`${file.filename}: this source is retired; the saved view is historical.`);
    }
    const bounds = geometry.map((mesh, i) => {
      const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      mesh.positions.forEach((v, k) => { min[k % 3] = Math.min(min[k % 3]!, v); max[k % 3] = Math.max(max[k % 3]!, v); });
      return { id: `part-${i + 1}`, min, max };
    });
    const explosion = suggestAssemblyExplosion(bounds);
    return { sources, geometry, warnings: [...warnings], parts: geometry.map((mesh, i) => ({ id: bounds[i]!.id, artifactId: mesh.artifactId, nodeId: mesh.nodeId, name: mesh.name, group: mesh.group, color: mesh.color, position: [0, 0, 0], rotation: [0, 0, 0], explode: explosion[bounds[i]!.id]!, material: "", notes: "" })) };
  }
  async save(projectId: string, revisionId: string, input: unknown, ctx: RequestContext) {
    const body = parse(assemblyInputSchema, input), action = "project.assembly.save";
    if (!ctx.idempotencyKey || ctx.idempotencyKey.length < 8 || ctx.idempotencyKey.length > 200) throw new ApplicationError("validation", "Use a stable 8–200 character Idempotency-Key for assembly saves and unchanged retries.");
    return this.audited({ ...ctx, fingerprint: hash({ action, projectId, revisionId, body }) }, action, "project", projectId, async () => {
      await this.revision(projectId, revisionId, true);
      const previous = await this.store().get("assembly", revisionId);
      if ((previous?.version ?? 0) !== body.expectedVersion) throw new ApplicationError("conflict", "The assembly changed. Reload before saving your edits.");
      const imported = await this.inspectSources(projectId, revisionId, body.sources, true);
      for (const part of body.parts) {
        if (!imported.geometry.some(m => m.artifactId === part.artifactId && m.nodeId === part.nodeId)) throw new ApplicationError("validation", "An assembly part is missing from the exact source file. Inspect the source again.");
        if (part.bomLineId) { const line = await this.app.getBomLine(part.bomLineId); if (line.revisionId !== revisionId || line.retiredAt) throw new ApplicationError("forbidden", "A part's requirement must be active in this exact project revision."); }
      }
      // Repeated placements are allowed, but must stay within the rendering budget.
      const triangles = body.parts.reduce((sum, p) => sum + imported.geometry.find(m => m.artifactId === p.artifactId && m.nodeId === p.nodeId)!.indices.length / 3, 0);
      if (triangles > 250_000) throw new ApplicationError("quota_exceeded", "Repeated placements exceed 250,000 triangles.");
      const { expectedVersion, ...content } = body, timestamp = new Date().toISOString();
      const value: ProjectAssembly = { ...content, id: revisionId, projectId, projectRevisionId: revisionId, version: expectedVersion + 1, contentSha256: hash(content), updatedAt: timestamp, updatedBy: ctx.actor };
      await this.store().put({ kind: "assembly", id: revisionId, projectId, revisionId, version: value.version, payload: { ...value }, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp }, expectedVersion);
      return { value, entityId: projectId, version: value.version };
    });
  }
  async read(projectId: string, revisionId: string): Promise<AssemblyRead> {
    return this.ports.unitOfWork.exclusive(async () => {
      await this.revision(projectId, revisionId); const record = await this.store().get("assembly", revisionId), assembly = record ? record.payload as unknown as ProjectAssembly : null, warnings: string[] = [];
      if (assembly) {
        for (const source of assembly.sources) { try { const file = await this.source(projectId, revisionId, source); if (file.retired) warnings.push(`${file.filename}: source retired; historical view.`); } catch { warnings.push("A saved source is unavailable or changed. Reinspect before editing this assembly."); } }
        for (const part of assembly.parts) if (part.bomLineId) { try { const line = await this.app.getBomLine(part.bomLineId); if (line.retiredAt || line.revisionId !== revisionId) warnings.push(`${part.name}: linked requirement is no longer active.`); } catch { warnings.push(`${part.name}: linked requirement is unavailable.`); } }
      }
      return { assembly, warnings };
    });
  }
  async history(projectId: string, revisionId: string, input: unknown = {}) {
    const page = parse(workflowPageSchema, input);
    return this.ports.unitOfWork.exclusive(async () => { await this.revision(projectId, revisionId); const history = await this.store().history("assembly", revisionId, page.limit, page.cursor); return { ...history, data: history.data.map(r => ({ version: r.version, updatedAt: r.updatedAt, name: r.payload.name, contentSha256: r.payload.contentSha256 })) }; });
  }
}
