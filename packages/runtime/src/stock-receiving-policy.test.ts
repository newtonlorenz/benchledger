import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CreateInventoryItem } from "@benchledger/api-contract";
import { ApplicationService, type RequestContext } from "@benchledger/application";
import { createDemoRuntime, createProductionRuntime } from "./index.js";

const ctx = (name: string): RequestContext => ({ actor: name, source: "ui", correlationId: name, scopes: new Set(["read", "write", "admin"]) });

const item = (id: string, state: CreateInventoryItem["evidence"]["state"], quantity: number): CreateInventoryItem => ({
  id, name: id, kind: "fastener", quantity, unit: "each", tags: [], links: [], evidence: { state }
});

async function withWorkspace<T>(run: (service: ApplicationService, revisionId: string) => Promise<T>): Promise<T> {
  const runtime = await createDemoRuntime({ seed: "empty" });
  try {
    const service = new ApplicationService(runtime.ports);
    const c = ctx("seed");
    for (const input of [item("inserts-delivered", "delivered_uncounted", 10), item("screws-ordered", "ordered_unverified", 5), item("nuts-counted", "physically_counted", 3)]) {
      await service.createInventoryItem(input, c);
    }
    await service.createProject({ id: "policy-project", name: "Policy project", status: "planned" }, c);
    const revision = await service.createProjectRevision("policy-project", { id: "policy-revision", name: "Initial", status: "concept" }, c);
    for (const [id, itemId, requiredQuantity] of [["line-inserts", "inserts-delivered", 4], ["line-screws", "screws-ordered", 2], ["line-nuts", "nuts-counted", 1]] as const) {
      await service.createBomLine(revision.data.id, { id, name: id, role: "consumed", itemId, requiredQuantity, unit: "each", optional: false, alternatives: [], constraints: {} }, c);
    }
    return await run(service, revision.data.id);
  } finally {
    await runtime.close();
  }
}

const decisions = async (service: ApplicationService, revisionId: string) =>
  Object.fromEntries((await service.evaluateBomGaps(revisionId)).lines.map((line) => [line.lineId, line.decision]));

describe("stock receiving policy (SQLite runtime)", () => {
  it("keeps the default on_receipt behaviour: ordered and delivered stock stay pending", () => withWorkspace(async (service, revisionId) => {
    await expect(service.getWorkspacePreferences()).resolves.toMatchObject({ stockReceivingPolicy: "on_receipt", version: 1 });
    expect(await decisions(service, revisionId)).toEqual({ "line-inserts": "check", "line-screws": "check", "line-nuts": "ready" });
    await expect(service.getInventoryItem("inserts-delivered")).resolves.toMatchObject({ quantity: 10, availableQuantity: 0, availability: "inspect_first", evidence: { state: "delivered_uncounted" } });
    await expect(service.createReservation(revisionId, { lineId: "line-inserts", itemId: "inserts-delivered", quantity: 4 }, ctx("reserve")))
      .rejects.toMatchObject({ code: "conflict", message: "Only physically confirmed stock can be reserved" });
    const inspections = await service.listInspections(revisionId);
    expect(inspections.data.filter((action) => action.kind === "physical_quantity").map((action) => action.itemId).sort()).toEqual(["inserts-delivered", "screws-ordered"]);
  }));

  it("previews, audits and applies on_delivery without rewriting evidence", () => withWorkspace(async (service, revisionId) => {
    const delivery = await service.previewStockReceivingPolicy("on_delivery");
    expect(delivery).toMatchObject({ from: "on_receipt", to: "on_delivery", version: 1, lost: [], blockedBy: [], truncated: false });
    expect(delivery.gained.map((row) => [row.itemId, row.from, row.to])).toEqual([["inserts-delivered", "inspect_first", "assumed"]]);
    expect((await service.previewStockReceivingPolicy("on_purchase")).gained.map((row) => row.itemId).sort()).toEqual(["inserts-delivered", "screws-ordered"]);
    await expect(service.previewStockReceivingPolicy("whenever")).rejects.toThrow();

    await expect(service.updateWorkspacePreferences({ stockReceivingPolicy: "on_delivery", expectedVersion: 7 }, ctx("stale"))).rejects.toMatchObject({ code: "conflict", details: { reason: "version_mismatch", actualVersion: 1 } });
    const changed = await service.updateWorkspacePreferences({ stockReceivingPolicy: "on_delivery", expectedVersion: 1 }, ctx("admin-person"));
    expect(changed.data).toMatchObject({ stockReceivingPolicy: "on_delivery", version: 2 });
    expect(changed.audit).toMatchObject({ action: "workspace.preferences.update", actor: "admin-person", entityType: "workspace_preferences", change: { setting: "stockReceivingPolicy", from: "on_receipt", to: "on_delivery", gained: 1, lost: 0 } });

    await expect(service.getInventoryItem("inserts-delivered")).resolves.toMatchObject({ quantity: 10, availableQuantity: 10, allocatedQuantity: 0, availability: "assumed", evidence: { state: "delivered_uncounted" } });
    await expect(service.getInventoryItem("screws-ordered")).resolves.toMatchObject({ availableQuantity: 0, availability: "ordered" });
    expect((await service.listInventory({ available: true, limit: 50 })).data.map((row) => row.id).sort()).toEqual(["inserts-delivered", "nuts-counted"]);
    expect(await decisions(service, revisionId)).toEqual({ "line-inserts": "ready", "line-screws": "check", "line-nuts": "ready" });
    const gap = (await service.evaluateBomGaps(revisionId)).lines.find((line) => line.lineId === "line-inserts");
    expect(gap?.candidates[0]).toMatchObject({ evidenceState: "delivered_uncounted", availability: "assumed", suppliedQuantity: 4 });
    expect(gap?.reasons.join(" ")).toMatch(/delivered but not yet counted/);
    // The inspect-first queue no longer nags about trusted delivered stock.
    const actions = (await service.listInspections(revisionId)).data.filter((action) => action.kind === "physical_quantity");
    expect(actions.map((action) => action.itemId)).toEqual(["screws-ordered"]);

    // Replaying the same policy is a no-op that keeps the version.
    await expect(service.updateWorkspacePreferences({ stockReceivingPolicy: "on_delivery" }, ctx("again"))).resolves.toMatchObject({ data: { version: 2 } });
  }));

  it("reserves policy-trusted stock, refuses to strand it, and treats a count as receiving", () => withWorkspace(async (service, revisionId) => {
    await service.updateWorkspacePreferences({ stockReceivingPolicy: "on_purchase" }, ctx("admin"));
    expect(await decisions(service, revisionId)).toEqual({ "line-inserts": "ready", "line-screws": "ready", "line-nuts": "ready" });
    await service.createReservation(revisionId, { id: "reserve-inserts", lineId: "line-inserts", itemId: "inserts-delivered", quantity: 4 }, ctx("reserve"));
    await expect(service.getInventoryItem("inserts-delivered")).resolves.toMatchObject({ quantity: 10, availableQuantity: 6, allocatedQuantity: 4, availability: "assumed", evidence: { state: "delivered_uncounted" } });
    await expect(service.createReservation(revisionId, { lineId: "line-screws", itemId: "screws-ordered", quantity: 9 }, ctx("too-many"))).rejects.toMatchObject({ code: "conflict" });

    // Switching back would leave a reservation on stock that no longer counts.
    const impact = await service.previewStockReceivingPolicy("on_receipt");
    expect(impact.blockedBy.map((row) => [row.itemId, row.allocatedQuantity])).toEqual([["inserts-delivered", 4]]);
    await expect(service.updateWorkspacePreferences({ stockReceivingPolicy: "on_receipt" }, ctx("admin"))).rejects.toMatchObject({ code: "conflict", details: { reason: "policy_change_strands_reservations", itemIds: ["inserts-delivered"] } });
    await expect(service.getWorkspacePreferences()).resolves.toMatchObject({ stockReceivingPolicy: "on_purchase" });

    // Generic stock movements cannot silently adjust a claimed quantity.
    await expect(service.recordStockEvent({ itemId: "inserts-delivered", type: "receipt", quantity: 5, unit: "each" }, ctx("receipt"))).rejects.toMatchObject({ code: "conflict", details: { reason: "evidence_not_received" } });

    // A physical count of delivered stock is receiving it.
    const received = await service.recordPhysicalCount("inserts-delivered", 9, ctx("count"));
    expect(received.data.item).toMatchObject({ quantity: 9, availableQuantity: 5, allocatedQuantity: 4, availability: "confirmed", evidence: { state: "physically_counted" } });
    expect(received.audit.change).toMatchObject({ received: true, evidenceFrom: "delivered_uncounted", evidenceTo: "physically_counted" });
    expect(received.data.event).toMatchObject({ type: "count", quantity: 9 });

    await expect(service.updateWorkspacePreferences({ stockReceivingPolicy: "on_receipt" }, ctx("admin"))).resolves.toMatchObject({ data: { stockReceivingPolicy: "on_receipt", version: 3 } });
    expect(await decisions(service, revisionId)).toEqual({ "line-inserts": "ready", "line-screws": "check", "line-nuts": "ready" });
  }));

  it("persists the from/to change summary on the audit row", async () => {
    const runtime = await createDemoRuntime({ seed: "empty" });
    try {
      const changed = await new ApplicationService(runtime.ports).updateWorkspacePreferences({ stockReceivingPolicy: "on_purchase" }, ctx("auditor"));
      const stored = (await runtime.ports.audit.list(10)).data.find((event) => event.id === changed.audit.id);
      expect(stored).toMatchObject({ actor: "auditor", action: "workspace.preferences.update", change: { setting: "stockReceivingPolicy", from: "on_receipt", to: "on_purchase" } });
    } finally { await runtime.close(); }
  });

  it("persists the policy across a durable reopen", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-policy-"));
    try {
      const first = await createProductionRuntime({ dataDir, seedStarterCatalog: false });
      await new ApplicationService(first.ports).updateWorkspacePreferences({ stockReceivingPolicy: "on_delivery", expectedVersion: 1 }, ctx("admin"));
      await first.close();
      const second = await createProductionRuntime({ dataDir, seedStarterCatalog: false });
      try {
        await expect(new ApplicationService(second.ports).getWorkspacePreferences()).resolves.toMatchObject({ stockReceivingPolicy: "on_delivery", version: 2 });
      } finally { await second.close(); }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
