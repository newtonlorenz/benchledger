import type { UnitOfWorkOperation, UnitOfWorkPort } from "@benchledger/application";
import type { BenchDatabase } from "@benchledger/database";
import { ExclusiveBarrier } from "./barrier.js";

/** Production coordination boundary for SQLite and filesystem state. */
export class ProductionUnitOfWork implements UnitOfWorkPort {
  constructor(
    private readonly database: BenchDatabase,
    readonly barrier: ExclusiveBarrier = new ExclusiveBarrier()
  ) {}

  /** Execute a durable mutation under the FIFO barrier and an outer SQLite transaction. */
  run<T>(operation: UnitOfWorkOperation<T>): Promise<T> {
    return this.transactional(operation);
  }

  transactional<T>(operation: UnitOfWorkOperation<T>): Promise<T> {
    return this.barrier.exclusive(() => this.database.transactionAsync(operation));
  }

  /** Serialize work that must not overlap a transaction/backup without opening one. */
  exclusive<T>(operation: UnitOfWorkOperation<T>): Promise<T> {
    return this.barrier.exclusive(operation);
  }
}
