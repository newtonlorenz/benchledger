import { useEffect, useState } from "react";
import { projectFabricationRoute } from "./project-build-readiness";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";
import type { Project, InventoryItem } from "./domain";
import { StockReservationPlanning } from "./stock-reservation-ui";
import type { BuildFileUpload } from "./build-plan-ui";
import { BuildPlanning } from "./build-plan-ui";
import { WorkstreamPlanning } from "./workstream-ui";
import type { StockReceiptContext } from "./stock-receipt";
import { RequirementSourcing } from "./requirement-sourcing";

export function MakerPlanningTools({ project, items, onRefresh, onUsedStock, onUpload, onApproach, stockReservationsSupported = false }: { project: Project; items: InventoryItem[]; onRefresh(): Promise<boolean>; onUsedStock?: (() => void) | undefined; onUpload?: BuildFileUpload | undefined; onApproach?: (() => void) | undefined; stockReservationsSupported?: boolean }) {
  const printed = projectFabricationRoute(project) === "printed";
  const [planOpen, setPlanOpen] = useState(printed);
  useEffect(() => { if (printed) setPlanOpen(true); }, [printed]);
  const plan = <Disclosure key={`build:${project.id}:${project.serverRevisionId}`} open={planOpen} onOpenChange={setPlanOpen}><DisclosureTrigger>{printed ? "Parts and print plates" : "Parts and print plates, optional"}</DisclosureTrigger><DisclosureContent><BuildPlanning project={project} items={items} onUpload={onUpload} onApproach={onApproach} /></DisclosureContent></Disclosure>;
  const work = <WorkstreamPlanning key={`work:${project.id}`} project={project} onProjectRefresh={onRefresh} />;
  const stock = stockReservationsSupported ? <StockReservationPlanning key={`stock:${project.id}:${project.serverRevisionId}`} project={project} items={items} onRefresh={onRefresh} onUsedStock={onUsedStock} /> : null;
  return <div className="maker-planning-tools build-workspace">
    <div className="workflow-page-heading"><span className="eyebrow">Build planning</span><h2>Parts, plates and workstreams</h2><p>Plan quantities and track each piece of work. Record actual stock use separately.</p></div>
    {printed ? [plan, stock, work] : [work, stock, plan]}
  </div>;
}
export function ProjectQuoteTools({ project, onPlan, onInventory, onMatch }: { project: Project; onPlan?: (() => void) | undefined; onInventory?: ((context: StockReceiptContext) => void) | undefined; onMatch?: ((lineId: string) => void) | undefined }) {
  return <RequirementSourcing key={`${project.id}:${project.serverRevisionId}`} project={project} onPlan={onPlan} onInventory={onInventory} onMatch={onMatch} />;
}
