import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddBomDialog, BomLineRow, inventoryCandidateLabel, inventoryDiscriminator } from "./App";
import { mapBomLine } from "./api";
import type { BomLineStatus, InventoryItem } from "./domain";
import { inventory, projects } from "./mock-data";

describe("BOM line version and expert context", () => {
  it("keeps beginner requirement entry focused on the need and use", () => {
    const project = projects[0]!;
    const markup = renderToStaticMarkup(<AddBomDialog items={inventory} project={project} expert={false} onClose={() => undefined} onCreate={async () => true} />);

    expect(markup).toContain("Add a part, material, or tool");
    expect(markup).toContain("What do you need?");
    expect(markup).toContain("How will you use it?");
    expect(markup).toContain('value="consumed"');
    expect(markup).toContain("Part or material (used up or built in)");
    expect(markup).toContain('value="reusable"');
    expect(markup).toContain("Reusable tool or equipment");
    expect(markup).not.toContain("Search matching inventory");
    expect(markup).not.toContain(project.currentRevision);
    expect(markup).not.toContain(project.serverRevisionId!);
  });

  it("keeps manual matching and revision identifiers in expert requirement entry", () => {
    const project = projects[0]!;
    const markup = renderToStaticMarkup(<AddBomDialog items={inventory} project={project} expert onClose={() => undefined} onCreate={async () => true} />);

    expect(markup).toContain(`Add a requirement to ${project.currentRevision}`);
    expect(markup).toContain("Search matching inventory");
    expect(markup).toContain(project.currentRevision);
    expect(markup).toContain(project.serverRevisionId!);
    expect(markup).not.toContain('value="printer"');
  });

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
      version: 42,
    });

    expect(line).toMatchObject({
      id: "bom-line-42",
      version: 42,
      unit: "g",
      serverUnit: "gram",
    });
  });

  it("preserves consumed, reusable, and legacy-null requirement roles from the service", () => {
    const base = {
      id: "bom-role",
      revisionId: "revision-7",
      name: "Role-aware requirement",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      constraints: {},
      alternatives: [],
      createdAt: "2026-09-02T10:00:00.000Z",
      updatedAt: "2026-09-02T10:00:00.000Z",
      version: 1,
    };
    expect(mapBomLine({ ...base, role: "consumed" }).role).toBe("consumed");
    expect(mapBomLine({ ...base, role: "reusable" }).role).toBe("reusable");
    expect(mapBomLine({ ...base, role: null }).role).toBeNull();
  });

  it("keeps line identity, version, and canonical unit inside the expert-only disclosure", () => {
    const status: BomLineStatus = {
      line: {
        id: "bom-line-42",
        version: 7,
        label: "PETG",
        required: 400,
        unit: "g",
        serverUnit: "gram",
      },
      supplied: 0,
      remaining: 400,
      state: "missing",
      decision: "source",
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

  it("marks a legacy null role for review without calling it consumable", () => {
    const status: BomLineStatus = {
      line: {
        id: "legacy-role-line",
        version: 1,
        label: "Legacy part",
        role: null,
        required: 1,
        unit: "each",
      },
      supplied: 0,
      remaining: 1,
      state: "missing",
      decision: "source",
    };

    const beginnerMarkup = renderToStaticMarkup(<BomLineRow line={status} expert={false} onOpenItem={() => undefined} onResolveRole={() => undefined} />);
    const expertMarkup = renderToStaticMarkup(<BomLineRow line={status} expert onOpenItem={() => undefined} onResolveRole={() => undefined} />);
    expect(beginnerMarkup).not.toContain("Review use");
    expect(beginnerMarkup).not.toContain("Use is not recorded");
    expect(beginnerMarkup).not.toContain("consumable");
    expect(beginnerMarkup).toContain("How will you use this?");
    expect(beginnerMarkup).toContain("Part or material");
    expect(beginnerMarkup).toContain("Reusable tool");
    expect(expertMarkup).toContain("Requirement use");
    expect(expertMarkup).toContain("Not recorded");
    expect(expertMarkup).toContain("not treated as consumable");
    expect(expertMarkup).toContain("How will you use this?");
    expect(expertMarkup).toContain("Part or material");
    expect(expertMarkup).toContain("Reusable tool");

    const resolvedMarkup = renderToStaticMarkup(<BomLineRow line={{ ...status, line: { ...status.line, role: "consumed" } }} expert={false} onOpenItem={() => undefined} onResolveRole={() => undefined} />);
    expect(resolvedMarkup).not.toContain("How will you use this?");
  });

  it("shows an explicit correction blocker only for semantic inventory unit errors", () => {
    const item = {
      id: "legacy-tool",
      name: "Legacy caliper",
      kind: "tool",
      category: "Tools",
      variant: "tool",
      description: "Imported row",
      quantity: 1,
      unit: "m",
      reserved: 0,
      state: "available",
      evidence: "counted",
      location: "Bench drawer",
      tags: [],
      compatibility: [],
      accent: "slate",
      unitStatus: "needs_correction",
      unitCorrectionReason: "tool items use each; this record uses metre.",
    } satisfies InventoryItem;
    const status: BomLineStatus = {
      line: {
        id: "legacy-line",
        version: 2,
        label: "Legacy caliper",
        itemId: item.id,
        required: 1,
        unit: "m",
      },
      item,
      items: [item],
      supplied: 0,
      remaining: 1,
      state: "inspect-first",
      decision: "check",
    };

    const beginnerMarkup = renderToStaticMarkup(<BomLineRow line={status} expert={false} onOpenItem={() => undefined} />);
    const expertMarkup = renderToStaticMarkup(<BomLineRow line={status} expert onOpenItem={() => undefined} />);
    expect(beginnerMarkup).toContain("Fix unit");
    expect(beginnerMarkup).not.toContain("tool items use each");
    expect(beginnerMarkup).toContain("No safe match");
    expect(expertMarkup).toContain("tool items use each");
  });

  it("uses human evidence to distinguish duplicate physical items", () => {
    const base = {
      id: "spool-a",
      name: "PLA Basic",
      kind: "filament",
      category: "Filament",
      variant: "filament",
      description: "Spool",
      quantity: 1000,
      unit: "g",
      reserved: 0,
      state: "available",
      evidence: "counted",
      location: "Shelf A",
      tags: [],
      compatibility: [],
      accent: "orange",
    } satisfies InventoryItem;
    const blue = {
      ...base,
      catalogProduct: {
        id: "pla-blue",
        kind: "filament" as const,
        manufacturer: "Maker",
        colourName: "Blue",
      },
    };
    const red = {
      ...base,
      id: "spool-b",
      location: "Shelf B",
      catalogProduct: {
        id: "pla-red",
        kind: "filament" as const,
        manufacturer: "Maker",
        colourName: "Red",
      },
    };
    expect(inventoryDiscriminator(blue)).toBe("Blue · Shelf A");
    expect(inventoryDiscriminator(red)).toBe("Red · Shelf B");
    expect(inventoryDiscriminator({ ...base, location: "Unassigned" })).toBe("Physical item");
    expect(inventoryCandidateLabel(blue, [blue])).toEqual({
      name: "PLA Basic",
    });
    expect(inventoryCandidateLabel(blue, [blue, red])).toEqual({
      name: "PLA Basic",
      discriminator: "Blue · Shelf A",
    });
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
    expect(
      inventoryDiscriminator({
        ...sameA,
        location: "Unassigned",
        variant: "PETG Basic",
      }),
    ).toBe("Physical item");
  });
});
