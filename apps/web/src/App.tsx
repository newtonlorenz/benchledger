import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import type * as React from "react";
import { ApiError, createSampleWorkspaceAdapter, createWorkspaceAdapter, MAX_INVENTORY_SEARCH_LENGTH } from "./api";
import type { WorkspaceAdapter } from "./api";
import type { BomInput, CatalogProductDraft, CatalogProductPage, CatalogSearchOptions, ExactInventoryInput, InventoryBulkUpdateInput, InventoryBulkUpdateResult, InventoryCommissionInput, InventoryCreateInput, InventoryKindQuery, InventoryListQuery, InventoryUpdateInput, ProjectCreateInput, ProjectRevisionUpdateInput, RevisionInput, WorkspaceAccess } from "./api";
import { CatalogInventoryFlow, BuildSetupSummary, OwnedItemCombobox, buildFilamentSelection, buildItemEligibility, splitSetupValues } from "./catalog-ui";
import type { BuildConfigInput, CatalogProduct } from "./domain";
import {
  calculateProjectSummary,
  formatMoney,
  formatQuantity,
  getStockLabel,
  inventoryKindOptions,
  exactProductLabel, isExactProductIdentityComplete, isExactProductConfirmed,
  railSteps,
  shoppingEligibleLines,
  shoppingOfferItemIds,
  shoppingEmptyState,
  sumMoneyByCurrency,
  unitDiagnostics
} from "./domain";
import { fabricationRouteLabel, fabricationRouteOptions } from "./domain"; import type { BomDecision, BomLineStatus, FabricationRoute, InventoryCategory, InventoryCondition, InventoryEvidenceState, InventoryItem, Project, StockLabelTone, StockState } from "./domain";
import { offers as fixtureOffers } from "./mock-data";
import { Icon } from "./icons";
import { ReconciliationUI } from "./reconciliation-ui";
import type { ReconciliationViewModel } from "./reconciliation-ui";
import { CategoryManager, CategorySelection, inventoryCategoryFilterOptions, managedCategoryForId, selectedCategoryLabel } from "./category-ui";
import type { CategoryCreateInput, CategoryUpdateInput, ManagedInventoryCategory } from "./category-ui";
import { WorkspaceAccessSection } from "./workspace-access";
import type { ArtifactUploadTarget } from "./artifact-scope";
import { artifactIdentityLabel, artifactRevisionLabel, artifactScopeChoices, artifactScopeIdentity, artifactScopeKey, defaultArtifactScope, filterArtifactsForScope } from "./artifact-scope";
import { InspectionQueuePanel } from "./inspection-ui";
import type { InspectionAction, InspectionCompletionInput, InspectionCompletionPreview, InspectionCompletionResult } from "./inspection-ui";
import { defaultUnitForItemKind, validUnitsForItemKind } from "@benchledger/api-contract";
import { inventoryCandidateLabel, inventoryCandidateText, inventoryDiscriminator } from "./inventory-identity";
export { inventoryCandidateLabel, inventoryDiscriminator } from "./inventory-identity";

type Page = "overview" | "inventory" | "projects" | "capabilities" | "settings";
type ProjectTab = "plan" | "files" | "offers" | "reconciliation";
type ProjectView = "active" | "archived";
type NavigationHistoryState = { readonly projectView?: ProjectView };
type ConnectionState = "loading" | "ready" | "sample" | "unauthenticated" | "offline" | "error";
type PendingRevisionSetup = { readonly projectId: string; readonly revisionId: string; readonly input: BuildConfigInput; };
type ProjectCreateOutcome = "created" | "failed" | "ambiguous";
type ToastTone = "success" | "error"; type VersionedInventoryItem = InventoryItem & { version: number };
type BulkInventorySelection = { readonly items: VersionedInventoryItem[]; readonly onResult: (result: InventoryBulkUpdateResult) => void; };
type InspectionProject = Project & { readonly inspectionActions?: readonly InspectionAction[]; };
type InspectionContextValue = {
  readonly actions: readonly InspectionAction[];
  readonly error?: string;
  readonly onReadInspection: (action: InspectionAction) => Promise<InspectionAction>;
  readonly onPreviewInspection: (action: InspectionAction, input: InspectionCompletionInput) => Promise<InspectionCompletionPreview>;
  readonly onConfirmInspection: (action: InspectionAction, input: InspectionCompletionInput, preview: InspectionCompletionPreview) => Promise<InspectionCompletionResult>;
};
const InspectionContext = createContext<InspectionContextValue | undefined>(undefined);

const ambiguousProjectCreationMessage = "BenchLedger could not confirm whether this project was created. Your details are still here. Retry safely; the same command will be replayed if it committed.";

/** Read the bounded category endpoint to completion without inventing a larger page size. */
export async function loadAllInventoryCategories(adapter: Pick<WorkspaceAdapter, "listInventoryCategories">, limit = 200): Promise<ManagedInventoryCategory[]> {
  const categories: ManagedInventoryCategory[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await adapter.listInventoryCategories({ limit, ...(cursor === undefined ? {} : { cursor }) });
    categories.push(...page.data.map((category) => ({ ...category })));
    const nextCursor = page.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== undefined);
  return categories;
}

function readInventoryUrlState(): { readonly search: string; readonly categoryNodeId: string; readonly kind: InventoryKindQuery | "All"; readonly evidence: InventoryEvidenceState | "All"; readonly availability: "All" | "available" | "unavailable"; } {
  if (typeof window === "undefined") return { search: "", categoryNodeId: "", kind: "All", evidence: "All", availability: "All" };
  const params = new URLSearchParams(window.location.search);
  const categoryNodeId = params.get("unassigned") === "true" ? UNASSIGNED_CATEGORY_FILTER : (params.get("categoryNodeId")?.trim() ?? "");
  const kindValue = params.get("kind");
  const evidenceValue = params.get("evidence");
  const availableValue = params.get("available");
  const kind = inventoryKindOptions.some((option) => option.value === kindValue) ? (kindValue as InventoryKindQuery) : "All";
  const evidenceValues: InventoryEvidenceState[] = ["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"];
  const evidence = evidenceValues.includes(evidenceValue as InventoryEvidenceState) ? (evidenceValue as InventoryEvidenceState) : "All";
  const availability = availableValue === "true" ? "available" : availableValue === "false" ? "unavailable" : "All";
  return { search: params.get("q")?.trim().slice(0, MAX_INVENTORY_SEARCH_LENGTH) ?? "", categoryNodeId, kind, evidence, availability };
} export function readNavigationUrlState(): { page: Page; projectId?: string; tab: ProjectTab; projectView?: ProjectView; } {
  if (typeof window === "undefined") return { page: "overview", tab: "plan" };
  let parts: string[];
  try {
    parts = window.location.hash.replace(/^#\/?/u, "").split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return { page: "overview", tab: "plan" };
  }
  const historyState = window.history.state as NavigationHistoryState | null;
  const projectView: ProjectView | undefined = historyState?.projectView === "active" || historyState?.projectView === "archived" ? historyState.projectView : undefined;
  const page = parts[0];
  if (page === "projects") {
    const tab = (["plan", "files", "offers", "reconciliation"] as ProjectTab[]).includes(parts[2] as ProjectTab) ? (parts[2] as ProjectTab) : "plan";
    return { page, ...(parts[1] ? { projectId: parts[1] } : {}), tab, ...(projectView ? { projectView } : {}) };
  }
  if (page === "inventory" || page === "capabilities" || page === "settings" || page === "overview") return { page, tab: "plan" };
  return { page: "overview", tab: "plan" };
} function navigationHash( page: Page, projectId?: string, tab: ProjectTab = "plan" ): string { if (page === "overview") return "#/"; if (page !== "projects") return `#/${page}`; if (!projectId) return "#/projects"; return `#/projects/${encodeURIComponent(projectId)}/${tab}`; } const pageCopy: Record<Page, { label: string; icon: Parameters<typeof Icon>[0]["name"] }> = {
  overview: { label: "Workbench", icon: "grid" },
  inventory: { label: "Inventory", icon: "box" },
  projects: { label: "Projects", icon: "folder" },
  capabilities: { label: "For agents", icon: "spark" },
  settings: { label: "Settings", icon: "settings" }
};

const technicalDetailsPreferenceKey = "benchledger:technical-details"; function readTechnicalDetailsPreference(): boolean { if (typeof window === "undefined") return false; try { return ( window.localStorage.getItem(technicalDetailsPreferenceKey) === "shown" ); } catch { return false; } } const categoryIcons: Record<InventoryCategory, Parameters<typeof Icon>[0]["name"]> = {
  Printers: "layers",
  Filament: "spool",
  Tools: "tool",
  Accessories: "wrench",
  Electronics: "circuit",
  Fasteners: "link",
  "Wire & cable": "link"
};
const UNASSIGNED_CATEGORY_FILTER = "__unassigned__"; const inventoryStatusOptions = [ { value: "All", label: "All stock records" }, { value: "physically_counted", label: "Physically counted" }, { value: "commissioned", label: "Commissioned" }, { value: "delivered_uncounted", label: "Delivered, not counted" }, { value: "ordered_unverified", label: "Ordered, not verified" }, { value: "allocated", label: "Reserved for a project" }, { value: "consumed", label: "Used" }, { value: "unknown", label: "Not checked yet" } ] as const; const inventoryEvidenceOptions = [ { value: "All", label: "All evidence" }, { value: "physically_counted", label: "Physically counted" }, { value: "commissioned", label: "Commissioned" }, { value: "delivered_uncounted", label: "Delivered, not counted" }, { value: "ordered_unverified", label: "Ordered, not verified" }, { value: "allocated", label: "Reserved for a project" }, { value: "consumed", label: "Used" }, { value: "unknown", label: "Not checked yet" } ] as const; function displayedInventoryState(item: InventoryItem): StockState {
  return item.unitStatus === "needs_correction" ? "inspect-first" : item.state;
} /** Keep missing storage metadata distinct from a real location label. */ export function inventoryLocationLabel(location: string | undefined): string { const value = location?.trim(); return !value || value === "Unassigned" ? "No location" : value; } /** Keep the canonical project lifecycle readable without exposing storage keys. */
export function projectLifecycleLabel(status: Project["status"]): string {
  const labels: Record<Project["status"], string> = {
    idea: "Idea",
    planned: "Planned",
    ready: "Ready",
    building: "Building",
    validating: "Validating",
    complete: "Complete",
    archived: "Archived"
  };
  return labels[status];
}

/** One beginner decision vocabulary for every requirement state. */
export function decisionDisplay(decision: BomDecision | "optional"): { label: string; tone: StockLabelTone; } {
  switch (decision) {
    case "ready": return { label: "Ready", tone: "good" };
    case "check": return { label: "Check", tone: "warn" };
    case "decide": return { label: "Decide", tone: "info" };
    case "source": return { label: "Source", tone: "bad" };
    case "optional": return { label: "Optional", tone: "muted" };
  }
}

export function formatRequirementCount(count: number): string {
  const normalized = Math.max(0, Math.trunc(count));
  return `${normalized} requirement${normalized === 1 ? "" : "s"}`;
}

export function formatRequirementSourcingMessage(count: number): string {
  const normalized = Math.max(0, Math.trunc(count));
  if (normalized === 0) return "No requirements need sourcing";
  return `${formatRequirementCount(normalized)} ${normalized === 1 ? "needs" : "need"} sourcing`;
}

export function formatRequirementCheckMessage(count: number): string {
  const normalized = Math.max(0, Math.trunc(count));
  if (normalized === 0) return "No requirements need a physical or compatibility check";
  return `${formatRequirementCount(normalized)} ${normalized === 1 ? "needs" : "need"} a physical or compatibility check`;
}

export function formatRequirementDecisionMessage(count: number): string {
  const normalized = Math.max(0, Math.trunc(count));
  if (normalized === 0) return "No requirements need a decision";
  return `${formatRequirementCount(normalized)} ${normalized === 1 ? "needs" : "need"} a decision`;
}

export function formatSourceReadyMessage(count: number): string {
  const normalized = Math.max(0, Math.trunc(count));
  if (normalized === 0) return "No requirements need sourcing";
  return `${formatRequirementCount(normalized)} ${normalized === 1 ? "still needs" : "still need"} sourcing`;
} /** Keep machine-stored specification keys readable in maker-facing copy. */ export function humanizeSpecificationDecision(value: string): string { return value .replaceAll("_", " ") .replace(/\s+/gu, " ") .trim() .toLocaleLowerCase(); } function beginnerInspectDescription(line: BomLineStatus): string { const item = line.item; const evidence = item?.serverEvidence ?? (item?.evidence === "delivered" ? "delivered_uncounted" : item?.evidence === "ordered" ? "ordered_unverified" : undefined); if ( item && (evidence === "delivered_uncounted" || evidence === "ordered_unverified") ) { return `Count ${item.name} before you use it.`; } const reasonText = line.gap?.reasons.join(" ").toLocaleLowerCase() ?? ""; if ( item && (reasonText.includes("compatib") || reasonText.includes("match")) ) { return `Check that ${item.name} matches ${line.line.label}.`; } if (item) return `Check ${item.name} before you use it.`; return "Check this requirement before you use it."; } function App() {
  const initialNavigation = useRef(readNavigationUrlState()).current; const [adapter, setAdapter] = useState<WorkspaceAdapter>(() => createWorkspaceAdapter());
  const [page, setPage] = useState<Page>(initialNavigation.page);
  const [projects, setProjects] = useState<Project[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const projectViewRef = useRef<ProjectView>("active");
  const [projectView, setProjectViewState] = useState<ProjectView>("active");
  const setProjectView = (next: ProjectView | ((current: ProjectView) => ProjectView)) => {
    if (typeof next !== "function") projectViewRef.current = next;
    setProjectViewState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      projectViewRef.current = resolved;
      return resolved;
    });
  };
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [offers, setOffers] = useState(fixtureOffers);
  const [selectedProjectId, setSelectedProjectId] = useState( initialNavigation.projectId ?? "project-lamp");
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [projectTab, setProjectTab] = useState<ProjectTab>( initialNavigation.tab );
  const [search, setSearch] = useState(() => readInventoryUrlState().search);
  const [expert, setExpert] = useState(readTechnicalDetailsPreference);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToastMessage] = useState<string>();
  const [toastTone, setToastTone] = useState<ToastTone>("success"); const [toastNonce, setToastNonce] = useState(0); const setToast = (message: string, tone: ToastTone = "success") => { setToastTone(tone); setToastMessage(message); setToastNonce((current) => current + 1); }; const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [connectionError, setConnectionError] = useState<ApiError>();
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [sampleMode, setSampleMode] = useState(false);
  const [workspaceAccess, setWorkspaceAccess] = useState<WorkspaceAccess>();
  const [serviceCapabilities, setServiceCapabilities] = useState< readonly string[] >([]); const [reloadNonce, setReloadNonce] = useState(0);
  const [categoryReloadNonce, setCategoryReloadNonce] = useState(0);
  const [inventoryRefreshNonce, setInventoryRefreshNonce] = useState(0);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewRevision, setShowNewRevision] = useState(false);
  const [showEditBuildApproach, setShowEditBuildApproach] = useState(false);
  const [showAddBom, setShowAddBom] = useState(false); const [showNewItem, setShowNewItem] = useState(false);
  const [replacementFor, setReplacementFor] = useState<InventoryItem>();
  const [bulkInventorySelection, setBulkInventorySelection] = useState<BulkInventorySelection>();
  const [bulkSelectionResetNonce, setBulkSelectionResetNonce] = useState(0);
  const [pendingRevisionSetup, setPendingRevisionSetup] = useState<PendingRevisionSetup>();
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogProducts, setCatalogProducts] = useState<CatalogProduct[]>([]);
  const [categories, setCategories] = useState<ManagedInventoryCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoriesError, setCategoriesError] = useState<string>();
  const catalogSearchSequence = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchLauncherRef = useRef<HTMLButtonElement>(null);
  const searchHandoffRef = useRef(false);
  const mainRef = useRef<HTMLElement>(null); const mainFocusFrameRef = useRef<number | undefined>(undefined); const pendingMainFocusRef = useRef(false); const newProjectTriggerRef = useRef<HTMLButtonElement>(null);

  const bootstrapWorkspace = async () => {
    let access: WorkspaceAccess | undefined;
    try {
      access = await adapter.getWorkspaceAccess();
      setWorkspaceAccess(access);
      if (access.mode === "lan_open" && !access.demo) await adapter.openLanSession();
    } catch (error) {
      // Older local services do not expose the optional access endpoint yet.
      // Keep their existing password flow usable while the service is upgraded.
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    return adapter.loadWorkspace();
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setConnection("loading");
    bootstrapWorkspace().then(async (snapshot) => {
      if (!active) return;
      const archived = await adapter.listArchivedProjects().catch((error: unknown) => error instanceof ApiError && error.status === 404 ? [] : Promise.reject(error));
      setItems(snapshot.inventory);
      setProjects(snapshot.projects);
      setArchivedProjects(archived);
      const requestedNavigation = readNavigationUrlState();
      const initialProjectView: ProjectView = requestedNavigation.projectView ?? (requestedNavigation.projectId && archived.some( (project) => project.id === requestedNavigation.projectId ) ? "archived" : snapshot.projects.length > 0 || archived.length === 0 ? "active" : "archived");
      setProjectView(initialProjectView);
      setOffers(snapshot.offers); setServiceCapabilities(snapshot.capabilities ?? []); const requestedProjectId = requestedNavigation.projectId; const selectedId = requestedProjectId && [...snapshot.projects, ...archived].some( (project) => project.id === requestedProjectId ) ? requestedProjectId : (initialProjectView === "archived" ? (archived[0]?.id ?? "") : (snapshot.projects[0]?.id ?? archived[0]?.id ?? "")); setSelectedProjectId(selectedId); if ( requestedNavigation.page === "projects" && selectedId !== requestedProjectId ) { window.history.replaceState( { projectView: initialProjectView }, "", navigationHash("projects", selectedId, requestedNavigation.tab) ); } setSampleMode(snapshot.source === "synthetic");
      setWorkspaceAccess((current) => current ? { ...current, demo: current.demo || Boolean(snapshot.health?.demo) } : current);
      setDemoAvailable(Boolean(snapshot.health?.demo));
      setConnection(snapshot.source === "synthetic" ? "sample" : "ready");
      setConnectionError(undefined);
      setLoading(false);
    }).catch((error: unknown) => {
      if (!active) return;
      const normalized = normalizeApiError(error);
      if (normalized.kind === "unauthenticated") {
        handleSessionExpiry(normalized);
      } else {
        setConnectionError(normalized);
      }
      setDemoAvailable((current) => current || Boolean(normalized.demo));
      setConnection(normalized.kind === "unauthenticated" ? "unauthenticated" : normalized.kind === "offline" ? "offline" : "error");
      setLoading(false);
    });
    return () => { active = false; };
  }, [adapter, reloadNonce]);

  useEffect(() => {
    if (connection === "loading" || connection === "unauthenticated") return;
    let active = true;
    setCategoriesLoading(true);
    setCategoriesError(undefined);
    loadAllInventoryCategories(adapter).then((result) => {
      if (!active) return;
      setCategories(result);
    }).catch((error: unknown) => {
      if (!active) return;
      setCategoriesError(normalizeApiError(error).message);
    }).finally(() => { if (active) setCategoriesLoading(false); });
    return () => { active = false; };
  }, [adapter, connection, categoryReloadNonce]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToastMessage(undefined), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast, toastNonce]); useEffect(() => { try { window.localStorage.setItem( technicalDetailsPreferenceKey, expert ? "shown" : "hidden" ); } catch { // A restricted browser storage policy should not prevent changing the view.
} }, [expert]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (page === "inventory") { if (mainFocusFrameRef.current !== undefined) { window.cancelAnimationFrame(mainFocusFrameRef.current); mainFocusFrameRef.current = undefined; } searchInputRef.current?.focus(); } else {
          searchLauncherRef.current?.focus();
          launchInventorySearch();
        }
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [page]);

  useLayoutEffect(() => {
    if (page !== "inventory" || !searchHandoffRef.current) return;
    if (mainFocusFrameRef.current !== undefined) { window.cancelAnimationFrame(mainFocusFrameRef.current); mainFocusFrameRef.current = undefined; } const input = searchInputRef.current;
    if (!input) return;
    const frame = window.requestAnimationFrame(() => {
      searchHandoffRef.current = false;
      input.focus();
      const caret = input.value.length;
      input.setSelectionRange(caret, caret);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [page]);

  const visibleProjects = projectView === "archived" ? archivedProjects : projects;
  const selectedProject = visibleProjects.find((project) => project.id === selectedProjectId) ?? visibleProjects[0];
  const selectedItem = items.find((item) => item.id === selectedItemId);
  const overlayOpen = Boolean(selectedItem || showNewProject || showNewRevision || showEditBuildApproach || showAddBom || showNewItem || bulkInventorySelection);

  const resetMainScrollAndFocus = () => { if (typeof window !== "undefined") window.scrollTo({ top: 0, left: 0, behavior: "auto" }); const main = mainRef.current; if (!main) return; main.scrollTop = 0; main.scrollLeft = 0; if (mainFocusFrameRef.current !== undefined) { window.cancelAnimationFrame(mainFocusFrameRef.current); mainFocusFrameRef.current = undefined; } main.focus({ preventScroll: true });
  }; useLayoutEffect(() => {
    if (!pendingMainFocusRef.current) return; pendingMainFocusRef.current = false; resetMainScrollAndFocus();
  }, [page, selectedProjectId, projectTab, projectView]); useEffect(() => { const restoreNavigation = () => { const restored = readNavigationUrlState(); pendingMainFocusRef.current = true; const restoredView: ProjectView = restored.projectView ?? (restored.projectId && archivedProjects.some((project) => project.id === restored.projectId) ? "archived" : restored.page === "projects" && projects.length === 0 && archivedProjects.length > 0 ? "archived" : "active"); setProjectView(restoredView); setPage(restored.page); setProjectTab(restored.tab); if (restored.projectId) setSelectedProjectId(restored.projectId); else if (restored.page === "projects") setSelectedProjectId((restoredView === "archived" ? archivedProjects : projects)[0]?.id ?? ""); setMobileNav(false); setSelectedItemId(undefined); }; window.addEventListener("popstate", restoreNavigation); window.addEventListener("hashchange", restoreNavigation); return () => { window.removeEventListener("popstate", restoreNavigation); window.removeEventListener("hashchange", restoreNavigation);
  }; }, [archivedProjects, projects]); const recordNavigation = ( nextPage: Page, projectId = selectedProjectId, tab = projectTab, view: ProjectView = projectViewRef.current ) => { const intraProjectTabNavigation = nextPage === "projects" && projectId === selectedProjectId && tab !== projectTab; if (intraProjectTabNavigation) pendingMainFocusRef.current = false; const nextView = nextPage === "projects" ? archivedProjects.some((project) => project.id === projectId) ? "archived" : projects.some((project) => project.id === projectId) ? "active" : view : view; const nextHash = navigationHash(nextPage, projectId, tab); const currentState = window.history.state as NavigationHistoryState | null; const nextState: NavigationHistoryState = nextPage === "projects" ? { projectView: nextView } : {}; const sameView = nextPage !== "projects" || currentState?.projectView === nextView; if (window.location.hash !== nextHash || !sameView) window.history.pushState(nextState, "", nextHash);
  };

  const navigate = (nextPage: Page) => { pendingMainFocusRef.current = !searchHandoffRef.current; recordNavigation(nextPage); setPage(nextPage); setMobileNav(false); setSelectedItemId(undefined); if (nextPage === page) resetMainScrollAndFocus(); }; const openProject = (projectId: string, tab: ProjectTab = "plan") => { pendingMainFocusRef.current = true; recordNavigation("projects", projectId, tab); setSelectedProjectId(projectId); setProjectTab(tab); setPage("projects"); setMobileNav(false); }; const selectProject = (projectId: string) => openProject(projectId, projectTab); const selectProjectTab = (tab: ProjectTab, replace = false) => { const nextHash = navigationHash("projects", selectedProjectId, tab); if (replace) window.history.replaceState({}, "", nextHash); else recordNavigation("projects", selectedProjectId, tab); setProjectTab(tab); }; const changeProjectView = (view: "active" | "archived") => { const nextProjectId = (view === "archived" ? archivedProjects : projects)[0]?.id ?? ""; setProjectView(view); if (nextProjectId) openProject(nextProjectId, projectTab); else { recordNavigation("projects", "", projectTab); setSelectedProjectId(""); } }; const launchInventorySearch = () => { if (page === "inventory") { if (mainFocusFrameRef.current !== undefined) { window.cancelAnimationFrame(mainFocusFrameRef.current); mainFocusFrameRef.current = undefined; } searchInputRef.current?.focus(); return; } searchHandoffRef.current = true; navigate("inventory"); }; const openNewProject = (event: React.MouseEvent<HTMLButtonElement>) => { newProjectTriggerRef.current = event.currentTarget; setShowNewProject(true); }; const closeNewProject = () => { setShowNewProject(false); const trigger = newProjectTriggerRef.current; if (trigger) window.setTimeout(() => trigger.focus(), 32); }; const openNewPrinter = () => { setReplacementFor(undefined); setShowNewItem(true); }; const openNewPrinterDetails = (item: InventoryItem) => { setReplacementFor(item); setShowNewItem(true); }; const closeNewItem = () => { catalogSearchSequence.current += 1; setCatalogQuery(""); setCatalogProducts([]); setShowNewItem(false); setReplacementFor(undefined); }; const retryConnection = () => { setConnectionError(undefined); setReloadNonce((current) => current + 1); }; const refreshWorkspace = async (): Promise<boolean> => { try { const snapshot = await adapter.loadWorkspace();
      const archived = await adapter.listArchivedProjects().catch((error: unknown) => error instanceof ApiError && error.status === 404 ? [] : Promise.reject(error));
      setItems(snapshot.inventory);
      setProjects(snapshot.projects);
      setArchivedProjects(archived);
      setProjectView((current) => snapshot.projects.length > 0 || archived.length === 0 ? current : "archived");
      setSelectedProjectId((current) => snapshot.projects.some((project) => project.id === current) || archived.some((project) => project.id === current) ? current : ((snapshot.projects[0] ?? archived[0])?.id ?? "") );
      setOffers(snapshot.offers); setServiceCapabilities(snapshot.capabilities ?? []); setSampleMode(snapshot.source === "synthetic");
      setWorkspaceAccess((current) => current ? { ...current, demo: current.demo || Boolean(snapshot.health?.demo) } : current);
      setDemoAvailable(Boolean(snapshot.health?.demo));
      setConnection(snapshot.source === "synthetic" ? "sample" : "ready");
      setConnectionError(undefined);
      setInventoryRefreshNonce((current) => current + 1);
      return true;
    } catch (error: unknown) {
      // A close-out commit is already durable by the time this refresh runs.
      // Keep the current project/reconciliation visible and let the caller
      // report refresh trouble separately from the successful commit.
      setConnectionError(normalizeApiError(error));
      return false;
    }
  };

  const archiveProject = async (project: Project) => {
    try {
      const archived = await adapter.archiveProject(project.id, project.version);
      const remaining = projects.filter((candidate) => candidate.id !== project.id);
      setProjects(remaining);
      setArchivedProjects((current) => [archived, ...current.filter((candidate) => candidate.id !== archived.id)]); const nextId = remaining[0]?.id ?? archived.id; const nextView: ProjectView = remaining.length > 0 ? "active" : "archived"; setProjectView(nextView);
      setSelectedProjectId(nextId); window.history.replaceState( { projectView: nextView }, "", navigationHash("projects", nextId, projectTab) );
      setToast(expert ? "Project archived. It is hidden from active lists; reservations were released, audit history was retained, and the archive is reversible." : "Project archived. It is hidden from active lists; stock set aside for it was released, its project history was kept, and it can be restored.");
    } catch (error: unknown) {
      handleMutationError(error, "archiving that project");
      throw error;
    }
  };

  const restoreProject = async (project: Project) => {
    try {
      const restored = await adapter.restoreProject(project.id, project.version);
      setArchivedProjects((current) => current.filter((candidate) => candidate.id !== project.id));
      setProjects((current) => [restored, ...current.filter((candidate) => candidate.id !== restored.id)]);
      setProjectView("active");
      setSelectedProjectId(restored.id); window.history.replaceState( { projectView: "active" }, "", navigationHash("projects", restored.id, projectTab) ); setToast(expert ? `${project.name} was restored to Idea. Released reservations were not recreated.` : `${project.name} was restored to Idea. Previously released stock was not set aside again.`);
    } catch (error: unknown) {
      handleMutationError(error, "restoring that project");
      throw error;
    }
  };

  const removeProject = async (project: Project) => {
    try {
      await adapter.removeProject(project.id, project.version);
      const remainingProjects = projects.filter((candidate) => candidate.id !== project.id);
      const remainingArchived = archivedProjects.filter((candidate) => candidate.id !== project.id);
      setProjects(remainingProjects);
      setArchivedProjects(remainingArchived);
      const nextView: ProjectView = remainingProjects.length > 0 ? "active" : remainingArchived.length > 0 ? "archived" : "active"; setProjectView(nextView); const nextId = (remainingProjects[0] ?? remainingArchived[0])?.id ?? ""; setSelectedProjectId(nextId); window.history.replaceState( { projectView: nextView }, "", navigationHash("projects", nextId, projectTab) );
      setToast(expert ? "Project permanently removed from the workspace. Its reservation releases and audit history remain retained; it cannot be restored." : "Project permanently removed from the workspace. Its project history was kept, but it cannot be restored.");
    } catch (error: unknown) {
      handleMutationError(error, "removing that project");
      throw error;
    }
  };

  const useSampleWorkspace = () => {
    setConnectionError(undefined);
    setAdapter(createSampleWorkspaceAdapter());
  };

  const returnToPrivateWorkspace = () => {
    setSampleMode(false);
    setConnectionError(undefined);
    setLoading(true);
    setConnection("loading");
    setAdapter(createWorkspaceAdapter());
  };

  const signIn = async (password: string) => {
    try {
      await adapter.login(password);
      setSampleMode(false);
      setConnectionError(undefined);
      setReloadNonce((current) => current + 1);
    } catch (error: unknown) {
      const normalized = normalizeApiError(error);
      setConnectionError(normalized);
      setDemoAvailable((current) => current || Boolean(normalized.demo));
      setConnection(normalized.kind === "offline" ? "offline" : normalized.kind === "unauthenticated" ? "unauthenticated" : "error");
      setLoading(false);
      throw normalized;
    }
  };

  const signOut = async () => {
    try {
      await adapter.logout();
      setItems([]);
      setProjects([]);
      setArchivedProjects([]);
      setOffers([]); setServiceCapabilities([]); setPendingRevisionSetup(undefined);
      setSampleMode(false);
      setConnectionError(undefined);
      setConnection("unauthenticated");
    } catch (error: unknown) {
      handleMutationError(error, "signing out");
    }
  };

  const clearAuthenticatedWorkspace = () => {
    adapter.clearAuthenticatedState();
    setItems([]);
    setProjects([]);
    setArchivedProjects([]);
    setOffers([]); setServiceCapabilities([]); setPendingRevisionSetup(undefined);
    setSelectedItemId(undefined);
    setCatalogQuery("");
    setCatalogProducts([]);
  };

  const handleSessionExpiry = (error: unknown): ApiError => {
    const normalized = normalizeApiError(error);
    if (!sampleMode) {
      clearAuthenticatedWorkspace();
      setConnectionError(normalized);
      setConnection("unauthenticated");
    }
    return normalized;
  };

  const handleMutationError = (error: unknown, action: string) => {
    const normalized = normalizeApiError(error);
    if (!sampleMode && (normalized.kind === "unauthenticated" || normalized.kind === "csrf")) {
      handleSessionExpiry(normalized);
    } else {
      setConnectionError(normalized);
    }
    setToast(writeFailureMessage(normalized, action), "error");
  };

  const refreshProjectReadiness = async (): Promise<boolean> => {
    setProjects((current) => current.map(({ gapEvaluation: _stale, readinessUnavailable: _previousFailure, ...project }) => ({ ...project, readinessUnavailable: true })));
    try {
      const refreshed = await adapter.refreshProjectReadiness();
      setProjects(refreshed);
      return true;
    } catch (error: unknown) {
      const normalized = normalizeApiError(error);
      if (!sampleMode && (normalized.kind === "unauthenticated" || normalized.kind === "csrf")) handleSessionExpiry(normalized);
      else setConnectionError(normalized);
      setToast("Inventory was saved, but the latest stock results could not be loaded. Reload before preparing a Source proposal.");
      return false;
    }
  };

  const recordCount = async (itemId: string, quantity: number): Promise<InventoryItem> => {
    try {
      const result = await adapter.recordCount(itemId, quantity);
      setItems((current) => current.map((item) => (item.id === itemId ? result : item)) );
      setInventoryRefreshNonce((current) => current + 1);
      if (await refreshProjectReadiness()) setToast(`Saved physical count: ${formatQuantity(result.quantity, result.unit)} for ${result.name}.`);
      return result;
    } catch (error: unknown) {
      handleMutationError(error, "recording that count");
      throw error;
    }
  };

  const commissionInventoryItem = async (itemId: string, input: InventoryCommissionInput, expectedVersion: number): Promise<InventoryItem> => {
    try {
      const result = await adapter.commissionInventoryItem(itemId, input, expectedVersion);
      setItems((current) => current.map((item) => (item.id === itemId ? result : item)) );
      if (await refreshProjectReadiness()) setToast(`Commissioned ${result.name} with ${formatQuantity(result.quantity, result.unit)} observed stock.`);
      return result;
    } catch (error: unknown) {
      handleMutationError(error, "commissioning that inventory");
      throw error;
    }
  };

  const updateInventoryItem = async (itemId: string, input: Partial<InventoryUpdateInput>, expectedVersion?: number): Promise<InventoryItem> => {
    try {
      const result = await adapter.updateInventoryItem(itemId, input, expectedVersion);
      setItems((current) => current.map((item) => (item.id === itemId ? result : item)) );
      setInventoryRefreshNonce((current) => current + 1);
      if (await refreshProjectReadiness()) setToast(`Saved changes to ${result.name}.`);
      return result;
    } catch (error: unknown) {
      handleMutationError(error, "saving that inventory item");
      throw error;
    }
  };

  const bulkUpdateInventory = async (input: InventoryBulkUpdateInput): Promise<InventoryBulkUpdateResult> => {
    try {
      const result = await adapter.bulkUpdateInventory(input);
      const returned = new Map([...result.updated, ...result.unchanged].map((item) => [item.id, item] as const));
      setItems((current) => current.map((item) => returned.get(item.id) ?? item));
      await refreshProjectReadiness();
      return result;
    } catch (error: unknown) {
      const normalized = normalizeApiError(error);
      setConnectionError(normalized);
      if (!sampleMode && (normalized.kind === "unauthenticated" || normalized.kind === "csrf")) {
        setConnection("unauthenticated");
        setItems([]);
        setProjects([]);
        setOffers([]);
      }
      throw normalized;
    }
  };

  const applyBulkInventory = async (input: InventoryBulkUpdateInput): Promise<InventoryBulkUpdateResult> => {
    const result = await bulkUpdateInventory(input);
    bulkInventorySelection?.onResult(result);
    window.setTimeout(() => setInventoryRefreshNonce((current) => current + 1), 0);
    return result;
  };

  const closeBulkInventory = () => {
    setBulkInventorySelection(undefined);
    setBulkSelectionResetNonce((current) => current + 1);
  };

  const createProject = async (input: ProjectCreateInput ): Promise<ProjectCreateOutcome> => {
    try {
      const project = await adapter.createProject(input);
      setProjects((current) => [project, ...current]); pendingMainFocusRef.current = true; recordNavigation("projects", project.id, "plan"); setSelectedProjectId(project.id); setProjectTab("plan"); setShowNewProject(false);
      setPage("projects");
      setToast(`${project.name} is ready for its first requirements.`);
      return "created";
    } catch (error: unknown) {
      const normalized = normalizeApiError(error);
      if (isAmbiguousMutation(normalized)) {
        setConnectionError(normalized);
        setToast(ambiguousProjectCreationMessage);
        return "ambiguous";
      }
      handleMutationError(normalized, "creating that project");
      return "failed";
    }
  };

  const createRevision = async (input: RevisionInput): Promise<boolean> => {
    if (!selectedProject) return false;
    try {
      const { buildConfig, ...revisionInput } = input;
      const project = await adapter.createRevision(selectedProject.id, revisionInput);
      let updatedProject = project;
      if (buildConfig?.printerItemId && buildConfig.printerProductId && project.serverRevisionId) {
        try {
          const snapshot = await adapter.createBuildConfigSnapshot(selectedProject.id, project.serverRevisionId, buildConfig);
          updatedProject = { ...project, buildConfigSnapshot: snapshot };
          setPendingRevisionSetup((current) => current?.projectId === project.id ? undefined : current);
        } catch (error: unknown) {
          // Revision creation is durable and already succeeded. Surface that
          // revision immediately, close the create dialog, and retain the
          // setup command for an explicit retry so a failed setup cannot be
          // retried by accidentally creating a second revision.
          const normalized = normalizeApiError(error);
          setProjects((current) => current.map((candidate) => candidate.id === project.id ? project : candidate));
          setSelectedProjectId(project.id);
          setPendingRevisionSetup({ projectId: project.id, revisionId: project.serverRevisionId, input: buildConfig });
          setShowNewRevision(false);
          setConnectionError(normalized);
          setToast("Revision created. The setup save was not confirmed. Retry setup; BenchLedger will check the saved result before creating anything twice.");
          return true;
        }
      } else {
        setPendingRevisionSetup((current) => current?.projectId === project.id ? undefined : current);
      }
      setProjects((current) => current.map((candidate) => candidate.id === updatedProject.id ? updatedProject : candidate));
      setShowNewRevision(false);
      setToast(`${updatedProject.name} is now on ${updatedProject.currentRevision}.${updatedProject.buildConfigSnapshot ? (expert ? " Setup was saved as an immutable snapshot." : " A read-only setup record was saved for this revision.") : ""}`);
      return true;
    } catch (error: unknown) {
      handleMutationError(error, "creating that revision");
      return false;
    }
  };

  const updateBuildApproach = async ( input: ProjectRevisionUpdateInput ): Promise<boolean> => { if (!selectedProject?.serverRevisionId) return false; try { const updated = await adapter.updateProjectRevision( selectedProject.serverRevisionId, input, selectedProject.serverRevisionVersion ); setProjects((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate ) ); setArchivedProjects((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate ) ); setShowEditBuildApproach(false); const refreshed = await refreshWorkspace(); setToast( refreshed ? "Build approach saved." : "Build approach saved, but the workspace refresh failed. Reload before continuing.", refreshed ? "success" : "error" ); return true; } catch (error: unknown) { handleMutationError(error, "updating that build approach"); return false; } }; const retryRevisionSetup = async () => {
    const pending = pendingRevisionSetup;
    if (!pending) return;
    const project = projects.find((candidate) => candidate.id === pending.projectId);
    if (!project || project.serverRevisionId !== pending.revisionId) {
      setPendingRevisionSetup(undefined);
      setToast("That revision is no longer the current project revision. Reload before retrying its setup.");
      return;
    }
    try {
      const snapshot = await adapter.createBuildConfigSnapshot(pending.projectId, pending.revisionId, pending.input);
      setProjects((current) => current.map((candidate) => candidate.id === pending.projectId ? { ...candidate, buildConfigSnapshot: snapshot } : candidate));
      setPendingRevisionSetup(undefined);
      setToast(`${project.name} build setup was saved to ${project.currentRevision}.`);
    } catch (error: unknown) {
      const normalized = normalizeApiError(error);
      if (isAmbiguousMutation(normalized)) {
        setConnectionError(normalized);
        setToast("The setup save was not confirmed. Retry setup; BenchLedger will check the saved result before creating anything twice.");
      } else {
        handleMutationError(normalized, "saving that revision setup");
      }
    }
  };

  const addBomLine = async (input: BomInput): Promise<boolean> => {
    if (!selectedProject) return false;
    try {
      const project = await adapter.createBomLine(selectedProject.id, input);
      setProjects((current) => current.map((candidate) => candidate.id === project.id ? project : candidate));
      setShowAddBom(false);
      setToast(`${input.name} was added to ${project.currentRevision}.`);
      return true;
    } catch (error: unknown) {
      handleMutationError(error, "adding that requirement");
      return false;
    }
  };

  const resolveBomLineRole = async ( lineId: string, role: "consumed" | "reusable", expectedVersion: number ) => { if (!selectedProject) return; try { const project = await adapter.updateBomLineRole( selectedProject.id, lineId, role, expectedVersion ); setProjects((current) => current.map((candidate) => candidate.id === project.id ? project : candidate ) ); const saved = role === "consumed" ? "Requirement marked as a part or material." : "Requirement marked as a reusable tool or equipment."; setToast( project.readinessUnavailable ? `${saved} Stock status could not refresh; reload before sourcing.` : saved, project.readinessUnavailable ? "error" : "success" ); } catch (error: unknown) { handleMutationError(error, "updating how that requirement is used"); } }; const uploadArtifact = async (projectId: string, file: File, role: string, target?: ArtifactUploadTarget) => {
    try {
      const project = await adapter.uploadArtifact(projectId, file, role, target);
      setProjects((current) => current.map((candidate) => candidate.id === project.id ? project : candidate));
      setToast(`${file.name} was uploaded to ${target ? artifactScopeIdentity(target, expert) : expert ? `Project · ${project.serverRevisionId ?? project.currentRevision}` : "the project revision"}.`);
    } catch (error: unknown) {
      handleMutationError(error, "uploading that file");
      throw normalizeApiError(error);
    }
  };

  const addInventoryItem = async (input: InventoryCreateInput ): Promise<boolean> => {
    try {
      const item = await adapter.createInventoryItem(input);
      setItems((current) => [item, ...current]);
      setInventoryRefreshNonce((current) => current + 1); closeNewItem();
      if (await refreshProjectReadiness()) setToast(`${item.name} added as Check. Record a physical count before reserving it.`);
      return true;
    } catch (error: unknown) {
      handleMutationError(error, "adding that inventory item");
      return false;
    }
  };

  const createInventoryCategory = async (input: CategoryCreateInput): Promise<ManagedInventoryCategory | undefined> => {
    try {
      const category = await adapter.createInventoryCategory(input);
      setCategories((current) => [...current, category]);
      return category;
    } catch (error: unknown) {
      const normalized = normalizeApiError(error);
      throw normalized;
    }
  };

  const updateInventoryCategory = async (id: string, input: CategoryUpdateInput, expectedVersion: number): Promise<ManagedInventoryCategory | undefined> => {
    try {
      const category = await adapter.updateInventoryCategory(id, input, expectedVersion);
      setCategories((current) => current.map((candidate) => candidate.id === id ? category : candidate));
      return category;
    } catch (error: unknown) {
      const normalized = normalizeApiError(error);
      if (normalized.code === "version_conflict") setCategoryReloadNonce((current) => current + 1);
      throw normalized;
    }
  };

  const archiveInventoryCategory = async (id: string, expectedVersion: number): Promise<ManagedInventoryCategory | undefined> => {
    try {
      const category = await adapter.archiveInventoryCategory(id, expectedVersion);
      setCategories((current) => current.map((candidate) => candidate.id === id ? category : candidate));
      return category;
    } catch (error: unknown) {
      const normalized = normalizeApiError(error);
      if (normalized.code === "version_conflict") setCategoryReloadNonce((current) => current + 1);
      throw normalized;
    }
  };

  const searchCatalogProducts = async (kind: "filament" | "printer", query: string, options?: CatalogSearchOptions): Promise<CatalogProduct[]> => {
    const sequence = ++catalogSearchSequence.current;
    try {
      const results = await adapter.searchCatalogProducts(kind, query, options);
      if (sequence === catalogSearchSequence.current) setCatalogProducts(results);
      return results;
    } catch (error: unknown) {
      if (sequence === catalogSearchSequence.current) {
        handleMutationError(error, "searching the product catalog");
        setCatalogProducts([]);
      }
      return [];
    }
  };

  const listCatalogProductPage = async (kind: "filament" | "printer", query: string, options?: CatalogSearchOptions): Promise<CatalogProductPage> => {
    if (adapter.listCatalogProductPage) return adapter.listCatalogProductPage(kind, query, options);
    return { products: await adapter.searchCatalogProducts(kind, query, options), limit: options?.limit ?? 50 };
  };

  const resetCatalogSelection = () => { catalogSearchSequence.current += 1; setCatalogQuery(""); setCatalogProducts([]); }; const addCatalogProduct = async (input: CatalogProductDraft): Promise<CatalogProduct | undefined> => {
    try {
      const product = await adapter.createCatalogProduct(input);
      setCatalogProducts((current) => [product, ...current.filter((candidate) => candidate.id !== product.id)]);
      setCatalogQuery("");
      return product;
    } catch (error: unknown) {
      handleMutationError(error, "adding that catalog product");
      return undefined;
    }
  };

  const addExactInventoryItem = async (input: ExactInventoryInput): Promise<boolean> => {
    try {
      const item = await adapter.createExactInventoryItem(input);
      setItems((current) => [item, ...current]);
      setInventoryRefreshNonce((current) => current + 1); closeNewItem();
      setCatalogQuery("");
      setCatalogProducts([]);
      if (await refreshProjectReadiness()) setToast(`${item.name} added. Its exact product link is ${item.productProfile?.linkState === "confirmed" ? "confirmed" : "reported until you check it"}.`);
      return true;
    } catch (error: unknown) {
      handleMutationError(error, "adding that exact inventory item");
      return false;
    }
  }; const linkExactInventoryItem = async ( item: InventoryItem, input: ExactInventoryInput ): Promise<boolean> => { try { const linked = await adapter.linkExactInventoryItem( item.id, input, item.productProfile?.version ); setItems((current) => current.map((candidate) => candidate.id === linked.id ? linked : candidate ) ); closeNewItem(); setSelectedItemId(linked.id); if (await refreshProjectReadiness()) setToast( `${linked.name} now has an exact product link. Its stock evidence is unchanged.` ); return true; } catch (error: unknown) { handleMutationError(error, "linking that exact product"); return false; } }; if (loading || connection === "loading") return <LoadingScreen />;
  if (connection !== "ready" && connection !== "sample") {
    return ( <ConnectionScreen state={connection} error={connectionError} demoAvailable={demoAvailable} onLogin={signIn} onRetry={retryConnection} onSample={useSampleWorkspace} /> );
  }

  return (
    <div className="app-shell">
      <div className="app-background" aria-hidden={overlayOpen ? true : undefined} inert={overlayOpen || undefined}>
        <Sidebar page={page} projectCount={projects.length} sampleMode={sampleMode} expert={expert} onNavigate={navigate} mobileOpen={mobileNav} onClose={() => setMobileNav(false)} />
        <div className="app-main" aria-hidden={mobileNav ? true : undefined} inert={mobileNav || undefined}>
          <header className="topbar">
            <button className="icon-button mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileNav(true)}>
              <Icon name="menu" size={21} />
            </button>
            <div className="breadcrumb"><span>BenchLedger</span><Icon name="chevron-right" size={14} /><strong>{pageCopy[page].label}</strong></div>
            <div className="topbar-actions">
              {page !== "inventory" && ( <button ref={searchLauncherRef} type="button" className="global-search" onClick={launchInventorySearch} aria-label="Search inventory">
                <Icon name="search" size={17} />
                <span className="global-search-text">Search inventory</span>
                <kbd>⌘ K</kbd>
              </button> )} <button className="icon-button" aria-label="Open account settings" onClick={() => navigate("settings")}> <Icon name="settings" size={19} /> </button>
            </div>
          </header>

          {sampleMode && <SampleBanner onReturn={returnToPrivateWorkspace} />}

          <main ref={mainRef} className="content" id="main-content" tabIndex={-1} >
            {page === "overview" && ( <OverviewPage items={items} projects={projects} expert={expert} sampleMode={sampleMode} onNavigate={navigate} onOpenProject={openProject} onSelectItem={setSelectedItemId} onNewProject={openNewProject} onAddPrinter={openNewPrinter} /> )}{" "}
            {page === "inventory" && ( <InventoryPage adapter={adapter} categories={categories} expert={expert} search={search} searchInputRef={searchInputRef} refreshKey={inventoryRefreshNonce} bulkSelectionResetKey={bulkSelectionResetNonce} onSearch={(value) => setSearch(value.slice(0, MAX_INVENTORY_SEARCH_LENGTH))} onSessionExpired={handleSessionExpiry} onPageItems={(pageItems) => setItems((current) => { const byId = new Map(current.map((item) => [item.id, item] as const)); pageItems.forEach((item) => byId.set(item.id, item)); return [...byId.values()]; })} onSelectItem={setSelectedItemId} onNewItem={() => { setReplacementFor(undefined); setShowNewItem(true); }} onBulkSelectionChange={(selection, onResult) => setBulkInventorySelection(selection.length ? { items: [...selection], onResult } : undefined)} /> )}{" "}
            {page === "projects" && selectedProject && ( <ProjectPage project={selectedProject} projects={visibleProjects} projectView={projectView} archivedProjectCount={archivedProjects.length} items={items} offers={offers} tab={projectTab} expert={expert} sampleMode={sampleMode} reconciliationSupported={ serviceCapabilities.includes("reconciliation.read") && serviceCapabilities.includes("reconciliation.write") } onTabChange={selectProjectTab} onSelectProject={selectProject} onProjectViewChange={changeProjectView} onOpenItem={setSelectedItemId} onNavigate={navigate} onToast={setToast} onNewProject={openNewProject} onArchive={archiveProject} onRestore={restoreProject} onRemove={removeProject} onNewRevision={() => setShowNewRevision(true)} onEditBuildApproach={() => setShowEditBuildApproach(true)} onRetrySetup={pendingRevisionSetup?.projectId === selectedProject.id && pendingRevisionSetup.revisionId === selectedProject.serverRevisionId ? retryRevisionSetup : undefined} onAddBom={() => setShowAddBom(true)} onResolveBomRole={resolveBomLineRole} onUpload={uploadArtifact} onReadReconciliation={adapter.readReconciliation} onSaveReconciliation={adapter.saveReconciliationDraft} onCommitReconciliation={adapter.commitReconciliation} onRefreshWorkspace={refreshWorkspace} onListInspections={adapter.listInspections} onReadInspection={adapter.readInspection} onPreviewInspection={adapter.previewInspectionCompletion} onConfirmInspection={adapter.commitInspectionCompletion} /> )}{" "}
            {page === "projects" && !selectedProject && ( <section><div className="project-view-switch" role="group" aria-label="Project view"><button type="button" aria-pressed={projectView === "active"} className={projectView === "active" ? "is-active" : ""} onClick={() => changeProjectView("active")}> {" "}Active projects{" "} </button><button type="button" aria-pressed={projectView === "archived"} className={projectView === "archived" ? "is-active" : ""} onClick={() => changeProjectView("archived")}> {" "}Archived ({archivedProjects.length}){" "} </button></div><EmptyState icon="folder" title={projectView === "archived" ? "No archived projects" : "No projects yet"} description={projectView === "archived" ? "Archived projects will appear here with their retained history." : "Start with a name and project goal. You can add parts and files after that."} {...(projectView === "active" ? { action: "Create first project", onAction: () => setShowNewProject(true) } : {})} /></section> )}{" "}
            {page === "capabilities" && ( <CapabilitiesPage expert={expert} onCopy={setToast} /> )}{" "}
            {page === "settings" && ( <><div className={workspaceAccess?.mode === "lan_open" ? "settings-page-lan-open" : undefined}><SettingsPage expert={expert} sampleMode={sampleMode} connection={connection} categories={categories} categoriesLoading={categoriesLoading} categoriesError={categoriesError} onRetryCategories={() => setCategoryReloadNonce((current) => current + 1)} onCreateCategory={createInventoryCategory} onUpdateCategory={updateInventoryCategory} onArchiveCategory={archiveInventoryCategory} hideLogout={workspaceAccess?.mode === "lan_open"} onExpert={() => setExpert((current) => !current)} onLogout={sampleMode ? returnToPrivateWorkspace : signOut} /></div>{workspaceAccess && !sampleMode && !workspaceAccess.demo && ( <div className="settings-layout"><WorkspaceAccessSection access={workspaceAccess} pendingRetry={adapter.getWorkspaceAccessRetry()} onUpdate={adapter.updateWorkspaceAccess} onChanged={setWorkspaceAccess} onClearRetry={adapter.clearWorkspaceAccessRetry} onRebootstrap={() => { setReloadNonce((current) => current + 1); }} /></div> )}</> )}
          </main>
        </div>
      </div>

      {selectedItem && ( <InventoryDrawer item={selectedItem} items={items} categories={categories} categoriesLoading={categoriesLoading} categoriesError={categoriesError} expert={expert} onClose={() => setSelectedItemId(undefined)} onCount={recordCount} onCommission={commissionInventoryItem} onUpdate={updateInventoryItem} onLinkProduct={(record) => { setSelectedItemId(undefined); setReplacementFor(record); setShowNewItem(true); }} onCreateReplacement={(record) => { setSelectedItemId(undefined); setReplacementFor(record); setShowNewItem(true); }} /> )}{" "}
      {showNewProject && ( <NewProjectDialog items={items} suspended={showNewItem} onClose={closeNewProject} onAddPrinter={openNewPrinter} onCreate={createProject} /> )}{" "}
      {showNewRevision && selectedProject && ( <NewRevisionDialog project={selectedProject} items={items} expert={expert} suspended={showNewItem} onClose={() => setShowNewRevision(false)} onAddPrinterDetails={openNewPrinterDetails} onAddPrinter={openNewPrinter} onCreate={createRevision} /> )}{" "} {showEditBuildApproach && selectedProject && ( <EditBuildApproachDialog project={selectedProject} items={items} expert={expert} suspended={showNewItem} onClose={() => setShowEditBuildApproach(false)} onAddPrinter={openNewPrinter} onSave={updateBuildApproach} /> )}{" "}
      {showAddBom && selectedProject && ( <AddBomDialog items={items} project={selectedProject} expert={expert} onClose={() => setShowAddBom(false)} onCreate={addBomLine} /> )}{" "}
      {showNewItem && ( <NewInventoryDialog expert={expert} replacementFor={replacementFor} categories={categories} categoriesLoading={categoriesLoading} categoriesError={categoriesError} catalogQuery={catalogQuery} catalogProducts={catalogProducts} onCatalogQuery={setCatalogQuery} onResetCatalog={resetCatalogSelection} onSearchCatalog={searchCatalogProducts} onSearchCatalogPage={listCatalogProductPage} onCreateCatalogProduct={addCatalogProduct} onCreateExact={addExactInventoryItem} onLinkExact={linkExactInventoryItem} onClose={closeNewItem} onGoSettings={() => { closeNewItem(); setShowNewRevision(false); navigate("settings"); }} onCreate={addInventoryItem} /> )}{" "}
      {bulkInventorySelection && ( <BulkInventoryDialog selectedItems={bulkInventorySelection.items} onClose={closeBulkInventory} onDone={closeBulkInventory} onApply={applyBulkInventory} /> )}{" "}
      {toast && ( <div className={`toast toast-${toastTone}`} role={toastTone === "error" ? "alert" : "status"} aria-live="polite" ><Icon name={toastTone === "error" ? "warning" : "check-circle"} size={18} /><span>{toast}</span><button className="toast-close" aria-label="Dismiss notification" onClick={() => setToastMessage(undefined)}><Icon name="close" size={15} /></button></div> )}
    </div>
  );
}

function BrandMark() { return ( <div className="brand-mark" aria-hidden="true"> <span /> <span /> <span /> </div> ); } function Sidebar({ page, projectCount, sampleMode, expert, onNavigate, mobileOpen, onClose }: { page: Page; projectCount: number; sampleMode: boolean; expert: boolean; onNavigate: (page: Page) => void; mobileOpen: boolean; onClose: () => void; }) {
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | undefined>(undefined);

  useEffect(() => {
    if (!mobileOpen) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeButtonRef.current?.focus();
  }, [mobileOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const desktop = window.matchMedia("(min-width: 801px)");
    const closeAtDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) onClose();
    };
    desktop.addEventListener("change", closeAtDesktop);
    return () => desktop.removeEventListener("change", closeAtDesktop);
  }, [mobileOpen, onClose]);

  const closeAndRestoreFocus = () => {
    const returnFocus = returnFocusRef.current;
    onClose();
    window.requestAnimationFrame(() => returnFocus?.focus());
  };

  const keepMobileFocusInside = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!mobileOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(drawerRef.current?.querySelectorAll<HTMLElement>(focusableOverlaySelector) ?? [])];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      drawerRef.current?.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return ( <>
    {mobileOpen && ( <div className="nav-scrim" aria-hidden="true" onClick={closeAndRestoreFocus} /> )}
    <aside ref={drawerRef} className={`sidebar ${mobileOpen ? "is-open" : ""}`} aria-label="Primary navigation" role={mobileOpen ? "dialog" : undefined} aria-modal={mobileOpen ? true : undefined} tabIndex={mobileOpen ? -1 : undefined} onKeyDown={keepMobileFocusInside}>
      <div className="brand-lockup"><BrandMark /><div><div className="wordmark">BenchLedger</div><div className="brand-caption">maker workspace</div></div><button ref={closeButtonRef} className="icon-button sidebar-close" aria-label="Close navigation" onClick={closeAndRestoreFocus}><Icon name="close" size={18} /></button></div>
      <div className="workspace-identity" aria-label="Current workspace"><span className="workspace-avatar">W</span><span><strong>Current workspace</strong><small>{sampleMode ? "Sample workspace" : "Private workspace"} ·
              Workbench
            </small></span></div>
      <nav className="nav-list">
        <span className="nav-label">Workspace</span>
        {(["overview", "inventory", "projects"] as Page[]).map((entry) => ( <button key={entry} className={`nav-item ${page === entry ? "is-active" : ""}`} onClick={() => onNavigate(entry)}><Icon name={pageCopy[entry].icon} size={18} /><span>{pageCopy[entry].label}</span>{entry === "projects" && ( <span className="nav-count">{projectCount}</span> )}</button>))}{" "} {expert && ( <> <span className="nav-label nav-label-agent">Agent access</span>
        <button className={`nav-item ${page === "capabilities" ? "is-active" : ""}`} onClick={() => onNavigate("capabilities")}><Icon name="spark" size={18} /><span>For agents</span><span className="status-dot" /></button>
      </> )} </nav>
      <div className="sidebar-bottom"><button className={`nav-item ${page === "settings" ? "is-active" : ""}`} onClick={() => onNavigate("settings")}><Icon name="settings" size={18} /><span>Settings</span></button><div className="connection-note"><span className="online-dot" /><span>{sampleMode ? "Sample workspace" : "Connected"}</span></div></div>
    </aside>
  </> );
}

function LoadingScreen() {
  return ( <div className="loading-screen" role="status" aria-live="polite"><div className="loading-brand"><BrandMark /><span>Loading workspace</span></div><div className="skeleton-line wide" /><div className="skeleton-line" /><div className="skeleton-table"><span /><span /><span /><span /></div></div> );
}

function normalizeApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof TypeError) return new ApiError("The private service could not be reached.", { kind: "offline" });
  if (error instanceof Error) return new ApiError(error.message, { kind: "server" });
  return new ApiError("The private service returned an unexpected error.", { kind: "server" });
}

function localDateTimeValue(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function observedAtFromLocalDateTime(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function writeFailureMessage(error: ApiError, action: string): string {
  if (error.kind === "offline") return `Cannot complete ${action}. The private service is offline. Nothing was saved.`;
  if (error.kind === "unauthenticated" || error.kind === "csrf") return `Cannot complete ${action}. Sign in again. Nothing was saved.`;
  if (error.kind === "validation") return `Cannot complete ${action}. Check the values and try again.`;
  return `Cannot complete ${action}. Nothing was saved.`;
}

/** Keep service/runtime terminology out of the beginner finish-build screen. */
export function reconciliationLoadErrorMessage(message: string, expert: boolean): string {
  if (expert) return message;
  if (message.trim() === "This runtime does not support post-project reconciliation") {
    return "Used-stock updates are not available on this service version. Update the service, then try again.";
  }
  return "The used-stock update could not be loaded. Try again or return to the plan.";
}

function isAmbiguousMutation(error: ApiError): boolean {
  return !["validation", "forbidden", "unauthenticated", "csrf"].includes(error.kind);
}

export function ConnectionScreen({ state, error, demoAvailable, onLogin, onRetry, onSample }: { state: Exclude<ConnectionState, "loading" | "ready" | "sample">; error: ApiError | undefined; demoAvailable: boolean; onLogin: (password: string) => Promise<void>; onRetry: () => void; onSample: () => void; }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password.trim()) { setFormError("Enter the workspace password to continue."); return; }
    setSubmitting(true);
    setFormError(undefined);
    try { await onLogin(password); } catch (loginError: unknown) { setFormError(normalizeApiError(loginError).kind === "unauthenticated" ? "That password did not open the workspace." : "We could not sign you in. Try again or check the service connection."); } finally { setSubmitting(false); }
  };
  const isOffline = state === "offline";
  const isAuth = state === "unauthenticated";
  const title = isAuth ? "Sign in" : isOffline ? "Private service offline" : "Cannot open workspace";
  const description = isAuth ? "Enter the password for this private workspace." : isOffline ? "BenchLedger cannot reach the private service. It did not replace private data with sample data." : "The service returned an error before it loaded the workspace. Nothing changed.";
  const detail = error && !isAuth && !isOffline ? error.correlationId ? `Reference ${error.correlationId}` : error.message : undefined;
  return ( <main className="connection-screen"><section className="connection-card" aria-labelledby="connection-title"><div className="loading-brand"><BrandMark /><span>BenchLedger · private workspace</span></div><div className="connection-state-icon"><Icon name={isAuth ? "info" : isOffline ? "link" : "warning"} size={22} /></div><h1 id="connection-title">{title}</h1><p className="connection-description">{description}</p>{detail && ( <p className="connection-detail" role="alert">{detail}</p> )}{" "}{isAuth && ( <form className="login-form" onSubmit={submit} noValidate><label className="form-field" htmlFor="workspace-password"><span>Workspace password</span><input id="workspace-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby={formError ? "workspace-password-error" : undefined} aria-invalid={Boolean(formError)} autoFocus /></label>{formError && ( <p id="workspace-password-error" className="form-error" role="alert">{formError}</p> )}<button className="button button-primary login-submit" type="submit" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}<Icon name="arrow-right" size={16} /></button></form> )}{" "}{!isAuth && ( <button className="button button-secondary connection-retry" onClick={onRetry}><Icon name="refresh" size={16} /> Try again{" "} </button> )}{" "}{demoAvailable && ( <div className="sample-choice"><span>Sample workspace</span><button className="text-button" onClick={onSample}> {" "}Open sample workspace <Icon name="arrow-right" size={15} /></button><small> {" "}Sample records are for practice. BenchLedger does not mix them with private records.{" "} </small></div> )}</section></main> );
} export function SampleBanner({ onReturn }: { onReturn: () => void }) {
  return ( <div className="offline-banner sample-banner" role="status"><Icon name="info" size={17} /><div><strong>Sample workspace</strong><span> {" "}
          Try the workflow here. Changes do not affect your private
          workspace.{" "} </span></div><button className="text-button" onClick={onReturn}><Icon name="arrow-left" size={15} /> Return to private workspace{" "} </button></div> );
}

function PageHeader({ eyebrow, title, description, action, onAction, actionIcon = "plus", children }: { eyebrow: string; title: string; description: string; action?: string | undefined; onAction?: ((event: React.MouseEvent<HTMLButtonElement>) => void) | undefined; actionIcon?: Parameters<typeof Icon>[0]["name"]; children?: ReactNode; }) {
  return ( <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="header-actions">{children}{" "} {action && ( <button className="button button-primary" onClick={onAction}><Icon name={actionIcon} size={17} />{action}</button> )}</div></div> );
}

function BuildRail({ currentStep, projectName, onProject }: { currentStep: number; projectName?: string | undefined; onProject?: (() => void) | undefined; }) {
  return ( <section className="build-rail" aria-label="Build progress"><div className="rail-heading"><div><span className="eyebrow">Build path</span><strong>{projectName ?? "Your next build"}</strong></div>{onProject && ( <button className="text-button" onClick={onProject}> {" "}Open project <Icon name="arrow-right" size={15} /></button> )}</div><div className="rail-track">{railSteps.map((step, index) => ( <div className={`rail-step ${index < currentStep ? "is-complete" : ""} ${index === currentStep ? "is-current" : ""}`} key={step}><span className="rail-marker">{index < currentStep ? ( <Icon name="check" size={13} /> ) : ( index + 1 )}</span><span>{step}</span>{index < railSteps.length - 1 && ( <span className="rail-line" aria-hidden="true" /> )}</div>))}</div></section> );
}

type NullablePrinterProject = Project & { readonly intendedPrinterItemId?: string | null };
function projectFabricationRoute(project: Project): FabricationRoute { const plannedPrinter = (project as NullablePrinterProject).intendedPrinterItemId; if (project.fabricationRoute) return project.fabricationRoute; if (plannedPrinter !== undefined) return plannedPrinter ? "printed" : "undecided"; return project.buildConfigSnapshot?.printerItemId ? "printed" : "undecided"; } function projectIntendedPrinterId(project: Project): string | undefined { const plannedPrinter = (project as NullablePrinterProject).intendedPrinterItemId; if (plannedPrinter !== undefined) return plannedPrinter ?? undefined; return project.fabricationRoute === undefined ? project.buildConfigSnapshot?.printerItemId : undefined; } export function isUsableOwnedPrinter(item: InventoryItem): boolean { const evidence = item.serverEvidence ?? item.evidence; const retired = (item as InventoryItem & { retired?: boolean }).retired === true || item.tags.some((tag) => tag.toLocaleLowerCase() === "retired");
  const availableQuantity = item.availableQuantity ?? Math.max(item.quantity - item.reserved, 0);
  const profileMatchesItem = item.productProfile?.inventoryItemId === item.id && item.productProfile.catalogProductId === item.catalogProduct?.id && item.productProfile.linkState === "confirmed" && (item.productProfile.profileType === "printer_asset" || item.productProfile.printer !== undefined); return ( item.category === "Printers" && !retired && item.unit === "each" && item.unitStatus !== "needs_correction" && item.quantity > 0 && availableQuantity > 0 && (evidence === "physically_counted" || evidence === "commissioned") && item.catalogProduct?.kind === "printer" && isExactProductIdentityComplete(item) && profileMatchesItem ); } export function printerBuildVolumeCopy( item: InventoryItem | undefined ): string | undefined { const volume = item?.catalogProduct?.buildVolumeMm; if ( !volume || ![volume.x, volume.y, volume.z].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0 ) ) return undefined; return `${volume.x} × ${volume.y} × ${volume.z} mm build volume`; } export interface PrintRelatedSignals { requirementCount: number; fileCount: number; hasBuildSetup: boolean; } export function printRelatedSignals( project: Project, items: InventoryItem[] ): PrintRelatedSignals { const printRequirementCount = project.bom.filter((line) => { const item = line.itemId ? items.find((candidate) => candidate.id === line.itemId) : undefined; const itemIsPrintRelated = item?.category === "Filament" || item?.category === "Printers" || item?.kind === "filament" || item?.kind === "printer"; const constrainedKind = line.constraints?.kind; return ( itemIsPrintRelated || constrainedKind === "filament" || constrainedKind === "printer" ); }).length; const printableFileCount = project.artifacts.filter( (artifact) => artifact.role === "STL" || artifact.role === "Build plate" ).length; return { requirementCount: printRequirementCount, fileCount: printableFileCount, hasBuildSetup: project.buildConfigSnapshot !== undefined }; } export function hasCurrentRevisionPrintableArtifact(project: Project): boolean { const currentWorkItemRevisions = new Map( (project.workItems ?? []).flatMap((item) => { const revisionId = item.currentRevisionId ?? item.currentRevision?.id; return revisionId ? [[item.id, revisionId] as const] : []; }) ); return project.artifacts.some((artifact) => { if (artifact.role !== "STL" && artifact.role !== "Build plate") return false; if (artifact.workItemId !== undefined) { return ( artifact.workItemRevisionId !== undefined && currentWorkItemRevisions.get(artifact.workItemId) === artifact.workItemRevisionId ); } return ( project.serverRevisionId !== undefined && artifact.projectRevisionId === project.serverRevisionId ); }); } function printReviewCopy(signals: PrintRelatedSignals): string | undefined { const itemCount = signals.requirementCount + signals.fileCount; if (itemCount > 0) return `Review ${itemCount} print-related item${itemCount === 1 ? "" : "s"} before continuing with this route.`; if (signals.hasBuildSetup) return "A saved print setup remains. Review it before continuing with this route."; return undefined; } export function BuildApproachCard({ project, items, expert, onSelectPrinter, onChoosePrinter, onReviewPrintItems }: { project: Project; items: InventoryItem[]; expert: boolean; onSelectPrinter?: ((id: string) => void) | undefined; onChoosePrinter?: (() => void) | undefined; onReviewPrintItems?: ((target: "plan" | "files") => void) | undefined; }) { const route = projectFabricationRoute(project); const printerId = projectIntendedPrinterId(project); const printer = printerId ? items.find((item) => item.id === printerId) : undefined; const usablePrinter = printer && isUsableOwnedPrinter(printer) ? printer : undefined; const selectedPrinterLabel = usablePrinter ? inventoryCandidateLabel(usablePrinter, items, expert).name : undefined; const routeCopy = route === "ready_made" ? "Use a bought or existing enclosure/part" : route === "none" ? "Electronics / assembly only" : route === "printed" ? (selectedPrinterLabel ?? (printer ? "Printer needs a check" : "No printer selected yet")) : "Choose how this project will be built."; const printSignals = route === "ready_made" || route === "none" ? printRelatedSignals(project, items) : undefined; const reviewCopy = printSignals ? printReviewCopy(printSignals) : undefined; const reviewTarget = printSignals && printSignals.requirementCount === 0 && printSignals.fileCount > 0 ? ("files" as const) : ("plan" as const); const hasPrintableFile = route === "printed" && hasCurrentRevisionPrintableArtifact(project); const detailCopy = route === "printed" ? usablePrinter ? `${printerBuildVolumeCopy(usablePrinter) ?? "Build volume not recorded"}.` : printer ? "This printer is not available as an owned capability until it is physically counted or commissioned." : "That’s fine—you can choose or add an owned printer later." : route === "ready_made" ? "Next, add the dimensions or requirement for the part you will use." : route === "none" ? "No printer is needed for this approach." : "You can choose an approach when you know how you want to build it."; return ( <section className="surface build-approach-card" aria-label="Build approach" > <div className="build-approach-heading"> <div> <span className="eyebrow">Build approach</span> <h2>{routeCopy}</h2> </div> {route !== "printed" && ( <span className="route-chip">{fabricationRouteLabel(route)}</span> )} </div> <p>{detailCopy}</p> {reviewCopy && ( <div className="build-approach-review" role="note"> <strong>Review print-related items</strong> <span>{reviewCopy}</span> {onReviewPrintItems && ( <button type="button" className="text-button" onClick={() => onReviewPrintItems(reviewTarget)} > {reviewTarget === "files" ? "Open Files" : "Open Plan"} <Icon name="arrow-right" size={14} /> </button> )} </div> )}{" "} {route === "printed" && ( <div className="build-approach-fit"> <strong>Not checked yet.</strong> <span> {hasPrintableFile ? "Build file added. Fit still needs a slicer check." : "Add a printable file to check fit."} </span> </div> )}{" "} {(onChoosePrinter || (route === "printed" && printer && onSelectPrinter)) && ( <div className="build-approach-actions"> {onChoosePrinter && ( <button type="button" className="text-button" onClick={onChoosePrinter} > {" "}
              Change build approach <Icon name="arrow-right" size={15} /> </button> )}{" "} {route === "printed" && printer && onSelectPrinter && ( <button type="button" className="text-button" onClick={() => onSelectPrinter(printer.id)} > {" "}
              Open printer details <Icon name="arrow-up-right" size={14} /> </button> )} </div> )}{" "} {expert && ( <details className="expert-detail build-approach-expert"> <summary>Planning details</summary> <div className="detail-grid"> <div> <span>Fabrication route</span> <code>{route}</code> </div> <div> <span>Intended printer</span> <code>{printerId ?? "Not selected"}</code> </div> <div> <span>Printer build volume</span> <code>{printerBuildVolumeCopy(printer) ?? "Not recorded"}</code> </div> </div> </details> )} </section> ); } export function OverviewPage({ items, projects, expert, sampleMode: _sampleMode, onNavigate, onOpenProject, onSelectItem, onNewProject, onAddPrinter }: { items: InventoryItem[]; projects: Project[]; expert: boolean; sampleMode: boolean; onNavigate: (page: Page) => void; onOpenProject: (id: string, tab?: ProjectTab) => void; onSelectItem: (id: string) => void; onNewProject: (event: React.MouseEvent<HTMLButtonElement>) => void; onAddPrinter?: (() => void) | undefined; }) { const activeProject = projects.find( (project) => project.status !== "complete" && project.status !== "archived" ) ?? projects[0]; const activeSummary = activeProject ? calculateProjectSummary(activeProject, items) : undefined; const readinessUnavailable = activeSummary?.readinessUnavailable === true; const noRequirements = activeSummary?.totalLines === 0; const decideLine = readinessUnavailable ? undefined : activeSummary?.lineStatuses.find( (line) => line.line.optional !== true && line.decision === "decide" ); const inspectLine = readinessUnavailable ? undefined : activeSummary?.lineStatuses.find( (line) => line.line.optional !== true && line.state === "inspect-first" ); const sourceLine = readinessUnavailable ? undefined : activeSummary?.lineStatuses.find( (line) => line.line.optional !== true && line.decision === "source" ); const activeProjectRoute = activeProject ? projectFabricationRoute(activeProject) : undefined; const activeProjectPrinterId = activeProject ? projectIntendedPrinterId(activeProject) : undefined; const activeProjectPrinter = activeProjectPrinterId ? items.find((item) => item.id === activeProjectPrinterId) : undefined; const activeRouteNeedsDecision = activeProjectRoute === "undecided"; const activePrintedRouteNeedsPrinter = activeProjectRoute === "printed" && (activeProjectPrinter === undefined || !isUsableOwnedPrinter(activeProjectPrinter)); const nextActionTitle = activeProject ? readinessUnavailable ? "Reload stock results" : activeRouteNeedsDecision ? "Choose build approach" : noRequirements ? "Add the first requirements" : decideLine ? `Decide ${decideLine.line.label}` : inspectLine ? `Check ${inspectLine.line.label}` : sourceLine ? `Source ${sourceLine.line.label}`
        : activePrintedRouteNeedsPrinter ? "Choose a printer" : "Review files or validation" : "Create your first project";
  const nextActionDescription = activeProject
    ? readinessUnavailable
      ? "The latest inventory results are unavailable. Reload before preparing a Source proposal." : activeRouteNeedsDecision ? "Choose whether this is 3D printed, ready-made, electronics-only, or still undecided." : noRequirements
      ? "Nothing is recorded for this project yet. Add the materials, parts, or files it needs." : decideLine
      ? decideLine.missingDecisions?.length
        ? `Resolve ${decideLine.missingDecisions.map(humanizeSpecificationDecision).join(" and ")} before BenchLedger proposes a source.`
        : "Resolve the requirement details before BenchLedger proposes a source."
      : inspectLine
        ? beginnerInspectDescription(inspectLine) : sourceLine
          ? `${formatQuantity(sourceLine.remaining || sourceLine.line.required, sourceLine.line.unit)} is not covered by confirmed stock yet.`
          : activePrintedRouteNeedsPrinter ? "Pick an owned printer before checking build volume, material setup, or printable files." : "Every recorded requirement is covered by confirmed stock." : "Name what you are making, then add its requirements and files."; const printers = items.filter(isUsableOwnedPrinter); const tools = items.filter((item) => item.category === "Tools"); const printerNames = printers .slice(0, 2) .map((item) => inventoryCandidateLabel(item, items, expert).name); const toolNames = tools .slice(0, 3) .map((item) => inventoryCandidateLabel(item, items, expert).name); const configuredPrinter = activeProject?.buildConfigSnapshot?.printerItemId ? items.find( (item) => item.id === activeProject.buildConfigSnapshot?.printerItemId ) : undefined; const configuredFilament = activeProject?.buildConfigSnapshot?.filamentItemId ? items.find( (item) => item.id === activeProject.buildConfigSnapshot?.filamentItemId ) : undefined;
  return ( <>
    <PageHeader eyebrow="Workbench" title="What are you making?" description="Start with a project, then see what you already have." /> <section className="surface overview-start" aria-labelledby="overview-project-heading" >
    <div className="overview-start-copy"> <span className="eyebrow"> {activeProject ? "Current project" : "Start here"} </span> <h2 id="overview-project-heading"> {activeProject?.name ?? "Your next project"} </h2> <p> {activeProject?.description ?? "Create a project to keep its requirements, files, and build decisions together."} </p>
    <div className="overview-next-action"><span className="eyebrow">Next action</span> <strong>{nextActionTitle}</strong> <span>{nextActionDescription}</span> </div> </div> {activeProject ? ( <button className="button button-primary overview-primary-action" onClick={() => onOpenProject(activeProject.id)} > {" "}
            Continue {activeProject.name} <Icon name="arrow-right" size={16} /> </button> ) : ( <button className="button button-primary overview-primary-action" onClick={onNewProject} > {" "}
            New project <Icon name="plus" size={16} /> </button> )} </section>{activeProject && ( <BuildApproachCard project={activeProject} items={items} expert={expert} onSelectPrinter={onSelectItem} onReviewPrintItems={(target) => onOpenProject(activeProject.id, target)} /> )}{" "} {expert && activeProject && ( <section className="surface overview-expert-context" aria-label="Technical project context" ><div> <span className="eyebrow">Readiness</span> <strong> {activeSummary?.readyLines ?? 0} ready ·{" "} {activeSummary?.checkLines ?? 0} check{" "} </strong><small> {activeSummary?.decideLines ?? 0} decide ·{" "} {activeSummary?.sourceLines ?? 0} source{" "} </small></div><div><span className="eyebrow">Revision</span> <strong>{activeProject.currentRevision}</strong><small>{activeProject.serverRevisionId ?? "Revision identity not recorded"}</small></div><div><span className="eyebrow">Technical context</span><strong> {configuredPrinter ? inventoryCandidateLabel(configuredPrinter, items, true).name : "No printer setup recorded"}</strong><small> {configuredFilament ? inventoryCandidateLabel(configuredFilament, items, true).name : "No filament setup recorded"}</small></div></section> )} <section className="surface workshop-summary" aria-labelledby="workshop-summary-heading" ><div className="workshop-summary-header"> <div><span className="eyebrow">Workshop</span><h2 id="workshop-summary-heading">Your workshop</h2></div><span className="workshop-total">{items.length} item{items.length === 1 ? "" : "s"}</span></div><div className="workshop-summary-grid"><div className="workshop-group workshop-printers"> <div className="workshop-group-heading"> <span> <Icon name="layers" size={16} /> Owned printers{" "}</span><strong>{printers.length}</strong></div> {printers.length ? ( <div className="workshop-printer-list">{printers.map((item) => { const label = inventoryCandidateLabel(item, items, expert); return ( <button type="button" className="workshop-printer-card" key={item.id} onClick={() => onSelectItem(item.id)}><span> <strong>{label.name}</strong> <small> {printerBuildVolumeCopy(item) ?? "Build volume not recorded"} </small> </span><Icon name="arrow-up-right" size={14} /></button> ); })} </div> ) : ( <div className="workshop-empty-state"><span className="workshop-empty">{" "}
                  No owned printers yet. That’s fine for electronics and
                  ready-made builds.{" "}</span>{onAddPrinter && ( <button type="button" className="text-button" onClick={onAddPrinter} > {" "}
                    Add printer <Icon name="plus" size={14} /></button> )}</div> )} </div><div className="workshop-group workshop-tools"> <div className="workshop-group-heading"><span> <Icon name="tool" size={16} /> Key tools{" "} </span> <strong>{tools.length}</strong></div> {toolNames.length ? ( <div className="workshop-name-list">{toolNames.map((name) => ( <span key={name}>{name}</span> ))}{" "} {tools.length > toolNames.length && ( <small>+{tools.length - toolNames.length} more</small> )} </div> ) : ( <span className="workshop-empty">No tools recorded yet.</span> )}</div></div> <div className="workshop-summary-actions"> <button type="button" className="text-button" onClick={() => onNavigate("inventory")} > {" "}
            Manage inventory <Icon name="arrow-right" size={15} /></button> {expert && ( <button type="button" className="text-button workshop-agent-link" onClick={() => onNavigate("capabilities")} >{" "}
              For agents <Icon name="arrow-right" size={14} /></button>)}</div></section> </> );
}

function Metric({ value, label, detail, tone }: { value: string; label: string; detail: string; tone: StockLabelTone; }) {
  return ( <div className="metric"><span className={`metric-value metric-${tone}`}>{value}</span><div><strong>{label}</strong><small>{detail}</small></div></div> );
}

function SectionHeading({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string | undefined; onAction?: (() => void) | undefined; }) {
  return ( <div className="section-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{action && ( <button className="text-button" onClick={onAction}>{action}<Icon name="arrow-right" size={14} /></button> )}</div> );
}

function hasObservedInventoryVersion(item: InventoryItem): item is VersionedInventoryItem {
  return ( typeof item.version === "number" && Number.isSafeInteger(item.version) && item.version > 0 );
}

function InventoryPage({ adapter, categories, expert, search, searchInputRef, refreshKey, bulkSelectionResetKey, onSearch, onSessionExpired, onPageItems, onSelectItem, onNewItem, onBulkSelectionChange }: { adapter: WorkspaceAdapter; categories: readonly ManagedInventoryCategory[]; expert: boolean; search: string; searchInputRef: React.RefObject<HTMLInputElement | null>; refreshKey: number; bulkSelectionResetKey: number; onSearch: (value: string) => void; onSessionExpired: (error: unknown) => void; onPageItems: (items: readonly InventoryItem[]) => void; onSelectItem: (id: string) => void; onNewItem: () => void; onBulkSelectionChange: (items: readonly VersionedInventoryItem[], onResult: (result: InventoryBulkUpdateResult) => void) => void; }) {
  const initialUrlState = readInventoryUrlState();
  const retainSearchFocusRef = useRef(false);
  const [categoryNodeId, setCategoryNodeId] = useState(initialUrlState.categoryNodeId);
  const [kind, setKind] = useState<InventoryKindQuery | "All">(initialUrlState.kind);
  const [evidence, setEvidence] = useState<InventoryEvidenceState | "All">(initialUrlState.evidence);
  const [availability, setAvailability] = useState<"All" | "available" | "unavailable">(initialUrlState.availability);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(expert); const [pageItems, setPageItems] = useState<InventoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [total, setTotal] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [loadMoreError, setLoadMoreError] = useState<ApiError>();
  const [retryNonce, setRetryNonce] = useState(0);
  const [selectedTargets, setSelectedTargets] = useState<Map<string, number>>(() => new Map());
  const [selectionNotice, setSelectionNotice] = useState<string>();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selectedTargetsRef = useRef(selectedTargets);
  const requestSequence = useRef(0);
  const baseQuery: InventoryListQuery = {
    limit: 25,
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(kind === "All" ? {} : { kind }),
    ...(evidence === "All" ? {} : { evidence }),
    ...(categoryNodeId === UNASSIGNED_CATEGORY_FILTER ? { unassigned: true } : categoryNodeId ? { categoryNodeId } : {}),
    ...(availability === "All" ? {} : { available: availability === "available" })
  };
  const filterKey = `${search}|${categoryNodeId}|${kind}|${evidence}|${availability}`;
  const previousFilterKey = useRef(filterKey); const selectedKindLabel = inventoryKindOptions.find( (option) => option.value === kind )?.label; const advancedFilterSummary = [ kind !== "All" && selectedKindLabel ? `Item type: ${selectedKindLabel}` : undefined ] .filter((value): value is string => Boolean(value)) .join(" · "); // Capture the selection from the current render before a filter change
  // resets it. Empty selections do not need a disruptive status message.
  selectedTargetsRef.current = selectedTargets;

  const loadedSelectedCount = pageItems.reduce((count, item) => count + (selectedTargets.has(item.id) ? 1 : 0), 0);
  const allLoadedSelected = pageItems.length > 0 && loadedSelectedCount === pageItems.length;
  const unversionedItem = pageItems.find((item) => !hasObservedInventoryVersion(item));
  const unversionedNotice = unversionedItem ? "Some loaded inventory rows cannot be selected for bulk edit because their observed version is unavailable. Reload inventory first." : undefined;

  useEffect(() => {
    const changed = previousFilterKey.current !== filterKey;
    previousFilterKey.current = filterKey;
    const hadSelection = selectedTargetsRef.current.size > 0;
    setSelectedTargets(new Map());
    setSelectionNotice(changed && hadSelection ? "Selection cleared because the search or filters changed." : undefined);
    onBulkSelectionChange([], () => undefined);
  // The parent callback is an inline state bridge; filter primitives define the reset boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  useEffect(() => {
    if (bulkSelectionResetKey === 0) return;
    setSelectedTargets(new Map());
    setSelectionNotice(undefined);
  }, [bulkSelectionResetKey]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = loadedSelectedCount > 0 && !allLoadedSelected;
  }, [loadedSelectedCount, allLoadedSelected]);

  const toggleSelected = (itemId: string) => {
    const item = pageItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    if (!hasObservedInventoryVersion(item)) {
      setSelectionNotice(`Cannot select ${item.name} for bulk edit because its observed version is unavailable. Reload inventory first.`);
      return;
    }
    if (selectedTargets.has(itemId)) {
      setSelectedTargets((current) => {
        const next = new Map(current);
        next.delete(itemId);
        return next;
      });
      setSelectionNotice(undefined);
      return;
    }
    if (selectedTargets.size >= 100) {
      setSelectionNotice("You can select up to 100 items at a time.");
      return;
    }
    setSelectedTargets((current) => new Map(current).set(itemId, item.version));
    setSelectionNotice(undefined);
  };

  const toggleAllLoaded = () => {
    if (unversionedItem) {
      setSelectionNotice(unversionedNotice);
      return;
    }
    if (allLoadedSelected) {
      setSelectedTargets((current) => {
        const next = new Map(current);
        pageItems.forEach((item) => next.delete(item.id));
        return next;
      });
      setSelectionNotice(undefined);
      return;
    }
    const available = Math.max(100 - selectedTargets.size, 0);
    const eligibleItems = pageItems.filter(hasObservedInventoryVersion);
    const toAdd = eligibleItems.filter((item) => !selectedTargets.has(item.id)).slice(0, available);
    setSelectedTargets((current) => {
      const next = new Map(current);
      toAdd.forEach((item) => next.set(item.id, item.version));
      return next;
    });
    setSelectionNotice(toAdd.length < eligibleItems.filter((item) => !selectedTargets.has(item.id)).length ? "You can select up to 100 items at a time." : undefined);
  };

  const openBulkEditor = () => {
    if (!selectedTargets.size) {
      setSelectionNotice("Select at least one inventory item to bulk edit.");
      return;
    }
    const selectedEntries = [...selectedTargets.entries()].map(([id, version]) => ({ id, version, item: pageItems.find((candidate) => candidate.id === id) }));
    const invalidSelectedEntry = selectedEntries.find(({ item }) => !item || !hasObservedInventoryVersion(item));
    if (invalidSelectedEntry) {
      const label = invalidSelectedEntry.item?.name ?? invalidSelectedEntry.id;
      setSelectionNotice(`Cannot bulk edit ${label} because its observed version is unavailable. Reload inventory first.`);
      return;
    }
    const selectedItems: VersionedInventoryItem[] = selectedEntries.map(({ item, version }) => ({ ...item!, version }));
    onBulkSelectionChange(selectedItems, (result) => {
      const returned = new Map([...result.updated, ...result.unchanged].map((item) => [item.id, item] as const));
      setPageItems((current) => current.map((item) => returned.get(item.id) ?? item));
    });
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    ["q", "categoryNodeId", "unassigned", "kind", "evidence", "available"].forEach((key) => params.delete(key));
    if (search.trim()) params.set("q", search.trim());
    if (categoryNodeId === UNASSIGNED_CATEGORY_FILTER) params.set("unassigned", "true");
    else if (categoryNodeId) params.set("categoryNodeId", categoryNodeId);
    if (kind !== "All") params.set("kind", kind);
    if (evidence !== "All") params.set("evidence", evidence);
    if (availability !== "All") params.set("available", String(availability === "available"));
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [search, categoryNodeId, kind, evidence, availability]);

  useLayoutEffect(() => {
    if (!retainSearchFocusRef.current) return;
    retainSearchFocusRef.current = false;
    searchInputRef.current?.focus();
  }, [search, searchInputRef]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    let active = true;
    setPageItems([]);
    setNextCursor(undefined);
    setTotal(undefined);
    setError(undefined);
    setLoadMoreError(undefined);
    setLoading(true);
    setLoadingMore(false);
    const timeout = window.setTimeout(() => {
      adapter.listInventory(baseQuery).then((result) => {
        if (!active || sequence !== requestSequence.current) return;
        setPageItems(result.items);
        setNextCursor(result.nextCursor);
        setTotal(result.total);
        onPageItems(result.items);
      }).catch((cause: unknown) => {
        if (!active || sequence !== requestSequence.current) return;
        const normalized = normalizeApiError(cause);
        if (normalized.kind === "unauthenticated") {
          onSessionExpired(normalized);
        } else {
          setError(normalized);
        }
      }).finally(() => {
        if (active && sequence === requestSequence.current) setLoading(false);
      });
    }, 280);
    return () => { active = false; window.clearTimeout(timeout); };
  // filterKey intentionally represents the primitive filter state and keeps
  // this request debounced when the user types rapidly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, filterKey, refreshKey, retryNonce]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const sequence = ++requestSequence.current;
    setLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      const result = await adapter.listInventory({ ...baseQuery, cursor: nextCursor });
      if (sequence !== requestSequence.current) return;
      setPageItems((current) => {
        const byId = new Map(current.map((item) => [item.id, item] as const));
        result.items.forEach((item) => byId.set(item.id, item));
        return [...byId.values()];
      });
      setNextCursor(result.nextCursor);
      setTotal(result.total);
      onPageItems(result.items);
    } catch (cause: unknown) {
      if (sequence === requestSequence.current) {
        const normalized = normalizeApiError(cause);
        if (normalized.kind === "unauthenticated") {
          onSessionExpired(normalized);
        } else {
          setLoadMoreError(normalized);
        }
      }
    } finally {
      if (sequence === requestSequence.current) setLoadingMore(false);
    }
  };

  const clearFilters = () => {
    onSearch("");
    setCategoryNodeId("");
    setKind("All");
    setEvidence("All");
    setAvailability("All");
  };
  return ( <>
    <PageHeader eyebrow="Inventory" title="What do you have?" description="See your printers, tools, materials, components, quantities, and evidence." action="Add item" onAction={onNewItem} />
    <section className="surface inventory-section">
      <div className="inventory-toolbar" aria-label="Inventory filters">
        <label className="field-search"><Icon name="search" size={17} /><span className="sr-only">Search inventory</span><input ref={searchInputRef} aria-label="Search inventory" value={search} maxLength={MAX_INVENTORY_SEARCH_LENGTH} onChange={(event) => { retainSearchFocusRef.current = document.activeElement === event.currentTarget; onSearch(event.currentTarget.value); }} placeholder="Search name, model, tag, or location" /></label>
        <div className="inventory-filter-grid">
          <InventoryFilter label="Category" value={categoryNodeId} onChange={setCategoryNodeId} options={[{ value: "", label: "All categories" }, ...inventoryCategoryFilterOptions(categories), { value: UNASSIGNED_CATEGORY_FILTER, label: "Unassigned items" }]} />
          <InventoryFilter label={expert ? "Evidence" : "Stock record"} value={evidence} onChange={(value) => setEvidence(value as InventoryEvidenceState | "All")} options={ expert ? inventoryEvidenceOptions : inventoryStatusOptions } />
          <InventoryFilter label="Availability" value={availability} onChange={(value) => setAvailability(value as typeof availability)} options={[{ value: "All", label: "All availability" }, { value: "available", label: "Available for reuse" }, { value: "unavailable", label: "Not available" } ]} /> <details className="inventory-more-filters" open={moreFiltersOpen} onToggle={(event) => setMoreFiltersOpen(event.currentTarget.open)} > <summary> <span>More filters</span> {advancedFilterSummary && ( <small>{advancedFilterSummary}</small> )} <Icon name="chevron-down" size={14} />
          </summary> <div className="inventory-more-filter-grid"> <InventoryFilter label="Item type" value={kind} onChange={(value) => setKind(value as InventoryKindQuery | "All")} options={[{ value: "All", label: "All item types" }, ...inventoryKindOptions ]} /> {advancedFilterSummary && ( <button type="button" className="text-button inventory-clear-more" onClick={() => setKind("All")} > {" "}
                    Clear more filters{" "} </button> )} </div> </details>
        </div>
      </div>
      <div className="inventory-page-status" role="status" aria-live="polite">{loading ? "Loading inventory…" : error ? "Inventory could not be loaded." : loadMoreError ? "Showing the loaded items. More items could not be loaded." : total === undefined ? `Showing ${pageItems.length} items` : `Showing ${pageItems.length} of ${total} items`}</div>
      {selectedTargets.size > 0 && ( <div className="inventory-selection-bar" aria-label="Bulk inventory selection"><div><strong>{selectedTargets.size} selected of {pageItems.length}{" "} loaded{" "} </strong><span> {" "}Select all applies only to the items currently loaded. You can select up to 100.{" "} </span></div><button className="button button-secondary" onClick={openBulkEditor}> {" "}Bulk edit<Icon name="sliders" size={16} /></button></div> )}{" "}
      {unversionedNotice && ( <p id="inventory-version-notice" className="inventory-selection-notice" role="status" aria-live="polite">{unversionedNotice}</p> )}{" "}
      {selectionNotice && ( <p className="inventory-selection-notice" role="status" aria-live="polite">{selectionNotice}</p> )}{" "}
      {error ? ( <div className="inventory-load-error" role="alert"><span>{error.message}</span><button className="button button-secondary" onClick={() => setRetryNonce((value) => value + 1)}> {" "}Try again{" "} </button></div> ) : loading && pageItems.length === 0 ? ( <div className="inventory-loading" aria-label="Loading inventory"> {" "}Loading inventory…{" "} </div> ) : pageItems.length ? ( <><InventoryTable items={pageItems} categories={categories} selectedIds={new Set(selectedTargets.keys())} selectAllRef={selectAllRef} allLoadedSelected={allLoadedSelected} hasUnversionedLoaded={Boolean(unversionedItem)} onToggleAll={toggleAllLoaded} onToggleSelected={toggleSelected} onSelectItem={onSelectItem} />{loadMoreError && ( <div className="inventory-load-error" role="alert"><span>{loadMoreError.message}</span><button className="button button-secondary" onClick={() => { void loadMore(); }}> {" "}Try again{" "} </button></div> )}{" "}{nextCursor && ( <div className="inventory-load-more"><button className="button button-secondary" onClick={() => { void loadMore(); }} disabled={loadingMore} aria-busy={loadingMore}>{loadingMore ? "Loading…" : "Load more"}<Icon name="chevron-right" size={16} /></button></div> )}</> ) : ( <EmptyState icon="search" title="No matching items" description="Change the search text or filters." action="Clear filters" onAction={clearFilters} /> )}
    </section>
  </> );
}

function InventoryFilter({ label, value, options, onChange }: { label: string; value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void; }) {
  return ( <label className="category-control"><span className="category-control-label">{label}</span><select aria-label={`Filter inventory by ${label.toLowerCase()}`} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => ( <option key={option.value} value={option.value}>{option.label}</option>))}</select></label> );
}

export function managedInventoryLabel(categories: readonly ManagedInventoryCategory[], item: InventoryItem, _expert = false): string { // Missing category metadata is a normal beginner-facing state; a referenced
// node that is absent from the managed list is a service/category error.
return ( selectedCategoryLabel(categories, item.categoryNodeId) ?? (item.categoryNodeId ? "Managed category unavailable" : "No category") );
} export function InventoryTable({ items, categories, selectedIds, selectAllRef, allLoadedSelected, hasUnversionedLoaded, onToggleAll, onToggleSelected, onSelectItem }: { items: InventoryItem[]; categories: readonly ManagedInventoryCategory[]; selectedIds: ReadonlySet<string>; selectAllRef: React.RefObject<HTMLInputElement | null>; allLoadedSelected: boolean; hasUnversionedLoaded: boolean; onToggleAll: () => void; onToggleSelected: (id: string) => void; onSelectItem: (id: string) => void; }) {
  return ( <div className="table-scroll"><table className="data-table inventory-table"><caption className="sr-only">Inventory items</caption><thead><tr><th scope="col" className="select-column"><label className="inventory-checkbox-hit"><input ref={selectAllRef} type="checkbox" className="inventory-checkbox" checked={allLoadedSelected} onChange={onToggleAll} disabled={hasUnversionedLoaded} aria-describedby={hasUnversionedLoaded ? "inventory-version-notice" : undefined} aria-label="Select all loaded inventory items" /></label></th><th scope="col">Item</th><th scope="col">Category</th><th scope="col">Quantity</th><th scope="col">Status</th><th scope="col">Location</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead><tbody>{items.map((item) => { const categoryLabel = managedInventoryLabel(categories, item); const versionAvailable = hasObservedInventoryVersion(item); const versionNoticeId = `inventory-version-${item.id}`; const identity = inventoryCandidateLabel(item, items); const identityText = inventoryCandidateText(item, items); return ( <tr key={item.id}><td className="select-column"><label className="inventory-checkbox-hit"><input type="checkbox" className="inventory-checkbox" checked={selectedIds.has(item.id)} onChange={() => onToggleSelected(item.id)} disabled={!versionAvailable} aria-describedby={!versionAvailable ? versionNoticeId : undefined} aria-label={`Select ${identityText}`} /></label>{!versionAvailable && ( <span id={versionNoticeId} className="sr-only"> {" "}Cannot select for bulk edit because this row has no positive observed version. Reload inventory first.{" "} </span> )}</td><td><button className="table-item" onClick={() => onSelectItem(item.id)}><span className={`item-glyph accent-${item.accent}`}><Icon name={categoryIcons[item.category]} size={16} /></span><span><strong>{identity.name}</strong>{identity.discriminator ? ( <small>{identity.discriminator}</small> ) : item.variant ? ( <small>{item.variant}</small> ) : null}{" "} {(item.category === "Filament" || item.category === "Printers") && ( <small className={`exact-product-state ${isExactProductConfirmed(item) ? "is-confirmed" : ""}`}>{exactProductLabel(item)}</small> )}</span></button></td><td><span className="category-label"><Icon name={categoryIcons[item.category]} size={14} />{categoryLabel}</span></td><td className="quantity-cell"> {item.unitStatus === "needs_correction" ? ( <> <strong className="quantity-blocked">Fix unit</strong> <small>Quantity not usable</small> </> ) : ( <> <strong>{formatQuantity(Math.max(item.quantity - item.reserved, 0), item.unit)}</strong>{item.reserved > 0 && ( <small>{formatQuantity(item.reserved, item.unit)}{" "} reserved{" "} </small> )} </> )}</td><td><StatusPill state={displayedInventoryState(item)} {...(item.unitStatus === "needs_correction" ? { label: "Fix unit" } : {})} /></td><td><span className="location-label"> {inventoryLocationLabel(item.location)}</span></td><td><button className="row-open" onClick={() => onSelectItem(item.id)} aria-label={`Open ${identityText}`}><Icon name="chevron-right" size={17} /></button></td></tr> ); })}</tbody></table></div> );
}

type BulkInventoryOutcome = {
  kind: "success" | "noop" | "conflict" | "error" | "ambiguous";
  message: string;
  updated: number;
  unchanged: number;
  correlationId?: string;
};

function splitBulkTags(value: string): string[] {
  return value.split(/[\n,]/u).map((tag) => tag.trim()).filter(Boolean);
} export function hasBulkInventoryChanges( location: string, condition: InventoryCondition | "", tagsAdd: string, tagsRemove: string ): boolean { return Boolean( location.trim() || condition || splitBulkTags(tagsAdd).length || splitBulkTags(tagsRemove).length ); } function projectedBulkTags(item: InventoryItem, changes: InventoryBulkUpdateInput["changes"]): string[] {
  const removed = new Set((changes.tags?.remove ?? []).map((tag) => tag.toLocaleLowerCase()));
  const tags = item.tags.filter((tag) => !removed.has(tag.toLocaleLowerCase()));
  const existing = new Set(tags.map((tag) => tag.toLocaleLowerCase()));
  for (const tag of changes.tags?.add ?? []) {
    const key = tag.toLocaleLowerCase();
    if (!existing.has(key)) {
      existing.add(key);
      tags.push(tag);
    }
  }
  return tags;
} export function BulkInventoryDialog({ selectedItems, onClose, onDone, onApply }: { selectedItems: readonly VersionedInventoryItem[]; onClose: () => void; onDone: () => void; onApply: (input: InventoryBulkUpdateInput) => Promise<InventoryBulkUpdateResult>; }) {
  const targetCount = useRef(selectedItems.length).current;
  const [location, setLocation] = useState("");
  const [condition, setCondition] = useState<InventoryCondition | "">("");
  const [tagsAdd, setTagsAdd] = useState("");
  const [tagsRemove, setTagsRemove] = useState("");
  const [step, setStep] = useState<"edit" | "confirm" | "result">("edit");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [outcome, setOutcome] = useState<BulkInventoryOutcome>();

  const buildChanges = (): InventoryBulkUpdateInput["changes"] => {
    const add = splitBulkTags(tagsAdd);
    const remove = splitBulkTags(tagsRemove);
    const changes: InventoryBulkUpdateInput["changes"] = {};
    if (location.trim()) changes.location = location.trim();
    if (condition) changes.condition = condition;
    if (add.length || remove.length) changes.tags = { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
    return changes;
  };

  const hasActualChange = hasBulkInventoryChanges( location, condition, tagsAdd, tagsRemove ); const reviewChanges = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setFormError(undefined);
    const changes = buildChanges();
    if (!Object.keys(changes).length) {
      setFormError("Choose a location, condition, or tag change before continuing.");
      return;
    }
    if (changes.location && changes.location.length > 240) {
      setFormError("Location must be 240 characters or fewer.");
      return;
    }
    const add = changes.tags?.add ?? [];
    const remove = changes.tags?.remove ?? [];
    const addKeys = new Set(add.map((tag) => tag.toLocaleLowerCase()));
    const removeKeys = remove.map((tag) => tag.toLocaleLowerCase());
    if (new Set(add.map((tag) => tag.toLocaleLowerCase())).size !== add.length || new Set(removeKeys).size !== remove.length) {
      setFormError("Tags must be unique, ignoring capitalization.");
      return;
    }
    if (removeKeys.some((tag) => addKeys.has(tag))) {
      setFormError("A tag cannot be added and removed in the same edit.");
      return;
    }
    const invalidTagItem = selectedItems.find((item) => {
      const projected = projectedBulkTags(item, changes);
      return projected.length > 50 || projected.some((tag) => tag.length > 80);
    });
    if (invalidTagItem) {
      setFormError(`The changes would exceed the 50-tag or 80-character tag limit for ${invalidTagItem.name}.`);
      return;
    }
    setStep("confirm");
  };

  const confirmChanges = async () => {
    if (saving) return;
    setSaving(true);
    setFormError(undefined);
    try {
      const result = await onApply({
        targets: selectedItems.map((item) => ({ itemId: item.id, expectedVersion: item.version })),
        changes: buildChanges()
      });
      const updated = result.updated.length;
      const unchanged = result.unchanged.length;
      setOutcome({
        kind: updated ? "success" : "noop",
        message: updated ? `Saved changes to ${updated} item${updated === 1 ? "" : "s"}${unchanged ? `; ${unchanged} unchanged` : ""}.` : `No changes needed. ${unchanged} item${unchanged === 1 ? "" : "s"} unchanged.`,
        updated,
        unchanged,
        correlationId: result.correlationId
      });
      setStep("result");
    } catch (error: unknown) {
      const normalized = normalizeApiError(error);
      const conflict = normalized.status === 409 || normalized.code === "version_conflict";
      const ambiguous = !conflict && isAmbiguousMutation(normalized);
      setOutcome({
        kind: conflict ? "conflict" : ambiguous ? "ambiguous" : "error",
        message: conflict
          ? "Nothing changed. One or more selected items changed on the service; reload and select them again."
          : ambiguous
            ? "BenchLedger could not confirm whether this bulk edit was applied. Retry safely to replay the same command, or close this dialog and verify the rows before making another change."
            : normalized.message,
        updated: 0,
        unchanged: 0,
        ...(normalized.correlationId ? { correlationId: normalized.correlationId } : {})
      });
      setStep("result");
    } finally {
      setSaving(false);
    }
  };

  const dialogClose = saving ? () => undefined : onClose;
  return ( <Dialog title="Bulk edit inventory" onClose={dialogClose}>
    {step === "edit" && ( <form className="bulk-inventory-form" onSubmit={reviewChanges} aria-busy={saving}>
      <p className="dialog-intro"> {" "}Apply the same storage, condition, or tag changes to {" "} <strong>{targetCount} selected item{targetCount === 1 ? "" : "s"}</strong>{" "}. Quantity and evidence are not included.{" "} </p>
      <label className="form-field"><span>Location</span><input autoFocus value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Leave blank to keep each location" disabled={saving} /></label>
      <label className="form-field"><span>Condition</span><select value={condition} onChange={(event) => setCondition(event.target.value as InventoryCondition | "")} disabled={saving}><option value="">Keep each current condition</option><option value="new">New</option><option value="good">Good</option><option value="worn">Worn</option><option value="needs_repair">Needs repair</option><option value="unknown">Unknown</option></select></label>
      <label className="form-field"><span>Tags to add</span><input value={tagsAdd} onChange={(event) => setTagsAdd(event.target.value)} placeholder="Comma or newline separated" disabled={saving} /></label>
      <label className="form-field"><span>Tags to remove</span><input value={tagsRemove} onChange={(event) => setTagsRemove(event.target.value)} placeholder="Comma or newline separated" disabled={saving} /></label>
      {formError && ( <p className="form-error" role="alert">{formError}</p> )}
      <p className="bulk-inventory-note"> {" "}Nothing changes until you review and confirm.{" "} </p>
      <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={saving}> {" "}Cancel{" "} </button><button type="submit" className="button button-primary" disabled={saving || !hasActualChange}> {" "}Review changes<Icon name="arrow-right" size={16} /></button></div>
    </form> )}{" "}
    {step === "confirm" && ( <section className="bulk-inventory-confirmation" aria-busy={saving}>
      <p className="dialog-intro">Nothing changes until you confirm.</p>
      <div className="bulk-inventory-summary"><strong>{targetCount} item{targetCount === 1 ? "" : "s"}</strong>{location.trim() && <span>Location → {location.trim()}</span>}{" "} {condition && ( <span>Condition → {condition.replaceAll("_", " ")}</span> )}{" "}{(tagsAdd.trim() || tagsRemove.trim()) && ( <span> {" "}Tags → {" "} {tagsAdd.trim() ? `add ${splitBulkTags(tagsAdd).join(", ")}` : ""}{" "} {tagsAdd.trim() && tagsRemove.trim() ? "; " : ""}{" "} {tagsRemove.trim() ? `remove ${splitBulkTags(tagsRemove).join(", ")}` : ""}</span> )}</div>
      <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => setStep("edit")} disabled={saving}> {" "}Back to changes{" "} </button><button type="button" className="button button-primary" onClick={() => { void confirmChanges(); }} disabled={saving} aria-busy={saving}>{saving ? "Applying…" : "Confirm bulk edit"}</button></div>
      {saving && ( <p className="bulk-live-status" role="status" aria-live="polite"> {" "}Applying changes to {targetCount} item{" "} {targetCount === 1 ? "" : "s"}…{" "} </p> )}
    </section> )}{" "}
    {step === "result" && outcome && ( <section className={`bulk-inventory-result bulk-result-${outcome.kind}`}>
      <p className="bulk-live-status" role={outcome.kind === "conflict" || outcome.kind === "error" || outcome.kind === "ambiguous" ? "alert" : "status"} aria-live="polite">{outcome.message}</p>
      {outcome.correlationId && ( <small className="bulk-correlation"> {" "}Reference {outcome.correlationId}</small> )}{" "}
      {outcome.kind === "ambiguous" && ( <p className="bulk-inventory-note"> {" "}Retry safely reuses the retained idempotency key for this exact edit. Do not change the values if you want the service to replay the same command.{" "} </p> )}{" "}
      {outcome.kind === "conflict" && ( <p className="bulk-inventory-note"> {" "}Nothing was saved. Reload inventory and select the current rows before trying again.{" "} </p> )}{" "}
      {outcome.kind === "error" && ( <p className="bulk-inventory-note"> {" "}Nothing was saved. Correct the values or check the service connection.{" "} </p> )}
      <div className="dialog-actions">{outcome.kind === "success" || outcome.kind === "noop" ? ( <button type="button" className="button button-primary" onClick={onDone}> {" "}Done{" "} </button> ) : outcome.kind === "ambiguous" ? ( <><button type="button" className="button button-primary" onClick={() => { void confirmChanges(); }} disabled={saving} aria-busy={saving}> {" "}Retry safely{" "} </button><button type="button" className="button button-secondary" onClick={onClose}> {" "}Close{" "} </button></> ) : ( <><button type="button" className="button button-quiet" onClick={() => { setOutcome(undefined); setStep("edit"); }}> {" "}Back to changes{" "} </button><button type="button" className="button button-secondary" onClick={onClose}> {" "}Close{" "} </button></> )}</div>
    </section> )}
  </Dialog> );
}

function evidenceLabel(evidence: InventoryItem["evidence"], serverEvidence?: InventoryItem["serverEvidence"]): string {
  if (serverEvidence === "physically_counted") return "Physically counted";
  if (serverEvidence === "commissioned") return "Commissioned";
  if (serverEvidence === "delivered_uncounted") return "Delivered, not counted";
  if (serverEvidence === "ordered_unverified") return "Ordered, not verified";
  if (serverEvidence === "allocated") return "Allocated";
  if (serverEvidence === "consumed") return "Consumed";
  if (serverEvidence === "unknown") return "Unknown";
  if (evidence === "counted") return "Physically counted";
  if (evidence === "commissioned") return "Commissioned";
  if (evidence === "ordered") return "Ordered, not verified";
  return "Delivered, not counted";
}

function StatusPill({ state, compact = false, label }: { state: StockState | "optional"; compact?: boolean; label?: string; }) {
  const status = state === "optional" ? { label: "Optional", tone: "muted" as const } : getStockLabel(state); const displayLabel = label ?? status.label; return ( <span className={`status-pill tone-${status.tone} ${compact ? "status-compact" : ""}`} > <span className="status-symbol" aria-hidden="true"> {status.tone === "good" ? "✓" : status.tone === "bad" ? "!" : status.tone === "warn" ? "?" : "–"} </span> {displayLabel} </span> ); } export async function copyTextWithFallback(value: string): Promise<boolean> { if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(value); return true; } catch { // HTTP LAN origins may not expose the async clipboard API. Continue
// with the user-gesture fallback before asking for a manual copy.
} } if ( typeof document === "undefined" || typeof document.execCommand !== "function" ) return false; const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined; const textarea = document.createElement("textarea"); textarea.value = value; textarea.readOnly = true; textarea.setAttribute("aria-hidden", "true"); textarea.style.position = "fixed"; textarea.style.opacity = "0"; textarea.style.pointerEvents = "none"; document.body.append(textarea); textarea.select(); textarea.setSelectionRange(0, value.length); try { return document.execCommand("copy"); } catch { return false; } finally { textarea.remove(); previousFocus?.focus();
} } export function ProjectExpertContext({ project }: { project: Project }) {
  const workItems = project.workItems ?? [];
  return ( <div className="detail-grid expert-context-grid">
    {workItems.length ? ( workItems.map((item) => {
      const revisionId = item.currentRevisionId ?? item.currentRevision?.id;
      const value = `${item.name} · ${item.id} · ${revisionId ?? "No current revision"}`;
      return ( <div key={item.id}><span>Work item</span><div className="expert-value"><code>{value}</code><CopyValueButton value={value} /></div></div> );
    }) ) : ( <div><span>Work items</span><code>No work items recorded</code></div> )}
    <div><span>Revision state</span><code>State is supplied by the connected service.</code></div>
    <div><span>Artifact policy</span><code>Retained revisions are not overwritten.</code></div>
  </div> );
}

function CopyValueButton({ value }: { value: string }) {
  const [feedback, setFeedback] = useState<"success" | "error">();
  const feedbackTimer = useRef<number | undefined>(undefined); const feedbackId = useId(); useEffect( () => () => {
    if (feedbackTimer.current !== undefined) window.clearTimeout(feedbackTimer.current); }, [] ); const announce = (next: "success" | "error") => { if (feedbackTimer.current !== undefined) window.clearTimeout(feedbackTimer.current); setFeedback(next); feedbackTimer.current = window.setTimeout(() => { feedbackTimer.current = undefined; setFeedback(undefined); }, 1800);
    }; const copy = async () => { announce((await copyTextWithFallback(value)) ? "success" : "error"); }; const feedbackMessage = feedback === "success" ? "Copied." : feedback === "error" ? "Copy did not work. Select the value and copy it manually." : undefined; return ( <span className="copy-value-control"> <button type="button" className="copy-value-button" onClick={() => { void copy(); }} aria-describedby={feedback ? feedbackId : undefined} aria-label={feedback === "success" ? "Copied" : "Copy value"}>{feedback === "success" ? "Copied" : "Copy"}</button> {feedbackMessage && ( <span id={feedbackId} className={`copy-value-feedback copy-feedback-${feedback}`} role={feedback === "error" ? "alert" : "status"} aria-live="polite" > {feedbackMessage} </span> )} </span> );
}

function ProjectPage({ project, projects, projectView, archivedProjectCount, items, offers, tab, expert, sampleMode, reconciliationSupported, onTabChange, onSelectProject, onProjectViewChange, onOpenItem, onNavigate, onToast, onNewProject, onArchive, onRestore, onRemove, onNewRevision, onEditBuildApproach, onRetrySetup, onAddBom, onResolveBomRole, onUpload, onReadReconciliation, onSaveReconciliation, onCommitReconciliation, onRefreshWorkspace, onListInspections, onReadInspection, onPreviewInspection, onConfirmInspection }: {
  project: Project;
  projects: Project[];
  projectView: "active" | "archived";
  archivedProjectCount: number;
  items: InventoryItem[];
  offers: typeof fixtureOffers;
  tab: ProjectTab;
  expert: boolean;
  sampleMode: boolean; reconciliationSupported: boolean; onTabChange: (tab: ProjectTab, replace?: boolean) => void;
  onSelectProject: (id: string) => void;
  onProjectViewChange: (view: "active" | "archived") => void;
  onOpenItem: (id: string) => void;
  onNavigate: (page: Page) => void;
  onToast: (message: string) => void;
  onNewProject: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onArchive: (project: Project) => Promise<void>;
  onRestore: (project: Project) => Promise<void>;
  onRemove: (project: Project) => Promise<void>;
  onNewRevision: () => void; onEditBuildApproach: () => void; onRetrySetup?: (() => void) | undefined;
  onAddBom: () => void; onResolveBomRole: ( lineId: string, role: "consumed" | "reusable", expectedVersion: number ) => Promise<void>; onUpload: (projectId: string, file: File, role: string, target?: ArtifactUploadTarget) => Promise<void>;
  onReadReconciliation: WorkspaceAdapter["readReconciliation"];
  onSaveReconciliation: WorkspaceAdapter["saveReconciliationDraft"];
  onCommitReconciliation: WorkspaceAdapter["commitReconciliation"];
  onRefreshWorkspace: () => Promise<boolean>;
  onListInspections: WorkspaceAdapter["listInspections"];
  onReadInspection: WorkspaceAdapter["readInspection"];
  onPreviewInspection: WorkspaceAdapter["previewInspectionCompletion"];
  onConfirmInspection: WorkspaceAdapter["commitInspectionCompletion"];
}) {
  const summary = calculateProjectSummary(project, items);
  const configuredPrinter = project.buildConfigSnapshot?.printerItemId ? items.find((item) => item.id === project.buildConfigSnapshot?.printerItemId) : undefined;
  const configuredFilament = project.buildConfigSnapshot?.filamentItemId ? items.find((item) => item.id === project.buildConfigSnapshot?.filamentItemId) : undefined;
  const projectRoute = projectFabricationRoute(project); const intendedPrinterId = projectIntendedPrinterId(project); const intendedPrinter = intendedPrinterId ? items.find((item) => item.id === intendedPrinterId) : undefined; const routeNeedsDecision = project.status !== "archived" && projectRoute === "undecided"; const printedRouteNeedsPrinter = project.status !== "archived" && projectRoute === "printed" && (intendedPrinter === undefined || !isUsableOwnedPrinter(intendedPrinter)); const nextActionTitle = project.status === "archived" ? "Restore to continue work" : summary.readinessUnavailable ? "Reload stock results" : routeNeedsDecision ? "Choose build approach" : summary.decideLines ? "Add the missing details" : summary.inspectLines ? "Check the physical stock" : summary.sourceLines ? "Source the remaining requirements" : summary.totalLines === 0 ? "Add requirements" : printedRouteNeedsPrinter ? "Choose a printer" : "Ready to validate"; const nextActionDescription = project.status === "archived" ? "Archived projects reject new work, revisions, requirements, uploads, and used-stock updates until restored." : summary.readinessUnavailable ? "Inventory changed, but stock results are unavailable. Wait for the latest results before preparing a Source proposal." : routeNeedsDecision ? "Choose whether this is 3D printed, ready-made, electronics-only, or still undecided before validation." : summary.decideLines ? `Add the missing details before you choose what to buy.` : summary.inspectLines ? formatRequirementCheckMessage(summary.inspectLines) + "." : summary.sourceLines ? formatSourceReadyMessage(summary.sourceLines) + "." : summary.totalLines === 0 ? "No requirements are recorded yet." : printedRouteNeedsPrinter ? "Pick an owned printer before checking build volume, material setup, or printable files." : "Every recorded requirement is covered by confirmed stock."; const hasServerRevision = !sampleMode && reconciliationSupported && Boolean(project.serverRevisionId);
  const [reconciliation, setReconciliation] = useState<ReconciliationViewModel>();
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [reconciliationError, setReconciliationError] = useState<string>();
  const [archiveConfirmationOpen, setArchiveConfirmationOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [restoreConfirmationOpen, setRestoreConfirmationOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [removeConfirmationOpen, setRemoveConfirmationOpen] = useState(false);
  const [removeConfirmation, setRemoveConfirmation] = useState("");
  const [removing, setRemoving] = useState(false);
  const [inspectionActions, setInspectionActions] = useState<readonly InspectionAction[]>(() => (project as InspectionProject).inspectionActions ?? []);
  const [inspectionError, setInspectionError] = useState<string>();
  const tabRefs = useRef<Record<ProjectTab, HTMLButtonElement | null>>({ plan: null, files: null, offers: null, reconciliation: null }); const pendingTabFocusRef = useRef<ProjectTab | undefined>(undefined); const reconciliationRevisionId = project.serverRevisionId;
  const inspectionRevisionId = project.serverRevisionId; const availableTabs: ProjectTab[] = hasServerRevision ? ["plan", "files", "offers", "reconciliation"] : ["plan", "files", "offers"]; const moveTabFocus = ( event: React.KeyboardEvent<HTMLButtonElement>, current: ProjectTab ) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const currentIndex = availableTabs.indexOf(current); const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? availableTabs.length - 1 : event.key === "ArrowRight" ? (currentIndex + 1) % availableTabs.length : (currentIndex - 1 + availableTabs.length) % availableTabs.length; const next = availableTabs[nextIndex]; if (!next) return; pendingTabFocusRef.current = next; onTabChange(next); }; useLayoutEffect(() => { const pendingTab = pendingTabFocusRef.current; if (!pendingTab || pendingTab !== tab) return; pendingTabFocusRef.current = undefined; tabRefs.current[pendingTab]?.focus(); }, [tab]); useEffect(() => {
    const snapshotActions = (project as InspectionProject).inspectionActions;
    // A normal workspace read may omit the derived queue. Preserve the
    // already-consumed result until the revision-scoped list read replaces it.
    if (snapshotActions !== undefined) setInspectionActions(snapshotActions);
  }, [project]);

  useEffect(() => {
    if (tab !== "plan" || sampleMode || !inspectionRevisionId) return;
    let active = true;
    setInspectionError(undefined);
    onListInspections(inspectionRevisionId).then((next) => {
      if (active) setInspectionActions(next);
    }).catch((error: unknown) => {
      if (active) setInspectionError(normalizeApiError(error).message);
    });
    return () => { active = false; };
  }, [tab, sampleMode, inspectionRevisionId, onListInspections]);

  useEffect(() => {
    if (tab !== "reconciliation" || !hasServerRevision || !reconciliationRevisionId) return;
    let active = true;
    setReconciliationLoading(true);
    setReconciliationError(undefined);
    onReadReconciliation(project.id, reconciliationRevisionId).then((next) => {
      if (!active) return;
      setReconciliation(next);
    }).catch((error: unknown) => {
      if (!active) return;
      const normalized = normalizeApiError(error);
      setReconciliationError(normalized.message);
    }).finally(() => {
      if (active) setReconciliationLoading(false);
    });
    return () => { active = false; };
  }, [tab, hasServerRevision, project.id, reconciliationRevisionId, onReadReconciliation]);

  useEffect(() => {
    if (!hasServerRevision && tab === "reconciliation") onTabChange("plan", true);
  }, [hasServerRevision, tab, onTabChange]);

  const saveReconciliation = async (model: ReconciliationViewModel) => {
    if (!reconciliationRevisionId) return;
    const saved = await onSaveReconciliation(project.id, reconciliationRevisionId, model);
    setReconciliation(saved);
    onToast("Stock review saved. Review the changes before applying them.");
  };

  const commitReconciliation = async (model: ReconciliationViewModel) => {
    if (!reconciliationRevisionId) return;
    const committed = await onCommitReconciliation(project.id, reconciliationRevisionId, model);
    setReconciliation(committed);
    const refreshed = await onRefreshWorkspace();
    if (refreshed) {
      onToast("Stock update saved. The project status did not change.");
    } else {
      onToast("Stock update saved, but the workspace refresh failed. The project status did not change. Try refreshing again when the service is available.");
    }
  };
  const confirmInspection = async (action: InspectionAction, _input: InspectionCompletionInput, preview: InspectionCompletionPreview): Promise<InspectionCompletionResult> => {
    const committed = await onConfirmInspection(action.projectRevisionId, action.id, { previewId: preview.id, expectedPreviewVersion: preview.version, contentSha256: preview.contentSha256, confirmed: true });
    // Consume the server read-back first so the completed action disappears
    // immediately, then refresh the canonical inventory/project/gap snapshot.
    setInspectionActions(committed.inspections.data);
    const refreshed = await onRefreshWorkspace();
    if (!refreshed) setInspectionError("This check was committed, but the workspace refresh failed. The displayed queue is the committed server read-back; reload when the service is available.");
    return committed;
  };
  const confirmArchive = async () => {
    if (archiving) return;
    setArchiving(true);
    try {
      await onArchive(project);
      setArchiveConfirmationOpen(false);
    } catch {
      // The parent reports the actionable error; keep the confirmation open
      // so the user can retry without losing the selected project.
    } finally {
      setArchiving(false);
    }
  };
  const confirmRestore = async () => {
    if (restoring) return;
    setRestoring(true);
    try {
      await onRestore(project);
      setRestoreConfirmationOpen(false);
    } catch {
      // The parent reports the actionable error; keep the confirmation open
      // so the user can retry without losing the selected project.
    } finally {
      setRestoring(false);
    }
  };
  const confirmRemove = async () => {
    if (removing || removeConfirmation !== project.name) return;
    setRemoving(true);
    try {
      await onRemove(project);
      setRemoveConfirmationOpen(false);
      setRemoveConfirmation("");
    } catch {
      // The parent reports the actionable error; keep the confirmation open
      // so the exact-name confirmation is still available for a retry.
    } finally {
      setRemoving(false);
    }
  };
  const inspectionContext: InspectionContextValue = {
    actions: inspectionActions,
    ...(inspectionError ? { error: inspectionError } : {}),
    onReadInspection: (action) => onReadInspection(action.projectRevisionId, action.id),
    onPreviewInspection: (action, input) => onPreviewInspection(action.projectRevisionId, action.id, input),
    onConfirmInspection: confirmInspection
  };
  return ( <InspectionContext.Provider value={inspectionContext}><>
    <PageHeader eyebrow="Project" title={project.name} description={project.description} action={project.status === "archived" ? undefined : "New revision"} onAction={project.status === "archived" ? undefined : onNewRevision}><div className="project-view-switch" role="group" aria-label="Project view"><button type="button" aria-pressed={projectView === "active"} className={projectView === "active" ? "is-active" : ""} onClick={() => onProjectViewChange("active")}> {" "}Active projects{" "} </button><button type="button" aria-pressed={projectView === "archived"} className={projectView === "archived" ? "is-active" : ""} onClick={() => onProjectViewChange("archived")}> {" "}Archived ({archivedProjectCount}){" "} </button></div><select className="project-select" aria-label="Choose project" value={project.id} onChange={(event) => onSelectProject(event.target.value)}>{projects.map((candidate) => ( <option key={candidate.id} value={candidate.id}>{candidate.name}</option>))}</select><button type="button" className="button button-quiet" onClick={onNewProject}> {" "}New project{" "} </button></PageHeader>
    {archiveConfirmationOpen && ( <Dialog title={`Archive ${project.name}?`} role="alertdialog" onClose={() => { if (!archiving) setArchiveConfirmationOpen(false); }}><p className="dialog-intro">{expert ? "This hides the project from active lists and releases its active reservations. Revisions, files, requirements, stock evidence, and audit history remain retained. Archive is reversible; restore returns it to Idea without recreating reservations." : "This hides the project from active lists and releases stock set aside for it. Its revisions, files, requirements, stock records, and project history are kept. You can restore it later, but released stock will not be set aside again."}</p><div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => setArchiveConfirmationOpen(false)} disabled={archiving}> {" "}Cancel{" "} </button><button type="button" className="button button-primary" onClick={() => { void confirmArchive(); }} disabled={archiving} aria-busy={archiving}>{archiving ? "Archiving…" : "Archive project"}</button></div></Dialog> )}{" "}
    {restoreConfirmationOpen && ( <Dialog title={`Restore ${project.name}?`} role="alertdialog" onClose={() => { if (!restoring) setRestoreConfirmationOpen(false); }}><p className="dialog-intro">{expert ? "This moves the project to Idea. It does not recreate released reservations." : "This moves the project to Idea. Stock released when it was archived will not be set aside again."}</p><div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => setRestoreConfirmationOpen(false)} disabled={restoring}> {" "}Cancel{" "} </button><button type="button" className="button button-primary" onClick={() => { void confirmRestore(); }} disabled={restoring} aria-busy={restoring}>{restoring ? "Restoring…" : "Restore project"}</button></div></Dialog> )}{" "}
    {removeConfirmationOpen && ( <Dialog title={`Remove ${project.name} from the workspace?`} role="alertdialog" onClose={() => { if (!removing) { setRemoveConfirmationOpen(false); setRemoveConfirmation(""); } }}><p className="dialog-intro"><strong>This action is irreversible.</strong> {" "} {expert ? ( <> {" "}It removes this {" "} {project.status === "archived" ? "archived" : "active"}{" "} project from workspace lists. {" "} {project.status === "archived" ? "" : "Active reservations will be released. "}{" "} Its tombstone, revisions, files, reservation release evidence, and audit history remain retained, but the project cannot be restored.{" "} </> ) : ( <> {" "}It removes this {" "} {project.status === "archived" ? "archived" : "active"}{" "} project from workspace lists. {" "} {project.status === "archived" ? "" : "Stock set aside for it will be released. "}{" "} Its project history is kept, but the project cannot be restored.{" "} </> )}</p><label className="form-field" htmlFor="remove-project-confirmation"><span> {" "}Type <strong>{project.name}</strong> to confirm{" "} </span><input id="remove-project-confirmation" autoFocus value={removeConfirmation} onChange={(event) => setRemoveConfirmation(event.target.value)} disabled={removing} autoComplete="off" /></label><div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => { setRemoveConfirmationOpen(false); setRemoveConfirmation(""); }} disabled={removing}> {" "}Cancel{" "} </button><button type="button" className="button button-danger" onClick={() => { void confirmRemove(); }} disabled={removing || removeConfirmation !== project.name} aria-busy={removing}>{removing ? "Removing…" : "Remove from workspace"}</button></div></Dialog> )}{" "}
    {project.status === "archived" && ( <div className="archive-notice" role="status"><Icon name="archive" size={17} /><span><strong>Archived project</strong> {expert ? "Hidden from active lists. Active reservations were released; revisions, files, requirements, stock evidence, and audit history remain retained. Restore is reversible and returns the project to Idea without recreating reservations." : "Hidden from active lists. Stock set aside for it was released; revisions, files, requirements, stock records, and project history were kept. Restoring returns it to Idea without setting that stock aside again."}</span></div> )}{" "}
    {onRetrySetup && project.status !== "archived" && ( <div className="setup-retry-callout" role="status"><Icon name="warning" size={17} /><span><strong> {" "}Revision created. The setup save was not confirmed.{" "} </strong>{" "} Retry setup; BenchLedger will check the saved result before creating anything twice.{" "} </span><button className="button button-secondary" onClick={onRetrySetup}><Icon name="refresh" size={16} /> Retry setup{" "} </button></div> )}
    <details className="project-actions"><summary> {" "}Project settings <Icon name="chevron-down" size={14} /></summary><div className="project-settings-content"><span>{expert ? "Archive keeps revisions and audit history available. Removing a project keeps its tombstone but cannot be undone." : "Archive keeps the project and its history available. Removing a project cannot be undone, although its project history is kept."}</span><div className="project-settings-buttons">{project.status === "archived" ? ( <button className="button button-primary" onClick={() => setRestoreConfirmationOpen(true)}><Icon name="refresh" size={16} /> Restore project{" "} </button> ) : ( <button className="button button-secondary" onClick={() => setArchiveConfirmationOpen(true)}><Icon name="archive" size={16} /> Archive project{" "} </button> )}<button className="button button-danger" onClick={() => { setRemoveConfirmation(""); setRemoveConfirmationOpen(true); }}><Icon name="trash" size={16} /> Remove from workspace{" "} </button></div></div></details> {expert && ( <BuildRail currentStep={project.railStep} projectName={`${project.name} · ${project.currentRevision}`} /> )} <div className="dossier-layout"><aside className="dossier-column"> {expert && ( <div className="dossier-status"><span className={`status-pill tone-${project.status === "complete" ? "good" : "info"}`}><span className="status-symbol">●</span>{projectLifecycleLabel(project.status)}</span><span className="revision-label">{project.currentRevision}</span></div> )} <h2>{project.workItem}</h2><div className="dossier-next"><span className="eyebrow">Next action</span><strong>{nextActionTitle}</strong><span>{nextActionDescription}</span> </div> <BuildApproachCard project={project} items={items} expert={expert} onSelectPrinter={onOpenItem} onChoosePrinter={onEditBuildApproach} onReviewPrintItems={(target) => onTabChange(target)} /> {expert && ( <><dl className="dossier-facts"><div><dt>Current revision</dt><dd>{project.currentRevision}</dd></div><div><dt>Build files</dt><dd>{project.artifacts.length} artifacts</dd></div><div><dt>Last changed</dt><dd>{project.updated}</dd></div></dl>{project.buildConfigSnapshot && ( <BuildSetupSummary input={project.buildConfigSnapshot} printer={configuredPrinter} filament={configuredFilament} expert /> )} </> )}{" "}{expert && ( <details className="expert-detail"><summary>Technical context</summary><ProjectExpertContext project={project} /></details> )}<button className="text-button dossier-inventory-link" onClick={() => onNavigate("inventory")}> {" "}Browse all inventory <Icon name="arrow-right" size={15} />{" "} </button></aside><section className="dossier-workspace"><div className="tab-list" role="tablist" aria-label="Project workspace"><button ref={(node) => { tabRefs.current.plan = node; }} id="project-tab-plan" role="tab" aria-controls="project-tabpanel" aria-selected={tab === "plan"} tabIndex={tab === "plan" ? 0 : -1} className={tab === "plan" ? "is-active" : ""} onKeyDown={(event) => moveTabFocus(event, "plan")} onClick={() => onTabChange("plan")}><Icon name="clipboard" size={16} /> Plan {" "} <span>{summary.totalLines}</span></button><button ref={(node) => { tabRefs.current.files = node; }} id="project-tab-files" role="tab" aria-controls="project-tabpanel" aria-selected={tab === "files"} tabIndex={tab === "files" ? 0 : -1} className={tab === "files" ? "is-active" : ""} onKeyDown={(event) => moveTabFocus(event, "files")} onClick={() => onTabChange("files")}><Icon name="folder" size={16} /> Files {" "} <span>{project.artifacts.length}</span></button><button ref={(node) => { tabRefs.current.offers = node; }} id="project-tab-offers" role="tab" aria-controls="project-tabpanel" aria-selected={tab === "offers"} tabIndex={tab === "offers" ? 0 : -1} className={tab === "offers" ? "is-active" : ""} onKeyDown={(event) => moveTabFocus(event, "offers")} onClick={() => onTabChange("offers")}><Icon name="tag" size={16} /> Shopping list {" "} <span>{summary.sourceLines}</span></button>{hasServerRevision && ( <button ref={(node) => { tabRefs.current.reconciliation = node; }} id="project-tab-reconciliation" role="tab" aria-controls="project-tabpanel" aria-selected={tab === "reconciliation"} tabIndex={tab === "reconciliation" ? 0 : -1} className={tab === "reconciliation" ? "is-active" : ""} onKeyDown={(event) => moveTabFocus(event, "reconciliation")} onClick={() => onTabChange("reconciliation")}><Icon name="check-circle" size={16} /> Update used stock {" "} <span>{reconciliation?.status === "committed" ? "Done" : "Review"}</span></button> )}</div> <div id="project-tabpanel" role="tabpanel" aria-labelledby={"project-tab-" + tab} tabIndex={0} > {tab === "plan" && ( <ProjectPlan project={project} summary={summary} expert={expert} onOpenItem={onOpenItem} onAddBom={project.status === "archived" ? () => onToast("Restore this project before adding a requirement.") : onAddBom} onResolveBomRole={onResolveBomRole} /> )}{" "}{tab === "files" && ( <ProjectFiles project={project} expert={expert} sampleMode={sampleMode} onUpload={(file, role, target) => onUpload(project.id, file, role, target)} archived={project.status === "archived"} /> )}{" "}{tab === "offers" && ( <ShoppingList project={project} summary={summary} offers={offers} expert={expert} onToast={onToast} onBackToPlan={() => onTabChange("plan")} /> )}{" "}{tab === "reconciliation" && hasServerRevision && ( <section className="reconciliation-page-surface">{reconciliationLoading && ( <div className="reconciliation-loading" role="status"><span className="eyebrow">Update used stock</span><strong>Loading the current review…</strong><p>Nothing changes in stock while this review loads.</p></div> )}{" "}{reconciliationError && !reconciliationLoading && ( <div className="reconciliation-loading reconciliation-load-error" role="alert"><span className="eyebrow">Could not load stock update</span><strong>{reconciliationLoadErrorMessage(reconciliationError, expert)}</strong><button className="button button-secondary" onClick={() => onTabChange("plan")}> {" "}Back to plan{" "} </button></div> )}{" "}{reconciliation && !reconciliationLoading && !reconciliationError && ( <ReconciliationUI model={reconciliation} expert={expert} onChange={setReconciliation} onRequestPreview={saveReconciliation} onConfirmCommit={commitReconciliation} /> )}</section> )}</div> </section></div>
  </></InspectionContext.Provider> );
}

function ProjectPlan({ project, summary, expert, onOpenItem, onAddBom, onResolveBomRole }: { project: Project; summary: ReturnType<typeof calculateProjectSummary>; expert: boolean; onOpenItem: (id: string) => void; onAddBom: () => void; onResolveBomRole: ( lineId: string, role: "consumed" | "reusable", expectedVersion: number ) => Promise<void>; }) {
  const inspection = useContext(InspectionContext);
  const empty = summary.totalLines === 0;
  return ( <div className="project-plan"> {(expert || (inspection?.actions.length ?? 0) > 0 || inspection?.error) && ( <InspectionQueuePanel actions={inspection?.actions ?? (project as InspectionProject).inspectionActions ?? []} expert={expert} loadError={inspection?.error} onReadInspection={inspection?.onReadInspection} onPreviewInspection={inspection?.onPreviewInspection} onConfirmInspection={inspection?.onConfirmInspection} /> )} <section className="surface bom-section"><SectionHeading eyebrow="Requirements" title="What does this project need?" /> {expert && ( <div className="bom-explainer"><Icon name="info" size={16} /><span> {" "}Counted or commissioned stock is Ready. Delivered or ordered stock is Check. Missing details are Decide. Stock that is still missing is Source.{" "} </span></div> )}{" "} {empty ? ( <div className="empty-state"><h3>No requirements are recorded yet.</h3><p>Add the materials, parts, and files that this build needs.</p></div> ) : ( <div className="bom-list">{summary.lineStatuses.map((line) => ( <BomLineRow key={line.line.id} line={line} expert={expert} onOpenItem={onOpenItem} onResolveRole={onResolveBomRole} />))}</div> )}<button className="add-line-button" onClick={onAddBom}><Icon name="plus" size={16} /> {empty ? "Add first requirement" : "Add a requirement"}</button></section> {expert && ( <section className="surface learning-section"><SectionHeading eyebrow="Project memory" title="What we learned" /><div className="learning-list">{project.notes.length ? ( project.notes.map((note, index) => ( <div className="learning-row" key={note}><span className="learning-index">0{index + 1}</span><p>{note}</p><span className="learning-time">Recorded</span></div>)) ) : ( <p className="activity-empty"> {" "}No observations are recorded for this revision yet.{" "} </p> )}</div></section> )} </div> );
}

export function BomLineRow({ line, expert, onOpenItem, onResolveRole }: { line: BomLineStatus; expert: boolean; onOpenItem: (id: string) => void; onResolveRole?: ( lineId: string, role: "consumed" | "reusable", expectedVersion: number ) => void; }) {
  const required = line.gap?.requiredQuantity ?? line.line.required;
  const unit = line.gap?.unit ?? line.line.unit;
  const reasons = line.gap?.reasons ?? [];
  const diagnostics = unitDiagnostics(line);
  const candidates = line.gap?.candidates ?? [];
  const alternatives = line.gap?.alternatives ?? line.line.alternatives ?? [];
  const itemFor = (itemId: string) => (line.items ?? (line.item ? [line.item] : [])).find((item) => item.id === itemId);
  const correctionItem = line.item?.unitStatus === "needs_correction" ? line.item : undefined;
  const needsUnitCorrection = correctionItem !== undefined;
  const roleLabel = line.line.role === "consumed" ? "Part or material" : line.line.role === "reusable" ? "Reusable tool or equipment" : "Review use"; const roleNeedsReview = line.line.role !== "consumed" && line.line.role !== "reusable"; const rowDisplay = needsUnitCorrection ? { label: "Fix unit", tone: "warn" as const } : decisionDisplay(line.line.optional ? "optional" : line.decision);
  const matchedItemLabel = line.item ? inventoryCandidateLabel(line.item, line.items ?? [line.item], expert) : undefined;
  return ( <div className={`bom-row bom-${line.state} ${needsUnitCorrection ? "bom-unit-mismatch" : ""}`}>
    <div className="bom-main"><div><strong>{line.line.label}</strong><span>{line.line.note ?? `${formatQuantity(required, unit)} required`}</span>{roleNeedsReview && onResolveRole && ( <div className="bom-role-choice" role="group" aria-label={`Choose how ${line.line.label} is used`} > <small>How will you use this?</small> <button type="button" className="text-button" onClick={() => onResolveRole(line.line.id, "consumed", line.line.version) } > {" "}
                Part or material{" "} </button> <button type="button" className="text-button" onClick={() => onResolveRole(line.line.id, "reusable", line.line.version) } > {" "}
                Reusable tool{" "} </button> </div> )}{" "} {expert && ( <small className={`bom-role-state ${roleNeedsReview ? "is-review" : ""}`} > <strong>{roleLabel}</strong> {roleNeedsReview ? " · Use is not recorded; review before planning stock consumption." : " · Recorded for planning."} </small> )}{" "} {expert && needsUnitCorrection && ( <small className="bom-unit-warning"><strong>Fix unit</strong> {correctionItem.unitCorrectionReason ?? "Stock is not matched or reserved until its unit is corrected from observed evidence."}</small> )}{" "}{expert && line.missingDecisions?.length ? ( <small className="bom-missing-decisions"> {" "}Decide: {" "} {line.missingDecisions.map(humanizeSpecificationDecision) .join(", ")}</small> ) : null}</div></div>
    <div className="bom-quantity"><strong>{line.supplied > 0 ? `${formatQuantity(line.supplied, unit)} / ` : ""}{" "} {formatQuantity(required, unit)}</strong>{line.remaining > 0 && ( <small>{formatQuantity(line.remaining, unit)} remaining</small> )}</div>
    <div className="bom-match">{needsUnitCorrection ? ( <span className="match-none">No safe match</span> ) : line.item && matchedItemLabel ? ( <button className="match-link" onClick={() => onOpenItem(line.item!.id)}><span>{matchedItemLabel.name}</span>{matchedItemLabel.discriminator && ( <small>· {matchedItemLabel.discriminator}</small> )}<Icon name="arrow-up-right" size={13} /></button> ) : ( <span className="match-none">No matching stock</span> )}<span className={`status-pill tone-${rowDisplay.tone}`}><span className="status-symbol" aria-hidden="true">{rowDisplay.tone === "good" ? "✓" : rowDisplay.tone === "bad" ? "!" : rowDisplay.tone === "warn" ? "?" : "–"}</span>{rowDisplay.label}</span></div>
    {expert && ( <details className="bom-expert"><summary aria-label={`Show evidence for ${line.line.label}`}><Icon name="chevron-down" size={16} /></summary><div><span>Line ID</span><p>{line.line.id}</p><span>Line version</span><p>{line.line.version}</p><span>Canonical unit</span><p>{line.line.serverUnit ?? line.line.unit}</p><span>Requirement use</span> <p> {roleNeedsReview ? "Not recorded — review whether this is used up or reusable. It is not treated as consumable." : roleLabel} </p> <span>Match reason</span><p>{needsUnitCorrection ? "The inventory unit must be corrected from observed evidence before matching." : line.item ? `${line.item.variant} matches the requested category. Compatibility is based on the recorded project constraint.` : "No exact variant has been recorded in the workspace."}</p>{line.item?.dimensions && ( <span> {" "}Recorded dimensions: {formatDimensions(line.item.dimensions)}</span> )}{" "}{reasons.length > 0 && ( <><span>Canonical gap reasons</span><ul>{reasons.map((reason) => ( <li key={reason}>{reason}</li>))}</ul></> )}{" "}{diagnostics.length > 0 && ( <><span>Unit diagnostics</span><ul>{diagnostics.map((diagnostic) => ( <li key={diagnostic}>{diagnostic}</li>))}</ul></> )}{" "}{candidates.length > 0 && ( <><span>Candidate evidence</span><ul>{candidates.map((candidate) => ( <li key={`${candidate.itemId}-${candidate.relationship}`}>{itemFor(candidate.itemId)?.name ?? candidate.itemId}: {" "} {candidate.reason}</li>))}</ul></> )}{" "}{alternatives.length > 0 && ( <><span>Structured alternatives</span><ul>{alternatives.map((alternative) => ( <li key={alternative.itemId}>{alternative.itemId}{" "} {alternative.compatible ? ` · ${alternative.compatible}` : ""}{" "} {alternative.reason ? ` · ${alternative.reason}` : ""}{" "} {alternative.quantityConversion ? ` · 1 ${alternative.quantityConversion.inventory.unit} = ${alternative.quantityConversion.requirement.quantity} ${alternative.quantityConversion.evidence.basis}, observed ${alternative.quantityConversion.evidence.observedAt.slice(0, 10)}` : ""}</li>))}</ul></> )}</div></details> )}
  </div> );
}

type UploadEntryStatus = "pending" | "uploading" | "success" | "error";

interface UploadEntry {
  name: string;
  role: string;
  status: UploadEntryStatus;
  message?: string;
}

interface UploadRun {
  entries: UploadEntry[];
  total: number;
  completed: number;
  active: boolean;
  currentIndex?: number;
  targetKey: string;
  targetLabel: string;
}

export function ProjectFiles({ project, expert, sampleMode, onUpload, archived = false }: { project: Project; expert: boolean; sampleMode: boolean; onUpload: (file: File, role: string, target?: ArtifactUploadTarget) => Promise<void>; archived?: boolean; }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const choices = artifactScopeChoices(project, expert);
  const [scopeKey, setScopeKey] = useState(() => artifactScopeKey(defaultArtifactScope(project)));
  const [uploadRun, setUploadRun] = useState<UploadRun>();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]); const selectedChoice = choices.find((choice) => choice.key === scopeKey) ?? choices[0];
  const scope = selectedChoice?.target ?? { kind: "all" as const };
  const allArtifacts = project.allArtifacts ?? project.artifacts;
  const visibleArtifacts = filterArtifactsForScope(allArtifacts, scope);
  const uploadsDisabled = archived || uploadRun?.active === true || scope.kind === "all";

  useEffect(() => {
    setScopeKey(artifactScopeKey(defaultArtifactScope(project)));
    setUploadRun(undefined); setSelectedFiles([]); }, [project.id, project.serverRevisionId]);

  const processFiles = async (selected: File[]) => {
    const frozenTarget = scope.kind === "all" ? undefined : { ...scope };
    if (!frozenTarget) return;
    const targetLabel = artifactScopeIdentity(frozenTarget, expert);
    const entries = selected.map((file) => ({ name: file.name, role: roleForFile(file.name), status: "pending" as const }));
    setUploadRun({ entries, total: selected.length, completed: 0, active: true, targetKey: artifactScopeKey(frozenTarget), targetLabel });
    for (const [index, file] of selected.entries()) {
      const role = roleForFile(file.name);
      setUploadRun((current) => current ? { ...current, active: true, currentIndex: index, entries: current.entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, status: "uploading" } : entry) } : current);
      try {
        // frozenTarget is captured before the first request and reused for every
        // file in this run, even if a revision changes elsewhere in the app.
        await onUpload(file, role, frozenTarget);
        setUploadRun((current) => current ? { ...current, entries: current.entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, status: "success", message: `Uploaded to ${targetLabel}.` } : entry) } : current);
      } catch (error: unknown) {
        const failure = writeFailureMessage(normalizeApiError(error), `uploading ${file.name}`);
        setUploadRun((current) => current ? { ...current, entries: current.entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, status: "error", message: failure } : entry) } : current);
      }
      setUploadRun((current) => current ? { ...current, completed: index + 1 } : current);
    }
    setUploadRun((current) => {
      if (!current) return current;
      const { currentIndex: _currentIndex, ...finished } = current;
      return { ...finished, active: false, completed: selected.length };
    });
  };
  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!selected.length || uploadsDisabled) return; setSelectedFiles(selected); }; const addFiles = () => { if (!selectedFiles.length || uploadsDisabled) return; const selected = [...selectedFiles]; setSelectedFiles([]); void processFiles(selected);
  };
  const successCount = uploadRun?.entries.filter((entry) => entry.status === "success").length ?? 0;
  const errorCount = uploadRun?.entries.filter((entry) => entry.status === "error").length ?? 0;
  const currentEntry = uploadRun?.currentIndex === undefined ? undefined : uploadRun.entries[uploadRun.currentIndex];
  const bindings = [...new Set(visibleArtifacts.map((file) => [file.machine, file.material].filter(Boolean).join(" · ")).filter(Boolean))];
  const bindingLabel = bindings.length ? bindings.join(", ") : "No machine binding recorded";
  const scopeDescription = expert
    ? scope.kind === "all"
      ? "Read-only view. Legacy and unbound files remain visible; choose a revision to upload."
      : scope.kind === "project"
        ? `Uploads will be bound to projectRevisionId=${scope.projectRevisionId}.`
        : `Uploads will be bound to workItemId=${scope.workItemId} and workItemRevisionId=${scope.workItemRevisionId}.`
    : scope.kind === "all"
      ? "Read-only view. Choose a revision before adding files."
      : scope.kind === "project"
        ? "New files will be saved with this project revision."
        : "New files will be saved with this work item revision."; const addFilesLabel = selectedFiles.length ? `Add ${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"}` : "Add files"; const selectedFilesLabel = selectedFiles.map((file) => file.name).join(", "); return ( <section className="surface files-section">
    <div className="files-header"><div><span className="eyebrow">Files</span><h2>Build files</h2><p>{archived ? "This archive keeps files and history available, but uploads resume only after you restore the project." : sampleMode ? "Try file uploads here. Changes stay in this sample workspace." : "Keep CAD, exports, build plates, and validation notes with the revision they belong to."}</p></div><div className="file-upload-actions"><input ref={fileInput} type="file" multiple className="sr-only" aria-label="Choose files to upload" onChange={chooseFiles} disabled={uploadsDisabled} /><button type="button" className="button button-secondary" onClick={() => fileInput.current?.click()} disabled={uploadsDisabled} >{archived ? "Restore to add files" : scope.kind === "all" ? "Choose a revision first" : selectedFiles.length ? "Change selection" : "Choose files"} </button> <button type="button" className="button button-primary" onClick={addFiles} disabled={uploadsDisabled || selectedFiles.length === 0} aria-busy={uploadRun?.active} ><Icon name="upload" size={16} />{uploadRun?.active ? "Uploading…" : addFilesLabel}</button> {selectedFiles.length > 0 && ( <span className="selected-file-summary" role="status"> {selectedFilesLabel}</span> )} </div></div>
    <div className="artifact-scope-control"><label className="form-field" htmlFor="artifact-scope"><span>File scope</span><select id="artifact-scope" aria-label="Choose file scope" value={selectedChoice?.key ?? "all"} onChange={(event) => setScopeKey(event.target.value)} disabled={uploadRun?.active || archived}>{choices.map((choice) => ( <option key={choice.key} value={choice.key} disabled={choice.disabled}>{choice.label}</option>))}</select></label><div className="file-scope-identity"><Icon name="folder" size={15} /><span><strong>{artifactScopeIdentity(scope, expert)}</strong><code>{scopeDescription}</code></span><span className="file-scope-context">{sampleMode ? "sample workspace" : "private workspace"}</span></div></div>
    {uploadRun && ( <div className={`upload-status ${errorCount ? "has-errors" : ""}`} role="status" aria-live="polite"><div className="upload-status-heading"><strong>{uploadRun.active ? `Uploading ${Math.min((uploadRun.currentIndex ?? uploadRun.completed) + 1, uploadRun.total)} of ${uploadRun.total}` : `${successCount} of ${uploadRun.total} file${uploadRun.total === 1 ? "" : "s"} uploaded`}</strong><span>{currentEntry?.name ?? (errorCount ? `${errorCount} failed` : `Target: ${uploadRun.targetLabel}`)}</span></div><progress max={uploadRun.total} value={uploadRun.completed} aria-label="Artifact upload progress" /><ul>{uploadRun.entries.map((entry) => ( <li key={`${entry.name}-${entry.role}`}><span><strong>{entry.name}</strong><small>{entry.role}</small></span><span className={`upload-entry-state upload-${entry.status}`}>{entry.status === "pending" ? "Waiting" : entry.status === "uploading" ? "Uploading…" : entry.status === "success" ? "Uploaded" : "Not uploaded"}</span>{entry.status === "error" && entry.message && ( <p role="alert">{entry.message}</p> )}</li>))}</ul></div> )}{" "}
    {visibleArtifacts.length ? ( <div className="table-scroll"><table className="data-table files-table"><caption className="sr-only"> {" "}Artifacts in {artifactScopeIdentity(scope, expert)}</caption><thead><tr><th scope="col">File</th><th scope="col">Role</th><th scope="col">Scope</th><th scope="col">Revision</th><th scope="col">Updated</th><th scope="col">State</th>{expert && <th scope="col">SHA-256</th>}</tr></thead><tbody>{visibleArtifacts.map((file) => ( <tr key={file.id}><td><span className="file-name"><span className={`file-type type-${file.role.toLowerCase().replaceAll(" ", "-")}`}><Icon name={file.role === "Validation" ? "clipboard" : file.role === "Editable CAD" ? "code" : "file"} size={15} /></span><span><strong>{file.name}</strong><small>{file.size}{file.machine ? ` · ${file.machine}` : ""}</small></span></span></td><td>{file.role}</td><td className="file-scope-cell">{artifactIdentityLabel(file, expert)}</td><td><span className="revision-tag">{artifactRevisionLabel(file, expert)}</span></td><td>{file.updated}</td><td><span className={`file-state state-${file.status}`}>{file.status === "candidate" ? "Candidate" : file.status === "validated" ? "Validated" : "Superseded"}</span></td>{expert && ( <td><code className="hash-cell">{file.hash}</code></td> )}</tr>))}</tbody></table></div> ) : ( <div className="files-empty"><Icon name="folder" size={20} /><strong>{scope.kind === "all" ? "No files in this workspace yet." : "No files in this revision yet."}</strong><span>{scope.kind === "all" ? expert ? "Legacy and unbound files will appear here when they are retained by the service." : "Files not assigned to a current revision will appear here." : "Add the editable source or first export when you have one."}</span></div> )}{" "}
    {expert && ( <details className="expert-detail file-manifest-detail"><summary>Show manifest details</summary><div className="manifest-grid"><span>Binding</span><strong>{bindingLabel}</strong><span>Scope</span><strong>{artifactScopeIdentity(scope, true)}</strong><span>Retention</span><strong> {" "}Older revision files remain auditable when the service records them.{" "} </strong><span>Preview</span><strong>Browser-safe text and image previews only.</strong></div></details> )}
  </section> );
}
type ShoppingOffer = (typeof fixtureOffers)[number];
type ShoppingRow = { readonly line: BomLineStatus; readonly offers: readonly ShoppingOffer[]; };

/** Keep the copied proposal empty when there are no required Source rows. */
export function shoppingDraftText(rows: readonly ShoppingRow[]): string {
  return rows.map(({ line, offers: lineOffers }) => {
    const selectedOffer = lineOffers.find((offer) => offer.preferred) ?? lineOffers[0];
    const unit = line.gap?.unit ?? line.line.unit;
    const required = line.gap?.requiredQuantity ?? line.line.required;
    return `${line.line.label}: ${formatQuantity(line.remaining || required, unit)}${selectedOffer ? ` · ${selectedOffer.supplier} · ${formatMoney(selectedOffer.priceMinor, selectedOffer.currency)}` : ""}`;
  }).join("\n");
}

/** Only an explicitly recorded HTTP(S) URL may become a supplier link. */
export function recordedOfferUrl(offer: Pick<ShoppingOffer, "url">): string | undefined {
  const value = typeof offer.url === "string" ? offer.url.trim() : "";
  if (!value || !/^https?:\/\//iu.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function ShoppingList({ project: _project, summary, offers, expert, onToast, onBackToPlan }: { project: Project; summary: ReturnType<typeof calculateProjectSummary>; offers: typeof fixtureOffers; expert: boolean; onToast: (message: string, tone?: ToastTone) => void; onBackToPlan: () => void; }) {
  const [showManualCopy, setShowManualCopy] = useState(false); const missing = shoppingEligibleLines(summary);
  const rows: ShoppingRow[] = missing.map((line) => {
    // Connected candidate relationships are authoritative. This keeps an
    // uncertain/conditional substitute out of a Source row's offers even if
    // an old fixture happens to use that inventory id.
    const itemIds = new Set(shoppingOfferItemIds(line));
    return { line, offers: offers.filter((offer) => itemIds.has(offer.itemId)) };
  });
  const selectedOffers = rows.flatMap((row) => {
    const selectedOffer = row.offers.find((offer) => offer.preferred) ?? row.offers[0];
    return selectedOffer ? [selectedOffer] : [];
  });
  const totalsByCurrency = sumMoneyByCurrency(selectedOffers);
  const currencies = Object.keys(totalsByCurrency).sort() as Array<(typeof selectedOffers)[number]["currency"]>;
  const draftList = shoppingDraftText(rows);
  const copyDraftList = async () => {
    if (summary.readinessUnavailable || rows.length === 0) return;
    if (await copyTextWithFallback(draftList)) { setShowManualCopy(false);
      onToast("Draft shopping list copied to the clipboard.");
    } else { setShowManualCopy(true); onToast( "Copy did not work. Select the shopping list below and copy it manually.", "error" );
    }
  };
  const emptyState = shoppingEmptyState(summary);
  return ( <section className="surface shopping-section"><div className="shopping-header"><div><span className="eyebrow">Shopping list</span><h2>Review what to source</h2><p> {" "}
            Review recorded offers for requirements that still need sourcing.
            BenchLedger does not place orders.{" "} </p></div><div className="shopping-total" aria-label="Estimated total by currency"><span>Estimated total</span>{currencies.length ? ( <div className="shopping-total-values">{currencies.map((currency) => ( <span className="shopping-total-line" key={currency}><strong>{formatMoney(totalsByCurrency[currency] ?? 0, currency)}</strong><small>{currency}</small></span>))}</div> ) : ( <strong className="shopping-total-empty">No priced offers</strong> )}<small>{formatRequirementCount(rows.length)} in Source</small></div></div>{summary.readinessUnavailable ? ( <EmptyState icon="warning" title={emptyState.title} description={emptyState.description} /> ) : rows.length ? ( <div className="shopping-list">{rows.map(({ line, offers: lineOffers }) => { const unit = line.gap?.unit ?? line.line.unit; const required = line.gap?.requiredQuantity ?? line.line.required; return ( <div className="shopping-row" key={line.line.id}><div className="shopping-item"><span className="bom-state-mark mark-bad">!</span><div><strong>{line.line.label}</strong><span>{formatQuantity(line.remaining || required, unit)}{" "} required{" "} </span></div></div><div className="offer-stack">{lineOffers.length ? ( lineOffers.map((offer) => { const url = recordedOfferUrl(offer); const content = ( <><span className="offer-supplier">{offer.preferred && ( <Icon name="check-circle" size={14} /> )}{" "}{offer.supplier}</span><span className="offer-title">{offer.title}<small>{offer.pack} · price recorded {offer.observed}</small></span><strong>{formatMoney(offer.priceMinor, offer.currency)}</strong><span className="offer-eta">{offer.eta}</span>{url && <Icon name="external" size={14} />}</> ); return url ? ( <a className={`offer-row ${offer.preferred ? "is-preferred" : ""}`} href={url} target="_blank" rel="noreferrer" key={offer.id}>{content}<span className="sr-only">Opens in a new tab.</span> </a> ) : ( <div className={`offer-row offer-row-unlinked ${offer.preferred ? "is-preferred" : ""}`} key={offer.id}>{content}</div> ); }) ) : ( <div className="offer-empty"><Icon name="info" size={15} /><span> {" "}No supplier offer is recorded. Copy the draft list and source this item outside BenchLedger.{" "} </span></div> )}</div></div> ); })}</div> ) : ( <EmptyState icon="check-circle" title={emptyState.title} description={emptyState.description} /> )}{" "}{expert && ( <details className="expert-detail offer-notes"><summary>Offer matching rules</summary><p> {" "}BenchLedger uses exact or confirmed-alternative candidates from canonical readiness. Check and Decide lines never enter this proposal. Each offer retains its supplier, source currency, package quantity, and observation date. An offer is never purchase authority.{" "} </p></details> )}<div className="shopping-actions"><button className="button button-secondary" onClick={() => { void copyDraftList(); }} disabled={summary.readinessUnavailable || rows.length === 0}><Icon name="copy" size={16} /> Copy draft list{" "} </button><button type="button" className="button button-quiet" onClick={onBackToPlan}> {" "}Back to plan<Icon name="arrow-left" size={16} /></button></div> {showManualCopy && ( <textarea className="manual-copy-text" aria-label="Shopping list to copy manually" readOnly value={draftList} onFocus={(event) => event.currentTarget.select()} /> )} </section> );
} export function CapabilitiesPage({ expert: _expert, onCopy }: { expert: boolean; onCopy: (message: string, tone?: ToastTone) => void; }) {
  const capabilityText = `BenchLedger workspace context\n\nRead benchledger://capabilities for the current tool names, then refresh the project and inventory context before making recommendations or writes.\nUse Preview before Commit wherever the live capability contract offers that flow, and commit only after the required approval.\nUse inventory and project evidence to classify confirmed reuse, inspect-first checks, missing specifications, and source gaps.\nTreat Ready as counted or commissioned only. Treat Check as inspect-first, never as available.\nOnly required Source lines belong in a shopping proposal. Never purchase, add to cart, reserve or consume stock, publish, deploy, start or heat a printer, flash firmware, or overwrite retained evidence without explicit approval.\nArtifact upload and download bytes use the authenticated browser or HTTP Files flow; agent tools expose the live metadata contract and fail closed for generic raw transfer.`;
  const copyContext = async () => { if (await copyTextWithFallback(capabilityText)) onCopy("Agent context copied to your clipboard."); else onCopy( "Copy did not work. Select the visible context block and copy it manually.", "error" ); };
  return ( <>
    <PageHeader eyebrow="Agent access" title="Agent workspace context" description="Read the same inventory and project evidence through the web interface, REST API, or MCP." action="Copy context" actionIcon="copy" onAction={copyContext} />
    <section className="agent-callout"><div className="agent-callout-icon"><Icon name="spark" size={21} /></div><div><strong>Read capabilities before using tools.</strong><p> {" "}Use inventory and project evidence to identify reuse, required checks, and missing parts.{" "} </p></div><span className="api-status">Live contract</span></section>
    <div className="capabilities-layout"><section className="surface context-section"><SectionHeading eyebrow="Technical quickstart" title="Workspace rules" action="Copy" onAction={copyContext} /><pre className="context-block"><code>{capabilityText}</code></pre><div className="context-footer"><span><Icon name="info" size={15} /> Live tool names come from the
              capability contract.{" "} </span><code>benchledger://capabilities</code></div></section><section className="surface capability-list-section"><SectionHeading eyebrow="Safe workflow" title="How agents should work" /><ol className="capability-list agent-workflow-list"> <li><strong>Read live capabilities</strong> <span>
                Use the capability URI for current tool names and supported
                operations.
              </span></li> <li> <strong>Refresh context</strong><span>
                Read the latest project revision, inventory evidence,
                reservations, and files before deciding.
              </span></li><li> <strong>Preview changes</strong> <span>
                Use a preview flow when the live contract provides one and show
                the proposed effect.
              </span></li><li> <strong>Commit after approval</strong> <span>
                Purchases, stock use, printer control, publishing, deployment,
                and destructive changes need explicit approval.
              </span></li> </ol> <p className="context-footer"> <Icon name="info" size={15} /> Artifact upload and download bytes
            stay in the authenticated browser or HTTP Files flow.{" "}</p></section></div>
    <section className="surface agent-prompts"><SectionHeading eyebrow="Example requests" title="Common tasks" /><div className="prompt-list"><Prompt text="Can I build this with what I have?" onCopy={onCopy} /><Prompt text="Prepare a sourced shopping list. Do not place an order." onCopy={onCopy} /><Prompt text="Which stock needs a physical count before I reserve it?" onCopy={onCopy} /><Prompt text="Read the latest project revision and list the changes." onCopy={onCopy} /></div></section>
  </> );
} export function Prompt({ text, onCopy }: { text: string; onCopy: (message: string, tone?: ToastTone) => void; }) { const [showManualCopy, setShowManualCopy] = useState(false); const copy = async () => { if (await copyTextWithFallback(text)) { setShowManualCopy(false); onCopy("Request copied."); } else { setShowManualCopy(true); onCopy( "Copy did not work. Select the request below and copy it manually.", "error" ); } }; return ( <div className="prompt-copy-control"> <button type="button" className="prompt-row" onClick={() => { void copy(); }}><Icon name="spark" size={15} /><span>{text}</span><Icon name="copy" size={14} /></button> {showManualCopy && ( <textarea className="manual-copy-text" aria-label="Request to copy manually" readOnly value={text} onFocus={(event) => event.currentTarget.select()} /> )} </div> ); } export function SettingsPage({ expert, sampleMode, connection, categories, categoriesLoading, categoriesError, onRetryCategories, onCreateCategory, onUpdateCategory, onArchiveCategory, hideLogout, onExpert, onLogout }: { expert: boolean; sampleMode: boolean; connection: ConnectionState; categories: readonly ManagedInventoryCategory[]; categoriesLoading: boolean; categoriesError?: string | undefined; onRetryCategories: () => void; onCreateCategory: (input: CategoryCreateInput) => Promise<ManagedInventoryCategory | undefined>; onUpdateCategory: (id: string, input: CategoryUpdateInput, expectedVersion: number) => Promise<ManagedInventoryCategory | undefined>; onArchiveCategory: (id: string, expectedVersion: number) => Promise<ManagedInventoryCategory | undefined>; hideLogout: boolean; onExpert: () => void; onLogout: () => void; }) {
  const connected = connection === "ready"; const [systemOpen, setSystemOpen] = useState(expert); const technicalDetailsHelpId = useId(); const activeCategoryCount = categories.filter( (category) => !category.archived ).length; return ( <><PageHeader eyebrow="Workspace" title="Settings" description="Choose how much detail to show and manage your workspace." /><div className="settings-layout"><section className="surface settings-section"><SectionHeading eyebrow="Display" title="Display detail" /><div className="setting-row"><div><strong>Technical details</strong><span id={technicalDetailsHelpId}> {expert ? "Hide identifiers and technical evidence for a simpler view." : "Show identifiers, evidence, and compatibility details when you need them."} </span></div><button type="button" className={`mode-toggle setting-control ${expert ? "is-expert" : ""}`} aria-pressed={expert} aria-describedby={technicalDetailsHelpId} onClick={onExpert}><span className="mode-dot" />{expert ? "Hide technical details" : "Show technical details"}</button></div><div className="setting-row"><div><strong>Measurements</strong><span> {" "}
                Current display units include millimetres, grams, metres,
                millilitres, pieces, and sets. This value is not editable.{" "} </span></div><span className="setting-value"> {expert ? "millimetre · gram · metre · millilitre · each · set" : "mm · g · m · millilitres · pieces · sets"} </span></div><div className="setting-row"><div><strong>Currency</strong><span> {" "}Each supplier price keeps its source currency and observation date. This value is not editable.{" "} </span></div><span className="setting-value">Source currency</span></div></section>{categoriesLoading && ( <div className="category-loading" role="status" aria-live="polite"><Icon name="refresh" size={16} /> Loading inventory categories…{" "} </div> )}{" "}{categoriesError ? ( <section className="surface settings-section category-load-error" role="alert"><Icon name="warning" size={18} /><div><strong>Could not load inventory categories.</strong><span>{categoriesError}</span></div><button type="button" className="button button-secondary" onClick={onRetryCategories}> {" "}Try again{" "} </button></section> ) : !categoriesLoading ? ( <details className="surface settings-section settings-category-details"> <summary> <span> <span className="eyebrow">Inventory</span> <strong>Categories · {activeCategoryCount}</strong> <small>Organize items and subcategories</small> </span> <Icon name="chevron-down" size={15} /> </summary> <div className="settings-category-content"> <CategoryManager categories={categories} onCreate={onCreateCategory} onUpdate={onUpdateCategory} onArchive={onArchiveCategory} /> </div> </details> ) : null}<details className="surface settings-section settings-system-details" open={systemOpen} onToggle={(event) => setSystemOpen(event.currentTarget.open)} > <summary> <span> <span className="eyebrow">System</span> <strong>{expert ? "Connection details" : "Connection and agent access"}</strong> {expert && <small>API connection and agent access</small>} </span> <Icon name="chevron-down" size={15} /> </summary> <section className="settings-system-content"><SectionHeading eyebrow="Connection" title={expert ? "Private API" : "Workspace connection"} /><div className="connection-panel"><div className="connection-panel-top"><span className="connection-icon"><Icon name="link" size={18} /></span><div><strong>{sampleMode ? "Sample workspace" : expert ? "Local workspace adapter" : "Your private workspace"}</strong><span>{sampleMode ? "Practice data" : expert ? "Connected to /api/v1" : "Connected to your workspace"}</span></div><span className="connection-badge"><span className={`online-dot ${connected || sampleMode ? "" : "is-offline"}`} /> {sampleMode ? "Sample mode" : connected ? "Connected" : "Session error"}</span></div><p>{sampleMode ? (expert ? "This workspace contains synthetic records. Changes remain in the sample workspace." : "This workspace contains practice data. Changes remain in the sample workspace.") : expert ? "The browser sends supported reads and writes to the authenticated private service. It reports failed writes." : "Your private workspace is connected. Changes stay in this workspace."}</p></div><div className="setting-row setting-row-last"><div><strong>{expert ? "MCP endpoint" : "Agent connection"}</strong><span> {" "}{expert ? "Use a scoped token. Read the capability manifest before you use tools." : "Your connected agent can read the workspace when you allow it."}{" "} </span></div>{expert ? <code className="setting-value">benchledger://capabilities</code> : <span className="setting-value">Agent access</span>}</div>{!hideLogout && ( <button className="button button-quiet settings-logout" onClick={onLogout}><Icon name="arrow-left" size={16} /> {sampleMode ? "Close sample workspace" : "Sign out"}</button> )}</section></details> {expert && ( <section className="surface settings-section"><SectionHeading eyebrow="Decision states" title="Inventory evidence rules" /><div className="evidence-legend"><Legend tone="good" title="Ready" text="A physical count or commissioning record confirms the stock." /><Legend tone="warn" title="Check" text="Count delivered or uncertain stock before you reuse it." /><Legend tone="bad" title="Source" text="Confirmed compatible stock does not cover the requirement." /></div></section> )} </div></> );
}

function Legend({ tone, title, text }: { tone: StockLabelTone; title: string; text: string; }) { return ( <div className="legend-row"><span className={`legend-mark mark-${tone}`}>{tone === "good" ? "✓" : tone === "warn" ? "?" : "!"}</span><div><strong>{title}</strong><span>{text}</span></div></div> ); }

const focusableOverlaySelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1'])";

function useOverlayBehavior(containerRef: React.RefObject<HTMLElement | null>, onClose: () => void, active = true) {
  const closeRef = useRef(onClose);
  const activeRef = useRef(active); const returnFocusRef = useRef<HTMLElement | undefined>( typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : undefined ); closeRef.current = onClose;
  activeRef.current = active;
  useEffect(() => {
    const previousFocus = returnFocusRef.current;
    const container = containerRef.current;
    const focusFirstControl = () => {
      const first = container?.querySelector<HTMLElement>("[data-autofocus]")
        ?? container?.querySelector<HTMLElement>("form input:not([disabled]), form textarea:not([disabled]), form select:not([disabled])")
        ?? container?.querySelector<HTMLElement>(focusableOverlaySelector);
      first?.focus({ preventScroll: true }); if (container) container.scrollTop = 0; };
    focusFirstControl();
    // The background becomes inert in the same render as the dialog. Some
    // browsers clear focus from the triggering control after that attribute
    // changes, so repeat the handoff after the browser applies inertness.
    const deferredFocus = window.setTimeout(focusFirstControl, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !container) return;
      const focusable = [...container.querySelectorAll<HTMLElement>(focusableOverlaySelector)];
      if (!focusable.length) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!container.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.clearTimeout(deferredFocus);
      if (previousFocus?.isConnected) {
        let restoreAttempts = 0;
        const restoreFocus = () => {
          if (!previousFocus.isConnected) return;
          previousFocus.focus({ preventScroll: true });
          restoreAttempts += 1;
          if (document.activeElement !== previousFocus && restoreAttempts < 3) window.setTimeout(restoreFocus, 16);
        };
        window.setTimeout(restoreFocus, 0);
      }
    };
  }, [containerRef]);
}

export function InventoryDrawer({ item, items = [item], categories, categoriesLoading, categoriesError, expert, onClose, onCount, onCommission, onUpdate, onLinkProduct, onCreateReplacement }: { item: InventoryItem; items?: readonly InventoryItem[]; categories: readonly ManagedInventoryCategory[]; categoriesLoading: boolean; categoriesError?: string | undefined; expert: boolean; onClose: () => void; onCount: (id: string, quantity: number) => Promise<InventoryItem>; onCommission: (id: string, input: InventoryCommissionInput, expectedVersion: number) => Promise<InventoryItem>; onUpdate: (id: string, input: Partial<InventoryUpdateInput>, expectedVersion?: number) => Promise<InventoryItem>; onLinkProduct?: (item: InventoryItem) => void; onCreateReplacement?: (item: InventoryItem) => void; }) {
  const unverifiedQuantity = item.evidence === "delivered" || item.evidence === "ordered";
  const [quantity, setQuantity] = useState(unverifiedQuantity ? "" : String(item.quantity));
  const [countSaving, setCountSaving] = useState(false);
  const [countError, setCountError] = useState<string>();
  const [countSaved, setCountSaved] = useState<string>();
  const [mutationReview, setMutationReview] = useState<InventoryMutationReview>();
  const [commissionQuantity, setCommissionQuantity] = useState("");
  const [commissionSource, setCommissionSource] = useState(item.provenance?.source ?? "");
  const [commissionSourceId, setCommissionSourceId] = useState(item.provenance?.sourceId ?? "");
  const [commissionObservedAt, setCommissionObservedAt] = useState(() => localDateTimeValue(item.provenance?.observedAt));
  const [commissionNote, setCommissionNote] = useState("");
  const [commissionSaving, setCommissionSaving] = useState(false);
  const [commissionError, setCommissionError] = useState<string>();
  const [commissionSaved, setCommissionSaved] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string>();
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [model, setModel] = useState(item.model ?? "");
  const [manufacturer, setManufacturer] = useState(item.manufacturer ?? "");
  const [sku, setSku] = useState(item.sku ?? "");
  const [location, setLocation] = useState(item.location === "Unassigned" ? "" : item.location);
  const [tags, setTags] = useState(item.tags.join(", "));
  const [categoryNodeId, setCategoryNodeId] = useState(item.categoryNodeId ?? "");
  const drawerRef = useRef<HTMLElement>(null);
  const drawerTitleId = useId();
  const availableForReuse = item.availableQuantity ?? Math.max(item.quantity - item.reserved, 0);
  const itemIdentity = inventoryCandidateText(item, items, expert);
  useOverlayBehavior(drawerRef, onClose, !mutationReview);
  const reviewCount = (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(quantity);
    setCountError(undefined);
    setCountSaved(undefined);
    if (!quantity.trim() || !Number.isFinite(parsed) || parsed < 0) {
      setCountError("Enter a quantity of zero or greater.");
      return;
    }
    setMutationReview({ kind: "count", quantity: parsed });
  };

  const submitCount = async () => {
    if (mutationReview?.kind !== "count" || countSaving) return;
    setCountSaving(true);
    try {
      const result = await onCount(item.id, mutationReview.quantity);
      setQuantity(String(result.quantity));
      setCountSaved(`Confirmed ${formatQuantity(result.quantity, result.unit)} as the on-hand quantity.`);
      setMutationReview(undefined);
    } catch (error: unknown) {
      setCountError(normalizeApiError(error).message);
    } finally {
      setCountSaving(false);
    }
  };

  const reviewCommission = (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(commissionQuantity);
    const observedAt = observedAtFromLocalDateTime(commissionObservedAt);
    setCommissionError(undefined);
    setCommissionSaved(undefined);
    if (!commissionQuantity.trim() || !Number.isFinite(parsed) || parsed < 0) {
      setCommissionError("Enter a quantity of zero or greater.");
      return;
    }
    if (!commissionSource.trim()) {
      setCommissionError("Add the source of this commissioning observation.");
      return;
    }
    if (!observedAt) {
      setCommissionError("Add when this quantity was observed.");
      return;
    }
    if (item.version === undefined) {
      setCommissionError("Reload this item before commissioning it.");
      return;
    }
    setMutationReview({
      kind: "commission",
      input: {
        quantity: parsed,
        source: commissionSource.trim(),
        ...(commissionSourceId.trim() ? { sourceId: commissionSourceId.trim() } : {}),
        observedAt,
        ...(commissionNote.trim() ? { note: commissionNote.trim() } : {})
      }
    });
  };

  const submitCommission = async () => {
    if (mutationReview?.kind !== "commission" || commissionSaving || item.version === undefined) return;
    setCommissionSaving(true);
    try {
      const result = await onCommission(item.id, mutationReview.input, item.version);
      setCommissionQuantity(String(result.quantity));
      setQuantity(String(result.quantity));
      setCommissionSaved(`Commissioned ${formatQuantity(result.quantity, result.unit)} as confirmed stock.`);
      setMutationReview(undefined);
    } catch (error: unknown) {
      setCommissionError(normalizeApiError(error).message);
    } finally {
      setCommissionSaving(false);
    }
  };

  const cancelEdit = () => {
    setName(item.name);
    setDescription(item.description);
    setModel(item.model ?? "");
    setManufacturer(item.manufacturer ?? "");
    setSku(item.sku ?? "");
    setLocation(item.location === "Unassigned" ? "" : item.location);
    setTags(item.tags.join(", "));
    setCategoryNodeId(item.categoryNodeId ?? "");
    setEditError(undefined);
    setEditing(false);
  };

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    setEditError(undefined);
    if (!name.trim()) {
      setEditError("Enter an item name.");
      return;
    }
    setEditSaving(true);
    try {
      await onUpdate(item.id, {
        name: name.trim(),
        description: description.trim(),
        model: model.trim(),
        manufacturer: manufacturer.trim(),
        sku: sku.trim(),
        location: location.trim(),
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        ...(categoryNodeId ? { categoryNodeId } : {})
      }, item.version);
      setEditing(false);
    } catch (error: unknown) {
      setEditError(normalizeApiError(error).message);
    } finally {
      setEditSaving(false);
    }
  };

  return ( <>
    <div className="drawer-scrim" aria-hidden="true" onClick={onClose} />
    <aside ref={drawerRef} className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby={drawerTitleId} aria-hidden={mutationReview ? true : undefined} inert={mutationReview ? true : undefined} tabIndex={-1}>
      <div className="drawer-header"><span className={`item-glyph accent-${item.accent}`} aria-hidden="true"><Icon name={categoryIcons[item.category]} size={18} /></span><div><span className="eyebrow">{managedInventoryLabel(categories, item)}</span><h2 id={drawerTitleId}>{itemIdentity}</h2></div><button type="button" className="icon-button" data-autofocus aria-label="Close item details" onClick={onClose}><Icon name="close" size={20} /></button></div>
      <div className="drawer-body">
        <div className="drawer-title-actions"><StatusPill state={displayedInventoryState(item)} {...(item.unitStatus === "needs_correction" ? { label: "Fix unit" } : {})} />{!editing && ( <button type="button" className="button button-secondary" onClick={() => setEditing(true)}> {" "}Edit item{" "} </button> )}</div>
        {item.unitStatus === "needs_correction" && ( <section className="unit-correction-callout" role="alert"><strong>This record cannot be used yet</strong><span>{" "}
                This unit does not match this item type. Create a corrected
                replacement before you use this record. The original stays
                blocked as history.{" "} </span>{onCreateReplacement && ( <button type="button" className="button button-secondary" onClick={() => onCreateReplacement(item)}> {" "}
                  Fix unit{" "} </button> )}{" "}{expert && ( <small> {" "}Recorded unit: {" "} <code>{inventoryUnitLabel(item.unit, true, item.serverUnit)}</code>{" "}. Historical quantities and evidence are not rewritten.{" "} </small> )}</section> )}{" "} {!item.kind && ( <section className="unit-correction-callout" role="status"> <strong>Item type not recorded</strong> <span>
                Create a corrected record before using this item in a project.
                The original evidence and reservations stay unchanged.
              </span> {onCreateReplacement && ( <button type="button" className="button button-secondary" onClick={() => onCreateReplacement(item)} >
                  Create corrected record
                </button> )}</section> )}{" "}
        {editing ? ( <form className="inventory-edit-form" onSubmit={(event) => { void submitEdit(event); }} aria-busy={editSaving}>
          <p className="drawer-section-copy"> {" "}Edit item identification and storage fields. Change quantity with a physical count.{" "} </p>
          <label className="form-field"><span>Name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} disabled={editSaving} /></label>
          <label className="form-field"><span>Description</span><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} disabled={editSaving} /></label>
          <div className="inventory-edit-grid">
            <label className="form-field"><span>Model or variant</span><input value={model} onChange={(event) => setModel(event.target.value)} disabled={editSaving} /></label>
            <label className="form-field"><span>Manufacturer</span><input value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} disabled={editSaving} /></label>
            <label className="form-field"><span>SKU</span><input value={sku} onChange={(event) => setSku(event.target.value)} disabled={editSaving} /></label>
            <label className="form-field"><span>Location</span><input value={location} onChange={(event) => setLocation(event.target.value)} disabled={editSaving} /></label>
          </div>
          <label className="form-field"><span>Tags</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Separate tags with commas" disabled={editSaving} /></label>
          {categoriesError ? ( <p className="field-hint category-edit-note" role="alert"> {" "}Managed categories are unavailable: {categoriesError}</p> ) : categoriesLoading ? ( <p className="field-hint category-edit-note" role="status"> {" "}Loading active categories…{" "} </p> ) : ( <CategorySelection categories={categories} value={categoryNodeId} onChange={setCategoryNodeId} required={Boolean(item.categoryNodeId)} ariaInvalid={Boolean(item.categoryNodeId && !managedCategoryForId(categories, item.categoryNodeId))} /> )}{" "}
          {editError && ( <p className="form-error" role="alert">{editError}</p> )}
          <div className="drawer-form-actions"><button type="button" className="button button-quiet" onClick={cancelEdit} disabled={editSaving}> {" "}Cancel{" "} </button><button type="submit" className="button button-primary" disabled={!name.trim() || editSaving}>{editSaving ? "Saving…" : "Save changes"}</button></div>
        </form> ) : ( <>
          <p className="drawer-description">{item.description}</p>
          {(item.category === "Filament" || item.category === "Printers") && ( <div className="exact-product-callout"><strong>{expert ? exactProductLabel(item) : "Product match"}</strong><span>{exactProductLabel(item) === "Product identity incomplete" ? "This catalog record does not include the recorded bundle or variant." : item.productProfile?.linkState === "confirmed" ? "Product identity confirmed for setup matching." : "Check the physical item before you link an exact product."}</span> {onLinkProduct && ( <button type="button" className="text-button" onClick={() => onLinkProduct(item)} > {item.productProfile ? "Change exact product" : "Link exact product"} <Icon name="arrow-right" size={14} /> </button> )} </div> )}
          <div className="drawer-facts"><div><span>Item type</span><strong>{item.kind ?? "Not recorded"}</strong></div>{item.category === "Printers" && ( <div className="printer-volume-fact"> <span> {isExactProductConfirmed(item) ? "Confirmed build volume" : "Recorded build volume"} </span> <strong> {printerBuildVolumeCopy(item) ?? "Not recorded"} </strong> </div> )} {item.variant ? ( <div><span>Model or variant</span><strong>{item.variant}</strong></div> ) : ( <div><span>Model or variant</span><strong>Model not recorded</strong></div> )}<div><span>Location</span><strong>{inventoryLocationLabel(item.location)}</strong></div>{item.manufacturer && ( <div><span>Manufacturer</span><strong>{item.manufacturer}</strong></div> )}{" "}{item.sku && ( <div><span>SKU</span><code>{item.sku}</code></div> )}{" "}{item.productProfile?.filament?.lotBatch && ( <div><span>Lot or batch</span><strong>{item.productProfile.filament.lotBatch}</strong></div> )}{" "}{item.productProfile?.printer?.assetLabel && ( <div><span>Asset label</span><strong>{item.productProfile.printer.assetLabel}</strong></div> )}</div>
        </> )}{" "}

        {expert && unverifiedQuantity && item.unitStatus !== "needs_correction" && ( <section className="drawer-quantity" aria-labelledby="commission-heading"><div><span className="eyebrow" id="commission-heading"> {" "}
                    Technical stock evidence{" "} </span><strong>Commission received stock</strong><span> {" "}Record a physical observation while retaining the delivery evidence.{" "} </span><p> {" "}Use this only when you need an explicit source and observation time in the audit trail.{" "} </p></div><form className="count-form" onSubmit={(event) => reviewCommission(event)}><label htmlFor="commission-quantity">Observed quantity</label><div><input id="commission-quantity" type="number" min="0" step="any" inputMode="decimal" value={commissionQuantity} onChange={(event) => setCommissionQuantity(event.target.value)} disabled={commissionSaving} /><span>{inventoryUnitLabel(item.unit, expert, item.serverUnit)}</span></div><label className="form-field"><span>Source</span><input required value={commissionSource} maxLength={500} placeholder="Physical check, delivery record, or project log" onChange={(event) => setCommissionSource(event.target.value)} disabled={commissionSaving} /></label><label className="form-field"><span>Observed</span><input required type="datetime-local" value={commissionObservedAt} onChange={(event) => setCommissionObservedAt(event.target.value)} disabled={commissionSaving} /></label><label className="form-field"><span> {" "}Source ID <small>(optional)</small></span><input value={commissionSourceId} maxLength={500} placeholder="Evidence reference" onChange={(event) => setCommissionSourceId(event.target.value)} disabled={commissionSaving} /></label><label className="form-field"><span> {" "}Note <small>(optional)</small></span><textarea rows={2} maxLength={1000} value={commissionNote} placeholder="What did you observe?" onChange={(event) => setCommissionNote(event.target.value)} disabled={commissionSaving} /></label><button type="submit" className="button button-secondary" disabled={commissionSaving}>{commissionSaving ? "Saving…" : "Review commissioning"}</button>{commissionError && ( <p className="form-error" role="alert">{commissionError}</p> )}{" "}{commissionSaved && ( <p className="form-success" role="status">{commissionSaved}</p> )}</form></section> )}

        <section className="drawer-quantity" aria-labelledby="physical-count-heading"><div><span className="eyebrow">Stock check</span><strong id="physical-count-heading"> {item.unitStatus === "needs_correction" ? "Quantity blocked" : "Confirm physical count"} </strong><span>{item.unitStatus === "needs_correction" ? "Create and count a corrected replacement before reusing this stock." : item.reserved ? `${formatQuantity(item.reserved, item.unit)} reserved; ${formatQuantity(availableForReuse, item.unit)} currently available for reuse.` : `Recorded quantity: ${formatQuantity(item.quantity, item.unit)}.`}</span><p> {item.unitStatus === "needs_correction" ? "The recorded quantity is retained as history until its unit is corrected." : "Count what is physically in front of you, then enter that quantity here."} </p></div> {item.unitStatus !== "needs_correction" && ( <form className="count-form" onSubmit={(event) => reviewCount(event)}><label htmlFor="count-quantity">Counted quantity</label><div><input id="count-quantity" type="number" min="0" step="any" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={countSaving} /><span>{inventoryUnitLabel(item.unit, expert, item.serverUnit)}</span></div><button type="submit" className="button button-secondary" disabled={countSaving}>{countSaving ? "Saving…" : "Review physical count"}</button>{countError && ( <p className="form-error" role="alert">{countError}</p> )}{" "}{countSaved && ( <p className="form-success" role="status">{countSaved}</p> )}</form> )} </section>

        {expert && ( <section className="provenance-panel" aria-labelledby="provenance-heading"><div><span className="eyebrow" id="provenance-heading"> {" "}Provenance{" "} </span><strong>{evidenceLabel(item.evidence, item.serverEvidence)}</strong></div><dl><div><dt>Source</dt><dd>{item.provenance?.source ?? "Not recorded"}</dd></div><div><dt>Observed</dt><dd>{item.provenance?.observedAt ? item.provenance.observedAt.slice(0, 10) : "Not recorded"}</dd></div>{item.provenance?.sourceId && ( <div><dt>Source record</dt><dd><code>{item.provenance.sourceId}</code></dd></div> )}{" "}{item.provenance?.note && ( <div><dt>Note</dt><dd>{item.provenance.note}</dd></div> )}</dl></section> )}{" "}

        {expert && ( <details className="expert-detail" open><summary>Technical evidence</summary><div className="detail-grid"><div><span>Item ID</span><div className="expert-value"><code>{item.id}</code><CopyValueButton value={item.id} /></div></div><div><span>Item kind</span><code>{item.kind ?? "Not recorded"}</code></div><div><span>Category node</span><code>{item.categoryNodeId ?? "Not assigned"}</code></div><div><span>Evidence state</span><code>{item.evidence}</code></div><div><span>Exact link state</span><code>{item.productProfile?.linkState ?? "not linked"}</code></div><div><span>Catalog product</span><code>{item.catalogProduct?.id ?? "Not recorded"}</code></div><div><span>Version</span><code>{item.version ?? "Not recorded"}</code></div><div><span>Dimensions</span><code>{item.dimensions ? formatDimensions(item.dimensions) : "Not recorded"}</code></div><div><span>Tags</span><code>{item.tags.join(" · ") || "None"}</code></div></div><div className="compatibility-box"><span>Compatibility notes</span>{item.compatibility.length ? ( <ul>{item.compatibility.map((note) => ( <li key={note}>{note}</li>))}</ul> ) : ( <p>No compatibility evidence is recorded.</p> )}</div></details> )}
      </div>
    </aside>
    {mutationReview && ( <InventoryMutationReviewDialog item={item} review={mutationReview} saving={mutationReview.kind === "count" ? countSaving : commissionSaving} onClose={() => { if (!countSaving && !commissionSaving) setMutationReview(undefined); }} onConfirm={() => { void (mutationReview.kind === "count" ? submitCount() : submitCommission()); }} /> )}
  </> );
}

function InventoryMutationReviewDialog({ item, review, saving, onClose, onConfirm }: { item: InventoryItem; review: InventoryMutationReview; saving: boolean; onClose: () => void; onConfirm: () => void; }) {
  const isCount = review.kind === "count";
  const newQuantity = isCount ? review.quantity : review.input.quantity;
  const oldEvidence = evidenceLabel(item.evidence, item.serverEvidence);
  const newEvidence = isCount ? "Physically counted" : "Commissioned";
  const effect = isCount
    ? "Records this physical count and updates the quantity available for reuse."
    : "Marks the received stock as commissioned and makes the observed quantity available for reuse; delivery evidence remains retained.";
  return ( <Dialog title={isCount ? "Review physical count" : "Review stock commissioning"} role="alertdialog" onClose={onClose}>
    <p className="dialog-intro"> {" "}Check the recorded change before saving it to inventory.{" "} </p>
    <div className="inventory-selection-summary">
      <span><strong>Item</strong>{item.name}<small>{item.variant}</small></span>
      <span><strong>Old value</strong>{formatQuantity(item.quantity, item.unit)}<small>{oldEvidence}</small></span>
      <span><strong>New value</strong>{formatQuantity(newQuantity, item.unit)}<small>{newEvidence}</small></span>
      <span><strong>Effect</strong>{effect}</span>
      {!isCount && ( <span><strong>Observation</strong>{review.input.source} · {review.input.observedAt}</span> )}
    </div>
    <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={saving}> {" "}Back to item{" "} </button><button type="button" className="button button-primary" onClick={onConfirm} disabled={saving} aria-busy={saving}>{saving ? "Saving…" : isCount ? "Confirm physical count" : "Commission stock"}<Icon name="check" size={16} /></button></div>
  </Dialog> );
} export function NewProjectDialog({ items = [], suspended = false, onClose, onAddPrinter, onCreate }: { items?: InventoryItem[]; suspended?: boolean; onClose: () => void; onAddPrinter?: (() => void) | undefined; onCreate: (input: ProjectCreateInput) => Promise<ProjectCreateOutcome>; }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fabricationRoute, setFabricationRoute] = useState<FabricationRoute>("undecided"); const [printer, setPrinter] = useState<InventoryItem>(); const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  if (suspended) return null;
  const printers = items.filter(isUsableOwnedPrinter); const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setFormError(undefined);
    try {
      const outcome = await onCreate({ name: name.trim(), description: description.trim(), fabricationRoute, ...(fabricationRoute === "printed" && printer ? { intendedPrinterItemId: printer.id } : {}) });
      if (outcome === "failed") setFormError("The project was not created. Check the service connection and try again.");
      if (outcome === "ambiguous") setFormError(ambiguousProjectCreationMessage);
    } catch (error: unknown) {
      setFormError(normalizeApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  }; return ( <Dialog title="Create project" onClose={onClose}><form onSubmit={(event) => { void submit(event); }}><p className="dialog-intro"> {" "}
          Enter a project name and goal, then choose how you might build it. You
          can change this later.{" "} </p> <label className="form-field"> <span>Project name</span> <input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Desk sensor enclosure" disabled={submitting} /> </label><label className="form-field"><span>Project goal</span><textarea required value={description} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder="Describe the required result" disabled={submitting} /></label><fieldset className="fabrication-route-options" aria-describedby="fabrication-route-help" ><legend>How will you build it?</legend> {fabricationRouteOptions.map((option) => ( <label className={`fabrication-route-option ${fabricationRoute === option.value ? "is-selected" : ""}`} key={option.value}><input type="radio" name="fabrication-route" value={option.value} checked={fabricationRoute === option.value} onChange={() => setFabricationRoute(option.value)} disabled={submitting} /><span> <strong>{option.label}</strong><small>{option.description}</small> </span></label> ))} <p id="fabrication-route-help"> {" "}
            This is a planning choice. It does not buy, reserve, or build
            anything.{" "} </p> </fieldset> {fabricationRoute === "printed" && ( <div className="route-printer-picker"> {printers.length ? ( <OwnedItemCombobox category="Printers" items={printers} value={printer} onSelect={setPrinter} label="Printer for this project" helper="Leave blank if you have not decided yet." showInitialChoices /> ) : ( <div className="printer-reassurance"> <strong>No owned printer recorded yet.</strong><span> {" "}
                  That’s fine—you can add one later, or use a ready-made or
                  electronics-only approach.{" "} </span> {onAddPrinter && ( <button type="button" className="text-button" onClick={onAddPrinter} disabled={submitting} > {" "}
                    Add printer <Icon name="plus" size={14} /></button> )} </div> )} </div> )}{" "} {formError && ( <p className="form-error" role="alert">{formError}</p> )}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}> {" "}Cancel{" "} </button><button type="submit" className="button button-primary" disabled={!name.trim() || !description.trim() || submitting} aria-busy={submitting}>{submitting ? "Creating…" : "Create project"} {" "} {!submitting && <Icon name="arrow-right" size={16} />}</button></div></form></Dialog> ); } export function revisionInputForRoute({ name, status, notes, fabricationRoute, intendedPrinterItemId, printerSelectionTouched = false, buildConfig }: { name: string; status: string; notes: string; fabricationRoute: FabricationRoute; intendedPrinterItemId?: string | null; printerSelectionTouched?: boolean; buildConfig?: BuildConfigInput; }): RevisionInput { return { name: name.trim(), status: status || "concept", ...(notes.trim() ? { notes: notes.trim() } : {}), fabricationRoute, ...(printerSelectionTouched ? { intendedPrinterItemId: fabricationRoute === "printed" ? (intendedPrinterItemId ?? null) : null } : {}), ...(fabricationRoute === "printed" && buildConfig ? { buildConfig } : {}) } as RevisionInput;
}

export function NewRevisionDialog({ project, items, expert, suspended = false, onClose, onAddPrinterDetails, onAddPrinter, onCreate }: { project: Project; items: InventoryItem[]; expert: boolean; suspended?: boolean; onClose: () => void; onAddPrinterDetails?: ((item: InventoryItem) => void) | undefined; onAddPrinter?: (() => void) | undefined; onCreate: (input: RevisionInput) => Promise<boolean>; }) {
  const carriedPrinterId = projectIntendedPrinterId(project); const carriedPrinter = carriedPrinterId ? items.find((item) => item.id === carriedPrinterId) : undefined; const carriedFilament = project.buildConfigSnapshot?.filamentItemId ? items.find( (item) => item.id === project.buildConfigSnapshot?.filamentItemId ) : undefined; const selectablePrinters = items.filter(isUsableOwnedPrinter); const [name, setName] = useState("");
  const [status, setStatus] = useState("concept");
  const [fabricationRoute, setFabricationRoute] = useState<FabricationRoute>( () => project.fabricationRoute ?? (carriedPrinter ? "printed" : "undecided") ); const [notes, setNotes] = useState("");
  const [printer, setPrinter] = useState<InventoryItem | undefined>( carriedPrinter ); const [printerChanged, setPrinterChanged] = useState(false);
  const [filament, setFilament] = useState<InventoryItem | undefined>( carriedFilament );
  const [hotendSide, setHotendSide] = useState("");
  const [nozzleDiameter, setNozzleDiameter] = useState("");
  const [nozzleMaterial, setNozzleMaterial] = useState("");
  const [buildPlate, setBuildPlate] = useState("");
  const [accessories, setAccessories] = useState("");
  const [firmware, setFirmware] = useState("");
  const [slicer, setSlicer] = useState("");
  const [slicerVersion, setSlicerVersion] = useState("");
  const [profile, setProfile] = useState("");
  const [calibration, setCalibration] = useState("");
  const [unknowns, setUnknowns] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>(); if (suspended) return null; const printerEligibility = printer ? buildItemEligibility(printer, "Printers") : { eligible: false, reason: "Choose an exact owned printer before saving build setup." };
  const printerNeedsDetails = Boolean( printer && printer.unitStatus !== "needs_correction" && !isExactProductIdentityComplete(printer) ); const filamentEligibility = filament ? buildItemEligibility(filament, "Filament") : { eligible: true };
  const setupWarnings = expert && fabricationRoute === "printed" ? [ ...(printer && !isUsableOwnedPrinter(printer) ? [ "This printer is not available as an owned capability until it is physically counted or commissioned." ] : []), ...(printer && !printerEligibility.eligible ? [ printerNeedsDetails ? "Add the exact printer model and variant before saving this setup." : (printerEligibility.reason ?? "This printer cannot be used for this setup yet.") ] : []),
    ...(filament && !filamentEligibility.eligible ? [ filamentEligibility.reason ?? "Choose physical filament with confirmed evidence before saving this setup." ] : [])
  ] : [];
  const buildConfig: BuildConfigInput = {
    ...(printer ? { printerItemId: printer.id, ...(printer.productProfile?.id ? { printerProfileId: printer.productProfile.id } : {}), ...(printer.catalogProduct ? { printerProductId: printer.catalogProduct.id } : {}) } : {}),
    ...(filament ? { filamentItemId: filament.id, ...(filament.productProfile?.id ? { filamentProfileId: filament.productProfile.id } : {}), ...(filament.catalogProduct ? { filamentProductId: filament.catalogProduct.id } : {}), filamentSelections: [buildFilamentSelection(filament)] } : {}),
    ...(hotendSide.trim() ? { hotendSide: hotendSide.trim() } : {}),
    ...(Number.isFinite(Number(nozzleDiameter)) && Number(nozzleDiameter) > 0 ? { nozzleDiameterMm: Number(nozzleDiameter) } : {}),
    ...(nozzleMaterial.trim() ? { nozzleMaterial: nozzleMaterial.trim() } : {}), ...(buildPlate.trim() ? { buildPlate: buildPlate.trim() } : {}), accessories: splitSetupValues(accessories), ...(firmware.trim() ? { firmware: firmware.trim() } : {}), ...(slicer.trim() ? { slicer: slicer.trim() } : {}), ...(slicerVersion.trim() ? { slicerVersion: slicerVersion.trim() } : {}), ...(profile.trim() ? { profile: profile.trim() } : {}), ...(calibration.trim() ? { calibration: calibration.trim() } : {}), unknowns: splitSetupValues(unknowns) }; const submit = async (event: FormEvent) => { event.preventDefault(); if (!name.trim() || submitting) return; setSubmitting(true); setFormError(undefined); try { // Beginner mode records only planning context. An immutable setup
// snapshot is an Expert action and still needs exact, usable identities.
const exactBuildConfig = expert && printer && isUsableOwnedPrinter(printer) && printerEligibility.eligible && !printerNeedsDetails && filamentEligibility.eligible ? buildConfig : undefined; const created = await onCreate( revisionInputForRoute({ name, status: expert ? status : "concept", notes, fabricationRoute, ...(printer?.id === undefined ? {} : { intendedPrinterItemId: printer.id }), printerSelectionTouched: printerChanged, ...(exactBuildConfig ? { buildConfig: exactBuildConfig } : {}) }) ); if (!created) setFormError( "The revision was not created. Check the service connection and try again." ); } catch (error: unknown) { setFormError(normalizeApiError(error).message); } finally { setSubmitting(false); } }; return ( <Dialog title={`New revision for ${project.name}`} onClose={onClose}> <form onSubmit={(event) => { void submit(event); }} > <p className="dialog-intro"> {" "}
          Choose how this revision will be built. You can carry the previous
          approach forward and change it later.{" "} </p> <label className="form-field"> <span>Revision name</span> <input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. R02 enclosure fit" disabled={submitting} /> </label> <fieldset className="fabrication-route-options" aria-describedby="revision-fabrication-route-help" > <legend>How will you build it?</legend> {fabricationRouteOptions.map((option) => ( <label className={`fabrication-route-option ${fabricationRoute === option.value ? "is-selected" : ""}`} key={option.value} > <input type="radio" name="revision-fabrication-route" value={option.value} checked={fabricationRoute === option.value} onChange={() => setFabricationRoute(option.value)} disabled={submitting} /> <span> <strong>{option.label}</strong> <small>{option.description}</small> </span> </label> ))} <p id="revision-fabrication-route-help"> {" "}
            This is planning context only. It does not buy, reserve, or
            build anything.{" "} </p> </fieldset> {fabricationRoute === "printed" && ( <> <div className="setup-picker-grid"> <OwnedItemCombobox category="Printers" items={selectablePrinters} value={printer} onSelect={(selection) => { setPrinter(selection); setPrinterChanged(true); }} onResolveItem={ printerNeedsDetails ? onAddPrinterDetails : undefined } label="Printer for this revision" helper="Leave blank if you have not decided yet." /> {expert && ( <OwnedItemCombobox category="Filament" items={items} value={filament} onSelect={setFilament} label="Filament (optional technical setup)" /> )} </div> {!printer && ( <div className="printer-reassurance"> <strong>No printer selected yet.</strong> <span> {" "}
                  That’s fine—you can choose or add an owned printer later.{" "} </span> {onAddPrinter && ( <button type="button" className="text-button" onClick={onAddPrinter} disabled={submitting} > {" "}
                    Add printer <Icon name="plus" size={14} /> </button> )} </div> ) }{" "} {setupWarnings.length > 0 && ( <div className="setup-warnings" role="status"> <strong>Setup details need attention</strong> {setupWarnings.map((warning) => ( <span key={warning}>{warning}</span> ))} </div> ) }{" "} {expert && printer && ( <BuildSetupSummary input={buildConfig} printer={printer} filament={filament} expert heading="Read-only setup record for this revision" /> )} </> ) }{" "} {expert && ( <details className="advanced-setup" open> <summary>Technical details</summary> <label className="form-field"> <span> {" "}
                Starting state <small>(technical override)</small> </span> <select value={status} onChange={(event) => setStatus(event.target.value)} disabled={submitting}><option value="concept">Concept</option> <option value="CAD complete">CAD complete</option> <option value="DFAM reviewed">DFAM reviewed</option> </select> </label> {fabricationRoute === "printed" && ( <div className="advanced-setup-grid"><label className="form-field"><span>Hotend side</span><input value={hotendSide} onChange={(event) => setHotendSide(event.target.value)} placeholder="Single nozzle / left / right" disabled={submitting} /></label><label className="form-field"><span>Nozzle diameter (mm)</span><input type="number" min="0.1" step="0.01" value={nozzleDiameter} onChange={(event) => setNozzleDiameter(event.target.value)} placeholder="0.4" disabled={submitting} /></label><label className="form-field"><span>Nozzle material</span><input value={nozzleMaterial} onChange={(event) => setNozzleMaterial(event.target.value)} placeholder="Hardened steel" disabled={submitting} /></label><label className="form-field"><span>Build plate</span><input value={buildPlate} onChange={(event) => setBuildPlate(event.target.value)} placeholder="Textured PEI" disabled={submitting} /></label><label className="form-field"><span>Accessories</span><input value={accessories} onChange={(event) => setAccessories(event.target.value)} placeholder="AMS 2 Pro, dryer" disabled={submitting} /></label> <label className="form-field"><span>Firmware</span><input value={firmware} onChange={(event) => setFirmware(event.target.value)} placeholder="Version or not recorded" disabled={submitting} /> </label><label className="form-field"> <span>Slicer</span><input value={slicer} onChange={(event) => setSlicer(event.target.value)} placeholder="Bambu Studio / Cura" disabled={submitting} /></label><label className="form-field"><span>Slicer version</span><input value={slicerVersion} onChange={(event) => setSlicerVersion(event.target.value)} placeholder="e.g. 1.10.0" disabled={submitting} /></label><label className="form-field"><span>Profile</span><input value={profile} onChange={(event) => setProfile(event.target.value)} placeholder="0.20 mm Standard" disabled={submitting} /></label><label className="form-field"><span>Calibration state</span><input value={calibration} onChange={(event) => setCalibration(event.target.value)} placeholder="Flow / first layer / date" disabled={submitting} /></label><label className="form-field advanced-unknowns"><span>Explicit unknowns</span><textarea value={unknowns} onChange={(event) => setUnknowns(event.target.value)} rows={2} placeholder="One unknown per line" disabled={submitting} /></label></div> )} </details> )} <label className="form-field"><span> {" "}
            Notes <small>(optional)</small> </span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} placeholder="What changed or what should be checked?" disabled={submitting} /></label> {formError && ( <p className="form-error" role="alert"> {formError} </p> )} <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting} > {" "}
            Cancel{" "} </button> <button type="submit" className="button button-primary" disabled={!name.trim() || submitting} aria-busy={submitting} > {submitting ? "Creating…" : "Create revision"}{" "} {!submitting && <Icon name="arrow-right" size={16} />} </button></div></form></Dialog> ); } export function EditBuildApproachDialog({ project, items, expert, suspended = false, onClose, onAddPrinter, onSave }: { project: Project; items: InventoryItem[]; expert: boolean; suspended?: boolean; onClose: () => void; onAddPrinter?: (() => void) | undefined; onSave: (input: ProjectRevisionUpdateInput) => Promise<boolean>; }) { const route = projectFabricationRoute(project); const carriedPrinterId = projectIntendedPrinterId(project); const carriedPrinter = carriedPrinterId ? items.find( (item) => item.id === carriedPrinterId && isUsableOwnedPrinter(item) ) : undefined; const selectablePrinters = items.filter(isUsableOwnedPrinter); const [fabricationRoute, setFabricationRoute] = useState<FabricationRoute>(route); const [printer, setPrinter] = useState<InventoryItem | undefined>( carriedPrinter ); const [submitting, setSubmitting] = useState(false); const [formError, setFormError] = useState<string>(); useEffect(() => { if (fabricationRoute !== "printed") setPrinter(undefined); }, [fabricationRoute]); if (suspended) return null; const submit = async (event: FormEvent) => { event.preventDefault(); if (submitting) return; setSubmitting(true); setFormError(undefined); try { const saved = await onSave({ fabricationRoute, intendedPrinterItemId: fabricationRoute === "printed" ? (printer?.id ?? null) : null }); if (!saved) setFormError( "The build approach was not saved. Check the service connection and try again." ); } catch (error: unknown) { setFormError(normalizeApiError(error).message); } finally { setSubmitting(false); } }; return ( <Dialog title="Edit build approach" onClose={onClose}><form className="edit-build-approach-form" onSubmit={(event) => { void submit(event); }} > <p className="dialog-intro"> {" "}
          Choose how this project will be built. You can change it again as the
          project becomes clearer.{" "} </p><fieldset className="fabrication-route-options" aria-describedby="edit-fabrication-route-help" ><legend>How will you build it?</legend> {fabricationRouteOptions.map((option) => ( <label className={`fabrication-route-option ${fabricationRoute === option.value ? "is-selected" : ""}`} key={option.value} ><input type="radio" name="edit-fabrication-route" value={option.value} checked={fabricationRoute === option.value} onChange={() => setFabricationRoute(option.value)} disabled={submitting} /><span> <strong>{option.label}</strong><small>{option.description}</small> </span></label> ))} <p id="edit-fabrication-route-help"> {" "}
            This changes planning context only. It does not buy, reserve, or
            build anything.{" "} </p></fieldset> {fabricationRoute === "printed" && ( <div className="route-printer-picker"><OwnedItemCombobox category="Printers" items={selectablePrinters} value={printer} onSelect={setPrinter} label="Printer for this project" helper="Leave blank if you have not decided yet." /> {!printer && ( <div className="printer-reassurance"> <strong>No printer selected yet.</strong><span> {" "}
                  That’s fine—you can choose or add an owned printer later.{" "} </span> {onAddPrinter && ( <button type="button" className="text-button" onClick={onAddPrinter} disabled={submitting} > {" "}
                    Add printer <Icon name="plus" size={14} /></button> )} </div> )}{" "} {printer && ( <p className="printer-build-volume-note"> {printerBuildVolumeCopy(printer) ?? "Build volume not recorded"}
                . Fit is checked only after a printable part is added.{" "} </p> )} </div> )}{" "} {expert && ( <details className="expert-detail" open><summary>Planning details</summary> <div className="detail-grid"> <div> <span>Revision</span><code> {project.serverRevisionId ?? project.currentRevision} </code> </div> <div> <span>Selected printer</span> <code>{printer?.id ?? "Not selected"}</code></div></div> </details> )}{" "} {formError && ( <p className="form-error" role="alert">{formError}</p> )}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}> {" "}Cancel{" "} </button><button type="submit" className="button button-primary" disabled={submitting} aria-busy={submitting}>{submitting ? "Saving…" : "Save build approach"}{" "} {!submitting && <Icon name="check" size={16} />}</button></div></form></Dialog> );
}

const bomUnitOptions: readonly { value: BomInput["unit"]; label: string }[] = [
  { value: "each", label: "pieces" },
  { value: "g", label: "grams" },
  { value: "m", label: "metres" },
  { value: "millimetre", label: "millimetres" },
  { value: "millilitre", label: "millilitres" },
  { value: "set", label: "sets" }
]; export function AddBomDialog({ items, project, expert, onClose, onCreate }: { items: InventoryItem[]; project: Project; expert: boolean; onClose: () => void; onCreate: (input: BomInput) => Promise<boolean>; }) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState<BomInput["unit"]>("each");
  const [role, setRole] = useState<NonNullable<BomInput["role"]>>("consumed"); const [itemId, setItemId] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [optional, setOptional] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const requiredQuantity = Number(quantity);
    if (!name.trim() || !Number.isFinite(requiredQuantity) || requiredQuantity <= 0 || submitting) return;
    setSubmitting(true);
    setFormError(undefined);
    try {
      const created = await onCreate({ name: name.trim(), requiredQuantity, unit, role, ...(expert && itemId ? { itemId } : {}), ...(optional ? { optional: true } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      if (!created) setFormError("The requirement was not added. Check the service connection and try again.");
    } catch (error: unknown) {
      setFormError(normalizeApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const filteredItems = items.filter((item) => {
    const needle = itemSearch.trim().toLocaleLowerCase();
    return ( !needle || [item.name, item.variant, item.location, item.manufacturer, item.sku, inventoryDiscriminator(item)].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle) );
  });
  const selectedItem = items.find((item) => item.id === itemId);
  return ( <Dialog title={ expert ? `Add a requirement to ${project.currentRevision}` : "Add a part, material, or tool" } onClose={onClose}><form onSubmit={(event) => { void submit(event); }}><p className="dialog-intro"> {expert ? "Describe one requirement. Matching stock is optional; BenchLedger can evaluate it after you save." : "Tell BenchLedger what you need and how it will be used. Matching stock happens after you save."} </p><label className="form-field"><span>What do you need?</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. ESP32 development board" disabled={submitting} /></label><div className="form-row"><label className="form-field"><span>Quantity</span><input type="number" min="0.01" step="any" required value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={submitting} /></label><label className="form-field"><span>Unit</span><select value={unit} onChange={(event) => setUnit(event.target.value as BomInput["unit"])} disabled={submitting}>{bomUnitOptions.map((option) => ( <option key={option.value} value={option.value}>{option.label}</option>))}</select></label></div><label className="form-field"> <span>How will you use it?</span> <select aria-label="How will you use it?" required value={role} onChange={(event) => setRole(event.target.value as NonNullable<BomInput["role"]>) } disabled={submitting} > <option value="consumed"> {" "}
              Part or material (used up or built in){" "} </option> <option value="reusable">Reusable tool or equipment</option> </select> </label> {expert && ( <div className="form-field matching-stock-field"><span> {" "}Known matching stock <small>(optional)</small></span><input aria-label="Search matching inventory" value={itemSearch} onChange={(event) => setItemSearch(event.target.value)} placeholder="Search name, colour, location, or SKU" disabled={submitting} /><select aria-label="Choose matching inventory" value={itemId} onChange={(event) => setItemId(event.target.value)} disabled={submitting}><option value="">Let BenchLedger match it</option>{filteredItems.map((item) => ( <option key={item.id} value={item.id}>{inventoryCandidateText(item, items)}</option>))}</select>{selectedItem && ( <small className="matching-stock-hint"> {" "}Selected: {inventoryCandidateText(selectedItem, items)}</small> )} </div> )}{" "} {expert && ( <details className="expert-detail requirement-expert-detail" open> <summary>Technical details</summary> <div className="detail-grid"> <div> <span>Project revision</span> <code>{project.serverRevisionId ?? "Not recorded"}</code> </div> <div> <span>Revision label</span> <code>{project.currentRevision}</code> </div><div> <span>Requirement role</span> <code>{role}</code> </div> <div> <span>Matching</span> <code> {itemId ? "Manual item selected" : "Service evaluates matching after save"}</code> </div></div> </details> )} <label className="form-field"><span> {" "}Requirement note <small>(optional)</small></span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="Fit, material, or compatibility detail" disabled={submitting} /></label><label className="check-field"><input type="checkbox" checked={optional} onChange={(event) => setOptional(event.target.checked)} disabled={submitting} /><span>Mark as optional</span></label>{formError && ( <p className="form-error" role="alert">{formError}</p> )}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}> {" "}Cancel{" "} </button><button type="submit" className="button button-primary" disabled={!name.trim() || submitting} aria-busy={submitting}>{submitting ? "Adding…" : "Add requirement"} {" "} {!submitting && <Icon name="arrow-right" size={16} />}</button></div></form></Dialog> );
}

type InventoryItemType = | "printer" | "filament" | "tool" | "accessory" | "consumable" | "electronic" | "fastener" | "wire" | "adhesive" | "other";
const defaultCategoryIdForItemType: Readonly< Record<InventoryItemType, string> > = { printer: "category-printers", filament: "category-filament", tool: "category-tools", accessory: "category-printer-accessories", consumable: "category-consumables", electronic: "category-electronics", fastener: "category-fasteners", wire: "category-electrical", adhesive: "category-adhesives", other: "category-other" }; const itemTypeOptions: readonly { value: InventoryItemType; label: string }[] = [
  { value: "printer", label: "Printer" }, { value: "filament", label: "Filament" }, { value: "tool", label: "Tool" }, { value: "accessory", label: "Accessory" }, { value: "consumable", label: "Consumable" }, { value: "electronic", label: "Electronic" }, { value: "fastener", label: "Fastener" }, { value: "wire", label: "Wire & cable" }, { value: "adhesive", label: "Adhesive" }, { value: "other", label: "Other" }
];

function displayInventoryUnit(unit: ReturnType<typeof defaultUnitForItemKind>): InventoryItem["unit"] {
  if (unit === "gram") return "g";
  if (unit === "metre") return "m";
  return unit;
}

const inventoryUnitLabels: Readonly<Record<InventoryItem["unit"], string>> = {
  each: "pieces", g: "grams", m: "metres", set: "sets", millimetre: "millimetres", millilitre: "millilitres"
}; function inventoryUnitLabel( unit: InventoryItem["unit"], expert: boolean, serverUnit?: string ): string { if (!expert) return inventoryUnitLabels[unit]; if (serverUnit?.trim()) return serverUnit; if (unit === "g") return "gram"; if (unit === "m") return "metre"; return unit; } type InventoryMutationReview =
  | { readonly kind: "count"; readonly quantity: number }
  | { readonly kind: "commission"; readonly input: InventoryCommissionInput };

function displayCategoryForKind(kind: InventoryItemType): InventoryCategory {
  if (kind === "printer") return "Printers";
  if (kind === "filament") return "Filament";
  if (kind === "tool") return "Tools";
  if (kind === "electronic") return "Electronics";
  if (kind === "fastener") return "Fasteners";
  if (kind === "wire") return "Wire & cable";
  return "Accessories";
}

function NewInventoryDialog({ expert, replacementFor, categories, categoriesLoading, categoriesError, catalogQuery, catalogProducts, onCatalogQuery, onResetCatalog, onSearchCatalog, onSearchCatalogPage, onCreateCatalogProduct, onCreateExact, onLinkExact, onClose, onGoSettings, onCreate }: { expert: boolean; replacementFor?: InventoryItem | undefined; categories: readonly ManagedInventoryCategory[]; categoriesLoading: boolean; categoriesError?: string | undefined; catalogQuery: string; catalogProducts: CatalogProduct[]; onCatalogQuery: (query: string) => void; onResetCatalog: () => void; onSearchCatalog: (kind: "filament" | "printer", query: string, options?: CatalogSearchOptions) => Promise<CatalogProduct[]>; onSearchCatalogPage: (kind: "filament" | "printer", query: string, options?: CatalogSearchOptions) => Promise<CatalogProductPage>; onCreateCatalogProduct: (input: CatalogProductDraft) => Promise<CatalogProduct | undefined>; onCreateExact: (input: ExactInventoryInput) => Promise<boolean>; onLinkExact: ( item: InventoryItem, input: ExactInventoryInput ) => Promise<boolean>; onClose: () => void; onGoSettings: () => void; onCreate: (input: InventoryCreateInput) => Promise<boolean>; }) {
  const replacementType = replacementFor?.kind as InventoryItemType | undefined;
  const linkTarget = replacementFor && (replacementFor.kind === "printer" || replacementFor.kind === "filament") && replacementFor.unitStatus !== "needs_correction" ? replacementFor : undefined; const [itemType, setItemType] = useState<InventoryItemType | undefined>(replacementType);
  const [categoryNodeId, setCategoryNodeId] = useState(replacementFor?.categoryNodeId ?? "");
  const [selectionConfirmed, setSelectionConfirmed] = useState(Boolean(replacementType && replacementFor?.categoryNodeId));
  const [name, setName] = useState(replacementFor ? `${replacementFor.name} (corrected)` : "");
  const [manufacturer, setManufacturer] = useState( replacementFor?.manufacturer ?? "" ); const [model, setModel] = useState(replacementFor?.model ?? ""); const [sku, setSku] = useState(replacementFor?.sku ?? ""); const [location, setLocation] = useState( replacementFor?.location === "Unassigned" ? "" : (replacementFor?.location ?? "") ); const [description, setDescription] = useState(""); const [quantity, setQuantity] = useState(replacementFor ? String(replacementFor.quantity) : "1");
  const [unit, setUnit] = useState<InventoryItem["unit"]>(replacementType ? displayInventoryUnit(defaultUnitForItemKind(replacementType)) : "each");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [manualDetails, setManualDetails] = useState(false); const categoryHintId = useId();
  const selectedCategory = managedCategoryForId(categories, categoryNodeId);
  const setType = (next: InventoryItemType) => { onResetCatalog(); setItemType(next); setSelectionConfirmed(false); setManualDetails(false); setFormError(undefined); setName(""); setManufacturer(""); setModel(""); setSku(""); setLocation(""); setDescription(""); setQuantity("1"); setUnit(displayInventoryUnit(defaultUnitForItemKind(next))); const suggested = categories.find((category) => !category.archived && category.id === defaultCategoryIdForItemType[next] ); setCategoryNodeId(suggested?.id ?? ""); };
  const resetSelection = () => { onResetCatalog(); setItemType(undefined); setCategoryNodeId(""); setSelectionConfirmed(false); setManualDetails(false); setFormError(undefined); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!itemType || !categoryNodeId || !name.trim() || (manualDetails && (!manufacturer.trim() || !model.trim())) || submitting) return;
    setSubmitting(true);
    setFormError(undefined);
    try {
      const created = await onCreate({ name: name.trim(), category: displayCategoryForKind(itemType), categoryNodeId, kind: itemType, quantity: Math.max(Number(quantity) || 0, 0), unit, ...(manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(sku.trim() ? { sku: sku.trim() } : {}), ...(location.trim() ? { location: location.trim() } : {}), ...(description.trim() ? { description: description.trim() } : {}) });
      if (!created) setFormError("The item was not added. Check the service connection and try again.");
    } catch (error: unknown) {
      setFormError(normalizeApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const chooseItemType = (event: ChangeEvent<HTMLSelectElement>) => { const next = event.target.value as InventoryItemType; if (next) setType(next); };
  const exactCategory = itemType === "filament" ? "Filament" : itemType === "printer" ? "Printers" : undefined;
  const categoryAvailable = !categoriesLoading && !categoriesError && selectedCategory !== undefined;
  if (!itemType || !categoryAvailable || !selectionConfirmed) {
    const activeCategoryCount = categories.filter((category) => !category.archived).length;
    const defaultCategoryMissing = Boolean( itemType && !categoryNodeId && !categoriesLoading && !categoriesError ); const categoriesUnavailable = Boolean(categoriesError) || (!categoriesLoading && activeCategoryCount === 0) || defaultCategoryMissing;
    return ( <Dialog title="Add to inventory" onClose={onClose}><form className="inventory-start-form" onSubmit={(event) => { event.preventDefault(); }}><p className="dialog-intro"> {expert ? "Choose the item type and managed category." : "Choose what you are adding. BenchLedger will file it in the matching inventory category."} </p><label className="form-field"><span> {expert ? ( <> {" "}Item type <small>(required)</small></> ) : ( "What are you adding?" )} </span><select autoFocus required value={itemType ?? ""} onChange={chooseItemType}><option value="">Choose an item type</option>{itemTypeOptions.map((option) => ( <option value={option.value} key={option.value}>{option.label}</option>))}</select></label> {expert && ( <> <CategorySelection categories={categories} value={categoryNodeId} onChange={(id) => { setCategoryNodeId(id); setSelectionConfirmed(false); }} disabled={categoriesLoading || categoriesUnavailable} ariaInvalid={categoriesUnavailable || (selectionConfirmed && !categoryNodeId)} ariaDescribedBy={categoryHintId} /><p id={categoryHintId} className="field-hint">{categoriesLoading ? "Refreshing active categories…" : categoriesError ? categoriesError : activeCategoryCount === 0 ? "No active categories are available. Add one in Settings before creating inventory." : itemType && categoryNodeId ? `Suggested category: ${selectedCategory?.name ?? displayCategoryForKind(itemType)}.` : "Choose an active category or subcategory."}</p> </> )}{" "} {categoriesUnavailable && ( <div className="category-unavailable" role="alert"><span>{categoriesError ? "Inventory categories could not be loaded." : defaultCategoryMissing ? "The matching inventory category is unavailable." : "Inventory needs one active managed category before a new item can be added."}</span><button type="button" className="text-button" onClick={onGoSettings}> {" "}Open Settings <Icon name="arrow-right" size={15} /></button></div> )}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose}> {" "}Cancel{" "} </button><button type="button" className="button button-primary" disabled={!itemType || !categoryNodeId || categoriesUnavailable} onClick={() => setSelectionConfirmed(true)}> {" "}Continue <Icon name="arrow-right" size={16} /></button></div></form></Dialog> );
  }
  const availableCategory = selectedCategory!;
  if (exactCategory && !manualDetails) return ( <Dialog title={ linkTarget ? linkTarget.productProfile ? "Change exact product" : "Link exact product" : exactCategory === "Filament" ? "Add filament" : "Add a printer" } onClose={onClose}><div className="inventory-selection-summary"><span><strong>Item type</strong>{itemTypeOptions.find((option) => option.value === itemType)?.label}</span> {expert && ( <span><strong>Category</strong>{availableCategory.name}</span> )} <button type="button" className="text-button" onClick={resetSelection}> {" "}Change selection{" "} </button></div><CatalogInventoryFlow category={exactCategory} products={catalogProducts.filter((product) => product.kind === (exactCategory === "Filament" ? "filament" : "printer"))} query={catalogQuery} onQueryChange={onCatalogQuery} onSearch={onSearchCatalog} onSearchPage={onSearchCatalogPage} onCreateProduct={onCreateCatalogProduct} onCreate={(input) => linkTarget ? onLinkExact(linkTarget, { ...input, categoryNodeId }) : onCreateExact({ ...input, categoryNodeId })} {...(linkTarget ? { existingItem: linkTarget } : { onAddManually: () => { onResetCatalog(); setManualDetails(true); setName(""); setQuantity(exactCategory === "Filament" ? "" : "1"); } })} /></Dialog> );
  const compatibleUnits = validUnitsForItemKind(itemType).map(displayInventoryUnit);
  return ( <Dialog title={replacementFor ? "Create corrected replacement" : "Add an inventory item"} onClose={onClose}><form onSubmit={(event) => { void submit(event); }}><button type="button" className="text-button category-back" onClick={ manualDetails ? () => setManualDetails(false) : resetSelection} disabled={submitting}><Icon name="arrow-left" size={15} /> {manualDetails ? "Choose an exact product" : expert ? "Choose another type or category" : "Change selection"} </button><div className="inventory-selection-summary"><span><strong>Item type</strong>{itemTypeOptions.find((option) => option.value === itemType)?.label}</span> {expert && ( <span><strong>Category</strong>{availableCategory.name}</span> )} </div>{manualDetails && ( <p className="unit-replacement-note"> {" "}
            The exact product is not confirmed. This item will stay in Check
            until you identify and physically verify it.{" "} </p> )}{" "} {replacementFor && ( <p className="unit-replacement-note"> {" "}The old record remains blocked as history. This replacement starts with a compatible unit and must be physically counted before it can supply a project.{" "} </p> )}<p className="dialog-intro"> {" "}
          This records the amount on a delivery or source record. It starts as{" "} <strong>Check</strong> until you confirm the item and quantity are
          physically present. This number is not a physical count or available
          stock.{" "} </p><label className="form-field"><span>Name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. JST-PH 2-pin leads" disabled={submitting} /></label> {manualDetails && ( <> <div className="form-row manual-product-fields"> <label className="form-field"> <span>Brand or manufacturer</span> <input required value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} placeholder={ itemType === "filament" ? "e.g. Polymaker" : "e.g. Prusa Research" } disabled={submitting} /> </label> <label className="form-field"> <span> {itemType === "filament" ? "Material and type" : "Model"} </span> <input required value={model} onChange={(event) => setModel(event.target.value)} placeholder={ itemType === "filament" ? "e.g. PLA, matte" : "e.g. MK4S" } disabled={submitting} /> </label> </div> <div className="form-row manual-product-fields"> <label className="form-field"> <span>
                  Product code <small>(optional)</small> </span> <input value={sku} onChange={(event) => setSku(event.target.value)} disabled={submitting} /> </label> <label className="form-field"> <span>
                  Location <small>(optional)</small> </span> <input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Shelf or workbench" disabled={submitting} /> </label> </div> <label className="form-field"> <span>
                Planning notes <small>(optional)</small> </span> <textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={ itemType === "filament" ? "Colour, diameter, or other details to confirm" : "Capabilities or details to confirm" } disabled={submitting} /> </label> </> )} <div className="form-row"><label className="form-field"><span>Quantity received</span><input type="number" min="0" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={submitting} /></label><label className="form-field"><span>Unit</span><select value={unit} onChange={(event) => setUnit(event.target.value as InventoryItem["unit"])} disabled={submitting}>{compatibleUnits.map((option) => ( <option key={option} value={option}>{inventoryUnitLabels[option]}</option>))}</select></label></div>{formError && ( <p className="form-error" role="alert">{formError}</p> )}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}> {" "}Cancel{" "} </button><button type="submit" className="button button-primary" disabled={!name.trim() || (manualDetails && (!manufacturer.trim() || !model.trim())) || submitting} aria-busy={submitting}>{submitting ? "Adding…" : replacementFor ? "Create replacement" : "Add item"} {" "} {!submitting && <Icon name="plus" size={16} />}</button></div></form></Dialog> );
}

function Dialog({ title, role = "dialog", onClose, children }: { title: string; role?: "dialog" | "alertdialog"; onClose: () => void; children: ReactNode; }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  useOverlayBehavior(dialogRef, onClose);
  return ( <><div className="dialog-scrim" aria-hidden="true" onClick={onClose} /><section ref={dialogRef} className="dialog" role={role} aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><div className="dialog-header"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={19} /></button></div>{children}</section></> );
}

function EmptyState({ icon, title, description, action, onAction }: { icon: Parameters<typeof Icon>[0]["name"]; title: string; description: string; action?: string; onAction?: () => void; }) {
  return ( <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={23} /></span><h2>{title}</h2><p>{description}</p>{action && ( <button className="button button-secondary" onClick={onAction}>{action}<Icon name="arrow-right" size={15} /></button> )}</div> );
}

function formatDimensions(dimensions: NonNullable<InventoryItem["dimensions"]>): string {
  if (dimensions.diameter) return `Ø${dimensions.diameter} ${dimensions.unit}`;
  return ( [dimensions.length, dimensions.width, dimensions.height].filter((value) => value !== undefined).join(" × ") + ` ${dimensions.unit}` );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function roleForFile(name: string): "Editable CAD" | "STEP" | "STL" | "Build plate" | "Validation" | "Notes" {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "step" || extension === "stp") return "STEP";
  if (extension === "stl") return "STL";
  if (extension === "3mf") return "Build plate";
  if (extension === "scad" || extension === "fcstd" || extension === "f3d") return "Editable CAD";
  if (extension === "md" || extension === "txt" || extension === "json") return "Notes";
  return "Validation";
}

export default App;
