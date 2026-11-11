import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.js";

export type SqliteParameter = string | number | bigint | Uint8Array | null;
export type SqliteRow = Readonly<Record<string, unknown>>;

/** Upper bound on cached prepared statements; repositories use a fixed set of SQL strings, plus a few with variable IN-lists. */
export const STATEMENT_CACHE_LIMIT = 256;

/** Small wrapper around Node 24's built-in synchronous SQLite driver. The
 * database is only used behind repositories, so callers cannot accidentally
 * bypass domain validation with arbitrary writes. */

export class BenchDatabase {
  private readonly connection: DatabaseSync;
  /** Least-recently-used prepared statements keyed by SQL text. */
  private readonly statements = new Map<string, StatementSync>();
  private transactionDepth = 0;
  private savepointSequence = 0;
  private closed = false;

  /**
   * `readOnly` opens an existing database without applying the schema, so
   * inspection commands (such as an import dry-run) never create, migrate or
   * write the file. Writes through a read-only handle fail in SQLite. A
   * `file:` URL may carry SQLite URI parameters such as `immutable=1`.
   */
  constructor(path: string | URL = ":memory:", options: { readonly readOnly?: boolean } = {}) {
    if (options.readOnly === true) {
      this.connection = new DatabaseSync(path, { readOnly: true });
      return;
    }
    this.connection = new DatabaseSync(path);
    this.connection.exec(SCHEMA_SQL);
  }

  exec(sql: string): void {
    this.assertOpen();
    this.connection.exec(sql);
  }

  run(sql: string, parameters: readonly SqliteParameter[] = []): unknown {
    this.assertOpen();
    return this.statement(sql).run(...(parameters as SqliteParameter[]));
  }

  all<T extends SqliteRow = SqliteRow>(sql: string, parameters: readonly SqliteParameter[] = []): readonly T[] {
    this.assertOpen();
    return this.statement(sql).all(...(parameters as SqliteParameter[])) as unknown as readonly T[];
  }

  /** Number of cached prepared statements (diagnostics and tests). */
  get cachedStatementCount(): number {
    return this.statements.size;
  }

  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) {
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }
    const prepared = this.connection.prepare(sql);
    this.statements.set(sql, prepared);
    if (this.statements.size > STATEMENT_CACHE_LIMIT) {
      const oldest = this.statements.keys().next().value;
      if (oldest !== undefined) this.statements.delete(oldest);
    }
    return prepared;
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
    this.statements.clear();
    this.connection.close();
  }
}
