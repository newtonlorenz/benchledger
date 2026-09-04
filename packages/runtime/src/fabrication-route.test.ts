import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationService } from "@benchledger/application";
import type { RequestContext } from "@benchledger/application";
import { createProductionRuntime, type ProductionRuntime } from "./index.js";

const context: RequestContext = {
  actor: "route-test",
  source: "api",
  correlationId: "route-test-correlation",
  scopes: new Set(["read", "write", "catalog:read", "catalog:write", "projects:read", "projects:write"])
};

const runtimes: ProductionRuntime[] = [];
const directories: string[] = [];

async function makeRuntime(): Promise<ProductionRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), "benchledger-route-test-"));
  directories.push(dataDir);
  const runtime = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("project revision fabrication route", () => {
  it("carries printed route and printer to a new revision, then clears it on route change", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const printer = await service.createInventoryItem({
      id: "route-printer", name: "Route printer", kind: "printer", quantity: 1, unit: "each", tags: [], links: [],
      evidence: { state: "commissioned", source: "bench" }
    }, context);
    const product = await service.createCatalogProduct({
      kind: "printer", manufacturer: "Example", exactModel: "Route Printer", technology: "fff", buildVolumeMm: { x: 220, y: 220, z: 250 }
    }, context);
    await service.putInventoryProductProfile(printer.data.id, { catalogProductId: product.data.id, profileType: "printer_asset", linkState: "confirmed", details: {} }, undefined, context);
    const setupPreview = await service.previewProjectSetup({
      project: { id: "setup-route-project", name: "Setup route project", status: "planned" },
      revision: { id: "setup-route-revision", name: "Printed setup", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: printer.data.id },
      workItems: [],
      bomLines: [{ localRef: "setup-line", id: "setup-route-line", name: "Setup requirement", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
      reservations: []
    }, context);
    const unownedPrinterPreview = structuredClone(setupPreview);
    unownedPrinterPreview.proposal.revision.intendedPrinterItemId = "missing-setup-printer";
    await expect(runtime.ports.projectSetups!.commitPreview({
      preview: unownedPrinterPreview,
      command: { previewId: setupPreview.id, expectedPreviewVersion: setupPreview.version, contentSha256: setupPreview.contentSha256, confirmReservations: false },
      actor: context.actor, source: context.source, correlationId: context.correlationId
    })).rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/inventory item/i) });
    const project = await service.createProject({ id: "route-project", name: "Route project", status: "planned" }, context);
    await expect(service.createProjectRevision(project.data.id, { id: "omitted-route-invalid", name: "Invalid", status: "concept", intendedPrinterItemId: printer.data.id }, context))
      .rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/printed fabrication route/i) });
    await expect(runtime.ports.projects.createProjectRevision(project.data.id, { id: "adapter-omitted-route-invalid", name: "Invalid", status: "concept", intendedPrinterItemId: printer.data.id }, context))
      .rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/printed fabrication route/i) });
    await expect(runtime.ports.projects.createProjectWithInitialRevision!({
      project: { id: "atomic-omitted-route-invalid-project", name: "Atomic invalid route", status: "planned" },
      revision: { id: "atomic-omitted-route-invalid-revision", name: "Invalid", status: "concept", intendedPrinterItemId: printer.data.id }
    }, context)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/printed fabrication route/i) });
    const first = await service.createProjectRevision(project.data.id, { id: "route-revision-1", name: "Initial", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: printer.data.id }, context);
    expect(first.data).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: printer.data.id });

    const carried = await service.createProjectRevision(project.data.id, { id: "route-revision-2", name: "Ready", status: "concept" }, context);
    expect(carried.data).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: printer.data.id });

    const changed = await service.updateProjectRevision(carried.data.id, { fabricationRoute: "ready_made" }, carried.data.version, context);
    expect(changed.data).toMatchObject({ fabricationRoute: "ready_made" });
    expect(changed.data).toMatchObject({ intendedPrinterItemId: null });
    await expect(runtime.ports.projects.updateProjectRevision!(carried.data.id, { fabricationRoute: "ready_made", intendedPrinterItemId: printer.data.id }, changed.data.version, context))
      .rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/printed fabrication route/i) });

    const carriedReadyMade = await service.createProjectRevision(project.data.id, { id: "route-revision-3", name: "Ready-made carry", status: "concept" }, context);
    expect(carriedReadyMade.data).toMatchObject({ fabricationRoute: "ready_made" });
    expect(carriedReadyMade.data).toMatchObject({ intendedPrinterItemId: null });

    const printedWithoutPrinter = await service.updateProjectRevision(carriedReadyMade.data.id, { fabricationRoute: "printed" }, carriedReadyMade.data.version, context);
    expect(printedWithoutPrinter.data).toMatchObject({ fabricationRoute: "printed" });
    expect(printedWithoutPrinter.data).toMatchObject({ intendedPrinterItemId: null });

    const selectedLater = await service.updateProjectRevision(printedWithoutPrinter.data.id, { fabricationRoute: "printed", intendedPrinterItemId: printer.data.id }, printedWithoutPrinter.data.version, context);
    expect(selectedLater.data).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: printer.data.id });

    const clearedAgain = await service.updateProjectRevision(selectedLater.data.id, { intendedPrinterItemId: null }, selectedLater.data.version, context);
    expect(clearedAgain.data).toMatchObject({ fabricationRoute: "printed" });
    expect(clearedAgain.data).toMatchObject({ intendedPrinterItemId: null });
    const carriedClear = await service.createProjectRevision(project.data.id, { id: "route-revision-4", name: "Cleared carry", status: "concept" }, context);
    expect(carriedClear.data).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: null });

    const atomicWithoutPrinter = await service.createProjectWithInitialRevision({
      project: { name: "Printed later", status: "planned" },
      revision: { name: "Initial", status: "concept", fabricationRoute: "printed" }
    }, context);
    expect(atomicWithoutPrinter.data.revision).toMatchObject({ fabricationRoute: "printed" });
    expect(atomicWithoutPrinter.data.revision).toMatchObject({ intendedPrinterItemId: null });

    const undecidedProject = await service.createProject({ id: "route-undecided-project", name: "Undecided route", status: "planned" }, context);
    const undecidedRevision = await service.createProjectRevision(undecidedProject.data.id, { name: "Generated baseline", status: "concept" }, context);
    expect(undecidedRevision.data.id).toMatch(/^project-revision_/u);
    expect(undecidedRevision.data).toMatchObject({ fabricationRoute: "undecided" });
    expect(undecidedRevision.data).toMatchObject({ intendedPrinterItemId: null });

    const clearedOnCreate = await service.createProjectRevision(project.data.id, {
      id: "route-revision-explicit-clear", name: "Clear on new revision", status: "concept", intendedPrinterItemId: null
    }, context);
    expect(clearedOnCreate.data).toMatchObject({ fabricationRoute: "printed", intendedPrinterItemId: null });

    await expect(service.updateProjectRevision("missing-route-revision", { fabricationRoute: "none" }, 1, context))
      .rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/project revision/i) });
    await expect(runtime.ports.projects.updateProjectRevision!("missing-route-revision", { fabricationRoute: "none" }, 1, context))
      .rejects.toThrow(/does not exist/i);
  });

  it("rejects an exact printer profile when physical stock evidence is unverified", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const project = await service.createProject({ id: "unverified-route-project", name: "Unverified route", status: "planned" }, context);
    await expect(service.createProjectRevision(project.data.id, {
      id: "missing-route-revision", name: "Missing printer", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: "missing-printer"
    }, context)).rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/inventory item/i) });

    const tool = await service.createInventoryItem({
      id: "not-a-printer", name: "Bench tool", kind: "tool", quantity: 1, unit: "each", tags: [], links: [],
      evidence: { state: "physically_counted", source: "bench" }
    }, context);
    await expect(service.createProjectRevision(project.data.id, {
      id: "tool-route-revision", name: "Wrong item kind", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: tool.data.id
    }, context)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/owned printer inventory item/i) });

    const unprofiledPrinter = await service.createInventoryItem({
      id: "unprofiled-printer", name: "Unprofiled printer", kind: "printer", quantity: 1, unit: "each", tags: [], links: [],
      evidence: { state: "commissioned", source: "bench" }
    }, context);
    await expect(service.createProjectRevision(project.data.id, {
      id: "unprofiled-route-revision", name: "Missing profile", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: unprofiledPrinter.data.id
    }, context)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/exact printer product profile/i) });

    const printer = await service.createInventoryItem({
      id: "unverified-printer", name: "Unverified printer", kind: "printer", quantity: 1, unit: "each", tags: [], links: [],
      evidence: { state: "delivered_uncounted", source: "delivery" }
    }, context);
    const product = await service.createCatalogProduct({
      kind: "printer", manufacturer: "Example", exactModel: "Unverified Printer", technology: "fff", buildVolumeMm: { x: 220, y: 220, z: 250 }
    }, context);
    await service.putInventoryProductProfile(printer.data.id, { catalogProductId: product.data.id, profileType: "printer_asset", linkState: "confirmed", details: {} }, undefined, context);
    await expect(service.createProjectRevision(project.data.id, {
      id: "unverified-route-revision", name: "Initial", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: printer.data.id
    }, context)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/positive available stock|physically counted|commissioned/i) });

    const profileUnverified = await service.createInventoryItem({
      id: "profile-unverified-printer", name: "Profile-unverified printer", kind: "printer", quantity: 1, unit: "each", tags: [], links: [],
      evidence: { state: "commissioned", source: "bench" }
    }, context);
    await service.putInventoryProductProfile(profileUnverified.data.id, { catalogProductId: product.data.id, profileType: "printer_asset", linkState: "reported", details: {} }, undefined, context);
    await expect(service.createProjectRevision(project.data.id, {
      id: "profile-unverified-route-revision", name: "Initial", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: profileUnverified.data.id
    }, context)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/exact printer product profile/i) });
  });

  it("rejects retired or unit-incompatible printer inventory", async () => {
    const runtime = await makeRuntime();
    const service = new ApplicationService(runtime.ports);
    const printer = await service.createInventoryItem({
      id: "incompatible-route-printer", name: "Incompatible route printer", kind: "printer", quantity: 1, unit: "each", tags: [], links: [],
      evidence: { state: "commissioned", source: "bench" }
    }, context);
    const product = await service.createCatalogProduct({
      kind: "printer", manufacturer: "Example", exactModel: "Incompatible Route Printer", technology: "fff", buildVolumeMm: { x: 220, y: 220, z: 250 }
    }, context);
    await service.putInventoryProductProfile(printer.data.id, { catalogProductId: product.data.id, profileType: "printer_asset", linkState: "confirmed", details: {} }, undefined, context);
    const project = await service.createProject({ id: "incompatible-route-project", name: "Incompatible route", status: "planned" }, context);
    const getItem = runtime.ports.inventory.getItem.bind(runtime.ports.inventory);
    runtime.ports.inventory.getItem = async (id) => {
      const item = await getItem(id);
      return item?.id === printer.data.id ? { ...item, retiredAt: "2026-09-04T00:00:00.000Z" } : item;
    };
    await expect(service.createProjectRevision(project.data.id, {
      id: "retired-route-revision", name: "Retired", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: printer.data.id
    }, context)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/retired/i) });

    runtime.ports.inventory.getItem = async (id) => {
      const item = await getItem(id);
      return item?.id === printer.data.id ? { ...item, unit: "gram", unitStatus: "needs_correction" } : item;
    };
    await expect(service.createProjectRevision(project.data.id, {
      id: "unit-incompatible-route-revision", name: "Wrong unit", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: printer.data.id
    }, context)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/compatible each unit/i) });

    runtime.ports.inventory.getItem = async (id) => {
      const item = await getItem(id);
      return item?.id === printer.data.id ? { ...item, availableQuantity: 0 } : item;
    };
    await expect(service.createProjectRevision(project.data.id, {
      id: "unavailable-route-revision", name: "Unavailable", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: printer.data.id
    }, context)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/positive available stock/i) });

    runtime.ports.inventory.getItem = getItem;
    const getProduct = runtime.ports.catalog!.getProduct.bind(runtime.ports.catalog);
    runtime.ports.catalog!.getProduct = async (id) => {
      const found = await getProduct(id);
      return found === null ? null : { ...found, kind: "filament" } as never;
    };
    await expect(service.createProjectRevision(project.data.id, {
      id: "wrong-product-route-revision", name: "Wrong catalog kind", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: printer.data.id
    }, context)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/printer catalog product/i) });
  });
});
