import { describe, expect, it } from "vitest";
import { STOCK_RECEIVING_POLICIES } from "@benchledger/domain";
import { stockReceivingPolicySchema } from "@benchledger/api-contract";
import type { BomLine, InventoryItem } from "@benchledger/api-contract";
import { evaluateBomGapsFromData, notInStockReason } from "./service/gap-evaluation.js";
import { inStockReservationRule } from "./service/shared.js";
import { ApplicationService } from "./service.js";
import type { ApplicationPorts, RequestContext } from "./ports.js";

const now = "2026-11-01T00:00:00.000Z";
const stock = (id: string, state: InventoryItem["evidence"]["state"], availableQuantity: number): InventoryItem => ({
  id, name: id, kind: "fastener", quantity: 10, availableQuantity, allocatedQuantity: 10 - availableQuantity > 0 && availableQuantity > 0 ? 10 - availableQuantity : 0, unit: "each",
  tags: [], links: [], evidence: { state }, createdAt: now, updatedAt: now, version: 1
});
const line = (id: string, itemId: string): BomLine => ({
  id, revisionId: "rev", name: id, role: "consumed", itemId, requiredQuantity: 4, unit: "each", optional: false, alternatives: [], constraints: {}, createdAt: now, updatedAt: now, version: 1
});

describe("stock receiving policy in application rules", () => {
  it("mirrors the domain policy list in the API contract", () => {
    expect(stockReceivingPolicySchema.options).toEqual([...STOCK_RECEIVING_POLICIES]);
  });

  it("evaluates BOM gaps under every policy with truthful candidate evidence", () => {
    // The runtime projects availableQuantity from the same policy; mirror it here.
    const inventoryFor = (policy: string): InventoryItem[] => [
      stock("delivered", "delivered_uncounted", policy === "on_receipt" ? 0 : 10),
      stock("ordered", "ordered_unverified", policy === "on_purchase" ? 10 : 0),
      stock("counted", "physically_counted", 10)
    ];
    const lines = [line("l-delivered", "delivered"), line("l-ordered", "ordered"), line("l-counted", "counted")];
    const results = Object.fromEntries(STOCK_RECEIVING_POLICIES.map((policy) => {
      const gaps = evaluateBomGapsFromData("rev", lines, inventoryFor(policy), [], policy);
      return [policy, Object.fromEntries(gaps.lines.map((gap) => [gap.lineId, `${gap.decision}:${gap.candidates[0]?.availability}`]))];
    }));
    expect(results).toEqual({
      on_purchase: { "l-delivered": "ready:assumed", "l-ordered": "ready:assumed", "l-counted": "ready:confirmed" },
      on_delivery: { "l-delivered": "ready:assumed", "l-ordered": "check:ordered", "l-counted": "ready:confirmed" },
      on_receipt: { "l-delivered": "check:inspect_first", "l-ordered": "check:ordered", "l-counted": "ready:confirmed" }
    });
    const purchase = evaluateBomGapsFromData("rev", lines, inventoryFor("on_purchase"), [], "on_purchase");
    expect(purchase.lines[0]?.candidates[0]).toMatchObject({ evidenceState: "delivered_uncounted", suppliedQuantity: 4 });
    expect(purchase.lines[0]?.reasons.join(" ")).toMatch(/not yet counted \(receiving policy: when bought\)/);
    expect(purchase.lines[2]?.reasons).toContain("Physically confirmed stock covers part or all of this requirement.");
    const delivery = evaluateBomGapsFromData("rev", lines, inventoryFor("on_delivery"), [], "on_delivery");
    expect(delivery.lines[1]?.reasons).toContain(notInStockReason("on_delivery"));
    const short = evaluateBomGapsFromData("rev", [{ ...line("l-short", "counted"), requiredQuantity: 20 }], inventoryFor("on_delivery"), [], "on_delivery");
    expect(short.lines[0]?.reasons).toContain("No in-stock quantity covers the remaining quantity.");
    expect(delivery.lines[0]?.reasons.join(" ")).toMatch(/when delivered/);
    expect(notInStockReason("on_receipt")).toMatch(/needs a physical count/);
    expect(notInStockReason("on_purchase")).toMatch(/needs a physical count/);
  });

  it("words the reservation rule for the active policy", () => {
    expect(inStockReservationRule("on_receipt")).toBe("Only physically confirmed stock can be reserved");
    expect(inStockReservationRule("on_delivery")).toMatch(/delivered or physically confirmed/);
    expect(inStockReservationRule("on_purchase")).toMatch(/bought, delivered or physically confirmed/);
  });

  it("keeps legacy hosts without a preferences port on the conservative default", async () => {
    const ports = {
      inventory: { listItems: async () => ({ data: [stock("delivered", "delivered_uncounted", 0)], limit: 200 }) },
      unitOfWork: { run: async (operation: () => Promise<unknown>) => operation(), transactional: async (operation: () => Promise<unknown>) => operation(), exclusive: async (operation: () => Promise<unknown>) => operation() }
    } as unknown as ApplicationPorts;
    const service = new ApplicationService(ports);
    await expect(service.getWorkspacePreferences()).resolves.toMatchObject({ stockReceivingPolicy: "on_receipt", version: 1 });
    await expect(service.previewStockReceivingPolicy("on_delivery")).resolves.toMatchObject({ gained: [{ itemId: "delivered", from: "inspect_first", to: "assumed" }] });
    const ctx: RequestContext = { actor: "admin", source: "ui", correlationId: "c", scopes: new Set(["admin"]) };
    await expect(service.updateWorkspacePreferences({ stockReceivingPolicy: "on_delivery" }, ctx)).rejects.toMatchObject({ code: "integrity_error" });
  });
});
