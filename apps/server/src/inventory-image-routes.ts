import { addInventoryImageSchema, commandJsonSchema } from "@benchledger/api-contract";
import type { FastifyInstance } from "fastify";
import type { ApplicationService } from "@benchledger/application";
import type { MakerRouteAccess } from "./maker-workflow-routes.js";
export function registerInventoryImageRoutes(app: FastifyInstance, service: ApplicationService, access: MakerRouteAccess) {
  const root = "/api/v1/inventory/:id/images";
  app.get(root, async request => { access.check(request, false); return service.inventoryImages.gallery((request.params as { id: string }).id, access.context(request)); });
  app.post(root, { bodyLimit: 3 * 1024 * 1024 }, async request => { access.check(request, true); return service.inventoryImages.add((request.params as { id: string }).id, request.body, access.context(request)); });
  app.get(`${root}/:imageId/content`, async (request, reply) => {
    access.check(request, false);
    const { id, imageId } = request.params as { id: string; imageId: string };
    const { bytes } = await service.inventoryImages.content(id, imageId, access.context(request));
    return reply.type("image/webp").header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "default-src 'none'; sandbox").header("Content-Disposition", 'inline; filename="inventory-image.webp"').send(Buffer.from(bytes));
  });
}
export function inventoryImageOpenApi() {
  const parameter = { name: "id", in: "path", required: true, schema: { type: "string" } };
  const responses = { "200": { description: "Image gallery metadata or audited mutation" }, "400": { description: "Invalid image" }, "403": { description: "Workspace-wide access required" }, "409": { description: "Stale gallery or conflicting retry" } };
  return {
    "/inventory/{id}/images": {
      get: { summary: "Read inventory image gallery", parameters: [parameter], responses },
      post: { summary: "Add a bounded raster image to any inventory item, including printers", description: "PNG/JPEG/WebP, at most 2 MiB and 16 megapixels; normalized WebP without metadata. Up to 12 images per item. expectedVersion is the gallery version. Stock and verification are unchanged.", parameters: [parameter, { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } }], requestBody: { required: true, content: { "application/json": { schema: commandJsonSchema(addInventoryImageSchema) } } }, responses }
    },
    "/inventory/{id}/images/{imageId}/content": { get: { summary: "Read authenticated normalized image bytes", parameters: [parameter, { ...parameter, name: "imageId" }], responses: { "200": { description: "Image", content: { "image/webp": { schema: { type: "string", format: "binary" } } } }, "403": responses["403"], "404": { description: "Image not found on this item" } } } }
  };
}
