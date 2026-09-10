import { ApplicationError } from "@benchledger/application";
import type { InventoryImagePort } from "@benchledger/application";
import type { InventoryImage } from "@benchledger/api-contract";
import { normalizeInventoryImage } from "@benchledger/artifacts";
export class MemoryInventoryImages implements InventoryImagePort {
  private records = new Map<string, { image: InventoryImage; bytes: Uint8Array }>();
  normalize = normalizeInventoryImage;
  snapshot() { const records = structuredClone(this.records); return () => { this.records = records; }; }
  async gallery(itemId: string) { const images = [...this.records.values()].filter(row => row.image.itemId === itemId).map(row => structuredClone(row.image)); return { itemId, version: images.length, images }; }
  async content(itemId: string, imageId: string) { const row = this.records.get(imageId); return row?.image.itemId === itemId ? structuredClone(row) : undefined; }
  async add(image: InventoryImage, bytes: Uint8Array, expectedVersion: number) {
    const gallery = await this.gallery(image.itemId);
    if (gallery.version !== expectedVersion) throw new ApplicationError("conflict", "Images changed. Reload the gallery.");
    const total = [...this.records.values()].reduce((sum,row) => sum + row.bytes.length, 0);
    if (gallery.images.length >= 12 || bytes.length > 512 * 1024 || total + bytes.length > 256 * 1024 * 1024) throw new ApplicationError("quota_exceeded", "Image storage limit reached.");
    this.records.set(image.id, structuredClone({ image, bytes })); return this.gallery(image.itemId);
  }
}
