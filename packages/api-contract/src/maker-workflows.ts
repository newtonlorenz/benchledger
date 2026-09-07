import { z } from "zod/v3";
import { idSchema, isoDateSchema, quantityUnitSchema, createBomLineSchema, workItemKindSchema } from "./schemas.js";

const money = z.number().int().nonnegative().max(1_000_000_000_000);
const positive = z.number().finite().positive().max(1_000_000_000);
const expectedVersion = z.number().int().nonnegative();
const safeUrl = z.string().max(2000).url().refine((value) => { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }, "Use an HTTP(S) source URL without embedded credentials");
export const workflowPageSchema = z.object({ limit: z.number().int().min(1).max(100).default(25), cursor: z.string().regex(/^(0|[1-9][0-9]*)$/u).max(12).optional() }).strict();
/** Search and filter the complete revision before paging; monetary totals retain full-revision scope. */
export const sourcingPageSchema = workflowPageSchema.extend({
  query: z.string().trim().max(200).optional(),
  filter: z.enum(["all", "source", "review", "optional"]).default("all")
}).strict();
export const createRequirementOfferSchema = z.object({
  bomLineId: idSchema, expectedBomLineVersion: z.number().int().positive(),
  supplier: z.string().trim().min(1).max(240), title: z.string().trim().min(1).max(240), url: safeUrl,
  packageQuantity: positive, packageUnit: quantityUnitSchema, priceMinor: money, currency: z.string().regex(/^[A-Z]{3}$/u),
  shippingMinor: money.optional(), taxIncluded: z.enum(["yes", "no", "unknown"]).default("unknown"),
  observedAt: isoDateSchema, validForDays: z.number().int().min(1).max(365).default(30), notes: z.string().max(2000).optional()
}).strict();
export const requirementOfferSchema = createRequirementOfferSchema.omit({ expectedBomLineVersion: true }).extend({
  id: idSchema, projectId: idSchema, projectRevisionId: idSchema, bomLineVersion: z.number().int().positive(),
  createdAt: isoDateSchema, recordedBy: z.string().max(200), version: z.literal(1)
}).strict();
export const chooseRequirementOfferSchema = z.object({ bomLineId: idSchema, offerId: idSchema.nullable(), expectedVersion, expectedBomLineVersion: z.number().int().positive(), confirmedFit: z.boolean() }).strict();
export const offerChoiceSchema = z.object({ id: idSchema, projectId: idSchema, projectRevisionId: idSchema, bomLineId: idSchema, offerId: idSchema.nullable(), bomLineVersion: z.number().int().positive(), version: z.number().int().positive(), confirmedBy: z.string().max(200), updatedAt: isoDateSchema }).strict();
export type RequirementOffer = z.infer<typeof requirementOfferSchema>;
export type CreateRequirementOffer = z.infer<typeof createRequirementOfferSchema>;
export type OfferChoice = z.infer<typeof offerChoiceSchema>;
export type ChooseRequirementOffer = z.infer<typeof chooseRequirementOfferSchema>;
export interface RequirementOfferEstimate { status: "estimated" | "needs_review"; reason?: string; packages?: number; partsSupplied?: number; priceMinor?: number; shippingMinor?: number; totalMinor?: number; currency?: string; shippingKnown: boolean; taxIncluded?: "yes" | "no" | "unknown" }

const partSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(240), quantity: z.number().int().min(1).max(1_000_000), workItemId: idSchema.optional(), workItemRevisionId: idSchema.optional(), artifactId: idSchema.optional() }).strict();
const plateSchema = z.object({
  id: idSchema, name: z.string().trim().min(1).max(240), copies: z.number().int().min(1).max(10_000), printerItemId: idSchema.optional(), buildConfigurationId: idSchema.optional(),
  parts: z.array(z.object({ partId: idSchema, quantity: z.number().int().min(1).max(1_000_000) }).strict()).min(1).max(100),
  materials: z.array(z.object({ itemId: idSchema, grams: positive, role: z.enum(["model", "support", "interface"]), side: z.enum(["left", "right", "single", "unspecified"]).default("unspecified") }).strict()).max(16).default([]),
  minutes: z.number().finite().positive().max(1_000_000).optional(), notes: z.string().max(2000).optional()
}).strict();
export const buildPlanInputSchema = z.object({ expectedVersion, name: z.string().trim().min(1).max(240), parts: z.array(partSchema).min(1).max(100), plates: z.array(plateSchema).max(100), notes: z.string().max(5000).optional() }).strict().superRefine((value, ctx) => {
  const ids = new Set(value.parts.map((part) => part.id));
  if (ids.size !== value.parts.length || new Set(value.plates.map((plate) => plate.id)).size !== value.plates.length) ctx.addIssue({ code: "custom", message: "Part and plate identifiers must be unique within their lists" });
  value.plates.forEach((plate, index) => {
    if (new Set(plate.parts.map((part) => part.partId)).size !== plate.parts.length) ctx.addIssue({ code: "custom", path: ["plates", index, "parts"], message: "Combine repeated entries for the same part on a plate" });
    for (const part of plate.parts) if (!ids.has(part.partId)) ctx.addIssue({ code: "custom", path: ["plates", index, "parts"], message: "A plate refers to an unknown part" });
    if (new Set(plate.materials.map((material) => `${material.itemId}:${material.role}:${material.side}`)).size !== plate.materials.length) ctx.addIssue({ code: "custom", path: ["plates", index, "materials"], message: "Combine duplicate material selections" });
  });
});
export type BuildPlanInput = z.infer<typeof buildPlanInputSchema>;
export interface BuildPlan extends Omit<BuildPlanInput, "expectedVersion"> { id: string; projectId: string; projectRevisionId: string; version: number; contentSha256: string; createdAt: string; createdBy: string; warnings: string[]; totals: { parts: { id: string; required: number; planned: number; missing: number; excess: number }[]; materialGrams: { itemId: string; grams: number }[]; minutes: number; timeComplete: boolean }; artifactBasis: { id: string; sha256: string; revisionId?: string }[] }
export const workAssignmentInputSchema = z.object({ expectedVersion, status: z.enum(["todo", "in_progress", "blocked", "done"]), assigneeId: idSchema.nullable().optional(), dueDate: z.string().date().nullable().optional(), notes: z.string().max(5000).optional() }).strict();
export const createWorkstreamSchema = z.object({ name: z.string().trim().min(1).max(240), kind: workItemKindSchema, description: z.string().max(5000).optional() }).strict();
export type WorkAssignmentInput = z.infer<typeof workAssignmentInputSchema>;
export interface WorkAssignment extends Omit<WorkAssignmentInput, "expectedVersion"> { id: string; projectId: string; workItemId: string; version: number; updatedAt: string; updatedBy: string }
export const bomImportInputSchema = z.object({ rows: z.array(createBomLineSchema.omit({ id: true })).min(1).max(24), allowDuplicateNames: z.boolean().default(false) }).strict();
export type BomImportInput = z.infer<typeof bomImportInputSchema>;
export interface BomImportPreview { id: string; projectId: string; projectRevisionId: string; version: number; actor: string; expiresAt: string; contentSha256: string; basis: string; rows: (BomImportInput["rows"][number] & { id: string })[]; warnings: string[]; status: "active" | "committed" }
export const bomImportCommitSchema = z.object({ previewId: idSchema, expectedPreviewVersion: z.number().int().positive(), contentSha256: z.string().regex(/^[a-f0-9]{64}$/u), confirmed: z.literal(true) }).strict();
export type WorkflowKind = "requirement_offer" | "offer_choice" | "build_plan" | "work_assignment" | "bom_import_preview";
export interface WorkflowRecord { kind: WorkflowKind; id: string; projectId: string; revisionId?: string; version: number; payload: Record<string, unknown>; createdAt: string; updatedAt: string }
