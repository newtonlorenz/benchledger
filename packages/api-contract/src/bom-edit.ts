import type { BomLine, UpdateBomLine } from "./types.js";

const allocationFields = ["itemId", "role", "requiredQuantity", "unit", "optional", "constraints", "alternatives"] as const;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
};
/** Descriptive corrections are safe; reserved stock must be released before changing its planning basis. */
export function changesReservedRequirement(current: Pick<BomLine, typeof allocationFields[number]>, changes: UpdateBomLine): boolean {
  return allocationFields.some((field) => {
    if (changes[field] === undefined) return false;
    if (field === "role" && current.role == null && changes.role === "consumed") return false;
    const next = field === "itemId" && changes.itemId === null ? undefined : changes[field];
    return canonical(next) !== canonical(current[field]);
  });
}
