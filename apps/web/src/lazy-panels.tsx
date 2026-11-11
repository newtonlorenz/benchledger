import { lazy, Suspense } from "react";
import type { ComponentProps, ComponentType } from "react";
import type { AssemblyWorkspace as AssemblyWorkspaceType } from "./assembly-ui";
import type { ExistingBomImport as ExistingBomImportType } from "./bom-import-ui";
import type { GuidedSetup as GuidedSetupType } from "./guided-setup";
import type { MakerPlanningTools as MakerPlanningToolsType, ProjectQuoteTools as ProjectQuoteToolsType } from "./maker-planning-ui";
import type { ReconciliationUI as ReconciliationUIType } from "./reconciliation-ui";

/**
 * Project tabs and setup dialogs that most visits never open load on demand,
 * keeping the first screen's script small. Each wrapper keeps the original
 * component's props.
 */
function PanelLoading() {
  return <p className="lazy-panel-loading" role="status" aria-live="polite">Loading…</p>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyPanel<C extends ComponentType<any>>(load: () => Promise<C>) {
  const Lazy = lazy(async () => ({ default: await load() }));
  return function LazyPanel(props: ComponentProps<C>) {
    const Component = Lazy as unknown as ComponentType<ComponentProps<C>>;
    return <Suspense fallback={<PanelLoading />}><Component {...props} /></Suspense>;
  };
}

export const AssemblyWorkspace = lazyPanel<typeof AssemblyWorkspaceType>(() => import("./assembly-ui").then((module) => module.AssemblyWorkspace));
export const ExistingBomImport = lazyPanel<typeof ExistingBomImportType>(() => import("./bom-import-ui").then((module) => module.ExistingBomImport));
export const GuidedSetup = lazyPanel<typeof GuidedSetupType>(() => import("./guided-setup").then((module) => module.GuidedSetup));
export const MakerPlanningTools = lazyPanel<typeof MakerPlanningToolsType>(() => import("./maker-planning-ui").then((module) => module.MakerPlanningTools));
export const ProjectQuoteTools = lazyPanel<typeof ProjectQuoteToolsType>(() => import("./maker-planning-ui").then((module) => module.ProjectQuoteTools));
export const ReconciliationUI = lazyPanel<typeof ReconciliationUIType>(() => import("./reconciliation-ui").then((module) => module.ReconciliationUI));
