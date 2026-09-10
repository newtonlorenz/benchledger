import type { InventoryImagePort } from "@benchledger/application";
import { normalizeInventoryImage } from "@benchledger/artifacts";
import type { InventoryImage } from "@benchledger/api-contract";
import type { InventoryImageRepository } from "@benchledger/database";
import { attempt } from "./utils.js";
export class ProductionInventoryImageAdapter implements InventoryImagePort {
  constructor(private readonly repository: InventoryImageRepository) {}
  normalize = normalizeInventoryImage;
  gallery(itemId: string) { return attempt(() => this.repository.gallery(itemId)); }
  content(itemId: string, imageId: string) { return attempt(() => this.repository.content(itemId, imageId)); }
  add(image: InventoryImage, bytes: Uint8Array, expectedVersion: number) { return attempt(() => this.repository.add(image, bytes, expectedVersion)); }
}
