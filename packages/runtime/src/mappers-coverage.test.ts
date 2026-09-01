import { describe, expect, it } from "vitest";
import type { RequestContext } from "@benchledger/application";
import type { ArtifactRevision } from "@benchledger/artifacts";
import type { CreateInventoryItem, StockEventInput } from "@benchledger/api-contract";
import type { InventoryItem, Project, WorkItem, ProjectRevision, WorkItemRevision, BomLine, Reservation, OfferSnapshot, Supplier, StockEvent } from "@benchledger/domain";
import {
  apiArtifactFromStore,
  apiBomLineFromNative,
  apiInventoryFromNative,
  apiOfferFromNative,
  apiProjectFromNative,
  apiProjectRevisionFromNative,
  apiReservationFromNative,
  apiStockEventFromNative,
  apiUploadSessionFromStore,
  apiWorkItemFromNative,
  apiWorkItemRevisionFromNative,
  isConfirmedEvidence,
  mapApiDimensionsToDomain,
  mapApiKindToCategory,
  mapApiUnitToDomain,
  mapDomainDimensionsToApi,
  nativeConstraintsFromApi,
  nativeItemFromApi,
  nativeProjectStatus,
  nativeStockEventFromApi,
  readInventoryMetadata
} from "./mappers.js";

const context = (source: RequestContext["source"] = "api"): RequestContext => ({
  actor: "mapper-agent",
  source,
  correlationId: "mapper-correlation",
  scopes: new Set(["read", "write"])
});

const nativeItem: InventoryItem = {
  id: "native-item",
  name: "Native item",
  category: "electronics",
  variant: "Rev B",
  purchasedQuantity: 12,
  unit: "meter",
  sourceStatus: "physically_confirmed",
  reusePolicy: "available",
  confidence: "confirmed",
  reportedQuantity: 9,
  manufacturer: "Maker",
  model: "Board",
  dimensions: { depth: 20, width: 30, height: 40, diameter: 2, unit: "cm", kind: "measured", uncertainty: 0.1, source: "drawing" },
  notes: "native notes",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z"
};

describe("inventory and dimension mapper edges", () => {
  it("reads only well-shaped BenchLedger metadata and supplier links", () => {
    expect(readInventoryMetadata(undefined)).toEqual({});
    expect(readInventoryMetadata({ benchLedger: "not-an-object" })).toEqual({});
    const metadata = readInventoryMetadata({ benchLedger: {
      kind: "filament",
      description: "White PETG",
      sku: "PETG-W",
      location: "shelf 1",
      condition: "good",
      tags: ["petg", "white"],
      links: [{ supplier: "Supplier", url: "https://supplier.example/petg", label: "listing", currentPriceMinor: 1900, currency: "EUR", observedAt: "2026-01-01T00:00:00.000Z", packageQuantity: 1 }],
      evidence: { state: "physically_counted", source: "count sheet", sourceId: "sheet-1", observedAt: "2026-01-01T00:00:00.000Z", note: "counted" }
    } });
    expect(metadata).toMatchObject({ kind: "filament", description: "White PETG", sku: "PETG-W", location: "shelf 1", condition: "good", tags: ["petg", "white"], links: [{ supplier: "Supplier", currentPriceMinor: 1900 }], evidence: { state: "physically_counted", sourceId: "sheet-1" } });
    expect(readInventoryMetadata({ benchLedger: { kind: "not-a-kind", condition: "broken", tags: ["ok", 1], links: [{ supplier: "missing-url" }], evidence: { state: "bad" } } })).toEqual({});
    expect(readInventoryMetadata({ benchLedger: { links: "not-an-array", evidence: [], tags: [] } })).toEqual({ tags: [] });
  });

  it("maps every public kind/unit and converts dimensions across units", () => {
    const kinds = ["printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"] as const;
    expect(kinds.map(mapApiKindToCategory)).toEqual(["printer", "tool", "printer_accessory", "consumable", "electronics", "fastener", "filament", "electrical", "adhesive", "other"]);
    expect(["each", "gram", "millimetre", "millilitre", "metre", "set"].map((unit) => mapApiUnitToDomain(unit as never))).toEqual(["piece", "gram", "millimetre", "millilitre", "meter", "set"]);
    const dimensions = mapApiDimensionsToDomain({ lengthMm: 10, widthMm: 20, heightMm: 30, diameterMm: 4, measured: true, uncertaintyMm: 0.2, note: "caliper" });
    expect(dimensions).toEqual({ depth: 10, width: 20, height: 30, diameter: 4, unit: "mm", kind: "measured", uncertainty: 0.2, source: "caliper" });
    expect(mapDomainDimensionsToApi(dimensions)).toEqual({ lengthMm: 10, widthMm: 20, heightMm: 30, diameterMm: 4, measured: true, uncertaintyMm: 0.2, note: "caliper" });
    expect(mapDomainDimensionsToApi(undefined)).toBeUndefined();
    expect(mapDomainDimensionsToApi({ depth: 2, width: 3, height: 4, diameter: 0.5, unit: "cm", kind: "nominal", uncertainty: 0.1, source: "spec" })).toEqual({ lengthMm: 20, widthMm: 30, heightMm: 40, diameterMm: 5, measured: false, uncertaintyMm: 1, note: "spec" });
    expect(mapDomainDimensionsToApi({ depth: 1, unit: "m", kind: "estimated" })).toEqual({ lengthMm: 1000, measured: false });
  });

  it("maps every evidence state and preserves existing provenance during updates", () => {
    const states = ["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"] as const;
    for (const state of states) {
      const input: CreateInventoryItem = { id: `item-${state}`, name: ` Item ${state} `, kind: "electronic", quantity: 2, unit: "each", tags: [], links: [], evidence: { state } };
      const mapped = nativeItemFromApi(input, input.id!, "2026-01-03T00:00:00.000Z");
      expect(mapped.name).toBe(`Item ${state}`);
      expect(mapped.sourceStatus).toBe(state === "physically_counted" ? "physically_confirmed" : state === "commissioned" ? "commissioned_available" : state === "delivered_uncounted" ? "delivered_uncounted" : state === "ordered_unverified" ? "ordered_unverified" : state === "unknown" ? "unknown" : "physically_confirmed");
      expect(isConfirmedEvidence(state)).toBe(state === "physically_counted" || state === "commissioned");
    }
    const updated = nativeItemFromApi({ id: "native-item", name: "Updated", kind: "tool", quantity: 5, unit: "metre", description: "desc", sku: "sku", location: "bin", condition: "worn", dimensions: { lengthMm: 4, measured: false }, tags: ["tag"], links: [], evidence: { state: "physically_counted" } }, "native-item", "2026-01-04T00:00:00.000Z", { ...nativeItem, source: { existing: true } });
    expect(updated).toMatchObject({ id: "native-item", name: "Updated", category: "tool", createdAt: nativeItem.createdAt, source: { existing: true, benchLedger: { kind: "tool", sku: "sku" } } });
  });

  it("uses fallback evidence and metadata when projecting native inventory", () => {
    const sourceStatuses = ["commissioned_available", "physically_confirmed", "delivered_uncounted", "shipped_available_baseline", "ordered_unverified", "other"] as const;
    const expected = ["commissioned", "physically_counted", "delivered_uncounted", "delivered_uncounted", "ordered_unverified", "unknown"] as const;
    for (const [index, sourceStatus] of sourceStatuses.entries()) {
      const { dimensions: _dimensions, notes: _notes, ...itemWithoutOptionalFields } = nativeItem;
      const item = { ...itemWithoutOptionalFields, id: `fallback-${index}`, category: index === 0 ? "printer" : index === 1 ? "tool" : index === 2 ? "filament" : index === 3 ? "electrical" : index === 4 ? "adhesive" : "other", sourceStatus, confidence: "unknown" as const, reportedQuantity: 7, purchasedQuantity: 11 };
      const projected = apiInventoryFromNative(item, { onHand: 3, available: 2 }, 4);
      expect(projected.evidence.state).toBe(expected[index]);
      expect(projected.quantity).toBe(sourceStatus === "commissioned_available" || sourceStatus === "physically_confirmed" ? 3 : 7);
      expect(projected.availableQuantity).toBe(sourceStatus === "commissioned_available" || sourceStatus === "physically_confirmed" ? 2 : 0);
      expect(projected.allocatedQuantity).toBe(sourceStatus === "commissioned_available" || sourceStatus === "physically_confirmed" ? 1 : 0);
    }
    const projected = apiInventoryFromNative({ ...nativeItem, source: { benchLedger: { kind: "filament", description: "metadata description", sku: "S", location: "L", condition: "new", tags: ["petg"], links: [], evidence: { state: "commissioned" } } } }, { onHand: 8, available: 6 }, 2);
    expect(projected).toMatchObject({ kind: "filament", description: "metadata description", sku: "S", location: "L", condition: "new", tags: ["petg"], quantity: 8, availableQuantity: 6, allocatedQuantity: 2, unit: "metre", dimensions: { lengthMm: 200 } });
  });
});

describe("stock/project/procurement mapper edges", () => {
  it("maps every stock event type, source, and visible evidence shape", () => {
    const types = ["receipt", "count", "correction", "allocate", "release", "consume", "return", "loss", "dispose"] as const;
    const nativeKinds = ["receipt", "count", "adjustment", "allocate", "release", "consume", "return", "loss", "loss"] as const;
    for (const [index, type] of types.entries()) {
      const input: StockEventInput = { itemId: "stock-item", type, quantity: type === "count" ? 3 : 1, unit: "each", note: index % 2 === 0 ? `note-${index}` : undefined, projectId: index === 0 ? "project" : undefined, correlationId: index === 1 ? "input-correlation" : undefined, idempotencyKey: index === 2 ? "idempotency-key" : undefined };
      const native = nativeStockEventFromApi(input, context(index % 3 === 0 ? "mcp" : index % 3 === 1 ? "import" : "system"), "piece", index + 1);
      expect(native.kind).toBe(nativeKinds[index]);
      expect(native.evidence?.apiItemVersion).toBe(index + 1);
      const publicEvent = apiStockEventFromNative(native, 1);
      expect(publicEvent.type).toBe(type === "dispose" ? "loss" : type);
      expect(publicEvent.itemVersion).toBe(index + 1);
      expect(publicEvent.source).toBe(native.source === "mcp" || native.source === "import" ? native.source : "api");
    }
    const hidden = apiStockEventFromNative({ id: "event-hidden", itemId: "stock-item", kind: "evidence", semantics: "informational", quantity: 0, unit: "piece", reason: "evidence", evidence: { apiItemVersion: 2, bootstrap: true }, occurredAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }, 1);
    expect(hidden).not.toHaveProperty("evidence");
    expect(apiStockEventFromNative({ id: "event-default", itemId: "stock-item", kind: "receipt", semantics: "delta", quantity: 1, unit: "piece", reason: "receipt", occurredAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }, 5)).toMatchObject({ actor: "system", source: "api", itemVersion: 5 });
  });

  it("projects project graph values, constraints, reservations, and offers", () => {
    expect(["idea", "planning", "in_progress", "validation", "complete", "retired"].map((status) => nativeProjectStatus(status as never))).toEqual(["active", "active", "active", "active", "complete", "retired"]);
    const project: Project = { id: "project", name: "Project", slug: "project", status: "active", visibility: "private", description: "desc", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" };
    expect(apiProjectFromNative(project, 2, {}, undefined)).toMatchObject({ id: "project", status: "in_progress", version: 2 });
    expect(apiProjectFromNative(project, 2, { status: "idea" }, "revision")).toMatchObject({ status: "idea", currentRevisionId: "revision" });
    expect(apiProjectFromNative({ ...project, status: "complete" }, 2, { status: "invalid" }, undefined).status).toBe("complete");
    const work: WorkItem = { id: "work", projectId: "project", name: "Work", kind: "part", createdAt: project.createdAt, updatedAt: project.updatedAt };
    expect(apiWorkItemFromNative(work, 1, undefined)).not.toHaveProperty("currentRevisionId");
    expect(apiWorkItemFromNative({ ...work, description: "desc" }, 2, "work-revision")).toMatchObject({ description: "desc", currentRevisionId: "work-revision" });
    const revision: ProjectRevision = { id: "revision", projectId: "project", number: 1, label: "r01", status: "concept", notes: "notes", createdAt: project.createdAt };
    expect(apiProjectRevisionFromNative(revision, 3)).toMatchObject({ name: "r01", notes: "notes", version: 3 });
    const workRevision: WorkItemRevision = { id: "work-revision", workItemId: "work", number: 1, label: "r01", status: "CAD complete", sourcePath: "cad/source.step", createdAt: project.createdAt };
    expect(apiWorkItemRevisionFromNative(workRevision, project.id, 2)).toMatchObject({ projectId: project.id, notes: "cad/source.step" });
    const line: BomLine = { id: "bom", revisionId: revision.id, name: "Board", quantity: 2, unit: "piece", required: true, alternativeItemIds: ["alt"] };
    expect(apiBomLineFromNative(line, {}, 1)).toMatchObject({ optional: false, alternatives: [{ itemId: "alt", compatible: "conditional" }], createdAt: "1970-01-01T00:00:00.000Z" });
    expect(apiBomLineFromNative({ ...line, optional: true, required: false, notes: "note" }, { constraints: { kind: "electronic" }, alternatives: [{ itemId: "alt", compatible: "confirmed", reason: "pinout" }], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", retired: true }, 2)).toMatchObject({ optional: true, notes: "note", constraints: { kind: "electronic" }, alternatives: [{ compatible: "confirmed" }], updatedAt: "2026-01-02T00:00:00.000Z" });
    expect(nativeConstraintsFromApi({ kind: "electronic", manufacturer: "Maker", model: "ESP", variantIncludes: "Rev", machineId: "H2D", tag: "board", unknown: "ignored" })).toEqual({ category: "electronics", manufacturer: "Maker", model: "ESP", variantIncludes: "Rev", machineId: "H2D", tags: ["board"] });
    const reservation: Reservation = { id: "reservation", projectRevisionId: "revision", bomLineId: "bom", itemId: "item", quantity: 1, status: "released", createdAt: project.createdAt, releasedAt: project.updatedAt };
    expect(apiReservationFromNative(reservation, 2)).toMatchObject({ lineId: "bom", updatedAt: project.updatedAt, version: 2 });
    const supplier: Supplier = { id: "supplier", name: "Supplier", website: "https://supplier.example", createdAt: project.createdAt };
    const offer: OfferSnapshot = { id: "offer", itemId: "item", supplierId: supplier.id, url: "https://supplier.example/item", title: "Board offer", packageQuantity: 2, packageUnit: "piece", priceMinor: 1000, currency: "EUR", observedAt: project.updatedAt, notes: "offer notes" };
    expect(apiOfferFromNative(offer, supplier, {}, 1)).toMatchObject({ name: "Board offer", supplier: "Supplier", staleAfterDays: 30, notes: "offer notes" });
    const { title: _title, ...offerWithoutTitle } = offer;
    expect(apiOfferFromNative(offerWithoutTitle, undefined, { name: "Custom", supplier: "Custom supplier", shippingMinor: 200, staleAfterDays: 7 }, 2)).toMatchObject({ name: "Custom", supplier: "Custom supplier", shippingMinor: 200, staleAfterDays: 7 });
  });
});

describe("artifact mapper edges", () => {
  it("normalizes artifact roles/media and upload status safely", () => {
    const base: ArtifactRevision = { version: 1, artifactId: "artifact", artifactRevisionId: "artifact-revision", projectId: "project", filename: "part.step", mediaType: undefined, role: "step", description: "desc", source: "upload", bytes: 10, sha256: "a".repeat(64), storageKey: "sha256/aa/file", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(apiArtifactFromStore(base, { author: "Dan", machineBinding: { printer: "H2D" } }, 2)).toMatchObject({ id: "artifact", mediaType: "application/octet-stream", role: "step", author: "Dan", machineBinding: { printer: "H2D" }, currentCandidate: true, retired: false });
    expect(apiArtifactFromStore({ ...base, role: "unknown-role" }, { retired: true }, 3, true)).toMatchObject({ role: "other", retired: true, currentCandidate: false });
    const statuses = ["open", "finalized", "expired", "aborted"] as const;
    for (const status of statuses) {
      expect(apiUploadSessionFromStore({ sessionId: `session-${status}`, status, projectId: "project", filename: "part.step", artifactId: "artifact", artifactRevisionId: "artifact-revision", bytesWritten: 0, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, 100)).toMatchObject({ status: status === "finalized" ? "finalized" : status === "open" ? "pending" : "expired", maxBytes: 100 });
    }
  });
});
