import { z } from "zod/v3";
import { idSchema, isoDateSchema } from "./schemas.js";
export const memberRoleSchema = z.enum(["viewer", "editor", "admin"]);
const username = z.string().trim().toLowerCase().min(3).max(80).regex(/^[a-z0-9][a-z0-9._@+-]*$/u);
const password = z.string().min(12).max(512);
export const teamMemberSchema = z.object({ id: idSchema, username, name: z.string().trim().min(1).max(120), role: memberRoleSchema, projectIds: z.array(idSchema).max(100).optional(), enabled: z.boolean(), version: z.number().int().positive(), createdAt: isoDateSchema, updatedAt: isoDateSchema }).strict();
export type TeamMember = z.infer<typeof teamMemberSchema>;
export interface TeamStatus { enabled: boolean; version: number }
export const createTeamMemberSchema = z.object({ username, name: z.string().trim().min(1).max(120), role: memberRoleSchema, projectIds: z.array(idSchema).max(100).optional(), password }).strict();
export const enableTeamSchema = createTeamMemberSchema.omit({ role: true, projectIds: true }).extend({ confirmed: z.literal(true), currentPassword: z.string().max(512).optional() }).strict();
export const updateTeamMemberSchema = z.object({ expectedVersion: z.number().int().positive(), name: z.string().trim().min(1).max(120), role: memberRoleSchema, projectIds: z.array(idSchema).max(100).nullable().optional(), enabled: z.boolean() }).strict();
export const teamPasswordSchema = z.object({ expectedVersion: z.number().int().positive(), newPassword: password, currentPassword: password }).strict();
export const memberLoginSchema = z.object({ username, password }).strict();
