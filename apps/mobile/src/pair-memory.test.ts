import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PairLinkMemory, type PairMemoryStore } from "./pair-memory";

const hash = async (value: string) => createHash("sha256").update(value).digest("hex");
function memoryStore(initial: string | null = null): PairMemoryStore & { value: string | null } {
  const store = { value: initial, get: async () => store.value, set: async (value: string) => { store.value = value; } };
  return store;
}
const link = "benchledger://pair?url=https%3A%2F%2Fbench.example.com&token=abc.DEF-123";

describe("consumed pairing link memory", () => {
  it("applies a cold-start pairing link once and ignores the same initial URL on later launches", async () => {
    const store = memoryStore();
    expect(await new PairLinkMemory(store, hash).claimInitial(link)).toBe(true);
    // A new process (later cold start) with the same persistent store.
    expect(await new PairLinkMemory(store, hash).claimInitial(link)).toBe(false);
    expect(await new PairLinkMemory(store, hash).claimInitial(`${link}2`)).toBe(true);
  });

  it("stores only a hash, never the token-bearing link", async () => {
    const store = memoryStore();
    await new PairLinkMemory(store, hash).claimInitial(link);
    expect(store.value).toBe(await hash(link));
    expect(store.value).not.toContain("abc.DEF-123");
  });

  it("treats a link received while running as consumed for later cold starts", async () => {
    const store = memoryStore();
    await new PairLinkMemory(store, hash).remember(link);
    expect(await new PairLinkMemory(store, hash).claimInitial(link)).toBe(false);
  });

  it("ignores an initial link it cannot fingerprint and tolerates storage failures", async () => {
    const failingHash = async () => { throw new Error("no crypto"); };
    expect(await new PairLinkMemory(memoryStore(), failingHash).claimInitial(link)).toBe(false);
    const broken: PairMemoryStore = { get: async () => { throw new Error("locked"); }, set: async () => { throw new Error("locked"); } };
    expect(await new PairLinkMemory(broken, hash).claimInitial(link)).toBe(true);
    await expect(new PairLinkMemory(broken, hash).remember(link)).resolves.toBeUndefined();
  });
});
