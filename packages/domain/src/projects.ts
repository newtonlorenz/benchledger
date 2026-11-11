import { createId, nowIso, slugify } from "./ids.js";
import { DomainError, assertPositiveQuantity } from "./errors.js";
import { isLedResistorRequirement, resolveBomSpecification } from "./specification.js";
import { cloneBomAlternativeQuantityConversion } from "./quantity-conversion.js";
import { isFabricationRoute, type FabricationRoute } from "./fabrication-route.js";
import type {
  BomConstraints,
  BomAlternative,
  BomLine,
  Project,
  ProjectStatus,
  ProjectRevision,
  Reservation,
  RevisionStatus,
  StockBalance,
  WorkItem,
  WorkItemKind,
  WorkItemRevision
} from "./types.js";

export interface NewProject {
  id?: string;
  name: string;
  slug?: string;
  description?: string;
  status?: ProjectStatus;
  visibility?: Project["visibility"];
  createdAt?: string;
  updatedAt?: string;
}

export function createProject(input: NewProject): Project {
  if (!input.name.trim()) throw new DomainError("invalid_project_name", "project name is required");
  const createdAt = input.createdAt ?? nowIso();
  return {
    id: input.id ?? createId("project"),
    name: input.name.trim(),
    slug: input.slug ?? slugify(input.name),
    ...(input.description === undefined ? {} : { description: input.description }),
    status: input.status ?? "idea",
    visibility: input.visibility ?? "private",
    createdAt,
    updatedAt: input.updatedAt ?? createdAt
  };
}

export interface NewWorkItem {
  id?: string;
  projectId: string;
  name: string;
  kind: WorkItemKind;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function createWorkItem(input: NewWorkItem): WorkItem {
  if (!input.projectId.trim()) throw new DomainError("invalid_project_id", "work item projectId is required");
  if (!input.name.trim()) throw new DomainError("invalid_work_item_name", "work item name is required");
  const createdAt = input.createdAt ?? nowIso();
  return {
    id: input.id ?? createId("work"),
    projectId: input.projectId,
    name: input.name.trim(),
    kind: input.kind,
    ...(input.description === undefined ? {} : { description: input.description }),
    createdAt,
    updatedAt: input.updatedAt ?? createdAt
  };
}

export interface NewProjectRevision {
  id?: string;
  projectId: string;
  number: number;
  label?: string;
  status?: RevisionStatus;
  fabricationRoute?: FabricationRoute;
  /** Null deliberately clears an inherited printer assignment. */
  intendedPrinterItemId?: string | null;
  machineId?: string;
  material?: string;
  notes?: string;
  createdAt?: string;
  supersedesRevisionId?: string;
}

export function createProjectRevision(input: NewProjectRevision): ProjectRevision {
  if (!input.projectId.trim()) throw new DomainError("invalid_project_id", "revision projectId is required");
  if (!Number.isInteger(input.number) || input.number < 1) throw new DomainError("invalid_revision_number", "revision number must be a positive integer");
  if (input.fabricationRoute !== undefined && !isFabricationRoute(input.fabricationRoute)) throw new DomainError("invalid_fabrication_route", "fabrication route is not supported");
  if (input.intendedPrinterItemId !== undefined && input.intendedPrinterItemId !== null && (input.fabricationRoute ?? "undecided") !== "printed") throw new DomainError("invalid_printer_route", "an intended printer requires the printed fabrication route");
  if (input.intendedPrinterItemId !== undefined && input.intendedPrinterItemId !== null && !input.intendedPrinterItemId.trim()) throw new DomainError("invalid_printer_item_id", "intended printer item ID cannot be empty");
  const createdAt = input.createdAt ?? nowIso();
  return {
    id: input.id ?? createId("project-revision"),
    projectId: input.projectId,
    number: input.number,
    label: input.label ?? `r${String(input.number).padStart(2, "0")}`,
    status: input.status ?? "concept",
    fabricationRoute: input.fabricationRoute ?? "undecided",
    intendedPrinterItemId: input.intendedPrinterItemId ?? null,
    ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
    ...(input.material === undefined ? {} : { material: input.material }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    createdAt,
    ...(input.supersedesRevisionId === undefined ? {} : { supersedesRevisionId: input.supersedesRevisionId })
  };
}

export interface NewWorkItemRevision {
  id?: string;
  workItemId: string;
  number: number;
  label?: string;
  status?: RevisionStatus;
  sourcePath?: string;
  createdAt?: string;
  supersedesRevisionId?: string;
}

export function createWorkItemRevision(input: NewWorkItemRevision): WorkItemRevision {
  if (!input.workItemId.trim()) throw new DomainError("invalid_work_item_id", "work item revision workItemId is required");
  if (!Number.isInteger(input.number) || input.number < 1) throw new DomainError("invalid_revision_number", "revision number must be a positive integer");
  const createdAt = input.createdAt ?? nowIso();
  return {
    id: input.id ?? createId("work-revision"),
    workItemId: input.workItemId,
    number: input.number,
    label: input.label ?? `r${String(input.number).padStart(2, "0")}`,
    status: input.status ?? "concept",
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
    createdAt,
    ...(input.supersedesRevisionId === undefined ? {} : { supersedesRevisionId: input.supersedesRevisionId })
  };
}

export function nextRevisionNumber(revisions: readonly { number: number }[]): number {
  return revisions.reduce((highest, revision) => Math.max(highest, revision.number), 0) + 1;
}

export interface NewBomLine {
  id?: string;
  revisionId: string;
  name: string;
  quantity: number;
  unit: BomLine["unit"];
  role?: BomLine["role"];
  required?: boolean;
  optional?: boolean;
  itemId?: string;
  alternativeItemIds?: readonly string[];
  alternatives?: readonly BomAlternative[];
  constraints?: BomConstraints;
  notes?: string;
}

export function createBomLine(input: NewBomLine): BomLine {
  if (!input.revisionId.trim()) throw new DomainError("invalid_revision_id", "BOM line revisionId is required");
  if (!input.name.trim()) throw new DomainError("invalid_bom_name", "BOM line name is required");
  assertPositiveQuantity(input.quantity, "BOM line quantity");
  if (input.constraints?.category === "printer") {
    throw new DomainError("printer_requirement_not_allowed", "Printers are selected through build configuration, not BOM requirements");
  }
  const rawSpecification = input.constraints?.specification;
  const resolvedSpecification = resolveBomSpecification({ name: input.name, constraints: input.constraints });
  if (isLedResistorRequirement(input.name) && rawSpecification?.status === "sufficient" && !resolvedSpecification.sufficient) {
    throw new DomainError("invalid_bom_specification", "A sufficient LED resistor requirement must resolve resistance and power_rating.");
  }
  const writtenConstraints = isLedResistorRequirement(input.name) && rawSpecification === undefined
    ? { ...(input.constraints ?? {}), specification: { status: "insufficient" as const, missingDecisions: [...resolvedSpecification.missingDecisions] } }
    : input.constraints;
  return {
    id: input.id ?? createId("bom"),
    revisionId: input.revisionId,
    name: input.name.trim(),
    quantity: input.quantity,
    unit: input.unit,
    ...(input.role === undefined ? {} : { role: input.role }),
    required: input.required ?? !input.optional,
    ...(input.optional === undefined ? {} : { optional: input.optional }),
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
    ...(input.alternativeItemIds === undefined ? {} : { alternativeItemIds: input.alternativeItemIds.slice() }),
    ...(input.alternatives === undefined ? {} : { alternatives: input.alternatives.map((alternative) => ({
      ...alternative,
      ...(alternative.quantityConversion === undefined ? {} : { quantityConversion: cloneBomAlternativeQuantityConversion(alternative.quantityConversion) }),
      ...(alternative.constraints === undefined ? {} : { constraints: { ...alternative.constraints, ...(alternative.constraints.tags === undefined ? {} : { tags: alternative.constraints.tags.slice() }) } })
    })) }),
    ...(writtenConstraints === undefined ? {} : { constraints: { ...writtenConstraints, ...(writtenConstraints.tags === undefined ? {} : { tags: writtenConstraints.tags.slice() }) } }),
    ...(input.notes === undefined ? {} : { notes: input.notes })
  };
}

export interface ReserveStockInput {
  id?: string;
  projectRevisionId: string;
  bomLineId: string;
  itemId: string;
  quantity: number;
  createdAt?: string;
}

export function activeReservedQuantity(reservations: readonly Reservation[], itemId: string): number {
  return reservations
    .filter((reservation) => reservation.itemId === itemId && reservation.status === "active")
    .reduce((total, reservation) => total + reservation.quantity, 0);
}

export function createReservation(
  input: ReserveStockInput,
  balance: StockBalance,
  existingReservations: readonly Reservation[] = []
): Reservation {
  if (!input.projectRevisionId.trim() || !input.bomLineId.trim() || !input.itemId.trim()) throw new DomainError("invalid_reservation_reference", "reservation references are required");
  assertPositiveQuantity(input.quantity, "reservation quantity");
  const alreadyReserved = activeReservedQuantity(existingReservations, input.itemId);
  if (alreadyReserved + input.quantity > balance.onHand) {
    throw new DomainError("insufficient_stock", `cannot reserve ${input.quantity}; only ${Math.max(0, balance.onHand - alreadyReserved)} unallocated unit(s) remain`);
  }
  const createdAt = input.createdAt ?? nowIso();
  return {
    id: input.id ?? createId("reservation"),
    projectRevisionId: input.projectRevisionId,
    bomLineId: input.bomLineId,
    itemId: input.itemId,
    quantity: input.quantity,
    status: "active",
    createdAt
  };
}

export function releaseReservation(reservation: Reservation, releasedAt = nowIso()): Reservation {
  if (reservation.status !== "active") throw new DomainError("reservation_not_active", "only an active reservation can be released");
  return { ...reservation, status: "released", releasedAt };
}

export function consumeReservation(reservation: Reservation): Reservation {
  if (reservation.status !== "active") throw new DomainError("reservation_not_active", "only an active reservation can be consumed");
  return { ...reservation, status: "consumed" };
}

/** Settle a reservation as part of the review-first close-out aggregate. */
export function settleReservation(reservation: Reservation, settledAt = nowIso()): Reservation {
  if (reservation.status !== "active") throw new DomainError("reservation_not_active", "only an active reservation can be settled");
  return { ...reservation, status: "settled", releasedAt: settledAt };
}
