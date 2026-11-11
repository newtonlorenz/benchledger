import { createHash } from "node:crypto";

/**
 * Writes whose application command requires an idempotency key. When neither
 * the host Idempotency-Key header nor the idempotencyKey argument supplies
 * one, the adapter derives a deterministic key from (tool, actor, canonical
 * arguments): an identical retry replays instead of failing or duplicating.
 * Repeating the same logical command on purpose needs a fresh idempotencyKey.
 */
export const DERIVED_IDEMPOTENCY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "commission_inventory_item",
  "remove_project",
  "commit_project_setup",
  "commit_inspection_completion",
  "save_project_assembly",
  "record_requirement_offer",
  "choose_requirement_offer",
  "save_build_plan",
  "create_workstream",
  "update_work_assignment",
  "preview_bom_import",
  "commit_bom_import",
]);

/** Tools whose own backend derives a key when none is supplied. */
export const BACKEND_DERIVED_IDEMPOTENCY_TOOL_NAMES: ReadonlySet<string> = new Set(["bulk_update_inventory_items", "add_inventory_image"]);

export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,200}$/u;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function derivedIdempotencyKey(tool: string, actorId: string, input: unknown): string {
  const digest = createHash("sha256").update(`${actorId}\u0000${tool}\u0000${canonicalJson(input)}`).digest("hex");
  return `mcp:${tool}:${digest}`.slice(0, 200);
}
