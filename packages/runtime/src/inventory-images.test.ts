import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ApplicationService } from "@benchledger/application";
import { createProductionRuntime, backupProductionRuntime, restoreProductionBackup } from "./index.js";
const ctx = { actor: "fixture", source: "api" as const, correlationId: "fixture", scopes: new Set(["read", "write"]), idempotencyKey: "persist-image-command" };
const upload = { expectedVersion: 0, filename: "fixture.png", mediaType: "image/png", imageBase64: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMw6piAFTEMpAQAEKQ94TX+ea8AAAAASUVORK5CYII=", sourceKind: "generated" };
it("persists image bytes and replay receipts across restart and backup/restore; audit failure rolls back", async () => {
  const root = await mkdtemp(join(tmpdir(), "benchledger-image-test-"));
  let runtime = await createProductionRuntime({ dataDir: join(root, "data") });
  try {
    let service = new ApplicationService(runtime.ports);
    await service.createInventoryItem({ id: "image-printer", name: "Synthetic printer", kind: "printer", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, { ...ctx, idempotencyKey: "create-fixture-printer" });
    const fail = vi.spyOn(runtime.ports.audit, "append").mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(service.inventoryImages.add("image-printer", upload, ctx)).rejects.toThrow(); fail.mockRestore();
    expect(runtime.database.all("SELECT id FROM inventory_images")).toHaveLength(0);
    const result = await service.inventoryImages.add("image-printer", upload, ctx), image = result.data.images[0]!;
    const original = await service.inventoryImages.content("image-printer", image.id, ctx);
    await runtime.close(); runtime = await createProductionRuntime({ dataDir: join(root, "data") }); service = new ApplicationService(runtime.ports);
    expect(await service.inventoryImages.add("image-printer", upload, ctx)).toMatchObject({ replayed: true });
    expect(await service.inventoryImages.content("image-printer", image.id, ctx)).toEqual(original);
    await backupProductionRuntime(runtime, join(root, "backup"));
    const restored = await restoreProductionBackup(join(root, "backup"), join(root, "restore"));
    try { expect(await new ApplicationService(restored.ports).inventoryImages.content("image-printer", image.id, ctx)).toEqual(original); } finally { await restored.close(); }
    runtime.database.run("UPDATE inventory_images SET content = ? WHERE id = ?", [new Uint8Array([1,2,3]), image.id]);
    await expect(service.inventoryImages.content("image-printer", image.id, ctx)).rejects.toMatchObject({ code: "integrity_error" });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
