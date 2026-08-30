import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type BarrierOperation<T> = () => T | PromiseLike<T>;

interface BarrierScope {
  readonly barrier: ExclusiveBarrier;
  readonly owner: string;
  depth: number;
  active: boolean;
}

interface WaitingOperation<T> {
  readonly operation: BarrierOperation<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly owner: string;
}

/**
 * A small FIFO async mutex with re-entrant ownership across await points.
 *
 * SQLite's built-in driver is synchronous, while application operations are
 * asynchronous because they may touch the artifact filesystem. Keeping the
 * mutex here (rather than relying on SQLite's busy timeout) means an online
 * backup can freeze both stores at one well-defined boundary. AsyncLocalStorage
 * is used only to recognize a nested call made by the current owner; a
 * different request can never inherit that ownership merely because it shares
 * the same database connection.
 */
export class ExclusiveBarrier {
  private readonly storage = new AsyncLocalStorage<BarrierScope>();
  private readonly queue: WaitingOperation<unknown>[] = [];
  private active = false;
  private accepting = true;

  exclusive<T>(operation: BarrierOperation<T>): Promise<T> {
    const scope = this.storage.getStore();
    if (scope?.barrier === this && scope.active) {
      scope.depth += 1;
      return Promise.resolve()
        .then(operation)
        .finally(() => { scope.depth -= 1; });
    }
    if (!this.accepting) return Promise.reject(new Error("runtime barrier is closed"));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ operation: operation as BarrierOperation<unknown>, resolve: resolve as (value: unknown) => void, reject, owner: randomUUID() });
      this.pump();
    });
  }

  /** Alias for callers that want to make the serialization intent explicit. */
  run<T>(operation: BarrierOperation<T>): Promise<T> {
    return this.exclusive(operation);
  }

  /**
   * Stop accepting new work, drain operations already queued ahead of this
   * close request, and then run the close callback while still holding the
   * barrier. Calls made by the closing callback remain re-entrant.
   */
  async shutdown<T>(operation: BarrierOperation<T>): Promise<T> {
    this.accepting = false;
    return this.enqueueInternal(operation);
  }

  private enqueueInternal<T>(operation: BarrierOperation<T>): Promise<T> {
    const scope = this.storage.getStore();
    if (scope?.barrier === this && scope.active) {
      scope.depth += 1;
      return Promise.resolve()
        .then(operation)
        .finally(() => { scope.depth -= 1; });
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ operation: operation as BarrierOperation<unknown>, resolve: resolve as (value: unknown) => void, reject, owner: randomUUID() });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.active = true;
    const scope: BarrierScope = { barrier: this, owner: next.owner, depth: 1, active: true };
    void this.storage.run(scope, async () => {
      try {
        next.resolve(await next.operation());
      } catch (error: unknown) {
        next.reject(error);
      } finally {
        // Detached tasks retain the AsyncLocalStorage object. Mark the lease
        // inactive before allowing the next owner to run so such a task must
        // queue instead of re-entering a completed operation's turn.
        scope.active = false;
        this.active = false;
        this.pump();
      }
    });
  }
}
