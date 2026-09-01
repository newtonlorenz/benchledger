import { DomainError } from "./errors.js";

/** The single project lifecycle shared by every product surface. */
export const PROJECT_LIFECYCLE = [
  "idea",
  "planned",
  "ready",
  "building",
  "validating",
  "complete",
  "archived"
] as const;

export type ProjectLifecycle = (typeof PROJECT_LIFECYCLE)[number];

/** Values used by older persisted/API records before MPM-002. */
export type LegacyProjectStatus = "active" | "on_hold" | "planning" | "in_progress" | "validation" | "complete" | "retired";

const LIFECYCLE_SET: ReadonlySet<string> = new Set(PROJECT_LIFECYCLE);

export function isProjectLifecycle(value: unknown): value is ProjectLifecycle {
  return typeof value === "string" && LIFECYCLE_SET.has(value);
}

/**
 * Convert a legacy value found in storage or an old seed.  This function is
 * intentionally conservative: `active` and `on_hold` carry no reliable
 * progress signal, so both return the earliest actionable state, `idea`.
 */
export function normalizeProjectLifecycle(value: unknown): ProjectLifecycle | undefined {
  if (isProjectLifecycle(value)) return value;
  if (typeof value !== "string") return undefined;
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

/** Canonicalize a status at a trusted boundary, rejecting unknown values. */
export function canonicalProjectStatus(value: unknown): ProjectLifecycle {
  if (!isProjectLifecycle(value)) throw new DomainError("invalid_project_status", "project lifecycle must be a canonical status");
  return value;
}

/**
 * Validate a lifecycle target without imposing adjacency restrictions.  A
 * user may intentionally move a plan back after a design change; evidence
 * state remains independent and is never reset by this helper.
 */
export function projectLifecycleTransition(_from: unknown, to: unknown): ProjectLifecycle {
  if (!isProjectLifecycle(to)) throw new DomainError("invalid_project_status", "project lifecycle must be a canonical status");
  return to;
}

export interface ProjectBlocked {
  readonly blocked: boolean;
  readonly reasons: readonly string[];
}

/** Derive blocked from actionable reasons; blocked is never a lifecycle value. */
export function deriveProjectBlocked(reasons: readonly string[]): ProjectBlocked {
  const uniqueReasons = [...new Set(reasons.map((reason) => reason.trim()).filter((reason) => reason.length > 0))];
  return { blocked: uniqueReasons.length > 0, reasons: uniqueReasons };
}
