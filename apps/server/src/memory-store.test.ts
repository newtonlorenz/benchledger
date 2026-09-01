import { describe, expect, it } from "vitest";
import { createMemoryRuntime, MemoryUnitOfWork } from "./memory-store.js";

describe("MemoryInventory", () => {
  it("normalizes search and enforces the REST inventory list bounds", async () => {
    const runtime = createMemoryRuntime();
    await runtime.inventory.createItem({
      id: "normalized-search-item",
      name: "PETG spool",
      kind: "filament",
      quantity: 1,
      unit: "each",
      tags: [],
      links: [],
      evidence: { state: "unknown" }
    });

    await expect(runtime.inventory.listItems({ q: "  petg  ", limit: 1 })).resolves.toMatchObject({ data: [{ id: "normalized-search-item" }] });
    await expect(runtime.inventory.listItems({ q: "q".repeat(201), limit: 1 })).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.inventory.listItems({ limit: 0 })).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.inventory.listItems({ limit: 201 })).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.inventory.listItems({ limit: 1, cursor: "c".repeat(201) })).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.inventory.listItems({ limit: 1, categoryNodeId: "category-tools", unassigned: true })).rejects.toMatchObject({ code: "validation" });
  });

  it("promotes an unknown physical count to available stock", async () => {
    const runtime = createMemoryRuntime();
    await runtime.inventory.createItem({
      id: "unknown-count-item",
      name: "Unknown count item",
      kind: "electronic",
      quantity: 0,
      unit: "each",
      tags: [],
      links: [],
      evidence: { state: "unknown" }
    });

    const mutation = await runtime.inventory.recordPhysicalCount("unknown-count-item", 4, {
      actor: "memory-store-test",
      source: "api",
      correlationId: "memory-store-count-test",
      scopes: new Set(["write"])
    });

    expect(mutation.item).toMatchObject({
      quantity: 4,
      availableQuantity: 4,
      evidence: { state: "physically_counted" }
    });
  });
});

describe("MemoryUnitOfWork", () => {
  it("serializes concurrent work and permits nested calls", async () => {
    const unitOfWork = new MemoryUnitOfWork();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });

    const first = unitOfWork.transactional(async () => {
      order.push("first:start");
      markStarted();
      await gate;
      await unitOfWork.exclusive(() => { order.push("nested"); });
      order.push("first:end");
      return "first";
    });
    const second = unitOfWork.run(() => {
      order.push("second");
      return "second";
    });

    await started;
    expect(order).toEqual(["first:start"]);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual(["first:start", "nested", "first:end", "second"]);
  });

  it("continues servicing the queue after an operation rejects", async () => {
    const unitOfWork = new MemoryUnitOfWork();
    await expect(unitOfWork.run(() => { throw new Error("expected"); })).rejects.toThrow("expected");
    await expect(unitOfWork.exclusive(() => "ready")).resolves.toBe("ready");
  });
});
