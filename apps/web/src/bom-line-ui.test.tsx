import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BomLineRow, inventoryCandidateLabel, inventoryDiscriminator } from "./App";
import { mapBomLine } from "./api";
import type { BomLineStatus, InventoryItem } from "./domain";

describe("BOM line version and expert context", () => {
  it("maps the server BOM line version exactly and retains the canonical unit", () => {
    const line = mapBomLine({
      id: "bom-line-42",
      revisionId: "revision-7",
      name: "PETG",
      requiredQuantity: 400,
      unit: "gram",
      optional: false,
      constraints: {},
      alternatives: [],
      createdAt: "2026-09-02T10:00:00.000Z",
      updatedAt: "2026-09-02T10:00:00.000Z",
      version: 42
    });

    expect(line).toMatchObject({ id: "bom-line-42", version: 42, unit: "g", serverUnit: "gram" });
  });

  it("keeps line identity, version, and canonical unit inside the expert-only disclosure", () => {
    const status: BomLineStatus = {
      line: { id: "bom-line-42", version: 7, label: "PETG", required: 400, unit: "g", serverUnit: "gram" },
      supplied: 0,
      remaining: 400,
      state: "missing",
      decision: "source"
    };
    const props = { line: status, onOpenItem: () => undefined };

    const expertMarkup = renderToStaticMarkup(<BomLineRow {...props} expert />);
    expect(expertMarkup).toContain("<span>Line ID</span><p>bom-line-42</p>");
    expect(expertMarkup).toContain("<span>Line version</span><p>7</p>");
    expect(expertMarkup).toContain("<span>Canonical unit</span><p>gram</p>");

    const beginnerMarkup = renderToStaticMarkup(<BomLineRow {...props} expert={false} />);
    expect(beginnerMarkup).not.toContain("bom-expert");
    expect(beginnerMarkup).not.toContain("Line ID");
    expect(beginnerMarkup).not.toContain("Line version");
    expect(beginnerMarkup).not.toContain("Canonical unit");
  });

  it("shows an explicit correction blocker only for semantic inventory unit errors", () => {
    const item = {
      id: "legacy-tool", name: "Legacy caliper", kind: "tool", category: "Tools", variant: "tool", description: "Imported row",
      quantity: 1, unit: "m", reserved: 0, state: "available", evidence: "counted", location: "Bench drawer",
      tags: [], compatibility: [], accent: "slate", unitStatus: "needs_correction", unitCorrectionReason: "tool items use each; this record uses metre."
    } satisfies InventoryItem;
    const status: BomLineStatus = {
      line: { id: "legacy-line", version: 2, label: "Legacy caliper", itemId: item.id, required: 1, unit: "m" },
      item, items: [item], supplied: 0, remaining: 1, state: "inspect-first", decision: "check"
    };

    const markup = renderToStaticMarkup(<BomLineRow line={status} expert={false} onOpenItem={() => undefined} />);
    expect(markup).toContain("Unit needs correction");
    expect(markup).toContain("tool items use each");
    expect(markup).toContain("No safe match");
  });

  it("uses human evidence to distinguish duplicate physical items", () => {
    const base = {
      id: "spool-a", name: "PLA Basic", kind: "filament", category: "Filament", variant: "filament", description: "Spool",
      quantity: 1000, unit: "g", reserved: 0, state: "available", evidence: "counted", location: "Shelf A",
      tags: [], compatibility: [], accent: "orange"
    } satisfies InventoryItem;
    const blue = { ...base, catalogProduct: { id: "pla-blue", kind: "filament" as const, manufacturer: "Maker", colourName: "Blue" } };
    const red = { ...base, id: "spool-b", location: "Shelf B", catalogProduct: { id: "pla-red", kind: "filament" as const, manufacturer: "Maker", colourName: "Red" } };
    expect(inventoryDiscriminator(blue)).toBe("Blue · Shelf A");
    expect(inventoryDiscriminator(red)).toBe("Red · Shelf B");
    expect(inventoryDiscriminator({ ...base, location: "Unassigned" })).toBe("Physical item");
    expect(inventoryCandidateLabel(blue, [blue])).toEqual({ name: "PLA Basic" });
    expect(inventoryCandidateLabel(blue, [blue, red])).toEqual({ name: "PLA Basic", discriminator: "Blue · Shelf A" });
    const anonymousA = { ...base, location: "Unassigned" };
    const anonymousB = { ...anonymousA, id: "spool-b" };
    expect(inventoryCandidateLabel(anonymousA, [anonymousA, anonymousB])).toEqual({ name: "PLA Basic", discriminator: "Physical item 1 of 2" });
    expect(inventoryCandidateLabel(anonymousB, [anonymousA, anonymousB])).toEqual({ name: "PLA Basic", discriminator: "Physical item 2 of 2" });
    const sameA = { ...base, id: "petg-a", name: "PETG Basic" };
    const sameB = { ...sameA, id: "petg-b" };
    const sameC = { ...sameA, id: "petg-c" };
    const labels = [sameA, sameB, sameC].map((item) => inventoryCandidateLabel(item, [sameA, sameB, sameC]).discriminator);
    expect(new Set(labels).size).toBe(3);
    expect(labels).toEqual(["Shelf A · Physical item 1 of 3", "Shelf A · Physical item 2 of 3", "Shelf A · Physical item 3 of 3"]);
    expect(inventoryDiscriminator({ ...sameA, location: "Unassigned", variant: "PETG Basic" })).toBe("Physical item");
  });
});
