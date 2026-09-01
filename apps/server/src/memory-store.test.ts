import { describe, expect, it } from "vitest";
import { createMemoryRuntime, MemoryUnitOfWork } from "./memory-store.js";

describe("MemoryInventory", () => {
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
