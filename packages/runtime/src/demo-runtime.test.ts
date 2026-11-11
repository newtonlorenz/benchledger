import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CreateInventoryItem } from "@benchledger/api-contract";
import { ApplicationService, type RequestContext } from "@benchledger/application";
import { createDemoRuntime, SYNTHETIC_DEMO_INVENTORY, SYNTHETIC_DEMO_PROJECT_ID, SYNTHETIC_DEMO_REVISION_ID } from "./index.js";

/**
 * Behaviour formerly covered by the hand-written demo memory store, now run
 * against the real SQLite runtime that demo mode uses.
 */
const ctx = (name: string, scopes: readonly string[] = ["read", "write", "projects:write", "bom:write"]): RequestContext => ({ actor: name, source: "api", correlationId: name, scopes: new Set(scopes) });

const counted = (id: string, overrides: Partial<CreateInventoryItem> = {}): CreateInventoryItem => ({
  id, name: id, kind: "electronic", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "physically_counted" }, ...overrides
});

async function withRuntime<T>(items: readonly CreateInventoryItem[], run: (runtime: Awaited<ReturnType<typeof createDemoRuntime>>, service: ApplicationService) => Promise<T>): Promise<T> {
  const runtime = await createDemoRuntime({ seed: "empty" });
  try {
    for (const item of items) await runtime.ports.inventory.createItem(item, ctx("seed"));
    return await run(runtime, new ApplicationService(runtime.ports));
  } finally {
    await runtime.close();
  }
}

describe("demo runtime", () => {
  it("seeds the synthetic workspace through the SQLite adapters and removes its temp directory on close", async () => {
    const runtime = await createDemoRuntime();
    expect(runtime.databasePath).toBe(":memory:");
    expect(existsSync(runtime.artifactDir)).toBe(true);
    const service = new ApplicationService(runtime.ports);
    const inventory = await service.listInventory({ limit: 50 });
    expect(inventory.data.map((item) => item.id).sort()).toEqual(SYNTHETIC_DEMO_INVENTORY.map((item) => item.id).sort());
    expect(inventory.data.find((item) => item.id === "wire-dupont")).toMatchObject({ quantity: 1, availableQuantity: 0, evidence: { state: "delivered_uncounted" } });
    expect(inventory.data.find((item) => item.id === "printer-h2d")).toMatchObject({ availableQuantity: 1, evidence: { state: "commissioned" } });
    await expect(service.getInventoryProductProfile("printer-h2d")).resolves.toMatchObject({ id: "profile-printer-h2d", catalogProductId: "catalog-printer-h2d", linkState: "confirmed" });
    await expect(runtime.ports.catalog!.listProducts({ limit: 50 })).resolves.toMatchObject({ data: [{ id: "catalog-filament-petg-hf" }, { id: "catalog-printer-h2d" }] });
    const gaps = await service.evaluateBomGaps(SYNTHETIC_DEMO_REVISION_ID);
    expect(Object.fromEntries(gaps.lines.map((line) => [line.lineId, line.status]))).toEqual({
      "synthetic-bom-board": "supplied", "synthetic-bom-fasteners": "missing", "synthetic-bom-filament": "supplied", "synthetic-bom-wire": "inspect_first"
    });
    await expect(runtime.ports.projects.getProject(SYNTHETIC_DEMO_PROJECT_ID)).resolves.toMatchObject({ currentRevisionId: SYNTHETIC_DEMO_REVISION_ID });
    await expect(runtime.ports.audit.list(10)).resolves.toMatchObject({ data: [] });
    await runtime.close();
    await runtime.close();
    expect(existsSync(runtime.dataDir)).toBe(false);
  });

  it("lists demo projects with production ordering (most recently updated first) and the real filters and cursors", async () => {
    const runtime = await createDemoRuntime();
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runtime.ports.projects.createProject({ id: "a-later-project", name: "Later reference", description: "Another reference project", status: "planned" }, ctx("order"));
      const first = await runtime.ports.projects.listProjects({ limit: 1 });
      expect(first).toMatchObject({ data: [{ id: "a-later-project" }], nextCursor: "1", total: 2 });
      await expect(runtime.ports.projects.listProjects({ limit: 1, cursor: "1" })).resolves.toMatchObject({ data: [{ id: SYNTHETIC_DEMO_PROJECT_ID }] });
      await expect(runtime.ports.projects.listProjects({ q: "later", limit: 5 })).resolves.toMatchObject({ data: [{ id: "a-later-project" }], total: 1 });
      await expect(runtime.ports.projects.listProjects({ limit: 1, cursor: "bad" })).rejects.toMatchObject({ code: "invalid_cursor" });
      await expect(runtime.ports.projects.getProject("a-later-project")).resolves.toMatchObject({ name: "Later reference" });
    } finally { await runtime.close(); }
  });

  it("starts blank when asked and can opt into the starter catalog", async () => {
    const runtime = await createDemoRuntime({ seed: "empty", seedStarterCatalog: true });
    try {
      await expect(runtime.ports.inventory.listItems({ limit: 10 })).resolves.toMatchObject({ data: [] });
      expect((await runtime.ports.catalog!.listProducts({ limit: 10 })).data.length).toBeGreaterThan(0);
    } finally { await runtime.close(); }
  });
});

describe("demo runtime stock and reservation rules", () => {
  it("uses live allocation when deleting reserved inventory", () => withRuntime([counted("delete-reserved-item")], async (runtime, service) => {
    const c = ctx("delete-reserved");
    await service.createProject({ id: "delete-reserved-project", name: "Delete reservation test", status: "planned" }, c);
    const revision = await service.createProjectRevision("delete-reserved-project", { name: "Initial", status: "concept" }, c);
    const line = await service.createBomLine(revision.data.id, { name: "Reserved item", role: "consumed", itemId: "delete-reserved-item", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, c);
    const reservation = await service.createReservation(revision.data.id, { lineId: line.data.id, itemId: "delete-reserved-item", quantity: 1 }, c);
    const reserved = (await runtime.ports.inventory.getItem("delete-reserved-item"))!;
    expect(reserved).toMatchObject({ availableQuantity: 0 });
    await expect(service.deleteInventoryItem(reserved.id, reserved.version, c)).rejects.toMatchObject({ code: "conflict" });
    await service.releaseReservation(reservation.data.id, reservation.data.version, c);
    const released = (await runtime.ports.inventory.getItem(reserved.id))!;
    expect(released).toMatchObject({ availableQuantity: 1 });
    await expect(service.deleteInventoryItem(released.id, released.version, c)).resolves.toMatchObject({ data: { retiredAt: expect.any(String) } });
  }));

  it("reserves decimal quantities up to the requirement despite binary rounding", () => withRuntime([counted("decimal-filament", { kind: "filament", unit: "gram" })], async (runtime, service) => {
    const c = ctx("decimal");
    await service.createProject({ id: "decimal-project", name: "Decimal reservations", status: "planned" }, c);
    const revision = await service.createProjectRevision("decimal-project", { name: "Initial", status: "concept" }, c);
    const line = await service.createBomLine(revision.data.id, { name: "Decimal filament", role: "consumed", itemId: "decimal-filament", requiredQuantity: 0.3, unit: "gram", optional: false, alternatives: [], constraints: {} }, c);
    await service.createReservation(revision.data.id, { lineId: line.data.id, itemId: "decimal-filament", quantity: 0.1 }, c);
    await expect(service.createReservation(revision.data.id, { lineId: line.data.id, itemId: "decimal-filament", quantity: 0.2 }, c)).resolves.toMatchObject({ data: { quantity: 0.2 } });
    await expect(service.createReservation(revision.data.id, { lineId: line.data.id, itemId: "decimal-filament", quantity: 0.01 }, c)).rejects.toMatchObject({ code: "conflict" });
    const fresh = await service.createBomLine(revision.data.id, { name: "Decimal filament", role: "consumed", itemId: "decimal-filament", requiredQuantity: 0.25, unit: "gram", optional: false, alternatives: [], constraints: {} }, c);
    await expect(Promise.resolve().then(() => runtime.ports.projects.createReservation(revision.data.id, { lineId: fresh.data.id, itemId: "decimal-filament", quantity: 0.5 }, c))).rejects.toBeDefined();
  }));

  it("does not change a directly reserved BOM line to reusable", () => withRuntime([counted("reserved-role-item")], async (_runtime, service) => {
    const c = ctx("reserved-role");
    await service.createProject({ id: "reserved-role-project", name: "Role project", status: "planned" }, c);
    await service.createProjectRevision("reserved-role-project", { id: "reserved-role-revision", name: "Initial", status: "concept" }, c);
    const line = await service.createBomLine("reserved-role-revision", { id: "reserved-role-line", name: "Reserved board", role: "consumed", itemId: "reserved-role-item", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: {} }, c);
    const reservation = await service.createReservation("reserved-role-revision", { id: "reserved-role-reservation", lineId: line.data.id, itemId: "reserved-role-item", quantity: 1 }, c);
    await expect(service.updateBomLine(line.data.id, { role: "reusable" }, line.data.version, c)).rejects.toMatchObject({ code: "conflict" });
    await service.releaseReservation(reservation.data.id, reservation.data.version, c);
    await expect(service.updateBomLine(line.data.id, { role: "reusable" }, line.data.version, c)).resolves.toMatchObject({ data: { role: "reusable", version: 2 } });
  }));

  it("round-trips consumed, reusable, and legacy requirement roles through direct and atomic writes", () => withRuntime([], async (_runtime, service) => {
    const c = ctx("role-round-trip");
    const project = await service.createProject({ id: "memory-role-project", name: "Role project", status: "planned" }, c);
    const revision = await service.createProjectRevision(project.data.id, { id: "memory-role-revision", name: "Initial", status: "concept" }, c);
    await service.createBomLine(revision.data.id, { id: "memory-role-consumed", name: "Fastener", role: "consumed", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }, c);
    await service.createBomLine(revision.data.id, { id: "memory-role-reusable", name: "Tool", role: "reusable", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }, c);
    await service.createBomLine(revision.data.id, { id: "memory-role-legacy", name: "Legacy", role: null, requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }, c);
    await expect(service.listBomLines(revision.data.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "memory-role-consumed", role: "consumed" }),
      expect.objectContaining({ id: "memory-role-reusable", role: "reusable" }),
      expect.objectContaining({ id: "memory-role-legacy", role: null }),
    ]));
    const preview = await service.previewProjectSetup({ project: { id: "memory-role-setup", name: "Role setup", status: "planned" }, revision: { id: "memory-role-setup-revision", name: "Initial", status: "concept" }, workItems: [], bomLines: [{ localRef: "tool", id: "memory-role-setup-tool", name: "Reusable tool", role: "reusable", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }], reservations: [] }, c);
    const committed = await service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: false }, { ...c, idempotencyKey: "memory-role-setup-commit" });
    expect(committed.data.bomLines).toEqual([expect.objectContaining({ id: "memory-role-setup-tool", role: "reusable" })]);
  }));

  it("promotes an unknown physical count to available stock", () => withRuntime([counted("unknown-count-item", { quantity: 0, evidence: { state: "unknown" } })], async (runtime) => {
    const mutation = await runtime.ports.inventory.recordPhysicalCount!("unknown-count-item", 4, ctx("unknown-count"));
    expect(mutation.item).toMatchObject({ quantity: 4, availableQuantity: 4, evidence: { state: "physically_counted" } });
  }));
});

describe("demo runtime project setup", () => {
  it("commits an atomic setup with allocation evidence", () => withRuntime([counted("memory-setup-stock", { kind: "fastener", quantity: 3 })], async (runtime, service) => {
    const c = ctx("setup-commit");
    const preview = await service.previewProjectSetup({
      project: { id: "memory-setup-project", name: "Memory setup", status: "planned" },
      revision: { id: "memory-setup-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "screws", id: "memory-setup-line", name: "M3 screw", role: "consumed", itemId: "memory-setup-stock", requiredQuantity: 2, unit: "each", optional: false, constraints: {}, alternatives: [] }],
      reservations: [{ localRef: "screw-reservation", bomLineLocalRef: "screws", id: "memory-setup-reservation", itemId: "memory-setup-stock", quantity: 2, unit: "each" }]
    }, c);
    expect(preview.status).toBe("active");
    const committed = await service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, { ...c, idempotencyKey: "memory-setup-key" });
    expect(committed.data).toMatchObject({ project: { id: "memory-setup-project" }, reservations: [{ id: "memory-setup-reservation" }], auditIds: [committed.audit.id] });
    await expect(runtime.ports.inventory.getItem("memory-setup-stock")).resolves.toMatchObject({ availableQuantity: 1 });
    const events = await runtime.ports.inventory.listStockEvents("memory-setup-stock", 10);
    expect(events.data.at(-1)).toMatchObject({ type: "allocate", quantity: 2 });
  }));

  it("keeps a planned reservation exclusive when two setup lines share one item", () => withRuntime([counted("memory-shared-setup-stock")], async (_runtime, service) => {
    const c = ctx("setup-shared");
    const preview = await service.previewProjectSetup({
      project: { id: "memory-shared-project", name: "Shared setup", status: "planned" },
      revision: { id: "memory-shared-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [
        { localRef: "line-a", id: "memory-shared-line-a", name: "First board", role: "consumed", itemId: "memory-shared-setup-stock", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] },
        { localRef: "line-b", id: "memory-shared-line-b", name: "Reserved board", role: "consumed", itemId: "memory-shared-setup-stock", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }
      ],
      reservations: [{ localRef: "shared-reservation", bomLineLocalRef: "line-b", id: "memory-shared-reservation", itemId: "memory-shared-setup-stock", quantity: 1, unit: "each" }]
    }, c);
    const previewByLine = new Map(preview.gaps.lines.map((line) => [line.lineId, line]));
    expect(previewByLine.get("memory-shared-line-a")).toMatchObject({ status: "missing", suppliedQuantity: 0, missingQuantity: 1 });
    expect(previewByLine.get("memory-shared-line-b")).toMatchObject({ status: "supplied", suppliedQuantity: 1, missingQuantity: 0 });
    const committed = await service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, { ...c, idempotencyKey: "memory-shared-setup-key" });
    expect(committed.data.gaps).toEqual(await service.evaluateBomGaps("memory-shared-revision"));
  }));

  it("blocks setup commit when a candidate row changes after preview", () => withRuntime([counted("memory-stale-candidate")], async (runtime, service) => {
    const c = ctx("setup-stale");
    const preview = await service.previewProjectSetup({
      project: { id: "memory-stale-project", name: "Stale candidate setup", status: "planned" },
      revision: { id: "memory-stale-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "board", id: "memory-stale-line", name: "Any board", itemId: "memory-stale-candidate", requiredQuantity: 1, unit: "each", optional: false, constraints: { kind: "electronic" }, alternatives: [] }],
      reservations: []
    }, c);
    expect(preview.affectedInventory.map((row) => row.itemId)).toEqual(["memory-stale-candidate"]);
    await runtime.ports.inventory.updateItem("memory-stale-candidate", { location: "Shelf B" }, 1, c);
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: false }, { ...c, idempotencyKey: "memory-stale-candidate-key" })).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "stale_basis", retryable: false, commitState: "not_committed", recoveryAction: "preview_project_setup" }
    });
    await expect(runtime.ports.projects.getProject("memory-stale-project")).resolves.toBeNull();
  }));

  it("enforces setup ownership, version/hash, expiry, and reservation confirmation", () => withRuntime([counted("memory-setup-guard-stock", { kind: "fastener", quantity: 2 })], async (runtime, service) => {
    const c = ctx("setup-guard");
    const preview = await service.previewProjectSetup({
      project: { id: "memory-setup-guard-project", name: "Guard setup", status: "planned" },
      revision: { id: "memory-setup-guard-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "screws", id: "memory-setup-guard-line", name: "Guard screw", role: "consumed", itemId: "memory-setup-guard-stock", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
      reservations: [{ localRef: "guard-reservation", bomLineLocalRef: "screws", id: "memory-setup-guard-reservation", itemId: "memory-setup-guard-stock", quantity: 1, unit: "each" }]
    }, c);
    const command = { previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true };
    await expect(service.commitProjectSetup(command, { ...c, actor: "different-actor", idempotencyKey: "guard-owner" })).rejects.toMatchObject({ code: "conflict", details: { reason: "preview_ownership", commitState: "not_committed" } });
    await expect(service.commitProjectSetup({ ...command, expectedPreviewVersion: preview.version + 1 }, { ...c, idempotencyKey: "guard-version" })).rejects.toMatchObject({ code: "conflict", details: { reason: "stale_preview" } });
    await expect(service.commitProjectSetup({ ...command, contentSha256: "a".repeat(64) }, { ...c, idempotencyKey: "guard-hash" })).rejects.toMatchObject({ code: "conflict", details: { reason: "stale_preview" } });
    await expect(service.commitProjectSetup({ ...command, confirmReservations: false }, { ...c, idempotencyKey: "guard-confirm" })).rejects.toMatchObject({ code: "validation" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(preview.expiresAt));
      await expect(service.commitProjectSetup(command, { ...c, idempotencyKey: "guard-expiry" })).rejects.toMatchObject({ code: "conflict", details: { reason: "preview_expired", recoveryAction: "preview_project_setup" } });
    } finally {
      vi.useRealTimers();
    }
    await expect(runtime.ports.projects.getProject("memory-setup-guard-project")).resolves.toBeNull();
  }));

  it("returns reviewable setup errors for every unsafe reservation class", () => withRuntime([
    counted("setup-valid-item", { quantity: 5 }),
    counted("setup-incompatible-item", { name: "Other part" }),
    counted("setup-wrong-unit", { unit: "set" }),
    counted("setup-unconfirmed", { evidence: { state: "delivered_uncounted" } }),
    counted("setup-short-stock"),
  ], async (runtime, service) => {
    const c = ctx("setup-errors");
    const exactLine = (localRef: string, itemId: string, requiredQuantity: number) => ({ localRef, id: `line-${localRef}`, name: localRef, role: "consumed" as const, itemId, requiredQuantity, unit: "each" as const, optional: false, constraints: {}, alternatives: [] });
    const preview = await service.previewProjectSetup({
      project: { id: "memory-setup-errors-project", name: "Unsafe reservation review", status: "planned" },
      revision: { id: "memory-setup-errors-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [
        exactLine("incompatible", "setup-valid-item", 1), exactLine("wrong-unit", "setup-wrong-unit", 1), exactLine("unconfirmed", "setup-unconfirmed", 1),
        exactLine("over-line", "setup-valid-item", 1), exactLine("short-stock", "setup-short-stock", 3),
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
    }, c);
    expect([...new Set(preview.fieldErrors.map((error) => error.code))]).toEqual(expect.arrayContaining([
      "invalid_reservation_reference", "unit_mismatch", "insufficient_evidence", "requirement_exceeded", "insufficient_stock", "unresolved_specification"
    ]));
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, { ...c, idempotencyKey: "setup-errors-commit" })).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.ports.projects.getProject("memory-setup-errors-project")).resolves.toBeNull();
  }));

  it("does not bind broad constraint-only candidates into a setup", () => withRuntime(Array.from({ length: 49 }, (_, index) => counted(`setup-many-candidate-${index}`, { kind: "fastener" })), async (_runtime, service) => {
    const preview = await service.previewProjectSetup({
      project: { id: "setup-many-project", name: "Many candidates", status: "planned" },
      revision: { id: "setup-many-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "fastener", id: "setup-many-line", name: "Any fastener", requiredQuantity: 1, unit: "each", optional: false, constraints: { kind: "fastener" }, alternatives: [] }],
      reservations: []
    }, ctx("setup-many"));
    expect(preview.affectedInventory).toHaveLength(0);
    expect(preview.gaps.lines[0]?.matchedItemIds).toEqual([]);
  }));

  it("rolls back the setup graph and allocation when the enclosing audit fails", () => withRuntime([counted("rollback-stock", { kind: "fastener", quantity: 2 })], async (runtime, service) => {
    const c = ctx("setup-rollback");
    const preview = await service.previewProjectSetup({
      project: { id: "rollback-project", name: "Rollback setup", status: "planned" },
      revision: { id: "rollback-revision", name: "Initial", status: "concept" },
      workItems: [],
      bomLines: [{ localRef: "screws", id: "rollback-line", name: "Rollback screw", role: "consumed", itemId: "rollback-stock", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
      reservations: [{ localRef: "screw-reservation", bomLineLocalRef: "screws", id: "rollback-reservation", itemId: "rollback-stock", quantity: 1, unit: "each" }]
    }, c);
    const before = await runtime.ports.inventory.listStockEvents("rollback-stock", 10);
    // Port-level fault injection: the audit port fails inside the unit of work.
    const failingAudit = vi.spyOn(runtime.ports.audit, "append").mockRejectedValueOnce(new Error("injected audit failure"));
    await expect(service.commitProjectSetup({ previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmReservations: true }, { ...c, idempotencyKey: "rollback-key" })).rejects.toThrow("injected audit failure");
    failingAudit.mockRestore();
    await expect(runtime.ports.projects.getProject("rollback-project")).resolves.toBeNull();
    await expect(runtime.ports.inventory.getItem("rollback-stock")).resolves.toMatchObject({ availableQuantity: 2 });
    await expect(runtime.ports.inventory.listStockEvents("rollback-stock", 10)).resolves.toEqual(before);
  }));

  it("retains a project's generated slug collision identity after a rename", () => withRuntime([], async (runtime, service) => {
    const c = ctx("slug");
    const project = await service.createProject({ id: "memory-slug-project", name: "Original Stable Name", status: "planned" }, c);
    await service.updateProject(project.data.id, { name: "A Different Name" }, project.data.version, c);
    await expect(service.createProjectWithInitialRevision({
      project: { id: "memory-new-project", name: "Original Stable Name", status: "planned" },
      revision: { id: "memory-new-revision", name: "Initial", status: "concept" },
    }, c)).rejects.toMatchObject({ code: "conflict", details: { reason: "project_name_exists" } });
    await expect(runtime.ports.projects.getProject("memory-new-project")).resolves.toBeNull();
    await expect(runtime.ports.projects.getProjectRevision("memory-new-revision")).resolves.toBeNull();
  }));
});

describe("demo runtime quantity conversion, inspection and artifacts", () => {
  const conversion = {
    inventory: { quantity: 1, unit: "set" as const },
    requirement: { quantity: 10, unit: "each" as const },
    evidence: { basis: "package_label" as const, observedAt: "2026-09-02T10:00:00.000Z", source: "synthetic package label", sourceId: "synthetic-label-1", note: "Ten pieces per sealed set." },
  } as const;

  it("reserves whole converted sets and rejects an unconverted unit mismatch", () => withRuntime([counted("conversion-set", { quantity: 3, unit: "set" })], async (runtime, service) => {
    const c = ctx("conversion");
    const project = await service.createProject({ id: "conversion-project", name: "Conversion project", status: "planned" }, c);
    const revision = await service.createProjectRevision(project.data.id, { id: "conversion-revision", name: "Initial", status: "concept" }, c);
    const line = await service.createBomLine(revision.data.id, { id: "conversion-line", name: "LEDs", role: "consumed", requiredQuantity: 15, unit: "each", optional: false, constraints: {}, alternatives: [{ itemId: "conversion-set", compatible: "confirmed", quantityConversion: conversion }] }, c);
    const reservation = await service.createReservation(revision.data.id, { id: "conversion-reservation", lineId: line.data.id, itemId: "conversion-set", quantity: 2 }, c);
    expect(reservation.data).toMatchObject({ itemId: "conversion-set", quantity: 2, status: "active" });
    await expect(runtime.ports.inventory.getItem("conversion-set")).resolves.toMatchObject({ availableQuantity: 1 });
    await expect(service.evaluateBomGaps(revision.data.id)).resolves.toMatchObject({ lines: [{ suppliedQuantity: 15, missingQuantity: 0, unit: "each" }] });
    const noConversion = await service.createBomLine(revision.data.id, { id: "no-conversion-line", name: "Unconverted LEDs", role: "consumed", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [{ itemId: "conversion-set", compatible: "confirmed" }] }, c);
    await expect(service.createReservation(revision.data.id, { lineId: noConversion.data.id, itemId: "conversion-set", quantity: 1 }, c)).rejects.toMatchObject({ code: "validation" });
  }));

  it("preserves inspection source, source id, and observed time on the count path", () => withRuntime([], async (runtime, service) => {
    const c = ctx("inspection-provenance");
    const item = await service.createInventoryItem({ id: "inspection-item", name: "Uncounted ESP32", kind: "electronic", quantity: 1, unit: "each", tags: [], links: [], evidence: { state: "delivered_uncounted", source: "delivery", observedAt: "2026-09-02T00:00:00.000Z" } }, c);
    const project = await service.createProject({ id: "inspection-project", name: "Inspection provenance", status: "planned" }, c);
    const revision = await service.createProjectRevision(project.data.id, { id: "inspection-revision", name: "Initial", status: "concept" }, c);
    await service.createBomLine(revision.data.id, { id: "inspection-line", name: "ESP32", itemId: item.data.id, requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }, c);
    const action = (await service.listInspections(revision.data.id)).data.find((candidate) => candidate.itemId === item.data.id);
    if (action === undefined) throw new Error("expected physical inspection action");
    const observation = { result: "confirmed" as const, quantity: 3, unit: "each" as const, source: "bench camera", sourceId: "photo-2026-09-02-01", observedAt: "2026-09-02T01:23:00.000Z", note: "Three boards counted in the tray" };
    const preview = await service.previewInspectionCompletion(revision.data.id, { actionId: action.id, observation }, c);
    const committed = await service.commitInspectionCompletion(revision.data.id, { actionId: action.id, previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmed: true }, { ...c, idempotencyKey: "inspection-commit" });
    const expected = { state: "physically_counted", source: observation.source, sourceId: observation.sourceId, observedAt: observation.observedAt, note: observation.note };
    expect(committed.data.item).toMatchObject({ evidence: expected, availableQuantity: 3 });
    await expect(runtime.ports.inventory.getItem(item.data.id)).resolves.toMatchObject({ evidence: expected });
  }));

  it("keeps project and work-item revision artifact scopes exact while retaining legacy artifacts in all-project reads", () => withRuntime([], async (runtime) => {
    const c = ctx("artifact-scope");
    const projectId = "artifact-scope-project", projectRevisionId = "artifact-scope-project-revision";
    const workItemId = "artifact-scope-work-item", workItemRevisionId = "artifact-scope-work-revision";
    const created: string[] = [];
    const finalize = async (suffix: string, input: { readonly workItemId?: string; readonly revisionId?: string }) => {
      const body = Buffer.from(`${suffix} artifact bytes\n`);
      const session = await runtime.ports.artifacts.beginUpload({ projectId, ...input, role: "step", filename: `${suffix}.step`, mediaType: "model/step", byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex") }, c);
      await runtime.ports.artifacts.writeUpload(session.id, body);
      const artifact = await runtime.ports.artifacts.finalizeUpload(session.id, c);
      created.push(artifact.id);
      return artifact;
    };
    const projectArtifact = await finalize("project", { revisionId: projectRevisionId });
    const workArtifact = await finalize("work", { workItemId, revisionId: projectRevisionId });
    const laterWorkArtifact = await finalize("later-work", { workItemId, revisionId: workItemRevisionId });
    await finalize("legacy", {});
    const ids = async (w?: string, r?: string) => new Set((await runtime.ports.artifacts.listArtifacts(projectId, w, r)).map((artifact) => artifact.id));
    expect(await ids(undefined, projectRevisionId)).toEqual(new Set([projectArtifact.id]));
    expect(await ids(workItemId, workItemRevisionId)).toEqual(new Set([laterWorkArtifact.id]));
    expect(await ids(workItemId, projectRevisionId)).toEqual(new Set([workArtifact.id]));
    expect(await ids(workItemId)).toEqual(new Set([workArtifact.id, laterWorkArtifact.id]));
    expect(await ids()).toEqual(new Set(created));
  }));
});
