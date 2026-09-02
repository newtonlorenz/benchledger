import { createHash } from "node:crypto";
import { createStockEvent, DomainError } from "@benchledger/domain";
import type {
  CreateInventoryItem,
  InspectionEvidence,
  InventoryItem as ApiInventoryItem,
} from "@benchledger/api-contract";
import type {
  InspectionCommitInput,
  InspectionCommitReceipt,
  InspectionPort,
  RequestContext,
  UnitOfWorkPort,
} from "@benchledger/application";
import { BomRepository, InspectionRepository, InventoryRepository } from "@benchledger/database";
import type { BenchDatabase } from "@benchledger/database";
import { RuntimeConflict, RuntimeState } from "./persistence.js";
import {
  apiBomLineFromNative, apiInventoryFromNative,
  nativeItemFromApi,
  mapApiUnitToDomain,
} from "./mappers.js";
import { bomMetadata } from "./project-adapter.js";
import { attempt, clone, nowIso } from "./utils.js";

const INVENTORY_ITEM = "inventory_item";
const BOM_LINE = "bom_line";

function actorForContext(ctx: RequestContext): { readonly type: "human" | "agent" | "system" | "import"; readonly id: string } {
  return { type: ctx.source === "mcp" ? "agent" : ctx.source === "import" ? "import" : ctx.source === "system" ? "system" : "human", id: ctx.actor };
}

function evidenceId(input: InspectionCommitInput, ctx: RequestContext): string {
  return `inspection-${createHash("sha256").update(`${input.preview.id}\u0000${ctx.idempotencyKey ?? ctx.correlationId}`).digest("hex").slice(0, 40)}`;
}

/** Durable adapter for append-only inspection evidence and physical counts. */
export class ProductionInspectionAdapter implements InspectionPort {
  constructor(
    private readonly database: BenchDatabase,
    private readonly repository: InspectionRepository,
    private readonly inventoryRepository: InventoryRepository,
    private readonly bomRepository: BomRepository,
    private readonly state: RuntimeState,
    private readonly unitOfWork: Pick<UnitOfWorkPort, "transactional">,
  ) {}

  async savePreview(preview: import("@benchledger/api-contract").InspectionCompletionPreview): Promise<import("@benchledger/api-contract").InspectionCompletionPreview> {
    // The application service already holds its read barrier while deriving
    // the actor-bound preview. A single INSERT is atomic and must not try to
    // acquire a nested unit-of-work transaction under that barrier.
    return clone(this.repository.savePreview(preview));
  }

  async getPreview(id: string, actor: string): Promise<import("@benchledger/api-contract").InspectionCompletionPreview | null> {
    return clone(this.repository.getPreview(id, actor) ?? null);
  }

  async commit(input: InspectionCommitInput, ctx: RequestContext): Promise<InspectionCommitReceipt> {
    return this.unitOfWork.transactional(() => attempt(() => this.commitWithinTransaction(input, ctx)));
  }

  private commitWithinTransaction(input: InspectionCommitInput, ctx: RequestContext): InspectionCommitReceipt {
    const item = this.inventoryRepository.get(input.action.itemId);
    if (item === undefined || item.retiredAt !== undefined) throw new DomainError("inventory_not_found", `inventory item ${input.action.itemId} does not exist`);
    const actualItemVersion = this.state.getVersion(INVENTORY_ITEM, item.id);
    if (actualItemVersion !== input.basis.itemVersion) throw new RuntimeConflict("Inspection inventory basis changed", { expectedVersion: input.basis.itemVersion, actualVersion: actualItemVersion });
    for (const reference of input.basis.lineVersions) {
      const actual = this.state.getVersion(BOM_LINE, reference.lineId);
      if (actual !== reference.version) throw new RuntimeConflict("Inspection BOM basis changed", { lineId: reference.lineId, expectedVersion: reference.version, actualVersion: actual });
    }
    const currentApi = this.toApi(item, actualItemVersion);
    const recordedAt = input.committedAt;
    const id = evidenceId(input, ctx);
    const evidence: InspectionEvidence = {
      id,
      projectRevisionId: input.projectRevisionId,
      actionId: input.action.id,
      itemId: item.id,
      kind: input.action.kind,
      result: input.observation.result,
      source: input.observation.source,
      ...(input.observation.sourceId === undefined ? {} : { sourceId: input.observation.sourceId }),
      observedAt: input.observation.observedAt,
      recordedAt,
      ...(input.observation.note === undefined ? {} : { note: input.observation.note }),
      ...(input.observation.quantity === undefined ? {} : { quantity: input.observation.quantity }),
      ...(input.observation.unit === undefined ? {} : { unit: input.observation.unit }),
      ...(input.observation.conversion === undefined ? {} : { conversion: input.observation.conversion })
    };
    return this.database.transaction(() => {
      const existing = this.repository.listEvidence(input.projectRevisionId).find((candidate) => candidate.id === id);
      if (existing !== undefined) return { id, evidence: existing, ...(input.action.kind === "physical_quantity" ? { item: currentApi } : {}) };

      this.applyBomLineChanges(input);
      let updatedApi: ApiInventoryItem | undefined;
      if (input.action.kind === "physical_quantity" && input.observation.result === "confirmed") {
        const quantity = input.observation.quantity;
        if (quantity === undefined || input.observation.unit !== currentApi.unit) throw new DomainError("invalid_unit", "physical inspection quantity does not match the inventory unit");
        const balance = this.inventoryRepository.balance(item.id);
        if (quantity < balance.allocated) throw new DomainError("over_allocation", "physical count cannot be below allocated quantity");
        const nextNative = nativeItemFromApi(this.createCountInput(currentApi, quantity, input.observation), item.id, recordedAt, item);
        this.inventoryRepository.upsert(nextNative);
        const nextVersion = actualItemVersion + 1;
        const event = createStockEvent({
          id: `${id}-count`,
          itemId: item.id,
          kind: "count",
          quantity,
          unit: mapApiUnitToDomain(currentApi.unit),
          reason: input.observation.note ?? "Inspection physical quantity",
          actor: actorForContext(ctx),
          source: ctx.source,
          evidence: { inspectionEvidenceId: id, previousEvidence: currentApi.evidence, state: "physically_counted" },
          correlationId: ctx.correlationId,
          idempotencyKey: `${id}-count`,
          occurredAt: recordedAt,
          createdAt: recordedAt
        });
        const appended = this.inventoryRepository.appendStockEvent(event);
        if (appended.inserted) this.state.setVersion(INVENTORY_ITEM, item.id, nextVersion);
        const resultingNative = this.inventoryRepository.get(item.id);
        if (resultingNative === undefined) throw new DomainError("inventory_not_found", `inventory item ${item.id} does not exist`);
        updatedApi = this.toApi(resultingNative, this.state.getVersion(INVENTORY_ITEM, item.id));
      }
      const appendedEvidence = this.repository.appendEvidence(evidence);
      return { id, evidence: appendedEvidence, ...(updatedApi === undefined ? {} : { item: updatedApi }) };
    });
  }

  private applyBomLineChanges(input: InspectionCommitInput): void {
    if (input.observation.result !== "confirmed" || input.action.kind === "physical_quantity") return;
    const beforeLines = input.preview.before.lines;
    const afterLines = input.preview.after.lines;
    if (beforeLines.length !== afterLines.length || beforeLines.length !== input.action.lineIds.length) {
      throw new DomainError("invalid_bom_line", "inspection preview line changes are incomplete");
    }
    for (const before of beforeLines) {
      const current = this.bomRepository.getLine(before.id);
      if (current === undefined || current.retiredAt !== undefined) throw new DomainError("bom_line_not_found", `BOM line ${before.id} does not exist`);
      const currentApi = this.toApiBom(current);
      if (JSON.stringify(currentApi) !== JSON.stringify(before)) throw new RuntimeConflict("Inspection BOM basis changed", { lineId: before.id, expectedVersion: before.version, actualVersion: this.state.getVersion(BOM_LINE, before.id) });
      const after = afterLines.find((candidate) => candidate.id === before.id);
      if (after === undefined || after.version !== before.version + 1) throw new DomainError("invalid_bom_line", "inspection preview line version is invalid");
      const metadata = this.state.getMetadata(BOM_LINE, before.id);
      this.database.run("UPDATE bom_lines SET alternative_item_ids_json = ? WHERE id = ?", [JSON.stringify(after.alternatives.map((alternative) => alternative.itemId)), before.id]);
      this.state.bumpVersion(BOM_LINE, before.id);
      this.state.setMetadata(BOM_LINE, before.id, { ...metadata, alternatives: after.alternatives, updatedAt: after.updatedAt });
    }
  }

  private toApiBom(line: import("@benchledger/domain").BomLine): import("@benchledger/api-contract").BomLine {
    return apiBomLineFromNative(line, bomMetadata(this.state.getMetadata(BOM_LINE, line.id)), this.state.getVersion(BOM_LINE, line.id));
  }

  private createCountInput(current: ApiInventoryItem, quantity: number, observation: InspectionCommitInput["observation"]): CreateInventoryItem {
    return {
      id: current.id,
      name: current.name,
      kind: current.kind,
      ...(current.categoryNodeId === undefined ? {} : { categoryNodeId: current.categoryNodeId }),
      ...(current.description === undefined ? {} : { description: current.description }),
      ...(current.manufacturer === undefined ? {} : { manufacturer: current.manufacturer }),
      ...(current.model === undefined ? {} : { model: current.model }),
      ...(current.sku === undefined ? {} : { sku: current.sku }),
      quantity,
      unit: current.unit,
      ...(current.location === undefined ? {} : { location: current.location }),
      ...(current.condition === undefined ? {} : { condition: current.condition }),
      ...(current.dimensions === undefined ? {} : { dimensions: current.dimensions }),
      tags: current.tags,
      links: current.links,
      evidence: { state: "physically_counted", source: observation.source, ...(observation.sourceId === undefined ? {} : { sourceId: observation.sourceId }), observedAt: observation.observedAt, ...(observation.note === undefined ? {} : { note: observation.note }) }
    };
  }

  private toApi(item: import("@benchledger/domain").InventoryItem, version: number): ApiInventoryItem {
    const balance = this.inventoryRepository.balance(item.id);
    return clone(apiInventoryFromNative(item, balance, version));
  }
}
