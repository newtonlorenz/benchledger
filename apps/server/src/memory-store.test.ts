import { describe, expect, it } from "vitest";
import type { CatalogProduct } from "@benchledger/api-contract";
import { createMemoryRuntime, MemoryUnitOfWork } from "./memory-store.js";

describe("MemoryInventory", () => {
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
    runtime.projects.projectRevisions.set("revision-release-failure", { id: "revision-release-failure", projectId: project.id, number: 1, name: "Initial", status: "concept", createdAt: project.createdAt, version: 1 });
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
    runtime.projects.projectRevisions.set("revision-archive-preflight", { id: "revision-archive-preflight", projectId: project.id, number: 1, name: "Initial", status: "concept", createdAt: project.createdAt, version: 1 });
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
    runtime.projects.projectRevisions.set("revision-archive-commit", { id: "revision-archive-commit", projectId: project.id, number: 1, name: "Initial", status: "concept", createdAt: project.createdAt, version: 1 });
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
