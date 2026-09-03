import { z } from "zod";
import {
  ITEM_KINDS,
  QUANTITY_UNITS,
  isUnitCompatibleWithItemKind,
  unitCorrectionReason
} from "./units.js";

export const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const correlationIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const isoDateSchema = z.string().datetime({ offset: true });

export const workspaceSecurityModeSchema = z.enum(["lan_open", "password"]);
export const workspaceSecurityStatusSchema = z.object({
  mode: workspaceSecurityModeSchema,
  passwordConfigured: z.boolean(),
  version: z.number().int().positive()
}).strict();

/** Public password inputs contain plaintext only at the request boundary.
 * Encoded hashes are generated inside the trusted host and are not accepted
 * by any public contract. Every mutation carries its optimistic version so a
 * stale settings form cannot overwrite a newer credential. */
export const workspacePasswordSchema = z.string().min(12).max(512);
export const workspaceSecurityMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("enable"), newPassword: workspacePasswordSchema, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ operation: z.literal("disable"), currentPassword: workspacePasswordSchema, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ operation: z.literal("change_password"), currentPassword: workspacePasswordSchema, newPassword: workspacePasswordSchema, expectedVersion: z.number().int().positive() }).strict()
]);

export const itemKindSchema = z.enum(ITEM_KINDS);

export const quantityUnitSchema = z.enum(QUANTITY_UNITS);
export const inventoryUnitStatusSchema = z.enum(["compatible", "needs_correction"]);
export const inventoryConditionSchema = z.enum(["new", "good", "worn", "needs_repair", "unknown"]);
export const stockEvidenceSchema = z.enum([
  "physically_counted",
  "commissioned",
  "delivered_uncounted",
  "ordered_unverified",
  "allocated",
  "consumed",
  "unknown"
]);
export const stockEventTypeSchema = z.enum([
  "receipt",
  "count",
  "correction",
  "allocate",
  "release",
  "consume",
  "return",
  "loss",
  "dispose"
]);

export const dimensionSchema = z.object({
  lengthMm: z.number().finite().nonnegative().optional(),
  widthMm: z.number().finite().nonnegative().optional(),
  heightMm: z.number().finite().nonnegative().optional(),
  diameterMm: z.number().finite().nonnegative().optional(),
  measured: z.boolean().default(false),
  uncertaintyMm: z.number().finite().nonnegative().optional(),
  note: z.string().max(500).optional()
}).strict();

export const supplierLinkSchema = z.object({
  supplier: z.string().min(1).max(160),
  url: z.string().url().max(2000),
  label: z.string().max(200).optional(),
  currentPriceMinor: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  observedAt: isoDateSchema.optional(),
  packageQuantity: z.number().finite().positive().optional()
}).strict();

export const evidenceSchema = z.object({
  state: stockEvidenceSchema,
  source: z.string().max(500).optional(),
  sourceId: z.string().max(500).optional(),
  observedAt: isoDateSchema.optional(),
  note: z.string().max(1000).optional()
}).strict();

const inventoryItemShape = z.object({
  id: idSchema,
  name: z.string().min(1).max(240),
  kind: itemKindSchema,
  /** Optional managed taxonomy node assignment; legacy `kind` remains closed. */
  categoryNodeId: idSchema.optional(),
  description: z.string().max(5000).optional(),
  manufacturer: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  sku: z.string().max(200).optional(),
  quantity: z.number().finite().nonnegative(),
  availableQuantity: z.number().finite().nonnegative(),
  /** On-hand quantity currently reserved for projects; not depleted stock. */
  allocatedQuantity: z.number().finite().nonnegative().optional(),
  unit: quantityUnitSchema,
  /** Derived compatibility state. Legacy mismatches remain readable but are not actionable. */
  unitStatus: inventoryUnitStatusSchema.optional(),
  unitCorrectionReason: z.string().max(500).optional(),
  location: z.string().max(240).optional(),
  condition: inventoryConditionSchema.optional(),
  dimensions: dimensionSchema.optional(),
  tags: z.array(z.string().min(1).max(80)).max(50),
  links: z.array(supplierLinkSchema).max(30),
  evidence: evidenceSchema,
  retiredAt: isoDateSchema.optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  version: z.number().int().positive()
}).strict();

function validateInventoryItemQuantityInvariant(
  value: { readonly quantity: number; readonly availableQuantity: number; readonly allocatedQuantity?: number | undefined; readonly evidence: { readonly state: string } },
  ctx: z.RefinementCtx
): void {
  if (value.availableQuantity > value.quantity) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["availableQuantity"],
      message: "availableQuantity cannot exceed quantity"
    });
  }
  const confirmedEvidence = value.evidence.state === "physically_counted" || value.evidence.state === "commissioned";
  const expectedAllocatedQuantity = value.quantity - value.availableQuantity;
  const allocationTolerance = Number.EPSILON * Math.max(1, value.quantity, value.availableQuantity);
  if (confirmedEvidence && value.allocatedQuantity !== undefined && Math.abs(value.allocatedQuantity - expectedAllocatedQuantity) > allocationTolerance) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allocatedQuantity"],
      message: "allocatedQuantity must equal quantity minus availableQuantity"
    });
  }
}

export const inventoryItemSchema = inventoryItemShape.superRefine(validateInventoryItemQuantityInvariant);

export const inventoryListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  kind: itemKindSchema.optional(),
  evidence: stockEvidenceSchema.optional(),
  available: z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean()).optional(),
  /** Summary/audit callers may include retired history explicitly. */
  includeRetired: z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean()).optional(),
  categoryNodeId: idSchema.optional(),
  unassigned: z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean()).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional()
}).strict().refine(({ categoryNodeId, unassigned }) => !(categoryNodeId !== undefined && unassigned === true), { message: "categoryNodeId and unassigned cannot be combined" });

/** User-managed taxonomy identity; intentionally has no `kind` discriminator. */
export const inventoryCategorySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  parentId: idSchema.optional(),
  sortOrder: z.number().int().nonnegative(),
  archived: z.boolean(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  version: z.number().int().positive()
}).strict();

export const inventoryCategoryListQuerySchema = z.object({
  includeArchived: z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean()).default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional()
}).strict();

export const createInventoryCategorySchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(120),
  parentId: idSchema.optional(),
  sortOrder: z.number().int().nonnegative().default(0)
}).strict();

export const updateInventoryCategorySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sortOrder: z.number().int().nonnegative().optional()
}).strict().refine((value) => value.name !== undefined || value.sortOrder !== undefined, {
  message: "at least one category field must change"
});

const createInventoryItemShape = inventoryItemShape.pick({
  name: true, kind: true, categoryNodeId: true, description: true, manufacturer: true, model: true,
  sku: true, quantity: true, unit: true, location: true, condition: true,
  dimensions: true, tags: true, links: true, evidence: true
}).extend({
  id: idSchema.optional(),
  availableQuantity: z.number().finite().nonnegative().optional()
}).strict();

function validateInventoryQuantityInvariant(value: { readonly quantity: number; readonly availableQuantity?: number | undefined }, ctx: z.RefinementCtx): void {
  if (value.availableQuantity !== undefined && value.availableQuantity > value.quantity) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["availableQuantity"],
      message: "availableQuantity cannot exceed quantity"
    });
  }
}

function validateInventoryItemKindUnit(
  value: { readonly kind: string; readonly unit: string },
  ctx: z.RefinementCtx
): void {
  const reason = unitCorrectionReason(value.kind, value.unit);
  if (reason !== undefined && !isUnitCompatibleWithItemKind(value.kind, value.unit)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unit"], message: reason });
  }
}

export const createInventoryItemSchema = createInventoryItemShape
  .superRefine(validateInventoryQuantityInvariant)
  .superRefine(validateInventoryItemKindUnit);

/**
 * Commissioning is a deliberate evidence transition, not a generic item
 * update. The observed quantity and provenance are recorded with an append-only
 * stock count event by the application service.
 */
export const commissionInventoryItemSchema = z.object({
  quantity: z.number().finite().nonnegative(),
  unit: quantityUnitSchema,
  evidence: evidenceSchema.extend({ state: z.literal("commissioned"), source: z.string().min(1).max(500), observedAt: isoDateSchema })
}).strict();

const updateInventoryItemShape = createInventoryItemShape.omit({ id: true, quantity: true, availableQuantity: true, unit: true, evidence: true });
export const updateInventoryItemSchema = updateInventoryItemShape.extend({ categoryNodeId: idSchema.nullable().optional() }).partial().strict();

const inventoryBulkTagInputSchema = z.string().trim().min(1).max(80);

function normalizeInventoryTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const value = tag.trim();
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

export const inventoryBulkUpdateTagsSchema = z.object({
  add: z.array(inventoryBulkTagInputSchema).max(50).optional(),
  remove: z.array(inventoryBulkTagInputSchema).max(50).optional()
}).strict().superRefine((value, context) => {
  const add = normalizeInventoryTags(value.add ?? []);
  const remove = normalizeInventoryTags(value.remove ?? []);
  if (add.length === 0 && remove.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "tags.add or tags.remove must contain at least one tag" });
  }
  const removed = new Set(remove.map((tag) => tag.toLocaleLowerCase()));
  if (add.some((tag) => removed.has(tag.toLocaleLowerCase()))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A tag cannot be both added and removed" });
  }
}).transform((value) => {
  const add = normalizeInventoryTags(value.add ?? []);
  const remove = normalizeInventoryTags(value.remove ?? []);
  return {
    ...(add.length === 0 ? {} : { add }),
    ...(remove.length === 0 ? {} : { remove })
  };
});

export const inventoryBulkUpdateChangesSchema = z.object({
  location: z.string().trim().min(1).max(240).optional(),
  condition: inventoryConditionSchema.optional(),
  tags: inventoryBulkUpdateTagsSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.location === undefined && value.condition === undefined && value.tags === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one bulk metadata change is required" });
  }
});

export const inventoryBulkUpdateTargetSchema = z.object({
  itemId: idSchema,
  expectedVersion: z.number().int().positive()
}).strict();

export const inventoryBulkUpdateSchema = z.object({
  targets: z.array(inventoryBulkUpdateTargetSchema).min(1).max(100),
  changes: inventoryBulkUpdateChangesSchema
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, target] of value.targets.entries()) {
    if (seen.has(target.itemId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["targets", index, "itemId"], message: "Bulk targets must contain unique item ids" });
    }
    seen.add(target.itemId);
  }
});

/** Descriptive aliases for callers that prefer the operation-first naming. */
export const bulkUpdateInventoryItemsSchema = inventoryBulkUpdateSchema;
export const bulkInventoryUpdateSchema = inventoryBulkUpdateSchema;

export const stockEventInputSchema = z.object({
  itemId: idSchema,
  type: stockEventTypeSchema,
  quantity: z.number().finite().nonnegative(),
  unit: quantityUnitSchema,
  note: z.string().max(2000).optional(),
  projectId: idSchema.optional(),
  correlationId: correlationIdSchema.optional(),
  idempotencyKey: z.string().min(8).max(200).optional()
}).strict();

export const stockEventSchema = stockEventInputSchema.extend({
  id: idSchema,
  actor: z.string().min(1).max(200),
  source: z.enum(["ui", "api", "mcp", "import"]),
  evidence: z.record(z.string(), z.unknown()).optional(),
  createdAt: isoDateSchema,
  itemVersion: z.number().int().positive()
}).strict();

export const usageInputSchema = z.object({
  itemId: idSchema,
  reservationId: idSchema.optional(),
  quantity: z.number().finite().positive(),
  unit: quantityUnitSchema,
  note: z.string().max(2000).optional()
}).strict();

/**
 * The only project lifecycle exposed by the public contract.  `blocked` is a
 * derived readiness condition and deliberately cannot be persisted as a
 * project status.  Legacy values are handled by the runtime migration/read
 * projection, never accepted as new public writes.
 */
export const projectLifecycleSchema = z.enum(["idea", "planned", "ready", "building", "validating", "complete", "archived"]);
export const projectStatusSchema = projectLifecycleSchema;
export type ProjectLifecycleValue = z.infer<typeof projectLifecycleSchema>;

/** Read/migration helper for records written before MPM-002. */
export function canonicalProjectLifecycle(value: unknown): ProjectLifecycleValue | undefined {
  if (projectLifecycleSchema.safeParse(value).success) return value as ProjectLifecycleValue;
  switch (value) {
    case "active":
    case "on_hold": return "idea";
    case "planning": return "planned";
    case "in_progress": return "building";
    case "validation": return "validating";
    case "retired": return "archived";
    default: return undefined;
  }
}
export const workItemKindSchema = z.enum(["part", "assembly", "electronics", "firmware", "document", "other"]);
export const revisionStatusSchema = z.enum([
  "concept", "CAD complete", "DFAM reviewed", "mesh validated", "slicer validated",
  "test printed", "fit/function verified", "production approved"
]);

export const projectSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(240),
  description: z.string().max(5000).optional(),
  status: projectStatusSchema,
  currentRevisionId: idSchema.optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  removedAt: isoDateSchema.optional(),
  removedBy: z.string().min(1).max(200).optional(),
  lastLifecycleStatus: projectStatusSchema.optional(),
  removedReservationIds: z.array(idSchema).max(10000).optional(),
  version: z.number().int().positive()
}).strict();

export const createProjectSchema = projectSchema.pick({ name: true, description: true, status: true }).extend({ id: idSchema.optional() }).strict();
export const updateProjectSchema = createProjectSchema.omit({ id: true }).partial().strict();

/** Exact-name confirmation required by irreversible project removal. */
export const removeProjectSchema = z.object({
  name: z.string().trim().min(1).max(240).optional(),
  projectName: z.string().trim().min(1).max(240).optional()
}).strict().superRefine((value, context) => {
  if (value.name === undefined && value.projectName === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "name or projectName confirmation is required" });
  }
  if (value.name !== undefined && value.projectName !== undefined && value.name !== value.projectName) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "name and projectName confirmations must match" });
  }
});

export const projectTombstoneSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(240),
  removedAt: isoDateSchema,
  removedBy: z.string().min(1).max(200),
  lastLifecycleStatus: projectStatusSchema,
  releasedReservationIds: z.array(idSchema).max(10000),
  version: z.number().int().positive(),
  auditId: idSchema.optional()
}).strict();

export const workItemSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: z.string().min(1).max(240),
  kind: workItemKindSchema,
  description: z.string().max(5000).optional(),
  currentRevisionId: idSchema.optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  version: z.number().int().positive()
}).strict();

export const createWorkItemSchema = workItemSchema.pick({ name: true, kind: true, description: true }).extend({ id: idSchema.optional() }).strict();

export const projectRevisionSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  number: z.number().int().positive(),
  name: z.string().min(1).max(240),
  notes: z.string().max(10000).optional(),
  status: revisionStatusSchema,
  createdAt: isoDateSchema,
  version: z.number().int().positive()
}).strict();

export const createProjectRevisionSchema = projectRevisionSchema.pick({ name: true, notes: true, status: true }).extend({ id: idSchema.optional() }).strict();

/** A project and its first versioned planning baseline are created atomically. */
export const createProjectWithInitialRevisionSchema = z.object({
  project: createProjectSchema,
  revision: createProjectRevisionSchema
}).strict();

/**
 * Safe, machine-readable conflicts returned by the atomic project setup
 * command. The details deliberately identify only the requested target; they
 * never include an existing record or a database constraint message.
 */
export const projectCreationConflictDetailsSchema = z.object({
  reason: z.enum(["project_id_exists", "revision_id_exists", "project_name_exists", "idempotency_key_reused"]),
  field: z.enum(["projectId", "revisionId", "projectName", "idempotencyKey"]),
  id: z.string().min(1).max(240),
  retryable: z.literal(false),
  commitState: z.literal("not_committed"),
  commandId: z.string().min(1).max(200).optional()
}).strict();

export const projectWithInitialRevisionSchema = z.object({
  project: projectSchema,
  revision: projectRevisionSchema
}).strict();

export const workItemRevisionSchema = projectRevisionSchema.extend({ workItemId: idSchema }).strict();
export const createWorkItemRevisionSchema = z.object({
  id: idSchema.optional(),
  name: z.string().min(1).max(240),
  notes: z.string().max(10000).optional(),
  status: revisionStatusSchema
}).strict();

export const quantityConversionEvidenceBasisSchema = z.enum([
  "package_label",
  "manufacturer_spec",
  "physical_count",
  "user_assertion",
]);

export const quantityConversionEvidenceSchema = z.object({
  basis: quantityConversionEvidenceBasisSchema,
  observedAt: isoDateSchema,
  source: z.string().max(500).optional(),
  sourceId: z.string().max(500).optional(),
  note: z.string().max(1000).optional(),
}).strict();

const quantityConversionInventorySchema = z.object({
  quantity: z.literal(1),
  unit: z.literal("set"),
}).strict();

const quantityConversionRequirementSchema = z.object({
  quantity: z.number().int().positive().safe(),
  unit: z.literal("each"),
}).strict();

export const quantityConversionSchema = z.object({
  inventory: quantityConversionInventorySchema,
  requirement: quantityConversionRequirementSchema,
  evidence: quantityConversionEvidenceSchema,
}).strict();

/** Alias that makes the owner of this nested contract explicit to consumers. */
export const bomAlternativeQuantityConversionSchema = quantityConversionSchema;

export const bomAlternativeSchema = z.object({
  itemId: idSchema,
  reason: z.string().max(1000).optional(),
  compatible: z.enum(["confirmed", "conditional", "unknown"]).default("conditional"),
  quantityConversion: quantityConversionSchema.optional(),
}).strict();

/**
 * BOM constraints are an intentionally small, closed vocabulary. Keeping
 * this object strict prevents an unrecognised field from being persisted and
 * later interpreted as a broader inventory match by another adapter.
 */
/**
 * A requirement-level specification decision. This deliberately lives beside,
 * but not inside, inventory matching constraints: it describes what the maker
 * still needs to decide and must never make an inventory item appear
 * compatible by itself.
 */
export const bomSpecificationDecisionSchema = z.enum([
  "identity",
  "purpose",
  "voltage",
  "current_or_load",
  "connector",
  "compatibility",
  "dimensions",
  "resistance",
  "power_rating",
]);
const bomSpecificationDecisionValueSchema = z.string().trim().min(1).max(240);
const bomSpecificationDecisionsSchema = z.object({
  identity: bomSpecificationDecisionValueSchema.optional(),
  purpose: bomSpecificationDecisionValueSchema.optional(),
  voltage: bomSpecificationDecisionValueSchema.optional(),
  current_or_load: bomSpecificationDecisionValueSchema.optional(),
  connector: bomSpecificationDecisionValueSchema.optional(),
  compatibility: bomSpecificationDecisionValueSchema.optional(),
  dimensions: bomSpecificationDecisionValueSchema.optional(),
  resistance: bomSpecificationDecisionValueSchema.optional(),
  power_rating: bomSpecificationDecisionValueSchema.optional(),
}).strict();

export const bomSpecificationSchema = z.object({
  status: z.enum(["sufficient", "insufficient"]),
  decisions: bomSpecificationDecisionsSchema.optional(),
  missingDecisions: z.array(bomSpecificationDecisionSchema).min(1).max(9).optional(),
}).strict().superRefine((value, ctx) => {
  const missing = value.missingDecisions ?? [];
  if (value.status === "insufficient" && missing.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["missingDecisions"], message: "Insufficient specifications must name at least one missing decision" });
  }
  if (value.status === "sufficient" && missing.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["missingDecisions"], message: "Sufficient specifications cannot include missing decisions" });
  }
  if (value.status === "sufficient" && Object.keys(value.decisions ?? {}).length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["decisions"], message: "Sufficient specifications must record at least one resolved decision" });
  }
  if (new Set(missing).size !== missing.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["missingDecisions"], message: "Missing decisions must be unique" });
  }
});

export const bomConstraintsSchema = z.object({
  kind: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  sku: z.string().optional(),
  tag: z.string().optional(),
  nameIncludes: z.string().optional(),
  specification: bomSpecificationSchema.optional(),
}).strict();

const bomLineShape = z.object({
  id: idSchema,
  revisionId: idSchema,
  name: z.string().min(1).max(240),
  itemId: idSchema.optional(),
  requiredQuantity: z.number().finite().positive(),
  unit: quantityUnitSchema,
  optional: z.boolean(),
  constraints: bomConstraintsSchema.default({}),
  alternatives: z.array(bomAlternativeSchema).max(20),
  notes: z.string().max(2000).optional(),
  retiredAt: isoDateSchema.optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  version: z.number().int().positive()
}).strict();

export const bomLineSchema = bomLineShape;

const createBomLineShape = bomLineShape.pick({
  name: true, itemId: true, requiredQuantity: true, unit: true, optional: true,
  constraints: true, alternatives: true, notes: true
}).extend({ id: idSchema.optional() }).strict();
export const createBomLineSchema = createBomLineShape;
export const updateBomLineSchema = createBomLineShape.omit({ id: true }).partial().strict();

/**
 * Bounded, review-first project graph setup. The local references are
 * proposal-scoped identities; the application resolves them to stable record
 * IDs once during preview and carries those IDs into commit.
 */
const projectSetupWorkItemSchema = z.object({
  localRef: idSchema,
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(240),
  kind: workItemKindSchema,
  description: z.string().max(5000).optional(),
  revision: createWorkItemRevisionSchema
}).strict();

const projectSetupBomLineSchema = z.object({
  localRef: idSchema,
  revisionLocalRef: idSchema.optional(),
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(240),
  itemId: idSchema.optional(),
  requiredQuantity: z.number().finite().positive(),
  unit: quantityUnitSchema,
  optional: z.boolean().default(false),
  constraints: bomConstraintsSchema.default({}),
  alternatives: z.array(bomAlternativeSchema).max(20).default([]),
  notes: z.string().max(2000).optional()
}).strict();

const projectSetupReservationSchema = z.object({
  localRef: idSchema,
  bomLineLocalRef: idSchema,
  id: idSchema.optional(),
  itemId: idSchema,
  quantity: z.number().finite().positive(),
  unit: quantityUnitSchema.optional()
}).strict();

export const projectSetupProposalSchema = z.object({
  project: createProjectSchema,
  revision: createProjectRevisionSchema,
  workItems: z.array(projectSetupWorkItemSchema).max(6).default([]),
  bomLines: z.array(projectSetupBomLineSchema).min(1).max(24),
  reservations: z.array(projectSetupReservationSchema).max(48).default([])
}).strict().superRefine((value, ctx) => {
  const refs = new Map<string, string>();
  const addRefs = (entries: readonly { readonly localRef: string }[], label: string) => {
    entries.forEach((entry, index) => {
      const prior = refs.get(entry.localRef);
      if (prior !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [label, index, "localRef"], message: `localRef '${entry.localRef}' is already used by ${prior}` });
      else refs.set(entry.localRef, `${label}[${index}]`);
    });
  };
  addRefs(value.workItems, "workItems");
  addRefs(value.bomLines, "bomLines");
  addRefs(value.reservations, "reservations");
  const workRefs = new Set(value.workItems.map((item) => item.localRef));
  value.bomLines.forEach((line, index) => {
    if (line.revisionLocalRef !== undefined && line.revisionLocalRef !== "project" && !workRefs.has(line.revisionLocalRef)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bomLines", index, "revisionLocalRef"], message: `Unknown revision localRef '${line.revisionLocalRef}'` });
    }
  });
  const bomRefs = new Set(value.bomLines.map((line) => line.localRef));
  value.reservations.forEach((reservation, index) => {
    if (!bomRefs.has(reservation.bomLineLocalRef)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reservations", index, "bomLineLocalRef"], message: `Unknown BOM line localRef '${reservation.bomLineLocalRef}'` });
  });
  const ids = new Map<string, string>();
  const addId = (id: string | undefined, path: (string | number)[], label: string) => {
    if (id === undefined) return;
    const prior = ids.get(id);
    if (prior !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `id '${id}' is already used by ${prior}` });
    else ids.set(id, label);
  };
  addId(value.project.id, ["project", "id"], "project");
  addId(value.revision.id, ["revision", "id"], "revision");
  value.workItems.forEach((item, index) => {
    addId(item.id, ["workItems", index, "id"], `workItems[${index}]`);
    addId(item.revision.id, ["workItems", index, "revision", "id"], `workItems[${index}].revision`);
  });
  value.bomLines.forEach((line, index) => addId(line.id, ["bomLines", index, "id"], `bomLines[${index}]`));
  value.reservations.forEach((reservation, index) => addId(reservation.id, ["reservations", index, "id"], `reservations[${index}]`));
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    if (encoded.byteLength > 256 * 1024) ctx.addIssue({ code: z.ZodIssueCode.too_big, maximum: 256 * 1024, type: "string", inclusive: true, path: [], message: "Project setup proposal exceeds the 256 KiB limit" });
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "Project setup proposal cannot be encoded" });
  }
});

export const projectSetupFieldErrorSchema = z.object({
  path: z.string().min(1).max(240),
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(1000)
}).strict();

export const projectSetupInventoryBasisSchema = z.object({
  itemId: idSchema,
  unit: quantityUnitSchema,
  evidenceBasis: evidenceSchema,
  before: z.object({
    version: z.number().int().positive(),
    quantity: z.number().finite().nonnegative(),
    availableQuantity: z.number().finite().nonnegative(),
    allocatedQuantity: z.number().finite().nonnegative()
  }).strict(),
  after: z.object({
    version: z.number().int().positive(),
    quantity: z.number().finite().nonnegative(),
    availableQuantity: z.number().finite().nonnegative(),
    allocatedQuantity: z.number().finite().nonnegative()
  }).strict()
}).strict();

export const projectSetupPlannedReservationSchema = z.object({
  localRef: idSchema,
  bomLineLocalRef: idSchema,
  reservationId: idSchema,
  itemId: idSchema,
  quantity: z.number().finite().positive(),
  unit: quantityUnitSchema,
  before: z.object({ version: z.number().int().positive(), availableQuantity: z.number().finite().nonnegative(), allocatedQuantity: z.number().finite().nonnegative() }).strict(),
  after: z.object({ version: z.number().int().positive(), availableQuantity: z.number().finite().nonnegative(), allocatedQuantity: z.number().finite().nonnegative() }).strict()
}).strict();

export const projectSetupPreviewSchema = z.object({
  id: idSchema,
  version: z.number().int().positive(),
  status: z.enum(["active", "committed", "expired"]),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  expiresAt: isoDateSchema,
  contentSha256: z.string().length(64).regex(/^[a-f0-9]+$/),
  proposal: projectSetupProposalSchema,
  fieldErrors: z.array(projectSetupFieldErrorSchema).max(100),
  unresolvedSpecifications: z.array(z.object({ bomLineLocalRef: idSchema, missingDecisions: z.array(bomSpecificationDecisionSchema).max(9) }).strict()).max(24),
  gaps: z.object({ revisionId: idSchema, lines: z.array(z.lazy(() => bomGapSchema)).max(24), totals: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
  plannedReservations: z.array(projectSetupPlannedReservationSchema).max(48),
  // Candidate matching may legitimately involve more rows than the bounded
  // reservation list. Keep the review document bounded without truncating a
  // workspace-scale inventory basis.
  affectedInventory: z.array(projectSetupInventoryBasisSchema).max(10_000),
  correlationId: correlationIdSchema
}).strict();

export const commitProjectSetupSchema = z.object({
  previewId: idSchema,
  expectedPreviewVersion: z.number().int().positive(),
  contentSha256: z.string().length(64).regex(/^[a-f0-9]+$/),
  confirmReservations: z.boolean()
}).strict();

/** HTTP request body for a path-addressed setup commit. The preview identity
 * is carried by `/project-setup/previews/{id}/commit`, never duplicated in the
 * JSON body. MCP keeps using commitProjectSetupSchema with its explicit ID. */
export const commitProjectSetupBodySchema = commitProjectSetupSchema.omit({ previewId: true }).strict();

export const projectSetupCommitResultSchema = z.object({
  project: projectSchema,
  revision: projectRevisionSchema,
  workItems: z.array(workItemSchema).max(6),
  workItemRevisions: z.array(workItemRevisionSchema).max(6),
  bomLines: z.array(bomLineSchema).max(24),
  reservations: z.array(z.lazy(() => reservationSchema)).max(48),
  auditIds: z.array(idSchema).max(4),
  context: z.record(z.string(), z.unknown()),
  gaps: z.object({
    revisionId: idSchema,
    lines: z.array(z.lazy(() => bomGapSchema)).max(24),
    totals: z.record(z.string(), z.number().int().nonnegative())
  }).strict(),
  nextAction: z.string().min(1).max(1000)
}).strict();

export const gapStatusSchema = z.enum(["supplied", "inspect_first", "specify_first", "partially_supplied", "missing", "optional"]);
export const bomDecisionSchema = z.enum(["ready", "check", "decide", "source"]);
export const bomGapCandidateSchema = z.object({
  itemId: idSchema,
  relationship: z.enum(["exact", "confirmed_alternative", "uncertain_alternative", "constraint_match"]),
  compatibility: z.enum(["confirmed", "conditional", "unknown"]),
  availableQuantity: z.number().finite().nonnegative(),
  suppliedQuantity: z.number().finite().nonnegative(),
  inspectQuantity: z.number().finite().nonnegative(),
  reason: z.string().max(1000),
}).strict();
export const bomGapSchema = z.object({
  lineId: idSchema,
  name: z.string(),
  optional: z.boolean().optional(),
  status: gapStatusSchema,
  /** Beginner-facing grouping derived from the structured gap state. */
  decision: bomDecisionSchema.optional(),
  missingDecisions: z.array(bomSpecificationDecisionSchema).max(9).optional(),
  requiredQuantity: z.number().finite().nonnegative(),
  suppliedQuantity: z.number().finite().nonnegative(),
  inspectQuantity: z.number().finite().nonnegative(),
  missingQuantity: z.number().finite().nonnegative(),
  unit: quantityUnitSchema,
  matchedItemIds: z.array(idSchema),
  reasons: z.array(z.string().max(1000)),
  alternatives: z.array(bomAlternativeSchema),
  candidates: z.array(bomGapCandidateSchema)
}).strict();

/**
 * Inspection actions are a read-time projection of canonical Check gaps. They
 * deliberately have no persisted action status: once the underlying BOM or
 * inventory changes, the projection is rebuilt and resolved actions disappear.
 */
export const inspectionActionKindSchema = z.enum(["physical_quantity", "compatibility", "unit_conversion"]);
export const inspectionActionLineSchema = z.object({
  lineId: idSchema,
  version: z.number().int().positive()
}).strict();
export const inspectionActionCandidateSchema = z.object({
  id: idSchema,
  version: z.number().int().positive(),
  name: z.string().min(1).max(240),
  unit: quantityUnitSchema,
  evidence: evidenceSchema
}).strict();
export const inspectionActionExpectedSchema = z.object({
  quantity: z.number().finite().nonnegative(),
  unit: quantityUnitSchema,
  lineIds: z.array(idSchema).max(24),
  lineRequirements: z.array(z.object({ lineId: idSchema, quantity: z.number().finite().positive(), unit: quantityUnitSchema }).strict()).max(24)
}).strict();
export const inspectionActionEffectSchema = z.object({
  kind: inspectionActionKindSchema,
  description: z.string().min(1).max(1000)
}).strict();
export const inspectionActionBasisSchema = z.object({
  itemVersion: z.number().int().positive(),
  lineVersions: z.array(inspectionActionLineSchema).max(24)
}).strict();
export const inspectionActionSchema = z.object({
  id: idSchema,
  projectRevisionId: idSchema,
  itemId: idSchema,
  itemVersion: z.number().int().positive(),
  kind: inspectionActionKindSchema,
  /** Canonical predicate used to derive the deterministic action ID. */
  normalizedPredicate: z.string().min(1).max(2000),
  question: z.string().min(1).max(1000),
  itemUnit: quantityUnitSchema,
  expectedUnit: quantityUnitSchema,
  compatibility: z.enum(["confirmed", "conditional", "unknown"]),
  lineIds: z.array(idSchema).max(24),
  lineVersions: z.array(inspectionActionLineSchema).max(24),
  version: z.number().int().positive(),
  candidate: inspectionActionCandidateSchema,
  expected: inspectionActionExpectedSchema,
  possibleResults: z.array(z.enum(["confirmed", "inconclusive"])).min(1).max(2),
  effects: z.array(inspectionActionEffectSchema).min(1).max(4),
  basis: inspectionActionBasisSchema,
  requiresHumanConfirmation: z.literal(true)
}).strict();
export const inspectionActionPageSchema = z.object({
  revisionId: idSchema,
  data: z.array(inspectionActionSchema).max(200),
  limit: z.number().int().min(1).max(200),
  nextCursor: z.string().max(512).optional(),
  total: z.number().int().nonnegative().optional()
}).strict();

export const inspectionObservationResultSchema = z.enum(["confirmed", "inconclusive"]);
export const inspectionObservationSchema = z.object({
  result: inspectionObservationResultSchema,
  quantity: z.number().finite().nonnegative().optional(),
  unit: quantityUnitSchema.optional(),
  source: z.string().trim().min(1).max(500),
  sourceId: z.string().trim().min(1).max(500).optional(),
  observedAt: isoDateSchema,
  note: z.string().max(1000).optional(),
  conversion: quantityConversionSchema.optional()
}).strict();
export const inspectionBasisSchema = z.object({
  actionId: idSchema,
  actionVersion: z.number().int().positive(),
  itemVersion: z.number().int().positive(),
  lineVersions: z.array(inspectionActionLineSchema).max(24),
  hash: z.string().length(64).regex(/^[a-f0-9]+$/)
}).strict();
export const inspectionAffectedLineSchema = z.object({
  lineId: idSchema,
  version: z.number().int().positive(),
  beforeDecision: bomDecisionSchema.optional(),
  afterDecision: bomDecisionSchema.optional()
}).strict();
export const inspectionCompletionPreviewSchema = z.object({
  id: idSchema,
  version: z.number().int().positive(),
  projectRevisionId: idSchema,
  actionId: idSchema,
  // Actors may be opaque bearer-subject identifiers (including email-shaped
  // values); the preview remains bound to the exact actor string by the
  // inspection port.
  actor: z.string().trim().min(1).max(160),
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
  contentSha256: z.string().length(64).regex(/^[a-f0-9]+$/),
  action: inspectionActionSchema,
  observation: inspectionObservationSchema,
  basis: inspectionBasisSchema,
  // The exact line snapshots make compatibility/conversion proposals
  // reviewable and give the commit adapter a closed, optimistic basis for
  // every affected alternative.
  before: z.object({ item: inventoryItemSchema, gaps: z.array(bomGapSchema).max(24), lines: z.array(bomLineSchema).max(24) }).strict(),
  after: z.object({ item: inventoryItemSchema, gaps: z.array(bomGapSchema).max(24), lines: z.array(bomLineSchema).max(24) }).strict(),
  affectedLines: z.array(inspectionAffectedLineSchema).max(24),
  reevaluatedGaps: z.object({ revisionId: idSchema, lines: z.array(bomGapSchema).max(24), totals: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
  requiresHumanConfirmation: z.literal(true)
}).strict();
export const commitInspectionCompletionSchema = z.object({
  previewId: idSchema,
  expectedPreviewVersion: z.number().int().positive(),
  contentSha256: z.string().length(64).regex(/^[a-f0-9]+$/),
  confirmed: z.literal(true)
}).strict();
/** HTTP keeps the revision/action in the path, but the preview identity is
 * still required in the body so the command is bound to one exact preview. */
export const commitInspectionCompletionBodySchema = commitInspectionCompletionSchema;
export const inspectionEvidenceSchema = z.object({
  id: idSchema,
  projectRevisionId: idSchema,
  actionId: idSchema,
  itemId: idSchema,
  kind: inspectionActionKindSchema,
  result: inspectionObservationResultSchema,
  source: z.string().min(1).max(500),
  sourceId: z.string().min(1).max(500).optional(),
  observedAt: isoDateSchema,
  recordedAt: isoDateSchema,
  note: z.string().max(1000).optional(),
  quantity: z.number().finite().nonnegative().optional(),
  unit: quantityUnitSchema.optional(),
  conversion: quantityConversionSchema.optional()
}).strict();
export const inspectionCompletionCommitSchema = z.object({
  id: idSchema,
  status: z.literal("committed"),
  projectRevisionId: idSchema,
  actionId: idSchema,
  previewId: idSchema,
  evidence: inspectionEvidenceSchema,
  item: inventoryItemSchema.optional(),
  gaps: z.object({ revisionId: idSchema, lines: z.array(bomGapSchema).max(24), totals: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
  inspections: inspectionActionPageSchema,
  committedAt: isoDateSchema
}).strict();

export const reservationSchema = z.object({
  id: idSchema,
  lineId: idSchema,
  itemId: idSchema,
  quantity: z.number().finite().positive(),
  status: z.enum(["active", "released", "consumed", "settled"]),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  version: z.number().int().positive()
}).strict();

export const createReservationSchema = reservationSchema.pick({ lineId: true, itemId: true, quantity: true }).extend({ id: idSchema.optional() }).strict();

export const offerSchema = z.object({
  id: idSchema,
  itemId: idSchema.optional(),
  name: z.string().min(1).max(240),
  supplier: z.string().min(1).max(160),
  url: z.string().url().max(2000),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3).toUpperCase(),
  packageQuantity: z.number().finite().positive().optional(),
  shippingMinor: z.number().int().nonnegative().optional(),
  observedAt: isoDateSchema,
  staleAfterDays: z.number().int().positive().default(30),
  notes: z.string().max(2000).optional(),
  version: z.number().int().positive()
}).strict();

export const createOfferSchema = offerSchema.pick({ itemId: true, name: true, supplier: true, url: true, priceMinor: true, currency: true, packageQuantity: true, shippingMinor: true, staleAfterDays: true, notes: true }).extend({ id: idSchema.optional(), observedAt: isoDateSchema.optional() }).strict();

export const artifactRoleSchema = z.enum([
  "source", "cad", "document", "brief", "design_record", "cad_source", "step", "stl", "three_mf", "slicer_project",
  "gcode", "firmware", "drawing", "validation", "photo", "text", "other"
]);

/**
 * A new artifact must be anchored to exactly one revision kind.  The public
 * contract deliberately uses the descriptive projectRevisionId and
 * workItemRevisionId fields; persistence adapters may continue to store the
 * older generic revisionId field after the application has resolved ancestry.
 */
export const artifactScopeSchema = z.union([
  z.object({ projectRevisionId: idSchema }).strict(),
  z.object({ workItemId: idSchema, workItemRevisionId: idSchema }).strict(),
]);

const artifactUploadCommonShape = {
  projectId: idSchema,
  role: artifactRoleSchema,
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200),
  byteSize: z.number().int().positive().max(100 * 1024 * 1024),
  sha256: z.string().length(64).regex(/^[a-f0-9]+$/),
  author: z.string().max(200).optional(),
  source: z.string().max(500).optional(),
};

const projectRevisionUploadSchema = z.object({
  ...artifactUploadCommonShape,
  projectRevisionId: idSchema,
  /** Build configuration snapshots are owned by project revisions only. */
  buildConfigurationSnapshotId: idSchema.optional(),
}).strict();

const workItemRevisionUploadSchema = z.object({
  ...artifactUploadCommonShape,
  workItemId: idSchema,
  workItemRevisionId: idSchema,
}).strict();

export const artifactSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  workItemId: idSchema.optional(),
  revisionId: idSchema.optional(),
  role: artifactRoleSchema,
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().length(64).regex(/^[a-f0-9]+$/),
  author: z.string().max(200).optional(),
  source: z.string().max(500).optional(),
  machineBinding: z.record(z.string(), z.string()).optional(),
  currentCandidate: z.boolean(),
  retired: z.boolean(),
  createdAt: isoDateSchema,
  version: z.number().int().positive()
}).strict();

export const beginUploadSchema = z.union([projectRevisionUploadSchema, workItemRevisionUploadSchema]);

/**
 * Listing is read-only and may address one exact revision or the whole
 * project. A work-item ID without its revision is intentionally ambiguous.
 */
export const artifactListQuerySchema = z.union([
  z.object({ role: artifactRoleSchema.optional(), projectRevisionId: idSchema }).strict(),
  z.object({ role: artifactRoleSchema.optional(), workItemId: idSchema, workItemRevisionId: idSchema }).strict(),
  z.object({ role: artifactRoleSchema.optional() }).strict(),
]);

export const uploadSessionSchema = z.object({
  id: idSchema,
  artifactId: idSchema,
  expiresAt: isoDateSchema,
  maxBytes: z.number().int().positive(),
  uploadUrl: z.string().min(1),
  status: z.enum(["pending", "finalized", "expired"])
}).strict();

export const auditEventSchema = z.object({
  id: idSchema,
  action: z.string().min(1).max(160),
  actor: z.string().min(1).max(200),
  source: z.enum(["ui", "api", "mcp", "import", "system"]),
  correlationId: correlationIdSchema,
  idempotencyKey: z.string().max(200).optional(),
  entityType: z.string().max(160),
  entityId: idSchema,
  version: z.number().int().positive().optional(),
  createdAt: isoDateSchema
}).strict();

export const pageSchema = z.object({
  nextCursor: z.string().optional(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative().optional()
}).strict();

export const healthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  version: z.string(),
  demo: z.boolean(),
  now: isoDateSchema
}).strict();

export const readinessSchema = healthSchema.extend({
  checks: z.record(z.string(), z.enum(["ok", "degraded", "failed"]))
}).strict();

/*
 * v2 exact-product contracts
 *
 * These records deliberately do not alter inventoryItemSchema. Legacy
 * inventory can continue to exist without an inferred product link; a link
 * is an explicit, separately versioned profile. Keep the product variants
 * closed so a printer-only field cannot quietly become filament evidence (or
 * vice versa).
 */

export const catalogProductLengthBasisSchema = z.enum([
  "manufacturer_declared",
  "calculated",
  "unknown"
]);

/** Server-owned provenance for curated catalog facts. */
export const catalogProductProvenanceSchema = z.object({
  sourceUrl: z.string().url().max(2000),
  sourceLabel: z.string().min(1).max(240),
  verifiedAt: isoDateSchema
}).strict();

const catalogProductMetadataShape = {
  id: idSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  version: z.number().int().positive(),
  /**
   * Server-owned source notes for curated records. This is deliberately
   * absent from the create/update specs below: callers may read provenance,
   * but cannot claim or rewrite it through the public product mutation API.
   */
  provenance: catalogProductProvenanceSchema.optional()
} as const;

const catalogProductFilamentFields = {
  kind: z.literal("filament"),
  manufacturer: z.string().min(1).max(200),
  productName: z.string().min(1).max(240).optional(),
  sku: z.string().min(1).max(200).optional(),
  materialFamily: z.string().min(1).max(120),
  materialSubtype: z.string().min(1).max(120).optional(),
  colourName: z.string().min(1).max(160),
  colourCode: z.string().min(1).max(80).optional(),
  diameterMm: z.number().finite().positive(),
  nominalNetMassG: z.number().finite().positive(),
  nominalLengthM: z.number().finite().positive().optional(),
  lengthBasis: catalogProductLengthBasisSchema,
  densityGcm3: z.number().finite().positive().optional()
} as const;

const catalogProductPrinterFields = {
  kind: z.literal("printer"),
  manufacturer: z.string().min(1).max(200),
  exactModel: z.string().min(1).max(240),
  exactVariant: z.string().min(1).max(240).optional(),
  technology: z.literal("fff"),
  buildVolumeMm: z.object({
    x: z.number().finite().positive(),
    y: z.number().finite().positive(),
    z: z.number().finite().positive()
  }).strict()
} as const;

export const catalogProductFilamentSpecSchema = z.object(catalogProductFilamentFields).strict();
export const catalogProductPrinterSpecSchema = z.object(catalogProductPrinterFields).strict();

export const catalogProductFilamentSchema = z.object({
  ...catalogProductFilamentFields,
  ...catalogProductMetadataShape
}).strict();
export const catalogProductPrinterSchema = z.object({
  ...catalogProductPrinterFields,
  ...catalogProductMetadataShape
}).strict();

/** The persisted exact catalog product, discriminated by `kind`. */
export const catalogProductSchema = z.discriminatedUnion("kind", [
  catalogProductFilamentSchema,
  catalogProductPrinterSchema
]);

/** The create payload omits server-owned identity and version metadata. */
export const createCatalogProductSchema = z.discriminatedUnion("kind", [
  catalogProductFilamentSpecSchema,
  catalogProductPrinterSpecSchema
]);
export const updateCatalogProductSchema = z.union([
  catalogProductFilamentSpecSchema.partial().strict(),
  catalogProductPrinterSpecSchema.partial().strict()
]);

export const inventoryProductProfileLinkStateSchema = z.enum([
  "confirmed",
  "reported",
  "suggested"
]);

/** Details that may be recorded for one physical filament spool. */
export const filamentSpoolProfileDetailsSchema = z.object({
  lot: z.string().min(1).max(160).optional(),
  batch: z.string().min(1).max(160).optional(),
  lotCode: z.string().min(1).max(160).optional(),
  openedState: z.enum(["sealed", "open", "unknown"]).optional(),
  openedAt: isoDateSchema.optional(),
  tareMassG: z.number().finite().nonnegative().optional(),
  currentPlacement: z.string().min(1).max(240).optional(),
  dryingHistory: z.string().max(2000).optional()
}).strict();

/** Details that may be recorded for one physical printer asset. */
export const printerAssetProfileDetailsSchema = z.object({
  assetLabel: z.string().min(1).max(240).optional(),
  commissionedAt: isoDateSchema.optional(),
  location: z.string().min(1).max(240).optional(),
  condition: z.enum(["new", "good", "worn", "needs_repair", "unknown"]).optional()
}).strict();

const inventoryProductProfileMetadataShape = {
  id: idSchema,
  itemId: idSchema,
  catalogProductId: idSchema,
  linkState: inventoryProductProfileLinkStateSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  version: z.number().int().positive()
} as const;

export const inventoryProductProfileFilamentSchema = z.object({
  ...inventoryProductProfileMetadataShape,
  profileType: z.literal("filament_spool"),
  details: filamentSpoolProfileDetailsSchema
}).strict();
export const inventoryProductProfilePrinterSchema = z.object({
  ...inventoryProductProfileMetadataShape,
  profileType: z.literal("printer_asset"),
  details: printerAssetProfileDetailsSchema
}).strict();

export const inventoryProductProfileSchema = z.discriminatedUnion("profileType", [
  inventoryProductProfileFilamentSchema,
  inventoryProductProfilePrinterSchema
]);

export const createInventoryProductProfileSchema = z.discriminatedUnion("profileType", [
  inventoryProductProfileFilamentSchema.omit({ id: true, createdAt: true, updatedAt: true, version: true }),
  inventoryProductProfilePrinterSchema.omit({ id: true, createdAt: true, updatedAt: true, version: true })
]);

/**
 * The profile half of an atomic inventory/profile create has no itemId. The
 * application assigns the item identity returned by the inventory write so a
 * caller cannot create a profile pointing at a different item.
 */
export const createInventoryProductProfileWithoutItemSchema = z.discriminatedUnion("profileType", [
  inventoryProductProfileFilamentSchema.omit({ id: true, itemId: true, createdAt: true, updatedAt: true, version: true }),
  inventoryProductProfilePrinterSchema.omit({ id: true, itemId: true, createdAt: true, updatedAt: true, version: true })
]);

/** Strict request shape for the atomic exact inventory + physical profile command. */
export const createInventoryWithProductProfileSchema = z.object({
  item: createInventoryItemSchema,
  profile: createInventoryProductProfileWithoutItemSchema,
}).strict();

export const updateInventoryProductProfileSchema = z.union([
  inventoryProductProfileFilamentSchema.partial().strict(),
  inventoryProductProfilePrinterSchema.partial().strict()
]);

const snapshotDescriptorSchema = z.union([
  z.string().min(1).max(500),
  z.object({
    name: z.string().min(1).max(240).optional(),
    version: z.string().min(1).max(160).optional(),
    model: z.string().min(1).max(240).optional(),
    material: z.string().min(1).max(160).optional(),
    side: z.string().min(1).max(80).optional(),
    type: z.string().min(1).max(160).optional(),
    surface: z.string().min(1).max(160).optional(),
    diameterMm: z.number().finite().positive().optional(),
    nozzleMaterial: z.string().min(1).max(160).optional(),
    state: z.string().min(1).max(160).optional(),
    recordedAt: isoDateSchema.optional(),
    quantity: z.number().finite().nonnegative().optional()
  }).strict()
]);

const snapshotPrinterItemSchema = z.object({
  itemId: idSchema,
  catalogProductId: idSchema,
  profileId: idSchema.optional(),
  linkState: inventoryProductProfileLinkStateSchema,
  name: z.string().min(1).max(240).optional(),
  manufacturer: z.string().min(1).max(200),
  exactModel: z.string().min(1).max(240).optional(),
  exactVariant: z.string().min(1).max(240).optional(),
  technology: z.literal("fff").optional(),
  buildVolumeMm: z.object({
    x: z.number().finite().positive(),
    y: z.number().finite().positive(),
    z: z.number().finite().positive()
  }).strict().optional()
}).strict();

const snapshotCatalogFilamentSelectionSchema = z.object({
  itemId: idSchema,
  catalogProductId: idSchema,
  profileId: idSchema.optional(),
  linkState: inventoryProductProfileLinkStateSchema,
  name: z.string().min(1).max(240).optional(),
  manufacturer: z.string().min(1).max(200),
  sku: z.string().min(1).max(200).optional(),
  materialFamily: z.string().min(1).max(120).optional(),
  materialSubtype: z.string().min(1).max(120).optional(),
  colourName: z.string().min(1).max(160).optional(),
  colourCode: z.string().min(1).max(80).optional(),
  lot: z.string().min(1).max(160).optional(),
  batch: z.string().min(1).max(160).optional(),
  diameterMm: z.number().finite().positive().optional(),
  nominalNetMassG: z.number().finite().positive().optional(),
  nominalLengthM: z.number().finite().positive().optional(),
  lengthBasis: catalogProductLengthBasisSchema.optional(),
  densityGcm3: z.number().finite().positive().optional(),
  role: z.string().min(1).max(120).optional(),
  quantity: z.number().finite().positive().optional()
}).strict();

/** Stable readiness text for a physical-only filament selection. */
export const FILAMENT_CATALOG_IDENTITY_UNKNOWN_BLOCKER = "Filament catalog identity is unknown; production approval is blocked." as const;

/**
 * A physical filament can be selected before its catalog identity is known.
 * This branch is intentionally closed and contains no catalog/profile-shaped
 * fields; the application copies the physical label and evidence into the
 * immutable response snapshot after resolving the item.
 */
export const createPhysicalOnlyFilamentSelectionSchema = z.object({
  itemId: idSchema,
  catalogIdentityState: z.literal("unknown"),
  role: z.string().min(1).max(120).optional(),
  quantity: z.number().finite().positive().optional()
}).strict();

export const physicalOnlyFilamentSelectionSchema = z.object({
  itemId: idSchema,
  catalogIdentityState: z.literal("unknown"),
  physicalLabel: z.string().min(1).max(240),
  physicalEvidence: evidenceSchema,
  role: z.string().min(1).max(120).optional(),
  quantity: z.number().finite().positive().optional()
}).strict();

/**
 * Keep the legacy exact branch byte-for-byte compatible while making the new
 * physical-only branch discriminated by its explicit identity-state field.
 * A z.union is used here because adding a `known` discriminator to the legacy
 * branch would alter existing exact snapshots and their content hashes.
 */
export const snapshotFilamentSelectionSchema = z.union([
  snapshotCatalogFilamentSelectionSchema,
  physicalOnlyFilamentSelectionSchema
]);

export const buildConfigurationSnapshotSchema = z.object({
  id: idSchema,
  projectRevisionId: idSchema,
  printerItemSnapshot: snapshotPrinterItemSchema,
  filamentSelections: z.array(snapshotFilamentSelectionSchema).max(64),
  activeHotend: snapshotDescriptorSchema,
  nozzle: snapshotDescriptorSchema,
  plate: snapshotDescriptorSchema,
  accessories: z.array(snapshotDescriptorSchema).max(64),
  firmware: snapshotDescriptorSchema,
  slicer: snapshotDescriptorSchema,
  profile: snapshotDescriptorSchema,
  calibration: snapshotDescriptorSchema,
  explicitUnknowns: z.array(z.string().min(1).max(500)).max(128),
  contentSha256: z.string().length(64).regex(/^[a-f0-9]+$/),
  supersedesSnapshotId: idSchema.optional(),
  capturedAt: isoDateSchema.optional(),
  createdBy: z.string().min(1).max(200).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  createdAt: isoDateSchema
}).strict();

/*
 * A create request contains references to the selected inventory/catalog
 * records only.  The copied product facts and link state belong to the
 * immutable server-created snapshot and must be re-read at creation time.
 * Keeping this schema separate from the persisted schema prevents clients
 * from sending store-shaped evidence that would otherwise be silently
 * discarded by an adapter.
 */
const createSnapshotPrinterSelectionSchema = z.object({
  itemId: idSchema,
  catalogProductId: idSchema,
  profileId: idSchema.optional()
}).strict();

const createSnapshotFilamentSelectionSchema = z.object({
  itemId: idSchema,
  catalogProductId: idSchema,
  profileId: idSchema.optional(),
  role: z.string().min(1).max(120).optional(),
  quantity: z.number().finite().positive().optional()
}).strict();

export const createSnapshotFilamentSelectionInputSchema = z.union([
  createSnapshotFilamentSelectionSchema,
  createPhysicalOnlyFilamentSelectionSchema
]);

export const createBuildConfigurationSnapshotSchema = z.object({
  /* An optional id is useful to preserve a caller's idempotency key; the
   * service/repository generates one when omitted. It is not hashed. */
  id: idSchema.optional(),
  projectRevisionId: idSchema,
  printerItemSnapshot: createSnapshotPrinterSelectionSchema,
  filamentSelections: z.array(createSnapshotFilamentSelectionInputSchema).max(64),
  activeHotend: snapshotDescriptorSchema,
  nozzle: snapshotDescriptorSchema,
  plate: snapshotDescriptorSchema,
  accessories: z.array(snapshotDescriptorSchema).max(64),
  firmware: snapshotDescriptorSchema,
  slicer: snapshotDescriptorSchema,
  profile: snapshotDescriptorSchema,
  calibration: snapshotDescriptorSchema,
  explicitUnknowns: z.array(z.string().min(1).max(500)).max(128),
  supersedesSnapshotId: idSchema.optional()
}).strict();

/**
 * Internal write shape used after the service has resolved the selection
 * references into copied product/profile evidence. This is intentionally
 * separate from the public create schema: adapters may persist the enriched
 * evidence, but clients may not submit it as if it were authoritative.
 */
export const buildConfigurationSnapshotStorageInputSchema = z.object({
  id: idSchema.optional(),
  projectRevisionId: idSchema,
  printerItemSnapshot: snapshotPrinterItemSchema,
  filamentSelections: z.array(snapshotFilamentSelectionSchema).max(64),
  activeHotend: snapshotDescriptorSchema,
  nozzle: snapshotDescriptorSchema,
  plate: snapshotDescriptorSchema,
  accessories: z.array(snapshotDescriptorSchema).max(64),
  firmware: snapshotDescriptorSchema,
  slicer: snapshotDescriptorSchema,
  profile: snapshotDescriptorSchema,
  calibration: snapshotDescriptorSchema,
  explicitUnknowns: z.array(z.string().min(1).max(500)).max(128),
  supersedesSnapshotId: idSchema.optional(),
  capturedAt: isoDateSchema.optional(),
  createdBy: z.string().min(1).max(200).optional(),
  evidence: z.record(z.string(), z.unknown()).optional()
}).strict();

export const artifactBuildConfigurationBindingSchema = z.object({
  id: idSchema,
  artifactId: idSchema,
  buildConfigurationSnapshotId: idSchema,
  projectRevisionId: idSchema.optional(),
  createdAt: isoDateSchema
}).strict();

export const createArtifactBuildConfigurationBindingSchema = artifactBuildConfigurationBindingSchema.omit({ id: true, createdAt: true }).extend({
  id: idSchema.optional(),
  createdAt: isoDateSchema.optional()
}).strict();

/*
 * Post-project reconciliation contracts.
 *
 * Reconciliation is deliberately a review document, rather than a thin
 * alias for the public consume/release commands.  A line must contain at
 * least one explicit outcome and the application validates that the outcomes
 * account for every active reservation before it can be committed.
 */
export const reconciliationOutcomeKindSchema = z.enum([
  "consumed",
  "returned",
  "damaged_lost",
  "usable_leftover",
  "converted_asset",
  "reviewed_no_change"
]);

export const reconciliationEvidenceSchema = z.object({
  state: stockEvidenceSchema,
  source: z.string().max(500).optional(),
  sourceId: z.string().max(500).optional(),
  observedAt: isoDateSchema.optional(),
  note: z.string().max(2000).optional(),
  condition: z.enum(["new", "good", "worn", "needs_repair", "unknown"]).optional(),
  uncertainty: z.number().finite().nonnegative().optional()
}).strict();

/** One explicit disposition for part of one reservation. */
export const reconciliationOutcomeSchema = z.object({
  reservationId: idSchema.optional(),
  itemId: idSchema.optional(),
  kind: reconciliationOutcomeKindSchema,
  quantity: z.number().finite().nonnegative(),
  unit: quantityUnitSchema,
  evidence: reconciliationEvidenceSchema,
  /** Required for converted_asset; ignored for other outcomes by validation. */
  convertedAsset: createInventoryItemSchema.optional()
}).strict();

export const reconciliationLineSchema = z.object({
  bomLineId: idSchema,
  outcomes: z.array(reconciliationOutcomeSchema).min(1).max(128)
}).strict();

export const reconciliationBasisItemSchema = z.object({
  itemId: idSchema,
  version: z.number().int().positive(),
  onHand: z.number().finite().nonnegative(),
  allocated: z.number().finite().nonnegative(),
  available: z.number().finite().nonnegative(),
  unit: quantityUnitSchema
}).strict();

export const reconciliationBasisReservationSchema = z.object({
  reservationId: idSchema,
  lineId: idSchema,
  itemId: idSchema,
  quantity: z.number().finite().positive(),
  unit: quantityUnitSchema,
  status: z.enum(["active", "released", "consumed", "settled"]),
  version: z.number().int().positive()
}).strict();

export const reconciliationBasisBomLineSchema = z.object({
  bomLineId: idSchema,
  version: z.number().int().positive(),
  requiredQuantity: z.number().finite().positive(),
  unit: quantityUnitSchema
}).strict();

export const reconciliationBasisSchema = z.object({
  hash: z.string().length(64).regex(/^[a-f0-9]+$/),
  bomLines: z.array(reconciliationBasisBomLineSchema).max(512),
  reservations: z.array(reconciliationBasisReservationSchema).max(2048),
  items: z.array(reconciliationBasisItemSchema).max(2048)
}).strict();

export const reconciliationPreviewReservationChangeSchema = z.object({
  reservationId: idSchema,
  fromStatus: z.enum(["active", "released", "consumed", "settled"]),
  toStatus: z.enum(["active", "released", "consumed", "settled"]),
  quantity: z.number().finite().positive(),
  unit: quantityUnitSchema
}).strict();

export const reconciliationPreviewStockChangeSchema = z.object({
  itemId: idSchema,
  kind: z.enum(["consume", "loss", "release"]),
  quantity: z.number().finite().positive(),
  unit: quantityUnitSchema,
  beforeOnHand: z.number().finite().nonnegative(),
  afterOnHand: z.number().finite().nonnegative(),
  beforeAllocated: z.number().finite().nonnegative(),
  afterAllocated: z.number().finite().nonnegative(),
  beforeAvailable: z.number().finite().nonnegative(),
  afterAvailable: z.number().finite().nonnegative(),
  eventKey: idSchema
}).strict();

export const reconciliationPreviewAssetSchema = z.object({
  itemId: idSchema,
  name: z.string().min(1).max(240),
  kind: itemKindSchema,
  quantity: z.number().finite().positive(),
  unit: quantityUnitSchema
}).strict();

export const reconciliationPreviewLineSchema = z.object({
  bomLineId: idSchema,
  reservedQuantity: z.number().finite().nonnegative(),
  accountedQuantity: z.number().finite().nonnegative(),
  unaccountedQuantity: z.number().finite().nonnegative(),
  outcomeCount: z.number().int().nonnegative(),
  /** All three scalar totals use this one active-reservation unit. */
  unit: quantityUnitSchema
}).strict();

export const reconciliationPreviewSchema = z.object({
  lines: z.array(reconciliationPreviewLineSchema).max(512),
  reservationChanges: z.array(reconciliationPreviewReservationChangeSchema).max(2048),
  stockChanges: z.array(reconciliationPreviewStockChangeSchema).max(4096),
  createdAssets: z.array(reconciliationPreviewAssetSchema).max(2048)
}).strict();

export const reconciliationDraftSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  projectRevisionId: idSchema,
  status: z.enum(["draft", "committed"]),
  version: z.number().int().positive(),
  lines: z.array(reconciliationLineSchema).max(512),
  basis: reconciliationBasisSchema,
  preview: reconciliationPreviewSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  committedAt: isoDateSchema.optional(),
  commitId: idSchema.optional(),
  auditId: idSchema.optional()
}).strict();

export const saveReconciliationDraftSchema = z.object({
  draftId: idSchema.optional(),
  projectRevisionId: idSchema,
  expectedVersion: z.number().int().positive().optional(),
  lines: z.array(reconciliationLineSchema).max(512)
}).strict();

export const commitReconciliationSchema = z.object({
  draftId: idSchema,
  expectedVersion: z.number().int().positive().optional()
}).strict();

export const reconciliationStockChangeSchema = reconciliationPreviewStockChangeSchema.extend({
  eventId: idSchema
}).strict();

export const reconciliationReservationChangeSchema = reconciliationPreviewReservationChangeSchema.extend({
  version: z.number().int().positive()
}).strict();

export const reconciliationCommitSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  projectRevisionId: idSchema,
  draftId: idSchema,
  status: z.literal("committed"),
  basis: reconciliationBasisSchema,
  lines: z.array(reconciliationLineSchema).max(512),
  stockChanges: z.array(reconciliationStockChangeSchema).max(4096),
  reservationChanges: z.array(reconciliationReservationChangeSchema).max(2048),
  createdAssets: z.array(inventoryItemSchema).max(2048),
  committedAt: isoDateSchema,
  auditId: idSchema.optional()
}).strict();
