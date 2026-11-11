import { ApplicationError } from "../errors.js";
import { isRecord } from "./shared.js";
import { bomAlternativeSchema, bomLineRoleSchema, bomSpecificationDecisionSchema, bomSpecificationSchema, idSchema, quantityUnitSchema } from "@benchledger/api-contract";
import type { BomLine, CreateBomLine, InventoryItem } from "@benchledger/api-contract";
import { isLedResistorRequirement, resolveBomSpecification } from "@benchledger/domain";
import { z } from "zod/v3";

/**
 * The REST and MCP boundaries use the closed bomConstraintsSchema. The
 * application service also reads older persisted BOM records, so it accepts
 * their string maps here and keeps unsupported keys fail-closed in matching,
 * reservation, and evaluation. This is an internal compatibility path only;
 * new external requests are validated by the strict boundary schemas.
 */
export const legacyBomConstraintValueSchema = z.union([z.string(), bomSpecificationSchema]);

export const legacyBomConstraintsSchema = z.record(z.string(), legacyBomConstraintValueSchema).default({});

export const legacyCreateBomLineSchema = z.object({
  id: idSchema.optional(),
  name: z.string().min(1).max(240),
  itemId: idSchema.optional(),
  role: bomLineRoleSchema.nullable().optional(),
  requiredQuantity: z.number().finite().positive(),
  unit: quantityUnitSchema,
  optional: z.boolean(),
  constraints: legacyBomConstraintsSchema,
  alternatives: z.array(bomAlternativeSchema).max(20),
  notes: z.string().max(2000).optional(),
}).strict();

export const legacyUpdateBomLineSchema = z.object({
  name: z.string().min(1).max(240).optional(),
  itemId: idSchema.nullable().optional(),
  role: bomLineRoleSchema.nullable().optional(),
  requiredQuantity: z.number().finite().positive().optional(),
  unit: quantityUnitSchema.optional(),
  optional: z.boolean().optional(),
  constraints: legacyBomConstraintsSchema.optional(),
  alternatives: z.array(bomAlternativeSchema).max(20).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

/**
 * Constraint keys are deliberately allow-listed at the API boundary. BOM
 * records are persisted as a flexible string map for forward compatibility,
 * but an unknown key must never silently broaden a match to every item.
 */
export const SUPPORTED_BOM_CONSTRAINT_KEYS: ReadonlySet<string> = new Set([
  "kind", "manufacturer", "model", "sku", "tag", "nameIncludes"
]);

export const SPECIFICATION_CONSTRAINT_KEY = "specification";

export type BomConstraintValue = string | z.infer<typeof bomSpecificationSchema>;

export function unsupportedBomConstraintKeys(constraints: Readonly<Record<string, BomConstraintValue | undefined>> | undefined): readonly string[] {
  if (constraints === undefined) return [];
  return Object.keys(constraints).filter((key) => key !== SPECIFICATION_CONSTRAINT_KEY && !SUPPORTED_BOM_CONSTRAINT_KEYS.has(key));
}

export function matchesBomConstraints(item: InventoryItem, constraints: Readonly<Record<string, BomConstraintValue | undefined>> | undefined): boolean {
  if (constraints === undefined) return true;
  if (unsupportedBomConstraintKeys(constraints).length > 0) return false;
  return Object.entries(constraints).every(([key, expected]) => {
    if (key === SPECIFICATION_CONSTRAINT_KEY) return bomSpecificationSchema.safeParse(expected).success;
    if (typeof expected !== "string") return false;
    if (key === "kind") return item.kind === expected;
    if (key === "manufacturer") return item.manufacturer?.toLowerCase() === expected.toLowerCase();
    if (key === "model") return item.model?.toLowerCase() === expected.toLowerCase();
    if (key === "sku") return item.sku?.toLowerCase() === expected.toLowerCase();
    if (key === "tag") return item.tags.some((tag) => tag.toLowerCase() === expected.toLowerCase());
    if (key === "nameIncludes") return item.name.toLowerCase().includes(expected.toLowerCase());
    return false;
  });
}

export type LegacyBomLineInput = Omit<CreateBomLine, "constraints"> & {
  /** @deprecated Accepted only for internal callers reading legacy records. */
  constraints?: Readonly<Record<string, BomConstraintValue>>;
};

export type BomSpecificationDecision = z.infer<typeof bomSpecificationDecisionSchema>;

export function bomSpecification(line: Pick<BomLine, "name" | "constraints"> & { readonly id?: string | undefined; readonly itemId?: string | undefined }): { readonly sufficient: boolean; readonly missingDecisions: readonly BomSpecificationDecision[] } {
  const raw = line.constraints?.[SPECIFICATION_CONSTRAINT_KEY];
  if (raw !== undefined && !bomSpecificationSchema.safeParse(raw).success) {
    throw new ApplicationError("integrity_error", `BOM line ${line.id ?? "unknown"} contains a malformed specification decision.`);
  }
  return resolveBomSpecification(line);
}

export function canonicalizeBomLineWrite<T extends { readonly name: string; readonly constraints?: unknown }>(input: T): T {
  if (!isLedResistorRequirement(input.name)) return input;
  const constraints = isRecord(input.constraints) ? input.constraints : undefined;
  const specification = constraints?.[SPECIFICATION_CONSTRAINT_KEY];
  const resolved = resolveBomSpecification(input);
  if (isSpecificationSufficientClaim(specification) && !resolved.sufficient) {
    throw new ApplicationError("validation", "A sufficient LED resistor requirement must resolve resistance and power_rating.");
  }
  if (specification !== undefined) {
    if (!isRecord(specification) || specification.status !== "insufficient") return input;
    return {
      ...input,
      constraints: {
        ...(constraints ?? {}),
        specification: { ...specification, status: "insufficient", missingDecisions: [...resolved.missingDecisions] },
      },
    } as T;
  }
  return {
    ...input,
    constraints: {
      ...(constraints ?? {}),
      specification: { status: "insufficient", missingDecisions: [...resolved.missingDecisions] },
    },
  } as T;
}

export function isSpecificationSufficientClaim(value: unknown): value is Readonly<Record<string, unknown>> & { readonly status: "sufficient" } {
  return isRecord(value) && value.status === "sufficient";
}

export function bomRequirementRequestsPrinter(input: Pick<CreateBomLine, "constraints">): boolean {
  return input.constraints?.kind === "printer";
}

export function assertConsumedBomRequirement(line: Pick<BomLine, "role">): void {
  if (line.role === undefined || line.role === null) {
    throw new ApplicationError("validation", "Review whether this BOM line is consumed or reusable before changing stock");
  }
  if (line.role !== "consumed") {
    throw new ApplicationError("validation", "Only consumed BOM requirements may reserve or consume stock");
  }
}
