import { ApplicationError, conflict, notFound } from "../errors.js";
import type { Mutation, RequestContext, ReservationDetails, StockMutation, UsageInput } from "../ports.js";
import { assertConsumedBomRequirement, bomSpecification, matchesBomConstraints, unsupportedBomConstraintKeys } from "./bom-rules.js";
import { bomCandidateQuantityConversion, canReserveBomItem } from "./gap-evaluation.js";
import { assertCompatibleInventoryUnit, inStockQuantityLabel, inStockReservationRule, inventoryWithUnitStatus, requireId } from "./shared.js";
import { createReservationSchema } from "@benchledger/api-contract";
import type { CreateReservation, InventoryItem, Reservation } from "@benchledger/api-contract";
import { exceedsReservableQuantity, quantityExceeds, countsAsInStock } from "@benchledger/domain";
import { ServiceModule } from "./module.js";

/** Reservations against stock that counts under the receiving policy, and recorded project usage. */
export class ReservationModule extends ServiceModule {
  async createReservation(revisionId: string, input: CreateReservation, ctx: RequestContext): Promise<Mutation<Reservation>> {
    const parsed = createReservationSchema.parse(input);
    const parentId = requireId(revisionId, "revision id");
    return this.mutate(ctx, "project.reservation.create", "reservation", parsed.id ?? "pending", async () => {
      await this.assertProjectActiveFromRevision(parentId);
      const lines = await this.ports.projects.listBomLines(parentId);
      const line = lines.find((candidate) => candidate.id === parsed.lineId);
      if (line === undefined) throw notFound("BOM line", parsed.lineId);
      assertConsumedBomRequirement(line);
      if (!bomSpecification(line).sufficient) {
        throw new ApplicationError("validation", "Resolve the BOM specification decisions before reserving stock");
      }
      const unsupported = unsupportedBomConstraintKeys(line.constraints);
      if (unsupported.length > 0) {
        throw new ApplicationError("validation", `Unsupported BOM constraint key(s): ${unsupported.join(", ")}`);
      }
      const item = await this.ports.inventory.getItem(parsed.itemId);
      if (item === null) throw notFound("Inventory item", parsed.itemId);
      assertCompatibleInventoryUnit(item, "Cannot reserve stock");
      if (!canReserveBomItem(line, item)) {
        throw new ApplicationError("validation", "Reservation item must be the exact BOM item or an approved alternative");
      }
      const conversion = bomCandidateQuantityConversion(line, item);
      if (item.unit !== line.unit && conversion === undefined) {
        throw new ApplicationError("validation", `Reservation requires a valid one-set conversion from ${item.unit} to ${line.unit}`);
      }
      if (conversion !== undefined && !Number.isSafeInteger(parsed.quantity)) {
        throw new ApplicationError("validation", "Converted reservations must use a whole number of sets");
      }
      if (!matchesBomConstraints(item, line.constraints)) {
        throw new ApplicationError("validation", "Inventory item does not satisfy the BOM constraints");
      }
      const policy = await this.stockReceivingPolicy();
      if (!countsAsInStock(item.evidence.state, policy)) {
        throw new ApplicationError("conflict", inStockReservationRule(policy), { reason: "not_in_stock", evidenceState: item.evidence.state, stockReceivingPolicy: policy });
      }
      const activeReservations = (await this.ports.projects.listReservations(parentId))
        .filter((reservation) => reservation.status === "active" && reservation.lineId === line.id);
      const activeUnits = new Set<InventoryItem["unit"]>([item.unit]);
      let reservedCoverage = 0;
      for (const reservation of activeReservations) {
        const reservedItem = reservation.itemId === item.id ? item : await this.ports.inventory.getItem(reservation.itemId);
        if (reservedItem === null) throw new ApplicationError("integrity_error", `Reservation references missing inventory item '${reservation.itemId}'`);
        assertCompatibleInventoryUnit(reservedItem, "Cannot evaluate existing reservation");
        activeUnits.add(reservedItem.unit);
        if (activeUnits.size > 1) {
          throw new ApplicationError("validation", `BOM line '${line.id}' cannot mix active reservation units`);
        }
        if (reservedItem.unit === line.unit) {
          reservedCoverage += reservation.quantity;
          continue;
        }
        const reservedConversion = bomCandidateQuantityConversion(line, reservedItem);
        if (reservedConversion === undefined || !Number.isSafeInteger(reservation.quantity)) {
          throw new ApplicationError("integrity_error", "Existing reservation has no valid quantity conversion for this BOM line");
        }
        reservedCoverage += reservation.quantity * reservedConversion.requirement.quantity;
      }
      if (exceedsReservableQuantity(parsed.quantity, line.requiredQuantity, reservedCoverage, conversion?.requirement.quantity)) {
        throw conflict(conversion === undefined
          ? `Cannot reserve beyond the BOM requirement of ${line.requiredQuantity} ${line.unit}`
          : `Cannot reserve beyond the BOM requirement of ${line.requiredQuantity} ${line.unit}; ${parsed.quantity} set(s) would exceed whole-set coverage`);
      }
      if (quantityExceeds(parsed.quantity, item.availableQuantity)) {
        throw conflict(`Not enough ${inStockQuantityLabel(policy)} to reserve ${parsed.quantity} ${item.unit}`);
      }
      const reservation = await this.ports.projects.createReservation(parentId, parsed, ctx);
      return { value: reservation, entityId: reservation.id, version: reservation.version };
    });
  }

  async releaseReservation(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Reservation>> {
    const reservationId = requireId(id, "reservation id");
    return this.mutate(ctx, "project.reservation.release", "reservation", reservationId, async () => {
      const details = await this.ports.projects.getReservationDetails(reservationId);
      if (details === null) throw notFound("Reservation", reservationId);
      await this.assertProjectActive(details.projectId);
      const reservation = await this.ports.projects.releaseReservation(reservationId, expectedVersion, ctx);
      return { value: reservation, entityId: reservation.id, version: reservation.version };
    });
  }

  async listReservations(revisionId: string): Promise<readonly Reservation[]> {
    const parsedRevisionId = requireId(revisionId, "revision id");
    await this.assertProjectReadableFromRevision(parsedRevisionId);
    return this.ports.unitOfWork.exclusive(() => this.ports.projects.listReservations(parsedRevisionId));
  }

  async getReservationDetails(id: string): Promise<ReservationDetails> {
    return this.ports.unitOfWork.exclusive(async () => {
      const details = await this.ports.projects.getReservationDetails(requireId(id, "reservation id"));
      if (!details) throw notFound("Reservation", id);
      await this.assertProjectReadable(details.projectId);
      return details;
    });
  }

  /** Read the current review document. A missing document is a normal first
   * visit; callers can save an explicit set of line outcomes to create it. */

  async recordUsage(input: UsageInput, ctx: RequestContext): Promise<Mutation<StockMutation>> {
    const itemId = requireId(input.itemId, "item id");
    requireId(input.projectId, "project id");
    const reservationId = requireId(input.reservationId ?? "", "reservation id");
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new ApplicationError("validation", "Usage quantity must be greater than zero");
    }
    return this.mutate(ctx, "project.usage.record", "inventory_item", itemId, async () => {
      await this.assertProjectActive(input.projectId);
      const item = await this.ports.inventory.getItem(itemId);
      if (item === null) throw notFound("Inventory item", itemId);
      assertCompatibleInventoryUnit(item, "Cannot record usage");
      if (item.unit !== input.unit) {
        throw new ApplicationError("validation", `Unit mismatch: item uses ${item.unit}, usage uses ${input.unit}`);
      }
      const details = await this.ports.projects.getReservationDetails(reservationId);
      if (details === null) throw notFound("Reservation", reservationId);
      if (details.projectId !== input.projectId) throw new ApplicationError("validation", "Reservation belongs to a different project");
      assertConsumedBomRequirement(details.bomLine);
      const usage = await this.ports.projects.recordUsage({ ...input, itemId, reservationId }, ctx);
      return { value: { ...usage, item: inventoryWithUnitStatus(usage.item) }, entityId: usage.item.id, version: usage.item.version };
    });
  }
}
