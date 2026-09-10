import { createHash, randomUUID } from "node:crypto";
import { addInventoryImageSchema, idSchema, INVENTORY_IMAGE_MAX_BYTES } from "@benchledger/api-contract";
import type { InventoryImage, InventoryImageGallery } from "@benchledger/api-contract";
import { ApplicationError } from "./errors.js";
import type { ApplicationPorts, RequestContext } from "./ports.js";
import type { ApplicationService } from "./service.js";
import type { AuditedWorkflowWriter } from "./maker-workflows.js";
export interface InventoryImagePort {
  gallery(itemId: string): Promise<InventoryImageGallery>;
  content(itemId: string, imageId: string): Promise<{ image: InventoryImage; bytes: Uint8Array } | undefined>;
  add(image: InventoryImage, bytes: Uint8Array, expectedVersion: number): Promise<InventoryImageGallery>;
  normalize(bytes: Uint8Array, mediaType: string): Promise<{ bytes: Uint8Array; width: number; height: number }>;
}
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export class InventoryImageService {
  constructor(private readonly ports: ApplicationPorts, private readonly app: ApplicationService, private readonly audited: AuditedWorkflowWriter) {}
  supports(): boolean { return this.ports.inventoryImages !== undefined; }
  private store(ctx: RequestContext) {
    if (ctx.projectId !== undefined) throw new ApplicationError("forbidden", "Inventory images require workspace-wide access.");
    if (!this.ports.inventoryImages) throw new ApplicationError("forbidden", "Inventory images are unavailable in this runtime.");
    return this.ports.inventoryImages;
  }
  private async item(id: string) {
    if (!idSchema.safeParse(id).success) throw new ApplicationError("validation", "Invalid item ID.");
    return this.app.getInventoryItem(id);
  }
  async gallery(itemId: string, ctx: RequestContext) {
    const store = this.store(ctx);
    return this.ports.unitOfWork.exclusive(async () => { await this.item(itemId); return store.gallery(itemId); });
  }
  async content(itemId: string, imageId: string, ctx: RequestContext) {
    const store = this.store(ctx);
    return this.ports.unitOfWork.exclusive(async () => {
      await this.item(itemId);
      const result = await store.content(itemId, imageId);
      if (!result) throw new ApplicationError("not_found", "Image not found.");
      if (digest(result.bytes) !== result.image.sha256) throw new ApplicationError("integrity_error", "Image integrity check failed.");
      return result;
    });
  }
  async add(itemId: string, raw: unknown, ctx: RequestContext) {
    const store = this.store(ctx), parsed = addInventoryImageSchema.safeParse(raw);
    if (!parsed.success) throw new ApplicationError("validation", "Provide a valid PNG, JPEG or WebP image of at most 2 MiB, a source kind and gallery version.");
    const input = parsed.data, bytes = Buffer.from(input.imageBase64, "base64");
    if (bytes.length > INVENTORY_IMAGE_MAX_BYTES || bytes.toString("base64") !== input.imageBase64) throw new ApplicationError("validation", "Invalid or oversized image encoding.");
    if (!ctx.idempotencyKey || ctx.idempotencyKey.length < 8 || ctx.idempotencyKey.length > 200) throw new ApplicationError("validation", "Use a stable 8–200 character Idempotency-Key for upload retries.");
    const action = "inventory.image.add";
    return this.audited({ ...ctx, fingerprint: digest(JSON.stringify({ itemId, input })) }, action, "inventory_item", itemId, async () => {
      const item = await this.item(itemId);
      if (item.retiredAt) throw new ApplicationError("conflict", "Cannot add images to a retired item.");
      const gallery = await store.gallery(itemId);
      if (gallery.version !== input.expectedVersion) throw new ApplicationError("conflict", "Images changed. Reload the gallery before adding an image.");
      if (gallery.images.length >= 12) throw new ApplicationError("quota_exceeded", "An item can have at most 12 images.");
      let normalized;
      try { normalized = await store.normalize(bytes, input.mediaType); }
      catch { throw new ApplicationError("validation", "Cannot read this image. Use a still PNG, JPEG or WebP up to 2 MiB and 16 megapixels."); }
      const image: InventoryImage = { id: `image-${randomUUID()}`, itemId, filename: input.filename, caption: input.caption, sourceKind: input.sourceKind, mediaType: "image/webp", width: normalized.width, height: normalized.height, byteLength: normalized.bytes.length, sha256: digest(normalized.bytes), originalSha256: digest(bytes), createdAt: new Date().toISOString() };
      const value = await store.add(image, normalized.bytes, input.expectedVersion);
      return { value, entityId: itemId, version: value.version };
    });
  }
}
