import { renderToStaticMarkup } from "react-dom/server";
import { it, expect } from "vitest";
import { GuidedSetup } from "./guided-setup";
import { createSampleWorkspaceAdapter } from "./api";
import { BuildEditor, PlanSummary } from "./build-plan-ui";
import { QuoteForm } from "./requirement-sourcing";
import { WorkstreamPlanning } from "./workstream-ui";
import { ExistingBomImport } from "./bom-import-ui";
import { MakerPlanningTools, ProjectQuoteTools } from "./maker-planning-ui";
import { projects, inventory } from "./mock-data";
import { quotedMinor, quotedMoney, mutationValue, revisionWorkflowPath } from "./workflow-ui";
import type { BuildPlan, BomLine } from "@benchledger/api-contract";
const project = { ...structuredClone(projects[0]!), fabricationRoute: "printed" as const };
const plan: BuildPlan = { id: "plan", projectId: project.id, projectRevisionId: project.serverRevisionId!, version: 1, name: "Bracket plan", contentSha256: "a".repeat(64), createdAt: "2026-09-06T00:00:00.000Z", createdBy: "synthetic", parts: [{ id: "bracket", name: "Bracket", quantity: 5 }], plates: [{ id: "plate", name: "First plate", copies: 2, parts: [{ partId: "bracket", quantity: 3 }], materials: [{ itemId: "filament", role: "model", side: "single", grams: 12 }], minutes: 40 }], warnings: ["Planning only"], artifactBasis: [], totals: { parts: [{ id: "bracket", required: 5, planned: 6, missing: 0, excess: 1 }], materialGrams: [{ itemId: "filament", grams: 24 }], minutes: 80, timeComplete: true } };
it("renders bounded guided setup without executing an import", () => {
  const html = renderToStaticMarkup(<GuidedSetup adapter={createSampleWorkspaceAdapter()} items={inventory} onDone={async () => undefined} onBusy={() => undefined} />);
  expect(html).toContain("Review CSV mapping"); expect(html).toContain("Preview complete project"); expect(html).toContain("No stock is reserved.");
});
it("renders repeated-plate planning and preserves evidence warnings", () => {
  const html = renderToStaticMarkup(<BuildEditor project={project} items={inventory} initial={plan} root="/synthetic" onCancel={() => undefined} onSaved={() => undefined} />);
  expect(html).toContain("Bracket"); expect(html).toContain("Material role"); expect(html).toContain("Nozzle side"); expect(html).toContain("Review build plan");
  expect(renderToStaticMarkup(<PlanSummary plan={plan} items={inventory} />)).toContain("80");
});
it("renders sourcing as an observation, with explicit prices and unknown shipping", () => {
  const line: BomLine = { id: "screw", revisionId: "revision", name: "Screw", requiredQuantity: 7, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [], version: 1, createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" };
  const html = renderToStaticMarkup(<QuoteForm line={line} root="/synthetic" onSaved={() => undefined} onCancel={() => undefined} />); expect(html).toContain("Save supplier observation"); expect(html).toContain("blank if unknown");
});
it("keeps import and planning controls contextual and read-only for archived projects", () => {
  expect(renderToStaticMarkup(<MakerPlanningTools project={project} items={inventory} onRefresh={async () => true} />)).toContain("Parts, plates and workstreams");
  expect(renderToStaticMarkup(<ExistingBomImport project={project} onRefresh={async () => true} />)).toContain("Append requirements from CSV");
  expect(renderToStaticMarkup(<ExistingBomImport project={{ ...project, status: "archived" }} onRefresh={async () => true} />)).toBe("");
  expect(renderToStaticMarkup(<WorkstreamPlanning project={project} />)).toContain("Add workstream");
  expect(renderToStaticMarkup(<WorkstreamPlanning project={project} readOnly />)).not.toContain("Add workstream");
  expect(renderToStaticMarkup(<ProjectQuoteTools project={project} />)).toContain("Supplier quotes for this project");
});
it("handles minor currency units without silently rounding excessive precision", () => {
  expect(quotedMinor("2.50", "EUR")).toBe(250); expect(quotedMinor("250", "JPY")).toBe(250);
  expect(quotedMoney(250, "EUR")).toContain("2.50"); expect(() => quotedMinor("2.555", "EUR")).toThrow(); expect(() => quotedMinor("-1", "GBP")).toThrow();
  expect(() => mutationValue(null, ["id"])).toThrow(); expect(() => mutationValue({ data: {} }, ["id"])).toThrow(); expect(mutationValue({ data: { id: "safe" } }, ["id"])).toEqual({ id: "safe" });
  expect(revisionWorkflowPath("project", "revision")).toBe("/projects/project/revisions/revision");
});
