import { z } from "zod";
/** Closed subset used by typed maker commands. Unsupported schema types fail at startup instead of advertising a misleading tool. Refinements remain enforced by Zod on execution. */
export function commandJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodOptional) return commandJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return { ...commandJsonSchema(schema.removeDefault()), default: schema._def.defaultValue() };
  if (schema instanceof z.ZodNullable) return { anyOf: [commandJsonSchema(schema.unwrap()), { type: "null" }] };
  if (schema instanceof z.ZodEffects) return commandJsonSchema(schema.innerType());
  if (schema instanceof z.ZodObject) { const shape = schema.shape as Record<string, z.ZodTypeAny>; return { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, commandJsonSchema(value)])), required: Object.entries(shape).filter(([,value]) => !value.isOptional()).map(([key]) => key) }; }
  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: "string" };
    for (const check of schema._def.checks) { if (check.kind === "min") result.minLength = check.value; if (check.kind === "max") result.maxLength = check.value; if (check.kind === "regex") result.pattern = check.regex.source; if (["datetime", "date", "url", "email"].includes(check.kind)) result.format = check.kind === "datetime" ? "date-time" : check.kind === "url" ? "uri" : check.kind; }
    return result;
  }
  if (schema instanceof z.ZodNumber) { const result: Record<string, unknown> = { type: "number" }; for (const check of schema._def.checks) { if (check.kind === "int") result.type = "integer"; if (check.kind === "min") result[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value; if (check.kind === "max") result[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value; } return result; }
  if (schema instanceof z.ZodArray) return { type: "array", items: commandJsonSchema(schema.element), ...(schema._def.minLength ? { minItems: schema._def.minLength.value } : {}), ...(schema._def.maxLength ? { maxItems: schema._def.maxLength.value } : {}) };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodLiteral) return { const: schema.value, type: typeof schema.value };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodUnion) return { anyOf: schema.options.map((value: z.ZodTypeAny) => commandJsonSchema(value)) };
  throw new Error(`Unsupported command schema type: ${schema._def.typeName}`);
}
