import { z } from "zod/v3";
import { idSchema, isoDateSchema, stockAvailabilitySchema, stockEvidenceSchema, stockReceivingPolicySchema } from "./schemas.js";

/**
 * Workspace-wide preferences that change how recorded facts are interpreted,
 * never the recorded facts themselves. Readable by every authenticated
 * caller; changing them is a human administrator decision (not an MCP tool).
 */
export const workspacePreferencesSchema = z.object({
  stockReceivingPolicy: stockReceivingPolicySchema,
  version: z.number().int().positive(),
  updatedAt: isoDateSchema
}).strict();

export const updateWorkspacePreferencesSchema = z.object({
  stockReceivingPolicy: stockReceivingPolicySchema,
  /** Optimistic concurrency: the version that was read. Also accepted as If-Match. */
  expectedVersion: z.number().int().positive().optional()
}).strict();

export const stockReceivingPolicyImpactQuerySchema = z.object({
  stockReceivingPolicy: stockReceivingPolicySchema
}).strict();

export const stockReceivingPolicyImpactItemSchema = z.object({
  itemId: idSchema,
  name: z.string().min(1).max(240),
  evidenceState: stockEvidenceSchema,
  quantity: z.number().finite().nonnegative(),
  unit: z.string().min(1).max(40),
  from: stockAvailabilitySchema,
  to: stockAvailabilitySchema,
  /** Quantity currently reserved for projects on this row. */
  allocatedQuantity: z.number().finite().nonnegative()
}).strict();

/**
 * Read-only preview of a policy change computed from current inventory.
 * `blockedBy` lists rows that would stop counting while they still hold
 * project reservations; the change is refused until they are received
 * (counted/commissioned) or the reservations are released.
 */
export const stockReceivingPolicyImpactSchema = z.object({
  from: stockReceivingPolicySchema,
  to: stockReceivingPolicySchema,
  version: z.number().int().positive(),
  gained: z.array(stockReceivingPolicyImpactItemSchema),
  lost: z.array(stockReceivingPolicyImpactItemSchema),
  blockedBy: z.array(stockReceivingPolicyImpactItemSchema),
  /** True when inventory was truncated while computing the preview. */
  truncated: z.boolean()
}).strict();

export type WorkspacePreferences = z.infer<typeof workspacePreferencesSchema>;
export type UpdateWorkspacePreferences = z.infer<typeof updateWorkspacePreferencesSchema>;
export type StockReceivingPolicy = z.infer<typeof stockReceivingPolicySchema>;
export type StockAvailability = z.infer<typeof stockAvailabilitySchema>;
export type StockReceivingPolicyImpactItem = z.infer<typeof stockReceivingPolicyImpactItemSchema>;
export type StockReceivingPolicyImpact = z.infer<typeof stockReceivingPolicyImpactSchema>;
