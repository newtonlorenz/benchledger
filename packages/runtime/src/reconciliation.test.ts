import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationService } from "@benchledger/application";
import type { RequestContext } from "@benchledger/application";
import { createProductionRuntime, type ProductionRuntime } from "./index.js";

const runtimes: ProductionRuntime[] = [];
const directories: string[] = [];

const context = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  actor: "reconciliation-test",
  source: "api",
  correlationId: "reconciliation-correlation",
  scopes: new Set(["read", "write"]),
  ...overrides
});

async function makeRuntime(): Promise<ProductionRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), "benchledger-reconciliation-"));
  directories.push(dataDir);
  const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
  runtimes.push(runtime);
  return runtime;
}

async function setup(runtime: ProductionRuntime, itemId = "reconciliation-item") {
  const service = new ApplicationService(runtime.ports);
  const item = await service.createInventoryItem({ id: itemId, name: "Reconciliation part", kind: "electronic", quantity: 4, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
  const project = await service.createProject({ id: `${itemId}-project`, name: "Reconciliation project", status: "planning" }, context());
  const revision = await service.createProjectRevision(project.data.id, { id: `${itemId}-revision`, name: "Initial", status: "concept" }, context());
  const line = await service.createBomLine(revision.data.id, { id: `${itemId}-line`, name: "Reconciliation part", itemId, requiredQuantity: 2, unit: "each", optional: false, alternatives: [], constraints: {} }, context());
  const reservation = await service.createReservation(revision.data.id, { id: `${itemId}-reservation`, lineId: line.data.id, itemId, quantity: 2 }, context());
  return { service, item, project, revision, line, reservation };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("post-project reconciliation", () => {
  it("keeps draft saves review-only and rolls back a mixed commit when the late audit step fails", async () => {
    const runtime = await makeRuntime();
    const { service, item, revision, line, reservation } = await setup(runtime);
    const beforeEvents = runtime.database.all("SELECT id FROM stock_events WHERE item_id = ?", [item.data.id]);
    const draft = await service.saveReconciliationDraft(revision.data.id, {
      lines: [{ bomLineId: line.data.id, outcomes: [
        { reservationId: reservation.data.id, itemId: item.data.id, kind: "consumed", quantity: 1, unit: "each", evidence: { state: "physically_counted", source: "bench" } },
        { reservationId: reservation.data.id, itemId: item.data.id, kind: "returned", quantity: 1, unit: "each", evidence: { state: "physically_counted", source: "bench" } }
      ] }]
    }, context({ idempotencyKey: "reconciliation-draft-1" }));
    expect(runtime.database.all("SELECT id FROM stock_events WHERE item_id = ?", [item.data.id])).toHaveLength(beforeEvents.length);
    expect(draft.data.preview.stockChanges.map((change) => change.kind)).toEqual(["release", "consume"]);
    expect(draft.data.preview.stockChanges).toMatchObject([
      { kind: "release", beforeOnHand: 4, afterOnHand: 4, beforeAllocated: 2, afterAllocated: 0, beforeAvailable: 2, afterAvailable: 4 },
      { kind: "consume", beforeOnHand: 4, afterOnHand: 3, beforeAllocated: 0, afterAllocated: 0, beforeAvailable: 4, afterAvailable: 3 }
    ]);

    const audit = runtime.ports.audit;
    audit.append = async () => { throw new Error("forced late audit failure"); };
    await expect(service.commitReconciliation(revision.data.id, { draftId: draft.data.id, expectedVersion: draft.data.version }, context({ idempotencyKey: "reconciliation-commit-1" }))).rejects.toThrow("forced late audit failure");

    await expect(service.getInventoryItem(item.data.id)).resolves.toMatchObject({ quantity: 4, availableQuantity: 2, version: 2 });
    await expect(service.listReservations(revision.data.id)).resolves.toMatchObject([{ id: reservation.data.id, status: "active", version: 1 }]);
    expect(runtime.database.get("SELECT id FROM reconciliation_commits WHERE project_revision_id = ?", [revision.data.id])).toBeUndefined();
    expect(runtime.database.all("SELECT id FROM stock_events WHERE item_id = ?", [item.data.id])).toHaveLength(beforeEvents.length);
  });

  it("fails closed on a stale item basis before writing reconciliation effects", async () => {
    const runtime = await makeRuntime();
    const { service, item, revision, line, reservation } = await setup(runtime, "stale-item");
    const draft = await service.saveReconciliationDraft(revision.data.id, {
      lines: [{ bomLineId: line.data.id, outcomes: [{ reservationId: reservation.data.id, itemId: item.data.id, kind: "consumed", quantity: 2, unit: "each", evidence: { state: "physically_counted" } }] }]
    }, context({ idempotencyKey: "stale-draft-1" }));
    const eventCount = runtime.database.all("SELECT id FROM stock_events WHERE item_id = ?", [item.data.id]).length;
    await service.recordPhysicalCount(item.data.id, 4, context({ idempotencyKey: "stale-count-1" }));
    await expect(service.commitReconciliation(revision.data.id, { draftId: draft.data.id, expectedVersion: draft.data.version }, context({ idempotencyKey: "stale-commit-1" }))).rejects.toMatchObject({ code: "conflict" });
    await expect(service.listReservations(revision.data.id)).resolves.toMatchObject([{ id: reservation.data.id, status: "active", version: 1 }]);
    expect(runtime.database.get("SELECT id FROM reconciliation_commits WHERE project_revision_id = ?", [revision.data.id])).toBeUndefined();
    expect(runtime.database.all("SELECT id FROM stock_events WHERE item_id = ?", [item.data.id])).toHaveLength(eventCount + 1);
  });

  it("replays an identical commit, rejects changed key payloads, and blocks a second reconciliation", async () => {
    const runtime = await makeRuntime();
    const { service, item, revision, line, reservation } = await setup(runtime, "replay-item");
    const draft = await service.saveReconciliationDraft(revision.data.id, {
      lines: [{ bomLineId: line.data.id, outcomes: [{ reservationId: reservation.data.id, itemId: item.data.id, kind: "consumed", quantity: 2, unit: "each", evidence: { state: "physically_counted" } }] }]
    }, context({ idempotencyKey: "replay-draft-1" }));
    const first = await service.commitReconciliation(revision.data.id, { draftId: draft.data.id, expectedVersion: draft.data.version }, context({ idempotencyKey: "replay-commit-1", correlationId: "first" }));
    const replay = await service.commitReconciliation(revision.data.id, { draftId: draft.data.id, expectedVersion: draft.data.version }, context({ idempotencyKey: "replay-commit-1", correlationId: "second" }));
    expect(first.data.id).toBe(replay.data.id);
    expect(replay.replayed).toBe(true);
    await expect(service.commitReconciliation(revision.data.id, { draftId: draft.data.id, expectedVersion: 999 }, context({ idempotencyKey: "replay-commit-1", correlationId: "changed" }))).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(service.commitReconciliation(revision.data.id, { draftId: draft.data.id, expectedVersion: draft.data.version }, context({ idempotencyKey: "replay-commit-2" }))).rejects.toMatchObject({ code: "conflict" });
    await expect(service.getInventoryItem(item.data.id)).resolves.toMatchObject({ quantity: 2, availableQuantity: 2 });
  });

  it("creates a bounded reusable asset while consuming only the converted source quantity", async () => {
    const runtime = await makeRuntime();
    const { service, item, revision, line, reservation } = await setup(runtime, "conversion-item");
    const draft = await service.saveReconciliationDraft(revision.data.id, {
      lines: [{ bomLineId: line.data.id, outcomes: [{
        reservationId: reservation.data.id,
        itemId: item.data.id,
        kind: "converted_asset",
        quantity: 2,
        unit: "each",
        evidence: { state: "physically_counted", note: "assembled from reserved stock" },
        convertedAsset: { name: "Reusable assembly", kind: "accessory", quantity: 1, unit: "each", tags: ["reusable"], links: [], evidence: { state: "physically_counted" } }
      }] }]
    }, context({ idempotencyKey: "conversion-draft-1" }));
    const committed = await service.commitReconciliation(revision.data.id, { draftId: draft.data.id, expectedVersion: draft.data.version }, context({ idempotencyKey: "conversion-commit-1" }));
    const assetId = committed.data.createdAssets[0]?.id;
    expect(assetId).toBeTruthy();
    await expect(service.getInventoryItem(assetId!)).resolves.toMatchObject({ kind: "accessory", quantity: 1, availableQuantity: 1, evidence: { state: "physically_counted" } });
    await expect(service.getInventoryItem(item.data.id)).resolves.toMatchObject({ quantity: 2, availableQuantity: 2 });
  });
});
