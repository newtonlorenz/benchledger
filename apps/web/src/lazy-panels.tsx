import type { ComponentProps } from "react";
import { deferView } from "./deferred-view";
import type { MakerPlanningTools as MakerPlanningToolsType, ProjectQuoteTools as ProjectQuoteToolsType } from "./maker-planning-ui";
import type { ReconciliationUI as ReconciliationUIType } from "./reconciliation-ui";

/**
 * Build and sourcing panels that most visits never open load on demand,
 * keeping the first screen's script small. Each wrapper keeps the original
 * component's props and uses the shared deferred-view loading and recovery
 * boundary (Assembly and PCB live in deferred-views.tsx).
 */
export const MakerPlanningTools = deferView<ComponentProps<typeof MakerPlanningToolsType>>(
  () => import("./maker-planning-ui").then((module) => ({ default: module.MakerPlanningTools })),
  { name: "Build tools", loading: "Opening build tools…", recovery: "You can still use the other project sections." },
);
export const ProjectQuoteTools = deferView<ComponentProps<typeof ProjectQuoteToolsType>>(
  () => import("./maker-planning-ui").then((module) => ({ default: module.ProjectQuoteTools })),
  { name: "Supplier quotes", loading: "Opening supplier quotes…", recovery: "You can still use the other project sections." },
);
export const ReconciliationUI = deferView<ComponentProps<typeof ReconciliationUIType>>(
  () => import("./reconciliation-ui").then((module) => ({ default: module.ReconciliationUI })),
  { name: "Used stock review", loading: "Opening used stock review…", recovery: "No stock was changed. You can still use the other project sections." },
);
