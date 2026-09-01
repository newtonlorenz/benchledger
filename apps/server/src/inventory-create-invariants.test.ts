import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApplicationService, type RequestContext } from "@benchledger/application";
import { createProductionRuntime } from "@benchledger/runtime";
import { createApp } from "./app.js";
import { createMemoryRuntime } from "./memory-store.js";

const context: RequestContext = {
  actor: "inventory-invariant-test",
  source: "api",
  correlationId: "inventory-invariant-test",
  scopes: new Set(["read", "write"])
};

const partialConfirmedInput = {
  id: "partial-confirmed-item",
  name: "Partially allocated board",
  kind: "electronic" as const,
  quantity: 10,
  availableQuantity: 3,
  unit: "each" as const,
  tags: [],
  links: [],
  evidence: { state: "physically_counted" as const }
};

const invalidConfirmedInput = { ...partialConfirmedInput, id: "invalid-confirmed-item", quantity: 2, availableQuantity: 3 };
const demoCredential = ["demo", "password", "please", "change"].join("-");

describe("inventory creation invariants", () => {
  it("returns a validation 400 before mutating demo inventory or audit history", async () => {
    const runtime = createMemoryRuntime();
    const app = await createApp({
      demo: true,
      runtime,
      auth: { sessionSecret: "s".repeat(48), secureCookies: false },
      logger: false
    });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: demoCredential } });
    const cookies = Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"] : [login.headers["set-cookie"] ?? ""];
    const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
    const csrf = login.json<{ csrfToken: string }>().csrfToken;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/inventory",
      headers: { cookie, "x-csrf-token": csrf },
      payload: invalidConfirmedInput
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "validation" } });
    await expect(runtime.inventory.getItem(invalidConfirmedInput.id)).resolves.toBeNull();
    await expect(runtime.ports.audit.list(50)).resolves.toMatchObject({ data: [] });
    await app.close();
  });

  it("keeps partial confirmed quantity and available stock aligned in demo and production runtimes", async () => {
    const demo = createMemoryRuntime();
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-inventory-invariant-"));
    const production = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    try {
      const demoCreated = await new ApplicationService(demo.ports).createInventoryItem(partialConfirmedInput, context);
      const productionCreated = await new ApplicationService(production.ports).createInventoryItem(partialConfirmedInput, context);

      expect(demoCreated.data).toMatchObject({ quantity: 10, availableQuantity: 3 });
      expect(productionCreated.data).toMatchObject({ quantity: 10, availableQuantity: 3 });
      expect(productionCreated.data).toMatchObject({ quantity: demoCreated.data.quantity, availableQuantity: demoCreated.data.availableQuantity });

      const [demoEvents, productionEvents] = await Promise.all([
        demo.ports.inventory.listStockEvents(partialConfirmedInput.id, 10),
        production.ports.inventory.listStockEvents(partialConfirmedInput.id, 10)
      ]);
      expect(demoEvents.data.map(({ type, quantity }) => ({ type, quantity }))).toEqual([
        { type: "count", quantity: 10 },
        { type: "allocate", quantity: 7 }
      ]);
      expect(productionEvents.data.map(({ type, quantity }) => ({ type, quantity }))).toEqual(demoEvents.data.map(({ type, quantity }) => ({ type, quantity })));

      const demoService = new ApplicationService(demo.ports);
      const productionService = new ApplicationService(production.ports);
      const [demoCount, productionCount] = await Promise.all([
        demoService.recordPhysicalCount(partialConfirmedInput.id, 8, context, "each", "physical recount"),
        productionService.recordPhysicalCount(partialConfirmedInput.id, 8, context, "each", "physical recount")
      ]);
      expect(demoCount.data).toMatchObject({ item: { quantity: 8, availableQuantity: 1, evidence: { state: "physically_counted" }, version: 2 } });
      expect(productionCount.data).toMatchObject({ item: { quantity: 8, availableQuantity: 1, evidence: { state: "physically_counted" }, version: 2 } });
      expect(productionCount.data.item).toMatchObject({
        quantity: demoCount.data.item.quantity,
        availableQuantity: demoCount.data.item.availableQuantity,
        version: demoCount.data.item.version
      });

      const [demoCountEvents, productionCountEvents] = await Promise.all([
        demo.ports.inventory.listStockEvents(partialConfirmedInput.id, 10),
        production.ports.inventory.listStockEvents(partialConfirmedInput.id, 10)
      ]);
      expect(demoCountEvents.data.map(({ type, quantity }) => ({ type, quantity }))).toEqual([
        { type: "count", quantity: 10 },
        { type: "allocate", quantity: 7 },
        { type: "count", quantity: 8 }
      ]);
      expect(productionCountEvents.data.map(({ type, quantity }) => ({ type, quantity }))).toEqual(demoCountEvents.data.map(({ type, quantity }) => ({ type, quantity })));

      const [demoBeforeInvalid, productionBeforeInvalid, demoEventsBeforeInvalid, productionEventsBeforeInvalid] = await Promise.all([
        demo.ports.inventory.getItem(partialConfirmedInput.id),
        production.ports.inventory.getItem(partialConfirmedInput.id),
        demo.ports.inventory.listStockEvents(partialConfirmedInput.id, 10),
        production.ports.inventory.listStockEvents(partialConfirmedInput.id, 10)
      ]);
      await expect(demoService.recordPhysicalCount(partialConfirmedInput.id, 6, context, "each", "below allocation")).rejects.toMatchObject({ code: "conflict" });
      await expect(productionService.recordPhysicalCount(partialConfirmedInput.id, 6, context, "each", "below allocation")).rejects.toMatchObject({ code: "conflict" });
      await expect(demo.ports.inventory.getItem(partialConfirmedInput.id)).resolves.toEqual(demoBeforeInvalid);
      await expect(production.ports.inventory.getItem(partialConfirmedInput.id)).resolves.toEqual(productionBeforeInvalid);
      await expect(demo.ports.inventory.listStockEvents(partialConfirmedInput.id, 10)).resolves.toEqual(demoEventsBeforeInvalid);
      await expect(production.ports.inventory.listStockEvents(partialConfirmedInput.id, 10)).resolves.toEqual(productionEventsBeforeInvalid);

      const controlledUpdates = [
        { quantity: 2 },
        { availableQuantity: 2 },
        { evidence: { state: "physically_counted" } },
        { unit: "gram" }
      ];
      for (const update of controlledUpdates) {
        await expect(Promise.resolve().then(() => demo.ports.inventory.updateItem(partialConfirmedInput.id, update as never, 1, context))).rejects.toMatchObject({ code: "validation" });
        await expect(Promise.resolve().then(() => production.ports.inventory.updateItem(partialConfirmedInput.id, update as never, 1, context))).rejects.toMatchObject({ code: "validation" });
      }
    } finally {
      await production.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("commissions uncertain inventory through an append-only count event in both runtimes", async () => {
    const uncertain = {
      id: "delivered-commission-item",
      name: "Delivered board",
      kind: "electronic" as const,
      quantity: 10,
      unit: "each" as const,
      tags: [],
      links: [],
      evidence: { state: "delivered_uncounted" as const, source: "delivery-record", sourceId: "delivery-1", observedAt: "2026-08-30T10:00:00.000Z" }
    };
    const commission = {
      quantity: 8,
      unit: "each" as const,
      evidence: { state: "commissioned" as const, source: "bench-commissioning", sourceId: "check-1", observedAt: "2026-08-31T10:00:00.000Z", note: "Located and tested" }
    };
    const memory = createMemoryRuntime();
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-commission-invariant-"));
    const production = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    const runtimes = [memory.ports, production.ports];
    try {
      for (const runtime of runtimes) {
        const service = new ApplicationService(runtime);
        await service.createInventoryItem(uncertain, context);
        const mutation = await service.commissionInventoryItem(uncertain.id, commission, 1, context);
        expect(mutation.data.item).toMatchObject({ quantity: 8, availableQuantity: 8, version: 2, evidence: commission.evidence });
        expect(mutation.data.event).toMatchObject({ type: "count", quantity: 8, evidence: { state: "commissioned", previousEvidence: uncertain.evidence, sourceId: "check-1" } });
        await expect(runtime.inventory.getItem(uncertain.id)).resolves.toMatchObject({ quantity: 8, availableQuantity: 8, evidence: commission.evidence, version: 2 });
        await expect(runtime.inventory.listStockEvents(uncertain.id, 10)).resolves.toMatchObject({ data: [{ type: "count", quantity: 8, evidence: { state: "commissioned" } }] });
        await expect(service.commissionInventoryItem(uncertain.id, commission, 1, context)).rejects.toMatchObject({ code: "conflict" });
      }
    } finally {
      await production.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
