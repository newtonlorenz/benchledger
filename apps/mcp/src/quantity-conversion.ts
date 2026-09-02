import { quantityConversionSchema } from "@benchledger/api-contract";
import { McpAdapterError } from "./errors.js";
import type { BomAlternativeQuantityConversion, QuantityConversion } from "./types.js";

type ApiQuantityConversion = {
  readonly inventory: { readonly quantity: 1; readonly unit: "set" };
  readonly requirement: { readonly quantity: number; readonly unit: "each" };
  readonly evidence: {
    readonly basis: "package_label" | "manufacturer_spec" | "physical_count" | "user_assertion";
    readonly observedAt: string;
    readonly source?: string;
    readonly sourceId?: string;
    readonly note?: string;
  };
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpAdapterError("INVALID_ARGUMENT", `${label} must be an object.`);
  }
  return value as UnknownRecord;
}
function keys(value: UnknownRecord, expected: readonly string[], label: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new McpAdapterError("INVALID_ARGUMENT", `${label}.${key} is not supported.`);
  }
}

/**
 * Parse the model-facing conversion contract. MCP deliberately calls the
 * requirement unit `piece`; the REST/application contract calls the same
 * canonical unit `each`.
 */
export function parseMcpQuantityConversion(value: unknown, label: string): QuantityConversion {
  const input = record(value, label);
  keys(input, ["inventory", "requirement", "evidence"], label);
  const inventory = record(input.inventory, `${label}.inventory`);
  keys(inventory, ["quantity", "unit"], `${label}.inventory`);
  const requirement = record(input.requirement, `${label}.requirement`);
  keys(requirement, ["quantity", "unit"], `${label}.requirement`);
  if (requirement.unit !== "piece") {
    throw new McpAdapterError("INVALID_ARGUMENT", `${label}.requirement.unit must be 'piece' at the MCP boundary.`);
  }
  const evidence = record(input.evidence, `${label}.evidence`);
  keys(evidence, ["basis", "observedAt", "source", "sourceId", "note"], `${label}.evidence`);
  const parsed = quantityConversionSchema.safeParse({
    ...input,
    inventory,
    requirement: { ...requirement, unit: "each" },
    evidence,
  });
  if (!parsed.success) {
    throw new McpAdapterError("INVALID_ARGUMENT", `${label} is invalid.`);
  }
  return {
    inventory: { quantity: 1, unit: "set" },
    requirement: { quantity: parsed.data.requirement.quantity, unit: "piece" },
    evidence: parsed.data.evidence,
  };
}

export function toApiQuantityConversion(value: QuantityConversion, label: string): ApiQuantityConversion {
  const parsed = parseMcpQuantityConversion(value, label);
  return {
    inventory: parsed.inventory,
    requirement: { quantity: parsed.requirement.quantity, unit: "each" },
    evidence: parsed.evidence,
  };
}

/** Map an API/application conversion back to the lossless MCP vocabulary. */
export function fromApiQuantityConversion(value: unknown, label: string): BomAlternativeQuantityConversion {
  const parsed = quantityConversionSchema.safeParse(value);
  if (!parsed.success) {
    throw new McpAdapterError("BACKEND_ERROR", `${label} is malformed.`);
  }
  return {
    inventory: { quantity: 1, unit: "set" },
    requirement: { quantity: parsed.data.requirement.quantity, unit: "piece" },
    evidence: parsed.data.evidence,
  };
}
