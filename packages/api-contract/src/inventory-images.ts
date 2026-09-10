import { z } from "zod/v3";
export const INVENTORY_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const addInventoryImageSchema = z.object({
  expectedVersion: z.number().int().min(0),
  filename: z.string().min(1).max(160).regex(/^[^/\\\x00-\x1f\x7f]+$/u),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  imageBase64: z.string().min(4).max(4 * Math.ceil(INVENTORY_IMAGE_MAX_BYTES / 3)).regex(/^[A-Za-z0-9+/]*={0,2}$/u),
  caption: z.string().trim().max(500).default(""),
  sourceKind: z.enum(["item_photo", "reference", "generated", "unknown"])
}).strict();
export type AddInventoryImage = z.infer<typeof addInventoryImageSchema>;
export interface InventoryImage {
  id: string; itemId: string; filename: string; caption: string;
  sourceKind: AddInventoryImage["sourceKind"];
  mediaType: "image/webp"; width: number; height: number; byteLength: number;
  sha256: string; originalSha256: string; createdAt: string;
}
export interface InventoryImageGallery { itemId: string; version: number; images: InventoryImage[] }
