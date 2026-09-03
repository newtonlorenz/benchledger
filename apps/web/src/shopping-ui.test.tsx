import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShoppingList, recordedOfferUrl, shoppingDraftText } from "./App";
import { projects } from "./mock-data";
import type { BomLineStatus, Offer, ProjectSummary } from "./domain";

function sourceSummary(overrides: Partial<BomLineStatus> = {}): ProjectSummary {
  const line: BomLineStatus = {
    line: { id: "source-line", version: 1, label: "M3 threaded inserts", required: 8, unit: "each" },
    supplied: 0,
    remaining: 8,
    state: "missing",
    decision: "source",
    ...overrides,
  };
  return {
    totalLines: 1,
    readyLines: 0,
    inspectLines: 0,
    missingLines: 1,
    optionalLines: 0,
    readyDecisionLines: 0,
    checkLines: 0,
    decideLines: 0,
    sourceLines: 1,
    partialLines: 0,
    readinessUnavailable: false,
    lineStatuses: [line],
  };
}

const offer: Offer = {
  id: "recorded-offer",
  itemId: "source-line",
  supplier: "Recorded supplier",
  title: "M3 insert pack",
  priceMinor: 499,
  currency: "EUR",
  pack: "8 pieces",
  eta: "2–4 days",
  url: "https://supplier.example/items/m3",
  observed: "3 Sep 2026",
};

describe("shopping proposal surface", () => {
  it("keeps an empty Source proposal out of the copied draft", () => {
    expect(shoppingDraftText([])).toBe("");
    expect(shoppingDraftText([])).not.toContain("Nothing is ready to source");
  });

  it("explains how to continue when a Source row has no recorded offer", () => {
    const markup = renderToStaticMarkup(
      <ShoppingList
        project={projects[0]!}
        summary={sourceSummary()}
        offers={[]}
        expert={false}
        onToast={() => undefined}
        onBackToPlan={() => undefined}
      />,
    );

    expect(markup).toContain("No supplier offer is recorded.");
    expect(markup).toContain("Copy the draft list and source this item outside BenchLedger.");
    expect(markup).toContain("Back to plan");
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain("Nothing is ready to source");
    expect(markup).not.toContain("<a ");
  });

  it("disables copying only when there are no Source rows to propose", () => {
    const summary: ProjectSummary = {
      ...sourceSummary(),
      totalLines: 0,
      missingLines: 0,
      sourceLines: 0,
      lineStatuses: [],
    };
    const markup = renderToStaticMarkup(
      <ShoppingList
        project={projects[0]!}
        summary={summary}
        offers={[]}
        expert={false}
        onToast={() => undefined}
        onBackToPlan={() => undefined}
      />,
    );

    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("Nothing is ready to source");
  });

  it("links only offers whose recorded URL is a valid HTTP(S) address", () => {
    expect(recordedOfferUrl(offer)).toBe(offer.url);
    expect(recordedOfferUrl({ url: "" })).toBeUndefined();
    expect(recordedOfferUrl({ url: "javascript:alert(1)" })).toBeUndefined();
    expect(recordedOfferUrl({ url: "not a URL" })).toBeUndefined();

    const unlinkedMarkup = renderToStaticMarkup(
      <ShoppingList
        project={projects[0]!}
        summary={sourceSummary()}
        offers={[{ ...offer, url: "" }]}
        expert={false}
        onToast={() => undefined}
        onBackToPlan={() => undefined}
      />,
    );
    expect(unlinkedMarkup).toContain("offer-row-unlinked");
    expect(unlinkedMarkup).not.toContain("<a ");

    const linkedMarkup = renderToStaticMarkup(
      <ShoppingList
        project={projects[0]!}
        summary={sourceSummary()}
        offers={[offer]}
        expert={false}
        onToast={() => undefined}
        onBackToPlan={() => undefined}
      />,
    );
    expect(linkedMarkup).toContain(`href="${offer.url}"`);
  });
});
