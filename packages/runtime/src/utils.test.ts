import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ApplicationError } from "@benchledger/application";
import { DomainError } from "@benchledger/domain";
import { attempt, mapPersistenceError, page, parseOffsetCursor } from "./utils.js";

function sqliteError(sql: string): unknown {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (parent_id TEXT REFERENCES parent(id)); INSERT INTO parent VALUES ('p1');");
  try {
    database.exec(sql);
  } catch (error: unknown) {
    return error;
  } finally {
    database.close();
  }
  throw new Error("expected SQLite to fail");
}

function mapped(error: unknown): unknown {
  try {
    mapPersistenceError(error);
  } catch (thrown: unknown) {
    return thrown;
  }
  throw new Error("expected mapping to throw");
}

describe("persistence error mapping", () => {
  it("maps domain codes from an explicit table and keeps the cause", () => {
    const cause = new DomainError("insufficient_stock", "not enough");
    expect(mapped(cause)).toMatchObject({ code: "conflict", message: "not enough", cause });
    expect(mapped(new DomainError("idempotency_conflict", "reused"))).toMatchObject({ code: "idempotency_conflict", details: { reason: "idempotency_key_reused" } });
    expect(mapped(new DomainError("bom_line_not_found", "missing"))).toMatchObject({ code: "not_found" });
    expect(mapped(new DomainError("invalid_quantity", "bad"))).toMatchObject({ code: "validation" });
    expect(mapped(new DomainError("reconciliation_committed", "done"))).toMatchObject({ code: "conflict" });
    expect(mapped(new DomainError("project_removed", "gone"))).toMatchObject({ code: "project_removed" });
    const unclassified = new DomainError("immutable_snapshot", "frozen");
    expect(mapped(unclassified)).toMatchObject({ code: "integrity_error", cause: unclassified });
  });

  it("classifies SQLite constraint failures by result code, not message text", () => {
    const unique = sqliteError("INSERT INTO parent VALUES ('p1')");
    expect(mapped(unique)).toMatchObject({ code: "conflict", cause: unique });
    expect(mapped(sqliteError("INSERT INTO child VALUES ('missing')"))).toMatchObject({ code: "not_found" });
    expect(mapped(new Error("a message mentioning a unique constraint"))).toMatchObject({ code: "internal" });
  });

  it("maps unexpected failures to internal with the original as cause", async () => {
    const bug = new TypeError("Cannot read properties of undefined");
    expect(mapped(bug)).toMatchObject({ code: "internal", cause: bug });
    expect((mapped(bug) as Error).message).not.toContain("undefined");
    const sqlBug = sqliteError("SELECT * FROM missing_table");
    expect(mapped(sqlBug)).toMatchObject({ code: "internal", cause: sqlBug });
    expect((mapped(sqlBug) as Error).message).not.toContain("missing_table");
    await expect(attempt(() => { throw bug; })).rejects.toMatchObject({ code: "internal", cause: bug });
    const known = new ApplicationError("forbidden", "no");
    expect(mapped(known)).toBe(known);
  });

  it("rejects malformed offset cursors instead of restarting at the first page", () => {
    expect(page([1, 2, 3], 2)).toMatchObject({ data: [1, 2], nextCursor: "2", total: 3 });
    expect(page([1, 2, 3], 2, "2")).toMatchObject({ data: [3], total: 3 });
    expect(parseOffsetCursor(undefined)).toBe(0);
    for (const cursor of ["", "-1", "abc", "1.5", "01", "1e3", "99999999999999999999"]) {
      expect(() => page([1], 1, cursor)).toThrow(expect.objectContaining({ code: "invalid_cursor" }));
    }
  });
});
