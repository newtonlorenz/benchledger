import { useState, type ReactNode } from "react";
import { projectFabricationRoute } from "./project-build-readiness";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";
import type { Project, InventoryItem } from "./domain";
import { StockReservationPlanning } from "./stock-reservation-ui";
import type { BuildFileUpload } from "./build-plan-ui";
import { BuildPlanning } from "./build-plan-ui";
import { WorkstreamPlanning } from "./workstream-ui";
import type { StockReceiptContext } from "./stock-receipt";
import { Button } from "./components/ui/button";
import "./specialist-journey.css";
import { RequirementSourcing } from "./requirement-sourcing";

export function MakerPlanningTools({ project, items, onRefresh, onUsedStock, onUpload, onApproach, onParts, onFiles, onAssembly, stockReservationsSupported = false, review }: { project: Project; items: InventoryItem[]; onRefresh(): Promise<boolean>; onUsedStock?: (() => void) | undefined; onUpload?: BuildFileUpload | undefined; onApproach?: (() => void) | undefined; onParts?: (() => void) | undefined; onFiles?: (() => void) | undefined; onAssembly?: (() => void) | undefined; stockReservationsSupported?: boolean; review?: ReactNode }) {
  const printed = projectFabricationRoute(project) === "printed";
  const [planOpen, setPlanOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  // Fetch when first requested; keep visited editors mounted to retain drafts.
  const [tasksVisited, setTasksVisited] = useState(false);
  const changeTasksOpen = (open: boolean) => {
    setTasksOpen(open);
    if (open) setTasksVisited(true);
  };
  const required = project.bom.filter((line) => !line.optional);
  const ready = project.readinessUnavailable ? 0 : required.filter((line) => project.gapEvaluation?.lines.some((gap) => gap.lineId === line.id && gap.decision === "ready")).length;
  const files = project.artifacts.filter((file) => file.status !== "superseded" && file.projectRevisionId === project.serverRevisionId);
  const reviewing = review !== undefined;
  return <div className={`maker-planning-tools build-workspace specialist-journey${reviewing ? " build-review-layout" : ""}`}>
    <section className="build-journey-panel" aria-label="Build journey">
      <div className="workflow-page-heading"><h2>Build plan</h2><p>{project.currentRevision} · Prepare, make, then record.</p></div>
      <ol className="build-journey" aria-label="Build sequence">
        <li><div className="build-journey-step"><h3>Check parts</h3><p>{!required.length ? "Add the parts this build needs." : project.readinessUnavailable || !project.gapEvaluation ? "Check current stock and compatibility." : `${ready} of ${required.length} required parts covered.`}</p>{onParts && <Button variant="ghost" onClick={onParts}>Review parts</Button>}</div></li>
        <li><div className="build-journey-step"><h3>Prepare files</h3><p>{files.length ? `${files.length} current revision file${files.length === 1 ? "" : "s"}.` : "Add files and instructions for this revision."}</p>{onFiles && <Button variant="ghost" onClick={onFiles}>Review build files</Button>}</div></li>
        <li><div className="build-journey-step"><h3>Assemble</h3><p>Follow the assembly order.</p>{onAssembly && <Button variant="ghost" onClick={onAssembly}>Open assembly guide</Button>}</div></li>
        <li><div className="build-journey-step"><h3>Verify the build</h3><p>Check physical fit and function.</p><Button variant="ghost" onClick={() => { changeTasksOpen(true); requestAnimationFrame(() => { const section = document.getElementById(`build-task-groups-${project.id}`); section?.scrollIntoView?.({ block: "start" }); section?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true }); }); }}>Record verification notes</Button></div></li>
        <li aria-current={reviewing ? "step" : undefined}><div className="build-journey-step"><h3>Record actual use</h3><p>Review used, returned or lost stock.</p>{reviewing ? <strong className="build-current-action">Review stock changes</strong> : onUsedStock ? <Button onClick={onUsedStock}>Record actual stock use</Button> : <p>Stock-use recording is unavailable here.</p>}</div></li>
      </ol>
      <p className="build-physical-note">File checks do not confirm a physical build. Setting stock aside does not deduct consumption.</p>
    </section>
    {review}
    <section className="build-advanced-tools" aria-label="Optional build tools">
      <h2>Build tools</h2>
      {stockReservationsSupported && <Disclosure className="build-step-tools"><DisclosureTrigger>Set aside stock for this build</DisclosureTrigger><DisclosureContent><StockReservationPlanning key={`stock:${project.id}:${project.serverRevisionId}`} project={project} items={items} onRefresh={onRefresh} /></DisclosureContent></Disclosure>}
      <Disclosure className="build-step-tools" key={`build:${project.id}:${project.serverRevisionId}`} open={planOpen} onOpenChange={setPlanOpen}><DisclosureTrigger>{printed ? "Parts and print plates" : "Parts and print plates, optional"}</DisclosureTrigger><DisclosureContent><BuildPlanning project={project} items={items} onUpload={onUpload} onApproach={onApproach} /></DisclosureContent></Disclosure>
      <Disclosure className="build-step-tools" open={tasksOpen} onOpenChange={changeTasksOpen}><DisclosureTrigger>Task groups and progress</DisclosureTrigger><DisclosureContent>{tasksVisited && <WorkstreamPlanning key={`work:${project.id}`} project={project} onProjectRefresh={onRefresh} />}</DisclosureContent></Disclosure>
    </section>
  </div>;
}
export function ProjectQuoteTools({ project, onPlan, onInventory, onMatch }: { project: Project; onPlan?: (() => void) | undefined; onInventory?: ((context: StockReceiptContext) => void) | undefined; onMatch?: ((lineId: string) => void) | undefined }) {
  return <RequirementSourcing key={`${project.id}:${project.serverRevisionId}`} project={project} onPlan={onPlan} onInventory={onInventory} onMatch={onMatch} />;
}
