import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BuildApproachCard,
  BulkInventoryDialog,
  CapabilitiesPage,
  EditBuildApproachDialog,
  NewProjectDialog,
  NewRevisionDialog,
  OverviewPage,
  SampleBanner,
  hasBulkInventoryChanges,
  isUsableOwnedPrinter,
  printRelatedSignals,
  printerBuildVolumeCopy,
  revisionInputForRoute
} from "./App";
import { inventory, projects } from "./mock-data";

const noop = () => undefined;

describe("build route UI", () => {
  it("renders the four build routes in both project and revision flows", () => {
    const projectMarkup = renderToStaticMarkup(<NewProjectDialog onClose={noop} onCreate={async () => "created"} />);
    const revisionMarkup = renderToStaticMarkup(<NewRevisionDialog project={projects[0]!} items={inventory} expert={false} onClose={noop} onCreate={async () => true} />);
    for (const label of ["3D-print parts", "Use ready-made parts or an enclosure", "Electronics / assembly only", "Decide later"]) {
      expect(projectMarkup).toContain(label);
      expect(revisionMarkup).toContain(label);
    }
    expect(projectMarkup).toContain('value="printed"');
    expect(projectMarkup).toContain('value="ready_made"');
    expect(projectMarkup).toContain('value="none"');
    expect(projectMarkup).toContain('value="undecided"');
  });

  it("uses maker language when the project build approach is undecided", () => {
    const markup = renderToStaticMarkup(<BuildApproachCard project={{ ...projects[0]!, fabricationRoute: "undecided" }} items={[]} expert={false} />);

    expect(markup).toContain("You can choose an approach when you know how you want to build it.");
    expect(markup).not.toContain("fabrication need");
  });

  it("keeps printer selection optional and defers fit claims", () => {
    const { intendedPrinterItemId: _printerId, ...projectWithoutPlanningPrinter } = projects[0]!;
    const printedProject = { ...projectWithoutPlanningPrinter, fabricationRoute: "printed" as const, artifacts: [] };
    const markup = renderToStaticMarkup(<BuildApproachCard project={printedProject} items={[]} expert={false} />);
    expect(markup).toContain("No printer selected yet");
    expect(markup).toContain("That’s fine");
    expect(markup).toContain("Not checked yet");
    expect(markup).toContain("Add a printable file to check fit.");
    expect(markup).not.toContain("compatible");
    expect(markup).not.toContain("Review print-related items");
    expect(revisionInputForRoute({ name: " R02 ", status: "concept", notes: "", fabricationRoute: "none" })).toEqual({ name: "R02", status: "concept", fabricationRoute: "none" });
    expect(revisionInputForRoute({ name: " R02 ", status: "concept", notes: "", fabricationRoute: "printed", intendedPrinterItemId: "eq-h2d" })).toEqual({ name: "R02", status: "concept", fabricationRoute: "printed" });
    expect(revisionInputForRoute({ name: " R02 ", status: "concept", notes: "", fabricationRoute: "printed", intendedPrinterItemId: "eq-h2d", printerSelectionTouched: true })).toEqual({ name: "R02", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: "eq-h2d" });
    expect(revisionInputForRoute({ name: " R02 ", status: "concept", notes: "", fabricationRoute: "printed", printerSelectionTouched: true })).toEqual({ name: "R02", status: "concept", fabricationRoute: "printed", intendedPrinterItemId: null });
  });

  it("does not resurrect a cleared printer from an old build snapshot", () => {
    const project = {
      ...projects[0]!,
      fabricationRoute: "printed" as const,
      intendedPrinterItemId: null,
      buildConfigSnapshot: { ...projects[0]!.buildConfigSnapshot!, printerItemId: "eq-h2d" }
    };
    const markup = renderToStaticMarkup(<NewRevisionDialog project={project} items={inventory} expert={false} onClose={noop} onCreate={async () => true} />);
    expect(markup).toContain("No printer selected yet");
    expect(markup).not.toContain("Bambu Lab H2D");
  });

  it("uses only current-revision printable artifacts as build-file evidence", () => {
    const currentProject = { ...projects[0]!, fabricationRoute: "printed" as const };
    const currentMarkup = renderToStaticMarkup(<BuildApproachCard project={currentProject} items={inventory} expert={false} />);
    expect(currentMarkup).toContain("Build file added. Fit still needs a slicer check.");

    const historicalOnly = {
      ...currentProject,
      artifacts: currentProject.artifacts.filter((artifact) => artifact.projectRevisionId !== currentProject.serverRevisionId),
    };
    const historicalMarkup = renderToStaticMarkup(<BuildApproachCard project={historicalOnly} items={inventory} expert={false} />);
    expect(historicalMarkup).toContain("Add a printable file to check fit.");
    expect(historicalMarkup).not.toContain("Build file added.");
  });

  it("uses contextual optional printer labels and concise sample wording", () => {
    const revisionMarkup = renderToStaticMarkup(<NewRevisionDialog project={projects[0]!} items={inventory} expert={false} onClose={noop} onCreate={async () => true} />);
    const editorMarkup = renderToStaticMarkup(<EditBuildApproachDialog project={projects[0]!} items={inventory} expert={false} onClose={noop} onSave={async () => true} />);
    expect(editorMarkup).toContain("Printer for this project");
    expect(revisionMarkup).toContain("Printer for this revision");
    expect(editorMarkup).toContain("Leave blank if you have not decided yet.");
    expect(revisionMarkup).toContain("Leave blank if you have not decided yet.");

    const banner = renderToStaticMarkup(<SampleBanner onReturn={noop} />);
    expect(banner).toContain("Try the workflow here. Changes do not affect your private workspace.");
    expect(banner).toContain("Return to private workspace");
    expect(banner).not.toContain("synthetic data");
  });

  it("opens a small route-only editor instead of sending printer choices to inventory", () => {
    const project = { ...projects[0]!, fabricationRoute: "printed" as const, intendedPrinterItemId: "eq-h2d", serverRevisionVersion: 3 };
    const card = renderToStaticMarkup(<BuildApproachCard project={project} items={inventory} expert={false} onChoosePrinter={noop} onSelectPrinter={noop} />);
    const editor = renderToStaticMarkup(<EditBuildApproachDialog project={project} items={inventory} expert={false} onClose={noop} onSave={async () => true} />);
    expect(card).toContain("Change build approach");
    expect(card).not.toContain("Inventory");
    expect(editor).toContain("Save build approach");
    expect(editor).toContain("Choose how this project will be built.");
    expect(editor).toContain("edit-build-approach-form");
    expect(editor).toContain("3D-print parts");
    expect(editor).not.toContain("Filament");
    expect(editor).not.toContain("targetEnvelopeMm");

    const { intendedPrinterItemId: _printerId, ...projectWithoutPrinter } = project;
    const nonPrintedCard = renderToStaticMarkup(<BuildApproachCard project={{ ...projectWithoutPrinter, fabricationRoute: "none" }} items={inventory} expert={false} onChoosePrinter={noop} onReviewPrintItems={(target) => { void target; }} />);
    expect(nonPrintedCard).toContain("Change build approach");
    expect(nonPrintedCard).toContain("Review print-related items");
    expect(nonPrintedCard).toContain("Open Plan");
    expect(printRelatedSignals(project, inventory)).toMatchObject({ requirementCount: 1, fileCount: 1, hasBuildSetup: true });

    const { buildConfigSnapshot: _setup, ...cleanProject } = projectWithoutPrinter;
    const cleanMarkup = renderToStaticMarkup(<BuildApproachCard project={{ ...cleanProject, fabricationRoute: "none", bom: [], artifacts: [] }} items={[]} expert={false} />);
    expect(cleanMarkup).not.toContain("Review print-related items");
  });

  it("shows actionable beginner workshop copy and responsive printer cards", () => {
    const markup = renderToStaticMarkup(<OverviewPage items={[]} projects={[{ ...projects[0]!, fabricationRoute: "none" }]} expert={false} sampleMode={false} onNavigate={noop} onOpenProject={noop} onSelectItem={noop} onNewProject={noop} onAddPrinter={noop} />);
    expect(markup).toContain("That’s fine for electronics and ready-made builds.");
    expect(markup).toContain("Add printer");
    expect(markup).toContain("build-approach-card");
    expect(markup).not.toContain("workshop-agent-link");

    const expertMarkup = renderToStaticMarkup(<OverviewPage items={[]} projects={[{ ...projects[0]!, fabricationRoute: "none" }]} expert={true} sampleMode={false} onNavigate={noop} onOpenProject={noop} onSelectItem={noop} onNewProject={noop} onAddPrinter={noop} />);
    expect(expertMarkup).toContain("workshop-agent-link");

    const printer = inventory.find((item) => item.category === "Printers")!;
    const cards = renderToStaticMarkup(<OverviewPage items={[printer]} projects={[]} expert={false} sampleMode={false} onNavigate={noop} onOpenProject={noop} onSelectItem={noop} onNewProject={noop} />);
    expect(cards).toContain("workshop-printer-card");
    expect(cards).toContain(printerBuildVolumeCopy(printer)!);
  });

  it("disables bulk review until a real field is supplied", () => {
    expect(hasBulkInventoryChanges(" ", "", " ,\n", "\t")).toBe(false);
    expect(hasBulkInventoryChanges("Shelf A", "", "", "")).toBe(true);
    expect(hasBulkInventoryChanges("", "good", "", "")).toBe(true);
    expect(hasBulkInventoryChanges("", "", "tag", "")).toBe(true);

    const item = { ...inventory[0]!, version: 1 };
    const markup = renderToStaticMarkup(<BulkInventoryDialog selectedItems={[item]} onClose={noop} onDone={noop} onApply={async () => ({ updated: [], unchanged: [], audits: [], correlationId: "bulk-test", replayed: false })} />);
    expect(markup).toMatch(/<button type="submit"[^>]*disabled="">\s+Review changes/u);
  });

  it("directs agents to the live contract without advertising stale tools", () => {
    const markup = renderToStaticMarkup(<CapabilitiesPage expert onCopy={noop} />);
    expect(markup).toContain("benchledger://capabilities");
    expect(markup).toContain("Preview");
    expect(markup).toContain("Commit after approval");
    expect(markup).toContain("Artifact upload and download bytes");
    expect(markup).not.toContain("create_artifact_revision");
    expect(markup).not.toContain("MCP available");
  });

  it("only treats counted or commissioned positive printers as owned capabilities", () => {
    const printer = inventory.find((item) => item.category === "Printers")!;
    expect(isUsableOwnedPrinter(printer)).toBe(true);
    const { productProfile: _profile, ...genericPrinter } = printer;
    expect(isUsableOwnedPrinter(genericPrinter)).toBe(false);
    expect(isUsableOwnedPrinter({ ...printer, evidence: "delivered" })).toBe(false);
    expect(isUsableOwnedPrinter({ ...printer, quantity: 0 })).toBe(false);
    expect(isUsableOwnedPrinter({ ...printer, tags: [...printer.tags, "retired"] })).toBe(false);
  });
});
