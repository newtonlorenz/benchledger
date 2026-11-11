import { ApplicationError, conflict, notFound } from "../errors.js";
import type { GapEvaluation, Mutation, RequestContext } from "../ports.js";
import { bomRequirementRequestsPrinter, canonicalizeBomLineWrite, legacyCreateBomLineSchema, legacyUpdateBomLineSchema } from "./bom-rules.js";
import type { LegacyBomLineInput } from "./bom-rules.js";
import { evaluateBomGapsFromData } from "./gap-evaluation.js";
import { isRecord, listAllInventory, requireId } from "./shared.js";
import { changesReservedRequirement } from "@benchledger/api-contract";
import type { BomLine, CreateBomLine, UpdateBomLine } from "@benchledger/api-contract";
import { ServiceModule } from "./module.js";

/** BOM requirement lines and the live gap evaluation of a revision. */
export class BomModule extends ServiceModule {
  async listBomLines(revisionId: string, options?: { readonly includeRetired?: boolean }): Promise<readonly BomLine[]> {
    const parsedRevisionId = requireId(revisionId, "revision id");
    await this.assertProjectReadableFromRevision(parsedRevisionId);
    return this.ports.unitOfWork.exclusive(() => this.ports.projects.listBomLines(parsedRevisionId, options));
  }

  async getBomLine(id: string): Promise<BomLine> {
    return this.ports.unitOfWork.exclusive(async () => {
      const line = await this.ports.projects.getBomLine(requireId(id, "BOM line id"));
      if (!line) throw notFound("BOM line", id);
      await this.assertProjectReadableFromRevision(line.revisionId);
      return line;
    });
  }

  /** Internal shared validation for single writes and atomic reviewed imports. No mutation or event occurs here. */

  async prepareBomLine(revisionId: string, input: CreateBomLine | LegacyBomLineInput): Promise<CreateBomLine> {
    const parsed = canonicalizeBomLineWrite(legacyCreateBomLineSchema.parse(input) as CreateBomLine);
    await this.assertProjectActiveFromRevision(requireId(revisionId, "revision id"));
    if (bomRequirementRequestsPrinter(parsed)) throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
    for (const itemId of [parsed.itemId, ...parsed.alternatives.map((alternative) => alternative.itemId)].filter((value): value is string => value !== undefined)) {
      const item = await this.ports.inventory.getItem(itemId);
      if (item?.kind === "printer") throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
    }
    return parsed;
  }

  async createBomLine(revisionId: string, input: CreateBomLine | LegacyBomLineInput, ctx: RequestContext): Promise<Mutation<BomLine>> {
    const initial = canonicalizeBomLineWrite(legacyCreateBomLineSchema.parse(input) as CreateBomLine);
    const parentId = requireId(revisionId, "revision id");
    return this.mutate(ctx, "project.bom_line.create", "bom_line", initial.id ?? "pending", async () => {
      const parsed = await this.prepareBomLine(parentId, initial);
      const line = await this.ports.projects.createBomLine(parentId, parsed, ctx);
      return { value: line, entityId: line.id, version: line.version };
    });
  }

  async updateBomLine(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<BomLine>> {
    const lineId = requireId(id, "BOM line id");
    const parsed = legacyUpdateBomLineSchema.parse(input) as UpdateBomLine;
    return this.mutate(ctx, "project.bom_line.update", "bom_line", lineId, async () => {
      const existing = await this.ports.projects.getBomLine(lineId);
      if (existing === null) throw notFound("BOM line", lineId);
      await this.assertProjectActiveFromRevision(existing.revisionId);
      if (changesReservedRequirement(existing, parsed)) {
        const hasActiveReservation = (await this.ports.projects.listReservations(existing.revisionId))
          .some((reservation) => reservation.lineId === lineId && reservation.status === "active");
        if (hasActiveReservation) throw conflict("Release or reconcile active reservations before changing this requirement’s stock, quantity, unit or use", { lineId });
      }
      const merged = canonicalizeBomLineWrite({
        ...existing,
        ...parsed,
        name: parsed.name ?? existing.name,
        itemId: parsed.itemId === null ? undefined : parsed.itemId ?? existing.itemId,
        constraints: parsed.constraints ?? existing.constraints,
        alternatives: parsed.alternatives ?? existing.alternatives,
      });
      if (bomRequirementRequestsPrinter(merged)) {
        throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
      }
      for (const itemId of [merged.itemId, ...merged.alternatives.map((alternative) => alternative.itemId)].filter((value): value is string => value !== undefined)) {
        const item = await this.ports.inventory.getItem(itemId);
        if (item?.kind === "printer") {
          throw new ApplicationError("validation", "Printers are selected through build configuration, not BOM requirements");
        }
      }
      const canonicalConstraints = isRecord(merged.constraints) ? { constraints: merged.constraints } : {};
      const line = await this.ports.projects.updateBomLine(lineId, { ...parsed, ...canonicalConstraints }, expectedVersion, ctx);
      return { value: line, entityId: line.id, version: line.version };
    });
  }

  async retireBomLine(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<BomLine>> {
    const lineId = requireId(id, "BOM line id");
    return this.mutate(ctx, "project.bom_line.retire", "bom_line", lineId, async () => {
      const existing = await this.ports.projects.getBomLine(lineId);
      if (existing === null) throw notFound("BOM line", lineId);
      await this.assertProjectActiveFromRevision(existing.revisionId);
      const line = await this.ports.projects.retireBomLine(lineId, expectedVersion, ctx);
      return { value: line, entityId: line.id, version: line.version };
    });
  }

  async restoreBomLine(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<BomLine>> {
    const lineId = requireId(id, "BOM line id");
    return this.mutate(ctx, "project.bom_line.restore", "bom_line", lineId, async () => {
      const existing = await this.ports.projects.getBomLine(lineId);
      if (existing === null) throw notFound("BOM line", lineId);
      await this.assertProjectActiveFromRevision(existing.revisionId);
      const line = await this.ports.projects.restoreBomLine(lineId, expectedVersion, ctx);
      return { value: line, entityId: line.id, version: line.version };
    });
  }

  async evaluateBomGaps(revisionId: string): Promise<GapEvaluation> {
    return this.ports.unitOfWork.exclusive(async () => {
      const id = requireId(revisionId, "revision id");
      await this.assertProjectReadableFromRevision(id);
      const lines = await this.ports.projects.listBomLines(id);
      const inventory = await listAllInventory(this.ports.inventory);
      const reservations = await this.ports.projects.listReservations(id);
      return evaluateBomGapsFromData(id, lines, inventory, reservations, await this.stockReceivingPolicy());
    });
  }

  /** Derived review queue for canonical Check/inspect candidates. */
}
