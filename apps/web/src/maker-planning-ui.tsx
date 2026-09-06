import { useState } from "react";
import type { Project, InventoryItem } from "./domain";
import { BuildPlanning } from "./build-plan-ui";
import { WorkstreamPlanning } from "./workstream-ui";
import { ExistingBomImport } from "./bom-import-ui";
import { RequirementSourcing } from "./requirement-sourcing";

export function MakerPlanningTools({ project, items, onRefresh }: { project: Project; items: InventoryItem[]; onRefresh(): Promise<boolean> }) {
  const [planning, setPlanning] = useState(false), [importing, setImporting] = useState(false);
  return <div className="maker-planning-tools">
    <details className="surface maker-tool-group" open={planning} onToggle={(event) => setPlanning(event.currentTarget.open)}><summary>Parts, plates and workstreams</summary>
      {planning && <><BuildPlanning key={`build:${project.id}:${project.serverRevisionId}`} project={project} items={items} /><WorkstreamPlanning key={`work:${project.id}`} project={project} /></>}
    </details>
    {project.status !== "archived" && <details className="surface maker-tool-group" open={importing} onToggle={(event) => setImporting(event.currentTarget.open)}><summary>Import requirements from CSV</summary>
      {importing && <ExistingBomImport key={`import:${project.id}:${project.serverRevisionId}`} project={project} onRefresh={onRefresh} />}
    </details>}
  </div>;
}
export function ProjectQuoteTools({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  return <details className="surface maker-tool-group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Supplier quotes for requirements</summary><p>Compare recorded quotes without creating inventory. Selected project quotes are separate from inventory-linked offers above.</p>{open && <RequirementSourcing key={`${project.id}:${project.serverRevisionId}`} project={project} />}</details>;
}
