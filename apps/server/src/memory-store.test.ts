import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CatalogProduct } from "@benchledger/api-contract";
import { ApplicationService } from "@benchledger/application";
import { createMemoryRuntime, MemoryUnitOfWork } from "./memory-store.js";

describe("MemoryInventory", () => {
  it("does not change a directly reserved BOM line to reusable", async () => {
    const runtime = createMemoryRuntime([{
      id: "reserved-role-item", name: "Reserved board", kind: "electronic", quantity: 1, availableQuantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1
    }]);
    await runtime.projects.createProject({ id: "reserved-role-project", name: "Role project", status: "planned" });
    const revision = await runtime.projects.createProjectRevision("reserved-role-project", { id: "reserved-role-revision", name: "Initial", status: "concept" });
    const line = await runtime.projects.createBomLine(revision.id, { id: "reserved-role-line", name: "Reserved board", role: "consumed", itemId: "reserved-role-item", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} });
    const reservation = await runtime.projects.createReservation(revision.id, { id: "reserved-role-reservation", lineId: line.id, itemId: "reserved-role-item", quantity: 1 });

    await expect(Promise.resolve().then(() => runtime.projects.updateBomLine(line.id, { role: "reusable" }, line.version))).rejects.toMatchObject({ code: "conflict" });
    await runtime.projects.releaseReservation(reservation.id, reservation.version);
    await expect(runtime.projects.updateBomLine(line.id, { role: "reusable" }, line.version)).resolves.toMatchObject({ role: "reusable", version: 2 });
  });

  it("blocks a legacy null role from becoming reusable while preserving null to consumed", async () => {
    const runtime = createMemoryRuntime([{
      id: "legacy-reserved-role-item", name: "Legacy reserved board", kind: "electronic", quantity: 1, availableQuantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1
    }]);
    await runtime.projects.createProject({ id: "legacy-reserved-role-project", name: "Legacy role project", status: "planned" });
    const revision = await runtime.projects.createProjectRevision("legacy-reserved-role-project", { id: "legacy-reserved-role-revision", name: "Initial", status: "concept" });
    const line = await runtime.projects.createBomLine(revision.id, { id: "legacy-reserved-role-line", name: "Legacy reserved board", role: null, itemId: "legacy-reserved-role-item", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} });
    runtime.projects.reservations.set("legacy-reserved-role-reservation", { id: "legacy-reserved-role-reservation", lineId: line.id, itemId: "legacy-reserved-role-item", quantity: 1, status: "active", createdAt: line.createdAt, updatedAt: line.updatedAt, version: 1 });

    await expect(Promise.resolve().then(() => runtime.projects.updateBomLine(line.id, { role: "reusable" }, line.version))).rejects.toMatchObject({ code: "conflict" });
    await expect(runtime.projects.updateBomLine(line.id, { role: "consumed" }, line.version)).resolves.toMatchObject({ role: "consumed", version: 2 });
  });

  it("round-trips consumed, reusable, and legacy requirement roles through direct and atomic writes", async () => {
    const runtime = createMemoryRuntime();
    const service = new ApplicationService(runtime.ports);
    const context = { actor: "memory-role-test", source: "api" as const, correlationId: "memory-role-test", scopes: new Set(["projects:write", "bom:write"]) };
    const project = await service.createProject({ id: "memory-role-project", name: "Role project", status: "planned" }, context);
    const revision = await service.createProjectRevision(project.data.id, { id: "memory-role-revision", name: "Initial", status: "concept" }, context);
    await service.createBomLine(revision.data.id, { id: "memory-role-consumed", name: "Fastener", role: "consumed", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }, context);
    await service.createBomLine(revision.data.id, { id: "memory-role-reusable", name: "Tool", role: "reusable", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }, context);
    await service.createBomLine(revision.data.id, { id: "memory-role-legacy", name: "Legacy", role: null, requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }, context);
    await expect(service.listBomLines(revision.data.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "memory-role-consumed", role: "consumed" }),
      expect.objectContaining({ id: "memory-role-reusable", role: "reusable" }),
      expect.objectContaining({ id: "memory-role-legacy", role: null }),
    ]));

    const preview = await service.previewProjectSetup({ project: { id: "memory-role-setup", name: "Role setup", status: "planned" }, revision: { id: "memory-role-setup-revision", name: "Initial", status: "concept" }, workItems: [], bomLines: [{ localRef: "tool", id: "memory-role-setup-tool", name: "Reusable tool", role: "reusable", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }], reservations: [] }, context);
    const committed = await service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: false }, { ...context, idempotencyKey: "memory-role-setup-commit" });
    expect(committed.data.bomLines).toEqual([expect.objectContaining({ id: "memory-role-setup-tool", role: "reusable" })]);
  });

  it("supports an atomic setup preview and commit with allocation evidence", async () => {
    const runtime = createMemoryRuntime([{
      id: "memory-setup-stock", name: "M3 screw", kind: "fastener", quantity: 3, availableQuantity: 3, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1
    }]);
    const service = new ApplicationService(runtime.ports);
    const context = { actor: "memory-setup-test", source: "api" as const, correlationId: "memory-setup", scopes: new Set(["projects:write", "bom:write"]) };
    const preview = await service.previewProjectSetup({
      project: { id: "memory-setup-project", name: "Memory setup", status: "planned" },
      revision: { id: "memory-setup-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "screws", id: "memory-setup-line", name: "M3 screw", role: "consumed", itemId: "memory-setup-stock", requiredQuantity: 2, unit: "each", optional: false, constraints: {}, alternatives: [] }],
      reservations: [{ localRef: "screw-reservation", bomLineLocalRef: "screws", id: "memory-setup-reservation", itemId: "memory-setup-stock", quantity: 2, unit: "each" }]
    }, context);
    expect(preview.status).toBe("active");
    const committed = await service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, { ...context, idempotencyKey: "memory-setup-key" });
    expect(committed.data).toMatchObject({ project: { id: "memory-setup-project" }, reservations: [{ id: "memory-setup-reservation" }], auditIds: [committed.audit.id] });
    expect(runtime.inventory.items.get("memory-setup-stock")?.availableQuantity).toBe(1);
    expect(runtime.inventory.events.get("memory-setup-stock")?.at(-1)).toMatchObject({ id: "reservation-memory-setup-reservation-allocate", type: "allocate", quantity: 2 });
  });

  it("keeps a planned reservation exclusive when two setup lines share one item", async () => {
    const runtime = createMemoryRuntime([{
      id: "memory-shared-setup-stock", name: "Shared board", kind: "electronic", quantity: 1, availableQuantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1
    }]);
    const service = new ApplicationService(runtime.ports);
    const context = { actor: "memory-shared-setup", source: "api" as const, correlationId: "memory-shared-setup", scopes: new Set(["projects:write", "bom:write"]) };
    const proposal = {
      project: { id: "memory-shared-project", name: "Shared setup", status: "planned" as const },
      revision: { id: "memory-shared-revision", name: "Initial", status: "concept" as const },
      workItems: [],
      bomLines: [
        { localRef: "line-a", id: "memory-shared-line-a", name: "First board", role: "consumed" as const, itemId: "memory-shared-setup-stock", requiredQuantity: 1, unit: "each" as const, optional: false, constraints: {}, alternatives: [] },
        { localRef: "line-b", id: "memory-shared-line-b", name: "Reserved board", role: "consumed" as const, itemId: "memory-shared-setup-stock", requiredQuantity: 1, unit: "each" as const, optional: false, constraints: {}, alternatives: [] }
      ],
      reservations: [{ localRef: "shared-reservation", bomLineLocalRef: "line-b", id: "memory-shared-reservation", itemId: "memory-shared-setup-stock", quantity: 1, unit: "each" as const }]
    };
    const preview = await service.previewProjectSetup(proposal, context);
    const previewByLine = new Map(preview.gaps.lines.map((line) => [line.lineId, line]));
    expect(previewByLine.get("memory-shared-line-a")).toMatchObject({ status: "missing", suppliedQuantity: 0, missingQuantity: 1 });
    expect(previewByLine.get("memory-shared-line-b")).toMatchObject({ status: "supplied", suppliedQuantity: 1, missingQuantity: 0 });
    const committed = await service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, { ...context, idempotencyKey: "memory-shared-setup-key" });
    const live = await service.evaluateBomGaps("memory-shared-revision");
    expect(committed.data.gaps).toEqual(live);
    expect(committed.data.gaps.lines.find((line) => line.lineId === "memory-shared-line-b")?.status).toBe("supplied");
  });

  it("blocks setup commit when a candidate row changes after preview", async () => {
    const runtime = createMemoryRuntime([{
      id: "memory-stale-candidate", name: "Candidate board", kind: "electronic", quantity: 1, availableQuantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1
    }]);
    const service = new ApplicationService(runtime.ports);
    const context = { actor: "memory-stale-candidate", source: "api" as const, correlationId: "memory-stale-candidate", scopes: new Set(["projects:write", "bom:write"]) };
    const preview = await service.previewProjectSetup({
      project: { id: "memory-stale-project", name: "Stale candidate setup", status: "planned" },
      revision: { id: "memory-stale-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "board", id: "memory-stale-line", name: "Any board", itemId: "memory-stale-candidate", requiredQuantity: 1, unit: "each", optional: false, constraints: { kind: "electronic" }, alternatives: [] }],
      reservations: []
    }, context);
    expect(preview.affectedInventory.map((row) => row.itemId)).toEqual(["memory-stale-candidate"]);
    await runtime.inventory.updateItem("memory-stale-candidate", { location: "Shelf B" }, 1);
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: false }, { ...context, idempotencyKey: "memory-stale-candidate-key" })).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "stale_basis", retryable: false, commitState: "not_committed", recoveryAction: "preview_project_setup" }
    });
    await expect(runtime.ports.projects.getProject("memory-stale-project")).resolves.toBeNull();
  });

  it("enforces setup ownership, version/hash, expiry, and reservation confirmation", async () => {
    const runtime = createMemoryRuntime([{
      id: "memory-setup-guard-stock", name: "Guard screw", kind: "fastener", quantity: 2, availableQuantity: 2, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1
    }]);
    const service = new ApplicationService(runtime.ports);
    const context = { actor: "memory-setup-guard", source: "api" as const, correlationId: "memory-setup-guard", scopes: new Set(["projects:write", "bom:write"]) };
    const preview = await service.previewProjectSetup({
      project: { id: "memory-setup-guard-project", name: "Guard setup", status: "planned" },
      revision: { id: "memory-setup-guard-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "screws", id: "memory-setup-guard-line", name: "Guard screw", role: "consumed", itemId: "memory-setup-guard-stock", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
      reservations: [{ localRef: "guard-reservation", bomLineLocalRef: "screws", id: "memory-setup-guard-reservation", itemId: "memory-setup-guard-stock", quantity: 1, unit: "each" }]
    }, context);
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, { ...context, actor: "different-actor", idempotencyKey: "memory-setup-guard-owner" })).rejects.toMatchObject({ code: "conflict", details: { reason: "preview_ownership", commitState: "not_committed" } });
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version + 1, contentSha256: preview.contentSha256, confirmReservations: true }, { ...context, idempotencyKey: "memory-setup-guard-version" })).rejects.toMatchObject({ code: "conflict", details: { reason: "stale_preview" } });
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: "a".repeat(64), confirmReservations: true }, { ...context, idempotencyKey: "memory-setup-guard-hash" })).rejects.toMatchObject({ code: "conflict", details: { reason: "stale_preview" } });
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: false }, { ...context, idempotencyKey: "memory-setup-guard-confirm" })).rejects.toMatchObject({ code: "validation" });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(preview.expiresAt));
      await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, { ...context, idempotencyKey: "memory-setup-guard-expiry" })).rejects.toMatchObject({ code: "conflict", details: { reason: "preview_expired", recoveryAction: "preview_project_setup" } });
    } finally {
      vi.useRealTimers();
    }
    await expect(runtime.ports.projects.getProject("memory-setup-guard-project")).resolves.toBeNull();
  });

  it("returns reviewable setup errors for every unsafe reservation class", async () => {
    const stamp = { createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1 };
    const runtime = createMemoryRuntime([
      { id: "setup-valid-item", name: "Valid part", kind: "electronic", quantity: 5, availableQuantity: 5, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, ...stamp },
      { id: "setup-incompatible-item", name: "Other part", kind: "electronic", quantity: 1, availableQuantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, ...stamp },
      { id: "setup-wrong-unit", name: "Packaged part", kind: "electronic", quantity: 1, availableQuantity: 1, unit: "set", tags: [], links: [], evidence: { state: "physically_counted" }, ...stamp },
      { id: "setup-unconfirmed", name: "Uncounted part", kind: "electronic", quantity: 1, availableQuantity: 0, unit: "each", tags: [], links: [], evidence: { state: "delivered_uncounted" }, ...stamp },
      { id: "setup-short-stock", name: "Short stock", kind: "electronic", quantity: 1, availableQuantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, ...stamp },
    ]);
    const service = new ApplicationService(runtime.ports);
    const context = { actor: "memory-setup-errors", source: "api" as const, correlationId: "memory-setup-errors", scopes: new Set(["projects:write", "bom:write"]) };
    const exactLine = (localRef: string, itemId: string, requiredQuantity: number) => ({ localRef, id: `line-${localRef}`, name: localRef, role: "consumed" as const, itemId, requiredQuantity, unit: "each" as const, optional: false, constraints: {}, alternatives: [] });
    const preview = await service.previewProjectSetup({
      project: { id: "memory-setup-errors-project", name: "Unsafe reservation review", status: "planned" },
      revision: { id: "memory-setup-errors-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [
        exactLine("incompatible", "setup-valid-item", 1),
        exactLine("wrong-unit", "setup-wrong-unit", 1),
        exactLine("unconfirmed", "setup-unconfirmed", 1),
        exactLine("over-line", "setup-valid-item", 1),
        exactLine("short-stock", "setup-short-stock", 3),
        { ...exactLine("undecided", "setup-valid-item", 1), constraints: { specification: { status: "insufficient" as const, missingDecisions: ["current_or_load" as const] } } },
      ],
      reservations: [
        { localRef: "reserve-incompatible", bomLineLocalRef: "incompatible", itemId: "setup-incompatible-item", quantity: 1, unit: "each" },
        { localRef: "reserve-wrong-unit", bomLineLocalRef: "wrong-unit", itemId: "setup-wrong-unit", quantity: 1, unit: "set" },
        { localRef: "reserve-unconfirmed", bomLineLocalRef: "unconfirmed", itemId: "setup-unconfirmed", quantity: 1, unit: "each" },
        { localRef: "reserve-over-line", bomLineLocalRef: "over-line", itemId: "setup-valid-item", quantity: 2, unit: "each" },
        { localRef: "reserve-short-stock", bomLineLocalRef: "short-stock", itemId: "setup-short-stock", quantity: 2, unit: "each" },
        { localRef: "reserve-undecided", bomLineLocalRef: "undecided", itemId: "setup-valid-item", quantity: 1, unit: "each" },
      ]
    }, context);
    const codes = new Set(preview.fieldErrors.map((error) => error.code));
    expect([...codes]).toEqual(expect.arrayContaining([
      "invalid_reservation_reference", "unit_mismatch", "insufficient_evidence", "requirement_exceeded", "insufficient_stock", "unresolved_specification"
    ]));
    await expect(service.commitProjectSetup({
      previewId: preview.id,
      expectedPreviewVersion: preview.version,
      contentSha256: preview.contentSha256,
      confirmReservations: true
    }, { ...context, idempotencyKey: "memory-setup-errors-commit" })).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.ports.projects.getProject("memory-setup-errors-project")).resolves.toBeNull();
  });

  it("does not bind broad constraint-only candidates into a setup", async () => {
    const stamp = { createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1 };
    const runtime = createMemoryRuntime(Array.from({ length: 49 }, (_, index) => ({
      id: `setup-many-candidate-${index}`, name: `Candidate ${index}`, kind: "fastener", quantity: 1,
      availableQuantity: 1, unit: "each" as const, tags: [], links: [], evidence: { state: "physically_counted" as const }, ...stamp
    })));
    const service = new ApplicationService(runtime.ports);
    const preview = await service.previewProjectSetup({
      project: { id: "setup-many-project", name: "Many candidates", status: "planned" },
      revision: { id: "setup-many-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "fastener", id: "setup-many-line", name: "Any fastener", requiredQuantity: 1, unit: "each", optional: false, constraints: { kind: "fastener" }, alternatives: [] }],
      reservations: []
    }, { actor: "setup-many-agent", source: "api", correlationId: "setup-many", scopes: new Set(["projects:write", "bom:write"]) });
    expect(preview.affectedInventory).toHaveLength(0);
    expect(preview.gaps.lines[0]?.matchedItemIds).toEqual([]);
  });

  it("compensates setup graph and allocation when the enclosing audit fails", async () => {
    const runtime = createMemoryRuntime([{
      id: "memory-setup-rollback-stock", name: "Rollback screw", kind: "fastener", quantity: 2, availableQuantity: 2, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1
    }]);
    const service = new ApplicationService(runtime.ports);
    const context = { actor: "memory-setup-rollback", source: "api" as const, correlationId: "memory-setup-rollback", scopes: new Set(["projects:write", "bom:write"]) };
    const preview = await service.previewProjectSetup({
      project: { id: "memory-setup-rollback-project", name: "Memory rollback setup", status: "planned" },
      revision: { id: "memory-setup-rollback-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "screws", id: "memory-setup-rollback-line", name: "Rollback screw", role: "consumed", itemId: "memory-setup-rollback-stock", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
      reservations: [{ localRef: "screw-reservation", bomLineLocalRef: "screws", id: "memory-setup-rollback-reservation", itemId: "memory-setup-rollback-stock", quantity: 1, unit: "each" }]
    }, context);
    const failingAudit = vi.spyOn(runtime.ports.audit, "append").mockRejectedValueOnce(new Error("injected audit failure"));
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, { ...context, idempotencyKey: "memory-setup-rollback-key" })).rejects.toThrow("injected audit failure");
    failingAudit.mockRestore();
    await expect(runtime.ports.projects.getProject("memory-setup-rollback-project")).resolves.toBeNull();
    expect(runtime.projects.reservations.size).toBe(0);
    expect(runtime.inventory.items.get("memory-setup-rollback-stock")?.availableQuantity).toBe(2);
    expect(runtime.inventory.events.get("memory-setup-rollback-stock")).toBeUndefined();
  });

  it("normalizes search and enforces the REST inventory list bounds", async () => {
    const runtime = createMemoryRuntime();
    await runtime.inventory.createItem({
      id: "normalized-search-item",
      name: "PETG spool",
      kind: "filament",
      quantity: 1,
      unit: "each",
      tags: [],
      links: [],
      evidence: { state: "unknown" }
    });

    await expect(runtime.inventory.listItems({ q: "  petg  ", limit: 1 })).resolves.toMatchObject({ data: [{ id: "normalized-search-item" }] });
    await expect(runtime.inventory.listItems({ q: "q".repeat(201), limit: 1 })).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.inventory.listItems({ limit: 0 })).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.inventory.listItems({ limit: 201 })).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.inventory.listItems({ limit: 1, cursor: "c".repeat(201) })).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.inventory.listItems({ limit: 1, categoryNodeId: "category-tools", unassigned: true })).rejects.toMatchObject({ code: "validation" });
  });

  it("promotes an unknown physical count to available stock", async () => {
    const runtime = createMemoryRuntime();
    await runtime.inventory.createItem({
      id: "unknown-count-item",
      name: "Unknown count item",
      kind: "electronic",
      quantity: 0,
      unit: "each",
      tags: [],
      links: [],
      evidence: { state: "unknown" }
    });

    const mutation = await runtime.inventory.recordPhysicalCount("unknown-count-item", 4, {
      actor: "memory-store-test",
      source: "api",
      correlationId: "memory-store-count-test",
      scopes: new Set(["write"])
    });

    expect(mutation.item).toMatchObject({
      quantity: 4,
      availableQuantity: 4,
      evidence: { state: "physically_counted" }
    });
  });

  it("preserves inspection source, source id, and observed time on the demo count path", async () => {
    const runtime = createMemoryRuntime();
    const service = new ApplicationService(runtime.ports);
    const context = {
      actor: "memory-inspection-agent",
      source: "api" as const,
      correlationId: "memory-inspection-provenance",
      scopes: new Set(["read", "write"]),
    };
    const item = await service.createInventoryItem({
      id: "memory-inspection-provenance-item", name: "Uncounted ESP32", kind: "electronic", quantity: 1, unit: "each", tags: [], links: [],
      evidence: { state: "delivered_uncounted", source: "delivery", observedAt: "2026-09-02T00:00:00.000Z" },
    }, context);
    const project = await service.createProject({ id: "memory-inspection-provenance-project", name: "Inspection provenance", status: "planned" }, context);
    const revision = await service.createProjectRevision(project.data.id, { id: "memory-inspection-provenance-revision", name: "Initial", status: "concept" }, context);
    await service.createBomLine(revision.data.id, {
      id: "memory-inspection-provenance-line", name: "ESP32", itemId: item.data.id, requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [],
    }, context);
    const action = (await service.listInspections(revision.data.id)).data.find((candidate) => candidate.itemId === item.data.id);
    if (action === undefined) throw new Error("expected physical inspection action");
    const observation = {
      result: "confirmed" as const,
      quantity: 3,
      unit: "each" as const,
      source: "bench camera",
      sourceId: "photo-2026-09-02-01",
      observedAt: "2026-09-02T01:23:00.000Z",
      note: "Three boards counted in the tray",
    };
    const preview = await service.previewInspectionCompletion(revision.data.id, { actionId: action.id, observation }, context);
    const committed = await service.commitInspectionCompletion(revision.data.id, {
      actionId: action.id, previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmed: true,
    }, { ...context, idempotencyKey: "memory-inspection-provenance-commit" });

    expect(committed.data.item).toMatchObject({ evidence: { state: "physically_counted", source: observation.source, sourceId: observation.sourceId, observedAt: observation.observedAt, note: observation.note } });
    expect(runtime.inventory.items.get(item.data.id)?.evidence).toMatchObject({ state: "physically_counted", source: observation.source, sourceId: observation.sourceId, observedAt: observation.observedAt, note: observation.note });
    expect(runtime.inventory.events.get(item.data.id)?.at(-1)).toMatchObject({ type: "count", note: observation.note, evidence: { state: "physically_counted", source: observation.source, sourceId: observation.sourceId, observedAt: observation.observedAt } });
  });

  it("restores an in-memory project when removal is compensated", async () => {
    const runtime = createMemoryRuntime();
    const project = await runtime.projects.createProject({ id: "project-removal-rollback", name: "Rollback project", status: "planned" });
    await expect(runtime.projects.removeProject(project.id, project.version, project.name, {
      actor: "memory-store-test", source: "api", correlationId: "remove-project", scopes: new Set(["write"])
    })).resolves.toMatchObject({ id: project.id, lastLifecycleStatus: "planned" });
    await expect(runtime.projects.listRemovedProjects()).resolves.toEqual([expect.objectContaining({ id: project.id })]);

    await runtime.projects.rollbackProjectRemoval(project.id);

    const restored = await runtime.projects.getProject(project.id);
    expect(restored).toMatchObject({ id: project.id, version: 1 });
    expect(restored).not.toHaveProperty("removedAt");
    await expect(runtime.projects.listRemovedProjects()).resolves.toEqual([]);
  });

  it("retains a project's generated slug collision identity after a rename", async () => {
    const runtime = createMemoryRuntime();
    const project = await runtime.projects.createProject({ id: "memory-slug-project", name: "Original Stable Name", status: "planned" });
    const renamed = await runtime.projects.updateProject(project.id, { name: "A Different Name" }, project.version);
    expect(renamed.name).toBe("A Different Name");

    await expect(runtime.projects.createProjectWithInitialRevision({
      project: { id: "memory-new-project", name: "Original Stable Name", status: "planned" },
      revision: { id: "memory-new-revision", name: "Initial", status: "concept" },
    }, { actor: "memory-store-test", source: "api", correlationId: "memory-slug-collision", scopes: new Set(["write"]) })).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "project_name_exists", field: "projectName", id: "original-stable-name", commitState: "not_committed" },
    });
    await expect(runtime.projects.getProject("memory-new-project")).resolves.toBeNull();
    await expect(runtime.projects.getProjectRevision("memory-new-revision")).resolves.toBeNull();
  });

  it("rolls back an in-memory removal when reservation release fails", async () => {
    const runtime = createMemoryRuntime();
    const project = await runtime.projects.createProject({ id: "project-release-failure", name: "Release failure", status: "planned" });
    runtime.projects.projectRevisions.set("revision-release-failure", { id: "revision-release-failure", projectId: project.id, number: 1, name: "Initial", status: "concept", fabricationRoute: "undecided", createdAt: project.createdAt, version: 1 });
    runtime.projects.bomLines.set("line-release-failure", { id: "line-release-failure", revisionId: "revision-release-failure", name: "Missing item", itemId: "missing-item", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: project.createdAt, updatedAt: project.updatedAt, version: 1 });
    runtime.projects.reservations.set("reservation-release-failure", { id: "reservation-release-failure", lineId: "line-release-failure", itemId: "missing-item", quantity: 1, status: "active", createdAt: project.createdAt, updatedAt: project.updatedAt, version: 1 });

    expect(() => runtime.projects.removeProject(project.id, project.version, project.name, {
      actor: "memory-store-test", source: "api", correlationId: "remove-project", scopes: new Set(["write"])
    })).toThrow("refers to missing inventory item");
    await expect(runtime.projects.getProject(project.id)).resolves.toMatchObject({ id: project.id, version: 1 });
    expect(runtime.projects.reservations.get("reservation-release-failure")?.status).toBe("active");
  });

  it("preflights every archive reservation dependency before mutation", async () => {
    const runtime = createMemoryRuntime();
    const project = await runtime.projects.createProject({ id: "project-archive-preflight", name: "Archive preflight", status: "planned" });
    runtime.projects.projectRevisions.set("revision-archive-preflight", { id: "revision-archive-preflight", projectId: project.id, number: 1, name: "Initial", status: "concept", fabricationRoute: "undecided", createdAt: project.createdAt, version: 1 });
    runtime.projects.bomLines.set("line-archive-preflight", { id: "line-archive-preflight", revisionId: "revision-archive-preflight", name: "Missing item", itemId: "missing-item", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: project.createdAt, updatedAt: project.updatedAt, version: 1 });
    runtime.projects.reservations.set("reservation-archive-preflight", { id: "reservation-archive-preflight", lineId: "line-archive-preflight", itemId: "missing-item", quantity: 1, status: "active", createdAt: project.createdAt, updatedAt: project.updatedAt, version: 1 });

    await expect(Promise.resolve().then(() => runtime.projects.archiveProject(project.id, project.version, { actor: "memory-store-test", source: "api", correlationId: "archive-preflight", scopes: new Set(["write"]) }))).rejects.toMatchObject({ code: "integrity_error" });
    await expect(runtime.projects.getProject(project.id)).resolves.toMatchObject({ status: "planned", version: 1 });
    expect(runtime.projects.reservations.get("reservation-archive-preflight")?.status).toBe("active");
  });

  it("closes a committed archive receipt so later rollback cannot undo it", async () => {
    const runtime = createMemoryRuntime([{
      id: "archive-item", name: "Archive item", kind: "electronic", quantity: 2, availableQuantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", version: 1
    }]);
    const project = await runtime.projects.createProject({ id: "project-archive-commit", name: "Archive commit", status: "planned" });
    runtime.projects.projectRevisions.set("revision-archive-commit", { id: "revision-archive-commit", projectId: project.id, number: 1, name: "Initial", status: "concept", fabricationRoute: "undecided", createdAt: project.createdAt, version: 1 });
    runtime.projects.bomLines.set("line-archive-commit", { id: "line-archive-commit", revisionId: "revision-archive-commit", name: "Archive item", itemId: "archive-item", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [], createdAt: project.createdAt, updatedAt: project.updatedAt, version: 1 });
    runtime.projects.reservations.set("reservation-archive-commit", { id: "reservation-archive-commit", lineId: "line-archive-commit", itemId: "archive-item", quantity: 1, status: "active", createdAt: project.createdAt, updatedAt: project.updatedAt, version: 1 });

    const archived = await runtime.projects.archiveProject(project.id, project.version, { actor: "memory-store-test", source: "api", correlationId: "archive-commit", scopes: new Set(["write"]) });
    await runtime.projects.commitProjectArchive(project.id);
    await runtime.projects.rollbackProjectArchive(project.id);
    await expect(runtime.projects.getProject(project.id)).resolves.toMatchObject({ status: "archived", version: archived.version });
    expect(runtime.projects.reservations.get("reservation-archive-commit")?.status).toBe("released");
    expect(runtime.inventory.items.get("archive-item")?.availableQuantity).toBe(2);
  });
});
const sourcedFilament: CatalogProduct = {
  id: "memory-sourced-filament",
  kind: "filament",
  manufacturer: "Example Materials",
  productName: "PLA Black",
  materialFamily: "PLA",
  colourName: "Black",
  diameterMm: 1.75,
  nominalNetMassG: 1000,
  lengthBasis: "unknown",
  provenance: {
    sourceUrl: "https://materials.example.test/pla",
    sourceLabel: "Example manufacturer product page",
    verifiedAt: "2026-08-30T12:00:00.000Z",
  },
  createdAt: "2026-08-30T12:00:00.000Z",
  updatedAt: "2026-08-30T12:00:00.000Z",
  version: 1,
};

describe("MemoryUnitOfWork", () => {
  it("serializes concurrent work and permits nested calls", async () => {
    const unitOfWork = new MemoryUnitOfWork();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });

    const first = unitOfWork.transactional(async () => {
      order.push("first:start");
      markStarted();
      await gate;
      await unitOfWork.exclusive(() => { order.push("nested"); });
      order.push("first:end");
      return "first";
    });
    const second = unitOfWork.run(() => {
      order.push("second");
      return "second";
    });

    await started;
    expect(order).toEqual(["first:start"]);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual(["first:start", "nested", "first:end", "second"]);
  });

  it("continues servicing the queue after an operation rejects", async () => {
    const unitOfWork = new MemoryUnitOfWork();
    await expect(unitOfWork.run(() => { throw new Error("expected"); })).rejects.toThrow("expected");
    await expect(unitOfWork.exclusive(() => "ready")).resolves.toBe("ready");
  });
});

describe("MemoryCatalog provenance parity", () => {
  it("preserves provenance for no-op facts and clears it for corrected facts", async () => {
    const runtime = createMemoryRuntime();
    runtime.catalog.products.set(sourcedFilament.id, structuredClone(sourcedFilament));

    const noOp = await runtime.catalog.updateProduct(sourcedFilament.id, { colourName: sourcedFilament.colourName }, 1);
    expect(noOp.provenance).toEqual(sourcedFilament.provenance);

    const corrected = await runtime.catalog.updateProduct(sourcedFilament.id, { colourName: "Graphite" }, 2);
    expect(corrected.provenance).toBeUndefined();
  });
});

describe("Memory BOM quantity conversion parity", () => {
  const conversion = {
    inventory: { quantity: 1, unit: "set" as const },
    requirement: { quantity: 10, unit: "each" as const },
    evidence: {
      basis: "package_label" as const,
      observedAt: "2026-09-02T10:00:00.000Z",
      source: "synthetic package label",
      sourceId: "synthetic-label-1",
      note: "Ten pieces per sealed set.",
    },
  } as const;

  it("reserves whole converted sets and rejects an unconverted unit mismatch", async () => {
    const runtime = createMemoryRuntime([{
      id: "memory-conversion-set",
      name: "LED set",
      kind: "electronic",
      quantity: 3,
      availableQuantity: 3,
      unit: "set",
      tags: [],
      links: [],
      evidence: { state: "physically_counted" },
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      version: 1,
    }]);
    const service = new ApplicationService(runtime.ports);
    const context = { actor: "memory-conversion-direct", source: "api" as const, correlationId: "memory-conversion-direct", scopes: new Set(["projects:write", "bom:write"]) };
    const project = await service.createProject({ id: "memory-conversion-project", name: "Memory conversion project", status: "planned" }, context);
    const revision = await service.createProjectRevision(project.data.id, { id: "memory-conversion-revision", name: "Initial", status: "concept" }, context);
    const line = await service.createBomLine(revision.data.id, {
      id: "memory-conversion-line",
      name: "LEDs",
      role: "consumed",
      requiredQuantity: 15,
      unit: "each",
      optional: false,
      constraints: {},
      alternatives: [{ itemId: "memory-conversion-set", compatible: "confirmed", quantityConversion: conversion }],
    }, context);

    const reservation = await service.createReservation(revision.data.id, { id: "memory-conversion-reservation", lineId: line.data.id, itemId: "memory-conversion-set", quantity: 2 }, context);
    expect(reservation.data).toMatchObject({ itemId: "memory-conversion-set", quantity: 2, status: "active" });
    expect(runtime.inventory.items.get("memory-conversion-set")?.availableQuantity).toBe(1);
    await expect(service.evaluateBomGaps(revision.data.id)).resolves.toMatchObject({ lines: [{ suppliedQuantity: 15, missingQuantity: 0, unit: "each" }] });

    const noConversion = await service.createBomLine(revision.data.id, {
      id: "memory-no-conversion-line",
      name: "Unconverted LEDs",
      role: "consumed",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      constraints: {},
      alternatives: [{ itemId: "memory-conversion-set", compatible: "confirmed" }],
    }, context);
    await expect(Promise.resolve().then(() => runtime.projects.createReservation(revision.data.id, { lineId: noConversion.data.id, itemId: "memory-conversion-set", quantity: 1 }))).rejects.toMatchObject({ code: "validation" });
  });

  it("preserves converted alternatives through setup commit and rolls back injected audit failure", async () => {
    const runtime = createMemoryRuntime([{
      id: "memory-setup-conversion-set",
      name: "Setup LED set",
      kind: "electronic",
      quantity: 2,
      availableQuantity: 2,
      unit: "set",
      tags: [],
      links: [],
      evidence: { state: "physically_counted" },
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      version: 1,
    }]);
    const service = new ApplicationService(runtime.ports);
    const context = { actor: "memory-conversion-setup", source: "api" as const, correlationId: "memory-conversion-setup", scopes: new Set(["projects:write", "bom:write"]) };
    const proposal = {
      project: { id: "memory-conversion-setup-project", name: "Memory converted setup", status: "planned" as const },
      revision: { id: "memory-conversion-setup-revision", name: "Initial", status: "concept" as const },
      workItems: [],
      bomLines: [{ localRef: "led-line", id: "memory-conversion-setup-line", name: "LEDs", role: "consumed" as const, requiredQuantity: 15, unit: "each" as const, optional: false, constraints: {}, alternatives: [{ itemId: "memory-setup-conversion-set", compatible: "confirmed" as const, quantityConversion: conversion }] }],
      reservations: [{ localRef: "led-reservation", bomLineLocalRef: "led-line", id: "memory-conversion-setup-reservation", itemId: "memory-setup-conversion-set", quantity: 2, unit: "set" as const }],
    };
    const preview = await service.previewProjectSetup(proposal, context);
    expect(preview.fieldErrors).toEqual([]);
    expect(preview.gaps.lines[0]).toMatchObject({ suppliedQuantity: 15, missingQuantity: 0, unit: "each" });

    const failingAudit = vi.spyOn(runtime.ports.audit, "append").mockRejectedValueOnce(new Error("injected converted setup audit failure"));
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, { ...context, idempotencyKey: "memory-conversion-setup-key" })).rejects.toThrow("injected converted setup audit failure");
    failingAudit.mockRestore();
    await expect(runtime.ports.projects.getProject("memory-conversion-setup-project")).resolves.toBeNull();
    expect(runtime.projects.reservations.size).toBe(0);
    expect(runtime.inventory.items.get("memory-setup-conversion-set")?.availableQuantity).toBe(2);
    expect(runtime.inventory.events.get("memory-setup-conversion-set")).toBeUndefined();

    const committed = await service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, { ...context, idempotencyKey: "memory-conversion-setup-retry" });
    expect(committed.data.bomLines[0]?.alternatives).toEqual(proposal.bomLines[0]?.alternatives);
    expect(committed.data.reservations).toMatchObject([{ id: "memory-conversion-setup-reservation", quantity: 2 }]);
  });
});

describe("Memory build configuration persistence", () => {
  it("retains physical-only filament snapshots and rejects tampering", async () => {
    const runtime = createMemoryRuntime([{
      id: "memory-physical-filament",
      name: "Unidentified PETG spool",
      kind: "filament",
      quantity: 760,
      availableQuantity: 760,
      unit: "gram",
      tags: [],
      links: [],
      evidence: {
        state: "physically_counted",
        source: "synthetic bench count",
        observedAt: "2026-08-30T00:00:00.000Z",
        note: "Synthetic physical-only filament fixture",
      },
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      version: 1,
    }]);
    const service = new ApplicationService(runtime.ports);
    const context = {
      actor: "memory-physical-snapshot",
      source: "api" as const,
      correlationId: "memory-physical-snapshot",
      scopes: new Set(["read", "write", "catalog:read", "catalog:write", "projects:read", "projects:write"]),
    };
    const project = await service.createProject({ id: "memory-physical-project", name: "Physical snapshot", status: "planned" }, context);
    const revision = await service.createProjectRevision(project.data.id, { id: "memory-physical-revision", name: "Initial", status: "concept" }, context);
    const printerItem = await service.createInventoryItem({ id: "memory-physical-printer", name: "H2D", kind: "printer", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "commissioned" } }, context);
    const printerProduct = await service.createCatalogProduct({ kind: "printer", manufacturer: "Bambu Lab", exactModel: "H2D", technology: "fff", buildVolumeMm: { x: 325, y: 320, z: 325 } }, context);
    const printerProfile = await service.putInventoryProductProfile(printerItem.data.id, { catalogProductId: printerProduct.data.id, profileType: "printer_asset", linkState: "confirmed", details: {} }, undefined, context);
    const productsBefore = runtime.catalog.products.size;
    const profilesBefore = runtime.catalog.profiles.size;

    const snapshot = await service.createBuildConfiguration(revision.data.id, {
      printerItemSnapshot: { itemId: printerItem.data.id, catalogProductId: printerProduct.data.id, profileId: printerProfile.data.id },
      filamentSelections: [{ itemId: "memory-physical-filament", catalogIdentityState: "unknown", role: "model", quantity: 320 }],
      activeHotend: "left", nozzle: { diameterMm: 0.4 }, plate: "Textured PEI", accessories: [], firmware: "01", slicer: "Bambu Studio", profile: "Standard", calibration: "checked", explicitUnknowns: [],
    }, context);
    expect(snapshot.data.filamentSelections).toEqual([{
      itemId: "memory-physical-filament",
      catalogIdentityState: "unknown",
      physicalLabel: "Unidentified PETG spool",
      physicalEvidence: runtime.inventory.items.get("memory-physical-filament")?.evidence,
      role: "model",
      quantity: 320,
    }]);
    expect(runtime.catalog.products.size).toBe(productsBefore);
    expect(runtime.catalog.profiles.size).toBe(profilesBefore);
    await expect(runtime.ports.buildConfigurations!.getBuildConfiguration(snapshot.data.id)).resolves.toEqual(snapshot.data);

    const stored = runtime.buildConfigurations.snapshots.get(snapshot.data.id);
    if (stored === undefined) throw new Error("expected memory snapshot");
    runtime.buildConfigurations.snapshots.set(snapshot.data.id, {
      ...stored,
      filamentSelections: [{ ...stored.filamentSelections[0]!, physicalLabel: "Tampered label" }],
    });
    await expect(runtime.ports.buildConfigurations!.getBuildConfiguration(snapshot.data.id)).rejects.toThrow(/hash|integrity/i);
    await expect(runtime.ports.buildConfigurations!.getLatestBuildConfiguration(revision.data.id)).rejects.toThrow(/hash|integrity/i);
    await expect(runtime.ports.buildConfigurations!.listBuildConfigurations(revision.data.id, { limit: 10 })).rejects.toThrow(/hash|integrity/i);
  });
});

describe("Memory artifact persistence", () => {
  it("keeps project and work-item revision scopes exact while retaining legacy artifacts in all-project reads", async () => {
    const runtime = createMemoryRuntime();
    const projectId = "memory-artifact-scope-project";
    const projectRevisionId = "memory-artifact-scope-project-revision";
    const workItemId = "memory-artifact-scope-work-item";
    const workItemRevisionId = "memory-artifact-scope-work-revision";
    const created: Array<{ readonly id: string; readonly body: Buffer }> = [];

    const finalize = async (
      suffix: string,
      input: { readonly workItemId?: string; readonly revisionId?: string },
      body: Buffer
    ) => {
      const session = await runtime.ports.artifacts.beginUpload({
        projectId,
        ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }),
        ...(input.revisionId === undefined ? {} : { revisionId: input.revisionId }),
        role: "step",
        filename: `${suffix}.step`,
        mediaType: "model/step",
        byteSize: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      }, { actor: "memory-artifact-scope", source: "api", correlationId: "memory-artifact-scope", scopes: new Set(["read", "write"]) });
      await runtime.ports.artifacts.writeUpload(session.id, body);
      const artifact = await runtime.ports.artifacts.finalizeUpload(session.id, { actor: "memory-artifact-scope", source: "api", correlationId: "memory-artifact-scope", scopes: new Set(["read", "write"]) });
      created.push({ id: artifact.id, body });
      return artifact;
    };

    const projectArtifact = await finalize("project", { revisionId: projectRevisionId }, Buffer.from("project artifact bytes\n"));
    const workArtifact = await finalize("work", { workItemId, revisionId: projectRevisionId }, Buffer.from("work artifact bytes\n"));
    const laterWorkArtifact = await finalize("later-work", { workItemId, revisionId: workItemRevisionId }, Buffer.from("later work artifact bytes\n"));
    await finalize("legacy", {}, Buffer.from("legacy artifact bytes\n"));

    const ids = async (requestedWorkItemId?: string, requestedRevisionId?: string) => new Set(
      (await runtime.ports.artifacts.listArtifacts(projectId, requestedWorkItemId, requestedRevisionId)).map((artifact) => artifact.id)
    );
    expect(await ids(undefined, projectRevisionId)).toEqual(new Set([projectArtifact.id]));
    expect(await ids(workItemId, workItemRevisionId)).toEqual(new Set([laterWorkArtifact.id]));
    expect(await ids(workItemId, projectRevisionId)).toEqual(new Set([workArtifact.id]));
    expect(await ids(workItemId)).toEqual(new Set([workArtifact.id, laterWorkArtifact.id]));
    expect(await ids()).toEqual(new Set(created.map((artifact) => artifact.id)));

    const before = await Promise.all(created.map((artifact) => runtime.ports.artifacts.readArtifact(artifact.id)));
    await runtime.ports.artifacts.listArtifacts(projectId);
    const after = await Promise.all(created.map((artifact) => runtime.ports.artifacts.readArtifact(artifact.id)));
    expect(after).toEqual(before);
  });
});
