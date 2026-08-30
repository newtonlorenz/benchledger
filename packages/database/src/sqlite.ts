import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.js";

export type SqliteParameter = string | number | bigint | Uint8Array | null;
export type SqliteRow = Readonly<Record<string, unknown>>;

/** Small wrapper around Node 24's built-in synchronous SQLite driver. The
 * database is only used behind repositories, so callers cannot accidentally
 * bypass domain validation with arbitrary writes. */
export class BenchDatabase {
  private readonly connection: DatabaseSync;
  private transactionDepth = 0;
  private savepointSequence = 0;
  private closed = false;

  constructor(path = ":memory:") {
    this.connection = new DatabaseSync(path);
    this.connection.exec(SCHEMA_SQL);
  }

  exec(sql: string): void {
    this.assertOpen();
    this.connection.exec(sql);
  }

  run(sql: string, parameters: readonly SqliteParameter[] = []): unknown {
    this.assertOpen();
    const statement = this.connection.prepare(sql);
    return statement.run(...(parameters as SqliteParameter[]));
  }

  all<T extends SqliteRow = SqliteRow>(sql: string, parameters: readonly SqliteParameter[] = []): readonly T[] {
    this.assertOpen();
    const statement = this.connection.prepare(sql);
    return statement.all(...(parameters as SqliteParameter[])) as unknown as readonly T[];
  }

  get<T extends SqliteRow = SqliteRow>(sql: string, parameters: readonly SqliteParameter[] = []): T | undefined {
    const rows = this.all<T>(sql, parameters);
    return rows[0];
  }

  transaction<T>(operation: () => T): T {
    this.assertOpen();
    const scope = this.beginScope();
    try {
      const result = operation();
      this.commitScope(scope);
      return result;
    } catch (error) {
      this.rollbackScope(scope);
      throw error;
    }
  }

  /**
   * Keep an outer SQLite transaction open while an application operation
   * awaits filesystem or adapter work. Existing repository transactions are
   * nested as SAVEPOINTs, so adapters can compose with this boundary without
   * accidentally committing the caller's transaction.
   */
  async transactionAsync<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.assertOpen();
    const scope = this.beginScope();
    try {
      const result = await operation();
      this.commitScope(scope);
      return result;
    } catch (error) {
      this.rollbackScope(scope);
      throw error;
    }
  }

  private beginScope(): { readonly savepoint?: string } {
    if (this.transactionDepth === 0) {
      this.connection.exec("BEGIN IMMEDIATE");
      this.transactionDepth = 1;
      return {};
    }
    const savepoint = `forge_sp_${++this.savepointSequence}`;
    this.connection.exec(`SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    return { savepoint };
  }

  private commitScope(scope: { readonly savepoint?: string }): void {
    try {
      if (scope.savepoint === undefined) this.connection.exec("COMMIT");
      else this.connection.exec(`RELEASE SAVEPOINT ${scope.savepoint}`);
    } finally {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
    }
  }

  private rollbackScope(scope: { readonly savepoint?: string }): void {
    try {
      if (scope.savepoint === undefined) this.connection.exec("ROLLBACK");
      else {
        this.connection.exec(`ROLLBACK TO SAVEPOINT ${scope.savepoint}`);
        this.connection.exec(`RELEASE SAVEPOINT ${scope.savepoint}`);
      }
    } finally {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("database is closed");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
  }
}
