// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BomLine, RequirementOffer, RequirementOfferEstimate } from "@benchledger/api-contract";
import { RequirementSourcing } from "./requirement-sourcing";
import { workflowRequest } from "./api";
import { projects } from "./mock-data";

vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), workflowRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(workflowRequest).mockReset(); });
const project = { ...structuredClone(projects[0]!), serverRevisionId: "revision" };
const line: BomLine = { id: "line", revisionId: "revision", name: "Screws", requiredQuantity: 4, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [], version: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
const offer: RequirementOffer = { id: "quote", projectId: project.id, projectRevisionId: "revision", bomLineId: line.id, bomLineVersion: 1, supplier: "Synthetic supplier", title: "Pack of screws", url: "https://supplier.example/screws", packageQuantity: 4, packageUnit: "each", priceMinor: 250, currency: "EUR", taxIncluded: "unknown", observedAt: "2026-09-01T00:00:00.000Z", validForDays: 30, createdAt: "2026-09-01T00:00:00.000Z", recordedBy: "synthetic", version: 1 };
const result = (estimate: RequirementOfferEstimate, selected = true) => ({ data: [{ line, decision: "source", missingQuantity: 4, offers: [offer], choice: selected ? { offerId: offer.id, bomLineVersion: line.version, version: 1 } : null, estimate }], total: 1, revisionTotal: 1, totals: {}, notice: "" });

it.each([
  "The supplier observation is stale. Record a fresh quote.",
  "Package and requirement units differ. Record the correct package quantity and unit; no conversion is inferred."
])("explains the authoritative estimate rejection: %s", async (reason) => {
  vi.mocked(workflowRequest).mockResolvedValue(result({ status: "needs_review", reason, shippingKnown: false }));
  render(<RequirementSourcing project={project} />);
  await screen.findByText("Selected quote needs review");
  expect(screen.queryByText("Selected for estimate")).toBeNull();
  expect(screen.getByText(reason)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Record replacement quote" }));
  const supplier = screen.getByRole("textbox", { name: "Supplier" });
  expect(document.activeElement).toBe(supplier);
  expect(supplier.compareDocumentPosition(screen.getByText("Synthetic supplier: Pack of screws")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(vi.mocked(workflowRequest).mock.calls.every((call) => call[1] === undefined)).toBe(true);
});
it("keeps a confirmed current estimate distinct from a quote awaiting review", async () => {
  vi.mocked(workflowRequest).mockResolvedValue(result({ status: "estimated", packages: 1, partsSupplied: 4, priceMinor: 250, totalMinor: 250, currency: "EUR", shippingKnown: false, taxIncluded: "unknown" }));
  render(<RequirementSourcing project={project} />);
  expect(await screen.findByText("Selected for estimate")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Record replacement quote" })).toBeNull();
  expect(screen.getByRole("button", { name: "Clear quote selection" })).toBeTruthy();
});
it("requires renewed fit review after the requirement version changes", async () => {
  const page = result({ status: "needs_review", reason: "The requirement changed. Review this quote again.", shippingKnown: false });
  page.data[0]!.line = { ...line, version: 2 };
  vi.mocked(workflowRequest).mockResolvedValue(page);
  render(<RequirementSourcing project={project} />);
  await screen.findByText("Selected quote needs review");
  expect(screen.queryByText("Selected for estimate")).toBeNull();
  const useQuote = screen.getByRole("button", { name: "Use reviewed quote" });
  expect(useQuote).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox", { name: "I checked that this quoted item meets the current requirement" }));
  expect(useQuote).toHaveProperty("disabled", false);
  expect(vi.mocked(workflowRequest).mock.calls.every(call => call[1] === undefined)).toBe(true);
});
it("focuses Supplier on entry and returns to the same requirement after cancellation", async () => {
  vi.mocked(workflowRequest).mockResolvedValue(result({ status: "needs_review", reason: "Choose a reviewed quote; nothing is selected automatically.", shippingKnown: false }, false));
  render(<RequirementSourcing project={project} />);
  const trigger = await screen.findByRole("button", { name: "Record quote for Screws" });
  trigger.focus(); fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Supplier" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel quote" }));
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole("textbox", { name: "Supplier" })).toBeNull();
});
it.each(["delayed", "failed", "immediate"])("returns focus after saving with a %s refresh", async (refreshMode) => {
  const failRefresh = refreshMode === "failed";
  const page = result({ status: "needs_review", reason: "Choose a reviewed quote; nothing is selected automatically.", shippingKnown: false }, false);
  let readCount = 0;
  let finishRefresh: (() => void) | undefined;
  vi.mocked(workflowRequest).mockImplementation(async (_path, method, input) => {
    if (method === "POST") {
      const { expectedBomLineVersion, ...fields } = input as Record<string, unknown>;
      return { data: { ...offer, ...fields, bomLineVersion: expectedBomLineVersion } };
    }
    if (++readCount > 1 && refreshMode !== "immediate") {
      await new Promise<void>((resolve) => { finishRefresh = resolve; });
      if (failRefresh) throw new Error("Synthetic refresh unavailable");
    }
    return page;
  });
  render(<RequirementSourcing project={project} />);
  fireEvent.click(await screen.findByRole("button", { name: "Record quote for Screws" }));
  for (const [label, value] of [["Supplier", "Synthetic supplier"], ["Supplier source URL", "https://supplier.example/screws"], ["Pack price", "2.50"]]) {
    fireEvent.change(screen.getByLabelText(label!, { exact: true }), { target: { value } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Save supplier observation" }));
  if (refreshMode !== "immediate") {
    await waitFor(() => expect(finishRefresh).toBeTypeOf("function"));
    expect((screen.getByRole("button", { name: "Record quote for Screws" }) as HTMLButtonElement).disabled).toBe(true);
    finishRefresh!();
  }
  await waitFor(() => expect(document.activeElement).toBe(failRefresh ? screen.getByRole("region", { name: "Requirement sourcing" }) : screen.getByRole("button", { name: "Record quote for Screws" })));
  expect(screen.getByText(/Quote saved\./u)).toBeTruthy();
});

it.each(["optional", "ready", "check"])("does not ask for quote review solely because a %s requirement is outside the estimate", async (kind) => {
  const reason = "Only required Source gaps enter a buying estimate.";
  const page = result({ status: "needs_review", reason, shippingKnown: false });
  page.data[0]!.line = { ...line, optional: kind === "optional" };
  page.data[0]!.decision = kind === "optional" ? "source" : kind;
  vi.mocked(workflowRequest).mockResolvedValue(page);
  render(<RequirementSourcing project={project} />);
  expect(await screen.findByText("Selected quote, not included in estimate")).toBeTruthy();
  expect(screen.getByText(reason)).toBeTruthy();
  expect(screen.queryByText("Selected quote needs review")).toBeNull();
  expect(screen.queryByRole("button", { name: "Record replacement quote" })).toBeNull();
});

it("connects selected quotes to explicit receipt and matching without changing stock", async () => {
  vi.mocked(workflowRequest).mockResolvedValue(result({ status: "estimated", packages: 1, partsSupplied: 4, priceMinor: 250, totalMinor: 250, currency: "EUR", shippingKnown: false }));
  const receive = vi.fn(), match = vi.fn();
  render(<RequirementSourcing project={project} onInventory={receive} onMatch={match} />);
  fireEvent.click(await screen.findByRole("button", { name: "Record received stock" }));
  fireEvent.click(screen.getByRole("button", { name: "Match owned stock" }));
  expect(receive).toHaveBeenCalledOnce(); expect(match).toHaveBeenCalledWith(line.id);
  expect(vi.mocked(workflowRequest).mock.calls.every((call) => call[1] === undefined)).toBe(true);
});
