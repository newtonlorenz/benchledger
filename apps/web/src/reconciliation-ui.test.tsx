import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ReconciliationUI,
  reconciliationCanCommit,
  reconciliationCanRequestPreview,
  reconciliationCommitErrorMessage,
  summarizeReconciliationLine
} from "./reconciliation-ui";
import type { ReconciliationViewModel } from "./reconciliation-ui";

describe("finish build flow", () => {
  it("moves from explicit line review to server preview and confirmation while keeping expert trace behind disclosure", () => {
    const initial: ReconciliationViewModel = {
      projectId: "project-lamp",
      projectName: "Bench lamp",
      projectRevisionId: "revision-2",
      status: "draft",
      lines: [
        { id: "line-filament", bomLineId: "bom-filament", name: "PETG for shade", itemLabel: "Bambu Lab PETG HF · black", itemKind: "filament", plannedQuantity: 3, plannedUnit: "gram", reservedQuantity: 3, unit: "gram", outcomes: [] },
        { id: "line-screws", bomLineId: "bom-screws", name: "M3 screws", itemLabel: "M3 × 8 mm", itemKind: "fastener", plannedQuantity: 0, plannedUnit: "each", reservedQuantity: 0, unit: "each", outcomes: [] }
      ]
    };
    const render = (model: ReconciliationViewModel, options: { expert?: boolean; confirmationOpen?: boolean } = {}) => renderToStaticMarkup(
      <ReconciliationUI
        model={model}
        expert={options.expert ?? false}
        confirmationOpen={options.confirmationOpen ?? false}
        onChange={() => undefined}
        onRequestPreview={() => undefined}
        onConfirmCommit={() => undefined}
      />
    );

    const reviewMarkup = render(initial);
    expect(reviewMarkup).toContain("Update used stock for Bench lamp");
    expect(reviewMarkup).toContain("No result recorded yet");
    expect(reviewMarkup).toContain("Choose what happened");
    expect(reviewMarkup).toContain("Stock set aside for this build needs a result.");
    expect(reviewMarkup).toContain("Still to record");
    expect(reviewMarkup).toContain("Review stock changes");
    expect(reviewMarkup).toContain("Still to record: add each selected item");
    expect(reviewMarkup).not.toContain("An untouched reservation still needs");
    expect(reviewMarkup).toContain("disabled=\"\">Apply stock changes");
    const beginnerText = reviewMarkup.replace(/<[^>]*>/gu, " ");
    expect(beginnerText).not.toMatch(/reconcil|reservation|commit|replay|settlement|basis hash|BOM line|source ID|evidence state|audit ID/iu);

    const reviewed: ReconciliationViewModel = {
      ...initial,
      lines: [
        {
          ...initial.lines[0]!,
          outcomes: [
            { id: "outcome-used", kind: "consumed", quantity: 2, unit: "gram", evidence: { state: "consumed", source: "Build notes" } },
            { id: "outcome-returned", kind: "returned", quantity: 1, unit: "gram", evidence: { state: "physically_counted", source: "Bench count" } }
          ]
        },
        {
          ...initial.lines[1]!,
          outcomes: [{ id: "outcome-unchanged", kind: "reviewed_no_change", quantity: 0, unit: "each", evidence: { state: "physically_counted", note: "No screws were used." } }]
        }
      ]
    };
    expect(summarizeReconciliationLine(reviewed.lines[0]!).complete).toBe(true);
    expect(summarizeReconciliationLine(reviewed.lines[1]!).complete).toBe(true);

    const previewed: ReconciliationViewModel = {
      ...reviewed,
      trace: { draftId: "draft-1", draftVersion: 2, basisHash: "a".repeat(64), auditId: "audit-pending", replayed: true },
      preview: {
        basisHash: "a".repeat(64),
        generatedAt: "2026-08-30T10:00:00.000Z",
        lines: [
          { bomLineId: "bom-filament", reservedQuantity: 3, accountedQuantity: 3, unaccountedQuantity: 0, outcomeCount: 2, unit: "gram" },
          { bomLineId: "bom-screws", reservedQuantity: 0, accountedQuantity: 0, unaccountedQuantity: 0, outcomeCount: 1, unit: "each" }
        ],
        reservationChanges: [{ reservationId: "reservation-filament", fromStatus: "active", toStatus: "settled", quantity: 3, unit: "gram" }],
        stockChanges: [{ itemId: "filament-black", itemLabel: "PETG HF black", kind: "consume", quantity: 2, unit: "gram", beforeAvailable: 998, afterAvailable: 996, eventKey: "reconcile-event-filament" }],
        createdAssets: []
      }
    };
    expect(reconciliationCanCommit(previewed)).toBe(true);

    const beginnerConfirmationMarkup = render(previewed, { confirmationOpen: true });
    expect(beginnerConfirmationMarkup).toContain("Review stock changes");
    expect(beginnerConfirmationMarkup).toContain("Apply these changes?");
    expect(beginnerConfirmationMarkup).toContain("Apply stock changes");
    expect(beginnerConfirmationMarkup).toContain("2 requirements reviewed");
    expect(beginnerConfirmationMarkup).toContain("The project status does not change.");
    expect(beginnerConfirmationMarkup).not.toContain("BOM line");
    expect(beginnerConfirmationMarkup).not.toContain("Basis hash");
    expect(beginnerConfirmationMarkup).not.toContain("Reservation settlement");
    expect(beginnerConfirmationMarkup).not.toContain("reconcile-event-filament");
    expect(beginnerConfirmationMarkup).not.toContain("Source ID");

    const expertConfirmationMarkup = render(previewed, { expert: true, confirmationOpen: true });
    expect(expertConfirmationMarkup).toContain("BOM line");
    expect(expertConfirmationMarkup).toContain("Basis hash");
    expect(expertConfirmationMarkup).toContain("reconcile-event-filament");
    expect(expertConfirmationMarkup).toContain("Replayed idempotently");
    expect(expertConfirmationMarkup).toContain("Source ID");
  });

  it("keeps planned BOM units separate from set-valued reservations and outcomes", () => {
    const model: ReconciliationViewModel = {
      projectId: "project-leds",
      projectName: "LED pack",
      projectRevisionId: "revision-leds",
      status: "draft",
      lines: [{
        id: "line-leds",
        bomLineId: "bom-leds",
        name: "LEDs",
        itemLabel: "LED sets",
        plannedQuantity: 10,
        plannedUnit: "each",
        reservedQuantity: 1,
        unit: "set",
        reservations: [{ id: "reservation-leds", itemId: "led-sets", quantity: 1, unit: "set", status: "active", version: 2 }],
        outcomes: [{ id: "outcome-leds", reservationId: "reservation-leds", itemId: "led-sets", kind: "consumed", quantity: 1, unit: "set", evidence: { state: "physically_counted" } }]
      }]
    };
    const markup = renderToStaticMarkup(<ReconciliationUI model={model} expert={false} confirmationOpen={false} onChange={() => undefined} onRequestPreview={() => undefined} onConfirmCommit={() => undefined} />);
    expect(markup).toContain("10 each");
    expect(markup).toContain("1 set");
    expect(markup).not.toContain("10 set");
    expect(summarizeReconciliationLine(model.lines[0]!).complete).toBe(true);
  });

  it("keeps unreserved requirements out of the default queue while offering optional context", () => {
    const model: ReconciliationViewModel = {
      projectId: "project-focused",
      projectName: "Focused close-out",
      projectRevisionId: "revision-focused",
      status: "draft",
      lines: [{
        id: "line-reserved",
        bomLineId: "bom-reserved",
        name: "Reserved component",
        itemLabel: "Component",
        plannedQuantity: 1,
        plannedUnit: "each",
        reservedQuantity: 1,
        unit: "each",
        reservations: [{ id: "reservation-1", itemId: "item-1", quantity: 1, unit: "each", status: "active" }],
        outcomes: []
      }],
      availableLines: [{
        id: "line-unreserved",
        bomLineId: "bom-unreserved",
        name: "Optional context component",
        itemLabel: "Unreserved component",
        plannedQuantity: 1,
        plannedUnit: "each",
        reservedQuantity: 0,
        unit: "each",
        outcomes: []
      }]
    };
    const markup = renderToStaticMarkup(<ReconciliationUI model={model} confirmationOpen={false} onChange={() => undefined} onRequestPreview={() => undefined} onConfirmCommit={() => undefined} />);
    expect(markup).toContain("Show all requirements");
    expect(markup).toContain("Review selected items; other requirements need no update.");
    expect(markup).not.toContain("Optional context component");
  });

  it("uses uncertainty-safe beginner wording when applying stock changes is not confirmed", () => {
    const message = reconciliationCommitErrorMessage(false, new TypeError("response lost after commit"));
    expect(message).toBe("The stock update was not confirmed. Try again. BenchLedger will check the saved result before it applies anything twice.");
    expect(message).not.toContain("Nothing was changed");
    expect(reconciliationCommitErrorMessage(true, new Error("server trace"))).toBe("server trace");
  });

  it("allows an empty reservation queue to request a preview and commit without inventing review work", () => {
    const model: ReconciliationViewModel = {
      projectId: "project-empty-close-out",
      projectName: "Empty close-out",
      projectRevisionId: "revision-empty-close-out",
      status: "draft",
      lines: [],
      availableLines: [{
        id: "line-unreserved",
        bomLineId: "bom-unreserved",
        name: "Unreserved component",
        itemLabel: "Component",
        plannedQuantity: 1,
        plannedUnit: "each",
        reservedQuantity: 0,
        unit: "each",
        outcomes: []
      }]
    };
    expect(reconciliationCanRequestPreview(model)).toBe(true);
    expect(reconciliationCanCommit(model)).toBe(false);

    const previewed: ReconciliationViewModel = {
      ...model,
      preview: { lines: [], reservationChanges: [], stockChanges: [], createdAssets: [] }
    };
    expect(reconciliationCanCommit(previewed)).toBe(true);

    const pendingMarkup = renderToStaticMarkup(<ReconciliationUI model={model} confirmationOpen={false} onChange={() => undefined} onRequestPreview={() => undefined} onConfirmCommit={() => undefined} />);
    expect(pendingMarkup).toContain("Review changes");
    expect(pendingMarkup).toContain("No selected stock needs an update. Request a review");
    expect(pendingMarkup).toContain("disabled=\"\">Apply stock changes");

    const readyMarkup = renderToStaticMarkup(<ReconciliationUI model={previewed} confirmationOpen onChange={() => undefined} onRequestPreview={() => undefined} onConfirmCommit={() => undefined} />);
    expect(readyMarkup).toContain("Ready to update stock");
    expect(readyMarkup).toContain("No requirements reviewed");
    expect(readyMarkup).toContain("Apply these changes?");
    expect(readyMarkup).toContain("Apply stock changes");
    expect(readyMarkup).not.toContain("disabled=\"\">Apply stock changes");
  });

  it("keeps an incomplete active reservation blocked from preview and commit", () => {
    const model: ReconciliationViewModel = {
      projectId: "project-active-blocked",
      projectName: "Active reservation",
      projectRevisionId: "revision-active-blocked",
      status: "draft",
      lines: [{
        id: "line-active",
        bomLineId: "bom-active",
        name: "Reserved component",
        itemLabel: "Component",
        plannedQuantity: 1,
        plannedUnit: "each",
        reservedQuantity: 1,
        unit: "each",
        reservations: [{ id: "reservation-active", itemId: "item-1", quantity: 1, unit: "each", status: "active" }],
        outcomes: []
      }],
      preview: { lines: [], reservationChanges: [], stockChanges: [], createdAssets: [] }
    };
    expect(reconciliationCanRequestPreview(model)).toBe(false);
    expect(reconciliationCanCommit(model)).toBe(false);
  });

  it("explains an over-recorded result without internal accounting terms", () => {
    const model: ReconciliationViewModel = {
      projectId: "project-overage",
      projectName: "Overage check",
      projectRevisionId: "revision-overage",
      status: "draft",
      lines: [{
        id: "line-overage",
        bomLineId: "bom-overage",
        name: "Filament",
        itemLabel: "PETG spool",
        plannedQuantity: 2,
        plannedUnit: "gram",
        reservedQuantity: 2,
        unit: "gram",
        outcomes: [{ id: "result-overage", kind: "consumed", quantity: 3, unit: "gram", evidence: { state: "consumed" } }],
      }],
    };
    const markup = renderToStaticMarkup(<ReconciliationUI model={model} onChange={() => undefined} onRequestPreview={() => undefined} onConfirmCommit={() => undefined} />);
    expect(markup).toContain("The recorded total is greater than the amount set aside. Reduce a result quantity before you review the changes.");
    expect(markup).not.toContain("over-accounted");
  });
});
