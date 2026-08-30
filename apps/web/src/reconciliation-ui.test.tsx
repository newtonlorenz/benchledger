import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ReconciliationUI,
  reconciliationCanCommit,
  summarizeReconciliationLine
} from "./reconciliation-ui";
import type { ReconciliationViewModel } from "./reconciliation-ui";

describe("reconciliation close-out flow", () => {
  it("moves from explicit line review to server preview and confirmation while keeping expert trace behind disclosure", () => {
    const initial: ReconciliationViewModel = {
      projectId: "project-lamp",
      projectName: "Bench lamp",
      projectRevisionId: "revision-2",
      status: "draft",
      lines: [
        { id: "line-filament", bomLineId: "bom-filament", name: "PETG for shade", itemLabel: "Bambu Lab PETG HF · black", itemKind: "filament", plannedQuantity: 3, reservedQuantity: 3, unit: "gram", outcomes: [] },
        { id: "line-screws", bomLineId: "bom-screws", name: "M3 screws", itemLabel: "M3 × 8 mm", itemKind: "fastener", plannedQuantity: 0, reservedQuantity: 0, unit: "each", outcomes: [] }
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
    expect(reviewMarkup).toContain("No outcome selected yet");
    expect(reviewMarkup).toContain("Choose what happened");
    expect(reviewMarkup).toContain("Only a line with zero active reservations can use");
    expect(reviewMarkup).not.toContain("An untouched reservation still needs");
    expect(reviewMarkup).toContain("Finish every line, including evidence");
    expect(reviewMarkup).toContain("disabled=\"\">Confirm close-out");

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
    expect(beginnerConfirmationMarkup).toContain("Server preview");
    expect(beginnerConfirmationMarkup).toContain("Commit this close-out?");
    expect(beginnerConfirmationMarkup).toContain("Yes, commit close-out");
    expect(beginnerConfirmationMarkup).not.toContain("BOM line");

    const expertConfirmationMarkup = render(previewed, { expert: true, confirmationOpen: true });
    expect(expertConfirmationMarkup).toContain("BOM line");
    expect(expertConfirmationMarkup).toContain("Basis hash");
    expect(expertConfirmationMarkup).toContain("reconcile-event-filament");
    expect(expertConfirmationMarkup).toContain("Replayed idempotently");
    expect(expertConfirmationMarkup).toContain("Source ID");
  });
});
