import { describe, expect, it } from "vitest";
import { MemoryUnitOfWork } from "./memory-store.js";

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
