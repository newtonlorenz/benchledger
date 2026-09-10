import { createHash } from "node:crypto";
import { z } from "zod/v3";
import { idSchema, addInventoryImageSchema, commandJsonSchema } from "@benchledger/api-contract";
import type { ApplicationService } from "@benchledger/application";
import type { McpToolDefinition, JsonObject, McpRequestContext } from "./types.js";
import { McpAdapterError } from "./errors.js";
const schemas = {
  list_inventory_images: z.object({ itemId: idSchema }).strict(),
  add_inventory_image: z.object({ itemId: idSchema, image: addInventoryImageSchema }).strict()
};
export type InventoryImageToolName = keyof typeof schemas;
export const INVENTORY_IMAGE_TOOLS: readonly McpToolDefinition[] = Object.entries(schemas).map(([name, schema]) => ({
  name, description: name === "list_inventory_images" ? "Read image metadata and gallery version for any inventory item, including printers. Requires workspace-wide inventory:read. Returns no image bytes."
    : "Attach a still PNG/JPEG/WebP image (max 2 MiB, 16 megapixels) to inventory or a printer. Use exact base64 encoded by a trusted host from the user-approved image, never invented bytes, local paths or remote URLs. Read gallery expectedVersion first. Label item_photo, reference, generated or unknown honestly. Images are normalized, metadata stripped; stock and verification unchanged. Identical retries replay safely. Requires workspace-wide inventory:write.",
  requiredScope: name === "list_inventory_images" ? "inventory:read" : "inventory:write", mutating: name === "add_inventory_image", inputSchema: commandJsonSchema(schema) as JsonObject
}));
export function parseInventoryImageTool(name: InventoryImageToolName, raw: unknown): Record<string, unknown> {
  const parsed = schemas[name].safeParse(raw);
  if (!parsed.success) throw new McpAdapterError("INVALID_ARGUMENT", "Provide an item ID and a valid bounded inventory image command.");
  return parsed.data;
}
export async function invokeInventoryImageTool(service: ApplicationService, name: InventoryImageToolName, input: Record<string, unknown>, context: McpRequestContext) {
  if (context.projectIds !== undefined) throw new McpAdapterError("FORBIDDEN", "Inventory images require workspace-wide access.");
  const ctx = { actor: context.actorId, source: "mcp" as const, correlationId: context.correlationId ?? "inventory-image", scopes: new Set(context.scopes), idempotencyKey: context.idempotencyKey ?? `mcp:image:${createHash("sha256").update(JSON.stringify({ actor: context.actorId, name, input })).digest("hex")}` };
  return name === "list_inventory_images" ? service.inventoryImages.gallery(input.itemId as string, ctx) : service.inventoryImages.add(input.itemId as string, input.image, ctx);
}

/** Only the bounded image command gets a larger transport envelope. */
export function isInventoryImageEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.method !== "tools/call" || typeof request.params !== "object" || request.params === null) return false;
  return (request.params as Record<string, unknown>).name === "add_inventory_image";
}
