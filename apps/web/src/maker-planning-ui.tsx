import type { Project, InventoryItem } from "./domain";
import { BuildPlanning } from "./build-plan-ui";
import { WorkstreamPlanning } from "./workstream-ui";
import { RequirementSourcing } from "./requirement-sourcing";

export function MakerPlanningTools({ project, items }: { project: Project; items: InventoryItem[]; onRefresh(): Promise<boolean> }) {
  return <div className="maker-planning-tools build-workspace">
    <div className="workflow-page-heading"><span className="eyebrow">Build planning</span><h2>Parts, plates and workstreams</h2><p>Plan quantities and track each piece of work. Record actual stock use separately.</p></div>
    <BuildPlanning key={`build:${project.id}:${project.serverRevisionId}`} project={project} items={items} />
    <WorkstreamPlanning key={`work:${project.id}`} project={project} />
  </div>;
}
export function ProjectQuoteTools({ project, onPlan }: { project: Project; onPlan?: (() => void) | undefined }) {
  return <RequirementSourcing key={`${project.id}:${project.serverRevisionId}`} project={project} onPlan={onPlan} />;
}
