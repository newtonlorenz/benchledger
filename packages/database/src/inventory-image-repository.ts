import type { InventoryImage, InventoryImageGallery } from "@benchledger/api-contract";
import { DomainError } from "@benchledger/domain";
import type { BenchDatabase } from "./sqlite.js";
export function migrateInventoryImageSchema(db: BenchDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS inventory_images (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, metadata_json TEXT NOT NULL, content BLOB NOT NULL
  ); CREATE INDEX IF NOT EXISTS inventory_images_item ON inventory_images(item_id);`);
}
export class InventoryImageRepository {
  constructor(private readonly db: BenchDatabase) {}
  gallery(itemId: string): InventoryImageGallery {
    const images = this.db.all("SELECT metadata_json FROM inventory_images WHERE item_id = ? ORDER BY rowid", [itemId]).map(row => JSON.parse(String(row.metadata_json)) as InventoryImage);
    return { itemId, version: images.length, images };
  }
  content(itemId: string, imageId: string) {
    const row = this.db.get("SELECT metadata_json, content FROM inventory_images WHERE item_id = ? AND id = ?", [itemId, imageId]);
    return row ? { image: JSON.parse(String(row.metadata_json)) as InventoryImage, bytes: new Uint8Array(row.content as Uint8Array) } : undefined;
  }
  add(image: InventoryImage, bytes: Uint8Array, expectedVersion: number) {
    return this.db.transaction(() => {
      const gallery = this.gallery(image.itemId);
      if (gallery.version !== expectedVersion) throw new DomainError("version_conflict", "Images changed. Reload the gallery.");
      const total = Number(this.db.get("SELECT COALESCE(SUM(length(content)),0) AS bytes FROM inventory_images")?.bytes);
      if (gallery.images.length >= 12 || bytes.length > 512 * 1024 || total + bytes.length > 256 * 1024 * 1024) throw new DomainError("invalid_image_quota", "Image storage limit reached.");
      this.db.run("INSERT INTO inventory_images (id,item_id,metadata_json,content) VALUES (?,?,?,?)", [image.id, image.itemId, JSON.stringify(image), bytes]);
      return this.gallery(image.itemId);
    });
  }
}
