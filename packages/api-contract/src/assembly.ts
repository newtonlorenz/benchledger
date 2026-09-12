import { z } from "zod/v3";
import { idSchema } from "./schemas.js";

export const assemblyVectorSchema = z.tuple([z.number().finite().min(-1e7).max(1e7), z.number().finite().min(-1e7).max(1e7), z.number().finite().min(-1e7).max(1e7)]);
export const assemblySourceSchema = z.object({
  artifactId: idSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  // STEP declares its own units; this choice applies to GLB and STL coordinates.
  unit: z.enum(["millimetre", "centimetre", "metre", "inch"]), upAxis: z.enum(["y", "z"]).default("z")
}).strict();
export const inspectAssemblySchema = z.object({ sources: z.array(assemblySourceSchema).min(1).max(16) }).strict().superRefine((value, ctx) => {
  if (new Set(value.sources.map(s => s.artifactId)).size !== value.sources.length) ctx.addIssue({ code: "custom", message: "Select each source file once" });
});
export const assemblyPartSchema = z.object({
  id: idSchema, artifactId: idSchema, nodeId: idSchema, name: z.string().trim().min(1).max(160),
  group: z.string().trim().max(160).default(""), color: z.string().regex(/^#[a-fA-F0-9]{6}$/u).default("#b6aa91"),
  position: assemblyVectorSchema.default([0, 0, 0]), rotation: assemblyVectorSchema.default([0, 0, 0]),
  explode: assemblyVectorSchema, material: z.string().max(240).default(""), notes: z.string().max(2000).default(""),
  bomLineId: idSchema.optional()
}).strict();
export const assemblyStepSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(160), partIds: z.array(idSchema).min(1).max(300), notes: z.string().max(3000).default("") }).strict();
export const assemblyInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(160),
  sources: z.array(assemblySourceSchema).min(1).max(16), parts: z.array(assemblyPartSchema).min(1).max(300),
  steps: z.array(assemblyStepSchema).max(100).default([]), notes: z.string().max(5000).default("")
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.parts.map(p => p.id));
  if (ids.size !== value.parts.length || new Set(value.steps.map(s => s.id)).size !== value.steps.length || new Set(value.sources.map(s => s.artifactId)).size !== value.sources.length) ctx.addIssue({ code: "custom", message: "Part, step and source identifiers must be unique" });
  for (const part of value.parts) if (!value.sources.some(s => s.artifactId === part.artifactId)) ctx.addIssue({ code: "custom", message: "A part refers to an unknown source" });
  for (const step of value.steps) if (new Set(step.partIds).size !== step.partIds.length || step.partIds.some(id => !ids.has(id))) ctx.addIssue({ code: "custom", message: "A build step has duplicate or unknown parts" });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 108_000) ctx.addIssue({ code: "custom", message: "Assembly metadata exceeds 108 KB; shorten notes or split the assembly" });
});
export type AssemblySource = z.infer<typeof assemblySourceSchema>;
export type AssemblyPart = z.infer<typeof assemblyPartSchema>;
export type AssemblyInput = z.infer<typeof assemblyInputSchema>;
export type AssemblyVector = z.infer<typeof assemblyVectorSchema>;
export interface ProjectAssembly extends Omit<AssemblyInput, "expectedVersion"> {
  id: string; projectId: string; projectRevisionId: string; version: number; contentSha256: string; updatedAt: string; updatedBy: string;
}
/** Normalised, static triangles in millimetres. Geometry is derived, never saved over CAD. */
export interface AssemblyMesh { nodeId: string; name: string; group: string; color: string; positions: number[]; indices: number[] }
export interface AssemblyGeometry extends AssemblyMesh { artifactId: string }
export interface AssemblyInspection { sources: AssemblySource[]; parts: AssemblyPart[]; warnings: string[]; geometry: AssemblyGeometry[] }
export interface AssemblyRead { assembly: ProjectAssembly | null; warnings: string[] }
