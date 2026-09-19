import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApplicationService } from "@benchledger/application";
import type { RequestContext } from "@benchledger/application";
import { inventoryListQuerySchema } from "@benchledger/api-contract";
import { createProductionRuntime } from "@benchledger/runtime";
import { createApplicationBackend } from "@benchledger/mcp";
import { createMemoryRuntime } from "./memory-store.js";

const context: RequestContext = { actor: "inventory-test", source: "api", correlationId: "inventory-test", scopes: new Set(["read", "write"]) };
const mcpContext = { actorId: "inventory-test", scopes: ["inventory:read" as const] };
for (const mode of ["memory", "durable"] as const) describe(`${mode} inventory workspace`, () => {
  it("filters before pagination and gives AI clients the same queues, sort and repair condition", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-inventory-test-"));
    const runtime = mode === "memory" ? createMemoryRuntime() : await createProductionRuntime({ dataDir });
    try {
      const service = new ApplicationService(runtime.ports);
      for (let index = 0; index < 31; index++) await service.createInventoryItem({
        id: `fixture-${index}`, name: `Part ${String(index).padStart(2,"0")}`, kind: "electronic", quantity: index === 30 ? 0 : 4, unit: "each", tags: [], links: [],
        location: index % 2 === 0 ? "Drawer A" : "Drawer B", condition: index === 29 ? "needs_repair" : "good",
        evidence: { state: index < 26 ? "delivered_uncounted" : "physically_counted" },
      }, context);
      const first = await service.listInventory({ stockView: "available", sort: "name_desc", limit: 2 });
      expect(first.data.map((item) => item.id)).toEqual(["fixture-28", "fixture-27"]);
      expect(first.total).toBe(3);
      const second = await service.listInventory({ stockView: "available", sort: "name_desc", cursor: first.nextCursor!, limit: 2 });
      expect(second.data.map((item) => item.id)).toEqual(["fixture-26"]);
      expect(second.nextCursor).toBeUndefined();
      expect((await service.listInventory({ stockView: "depleted", limit: 25 })).data.map((item) => item.id)).toEqual(["fixture-30"]);
      expect((await service.listInventory({ stockView: "check", sort: "name_desc", location: "Drawer B", limit: 2 })).data.map((item) => item.id)).toEqual(["fixture-29", "fixture-25"]);
      const backend = createApplicationBackend(service);
      const response = await backend.inventory.list({ stockView: "available", sort: "name_desc", limit: 2 }, mcpContext);
      expect(response.items.map((item) => item.id)).toEqual(["fixture-28", "fixture-27"]);
      expect(response.items[0]?.stockViews).toContain("available");
      const checks = await backend.inventory.list({ stockView: "check", sort: "name_desc", location: "Drawer B", limit: 1 }, mcpContext);
      expect(checks.items[0]).toMatchObject({ id: "fixture-29", stockCondition: "needs_repair", stockViews: ["check"] });
    } finally {
      if ("close" in runtime) await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
it("validates shared query enums and rejects unknown stock views on HTTP", () => {
  expect(inventoryListQuerySchema.parse({ stockView: "check", sort: "location", location: "Drawer A" })).toMatchObject({ stockView: "check", sort: "location", location: "Drawer A" });
  for (const input of [{ stockView: "ready_to_build" }, { sort: "quantity" }]) {
    expect(() => inventoryListQuerySchema.parse(input)).toThrow();
  }
});
