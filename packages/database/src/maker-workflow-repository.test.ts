import { describe, it, expect } from "vitest";
import { BenchDatabase } from "./sqlite.js";
import { MakerWorkflowRepository, migrateMakerWorkflowSchema } from "./maker-workflow-repository.js";
import type { WorkflowRecord } from "@benchledger/api-contract";
const row: WorkflowRecord = { kind: "build_plan", id: "plan", projectId: "project", revisionId: "revision", version: 1, payload: { name: "Synthetic plan", parts: [] }, createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" };
describe("durable maker workflow history", () => {
  it("retains immutable versions and rejects stale or cross-project replacements", () => {
    const db = new BenchDatabase(":memory:");
    try {
      migrateMakerWorkflowSchema(db); migrateMakerWorkflowSchema(db); const store = new MakerWorkflowRepository(db);
      expect(store.get("build_plan", "missing")).toBeNull(); store.put(row, 0);
      store.put({ ...row, version: 2, payload: { name: "Reviewed plan" } }, 1);
      expect(store.get("build_plan", "plan")?.payload).toEqual({ name: "Reviewed plan" });
      expect(store.history("build_plan", "plan", 1).nextCursor).toBe("1");
      expect(store.history("build_plan", "plan", 1, "1").data[0]?.payload).toEqual(row.payload);
      expect(() => store.put({ ...row, version: 2 }, 1)).toThrow();
      expect(() => store.put({ ...row, projectId: "other", version: 3 }, 2)).toThrow();
      expect(store.list("build_plan", "other", { limit: 10 }).data).toEqual([]);
      expect(store.list("build_plan", "project", { limit: 10, revisionId: "revision" }).data).toHaveLength(1);
      store.put({ ...row, id: "second" }, 0); expect(store.list("build_plan", "project", { limit: 1 }).nextCursor).toBe("1");
    } finally { db.close(); }
  });
  it("rolls back the current record and its history on a later transaction failure", () => {
    const db = new BenchDatabase(":memory:");
    try { migrateMakerWorkflowSchema(db); const store = new MakerWorkflowRepository(db);
      expect(() => db.transaction(() => { store.put(row, 0); throw new Error("Synthetic audit failure"); })).toThrow("Synthetic audit failure");
      expect(store.get("build_plan", "plan")).toBeNull(); expect(store.history("build_plan", "plan", 10).data).toEqual([]);
    } finally { db.close(); }
  });
});
