import { describe, expect, it } from "vitest";
import { projectSetupPreviewSchema } from "@benchledger/api-contract";
import { BenchDatabase, migrateProjectSetupSchema } from "./index.js";
import { ProjectSetupRepository } from "./project-setup-repository.js";

describe("ProjectSetupRepository", () => {
  it("persists actor-owned previews and advances their commit version", () => {
    const database = new BenchDatabase(":memory:");
    migrateProjectSetupSchema(database);
    const repository = new ProjectSetupRepository(database);
    const preview = projectSetupPreviewSchema.parse({
      id: "setup-preview-repository",
      version: 1,
      status: "active",
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      expiresAt: "2026-09-02T00:30:00.000Z",
      contentSha256: "a".repeat(64),
      proposal: {
        project: { id: "setup-repository-project", name: "Repository setup", status: "planned" },
        revision: { id: "setup-repository-revision", name: "Initial", status: "concept" },
        bomLines: [{ localRef: "part", id: "setup-repository-line", name: "Part", requiredQuantity: 1, unit: "each" }]
      },
      fieldErrors: [],
      unresolvedSpecifications: [],
      gaps: { revisionId: "setup-repository-revision", lines: [], totals: {} },
      plannedReservations: [],
      affectedInventory: [],
      correlationId: "setup-repository-correlation"
    });

    expect(repository.save(preview, "setup-agent")).toEqual(preview);
    expect(repository.get(preview.id, "other-agent")).toBeNull();
    expect(repository.get(preview.id, "setup-agent")).toEqual(preview);
    const committed = repository.markCommitted(preview.id, "setup-agent", "2026-09-02T00:01:00.000Z");
    expect(committed).toMatchObject({ id: preview.id, status: "committed", version: 2, updatedAt: "2026-09-02T00:01:00.000Z" });
    expect(repository.get(preview.id, "setup-agent")).toMatchObject({ status: "committed", version: 2 });
    database.close();
  });

  it("fails closed when a stored preview payload is malformed", () => {
    const database = new BenchDatabase(":memory:");
    migrateProjectSetupSchema(database);
    const repository = new ProjectSetupRepository(database);
    database.run("INSERT INTO project_setup_previews (id, actor, version, status, created_at, updated_at, expires_at, content_sha256, payload_json, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["malformed-preview", "setup-agent", 1, "active", "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z", "2026-09-02T00:30:00.000Z", "a".repeat(64), "not-json", "setup-malformed-correlation"]);
    expect(repository.get("malformed-preview", "setup-agent")).toBeNull();
    database.close();
  });
});
