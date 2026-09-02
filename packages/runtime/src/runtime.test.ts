import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationService } from "@benchledger/application";
import type { RequestContext } from "@benchledger/application";
import { ArtifactStore } from "@benchledger/artifacts";
import { BenchDatabase } from "@benchledger/database";
import { ProductionArtifactAdapter } from "./artifact-adapter.js";
import { backupProductionRuntime, createProductionRuntime, restoreProductionBackup, type ProductionRuntime, verifyProductionBackup } from "./index.js";
import { migrateRuntimeSchema, RuntimeState } from "./persistence.js";

const runtimes: ProductionRuntime[] = [];
const directories: string[] = [];

const context = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  actor: "test-agent",
  source: "api",
  correlationId: "correlation-test",
  scopes: new Set(["read", "write"]),
  ...overrides
});

async function makeRuntime(): Promise<ProductionRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), "benchledger-runtime-"));
  directories.push(dataDir);
  const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production runtime mappings", () => {
  it("previews setup without graph or ledger mutation and commits the exact preview", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    await runtime.ports.inventory.createItem({ id: "setup-stock", name: "M3 screw", kind: "fastener", quantity: 4, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
    const proposal = {
      project: { id: "setup-project", name: "Atomic setup", status: "planned" as const },
      revision: { id: "setup-revision", name: "Initial", status: "concept" as const },
      workItems: [{ localRef: "body", id: "setup-work", name: "Body", kind: "part" as const, revision: { id: "setup-work-revision", name: "Initial body", status: "concept" as const } }],
      bomLines: [{ localRef: "screw", revisionLocalRef: "project", id: "setup-bom", name: "M3 screw", itemId: "setup-stock", requiredQuantity: 2, unit: "each" as const, optional: false, constraints: {}, alternatives: [] }],
      reservations: [{ localRef: "reserve-screw", bomLineLocalRef: "screw", id: "setup-reservation", itemId: "setup-stock", quantity: 2, unit: "each" as const }]
    };
    const beforeProjects = runtime.database.get("SELECT COUNT(*) AS count FROM projects")?.count;
    const beforeEvents = runtime.database.get("SELECT COUNT(*) AS count FROM stock_events")?.count;
    const beforeAudits = runtime.database.get("SELECT COUNT(*) AS count FROM audit_log")?.count;
    const preview = await service.previewProjectSetup(proposal, context({ actor: "setup-agent" }));
    expect(preview).toMatchObject({ status: "active", version: 1, proposal: { project: { id: "setup-project" }, workItems: [{ id: "setup-work" }], bomLines: [{ id: "setup-bom" }], reservations: [{ id: "setup-reservation" }] } });
    expect(preview.contentSha256).toHaveLength(64);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM projects")?.count).toBe(beforeProjects);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM stock_events")?.count).toBe(beforeEvents);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM audit_log")?.count).toBe(beforeAudits);
    const committed = await service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, context({ actor: "setup-agent", idempotencyKey: "setup-commit-1" }));
    expect(committed.data).toMatchObject({ project: { id: "setup-project" }, revision: { id: "setup-revision" }, workItems: [{ id: "setup-work" }], bomLines: [{ id: "setup-bom" }], reservations: [{ id: "setup-reservation" }], auditIds: [committed.audit.id] });
    await expect(service.evaluateBomGaps("setup-revision")).resolves.toEqual(committed.data.gaps);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM projects")?.count).toBe((Number(beforeProjects) || 0) + 1);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM stock_events")?.count).toBe((Number(beforeEvents) || 0) + 1);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM audit_log")?.count).toBe((Number(beforeAudits) || 0) + 1);
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, context({ actor: "setup-agent", idempotencyKey: "setup-commit-1", fingerprint: "different-transport-envelope" }))).resolves.toMatchObject({ replayed: true, data: committed.data });
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: "b".repeat(64), confirmReservations: true }, context({ actor: "setup-agent", idempotencyKey: "setup-commit-1", fingerprint: "changed-transport-envelope" }))).rejects.toMatchObject({ code: "idempotency_conflict", details: { reason: "idempotency_key_reused", retryable: false, commitState: "not_committed" } });
  });

  it("rolls back the complete setup when a reservation, audit, or replay write fails", async () => {
    for (const stage of ["reservation", "audit", "idempotency"] as const) {
      const runtime = await makeRuntime();
      const service = new ApplicationService(runtime.ports);
      const suffix = `setup-${stage}`;
      await runtime.ports.inventory.createItem({
        id: `${suffix}-stock`, name: "Rollback screw", kind: "fastener", quantity: 2,
        unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }
      }, context());
      const preview = await service.previewProjectSetup({
        project: { id: `${suffix}-project`, name: `Rollback ${stage} project`, status: "planned" },
        revision: { id: `${suffix}-revision`, name: "Initial", status: "concept" },
        workItems: [],
        bomLines: [{ localRef: "screw", id: `${suffix}-line`, name: "Rollback screw", itemId: `${suffix}-stock`, requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
        reservations: [{ localRef: "reservation", bomLineLocalRef: "screw", id: `${suffix}-reservation`, itemId: `${suffix}-stock`, quantity: 1, unit: "each" }]
      }, context({ actor: suffix }));

      const failure = new Error(`injected ${stage} failure`);
      const spy = stage === "reservation"
        ? vi.spyOn(runtime.ports.projects, "createReservation").mockRejectedValueOnce(failure)
        : stage === "audit"
          ? vi.spyOn(runtime.ports.audit, "append").mockRejectedValueOnce(failure)
          : vi.spyOn(runtime.ports.idempotency, "set").mockRejectedValueOnce(failure);
      await expect(service.commitProjectSetup({
        previewId: preview.id,
        expectedPreviewVersion: preview.version,
        contentSha256: preview.contentSha256,
        confirmReservations: true
      }, context({ actor: suffix, idempotencyKey: `${suffix}-commit` }))).rejects.toThrow(failure.message);
      spy.mockRestore();

      await expect(runtime.ports.projects.getProject(`${suffix}-project`)).resolves.toBeNull();
      await expect(runtime.ports.inventory.getItem(`${suffix}-stock`)).resolves.toMatchObject({ availableQuantity: 2, version: 1 });
      expect(runtime.database.get("SELECT id FROM reservations WHERE id = ?", [`${suffix}-reservation`])).toBeUndefined();
      expect(runtime.database.get("SELECT id FROM stock_events WHERE id = ?", [`reservation-${suffix}-reservation-allocate`])).toBeUndefined();
      expect(runtime.database.get("SELECT id FROM audit_log WHERE action = ? AND entity_id = ?", ["project.setup.commit", `${suffix}-project`])).toBeUndefined();
      expect(runtime.database.get("SELECT payload_json FROM forge_runtime_idempotency WHERE actor = ? AND idempotency_key = ?", [suffix, `${suffix}-commit`])).toBeUndefined();
      const previewRow = runtime.database.get<{ readonly status: unknown; readonly payload_json: unknown }>("SELECT status, payload_json FROM project_setup_previews WHERE id = ?", [preview.id]);
      expect(previewRow?.status).toBe("active");
      expect(JSON.parse(String(previewRow?.payload_json))).toMatchObject({ status: "active", version: preview.version });
    }
  });

  it("rejects every setup identity collision before creating graph rows", async () => {
    const stages = [
      ["project", "getProject", "project_id_exists"],
      ["revision", "getProjectRevision", "revision_id_exists"],
      ["work", "getWorkItem", "work_item_id_exists"],
      ["work-revision", "getWorkItemRevision", "work_item_revision_id_exists"],
      ["bom", "getBomLine", "bom_line_id_exists"],
      ["reservation", "getReservationDetails", "reservation_id_exists"],
    ] as const;
    for (const [stage, method, reason] of stages) {
      const runtime = await makeRuntime();
      const service = new ApplicationService(runtime.ports);
      await runtime.ports.inventory.createItem({
        id: `${stage}-identity-stock`, name: "Identity stock", kind: "fastener", quantity: 1,
        unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }
      }, context());
      const preview = await service.previewProjectSetup({
        project: { id: `${stage}-identity-project`, name: `${stage} identity project`, status: "planned" },
        revision: { id: `${stage}-identity-revision`, name: "Initial", status: "concept" },
        workItems: [{ localRef: "part", id: `${stage}-identity-work`, name: "Part", kind: "part", revision: { id: `${stage}-identity-work-revision`, name: "Initial part", status: "concept" } }],
        bomLines: [{ localRef: "line", id: `${stage}-identity-line`, name: "Identity stock", itemId: `${stage}-identity-stock`, requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
        reservations: [{ localRef: "reservation", bomLineLocalRef: "line", id: `${stage}-identity-reservation`, itemId: `${stage}-identity-stock`, quantity: 1, unit: "each" }]
      }, context({ actor: `${stage}-identity-agent` }));
      const spy = vi.spyOn(runtime.ports.projects, method as "getProject").mockResolvedValueOnce({ id: `existing-${stage}` } as never);
      await expect(service.commitProjectSetup({
        previewId: preview.id,
        expectedPreviewVersion: preview.version,
        contentSha256: preview.contentSha256,
        confirmReservations: true
      }, context({ actor: `${stage}-identity-agent`, idempotencyKey: `${stage}-identity-key` }))).rejects.toMatchObject({
        code: "conflict",
        details: { reason, retryable: false, commitState: "not_committed" }
      });
      spy.mockRestore();
      await expect(runtime.ports.projects.getProject(`${stage}-identity-project`)).resolves.toBeNull();
    }
  });

  it("covers production setup semantic, stale-basis, and read-back defenses", async () => {
    {
      const runtime = await makeRuntime();
      const service = new ApplicationService(runtime.ports);
      await runtime.ports.inventory.createItem({ id: "setup-defence-stock", name: "Defence stock", kind: "fastener", quantity: 2, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
      const invalid = await service.previewProjectSetup({
        project: { id: "setup-invalid-project", name: "Invalid setup", status: "planned" },
        revision: { id: "setup-invalid-revision", name: "Initial", status: "concept" },
        workItems: [],
        bomLines: [{ localRef: "line", id: "setup-invalid-line", name: "Exact requirement", itemId: "setup-defence-stock", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
        reservations: [{ localRef: "bad", bomLineLocalRef: "line", itemId: "missing-setup-item", quantity: 1, unit: "each" }]
      }, context({ actor: "setup-invalid-agent" }));
      expect(invalid.fieldErrors).not.toHaveLength(0);
      await expect(service.commitProjectSetup({ previewId: invalid.id, expectedPreviewVersion: invalid.version, contentSha256: invalid.contentSha256, confirmReservations: false }, context({ actor: "setup-invalid-agent", idempotencyKey: "setup-invalid-key" }))).rejects.toMatchObject({ code: "validation" });

      const stale = await service.previewProjectSetup({
        project: { id: "setup-stale-project", name: "Stale setup", status: "planned" },
        revision: { id: "setup-stale-revision", name: "Initial", status: "concept" },
        workItems: [],
        bomLines: [{ localRef: "line", id: "setup-stale-line", name: "Constraint match", requiredQuantity: 1, unit: "each", optional: false, constraints: { kind: "fastener" }, alternatives: [] }],
        reservations: []
      }, context({ actor: "setup-stale-agent" }));
      await runtime.ports.inventory.updateItem("setup-defence-stock", { location: "Moved" }, 1, context());
      await expect(service.commitProjectSetup({ previewId: stale.id, expectedPreviewVersion: stale.version, contentSha256: stale.contentSha256, confirmReservations: false }, context({ actor: "setup-stale-agent", idempotencyKey: "setup-stale-key" }))).rejects.toMatchObject({ code: "conflict", details: { reason: "stale_basis" } });
    }

    {
      const runtime = await makeRuntime();
      const service = new ApplicationService(runtime.ports);
      await runtime.ports.inventory.createItem({ id: "setup-optional-stock", name: "Optional stock", kind: "fastener", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
      const preview = await service.previewProjectSetup({
        project: { id: "setup-optional-project", name: "Optional fields setup", status: "planned" },
        revision: { id: "setup-optional-revision", name: "Initial", status: "concept" },
        workItems: [{ localRef: "part", id: "setup-optional-work", name: "Part", kind: "part", description: "A described work item", revision: { id: "setup-optional-work-revision", name: "Initial part", status: "concept" } }],
        bomLines: [{ localRef: "line", id: "setup-optional-line", name: "Constraint-selected stock", requiredQuantity: 1, unit: "each", optional: false, constraints: { kind: "fastener" }, alternatives: [], notes: "Preserved setup note" }],
        reservations: []
      }, context({ actor: "setup-optional-agent" }));
      await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: false }, context({ actor: "setup-optional-agent", idempotencyKey: "setup-optional-key" }))).resolves.toMatchObject({ data: { workItems: [{ description: "A described work item" }], bomLines: [{ notes: "Preserved setup note" }] } });
    }

    {
      const runtime = await makeRuntime();
      const service = new ApplicationService(runtime.ports);
      const preview = await service.previewProjectSetup({
        project: { id: "setup-readback-project", name: "Read-back setup", status: "planned" },
        revision: { id: "setup-readback-revision", name: "Initial", status: "concept" },
        workItems: [],
        bomLines: [{ localRef: "line", id: "setup-readback-line", name: "Unowned requirement", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
        reservations: []
      }, context({ actor: "setup-readback-agent" }));
      const readBack = vi.spyOn(runtime.ports.projects, "getProject").mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: false }, context({ actor: "setup-readback-agent", idempotencyKey: "setup-readback-key" }))).rejects.toMatchObject({ code: "integrity_error" });
      readBack.mockRestore();
      await expect(runtime.ports.projects.getProject("setup-readback-project")).resolves.toBeNull();
    }
  });

  it("rejects every inventory field drift covered by the setup basis", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    await runtime.ports.inventory.createItem({
      id: "setup-basis-stock", name: "Basis stock", kind: "fastener", quantity: 2,
      unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }
    }, context());
    const preview = await service.previewProjectSetup({
      project: { id: "setup-basis-project", name: "Basis comparison", status: "planned" },
      revision: { id: "setup-basis-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "line", id: "setup-basis-line", name: "Basis stock", itemId: "setup-basis-stock", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
      reservations: []
    }, context({ actor: "setup-basis-agent" }));
    const current = await runtime.ports.inventory.getItem("setup-basis-stock");
    if (current === null) throw new Error("expected setup basis stock");
    const variants = [
      null,
      { ...current, version: current.version + 1 },
      { ...current, quantity: current.quantity + 1 },
      { ...current, availableQuantity: current.availableQuantity - 1 },
      { ...current, allocatedQuantity: 1 },
      { ...current, unit: "set" as const },
      { ...current, evidence: { state: "commissioned" as const } },
    ];
    for (const [index, drifted] of variants.entries()) {
      const getItem = vi.spyOn(runtime.ports.inventory, "getItem").mockResolvedValueOnce(drifted);
      await expect(service.commitProjectSetup({
        previewId: preview.id,
        expectedPreviewVersion: preview.version,
        contentSha256: preview.contentSha256,
        confirmReservations: false
      }, context({ actor: "setup-basis-agent", idempotencyKey: `setup-basis-key-${index}` }))).rejects.toMatchObject({
        code: "conflict",
        details: { reason: "stale_basis", staleItems: ["setup-basis-stock"], commitState: "not_committed" }
      });
      getItem.mockRestore();
    }
    await expect(runtime.ports.projects.getProject("setup-basis-project")).resolves.toBeNull();
  });

  it("replays stable atomic project IDs exactly and rejects a changed payload", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const input = {
      project: { id: "stable-atomic-project", name: "Stable atomic project", description: "Initial description", status: "planned" as const },
      revision: { id: "stable-atomic-revision", name: "Initial", notes: "First baseline", status: "concept" as const },
    };
    const command = context({ actor: "stable-agent", idempotencyKey: "stable-atomic-key" });

    const first = await service.createProjectWithInitialRevision(input, command);
    const replay = await service.createProjectWithInitialRevision(input, command);

    expect(replay).toMatchObject({ replayed: true, data: first.data, audit: first.audit });
    expect(runtime.database.all("SELECT id FROM projects WHERE id = ?", [input.project.id])).toHaveLength(1);
    expect(runtime.database.all("SELECT id FROM project_revisions WHERE id = ?", [input.revision.id])).toHaveLength(1);
    expect(runtime.database.all("SELECT id FROM audit_log WHERE action = 'project.create_with_initial_revision'", [])).toHaveLength(1);
    expect(runtime.database.all("SELECT actor, idempotency_key FROM forge_runtime_idempotency WHERE actor = ? AND idempotency_key = ?", [command.actor, command.idempotencyKey!])).toHaveLength(1);

    await expect(service.createProjectWithInitialRevision({
      project: { ...input.project, description: "Changed description" },
      revision: input.revision,
    }, command)).rejects.toMatchObject({ code: "idempotency_conflict", details: { reason: "idempotency_key_reused", retryable: false, commitState: "not_committed" } });
  });

  it("replays an atomic create when transport fingerprints differ but parsed payload is identical", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const input = {
      project: { id: "transport-stable-project", name: "Transport stable project", description: "Canonical payload", status: "planned" as const },
      revision: { id: "transport-stable-revision", name: "Initial", notes: "Canonical notes", status: "concept" as const },
    };
    const first = await service.createProjectWithInitialRevision(input, context({ idempotencyKey: "transport-fingerprint-key", fingerprint: "raw-body-a" }));
    const replay = await service.createProjectWithInitialRevision({
      revision: input.revision,
      project: { status: input.project.status, description: input.project.description, name: input.project.name, id: input.project.id },
    }, context({ idempotencyKey: "transport-fingerprint-key", fingerprint: "raw-body-b-with-reordered-fields" }));

    expect(replay).toMatchObject({ replayed: true, data: first.data, audit: first.audit });
    await expect(service.createProjectWithInitialRevision({
      project: { ...input.project, description: "Changed canonical payload" },
      revision: input.revision,
    }, context({ idempotencyKey: "transport-fingerprint-key", fingerprint: "raw-body-c" }))).rejects.toMatchObject({
      code: "idempotency_conflict",
      details: { reason: "idempotency_key_reused", field: "idempotencyKey", retryable: false, commitState: "not_committed" },
    });
  });

  it("reports stable project, revision, and generated slug collisions without partial records", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const first = await service.createProjectWithInitialRevision({
      project: { id: "existing-project-id", name: "Existing project", status: "planned" },
      revision: { id: "existing-revision-id", name: "Initial", status: "concept" },
    }, context({ idempotencyKey: "collision-seed-1" }));
    expect(first.data.project.id).toBe("existing-project-id");

    await expect(service.createProjectWithInitialRevision({
      project: { id: "existing-project-id", name: "Different project", status: "planned" },
      revision: { id: "new-revision-id", name: "Initial", status: "concept" },
    }, context({ idempotencyKey: "collision-project-id" }))).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "project_id_exists", field: "projectId", id: "existing-project-id", retryable: false, commitState: "not_committed" },
    });
    await expect(runtime.ports.projects.getProject("existing-project-id")).resolves.toMatchObject({ name: "Existing project" });
    await expect(runtime.ports.projects.getProjectRevision("new-revision-id")).resolves.toBeNull();

    await expect(service.createProjectWithInitialRevision({
      project: { id: "new-project-id", name: "Different project", status: "planned" },
      revision: { id: "existing-revision-id", name: "Initial", status: "concept" },
    }, context({ idempotencyKey: "collision-revision-id" }))).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "revision_id_exists", field: "revisionId", id: "existing-revision-id", retryable: false, commitState: "not_committed" },
    });
    await expect(runtime.ports.projects.getProject("new-project-id")).resolves.toBeNull();

    await expect(service.createProjectWithInitialRevision({
      project: { id: "slug-project-id", name: " existing   project ", status: "planned" },
      revision: { id: "slug-revision-id", name: "Initial", status: "concept" },
    }, context({ idempotencyKey: "collision-slug" }))).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "project_name_exists", field: "projectName", id: "existing-project", retryable: false, commitState: "not_committed" },
    });
    await expect(runtime.ports.projects.getProject("slug-project-id")).resolves.toBeNull();
    await expect(runtime.ports.projects.getProjectRevision("slug-revision-id")).resolves.toBeNull();
    expect(runtime.database.all("SELECT id FROM audit_log WHERE action = 'project.create_with_initial_revision'", [])).toHaveLength(1);
  });

  it("atomically tombstones a project and releases reservations across revisions", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    await runtime.ports.inventory.createItem({ id: "removal-item", name: "Removal item", kind: "electronic", quantity: 4, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
    const project = await runtime.ports.projects.createProject({ id: "removal-project", name: "Removal project", status: "planned" }, context());
    const firstRevision = await runtime.ports.projects.createProjectRevision(project.id, { id: "removal-revision-1", name: "First", status: "concept" }, context());
    const firstLine = await runtime.ports.projects.createBomLine(firstRevision.id, { id: "removal-line-1", name: "Removal item", itemId: "removal-item", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context());
    const firstReservation = await runtime.ports.projects.createReservation(firstRevision.id, { id: "removal-reservation-1", lineId: firstLine.id, itemId: "removal-item", quantity: 1 }, context());
    const secondRevision = await runtime.ports.projects.createProjectRevision(project.id, { id: "removal-revision-2", name: "Second", status: "concept" }, context());
    const secondLine = await runtime.ports.projects.createBomLine(secondRevision.id, { id: "removal-line-2", name: "Removal item", itemId: "removal-item", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context());
    const secondReservation = await runtime.ports.projects.createReservation(secondRevision.id, { id: "removal-reservation-2", lineId: secondLine.id, itemId: "removal-item", quantity: 1 }, context());
    const removeContext = context({ actor: "remover", idempotencyKey: "remove-project-1", correlationId: "remove-correlation" });

    const removed = await service.removeProject(project.id, 1, project.name, removeContext);
    expect(removed.data).toMatchObject({ id: project.id, name: project.name, lastLifecycleStatus: "planned", removedBy: "remover", releasedReservationIds: [firstReservation.id, secondReservation.id], auditId: removed.audit.id });
    await expect(runtime.ports.projects.listProjects({ limit: 50 })).resolves.toMatchObject({ data: [] });
    await expect(runtime.ports.projects.listRemovedProjects?.()).resolves.toMatchObject([{ id: project.id, releasedReservationIds: [firstReservation.id, secondReservation.id] }]);
    await expect(runtime.ports.projects.getProject(project.id)).resolves.toMatchObject({ removedAt: removed.data.removedAt, lastLifecycleStatus: "planned" });
    await expect(runtime.ports.projects.listReservations(firstRevision.id)).resolves.toMatchObject([{ id: firstReservation.id, status: "released" }]);
    await expect(runtime.ports.projects.listReservations(secondRevision.id)).resolves.toMatchObject([{ id: secondReservation.id, status: "released" }]);
    await expect(service.getProject(project.id)).rejects.toMatchObject({ code: "project_removed" });
    await expect(service.readRemovedProjectHistory(project.id)).resolves.toMatchObject({ data: [expect.objectContaining({ action: "project.remove", entityId: project.id })] });
    await expect(service.removeProject(project.id, 1, project.name, removeContext)).resolves.toMatchObject({ replayed: true, data: removed.data });
    await expect(service.removeProject(project.id, 2, project.name, context({ actor: "other", idempotencyKey: "remove-project-2" }))).rejects.toMatchObject({ code: "project_removed" });
  });

  it("migrates legacy project metadata once and reopens with the database lifecycle as authority", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-lifecycle-migration-"));
    directories.push(dataDir);
    const databasePath = join(dataDir, "benchledger.sqlite");
    const legacy = new BenchDatabase(databasePath);
    migrateRuntimeSchema(legacy);
    legacy.run("INSERT INTO projects (id, name, slug, status, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, 'private', ?, ?)", ["legacy-project", "Legacy project", "legacy-project", "active", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
    legacy.run("INSERT INTO project_revisions (id, project_id, revision_number, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?)", ["legacy-revision", "legacy-project", 1, "r01", "concept", "2026-01-02T00:00:00.000Z"]);
    legacy.run("INSERT INTO forge_runtime_metadata (entity_type, entity_id, payload_json, updated_at) VALUES (?, ?, ?, ?)", ["project", "legacy-project", JSON.stringify({ status: "planning", currentRevisionId: "legacy-revision" }), "2026-01-03T00:00:00.000Z"]);
    legacy.close();

    const first = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    expect(await first.ports.projects.getProject("legacy-project")).toMatchObject({ status: "planned", currentRevisionId: "legacy-revision" });
    expect(JSON.parse(first.database.get<{ readonly payload_json: string }>("SELECT payload_json FROM forge_runtime_metadata WHERE entity_type = ? AND entity_id = ?", ["project", "legacy-project"])!.payload_json)).toEqual({ currentRevisionId: "legacy-revision" });
    expect(first.database.all("SELECT id FROM audit_log WHERE action = 'project.lifecycle.migrated' AND entity_id = ?", ["legacy-project"])).toHaveLength(1);
    await first.close();

    const reopened = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(reopened);
    expect(await reopened.ports.projects.getProject("legacy-project")).toMatchObject({ status: "planned", currentRevisionId: "legacy-revision" });
    expect(reopened.database.all("SELECT id FROM audit_log WHERE action = 'project.lifecycle.migrated' AND entity_id = ?", ["legacy-project"])).toHaveLength(1);
  });

  it("applies bounded metadata batches atomically with deterministic no-op and audit behavior", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    for (const itemId of ["bulk-a", "bulk-b"]) {
      await runtime.ports.inventory.createItem({
        id: itemId,
        name: itemId,
        kind: "tool",
        quantity: 1,
        unit: "each",
        tags: [],
        links: [],
        evidence: { state: "physically_counted" },
      }, context());
    }
    const events: string[] = [];
    service.subscribe((event) => { events.push(event.entityId); });
    const command = {
      targets: [{ itemId: "bulk-b", expectedVersion: 1 }, { itemId: "bulk-a", expectedVersion: 1 }],
      changes: { location: "  Shelf A  ", tags: { add: ["Zed", " zed ", "alpha"] } },
    };
    const first = await service.bulkUpdateInventoryItems(command, context({ idempotencyKey: "bulk-production-1", correlationId: "bulk-correlation" }));
    expect(first.data.updated.map((item) => item.id)).toEqual(["bulk-a", "bulk-b"]);
    expect(first.data.updated).toMatchObject([
      { id: "bulk-a", location: "Shelf A", tags: ["Zed", "alpha"], version: 2 },
      { id: "bulk-b", location: "Shelf A", tags: ["Zed", "alpha"], version: 2 },
    ]);
    expect(first.audits).toHaveLength(2);
    expect(new Set(first.audits.map((audit) => audit.idempotencyKey)).size).toBe(2);
    expect(events).toEqual(["bulk-a", "bulk-b"]);

    const replay = await service.bulkUpdateInventoryItems({
      targets: [{ itemId: "bulk-a", expectedVersion: 1 }, { itemId: "bulk-b", expectedVersion: 1 }],
      changes: { location: "Shelf A", tags: { add: ["alpha", "zed"] } },
    }, context({ idempotencyKey: "bulk-production-1", correlationId: "different-correlation" }));
    expect(replay).toMatchObject({ replayed: true, data: first.data, audits: first.audits });
    expect(events).toHaveLength(2);

    const auditCountBeforeNoop = (await runtime.ports.audit.list(100)).data.length;
    const noOp = await service.bulkUpdateInventoryItems({ targets: [{ itemId: "bulk-a", expectedVersion: 2 }], changes: { location: "Shelf A" } }, context({ idempotencyKey: "bulk-production-noop" }));
    expect(noOp).toMatchObject({ data: { updated: [], unchanged: [{ id: "bulk-a", version: 2 }] }, audits: [] });
    expect((await runtime.ports.audit.list(100)).data).toHaveLength(auditCountBeforeNoop);
    expect(events).toHaveLength(2);

    await expect(service.bulkUpdateInventoryItems({
      targets: [{ itemId: "bulk-a", expectedVersion: 2 }, { itemId: "bulk-b", expectedVersion: 999 }],
      changes: { condition: "good" },
    }, context({ idempotencyKey: "bulk-production-conflict" }))).rejects.toMatchObject({
      code: "conflict",
      details: {
        staleTargets: [{ itemId: "bulk-b", expectedVersion: 999, actualVersion: 2 }],
      },
    });
    const afterConflictA = await runtime.ports.inventory.getItem("bulk-a");
    const afterConflictB = await runtime.ports.inventory.getItem("bulk-b");
    expect(afterConflictA).toMatchObject({ id: "bulk-a", version: 2 });
    expect(afterConflictB).toMatchObject({ id: "bulk-b", version: 2 });
    expect(afterConflictA).not.toHaveProperty("condition");
    expect(afterConflictB).not.toHaveProperty("condition");
    expect((await runtime.ports.audit.list(100)).data).toHaveLength(auditCountBeforeNoop);
    expect(events).toHaveLength(2);
  });

  it("derives non-colliding audit keys for different actors reusing a batch key", async () => {
    const runtime = await makeRuntime();
    await runtime.ports.inventory.createItem({
      id: "bulk-actor-item",
      name: "Bulk actor item",
      kind: "tool",
      quantity: 1,
      unit: "each",
      tags: [],
      links: [],
      evidence: { state: "physically_counted" },
    }, context());
    const service = new ApplicationService(runtime.ports);
    const first = await service.bulkUpdateInventoryItems({ targets: [{ itemId: "bulk-actor-item", expectedVersion: 1 }], changes: { location: "Actor A" } }, context({ actor: "actor-a", idempotencyKey: "shared-bulk-key" }));
    const second = await service.bulkUpdateInventoryItems({ targets: [{ itemId: "bulk-actor-item", expectedVersion: 2 }], changes: { location: "Actor B" } }, context({ actor: "actor-b", idempotencyKey: "shared-bulk-key" }));

    expect(first.audits[0]?.idempotencyKey).toMatch(/^bulk:[a-f0-9]{64}$/u);
    expect(second.audits[0]?.idempotencyKey).toMatch(/^bulk:[a-f0-9]{64}$/u);
    expect(second.audits[0]?.idempotencyKey).not.toBe(first.audits[0]?.idempotencyKey);
  });

  it("resolves BOM and reservation ancestry from a historical revision", async () => {
    const runtime = await makeRuntime();
    await runtime.ports.inventory.createItem({
      id: "historical-board",
      name: "Historical ESP32 board",
      kind: "electronic",
      quantity: 1,
      unit: "each",
      tags: [],
      links: [],
      evidence: { state: "physically_counted" }
    }, context());
    const project = await runtime.ports.projects.createProject({ id: "historical-project", name: "Historical project", status: "planned" }, context());
    const historicalRevision = await runtime.ports.projects.createProjectRevision(project.id, { id: "historical-revision", name: "Historical", status: "concept" }, context());
    const line = await runtime.ports.projects.createBomLine(historicalRevision.id, { id: "historical-bom", name: "Historical board", itemId: "historical-board", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context());
    const reservation = await runtime.ports.projects.createReservation(historicalRevision.id, { id: "historical-reservation", lineId: line.id, itemId: "historical-board", quantity: 1 }, context());
    const currentRevision = await runtime.ports.projects.createProjectRevision(project.id, { id: "current-revision", name: "Current", status: "concept" }, context());

    expect(currentRevision.id).not.toBe(historicalRevision.id);
    await expect(runtime.ports.projects.getBomLine(line.id)).resolves.toMatchObject({ id: line.id, revisionId: historicalRevision.id });
    await expect(runtime.ports.projects.getReservationDetails(reservation.id)).resolves.toMatchObject({
      projectId: project.id,
      projectRevisionId: historicalRevision.id,
      reservation: { id: reservation.id },
      bomLine: { id: line.id, revisionId: historicalRevision.id }
    });
  });

  it("persists reversible BOM retirement without changing requirement data", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-retired-bom-"));
    directories.push(dataDir);
    const first = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(first);
    const service = new ApplicationService(first.ports);
    await first.ports.inventory.createItem({
      id: "retirement-fastener",
      name: "M3 fastener",
      kind: "fastener",
      quantity: 4,
      unit: "each",
      tags: [],
      links: [],
      evidence: { state: "physically_counted" }
    }, context());
    const project = await first.ports.projects.createProject({ id: "retirement-project", name: "Retirement project", status: "planned" }, context());
    const revision = await first.ports.projects.createProjectRevision(project.id, { id: "retirement-revision", name: "Initial", status: "concept" }, context());
    const line = await first.ports.projects.createBomLine(revision.id, {
      id: "retirement-line",
      name: "M3 fastener",
      itemId: "retirement-fastener",
      requiredQuantity: 2,
      unit: "each",
      optional: false,
      constraints: {},
      alternatives: [],
      notes: "Preserve this requirement note"
    }, context());

    const reservation = await service.createReservation(revision.id, { id: "retirement-reservation", lineId: line.id, itemId: "retirement-fastener", quantity: 1 }, context());
    await expect(service.retireBomLine(line.id, line.version, context())).rejects.toMatchObject({ code: "conflict" });
    await service.releaseReservation(reservation.data.id, reservation.data.version, context());

    const retired = await service.retireBomLine(line.id, line.version, context());
    expect(retired).toMatchObject({
      data: { id: line.id, optional: false, notes: "Preserve this requirement note", version: 2 },
      audit: { action: "project.bom_line.retire" }
    });
    expect(retired.data.retiredAt).toBeDefined();
    await expect(service.listBomLines(revision.id)).resolves.toEqual([]);
    await expect(service.evaluateBomGaps(revision.id)).resolves.toMatchObject({ lines: [], totals: { suppliedLines: 0, missingLines: 0, optionalLines: 0 } });
    await expect(service.createReservation(revision.id, { lineId: line.id, itemId: "retirement-fastener", quantity: 1 }, context())).rejects.toMatchObject({ code: "not_found" });

    await first.close();
    runtimes.splice(runtimes.indexOf(first), 1);
    const reopened = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(reopened);
    const reopenedService = new ApplicationService(reopened.ports);
    await expect(reopenedService.listBomLines(revision.id)).resolves.toEqual([]);
    await expect(reopenedService.listBomLines(revision.id, { includeRetired: true })).resolves.toEqual([
      expect.objectContaining({ id: line.id, optional: false, notes: "Preserve this requirement note", version: 2, retiredAt: retired.data.retiredAt })
    ]);
    await expect(reopenedService.getBomLine(line.id)).resolves.toMatchObject({ id: line.id, retiredAt: retired.data.retiredAt });

    const restored = await reopenedService.restoreBomLine(line.id, 2, context());
    expect(restored).toMatchObject({
      data: { id: line.id, optional: false, notes: "Preserve this requirement note", version: 3 },
      audit: { action: "project.bom_line.restore" }
    });
    expect(restored.data).not.toHaveProperty("retiredAt");
    await expect(reopenedService.listBomLines(revision.id)).resolves.toEqual([expect.objectContaining({ id: line.id, version: 3 })]);
  });

  it("preserves BOM specification decisions after reopening the production runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-bom-specification-"));
    directories.push(dataDir);
    const first = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(first);
    const project = await first.ports.projects.createProject({ id: "specification-project", name: "Specification project", status: "planned" }, context());
    const revision = await first.ports.projects.createProjectRevision(project.id, { id: "specification-revision", name: "Initial", status: "concept" }, context());
    const line = await first.ports.projects.createBomLine(revision.id, {
      id: "specification-line",
      name: "12 V power supply",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      constraints: {
        specification: {
          status: "insufficient",
          missingDecisions: ["current_or_load", "connector"],
        },
      },
      alternatives: [],
    }, context());

    await first.close();
    runtimes.splice(runtimes.indexOf(first), 1);
    const reopened = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(reopened);
    const reopenedService = new ApplicationService(reopened.ports);

    await expect(reopenedService.getBomLine(line.id)).resolves.toMatchObject({
      constraints: {
        specification: {
          status: "insufficient",
          missingDecisions: ["current_or_load", "connector"],
        },
      },
    });
    await expect(reopenedService.evaluateBomGaps(revision.id)).resolves.toMatchObject({
      lines: [{ lineId: line.id, status: "specify_first", decision: "decide", missingDecisions: ["current_or_load", "connector"] }],
      totals: { requiredLines: 1, readyLines: 0, checkLines: 0, decideLines: 1, sourceLines: 0, optionalLines: 0 },
    });
  });

  it("resolves upload session ancestry after the session is persisted", async () => {
    const runtime = await makeRuntime();
    const session = await runtime.ports.artifacts.beginUpload({
      projectId: "upload-ancestry-project",
      revisionId: "upload-ancestry-revision",
      role: "step",
      filename: "part.step",
      mediaType: "model/step",
      byteSize: 1,
      sha256: "a".repeat(64)
    }, context());

    await expect(runtime.ports.artifacts.getUploadSessionDetails(session.id)).resolves.toMatchObject({
      projectId: "upload-ancestry-project",
      revisionId: "upload-ancestry-revision",
      session: { id: session.id }
    });
  });

  it("rolls back the domain mutation and suppresses events when audit append fails", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const events: unknown[] = [];
    service.subscribe((event) => { events.push(event); });
    const audit = runtime.ports.audit as typeof runtime.ports.audit & { append: typeof runtime.ports.audit.append };
    audit.append = async () => { throw new Error("audit store unavailable"); };

    await expect(service.createInventoryItem({
      id: "audit-rollback-item",
      name: "Should roll back",
      kind: "tool",
      quantity: 1,
      unit: "each",
      tags: [],
      links: [],
      evidence: { state: "physically_counted" }
    }, context({ idempotencyKey: "audit-rollback" }))).rejects.toThrow("audit store unavailable");

    await expect(runtime.ports.inventory.getItem("audit-rollback-item")).resolves.toBeNull();
    expect(runtime.database.get("SELECT id FROM audit_log WHERE entity_id = ?", ["audit-rollback-item"])).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("rolls back the domain and audit rows when idempotency persistence fails", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const idempotency = runtime.ports.idempotency as typeof runtime.ports.idempotency & { set: typeof runtime.ports.idempotency.set };
    idempotency.set = async () => { throw new Error("idempotency store unavailable"); };

    await expect(service.createInventoryItem({
      id: "idempotency-rollback-item",
      name: "Should roll back",
      kind: "tool",
      quantity: 1,
      unit: "each",
      tags: [],
      links: [],
      evidence: { state: "physically_counted" }
    }, context({ idempotencyKey: "idempotency-rollback" }))).rejects.toThrow("idempotency store unavailable");

    await expect(runtime.ports.inventory.getItem("idempotency-rollback-item")).resolves.toBeNull();
    expect(runtime.database.get("SELECT id FROM audit_log WHERE entity_id = ?", ["idempotency-rollback-item"])).toBeUndefined();
    expect(runtime.database.get("SELECT payload_json FROM forge_runtime_idempotency WHERE actor = ? AND idempotency_key = ?", ["test-agent", "idempotency-rollback"])).toBeUndefined();
  });

  it("serializes same-key commands so one mutates and the other replays", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const events: string[] = [];
    service.subscribe((event) => { events.push(event.id); });
    const input = {
      id: "same-key-item",
      name: "One item",
      kind: "tool" as const,
      quantity: 1,
      unit: "each" as const,
      tags: [],
      links: [],
      evidence: { state: "physically_counted" as const }
    };
    const firstContext = context({ idempotencyKey: "same-key", fingerprint: "same-input", correlationId: "first" });
    const secondContext = context({ idempotencyKey: "same-key", fingerprint: "same-input", correlationId: "second" });
    const [first, second] = await Promise.all([
      service.createInventoryItem(input, firstContext),
      service.createInventoryItem(input, secondContext)
    ]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(events).toHaveLength(1);
    await expect(runtime.ports.inventory.getItem(input.id)).resolves.toMatchObject({ id: input.id, quantity: 1 });
    expect(runtime.database.all("SELECT id FROM audit_log WHERE entity_id = ?", [input.id])).toHaveLength(1);
  });

  it("keeps event listener failures post-commit and continues delivery", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    let delivered = 0;
    service.subscribe(() => { throw new Error("broken subscriber"); });
    service.subscribe(() => { delivered += 1; });

    await expect(service.createInventoryItem({
      id: "event-listener-item",
      name: "Event item",
      kind: "tool",
      quantity: 1,
      unit: "each",
      tags: [],
      links: [],
      evidence: { state: "physically_counted" }
    }, context({ idempotencyKey: "event-listener" }))).resolves.toMatchObject({ replayed: false });
    expect(delivered).toBe(1);
    await expect(runtime.ports.inventory.getItem("event-listener-item")).resolves.toMatchObject({ id: "event-listener-item" });
  });

  it("keeps delivered stock uncertain while preserving API metadata and dimensions", async () => {
    const runtime = await makeRuntime();
    const item = await runtime.ports.inventory.createItem({
      id: "wire-uncounted",
      name: "Dupont jumper wire",
      kind: "wire",
      quantity: 20,
      unit: "metre",
      dimensions: { lengthMm: 2_000, widthMm: 2, measured: true, uncertaintyMm: 0.2 },
      tags: ["electronics", "jumper"],
      links: [],
      evidence: { state: "delivered_uncounted", source: "order-email", sourceId: "email-1" }
    }, context());

    expect(item).toMatchObject({
      id: "wire-uncounted",
      kind: "wire",
      quantity: 20,
      availableQuantity: 0,
      unit: "metre",
      tags: ["electronics", "jumper"],
      evidence: { state: "delivered_uncounted", source: "order-email", sourceId: "email-1" },
      dimensions: { lengthMm: 2_000, widthMm: 2, measured: true, uncertaintyMm: 0.2 }
    });
    await expect(runtime.ports.inventory.listItems({ q: "jumper", limit: 10 })).resolves.toMatchObject({ data: [{ id: "wire-uncounted" }] });
  });

  it("makes stock ledger retries idempotent without double-counting", async () => {
    const runtime = await makeRuntime();
    await runtime.ports.inventory.createItem({
      id: "board-1",
      name: "ESP32 board",
      kind: "electronic",
      quantity: 0,
      unit: "each",
      tags: ["esp32"],
      links: [],
      evidence: { state: "physically_counted" }
    }, context());

    const input = { itemId: "board-1", type: "receipt" as const, quantity: 2, unit: "each" as const, note: "received", idempotencyKey: "receipt-board-1" };
    const first = await runtime.ports.inventory.recordStockEvent(input, context({ idempotencyKey: input.idempotencyKey }));
    const replay = await runtime.ports.inventory.recordStockEvent(input, context({ idempotencyKey: input.idempotencyKey }));
    expect(replay.event.id).toBe(first.event.id);
    expect(replay.item.availableQuantity).toBe(2);
    const events = await runtime.ports.inventory.listStockEvents("board-1", 10);
    expect(events.data.filter((event) => event.type === "receipt")).toMatchObject([{ id: first.event.id }]);
    expect(events.data).toHaveLength(2); // the opening count is durable provenance, not a duplicate receipt.
    await expect(runtime.ports.inventory.getItem("board-1")).resolves.toMatchObject({ quantity: 2, availableQuantity: 2 });
  });

  it("keeps reservation allocation transactional when a reservation is rejected", async () => {
    const runtime = await makeRuntime();
    await runtime.ports.inventory.createItem({
      id: "bolt-1", name: "M3 bolt", kind: "fastener", quantity: 2, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }
    }, context());
    const project = await runtime.ports.projects.createProject({ id: "project-1", name: "Lamp", status: "planned" }, context());
    const revision = await runtime.ports.projects.createProjectRevision(project.id, { id: "revision-1", name: "Initial", status: "concept" }, context());
    const line = await runtime.ports.projects.createBomLine(revision.id, { id: "bom-1", name: "M3 bolt", itemId: "bolt-1", requiredQuantity: 2, unit: "each", optional: false, alternatives: [], constraints: {} }, context());

    const reservation = await runtime.ports.projects.createReservation(revision.id, { id: "reservation-1", lineId: line.id, itemId: "bolt-1", quantity: 1 }, context());
    expect(reservation.status).toBe("active");
    await expect(runtime.ports.projects.createReservation(revision.id, { id: "reservation-too-large", lineId: line.id, itemId: "bolt-1", quantity: 2 }, context())).rejects.toThrow(/reserve|stock|enough/i);
    await expect(runtime.ports.inventory.getItem("bolt-1")).resolves.toMatchObject({ quantity: 2, availableQuantity: 1 });
    await expect(runtime.ports.projects.listReservations(revision.id)).resolves.toHaveLength(1);
  });

  it("rejects a reservation for a wrong item, unapproved alternative or unsupported constraint", async () => {
    const runtime = await makeRuntime();
    for (const input of [
      { id: "bolt-1", name: "M3 bolt", kind: "fastener" as const },
      { id: "board-1", name: "ESP32 board", kind: "electronic" as const }
    ]) {
      await runtime.ports.inventory.createItem({ id: input.id, name: input.name, kind: input.kind, quantity: 2, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
    }
    const project = await runtime.ports.projects.createProject({ id: "project-reference", name: "Reference checks", status: "planned" }, context());
    const revision = await runtime.ports.projects.createProjectRevision(project.id, { id: "revision-reference", name: "Initial", status: "concept" }, context());
    const line = await runtime.ports.projects.createBomLine(revision.id, { id: "bom-reference", name: "M3 bolt", itemId: "bolt-1", requiredQuantity: 1, unit: "each", optional: false, alternatives: [{ itemId: "board-1", compatible: "conditional" }], constraints: {} }, context());

    await expect(runtime.ports.projects.createReservation(revision.id, { id: "reservation-wrong-item", lineId: line.id, itemId: "board-1", quantity: 1 }, context())).rejects.toMatchObject({ code: "validation" });

    // Simulate a legacy persisted row that predates the strict public constraint schema.
    const unsupportedLine = await runtime.ports.projects.createBomLine(revision.id, { id: "bom-unsupported", name: "M3 bolt", itemId: "bolt-1", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: { mysteryProperty: "anything" } as never }, context());
    await expect(runtime.ports.projects.createReservation(revision.id, { id: "reservation-unsupported", lineId: unsupportedLine.id, itemId: "bolt-1", quantity: 1 }, context())).rejects.toMatchObject({ code: "validation" });
  });

  it("keeps a reserved BOM supplied, consumes it atomically, and rejects cross-revision or reused usage", async () => {
    const runtime = await makeRuntime();
    await runtime.ports.inventory.createItem({ id: "board-reserved", name: "ESP32 board", kind: "electronic", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
    const project = await runtime.ports.projects.createProject({ id: "project-reserved", name: "Reserved project", status: "planned" }, context());
    const revision = await runtime.ports.projects.createProjectRevision(project.id, { id: "revision-reserved", name: "Initial", status: "concept" }, context());
    const line = await runtime.ports.projects.createBomLine(revision.id, { id: "bom-reserved", name: "ESP32 board", itemId: "board-reserved", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context());
    const reservation = await runtime.ports.projects.createReservation(revision.id, { id: "reservation-reserved", lineId: line.id, itemId: "board-reserved", quantity: 1 }, context());
    const service = new ApplicationService(runtime.ports);

    await expect(service.evaluateBomGaps(revision.id)).resolves.toMatchObject({ lines: [{ status: "supplied", suppliedQuantity: 1, missingQuantity: 0 }] });
    const laterRevision = await runtime.ports.projects.createProjectRevision(project.id, { id: "revision-later", name: "Later", status: "concept" }, context());
    await runtime.ports.projects.createBomLine(laterRevision.id, { id: "bom-later", name: "ESP32 board", itemId: "board-reserved", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, context());
    await expect(service.evaluateBomGaps(laterRevision.id)).resolves.toMatchObject({ lines: [{ status: "missing", suppliedQuantity: 0, missingQuantity: 1 }] });
    await expect(runtime.ports.projects.recordUsage({ reservationId: reservation.id, projectId: project.id, itemId: "board-reserved", quantity: 1, unit: "each" }, context())).resolves.toMatchObject({ event: { type: "consume", itemId: "board-reserved", quantity: 1 } });
    await expect(runtime.ports.projects.listReservations(revision.id)).resolves.toMatchObject([{ id: reservation.id, status: "consumed", version: 2 }]);
    await expect(service.evaluateBomGaps(revision.id)).resolves.toMatchObject({ lines: [{ status: "missing", suppliedQuantity: 0, missingQuantity: 1 }] });
    await expect(runtime.ports.inventory.getItem("board-reserved")).resolves.toMatchObject({ quantity: 0, availableQuantity: 0 });

    await expect(runtime.ports.projects.recordUsage({ reservationId: reservation.id, projectId: project.id, itemId: "board-reserved", quantity: 1, unit: "each" }, context())).rejects.toMatchObject({ code: "conflict" });
    await runtime.ports.projects.createProject({ id: "other-project", name: "Other project", status: "planned" }, context());
    await expect(runtime.ports.projects.recordUsage({ reservationId: reservation.id, projectId: "other-project", itemId: "board-reserved", quantity: 1, unit: "each" }, context())).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not partially consume or reuse a released reservation", async () => {
    const runtime = await makeRuntime();
    await runtime.ports.inventory.createItem({ id: "board-partial", name: "ESP32 board", kind: "electronic", quantity: 2, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
    const project = await runtime.ports.projects.createProject({ id: "project-partial", name: "Partial usage", status: "planned" }, context());
    const revision = await runtime.ports.projects.createProjectRevision(project.id, { id: "revision-partial", name: "Initial", status: "concept" }, context());
    const line = await runtime.ports.projects.createBomLine(revision.id, { id: "bom-partial", name: "ESP32 board", itemId: "board-partial", requiredQuantity: 2, unit: "each", optional: false, alternatives: [], constraints: {} }, context());
    const reservation = await runtime.ports.projects.createReservation(revision.id, { id: "reservation-partial", lineId: line.id, itemId: "board-partial", quantity: 2 }, context());

    await expect(runtime.ports.projects.recordUsage({ reservationId: reservation.id, projectId: project.id, itemId: "board-partial", quantity: 1, unit: "each" }, context())).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.ports.projects.listReservations(revision.id)).resolves.toMatchObject([{ id: reservation.id, status: "active", version: 1 }]);
    await expect(runtime.ports.inventory.getItem("board-partial")).resolves.toMatchObject({ quantity: 2, availableQuantity: 0 });
    await expect(runtime.ports.projects.releaseReservation(reservation.id, undefined, context())).resolves.toMatchObject({ status: "released", version: 2 });
    await expect(runtime.ports.projects.recordUsage({ reservationId: reservation.id, projectId: project.id, itemId: "board-partial", quantity: 2, unit: "each" }, context())).rejects.toMatchObject({ code: "conflict" });
    await expect(runtime.ports.inventory.getItem("board-partial")).resolves.toMatchObject({ quantity: 2, availableQuantity: 2 });
  });

  it("rolls back the project when initial revision creation fails", async () => {
    const runtime = await makeRuntime();
    const existing = await runtime.ports.projects.createProject({ id: "existing-project", name: "Existing", status: "planned" }, context());
    await runtime.ports.projects.createProjectRevision(existing.id, { id: "revision-collision", name: "Existing revision", status: "concept" }, context());

    await expect(runtime.ports.projects.createProjectWithInitialRevision?.({
      project: { id: "orphan-project", name: "Should roll back", status: "planned" },
      revision: { id: "revision-collision", name: "Initial", status: "concept" }
    }, context())).rejects.toMatchObject({ code: "conflict" });

    await expect(runtime.ports.projects.getProject("orphan-project")).resolves.toBeNull();
    expect(runtime.database.get("SELECT id FROM projects WHERE id = ?", ["orphan-project"])).toBeUndefined();
    expect(runtime.database.get("SELECT entity_id FROM forge_runtime_metadata WHERE entity_type = ? AND entity_id = ?", ["project", "orphan-project"])).toBeUndefined();
  });

  it("round-trips finalized artifact bytes and their digest", async () => {
    const runtime = await makeRuntime();
    const body = Buffer.from("opaque STEP bytes\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const session = await runtime.ports.artifacts.beginUpload({
      projectId: "project-artifact",
      revisionId: "revision-artifact",
      role: "step",
      filename: "part.step",
      mediaType: "model/step",
      byteSize: body.length,
      sha256,
      author: "test-agent"
    }, context());
    expect(session.status).toBe("pending");
    await expect(runtime.ports.artifacts.writeUpload(session.id, body)).resolves.toEqual({ receivedBytes: body.length });
    const artifact = await runtime.ports.artifacts.finalizeUpload(session.id, context());
    expect(artifact).toMatchObject({ projectId: "project-artifact", revisionId: "revision-artifact", filename: "part.step", byteSize: body.length, sha256, retired: false });
    const downloaded = await runtime.ports.artifacts.readArtifact(artifact.id);
    expect(Buffer.from(downloaded.body)).toEqual(body);
    expect(downloaded.artifact.sha256).toBe(sha256);
  });

  it("binds finalized artifacts to the same-revision snapshot and rolls back failed bindings", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const project = await service.createProject({ id: "binding-project", name: "Binding project", status: "planned" }, context());
    const revision = await service.createProjectRevision(project.data.id, { id: "binding-revision", name: "Initial", status: "concept" }, context());
    const laterRevision = await service.createProjectRevision(project.data.id, { id: "binding-revision-later", name: "Later", status: "concept" }, context());
    const printerProduct = await service.createCatalogProduct({ kind: "printer", manufacturer: "Bambu Lab", exactModel: "H2D", technology: "fff", buildVolumeMm: { x: 325, y: 320, z: 325 } }, context());
    const filamentProduct = await service.createCatalogProduct({ kind: "filament", manufacturer: "Bambu Lab", productName: "PETG HF", materialFamily: "PETG", colourName: "Black", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, context());
    const printer = await service.createInventoryWithProductProfile({
      item: { id: "binding-printer-item", name: "H2D bench", kind: "printer", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "commissioned" } },
      profile: { catalogProductId: printerProduct.data.id, profileType: "printer_asset", linkState: "confirmed", details: { assetLabel: "H2D bench" } }
    }, context());
    const filament = await service.createInventoryWithProductProfile({
      item: { id: "binding-filament-item", name: "PETG HF spool", kind: "filament", quantity: 1000, unit: "gram", tags: [], links: [], evidence: { state: "physically_counted" } },
      profile: { catalogProductId: filamentProduct.data.id, profileType: "filament_spool", linkState: "confirmed", details: { lot: "LOT-BINDING" } }
    }, context());
    const snapshot = await service.createBuildConfiguration(revision.data.id, {
      id: "binding-snapshot",
      printerItemSnapshot: { itemId: printer.data.item.id, catalogProductId: printerProduct.data.id, profileId: printer.data.profile.id },
      filamentSelections: [{ itemId: filament.data.item.id, catalogProductId: filamentProduct.data.id, profileId: filament.data.profile.id }],
      activeHotend: { side: "left", model: "H2D stock hotend" },
      nozzle: { diameterMm: 0.4, material: "hardened_steel" },
      plate: { name: "Cool Plate", surface: "smooth" },
      accessories: [],
      firmware: { version: "01.08.00.00" },
      slicer: { name: "Bambu Studio", version: "1.10.0" },
      profile: { name: "0.20mm Standard", version: "1" },
      calibration: { state: "current", recordedAt: "2026-08-30T00:00:00.000Z" },
      explicitUnknowns: []
    }, context());

    const body = Buffer.from("bound-step");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const begun = await service.beginArtifactUpload({ projectId: project.data.id, projectRevisionId: revision.data.id, buildConfigurationSnapshotId: snapshot.data.id, role: "step", filename: "bound.step", mediaType: "model/step", byteSize: body.length, sha256 }, context());
    await runtime.ports.artifacts.writeUpload(begun.data.id, body);
    const finalized = await service.finalizeArtifactUpload(begun.data.id, context());
    expect(finalized.data).toMatchObject({ id: begun.data.artifactId, revisionId: revision.data.id });
    expect(runtime.database.all("SELECT artifact_id, build_configuration_snapshot_id, project_revision_id FROM artifact_build_configuration_bindings WHERE artifact_id = ?", [finalized.data.id])).toEqual([
      { artifact_id: finalized.data.id, build_configuration_snapshot_id: snapshot.data.id, project_revision_id: revision.data.id }
    ]);

    await expect(service.beginArtifactUpload({ projectId: project.data.id, projectRevisionId: laterRevision.data.id, buildConfigurationSnapshotId: snapshot.data.id, role: "step", filename: "wrong-begin.step", mediaType: "model/step", byteSize: body.length, sha256 }, context())).rejects.toMatchObject({ code: "validation" });
    const directCrossRevision = await runtime.ports.artifacts.beginUpload({ projectId: project.data.id, revisionId: laterRevision.data.id, buildConfigurationSnapshotId: snapshot.data.id, role: "step", filename: "wrong-finalize.step", mediaType: "model/step", byteSize: body.length, sha256 }, context());
    await runtime.ports.artifacts.writeUpload(directCrossRevision.id, body);
    await expect(service.finalizeArtifactUpload(directCrossRevision.id, context())).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.ports.artifacts.getArtifact(directCrossRevision.artifactId)).resolves.toBeNull();

    const failingBinding = runtime.ports.artifacts as typeof runtime.ports.artifacts & { bindBuildConfiguration: NonNullable<typeof runtime.ports.artifacts.bindBuildConfiguration> };
    const originalBinding = failingBinding.bindBuildConfiguration;
    failingBinding.bindBuildConfiguration = async () => { throw new Error("forced binding failure"); };
    try {
      const failedBegin = await service.beginArtifactUpload({ projectId: project.data.id, projectRevisionId: revision.data.id, buildConfigurationSnapshotId: snapshot.data.id, role: "step", filename: "failed-binding.step", mediaType: "model/step", byteSize: body.length, sha256 }, context());
      await runtime.ports.artifacts.writeUpload(failedBegin.data.id, body);
      await expect(service.finalizeArtifactUpload(failedBegin.data.id, context())).rejects.toThrow("forced binding failure");
      await expect(runtime.ports.artifacts.getArtifact(failedBegin.data.artifactId)).resolves.toBeNull();
      expect(runtime.database.all("SELECT artifact_id FROM artifact_build_configuration_bindings WHERE artifact_id = ?", [failedBegin.data.artifactId])).toHaveLength(0);
      await expect(runtime.artifacts.listArtifactRevisions()).resolves.toMatchObject({ ok: true, value: expect.not.arrayContaining([expect.objectContaining({ artifactId: failedBegin.data.artifactId })]) });
    } finally {
      failingBinding.bindBuildConfiguration = originalBinding;
    }
  });

  it("removes filesystem artifacts when the audited finalization rolls back", async () => {
    const runtime = await makeRuntime();
    const project = await runtime.ports.projects.createProject({ id: "artifact-rollback-project", name: "Artifact rollback", status: "planned" }, context());
    const revision = await runtime.ports.projects.createProjectRevision(project.id, { id: "artifact-rollback-revision", name: "Initial", status: "concept" }, context());
    const service = new ApplicationService(runtime.ports);
    const body = Buffer.from("artifact audit rollback\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const begun = await service.beginArtifactUpload({ projectId: project.id, projectRevisionId: revision.id, role: "step", filename: "rollback.step", mediaType: "model/step", byteSize: body.length, sha256 }, context());
    await runtime.ports.artifacts.writeUpload(begun.data.id, body);

    const audit = runtime.ports.audit as typeof runtime.ports.audit & { append: typeof runtime.ports.audit.append };
    const originalAppend = audit.append;
    audit.append = async () => { throw new Error("injected artifact audit failure"); };
    await expect(service.finalizeArtifactUpload(begun.data.id, context())).rejects.toThrow("injected artifact audit failure");
    audit.append = originalAppend;

    const records = await runtime.artifacts.listArtifactRevisions();
    expect(records).toMatchObject({ ok: true, value: [] });
    await expect(runtime.ports.artifacts.getArtifact(begun.data.artifactId)).resolves.toBeNull();
    await expect(runtime.artifacts.recoverUpload(begun.data.id)).resolves.toMatchObject({ ok: true, value: { status: "open", bytesWritten: body.length } });
    await expect(service.finalizeArtifactUpload(begun.data.id, context())).resolves.toMatchObject({ data: { sha256 } });
    const afterRetry = await runtime.artifacts.listArtifactRevisions();
    expect(afterRetry.ok).toBe(true);
    if (afterRetry.ok) expect(afterRetry.value).toHaveLength(1);
  });

  it("removes a filesystem upload session when the audited begin mutation rolls back", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const rollbackProject = await runtime.ports.projects.createProject({ id: "begin-rollback-project", name: "Begin rollback", status: "planned" }, context());
    await runtime.ports.projects.createProjectRevision(rollbackProject.id, { id: "begin-rollback-revision", name: "Initial", status: "concept" }, context());
    const artifactPort = runtime.ports.artifacts;
    const originalBegin = artifactPort.beginUpload.bind(artifactPort);
    let sessionId: string | undefined;
    artifactPort.beginUpload = async (input, requestContext) => {
      const session = await originalBegin(input, requestContext);
      sessionId = session.id;
      return session;
    };
    const audit = runtime.ports.audit as typeof runtime.ports.audit & { append: typeof runtime.ports.audit.append };
    audit.append = async () => { throw new Error("injected begin audit failure"); };

    await expect(service.beginArtifactUpload({ projectId: "begin-rollback-project", projectRevisionId: "begin-rollback-revision", role: "step", filename: "begin-rollback.step", mediaType: "model/step", byteSize: 1, sha256: "a".repeat(64) }, context())).rejects.toThrow("injected begin audit failure");
    expect(sessionId).toEqual(expect.any(String));
    const session = await runtime.artifacts.getUploadSession(sessionId!);
    expect(session).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const orphans = await runtime.artifacts.listOrphanUploads();
    expect(orphans).toMatchObject({ ok: true, value: [] });
  });

  it("aborts the filesystem session when begin metadata persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "benchledger-adapter-begin-"));
    directories.push(root);
    const store = new ArtifactStore({ root: join(root, "artifacts"), maxUploadBytes: 1024, maxStorageBytes: 4096 });
    expect((await store.init()).ok).toBe(true);
    let metadataWrites = 0;
    const failingState = {
      setMetadata: () => {
        metadataWrites += 1;
        throw new Error("injected metadata persistence failure");
      }
    } as unknown as RuntimeState;
    const adapter = new ProductionArtifactAdapter(store, failingState, {
      exclusive: <T>(operation: () => T | PromiseLike<T>): Promise<T> => Promise.resolve(operation())
    });

    await expect(adapter.beginUpload({ projectId: "adapter-begin-project", role: "step", filename: "part.step", mediaType: "model/step", byteSize: 1, sha256: "a".repeat(64) }, context())).rejects.toMatchObject({ code: "integrity_error" });
    expect(metadataWrites).toBe(1);
    const orphans = await store.listOrphanUploads();
    expect(orphans).toMatchObject({ ok: true, value: [] });
  });

  it("compensates a new finalization when artifact metadata projection fails", async () => {
    const runtime = await makeRuntime();
    const state = new RuntimeState(runtime.database);
    const adapter = new ProductionArtifactAdapter(runtime.artifacts, state, runtime.unitOfWork);
    const body = Buffer.from("adapter projection metadata failure\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const session = await adapter.beginUpload({ projectId: "adapter-projection-project", role: "step", filename: "part.step", mediaType: "model/step", byteSize: body.length, sha256 }, context());
    await adapter.writeUpload(session.id, body);

    const originalSetMetadata = state.setMetadata.bind(state);
    let artifactMetadataWrites = 0;
    state.setMetadata = (entityType, entityId, payload) => {
      if (entityType === "artifact") {
        artifactMetadataWrites += 1;
        throw new Error("injected artifact metadata projection failure");
      }
      originalSetMetadata(entityType, entityId, payload);
    };
    try {
      await expect(adapter.finalizeUpload(session.id, context())).rejects.toMatchObject({ code: "integrity_error" });
    } finally {
      state.setMetadata = originalSetMetadata;
    }

    expect(artifactMetadataWrites).toBe(1);
    expect(await runtime.artifacts.listArtifactRevisions()).toMatchObject({ ok: true, value: [] });
    await expect(runtime.artifacts.recoverUpload(session.id)).resolves.toMatchObject({ ok: true, value: { status: "open", bytesWritten: body.length } });
    expect(runtime.database.get("SELECT entity_id FROM forge_runtime_versions WHERE entity_type = ? AND entity_id = ?", ["artifact", session.artifactId])).toBeUndefined();
    expect(runtime.database.get("SELECT entity_id FROM forge_runtime_metadata WHERE entity_type = ? AND entity_id = ?", ["artifact", session.artifactId])).toBeUndefined();

    const retry = await adapter.finalizeUpload(session.id, context());
    expect(retry).toMatchObject({ id: session.artifactId, sha256 });
    await adapter.commitFinalization(session.id, retry.id);
  });

  it("compensates a new finalization when artifact version projection fails", async () => {
    const runtime = await makeRuntime();
    const state = new RuntimeState(runtime.database);
    const adapter = new ProductionArtifactAdapter(runtime.artifacts, state, runtime.unitOfWork);
    const body = Buffer.from("adapter projection version failure\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const session = await adapter.beginUpload({ projectId: "adapter-version-project", role: "step", filename: "part.step", mediaType: "model/step", byteSize: body.length, sha256 }, context());
    await adapter.writeUpload(session.id, body);

    const originalSetInitialVersion = state.setInitialVersion.bind(state);
    let versionWrites = 0;
    state.setInitialVersion = (entityType, entityId) => {
      if (entityType === "artifact") {
        versionWrites += 1;
        throw new Error("injected artifact version projection failure");
      }
      originalSetInitialVersion(entityType, entityId);
    };
    try {
      await expect(adapter.finalizeUpload(session.id, context())).rejects.toMatchObject({ code: "integrity_error" });
    } finally {
      state.setInitialVersion = originalSetInitialVersion;
    }

    expect(versionWrites).toBe(1);
    expect(await runtime.artifacts.listArtifactRevisions()).toMatchObject({ ok: true, value: [] });
    await expect(runtime.artifacts.recoverUpload(session.id)).resolves.toMatchObject({ ok: true, value: { status: "open", bytesWritten: body.length } });
    expect(runtime.database.get("SELECT entity_id FROM forge_runtime_versions WHERE entity_type = ? AND entity_id = ?", ["artifact", session.artifactId])).toBeUndefined();
    expect(runtime.database.get("SELECT entity_id FROM forge_runtime_metadata WHERE entity_type = ? AND entity_id = ?", ["artifact", session.artifactId])).toBeUndefined();

    const retry = await adapter.finalizeUpload(session.id, context());
    expect(retry).toMatchObject({ id: session.artifactId, sha256 });
    await adapter.commitFinalization(session.id, retry.id);
  });

  it("does not compensate an already-finalized replay when projection fails", async () => {
    const runtime = await makeRuntime();
    const state = new RuntimeState(runtime.database);
    const adapter = new ProductionArtifactAdapter(runtime.artifacts, state, runtime.unitOfWork);
    const body = Buffer.from("adapter finalized replay\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const session = await adapter.beginUpload({ projectId: "adapter-replay-project", role: "step", filename: "part.step", mediaType: "model/step", byteSize: body.length, sha256 }, context());
    await adapter.writeUpload(session.id, body);
    const first = await adapter.finalizeUpload(session.id, context());
    await adapter.commitFinalization(session.id, first.id);

    const originalSetMetadata = state.setMetadata.bind(state);
    state.setMetadata = (entityType, entityId, payload) => {
      if (entityType === "artifact") throw new Error("injected replay metadata projection failure");
      originalSetMetadata(entityType, entityId, payload);
    };
    let rollbackCalls = 0;
    const originalRollback = runtime.artifacts.rollbackFinalization.bind(runtime.artifacts);
    runtime.artifacts.rollbackFinalization = async (...args: Parameters<typeof runtime.artifacts.rollbackFinalization>) => {
      rollbackCalls += 1;
      return originalRollback(...args);
    };
    try {
      await expect(adapter.finalizeUpload(session.id, context())).rejects.toMatchObject({ code: "integrity_error" });
    } finally {
      state.setMetadata = originalSetMetadata;
      runtime.artifacts.rollbackFinalization = originalRollback;
    }

    expect(rollbackCalls).toBe(0);
    expect(await runtime.artifacts.listArtifactRevisions()).toMatchObject({ ok: true, value: [expect.objectContaining({ artifactId: session.artifactId })] });
    await expect(runtime.artifacts.getUploadSession(session.id)).resolves.toMatchObject({ ok: true, value: { status: "finalized" } });
  });

  it("preserves retirement when finalization is replayed", async () => {
    const runtime = await makeRuntime();
    const state = new RuntimeState(runtime.database);
    const adapter = new ProductionArtifactAdapter(runtime.artifacts, state, runtime.unitOfWork);
    const body = Buffer.from("retired artifact replay\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const session = await adapter.beginUpload({ projectId: "retired-replay-project", role: "step", filename: "part.step", mediaType: "model/step", byteSize: body.length, sha256 }, context());
    await adapter.writeUpload(session.id, body);

    const finalized = await adapter.finalizeUpload(session.id, context());
    const retired = await adapter.retireArtifact(finalized.id, finalized.version, context());
    expect(retired).toMatchObject({ id: finalized.id, version: finalized.version + 1, retired: true, currentCandidate: false });

    const replay = await adapter.finalizeUpload(session.id, context());
    expect(replay).toMatchObject({ id: finalized.id, version: retired.version, retired: true, currentCandidate: false });
    await expect(adapter.getArtifact(finalized.id)).resolves.toMatchObject({ id: finalized.id, version: retired.version, retired: true, currentCandidate: false });
  });

  it("reports an adapter compensation failure as an integrity error", async () => {
    const runtime = await makeRuntime();
    const state = new RuntimeState(runtime.database);
    const adapter = new ProductionArtifactAdapter(runtime.artifacts, state, runtime.unitOfWork);
    const body = Buffer.from("adapter compensation failure\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const session = await adapter.beginUpload({ projectId: "adapter-compensation-project", role: "step", filename: "part.step", mediaType: "model/step", byteSize: body.length, sha256 }, context());
    await adapter.writeUpload(session.id, body);

    const originalSetMetadata = state.setMetadata.bind(state);
    state.setMetadata = (entityType, entityId, payload) => {
      if (entityType === "artifact") throw new Error("injected projection failure");
      originalSetMetadata(entityType, entityId, payload);
    };
    const originalRollback = runtime.artifacts.rollbackFinalization.bind(runtime.artifacts);
    runtime.artifacts.rollbackFinalization = async () => ({ ok: false as const, error: { code: "IO_ERROR" as const, message: "injected compensation failure", details: {} } });
    try {
      await expect(adapter.finalizeUpload(session.id, context())).rejects.toMatchObject({
        code: "integrity_error",
        message: "Artifact finalization failed and could not be compensated",
        details: { sessionId: session.id, artifactId: session.artifactId, compensationError: "The artifact operation failed" }
      });
    } finally {
      state.setMetadata = originalSetMetadata;
      runtime.artifacts.rollbackFinalization = originalRollback;
    }

    expect(await runtime.artifacts.listArtifactRevisions()).toMatchObject({ ok: true, value: [expect.objectContaining({ artifactId: session.artifactId })] });
    await expect(runtime.artifacts.getUploadSession(session.id)).resolves.toMatchObject({ ok: true, value: { status: "finalized" } });
  });

  it("reopens a configured data directory with persisted state and readiness", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-runtime-persist-"));
    directories.push(dataDir);
    const first = await createProductionRuntime({ dataDir, maxUploadBytes: 1024, maxStorageBytes: 4096 });
    await first.ports.inventory.createItem({ id: "persisted", name: "Persisted tool", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
    await first.close();
    const second = await createProductionRuntime({ dataDir, maxUploadBytes: 1024, maxStorageBytes: 4096 });
    runtimes.push(second);
    await expect(second.ports.inventory.getItem("persisted")).resolves.toMatchObject({ id: "persisted", quantity: 1 });
    await expect(second.ports.health?.check()).resolves.toEqual({ database: "ok", artifacts: "ok" });
  });

  it("creates an online SQLite plus artifact-hash backup and verifies a separate restore", async () => {
    const runtime = await makeRuntime();
    await runtime.ports.inventory.createItem({ id: "backup-item", name: "Backup tool", kind: "tool", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" } }, context());
    const backupRoot = await mkdtemp(join(tmpdir(), "benchledger-backup-parent-"));
    directories.push(backupRoot);
    const backupDirectory = join(backupRoot, "snapshot");
    const manifest = await backupProductionRuntime(runtime, backupDirectory);
    expect(manifest.format).toBe("benchledger-backup");
    expect(manifest.artifacts).toHaveLength(0);
    await expect(verifyProductionBackup(backupDirectory, { maxUploadBytes: 1024, maxStorageBytes: 4096 })).resolves.toMatchObject({ databaseSha256: manifest.databaseSha256 });
    const restoreDirectory = join(backupRoot, "restore");
    const restored = await restoreProductionBackup(backupDirectory, restoreDirectory, { maxUploadBytes: 1024, maxStorageBytes: 4096 });
    runtimes.push(restored);
    await expect(restored.ports.inventory.getItem("backup-item")).resolves.toMatchObject({ id: "backup-item", quantity: 1 });
  });

  it("freezes raw artifact writes until a backup snapshot has completed", async () => {
    const runtime = await makeRuntime();
    const body = Buffer.from("delayed artifact bytes\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const session = await runtime.ports.artifacts.beginUpload({
      projectId: "project-backup-upload",
      revisionId: "revision-backup-upload",
      role: "step",
      filename: "delayed.step",
      mediaType: "model/step",
      byteSize: body.length,
      sha256
    }, context());
    let uploadStarted!: () => void;
    const uploadReady = new Promise<void>((resolve) => { uploadStarted = resolve; });
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const artifactStore = runtime.artifacts as typeof runtime.artifacts & { writeUpload: typeof runtime.artifacts.writeUpload };
    const originalWrite = artifactStore.writeUpload.bind(runtime.artifacts);
    artifactStore.writeUpload = async (...args: Parameters<typeof runtime.artifacts.writeUpload>) => {
      uploadStarted();
      await uploadGate;
      return originalWrite(...args);
    };

    const upload = runtime.ports.artifacts.writeUpload(session.id, body);
    await uploadReady;
    const backupRoot = await mkdtemp(join(tmpdir(), "benchledger-backup-upload-parent-"));
    directories.push(backupRoot);
    const destination = join(backupRoot, "snapshot");
    let finished = false;
    const backup = backupProductionRuntime(runtime, destination).then((value) => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });

    releaseUpload();
    await upload;
    await backup;
    expect(finished).toBe(true);
    expect((await readdir(backupRoot)).filter((name) => name.includes("partial"))).toEqual([]);
    artifactStore.writeUpload = originalWrite;
  });

  it("waits for an outer SQLite mutation before copying a backup", async () => {
    const runtime = await makeRuntime();
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => { mutationStarted = resolve; });
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutation = runtime.unitOfWork.transactional(async () => {
      runtime.database.run("INSERT INTO forge_meta (key, value) VALUES (?, ?)", ["backup-barrier", "committed-after-wait"]);
      mutationStarted();
      await mutationGate;
    });
    await started;

    const backupRoot = await mkdtemp(join(tmpdir(), "benchledger-backup-mutation-parent-"));
    directories.push(backupRoot);
    const destination = join(backupRoot, "snapshot");
    let finished = false;
    const backup = backupProductionRuntime(runtime, destination).then((value) => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });

    releaseMutation();
    await mutation;
    await backup;
    expect(finished).toBe(true);
    const snapshot = new BenchDatabase(join(destination, "benchledger.sqlite"));
    expect(snapshot.get("SELECT value FROM forge_meta WHERE key = ?", ["backup-barrier"])).toMatchObject({ value: "committed-after-wait" });
    snapshot.close();
  });

  it("backs up finalized artifact bytes and metadata as one self-verified snapshot", async () => {
    const runtime = await makeRuntime();
    const body = Buffer.from("coherent artifact bytes\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const session = await runtime.ports.artifacts.beginUpload({
      projectId: "project-coherent-backup",
      revisionId: "revision-coherent-backup",
      role: "cad_source",
      filename: "source.step",
      mediaType: "model/step",
      byteSize: body.length,
      sha256
    }, context());
    await runtime.ports.artifacts.writeUpload(session.id, body);
    const artifact = await runtime.ports.artifacts.finalizeUpload(session.id, context());
    const backupRoot = await mkdtemp(join(tmpdir(), "benchledger-backup-coherent-parent-"));
    directories.push(backupRoot);
    const destination = join(backupRoot, "snapshot");
    const manifest = await backupProductionRuntime(runtime, destination);
    expect(manifest.artifacts).toMatchObject([{ artifactId: artifact.id, bytes: body.length, sha256 }]);
    await expect(verifyProductionBackup(destination, { maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 })).resolves.toMatchObject({ artifacts: [{ artifactId: artifact.id, sha256 }] });
  });

  it("does not publish a failed or partial backup when self-verification fails", async () => {
    const runtime = await makeRuntime();
    const backupRoot = await mkdtemp(join(tmpdir(), "benchledger-backup-failure-parent-"));
    directories.push(backupRoot);
    const destination = join(backupRoot, "snapshot");
    const artifactStore = runtime.artifacts as typeof runtime.artifacts & { listArtifactRevisions: typeof runtime.artifacts.listArtifactRevisions };
    const originalList = artifactStore.listArtifactRevisions.bind(runtime.artifacts);
    artifactStore.listArtifactRevisions = async () => ({ ok: true as const, value: [{
      version: 1 as const,
      artifactId: "invented-artifact",
      artifactRevisionId: "invented-revision",
      projectId: "invented-project",
      filename: "invented.step",
      bytes: 99,
      sha256: "f".repeat(64),
      storageKey: "sha256/ff/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      createdAt: "2026-08-30T00:00:00.000Z"
    }] });

    await expect(backupProductionRuntime(runtime, destination)).rejects.toThrow(/artifact|manifest|verification/i);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(backupRoot)).filter((name) => name.includes("partial"))).toEqual([]);
    artifactStore.listArtifactRevisions = originalList;
  });
});
