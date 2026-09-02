import { describe, expect, it } from "vitest";
import type { InspectionEvidence } from "@benchledger/api-contract";
import { BenchDatabase, InspectionRepository, InventoryRepository } from "./index.js";

describe("InspectionRepository", () => {
  it("keeps append-only evidence scoped and ordered by observation commit", () => {
    const database = new BenchDatabase(":memory:");
    const inventory = new InventoryRepository(database);
    inventory.create({
      id: "inspection-repository-item", name: "Inspection item", category: "electronics",
      purchasedQuantity: 1, unit: "each", sourceStatus: "delivered_uncounted", reusePolicy: "inspect_first", confidence: "unknown",
      createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
    });
    const repository = new InspectionRepository(database);
    const evidence = (id: string, revision: string, recordedAt: string): InspectionEvidence => ({
      id, projectRevisionId: revision, actionId: "inspection-action", itemId: "inspection-repository-item",
      kind: "compatibility", result: "inconclusive", source: "human", observedAt: "2026-09-02T00:00:00.000Z", recordedAt,
    });
    repository.appendEvidence(evidence("inspection-evidence-b", "revision-1", "2026-09-02T00:02:00.000Z"));
    repository.appendEvidence(evidence("inspection-evidence-a", "revision-1", "2026-09-02T00:01:00.000Z"));
    repository.appendEvidence(evidence("inspection-evidence-other", "revision-2", "2026-09-02T00:00:00.000Z"));

    expect(repository.listEvidence("revision-1").map((entry) => entry.id)).toEqual(["inspection-evidence-a", "inspection-evidence-b"]);
    expect(repository.listEvidence("revision-2").map((entry) => entry.id)).toEqual(["inspection-evidence-other"]);
    expect(() => repository.appendEvidence(evidence("inspection-evidence-a", "revision-1", "2026-09-02T00:03:00.000Z"))).toThrow();
    database.close();
  });
});
