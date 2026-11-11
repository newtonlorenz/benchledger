/**
 * Android may hand the same `getInitialURL` value back on later cold starts,
 * long after the user consumed (or abandoned) that pairing link. Remember a
 * one-way hash of the last consumed pairing link in secure storage, never the
 * link itself (it may carry a token), so a replayed initial URL is ignored.
 */
export interface PairMemoryStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}
export type PairHasher = (value: string) => Promise<string>;

export class PairLinkMemory {
  constructor(private readonly store: PairMemoryStore, private readonly hash: PairHasher) {}

  /** Record a link as consumed. Storage failures are tolerated: the link is still applied once. */
  async remember(url: string): Promise<void> {
    try { await this.store.set(await this.hash(url)); } catch { /* best effort */ }
  }

  /**
   * True when a cold-start initial URL has not been consumed before; it is then
   * recorded as consumed. A link delivered while running is always fresh, so
   * callers use `remember` for those instead.
   */
  async claimInitial(url: string): Promise<boolean> {
    let digest: string;
    try { digest = await this.hash(url); } catch { return false; }
    let previous: string | null = null;
    try { previous = await this.store.get(); } catch { previous = null; }
    if (previous === digest) return false;
    try { await this.store.set(digest); } catch { /* best effort */ }
    return true;
  }
}
