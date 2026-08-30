import { describe, expect, it } from "vitest";
import { ExclusiveBarrier } from "./barrier.js";

describe("ExclusiveBarrier", () => {
  it("runs queued owners in FIFO order and permits nested re-entry", async () => {
    const barrier = new ExclusiveBarrier();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = barrier.exclusive(async () => {
      order.push("first:start");
      await barrier.exclusive(() => { order.push("first:nested"); });
      await firstGate;
      order.push("first:end");
    });
    const second = barrier.exclusive(() => { order.push("second"); });
    const third = barrier.exclusive(() => { order.push("third"); });

    releaseFirst();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first:start", "first:nested", "first:end", "second", "third"]);
  });

  it("does not let detached work re-enter a completed owner's lease", async () => {
    const barrier = new ExclusiveBarrier();
    const order: string[] = [];
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    let child!: Promise<void>;

    await barrier.exclusive(async () => {
      order.push("first");
      child = (async () => {
        await childGate;
        await barrier.exclusive(() => { order.push("child"); });
      })();
    });

    let secondStarted!: () => void;
    const started = new Promise<void>((resolve) => { secondStarted = resolve; });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const second = barrier.exclusive(async () => {
      order.push("second:start");
      secondStarted();
      await secondGate;
      order.push("second:end");
    });

    await started;
    releaseChild();
    await Promise.resolve();
    expect(order).toEqual(["first", "second:start"]);

    releaseSecond();
    await Promise.all([second, child]);
    expect(order).toEqual(["first", "second:start", "second:end", "child"]);
  });

  it("drains already queued work before shutdown and rejects later work", async () => {
    const barrier = new ExclusiveBarrier();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const first = barrier.exclusive(async () => { order.push("first"); await gate; });
    const second = barrier.exclusive(() => { order.push("second"); });
    const closing = barrier.shutdown(() => { order.push("close"); });

    releaseFirst();
    await Promise.all([first, second, closing]);
    expect(order).toEqual(["first", "second", "close"]);
    await expect(barrier.exclusive(() => undefined)).rejects.toThrow("closed");
  });
});
