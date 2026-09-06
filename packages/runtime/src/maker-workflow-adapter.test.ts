import { it, expect } from "vitest";
import { BenchDatabase, MakerWorkflowRepository, migrateMakerWorkflowSchema } from "@benchledger/database";
import { ProductionMakerWorkflowAdapter } from "./maker-workflow-adapter.js";
import type { WorkflowRecord } from "@benchledger/api-contract";
it("maps durable workflow conflicts and retains project-filtered readback", async () => {
  const db = new BenchDatabase(":memory:");
  try {
    migrateMakerWorkflowSchema(db); const adapter = new ProductionMakerWorkflowAdapter(new MakerWorkflowRepository(db));
    const row: WorkflowRecord = { kind: "work_assignment", id: "work", projectId: "project", version: 1, payload: { status: "todo" }, createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" };
    await adapter.put(row, 0); expect(await adapter.get("work_assignment", "work")).toEqual(row);
    expect((await adapter.list("work_assignment", "project", { limit: 10 })).data).toHaveLength(1);
    expect((await adapter.list("work_assignment", "other", { limit: 10 })).data).toHaveLength(0);
    await expect(adapter.put(row, 0)).rejects.toMatchObject({ code: "conflict" });
    expect((await adapter.history("work_assignment", "work", 10)).data).toEqual([row]);
  } finally { db.close(); }
});
