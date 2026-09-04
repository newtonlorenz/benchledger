import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EditBuildApproachDialog, InventoryDrawer, InventoryTable, NewProjectDialog, NewRevisionDialog, OverviewPage, ProjectExpertContext, ProjectFiles, Prompt, SettingsPage, humanizeSpecificationDecision, inventoryLocationLabel, managedInventoryLabel, revisionInputForRoute } from "./App";
import { DEFAULT_MANAGED_INVENTORY_CATEGORIES } from "./category-ui"; import { buildItemEligibility } from "./catalog-ui"; import type { Artifact, Project } from "./domain";
import { catalogProducts, inventory, projects as sampleProjects } from "./mock-data";
import { artifactIdentityLabel, artifactRevisionLabel, artifactScopeChoices, artifactScopeIdentity, defaultArtifactScope, filterArtifactsForScope } from "./artifact-scope";

const project: Project = {
  id: "project-lamp",
  name: "Lamp",
  subtitle: "A lamp",
  description: "A revisioned lamp",
  status: "building",
  updated: "2026-09-02",
  currentRevision: "Current fit",
  workItem: "Legacy summary only",
  railStep: 1,
  bom: [],
  artifacts: [],
  notes: [],
  accent: "orange",
  serverRevisionId: "project-r7",
  projectRevisions: [{ id: "project-r7", number: 7, name: "Current fit", status: "concept" }],
  workItems: [
    { id: "work-legacy", name: "Unbound notes", kind: "notes" },
    { id: "work-body", name: "Body", kind: "part", currentRevisionId: "work-r3", currentRevision: { id: "work-r3", number: 3, name: "Body fit", status: "concept" } }
  ]
};

const artifact = (id: string, overrides: Partial<Artifact> = {}): Artifact => ({
  id,
  name: `${id}.step`,
  role: "STEP",
  revision: "r07",
  size: "10 B",
  hash: id.padEnd(64, "0"),
  updated: "2026-09-02",
  status: "candidate",
  ...overrides
});

describe("artifact scope selection", () => {
  it("keeps the maker home action-led and makes expert detail visibly additive", () => {
    const beginner = renderToStaticMarkup( <OverviewPage items={inventory} projects={[project]} expert={false} sampleMode={false} onNavigate={() => undefined} onOpenProject={() => undefined} onSelectItem={() => undefined} onNewProject={() => undefined} /> ); const expert = renderToStaticMarkup( <OverviewPage items={inventory} projects={[project]} expert sampleMode={false} onNavigate={() => undefined} onOpenProject={() => undefined} onSelectItem={() => undefined} onNewProject={() => undefined} /> );
    expect(beginner).toContain("What are you making?"); expect(beginner).toContain("Continue Lamp");
    expect(beginner).toContain("Your workshop");
    expect(beginner).not.toContain("Technical project context");
    expect(expert).toContain("Technical project context");
  });

  it("starts revision setup without an implied printing decision", () => {
    const markup = renderToStaticMarkup( <NewRevisionDialog project={project} items={inventory} expert={false} onClose={() => undefined} onCreate={async () => true} /> ); expect(markup).toContain("How will you build it?"); expect(markup).toContain("3D-print parts"); expect(markup).toContain("Use ready-made parts or an enclosure"); expect(markup).toContain("Electronics / assembly only"); expect(markup).toContain("Decide later"); expect(markup).not.toContain("Starting state"); }); it("carries forward the current printer setup and keeps lifecycle controls expert-only", () => { const withPrinter: Project = { ...project, fabricationRoute: "printed", intendedPrinterItemId: "eq-h2d", buildConfigSnapshot: { id: "setup-r7", projectId: project.id, revisionId: "project-r7", createdAt: "2026-09-03T12:00:00.000Z", version: 1, printerItemId: "eq-h2d", accessories: [], unknowns: [] } }; const beginner = renderToStaticMarkup( <NewRevisionDialog project={withPrinter} items={inventory} expert={false} onClose={() => undefined} onCreate={async () => true} /> ); const expert = renderToStaticMarkup( <NewRevisionDialog project={withPrinter} items={inventory} expert onClose={() => undefined} onCreate={async () => true} /> ); expect(beginner).toContain("3D-print parts"); expect(beginner).toContain("Bambu Lab H2D · AMS Combo"); expect(beginner).not.toContain("Starting state"); expect(expert).toContain("Starting state"); expect(expert).toContain("technical override"); }); it("creates no-print revisions without an empty build setup", () => { expect( revisionInputForRoute({ name: " Electronics ", status: "concept", notes: "", fabricationRoute: "none", buildConfig: { printerItemId: "eq-h2d", accessories: [], unknowns: [] } }) ).toEqual({ name: "Electronics", status: "concept", fabricationRoute: "none" }); expect(humanizeSpecificationDecision("power_rating")).toBe("power rating"); }); it("keeps every realistic sample inventory item connected to the managed category list", () => { const categoryIds = new Set( DEFAULT_MANAGED_INVENTORY_CATEGORIES.map((category) => category.id) ); expect(inventory).toHaveLength(14); expect( inventory.filter((item) => item.categoryNodeId === undefined) ).toHaveLength(0); expect( inventory.every( (item) => item.categoryNodeId !== undefined && categoryIds.has(item.categoryNodeId) ) ).toBe(true); }); it("keeps sample printers usable and project file identities coherent", () => { const samplePrinters = inventory.filter( (item) => item.category === "Printers" ); expect(samplePrinters).toHaveLength(2); expect( samplePrinters.every( (item) => buildItemEligibility(item, "Printers").eligible ) ).toBe(true); const lamp = sampleProjects.find( (candidate) => candidate.id === "project-lamp" ); expect(lamp).toMatchObject({ name: "Autonomous lamp", workItem: "Autonomous lamp enclosure", serverRevisionId: "sample-project-lamp-r03" }); expect( lamp?.bom.some( (line) => inventory.find((item) => item.id === line.itemId)?.category === "Printers" ) ).toBe(false); expect( lamp?.artifacts.filter( (file) => !file.projectRevisionId && !file.workItemRevisionId ) ).toHaveLength(0); expect(defaultArtifactScope(lamp!)).toEqual({ kind: "project", projectRevisionId: "sample-project-lamp-r03" }); const dialog = renderToStaticMarkup( <NewRevisionDialog project={lamp!} items={inventory} expert={false} onClose={() => undefined} onCreate={async () => true} /> ); expect(dialog).toContain("Bambu Lab H2D · AMS Combo"); expect(dialog).not.toContain("Build setup blocked"); expect(dialog).not.toContain("product link"); }); it("offers printer-detail recovery without pretending an unknown model is usable", () => { const { catalogProduct: _catalogProduct, productProfile: _productProfile, ...unknownPrinter } = inventory.find((item) => item.id === "eq-h2d")!; const withUnknownPrinter: Project = { ...project, buildConfigSnapshot: { id: "setup-unknown", projectId: project.id, revisionId: "project-r7", createdAt: "2026-09-03T12:00:00.000Z", version: 1, printerItemId: unknownPrinter.id, accessories: [], unknowns: [] } }; const markup = renderToStaticMarkup( <NewRevisionDialog project={withUnknownPrinter} items={[unknownPrinter]} expert={false} onClose={() => undefined} onAddPrinterDetails={() => undefined} onCreate={async () => true} /> ); expect(markup).toContain("Add the exact printer model and variant."); expect(markup).toContain("Add printer details"); expect(markup).not.toContain("product link"); }); it("defaults to the exact project revision independently of work-item ordering", () => { const choices = artifactScopeChoices(project); expect(defaultArtifactScope(project)).toEqual({ kind: "project", projectRevisionId: "project-r7" }); expect(choices.map((choice) => choice.label)).toEqual([ "Project · r07 · Current fit", "Work item · Body · r03 · Body fit", "Work item · Unbound notes · No current revision", "All files (read-only)" ]); expect( artifactScopeChoices(project, true).map((choice) => choice.label) ).toEqual([ "Project · r07 · Current fit · project-r7", "Work item · Body · work-body · r03 · Body fit · work-r3", "Work item · Unbound notes · work-legacy · No current revision", "All files (read-only)" ]); expect(choices[1]?.target).toEqual({ kind: "work-item", workItemId: "work-body", workItemRevisionId: "work-r3" }); expect(choices[2]?.disabled).toBe(true); expect(choices[3]).toMatchObject({ readOnly: true, disabled: false, target: { kind: "all" } }); }); it("matches project and work-item ancestry exactly while retaining legacy files in All", () => { const files = [ artifact("project-current", { projectRevisionId: "project-r7" }), artifact("project-old", { projectRevisionId: "project-r6" }), artifact("work-current", { workItemId: "work-body", workItemRevisionId: "work-r3" }), artifact("work-old", { workItemId: "work-body", workItemRevisionId: "work-r2" }), artifact("legacy") ]; expect( filterArtifactsForScope(files, { kind: "project", projectRevisionId: "project-r7" }).map((file) => file.id) ).toEqual(["project-current"]); expect( filterArtifactsForScope(files, { kind: "work-item", workItemId: "work-body", workItemRevisionId: "work-r3" }).map((file) => file.id) ).toEqual(["work-current"]); expect( filterArtifactsForScope(files, { kind: "all" }).map((file) => file.id) ).toEqual(files.map((file) => file.id)); expect(artifactIdentityLabel(files[0]!)).toBe("Project revision"); expect(artifactIdentityLabel(files[2]!)).toBe("Work item revision"); expect(artifactIdentityLabel(files[4]!)).toBe("Not assigned to a revision"); expect(artifactIdentityLabel(files[0]!, true)).toBe("Project · project-r7"); expect(artifactIdentityLabel(files[2]!, true)).toBe( "Work item · work-body · work-r3" ); expect(artifactIdentityLabel(files[4]!, true)).toBe("Unbound / legacy"); expect(artifactScopeIdentity({ kind: "all" })).toBe( "All files · read-only" ); }); it("keeps raw artifact ancestry and hashes out of beginner file views", () => { const markup = renderToStaticMarkup( <ProjectFiles project={{ ...project, allArtifacts: [ artifact("project-current", { projectRevisionId: "project-r7", revision: "opaque-artifact-revision" }), artifact("legacy") ] }} expert={false} sampleMode={false} onUpload={async () => undefined} /> ); expect(markup).toContain("Project · r07 · Current fit"); expect(markup).toContain("Project revision"); expect(markup).not.toContain("projectRevisionId="); expect(markup).not.toContain("Current fit · project-r7"); expect(markup).not.toContain("Body · work-body"); expect(markup).not.toContain("SHA-256"); expect(markup).not.toContain("Unbound / legacy"); expect(markup).toContain("Recorded revision"); expect(markup).not.toContain("opaque-artifact-revision"); expect(artifactRevisionLabel(artifact("friendly"))).toBe("r07"); expect( artifactRevisionLabel( artifact("caller-id", { projectRevisionId: "r07", revision: "r07" }) ) ).toBe("Recorded revision"); expect( artifactRevisionLabel( artifact("opaque", { projectRevisionId: "project-r7", revision: "opaque-artifact-revision" }), true ) ).toBe("opaque-artifact-revision"); }); it("keeps missing inventory category metadata explicit without exposing IDs", () => { const { categoryNodeId: _categoryNodeId, ...item } = inventory[0]!; const props = { item, categories: [], categoriesLoading: false, onClose: () => undefined, onCount: async () => item, onCommission: async () => item, onUpdate: async () => item }; const beginnerMarkup = renderToStaticMarkup( <InventoryDrawer {...props} expert={false} /> ); expect(beginnerMarkup).toContain('class="eyebrow">No category'); const expertMarkup = renderToStaticMarkup( <InventoryDrawer {...props} expert /> ); expect(expertMarkup).toContain('class="eyebrow">No category'); expect(beginnerMarkup).not.toContain(item.id); expect(expertMarkup).toContain(item.id); }); it("shows missing category and location metadata plainly in the table and drawer", () => { const { categoryNodeId: _categoryNodeId, ...sampleItem } = inventory[0]!; const item = { ...sampleItem, id: "missing-metadata", location: "" }; const tableMarkup = renderToStaticMarkup( <InventoryTable items={[item]} categories={[]} selectedIds={new Set()} selectAllRef={{ current: null }} allLoadedSelected={false} hasUnversionedLoaded={false} onToggleAll={() => undefined} onToggleSelected={() => undefined} onSelectItem={() => undefined} /> ); expect(tableMarkup).toContain("No category"); expect(tableMarkup).toContain("No location"); const drawerMarkup = renderToStaticMarkup( <InventoryDrawer item={item} categories={[]} categoriesLoading={false} expert={false} onClose={() => undefined} onCount={async () => item} onCommission={async () => item} onUpdate={async () => item} /> ); expect(drawerMarkup).toContain("No location"); expect(drawerMarkup).toContain("No category"); expect(drawerMarkup).not.toContain("UNASSIGNED ITEM"); const unavailableCategoryMarkup = renderToStaticMarkup( <InventoryDrawer item={{ ...item, categoryNodeId: "missing-category" }} categories={[]} categoriesLoading={false} expert={false} onClose={() => undefined} onCount={async () => item} onCommission={async () => item} onUpdate={async () => item} /> ); expect(unavailableCategoryMarkup).toContain("Managed category unavailable"); expect(inventoryLocationLabel("Shelf A")).toBe("Shelf A"); expect(inventoryLocationLabel("Unassigned")).toBe("No location"); expect(inventoryLocationLabel("Unassigned shelf")).toBe("Unassigned shelf"); expect( managedInventoryLabel([], { ...item, categoryNodeId: "missing-category" }) ).toBe("Managed category unavailable"); expect(managedInventoryLabel([], item, true)).toBe("No category"); }); it("renders an incomplete bundle link honestly", () => { const item = inventory.find((candidate) => candidate.id === "eq-h2d")!; const catalogProduct = catalogProducts.find( (candidate) => candidate.id === "catalog-h2d" )!; const { variant: _variant, exactVariant: _exactVariant, ...genericProduct } = catalogProduct; const incompleteItem = { ...item, catalogProduct: genericProduct, productProfile: { inventoryItemId: item.id, catalogProductId: genericProduct.id, linkState: "confirmed" as const } }; const markup = renderToStaticMarkup( <InventoryDrawer item={incompleteItem} categories={[]} categoriesLoading={false} expert={false} onClose={() => undefined} onCount={async () => incompleteItem} onCommission={async () => incompleteItem} onUpdate={async () => incompleteItem} onLinkProduct={() => undefined} /> ); expect(markup).toContain("Product match"); expect(markup).toContain("does not include the recorded bundle or variant"); expect(markup).toContain("Recorded build volume"); expect(markup).toContain("325 × 320 × 325 mm"); expect(markup).toContain("Change exact product"); expect(markup).not.toContain( "Product identity confirmed for setup matching" ); }); it("offers a history-safe corrected replacement for an invalid legacy unit", () => { const item = { ...inventory[0]!, unitStatus: "needs_correction" as const, unitCorrectionReason: "Printer items use each; this record uses gram." }; const props = { item, categories: [], categoriesLoading: false, onClose: () => undefined, onCount: async () => item, onCommission: async () => item, onUpdate: async () => item, onCreateReplacement: () => undefined }; const beginnerMarkup = renderToStaticMarkup( <InventoryDrawer {...props} expert={false} /> ); expect(beginnerMarkup).toContain("This record cannot be used yet"); expect(beginnerMarkup).toContain( "This unit does not match this item type. Create a corrected replacement before you use this record." );
    expect(beginnerMarkup).toContain("Fix unit"); expect(beginnerMarkup).toContain("Quantity blocked"); expect(beginnerMarkup).not.toContain("Recorded quantity:");
    expect(beginnerMarkup).toContain("original stays blocked as history"); expect(beginnerMarkup).not.toContain("Recorded unit:"); const expertMarkup = renderToStaticMarkup( <InventoryDrawer {...props} expert /> ); expect(expertMarkup).toContain("Recorded unit:");
    expect(expertMarkup).toContain( "Historical quantities and evidence are not rewritten" );
    expect(expertMarkup).not.toContain("Commission received stock"); expect(expertMarkup).not.toContain("Review commissioning"); }); it("repairs a legacy item with no recorded type through a guarded replacement", () => { const { kind: _kind, ...legacyItem } = inventory[0]!; const markup = renderToStaticMarkup( <InventoryDrawer item={legacyItem} categories={[]} categoriesLoading={false} expert={false} onClose={() => undefined} onCount={async () => legacyItem} onCommission={async () => legacyItem} onUpdate={async () => legacyItem} onCreateReplacement={() => undefined} /> );
    expect(markup).toContain("Item type not recorded");
    expect(markup).toContain("Create corrected record");
  });

  it("renders real scope identity, disabled unrevisioned items, and hash evidence without a fabricated path", () => {
    const markup = renderToStaticMarkup(<ProjectFiles project={{ ...project, allArtifacts: [artifact("project-current", { projectRevisionId: "project-r7" }), artifact("legacy")] }} expert sampleMode={false} onUpload={async () => undefined} />);
    expect(markup).toContain("Project · r07 · Current fit · project-r7");
    expect(markup).toContain( "Work item · Body · work-body · r03 · Body fit · work-r3" );
    expect(markup).toContain("All files (read-only)");
    expect(markup).toContain("SHA-256"); expect(markup).not.toContain("/work-items/"); expect(markup).not.toContain("legacy-summary-only");
  });

  it("keeps settings beginner-friendly while preserving canonical units for experts", () => {
    const props = { sampleMode: true, connection: "sample" as const,
      categories: [],
      categoriesLoading: false, onRetryCategories: () => undefined, onCreateCategory: async () => undefined, onUpdateCategory: async () => undefined, onArchiveCategory: async () => undefined, hideLogout: false, onExpert: () => undefined, onLogout: () => undefined };
    const beginnerMarkup = renderToStaticMarkup(<SettingsPage {...props} expert={false} />);
    expect(beginnerMarkup).toContain( "Categories organize your workspace. Item type controls stock rules." );
    expect(beginnerMarkup).toContain("mm · g · m · millilitres"); expect(beginnerMarkup).toContain("pieces");
    expect(beginnerMarkup).toContain("millilitres"); expect(beginnerMarkup).toContain("sets"); expect(beginnerMarkup).not.toContain("millilitre · g · m · millilitre"); expect(beginnerMarkup).toContain("Connection and agent access"); expect(beginnerMarkup).toContain("Show technical details"); expect(beginnerMarkup).toContain( "Show identifiers, evidence, and compatibility details when you need them." ); const expertMarkup = renderToStaticMarkup(<SettingsPage {...props} expert />);

    expect(expertMarkup).toContain( "millimetre · gram · metre · millilitre · each · set" );
    expect(expertMarkup).toContain("Hide technical details");
    expect(expertMarkup).toContain( "Hide identifiers and technical evidence for a simpler view." );
  });

  it("keeps beginner connection copy plain while preserving technical disclosure", () => {
    const props = { sampleMode: true, connection: "sample" as const,
      categories: [],
      categoriesLoading: false, onRetryCategories: () => undefined, onCreateCategory: async () => undefined, onUpdateCategory: async () => undefined, onArchiveCategory: async () => undefined, hideLogout: false, onExpert: () => undefined, onLogout: () => undefined };
    const beginnerMarkup = renderToStaticMarkup(<SettingsPage {...props} expert={false} />);
    expect(beginnerMarkup).toContain("Connection and agent access");
    expect(beginnerMarkup).toContain("Workspace connection");
    expect(beginnerMarkup).toContain("practice data");
    expect(beginnerMarkup).toContain("Agent connection");
    expect(beginnerMarkup).not.toContain("API");
    expect(beginnerMarkup).not.toContain("Private API");
    expect(beginnerMarkup).not.toContain("synthetic records");
    expect(beginnerMarkup).not.toContain("MCP endpoint");
    expect(beginnerMarkup).not.toContain("benchledger://capabilities");
    const expertMarkup = renderToStaticMarkup(<SettingsPage {...props} expert />);
    expect(expertMarkup).toContain("Private API");
    expect(expertMarkup).toContain("synthetic records");
    expect(expertMarkup).toContain("MCP endpoint");
    expect(expertMarkup).toContain("benchledger://capabilities");
  });

  it("keeps private beginner Settings copy plain", () => {
    const props = { sampleMode: false, connection: "ready" as const,
      categories: [],
      categoriesLoading: false, onRetryCategories: () => undefined, onCreateCategory: async () => undefined, onUpdateCategory: async () => undefined, onArchiveCategory: async () => undefined, hideLogout: false, onExpert: () => undefined, onLogout: () => undefined };
    const markup = renderToStaticMarkup(<SettingsPage {...props} expert={false} />);

    expect(markup).toContain("Your private workspace");
    expect(markup).toContain("Your private workspace is connected. Changes stay in this workspace.");
    expect(markup).toContain("Connected to your workspace");
    expect(markup).not.toContain("Local workspace adapter");
    expect(markup).not.toContain("browser sends supported reads and writes");
    expect(markup).not.toContain("Private API");
    expect(markup).not.toContain("MCP endpoint");
  });

  it("uses friendly unit suffixes in beginner stock checks and canonical values in Expert", () => {
    const item = {
      ...inventory[0]!, unit: "millilitre" as const, evidence: "delivered" as const };
    const props = {
      item,
      categories: [],
      categoriesLoading: false,
      onClose: () => undefined,
      onCount: async () => item,
      onCommission: async () => item,
      onUpdate: async () => item };
    const beginnerMarkup = renderToStaticMarkup(<InventoryDrawer {...props} expert={false} />);
    expect(beginnerMarkup).toContain(">millilitres<");
    expect(beginnerMarkup).not.toContain(">millilitre<"); const expertMarkup = renderToStaticMarkup( <InventoryDrawer {...props} expert /> );
    expect(expertMarkup).toContain(">millilitre<"); for (const [unit, beginner, canonical] of [ ["g", "grams", "gram"], ["m", "metres", "metre"] ] as const) { const unitItem = { ...item, unit }; expect( renderToStaticMarkup(<InventoryDrawer {...props} item={unitItem} expert={false} />) ).toContain(`>${beginner}<`);
    expect( renderToStaticMarkup( <InventoryDrawer {...props} item={unitItem} expert /> ) ).toContain(`>${canonical}<`);
  } });

  it("shows the retained original server unit when a record needs correction", () => {
    const item = { ...inventory[0]!, unit: "each" as const, serverUnit: "spoolish", unitStatus: "needs_correction" as const }; const markup = renderToStaticMarkup(<InventoryDrawer item={item} categories={[]} categoriesLoading={false} expert onClose={() => undefined} onCount={async () => item} onCommission={async () => item} onUpdate={async () => item} />);
    expect(markup).toContain("Recorded unit:");
    expect(markup).toContain("spoolish");
    expect(markup).not.toContain("Recorded unit: <code>each</code>"); }); it("keeps example request copy controls available with the app's live feedback messages", () => { const markup = renderToStaticMarkup( <Prompt text="Can I build this with what I have?" onCopy={() => undefined} /> );
    expect(markup).toContain("Can I build this with what I have?");
    expect(markup).toContain('type="button"');
  });

  it("renders only real work-item identities in the expert sidebar context", () => {
    const markup = renderToStaticMarkup(<ProjectExpertContext project={project} />);
    expect(markup).toContain("Body · work-body · work-r3");
    expect(markup).toContain("Unbound notes · work-legacy · No current revision");
    expect(markup).not.toContain("project-lamp/work-item");
    const emptyMarkup = renderToStaticMarkup(<ProjectExpertContext project={{ ...project, workItems: [] }} />);
    expect(emptyMarkup).toContain("No work items recorded");
    expect(emptyMarkup).not.toContain("project-lamp/work-item");
  });

  it("uses maker-friendly language for planning-only build choices", () => {
    const markups = [
      renderToStaticMarkup(<NewProjectDialog items={inventory} onClose={() => undefined} onCreate={async () => "created"} />),
      renderToStaticMarkup(<NewRevisionDialog project={project} items={inventory} expert={false} onClose={() => undefined} onCreate={async () => true} />),
      renderToStaticMarkup(<EditBuildApproachDialog project={project} items={inventory} expert={false} onClose={() => undefined} onSave={async () => true} />),
    ];
    for (const markup of markups) {
      expect(markup).toContain("build anything");
      expect(markup).not.toContain("fabricate");
    }
  });
});
