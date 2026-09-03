import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InspectionQueuePanel, InspectionResultDialog, alternativeChanges, effectsLabel, formatObservedAt, formatQuantityConversion, gapQuantities, inspectionActionAccessibleNames, lineReferences, previewDescription } from "./inspection-ui";
import type { InspectionAction } from "./inspection-ui";

function action(index: number): InspectionAction {
  const lineId = `bom-line-${index}`;
  return {
    id: `inspection-${index}`,
    projectRevisionId: "revision-1",
    itemId: `item-${index}`,
    itemVersion: 4,
    kind: "physical_quantity",
    normalizedPredicate: '{"kind":"physical_quantity"}',
    question: `Count the candidate for requirement ${index}.`,
    itemUnit: "each",
    expectedUnit: "each",
    compatibility: "conditional",
    lineIds: [lineId],
    lineVersions: [{ lineId, version: 2 }],
    version: 4,
    candidate: {
      id: `item-${index}`,
      version: 4,
      name: `Candidate item ${index}`,
      unit: "each",
      evidence: { state: "delivered_uncounted", source: "supplier label" }
    },
    expected: { quantity: 2, unit: "each", lineIds: [lineId], lineRequirements: [{ lineId, quantity: 2, unit: "each" }] },
    possibleResults: ["confirmed", "inconclusive"],
    effects: [{ kind: "physical_quantity", description: "Updates physical quantity evidence." }],
    basis: { itemVersion: 4, lineVersions: [{ lineId, version: 2 }] },
    requiresHumanConfirmation: true
  };
}

describe("Project Plan Checks", () => {
  it("shows the next three concrete beginner questions and a view-all affordance", () => {
    const markup = renderToStaticMarkup(<InspectionQueuePanel actions={[1, 2, 3, 4].map(action)} />);

    expect(markup).toContain("Count the candidate for requirement 1.");
    expect(markup).toContain("Count the candidate for requirement 2.");
    expect(markup).toContain("Count the candidate for requirement 3.");
    expect(markup).not.toContain("Count the candidate for requirement 4.");
    expect(markup).toContain("Candidate item 1");
    expect(markup).toContain("1 affected BOM line");
    expect(markup).toContain("View all");
  });

  it("adds stable ordinals only when inspection names would otherwise collide", () => {
    const first = action(1);
    const duplicate = { ...action(4), question: first.question, candidate: { ...action(4).candidate, name: first.candidate.name } };
    expect(inspectionActionAccessibleNames([first, action(2), duplicate])).toEqual([
      `Check ${first.candidate.name}: ${first.question} (1 of 2)`,
      "Check Candidate item 2: Count the candidate for requirement 2.",
      `Check ${first.candidate.name}: ${first.question} (2 of 2)`
    ]);
  });

  it("keeps expert action, line, item, evidence, predicate, unit, and effects traceability", () => {
    const markup = renderToStaticMarkup(<InspectionQueuePanel actions={[action(1)]} expert />);

    expect(markup).toContain("Action ID");
    expect(markup).toContain("inspection-1");
    expect(markup).toContain("bom-line-1 · v2");
    expect(markup).toContain("item-1 · v4");
    expect(markup).toContain("delivered_uncounted · supplier label");
    expect(markup).toContain("{&quot;kind&quot;:&quot;physical_quantity&quot;}");
    expect(markup).toContain("each");
    expect(markup).toContain("Updates physical quantity evidence.");
  });

  it("renders the completion dialog in preview-first state", () => {
    const markup = renderToStaticMarkup(<InspectionResultDialog action={action(1)} expert={false} onClose={() => undefined} onPreviewInspection={async () => { throw new Error("not called during server render"); }} onConfirmInspection={async () => undefined} />);

    expect(markup).toContain("Preview changes");
    expect(markup).not.toContain("Server preview");
    expect(markup).not.toContain("Confirm result");
    expect(markup).not.toContain("Quick complete");
    expect(markup).toContain("How did you check?");
    expect(markup).toContain("Physical check");
    expect(markup).not.toContain("Source ID");

    const expertMarkup = renderToStaticMarkup(<InspectionResultDialog action={action(1)} expert onClose={() => undefined} />);
    expect(expertMarkup).toContain("Source ID");
  });

  it("offers explicit confirmed compatibility and conversion evidence fields without inferring either", () => {
    const base = action(1);
    const conversionAction: InspectionAction = {
      ...base,
      kind: "unit_conversion",
      itemUnit: "set",
      expectedUnit: "each",
      question: "Confirm the package conversion.",
      effects: [{ kind: "unit_conversion", description: "Records conversion evidence only." }],
    };
    const compatibilityAction: InspectionAction = {
      ...base,
      kind: "compatibility",
      question: "Confirm the candidate compatibility.",
      effects: [{ kind: "compatibility", description: "Records compatibility evidence only." }],
    };
    const conversionMarkup = renderToStaticMarkup(<InspectionResultDialog action={conversionAction} expert={false} onClose={() => undefined} onPreviewInspection={async () => { throw new Error("not called during server render"); }} onConfirmInspection={async () => undefined} />);
    const compatibilityMarkup = renderToStaticMarkup(<InspectionResultDialog action={compatibilityAction} expert={false} onClose={() => undefined} onPreviewInspection={async () => { throw new Error("not called during server render"); }} onConfirmInspection={async () => undefined} />);
    expect(conversionMarkup).toContain("Pieces per set");
    expect(conversionMarkup).toContain("Conversion evidence basis");
    expect(conversionMarkup).toContain("Confirmed");
    expect(compatibilityMarkup).toContain("Confirmed");
    expect(compatibilityMarkup).not.toContain("Observed quantity");
  });

  it("summarizes exact before/after alternative compatibility and conversion changes", () => {
    const before = [{ id: "line-1", alternatives: [{ itemId: "item-1", compatible: "conditional", reason: "Needs a bench check" }] }] as never;
    const after = [{ id: "line-1", alternatives: [{ itemId: "item-1", compatible: "confirmed", reason: "Bench check passed", quantityConversion: { inventory: { quantity: 1, unit: "set" }, requirement: { quantity: 10, unit: "each" }, evidence: { basis: "package_label", source: "package label", sourceId: "pkg-10", observedAt: "2026-09-01T10:00:00.000Z" } } }] }] as never;

    expect(alternativeChanges(before, after)).toEqual(["line-1 · Alternative item-1: compatibility conditional → confirmed; conversion none → 1 set = 10 each (package_label · package label · pkg-10 · 2026-09-01T10:00:00.000Z); reason Needs a bench check → Bench check passed"]);
    expect(alternativeChanges(before, before)).toEqual([]);
  });

  it("handles added, removed, and provenance-light alternatives in the preview diff", () => {
    const before = [
      { id: "line-before", alternatives: undefined },
      { id: "line-shared", alternatives: [{ itemId: "removed" }] },
    ] as never;
    const after = [
      { id: "line-after", alternatives: undefined },
      { id: "line-shared", alternatives: [{ itemId: "added", compatible: "confirmed" }, { itemId: "converted", compatible: "conditional", quantityConversion: { inventory: { quantity: 1, unit: "set" }, requirement: { quantity: 8, unit: "each" }, evidence: { basis: "physical_count" } } }] },
    ] as never;

    expect(alternativeChanges(before, after)).toEqual([
      "line-shared · Alternative added: compatibility not present → confirmed; conversion none → none; reason none → none",
      "line-shared · Alternative converted: compatibility not present → conditional; conversion none → 1 set = 8 each (physical_count); reason none → none",
      "line-shared · Alternative removed: compatibility not present → not present; conversion none → none; reason none → none",
    ]);
    expect(formatQuantityConversion(undefined)).toBe("none");
    expect(formatObservedAt(undefined)).toBeUndefined();
    expect(formatObservedAt("not-a-date")).toBe("not-a-date");
    expect(formatObservedAt("2026-09-01T10:00:00.000Z")).toBeTruthy();
    expect(effectsLabel(undefined as never)).toBe("Recheck affected project requirements.");
    expect(effectsLabel(action(1).effects)).toContain("physical quantity");
    expect(lineReferences({ ...action(1), lineVersions: [] })).toBe("None");
    expect(gapQuantities(undefined)).toBe("not evaluated");
    expect(gapQuantities({ suppliedQuantity: 1, inspectQuantity: 2, missingQuantity: 3, unit: "each" } as never)).toBe("1 supplied · 2 inspect · 3 missing each");
    expect(previewDescription({ affectedLines: [] } as never)).toContain("no affected BOM lines");
    expect(previewDescription({ affectedLines: [{ lineId: "a" }] } as never)).toContain("1 BOM line will");
    expect(previewDescription({ affectedLines: [{ lineId: "a" }, { lineId: "b" }] } as never)).toContain("2 BOM lines");
  });

  it("renders sparse expert traceability and load failures without private DOM helpers", () => {
    const sparse: InspectionAction = {
      ...action(5),
      lineIds: ["line-a", "line-b"],
      lineVersions: [],
      expected: { ...action(5).expected, lineIds: ["line-a", "line-b"] },
      effects: undefined as never,
      candidate: { ...action(5).candidate, evidence: { state: "physically_counted" } },
    };
    const expertMarkup = renderToStaticMarkup(<InspectionQueuePanel actions={[sparse]} expert />);
    const emptyMarkup = renderToStaticMarkup(<InspectionQueuePanel actions={[]} loadError="Checks unavailable" />);
    const dialogMarkup = renderToStaticMarkup(<InspectionResultDialog action={sparse} expert onClose={() => undefined} />);

    expect(expertMarkup).toContain("2 affected BOM lines");
    expect(expertMarkup).toContain("None");
    expect(expertMarkup).toContain("physically_counted");
    expect(expertMarkup).toContain("Recheck affected project requirements.");
    expect(emptyMarkup).toContain("The current project checks could not be loaded.");
    expect(emptyMarkup).toContain("Checks unavailable");
    expect(dialogMarkup).toContain("Technical traceability");
    expect(dialogMarkup).toContain("Recheck affected project requirements.");
  });
});
