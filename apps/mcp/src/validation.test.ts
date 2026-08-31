import { describe, expect, it } from "vitest";
import { McpAdapterError } from "./errors.js";
import {
  assertProjectAccess,
  assertScope,
  categoryId,
  categorySingleId,
  artifactList,
  artifactMetadata,
  beginArtifactUpload,
  bomEvaluation,
  bomLineCreate,
  bomLineList,
  bomLineUpdate,
  boundedJsonObject,
  contextRefresh,
  dimensions,
  evidence,
  finalizeArtifactUpload,
  id,
  inventoryCreate,
  inventoryCategoryArchive,
  inventoryCategoryCreate,
  inventoryCategoryList,
  inventoryCategoryUpdate,
  inventoryWithProductProfileCreate,
  inventoryList,
  inventoryUpdate,
  offerList,
  parsePageInput,
  projectCreate,
  projectList,
  projectRevisionCreate,
  projectUpdate,
  projectWithInitialRevisionCreate,
  quantity,
  recordOffer,
  releaseReservation,
  reservation,
  retireArtifact,
  retireBomLine,
  retireProject,
  revisionRead,
  safeHttpLink,
  safeJson,
  singleId,
  stockEvent,
  stockEvents,
  usage,
  workItemCreate,
  workItemRevisionCreate,
} from "./validation.js";

const digest = "A".repeat(64);

function expectInvalid(action: () => unknown, message?: RegExp): void {
  expect(action).toThrowError(McpAdapterError);
  if (message !== undefined) expect(action).toThrowError(message);
}

describe("MCP validation boundary", () => {
  it("accepts stable identifiers and rejects path-like or empty identifiers", () => {
    expect(id("part_v2:front", "id")).toBe("part_v2:front");
    expectInvalid(() => id("", "id"), /between 1 and 128/);
    expectInvalid(() => id("../secret", "id"), /without path separators/);
    expectInvalid(() => id("part/1", "id"), /without path separators/);
    expectInvalid(() => id("part\\1", "id"), /without path separators/);
    expectInvalid(() => id("x".repeat(129), "id"));
    const longCategoryId = "c" + "a".repeat(159);
    expect(categoryId(longCategoryId, "categoryId")).toBe(longCategoryId);
    expect(categorySingleId({ categoryId: longCategoryId }, "categoryId")).toBe(longCategoryId);
    expectInvalid(() => id(longCategoryId, "id"));
    expectInvalid(() => id(42, "id"));
    expect(singleId({ itemId: "item-1" }, "itemId")).toBe("item-1");
    expectInvalid(() => singleId({ itemId: "item-1", extra: true }, "itemId"), /unknown field/);
    expectInvalid(() => singleId({ itemId: "../item" }, "itemId"));
    expect(() => singleId(null, "itemId")).toThrowError(/arguments must be an object/);
    expect(retireProject({ projectId: "project-1" })).toEqual({ projectId: "project-1" });
    expect(retireProject({ projectId: "project-1", expectedVersion: 4 })).toEqual({ projectId: "project-1", expectedVersion: 4 });
    expect(retireBomLine({ bomLineId: "bom-1", expectedVersion: 2 })).toEqual({ bomLineId: "bom-1", expectedVersion: 2 });
    expectInvalid(() => retireProject({ projectId: "project-1", expectedVersion: -1 }));
    expectInvalid(() => retireBomLine({ bomLineId: "bom-1", expectedVersion: 1.5 }));
  });

  it("normalizes pagination while bounding malformed cursors and limits", () => {
    expect(parsePageInput({})).toEqual({ limit: 25 });
    expect(parsePageInput({ limit: 100, cursor: "25" })).toEqual({ limit: 100, cursor: "25" });
    expect(parsePageInput(undefined, "params")).toEqual({ limit: 25 });
    expectInvalid(() => parsePageInput({ limit: 0 }));
    expectInvalid(() => parsePageInput({ limit: 101 }));
    expectInvalid(() => parsePageInput({ limit: 1.1 }));
    expectInvalid(() => parsePageInput({ cursor: 10 }));
    expectInvalid(() => parsePageInput({ cursor: "x".repeat(201) }));
    expectInvalid(() => parsePageInput({ unknown: true }));
  });

  it("validates quantities, dimensions, and evidence with explicit units and numeric bounds", () => {
    expect(quantity({ value: 1, unit: "piece" }, "q")).toEqual({ value: 1, unit: "piece" });
    expect(quantity({ value: 0.25, unit: "gram" }, "q")).toEqual({ value: 0.25, unit: "gram" });
    expectInvalid(() => quantity({ value: 0, unit: "piece" }, "q"));
    expectInvalid(() => quantity({ value: Number.NaN, unit: "piece" }, "q"));
    expectInvalid(() => quantity({ value: 1, unit: "pieces" }, "q"));
    expectInvalid(() => quantity({ value: 1, unit: "piece", extra: 1 }, "q"));

    expect(dimensions({ length: 10, width: 20, height: 2, diameter: 4, unit: "millimetre", source: "measured", uncertainty: 0.1 }, "d")).toEqual({ length: 10, width: 20, height: 2, diameter: 4, unit: "millimetre", source: "measured", uncertainty: 0.1 });
    expect(dimensions({ unit: "centimetre" }, "d")).toEqual({ unit: "centimetre" });
    expectInvalid(() => dimensions({ unit: "inch" }, "d"));
    expectInvalid(() => dimensions({ unit: "millimetre", length: 0 }, "d"));
    expectInvalid(() => dimensions({ unit: "millimetre", uncertainty: -1 }, "d"));

    expect(evidence({ state: "physical_count", source: "bench-count", recordedAt: "2026-08-30T10:00:00Z", note: "drawer 2" }, "e")).toMatchObject({ state: "physical_count", source: "bench-count", note: "drawer 2" });
    expect(evidence({ state: "unknown", source: "legacy-import", recordedAt: "unknown" }, "e")).toEqual({ state: "unknown", source: "legacy-import", recordedAt: "unknown", note: undefined });
    expectInvalid(() => evidence({ state: "confirmed", source: "x", recordedAt: "now" }, "e"));
    expectInvalid(() => evidence({ state: "unknown", source: "", recordedAt: "now" }, "e"));
    expectInvalid(() => evidence({ state: "unknown", source: "x", recordedAt: "now", extra: "nope" }, "e"));
  });

  it("validates inventory reads and writes, including links, optional metadata, and filters", () => {
    const longCategoryId = "c" + "a".repeat(159);
    expect(inventoryList({ limit: 10, query: "PETG", category: "filament", availability: "confirmed", location: "drawer-A" })).toMatchObject({ limit: 10, query: "PETG", category: "filament", availability: "confirmed", location: "drawer-A" });
    expect(inventoryList(undefined)).toEqual({ limit: 25, query: undefined, category: undefined, availability: undefined, location: undefined });
    const created = inventoryCreate({
      name: "PETG HF",
      category: "filament",
      quantity: { value: 1000, unit: "gram" },
      evidence: { state: "physical_count", source: "weighed", recordedAt: "2026-08-30" },
      categoryNodeId: longCategoryId,
      description: "High-flow filament",
      manufacturer: "Bambu Lab",
      model: "PETG HF",
      sku: "PETG-HF-BLK",
      dimensions: { length: 1, unit: "metre", source: "manufacturer" },
      condition: "opened",
      location: "filament cabinet",
      links: [{ label: "Manufacturer", url: "https://maker.example/petg" }],
    });
    expect(created).toMatchObject({ name: "PETG HF", categoryNodeId: longCategoryId, quantity: { value: 1000, unit: "gram" }, condition: "opened", links: [{ label: "Manufacturer" }] });
    expect(inventoryUpdate({ itemId: "filament-1", expectedVersion: 3, categoryNodeId: longCategoryId, model: "PETG HF v2", links: [] })).toMatchObject({ itemId: "filament-1", expectedVersion: 3, categoryNodeId: longCategoryId, model: "PETG HF v2", links: [] });
    expectInvalid(() => inventoryList({ availability: "maybe" }));
    expectInvalid(() => inventoryCreate({ name: "x", category: "tool", quantity: { value: 1, unit: "piece" }, evidence: { state: "unknown", source: "x", recordedAt: "now" }, links: [{ label: "bad", url: "file:///secret" }] }));
    expectInvalid(() => inventoryUpdate({ itemId: "item-1", links: [{ label: "bad", url: "https://example.test/a" }, { label: "bad", url: "https://example.test/b" }], unexpected: true }));
  });

  it("validates bounded category CRUD inputs and keeps parent/archive commands separate", () => {
    expect(inventoryCategoryList({ limit: 10, includeArchived: true })).toEqual({ limit: 10, cursor: undefined, includeArchived: true });
    expect(inventoryCategoryList({ cursor: "x".repeat(512) }).cursor).toHaveLength(512);
    expectInvalid(() => inventoryCategoryList({ cursor: "x".repeat(513) }));
    const longCategoryId = "c" + "a".repeat(159);
    expect(inventoryCategoryCreate({ id: longCategoryId, name: "  Printer parts  ", parentId: longCategoryId, sortOrder: 2 })).toEqual({ id: longCategoryId, name: "Printer parts", parentId: longCategoryId, sortOrder: 2 });
    expect(inventoryCategoryUpdate({ categoryId: longCategoryId, expectedVersion: 3, name: "Printers" })).toMatchObject({ categoryId: longCategoryId, expectedVersion: 3, name: "Printers" });
    expect(inventoryCategoryArchive({ categoryId: longCategoryId, expectedVersion: 3 })).toEqual({ categoryId: longCategoryId, expectedVersion: 3 });
    expect(inventoryCategoryCreate({ id: longCategoryId, name: "  Printer parts  ", parentId: longCategoryId, sortOrder: 2 })).toEqual({ id: longCategoryId, name: "Printer parts", parentId: longCategoryId, sortOrder: 2 });
    expect(inventoryCategoryUpdate({ categoryId: "category-printers", expectedVersion: 3, name: "Printers" })).toMatchObject({ categoryId: "category-printers", expectedVersion: 3, name: "Printers" });
    expect(inventoryCategoryArchive({ categoryId: "category-printers", expectedVersion: 3 })).toEqual({ categoryId: "category-printers", expectedVersion: 3 });
    expectInvalid(() => inventoryCategoryUpdate({ categoryId: "category-printers", name: "Printers" }));
    expectInvalid(() => inventoryCategoryArchive({ categoryId: "category-printers" }));
    expectInvalid(() => inventoryCategoryUpdate({ categoryId: "category-printers", parentId: "category-tools" }));
    expectInvalid(() => inventoryCategoryArchive({ categoryId: "bad/id" }));
  });

  it("validates the atomic inventory/profile request and forbids profile item identity", () => {
    const parsed = inventoryWithProductProfileCreate({
      item: {
        name: "PETG HF",
        category: "filament",
        quantity: { value: 1000, unit: "gram" },
        evidence: { state: "delivery", source: "order-1", recordedAt: "2026-08-30" },
      },
      profile: {
        catalogProductId: "catalog-petg-hf",
        profileType: "filament_spool",
        linkState: "reported",
        details: { openedState: "sealed" },
      },
    });
    expect(parsed).toMatchObject({ item: { name: "PETG HF" }, profile: { catalogProductId: "catalog-petg-hf" } });
    expectInvalid(() => inventoryWithProductProfileCreate({
      ...parsed,
      profile: { ...parsed.profile, itemId: "item-1" },
    }));
    expectInvalid(() => inventoryWithProductProfileCreate({ ...parsed, extra: true }));
  });

  it("accepts every stock event kind and protects event history inputs", () => {
    for (const kind of ["receipt", "count_correction", "allocation", "return", "use", "loss", "disposal"] as const) {
      expect(stockEvent({ itemId: "item-1", kind, quantity: { value: 1, unit: "piece" }, note: `event ${kind}` })).toMatchObject({ itemId: "item-1", kind, quantity: { value: 1, unit: "piece" } });
    }
    expect(stockEvents({ itemId: "item-1", limit: 5, cursor: "10" })).toEqual({ itemId: "item-1", limit: 5, cursor: "10" });
    expectInvalid(() => stockEvent({ itemId: "item-1", kind: "consume", quantity: { value: 1, unit: "piece" } }));
    expectInvalid(() => stockEvents({ itemId: "item-1", limit: 0 }));
  });

  it("validates project, work-item, and revision commands", () => {
    expect(projectList({ query: "lamp", status: "paused", limit: 2 })).toMatchObject({ query: "lamp", status: "paused", limit: 2 });
    expect(projectCreate({ name: "Autonomous lamp", description: "A servo-driven light" })).toEqual({ name: "Autonomous lamp", description: "A servo-driven light" });
    expect(projectWithInitialRevisionCreate({ name: "Lamp", projectId: "lamp", revisionId: "lamp-r1", revisionSummary: "Initial concept" })).toMatchObject({ name: "Lamp", projectId: "lamp", revisionId: "lamp-r1", revisionSummary: "Initial concept" });
    expect(projectUpdate({ projectId: "lamp", expectedVersion: 2, status: "complete" })).toEqual({ projectId: "lamp", expectedVersion: 2, name: undefined, description: undefined, status: "complete" });
    expect(workItemCreate({ projectId: "lamp", name: "Base", kind: "part" })).toMatchObject({ projectId: "lamp", name: "Base", kind: "part" });
    expect(projectRevisionCreate({ projectId: "lamp", summary: "r02" })).toEqual({ projectId: "lamp", summary: "r02" });
    expect(workItemRevisionCreate({ workItemId: "base", summary: "fit revision" })).toEqual({ workItemId: "base", summary: "fit revision" });
    expect(revisionRead({ revisionId: "lamp-r1" })).toEqual({ revisionId: "lamp-r1" });
    expectInvalid(() => projectList({ status: "done" }));
    expectInvalid(() => projectCreate({ name: "" }));
    expectInvalid(() => projectWithInitialRevisionCreate({ name: "Lamp", projectId: "bad/id" }));
    expectInvalid(() => workItemCreate({ projectId: "lamp", name: "Base", kind: "printer" }));
    expectInvalid(() => projectUpdate({ projectId: "lamp", status: "idea" }));
  });

  it("validates BOM, alternatives, constraints, reservations, and usage", () => {
    expect(bomLineList({ projectRevisionId: "lamp-r1", limit: 20 })).toMatchObject({ projectRevisionId: "lamp-r1", limit: 20 });
    const line = bomLineCreate({ projectRevisionId: "lamp-r1", description: "M3 screw", quantity: 4, unit: "piece", requirement: "required", itemId: "m3-screw", alternatives: [{ itemId: "m3-screw-2", compatible: "confirmed", reason: "same thread" }], constraints: { kind: "fastener", manufacturer: "Acme", model: "M3", sku: "M3-12", tag: "stainless", nameIncludes: "screw" }, notes: "Use button head" });
    expect(line).toMatchObject({ description: "M3 screw", alternatives: [{ itemId: "m3-screw-2", compatible: "confirmed", reason: "same thread" }], constraints: { kind: "fastener", nameIncludes: "screw" } });
    const legacyLine = bomLineCreate({ projectRevisionId: "lamp-r1", description: "Legacy screw", quantity: 1, unit: "piece", compatibleItemIds: ["m3-screw-3"] });
    expect(legacyLine).toMatchObject({ compatibleItemIds: ["m3-screw-3"] });
    expect(bomLineUpdate({ bomLineId: "bom-1", expectedVersion: 1, quantity: 2, unit: "set", requirement: "optional", constraints: {} })).toMatchObject({ bomLineId: "bom-1", quantity: 2, unit: "set", requirement: "optional" });
    expect(bomEvaluation({ projectRevisionId: "lamp-r1" })).toEqual({ projectRevisionId: "lamp-r1" });
    expect(reservation({ projectRevisionId: "lamp-r1", bomLineId: "bom-1", itemId: "m3-screw", quantity: { value: 4, unit: "piece" } })).toMatchObject({ bomLineId: "bom-1", quantity: { value: 4, unit: "piece" } });
    expect(releaseReservation({ reservationId: "reservation-1", expectedVersion: 1 })).toEqual({ reservationId: "reservation-1", expectedVersion: 1 });
    expect(usage({ projectRevisionId: "lamp-r1", reservationId: "reservation-1", itemId: "m3-screw", quantity: { value: 4, unit: "piece" }, note: "installed" })).toMatchObject({ reservationId: "reservation-1", note: "installed" });
    expectInvalid(() => bomLineCreate({ projectRevisionId: "lamp-r1", description: "x", quantity: 1, unit: "piece", compatibleItemIds: ["bad/id"] }));
    expectInvalid(() => bomLineCreate({ projectRevisionId: "lamp-r1", description: "x", quantity: 1, unit: "piece", alternatives: [{ itemId: "alt", compatible: "confirmed" }], compatibleItemIds: ["alt"] }), /not both/);
    expectInvalid(() => bomLineCreate({ projectRevisionId: "lamp-r1", description: "x", quantity: 1, unit: "piece", alternatives: [{ itemId: "alt", compatible: "maybe" }] }));
    expectInvalid(() => bomLineCreate({ projectRevisionId: "lamp-r1", description: "x", quantity: 1, unit: "piece", constraints: { invalid: "value" } }), /unsupported/);
    expectInvalid(() => bomLineCreate({ projectRevisionId: "lamp-r1", description: "x", quantity: 1, unit: "piece", constraints: { kind: ["electronic"] } }), /string/);
    expectInvalid(() => bomLineUpdate({ bomLineId: "bom-1", quantity: 0 }));
    expectInvalid(() => reservation({ projectRevisionId: "lamp-r1", bomLineId: "bom-1", itemId: "m3", quantity: { value: 1, unit: "each" } }));
    expectInvalid(() => usage({ projectRevisionId: "lamp-r1", itemId: "m3", quantity: { value: 1, unit: "piece" }, extra: true }));
  });

  it("protects artifact filenames, digests, role selectors, and transfer invariants", () => {
    expect(artifactList({ projectId: "lamp", workItemId: "base", revisionId: "base-r1", role: "step", limit: 5 })).toMatchObject({ projectId: "lamp", workItemId: "base", revisionId: "base-r1", role: "step" });
    expect(beginArtifactUpload({ projectId: "lamp", projectRevisionId: "lamp-r1", buildConfigurationSnapshotId: "build-config-1", filename: "part.step", role: "step", mediaType: "model/step", byteLength: 100, sha256: digest })).toMatchObject({ projectRevisionId: "lamp-r1", buildConfigurationSnapshotId: "build-config-1", filename: "part.step", sha256: digest.toLowerCase() });
    expect(beginArtifactUpload({ projectId: "lamp", workItemId: "base", workItemRevisionId: "base-r1", filename: "part.3mf", role: "three_mf", mediaType: "model/3mf", byteLength: 0, sha256: digest })).toMatchObject({ workItemId: "base", workItemRevisionId: "base-r1", byteLength: 0 });
    expect(finalizeArtifactUpload({ uploadId: "upload-1" })).toEqual({ uploadId: "upload-1" });
    expect(artifactMetadata({ artifactId: "artifact-1", revisionId: "lamp-r1" })).toEqual({ artifactId: "artifact-1", revisionId: "lamp-r1" });
    expect(retireArtifact({ artifactId: "artifact-1", expectedVersion: 3 })).toEqual({ artifactId: "artifact-1", expectedVersion: 3 });
    expectInvalid(() => beginArtifactUpload({ projectId: "lamp", filename: "../part.step", role: "step", mediaType: "model/step", byteLength: 10, sha256: digest }));
    expectInvalid(() => beginArtifactUpload({ projectId: "lamp", filename: "part.step", role: "step", mediaType: "model/step", byteLength: -1, sha256: digest }));
    expectInvalid(() => beginArtifactUpload({ projectId: "lamp", filename: "part.step", role: "unknown", mediaType: "model/step", byteLength: 10, sha256: digest }));
    expectInvalid(() => beginArtifactUpload({ projectId: "lamp", filename: "part.step", role: "step", mediaType: "model/step", byteLength: 10, sha256: "not-a-digest" }));
    expectInvalid(() => beginArtifactUpload({ projectId: "lamp", projectRevisionId: "lamp-r1", workItemId: "base", filename: "part.step", role: "step", mediaType: "model/step", byteLength: 10, sha256: digest }));
    expectInvalid(() => beginArtifactUpload({ projectId: "lamp", workItemRevisionId: "base-r1", filename: "part.step", role: "step", mediaType: "model/step", byteLength: 10, sha256: digest }));
    expectInvalid(() => artifactList({ projectId: "lamp", role: "unknown" }));
  });

  it("validates offer observations and context refresh requests", () => {
    expect(offerList({ itemId: "m3-screw", query: "amazon", supplier: "Amazon", limit: 10 })).toMatchObject({ itemId: "m3-screw", query: "amazon", supplier: "Amazon" });
    expect(recordOffer({ itemId: "m3-screw", description: "M3 screw pack", supplier: "Amazon", url: "https://amazon.example/m3", packageQuantity: { value: 100, unit: "piece" }, price: { minor: 499, currency: "eur" }, shippingMinor: 0, observedAt: "2026-08-30T10:00:00Z" })).toMatchObject({ itemId: "m3-screw", price: { minor: 499, currency: "EUR" }, shippingMinor: 0 });
    expect(contextRefresh({ projectId: "lamp", includeInventory: false, maxAgeSeconds: 60 })).toEqual({ projectId: "lamp", includeInventory: false, maxAgeSeconds: 60 });
    expect(contextRefresh(undefined)).toEqual({ projectId: undefined, includeInventory: undefined, maxAgeSeconds: undefined });
    expectInvalid(() => recordOffer({ supplier: "Amazon", url: "ftp://amazon.example/m3", price: { minor: 499, currency: "EUR" } }));
    expectInvalid(() => recordOffer({ supplier: "Amazon", url: "https://amazon.example/m3", price: { minor: 499, currency: "EU" } }));
    expectInvalid(() => recordOffer({ supplier: "Amazon", url: "https://amazon.example/m3", price: { minor: -1, currency: "EUR" } }));
    expectInvalid(() => contextRefresh({ includeInventory: "yes" }));
    expectInvalid(() => contextRefresh({ maxAgeSeconds: 86_401 }));
  });

  it("enforces scope helpers and only allows absolute HTTP artifact links", () => {
    expect(() => assertScope(["inventory:read"], "inventory:read")).not.toThrow();
    expectInvalid(() => assertScope([], "inventory:read"), /inventory:read/);
    expect(() => assertProjectAccess({ projectIds: ["lamp"] }, "lamp")).not.toThrow();
    expectInvalid(() => assertProjectAccess({ projectIds: ["other"] }, "lamp"), /not scoped/);
    expect(() => assertProjectAccess({}, "lamp")).not.toThrow();
    expect(safeHttpLink("https://maker.example/api/v1/transfers/artifacts/artifact-1/download", "link")).toContain("/artifacts/");
    expectInvalid(() => safeHttpLink("data:text/plain,secret", "link"), /scoped HTTP/);
    expectInvalid(() => safeHttpLink("https://maker.example/api/v1/transfers/artifacts/artifact-1/download?token=secret", "link"), /scoped BenchLedger/);
    expectInvalid(() => safeHttpLink("https://maker.example/not-an-artifact", "link"), /scoped BenchLedger/);
    expectInvalid(() => safeHttpLink("file:///tmp/artifact", "link"), /scoped HTTP/);
  });

  it("keeps returned JSON finite, bounded, and free of inline binary payloads", () => {
    expect(safeJson({ text: "ok", values: [1, true, null] })).toEqual({ text: "ok", values: [1, true, null] });
    expect(safeJson({ nested: { value: "ok" } })).toMatchObject({ nested: { value: "ok" } });
    expectInvalid(() => safeJson({ base64: "AAAA" }), /Binary content/);
    expectInvalid(() => safeJson({ rawBinary: "AAAA" }), /Binary content/);
    expectInvalid(() => safeJson({ value: "data:text/plain,secret" }), /Inline data URLs/);
    expectInvalid(() => safeJson({ value: Number.POSITIVE_INFINITY }));
    expectInvalid(() => safeJson({ value: BigInt(1) }));
    expectInvalid(() => boundedJsonObject(["not", "an", "object"], 100));
    expectInvalid(() => boundedJsonObject({ large: "x".repeat(20) }, 5), /too large/);
    expectInvalid(() => safeJson(Array.from({ length: 1001 }, () => 1)), /too many entries/);
    let nested: unknown = "end";
    for (let index = 0; index < 14; index += 1) nested = { nested };
    expectInvalid(() => safeJson(nested), /nested too deeply/);
  });
});
