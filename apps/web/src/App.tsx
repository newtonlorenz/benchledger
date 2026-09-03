import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import type * as React from "react";
import { ApiError, createSampleWorkspaceAdapter, createWorkspaceAdapter, MAX_INVENTORY_SEARCH_LENGTH } from "./api";
import type { WorkspaceAdapter } from "./api";
import type { BomInput, CatalogProductDraft, CatalogProductPage, CatalogSearchOptions, ExactInventoryInput, InventoryBulkUpdateInput, InventoryBulkUpdateResult, InventoryCommissionInput, InventoryKindQuery, InventoryListQuery, InventoryUpdateInput, RevisionInput, WorkspaceAccess } from "./api";
import { CatalogInventoryFlow, BuildSetupSummary, OwnedItemCombobox, buildFilamentSelection, buildItemEligibility, splitSetupValues } from "./catalog-ui";
import type { BuildConfigInput, CatalogProduct } from "./domain";
import {
  calculateProjectSummary,
  formatMoney,
  formatQuantity,
  getLineLabel,
  getStockLabel,
  inventoryKindOptions,
  exactProductLabel,
  railSteps,
  shoppingEligibleLines,
  shoppingOfferItemIds,
  shoppingEmptyState,
  sumMoneyByCurrency,
  unitDiagnostics
} from "./domain";
import type { BomLineStatus, InventoryCategory, InventoryCondition, InventoryEvidenceState, InventoryItem, Project, StockLabelTone, StockState } from "./domain";
import { activity, capabilityGroups, offers as fixtureOffers } from "./mock-data";
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
type ConnectionState = "loading" | "ready" | "sample" | "unauthenticated" | "offline" | "error";
type PendingRevisionSetup = { readonly projectId: string; readonly revisionId: string; readonly input: BuildConfigInput };
type ProjectCreateOutcome = "created" | "failed" | "ambiguous";
type VersionedInventoryItem = InventoryItem & { version: number };
type BulkInventorySelection = { readonly items: VersionedInventoryItem[]; readonly onResult: (result: InventoryBulkUpdateResult) => void };
type InspectionProject = Project & { readonly inspectionActions?: readonly InspectionAction[] };
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

function readInventoryUrlState(): { readonly search: string; readonly categoryNodeId: string; readonly kind: InventoryKindQuery | "All"; readonly evidence: InventoryEvidenceState | "All"; readonly availability: "All" | "available" | "unavailable" } {
  if (typeof window === "undefined") return { search: "", categoryNodeId: "", kind: "All", evidence: "All", availability: "All" };
  const params = new URLSearchParams(window.location.search);
  const categoryNodeId = params.get("unassigned") === "true" ? UNASSIGNED_CATEGORY_FILTER : params.get("categoryNodeId")?.trim() ?? "";
  const kindValue = params.get("kind");
  const evidenceValue = params.get("evidence");
  const availableValue = params.get("available");
  const kind = inventoryKindOptions.some((option) => option.value === kindValue) ? kindValue as InventoryKindQuery : "All";
  const evidenceValues: InventoryEvidenceState[] = ["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"];
  const evidence = evidenceValues.includes(evidenceValue as InventoryEvidenceState) ? evidenceValue as InventoryEvidenceState : "All";
  const availability = availableValue === "true" ? "available" : availableValue === "false" ? "unavailable" : "All";
  return { search: params.get("q")?.trim().slice(0, MAX_INVENTORY_SEARCH_LENGTH) ?? "", categoryNodeId, kind, evidence, availability };
}

const pageCopy: Record<Page, { label: string; icon: Parameters<typeof Icon>[0]["name"] }> = {
  overview: { label: "Workbench", icon: "grid" },
  inventory: { label: "Inventory", icon: "box" },
  projects: { label: "Projects", icon: "folder" },
  capabilities: { label: "For agents", icon: "spark" },
  settings: { label: "Settings", icon: "settings" }
};

const categoryIcons: Record<InventoryCategory, Parameters<typeof Icon>[0]["name"]> = {
  Printers: "layers",
  Filament: "package",
  Tools: "tool",
  Accessories: "wrench",
  Electronics: "spark",
  Fasteners: "link",
  "Wire & cable": "link"
};
const UNASSIGNED_CATEGORY_FILTER = "__unassigned__";

function displayedInventoryState(item: InventoryItem): StockState {
  return item.unitStatus === "needs_correction" ? "inspect-first" : item.state;
}

function App() {
  const [adapter, setAdapter] = useState<WorkspaceAdapter>(() => createWorkspaceAdapter());
  const [page, setPage] = useState<Page>("overview");
  const [projects, setProjects] = useState<Project[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const [projectView, setProjectView] = useState<"active" | "archived">("active");
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [offers, setOffers] = useState(fixtureOffers);
  const [selectedProjectId, setSelectedProjectId] = useState("project-lamp");
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [projectTab, setProjectTab] = useState<ProjectTab>("plan");
  const [search, setSearch] = useState(() => readInventoryUrlState().search);
  const [expert, setExpert] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [connectionError, setConnectionError] = useState<ApiError>();
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [sampleMode, setSampleMode] = useState(false);
  const [workspaceAccess, setWorkspaceAccess] = useState<WorkspaceAccess>();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [categoryReloadNonce, setCategoryReloadNonce] = useState(0);
  const [inventoryRefreshNonce, setInventoryRefreshNonce] = useState(0);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewRevision, setShowNewRevision] = useState(false);
  const [showAddBom, setShowAddBom] = useState(false);
  const [showNewItem, setShowNewItem] = useState(false);
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
  const newProjectTriggerRef = useRef<HTMLButtonElement>(null);

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
      setProjectView(snapshot.projects.length > 0 || archived.length === 0 ? "active" : "archived");
      setOffers(snapshot.offers);
      setSelectedProjectId((snapshot.projects[0] ?? archived[0])?.id ?? "");
      setSampleMode(snapshot.source === "synthetic");
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
      setDemoAvailable(Boolean(normalized.demo));
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
    const timeout = window.setTimeout(() => setToast(undefined), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const visibleProjects = projectView === "archived" ? archivedProjects : projects;
  const selectedProject = visibleProjects.find((project) => project.id === selectedProjectId) ?? visibleProjects[0];
  const selectedItem = items.find((item) => item.id === selectedItemId);
  const overlayOpen = Boolean(selectedItem || showNewProject || showNewRevision || showAddBom || showNewItem || bulkInventorySelection);

  const navigate = (nextPage: Page) => {
    setPage(nextPage);
    setMobileNav(false);
    setSelectedItemId(undefined);
  };

  const openProject = (projectId: string, tab: ProjectTab = "plan") => {
    setSelectedProjectId(projectId);
    setProjectTab(tab);
    setPage("projects");
    setMobileNav(false);
  };

  const searchInventory = (value: string) => {
    setSearch(value.slice(0, MAX_INVENTORY_SEARCH_LENGTH));
    navigate("inventory");
  };

  const openNewProject = (event: React.MouseEvent<HTMLButtonElement>) => {
    newProjectTriggerRef.current = event.currentTarget;
    setShowNewProject(true);
  };

  const closeNewProject = () => {
    setShowNewProject(false);
    const trigger = newProjectTriggerRef.current;
    if (trigger) window.setTimeout(() => trigger.focus(), 32);
  };

  const retryConnection = () => {
    setConnectionError(undefined);
    setReloadNonce((current) => current + 1);
  };

  const refreshWorkspace = async (): Promise<boolean> => {
    try {
      const snapshot = await adapter.loadWorkspace();
      const archived = await adapter.listArchivedProjects().catch((error: unknown) => error instanceof ApiError && error.status === 404 ? [] : Promise.reject(error));
      setItems(snapshot.inventory);
      setProjects(snapshot.projects);
      setArchivedProjects(archived);
      setProjectView((current) => snapshot.projects.length > 0 || archived.length === 0 ? current : "archived");
      setSelectedProjectId((current) => snapshot.projects.some((project) => project.id === current) || archived.some((project) => project.id === current) ? current : (snapshot.projects[0] ?? archived[0])?.id ?? "");
      setOffers(snapshot.offers);
      setSampleMode(snapshot.source === "synthetic");
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
      setArchivedProjects((current) => [archived, ...current.filter((candidate) => candidate.id !== archived.id)]);
      setProjectView(remaining.length > 0 ? "active" : "archived");
      setSelectedProjectId((current) => current === project.id ? remaining[0]?.id ?? archived.id : current);
      setToast("Project archived. It is hidden from active lists; reservations were released, history was retained, and the archive is reversible.");
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
      setSelectedProjectId(restored.id);
      setToast(`${project.name} was restored to Idea. Released reservations were not recreated.`);
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
      setProjectView(remainingProjects.length > 0 ? "active" : remainingArchived.length > 0 ? "archived" : "active");
      setSelectedProjectId((current) => current === project.id ? (remainingProjects[0] ?? remainingArchived[0])?.id ?? "" : current);
      setToast("Project permanently removed from the workspace. Its reservation releases and audit history remain retained; it cannot be restored.");
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
      setDemoAvailable(Boolean(normalized.demo));
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
      setOffers([]);
      setPendingRevisionSetup(undefined);
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
    setOffers([]);
    setPendingRevisionSetup(undefined);
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
    setToast(writeFailureMessage(normalized, action));
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
      setToast("Inventory was saved, but project readiness could not be refreshed. Reload before sourcing parts.");
      return false;
    }
  };

  const recordCount = async (itemId: string, quantity: number): Promise<InventoryItem> => {
    try {
      const result = await adapter.recordCount(itemId, quantity);
      setItems((current) => current.map((item) => item.id === itemId ? result : item));
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
      setItems((current) => current.map((item) => item.id === itemId ? result : item));
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
      setItems((current) => current.map((item) => item.id === itemId ? result : item));
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

  const createProject = async (input: Pick<Project, "name" | "description">): Promise<ProjectCreateOutcome> => {
    try {
      const project = await adapter.createProject(input);
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id);
      setShowNewProject(false);
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
          setToast(`${project.name} ${project.currentRevision} was created, but its build setup was not saved. Use “Retry setup” to try again; no duplicate revision was created.`);
          return true;
        }
      } else {
        setPendingRevisionSetup((current) => current?.projectId === project.id ? undefined : current);
      }
      setProjects((current) => current.map((candidate) => candidate.id === updatedProject.id ? updatedProject : candidate));
      setShowNewRevision(false);
      setToast(`${updatedProject.name} is now on ${updatedProject.currentRevision}.${updatedProject.buildConfigSnapshot ? " Setup was saved as an immutable snapshot." : " Add an exact owned printer to capture its build setup."}`);
      return true;
    } catch (error: unknown) {
      handleMutationError(error, "creating that revision");
      return false;
    }
  };

  const retryRevisionSetup = async () => {
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
      handleMutationError(error, "saving that revision setup");
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

  const uploadArtifact = async (projectId: string, file: File, role: string, target?: ArtifactUploadTarget) => {
    try {
      const project = await adapter.uploadArtifact(projectId, file, role, target);
      setProjects((current) => current.map((candidate) => candidate.id === project.id ? project : candidate));
      setToast(`${file.name} was uploaded to ${target ? artifactScopeIdentity(target, expert) : expert ? `Project · ${project.serverRevisionId ?? project.currentRevision}` : "the project revision"}.`);
    } catch (error: unknown) {
      handleMutationError(error, "uploading that file");
      throw normalizeApiError(error);
    }
  };

  const addInventoryItem = async (input: { name: string; category: InventoryCategory; categoryNodeId: string; kind: string; quantity: number; unit: InventoryItem["unit"] }): Promise<boolean> => {
    try {
      const item = await adapter.createInventoryItem(input);
      setItems((current) => [item, ...current]);
      setInventoryRefreshNonce((current) => current + 1);
      setShowNewItem(false);
      if (await refreshProjectReadiness()) setToast(`${item.name} added as Check quantity. Record a physical count before reserving it.`);
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

  const addCatalogProduct = async (input: CatalogProductDraft): Promise<CatalogProduct | undefined> => {
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
      setInventoryRefreshNonce((current) => current + 1);
      setShowNewItem(false);
      setCatalogQuery("");
      setCatalogProducts([]);
      if (await refreshProjectReadiness()) setToast(`${item.name} added. Its exact product link is ${item.productProfile?.linkState === "confirmed" ? "confirmed" : "reported until you check it"}.`);
      return true;
    } catch (error: unknown) {
      handleMutationError(error, "adding that exact inventory item");
      return false;
    }
  };

  if (loading || connection === "loading") return <LoadingScreen />;
  if (connection !== "ready" && connection !== "sample") {
    return <ConnectionScreen state={connection} error={connectionError} demoAvailable={demoAvailable} onLogin={signIn} onRetry={retryConnection} onSample={useSampleWorkspace} />;
  }

  return (
    <div className="app-shell">
      <div className="app-background" aria-hidden={overlayOpen ? true : undefined} inert={overlayOpen || undefined}>
        <Sidebar page={page} projectCount={projects.length} sampleMode={sampleMode} onNavigate={navigate} mobileOpen={mobileNav} onClose={() => setMobileNav(false)} />
        <div className="app-main" aria-hidden={mobileNav ? true : undefined} inert={mobileNav || undefined}>
          <header className="topbar">
            <button className="icon-button mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileNav(true)}>
              <Icon name="menu" size={21} />
            </button>
            <div className="breadcrumb"><span>BenchLedger</span><Icon name="chevron-right" size={14} /><strong>{pageCopy[page].label}</strong></div>
            <div className="topbar-actions">
              <label className="global-search">
                <Icon name="search" size={17} />
                <span className="sr-only">Search inventory</span>
                <input ref={searchInputRef} value={search} maxLength={MAX_INVENTORY_SEARCH_LENGTH} onChange={(event) => searchInventory(event.target.value)} placeholder="Search inventory" aria-label="Search inventory" />
                <kbd>⌘ K</kbd>
              </label>
              <button className={`mode-toggle ${expert ? "is-expert" : ""}`} onClick={() => setExpert((current) => !current)} aria-pressed={expert}>
                <span className="mode-dot" /> {expert ? "Expert details" : "Beginner view"}
              </button>
              <button className="avatar" aria-label="Open account settings" onClick={() => navigate("settings")}>MK</button>
            </div>
          </header>

          {sampleMode && <SampleBanner onReturn={returnToPrivateWorkspace} />}

          <main className="content" id="main-content">
            {page === "overview" && <OverviewPage items={items} projects={projects} expert={expert} sampleMode={sampleMode} onNavigate={navigate} onOpenProject={openProject} onSelectItem={setSelectedItemId} onNewProject={openNewProject} />}
            {page === "inventory" && <InventoryPage adapter={adapter} categories={categories} search={search} refreshKey={inventoryRefreshNonce} bulkSelectionResetKey={bulkSelectionResetNonce} onSearch={(value) => setSearch(value.slice(0, MAX_INVENTORY_SEARCH_LENGTH))} onSessionExpired={handleSessionExpiry} onPageItems={(pageItems) => setItems((current) => { const byId = new Map(current.map((item) => [item.id, item] as const)); pageItems.forEach((item) => byId.set(item.id, item)); return [...byId.values()]; })} onSelectItem={setSelectedItemId} onNewItem={() => { setReplacementFor(undefined); setShowNewItem(true); }} onBulkSelectionChange={(selection, onResult) => setBulkInventorySelection(selection.length ? { items: [...selection], onResult } : undefined)} />}
            {page === "projects" && selectedProject && <ProjectPage project={selectedProject} projects={visibleProjects} projectView={projectView} archivedProjectCount={archivedProjects.length} items={items} offers={offers} tab={projectTab} expert={expert} sampleMode={sampleMode} onTabChange={setProjectTab} onSelectProject={setSelectedProjectId} onProjectViewChange={(view) => { setProjectView(view); setSelectedProjectId((view === "archived" ? archivedProjects : projects)[0]?.id ?? ""); }} onOpenItem={setSelectedItemId} onNavigate={navigate} onToast={setToast} onNewProject={openNewProject} onArchive={archiveProject} onRestore={restoreProject} onRemove={removeProject} onNewRevision={() => setShowNewRevision(true)} onRetrySetup={pendingRevisionSetup?.projectId === selectedProject.id && pendingRevisionSetup.revisionId === selectedProject.serverRevisionId ? retryRevisionSetup : undefined} onAddBom={() => setShowAddBom(true)} onUpload={uploadArtifact} onReadReconciliation={adapter.readReconciliation} onSaveReconciliation={adapter.saveReconciliationDraft} onCommitReconciliation={adapter.commitReconciliation} onRefreshWorkspace={refreshWorkspace} onListInspections={adapter.listInspections} onReadInspection={adapter.readInspection} onPreviewInspection={adapter.previewInspectionCompletion} onConfirmInspection={adapter.commitInspectionCompletion} />}
            {page === "projects" && !selectedProject && <section><div className="project-view-switch" role="group" aria-label="Project view"><button type="button" className={projectView === "active" ? "is-active" : ""} onClick={() => { setProjectView("active"); setSelectedProjectId(projects[0]?.id ?? ""); }}>Active projects</button><button type="button" className={projectView === "archived" ? "is-active" : ""} onClick={() => { setProjectView("archived"); setSelectedProjectId(archivedProjects[0]?.id ?? ""); }}>Archived ({archivedProjects.length})</button></div><EmptyState icon="folder" title={projectView === "archived" ? "No archived projects" : "No projects yet"} description={projectView === "archived" ? "Archived projects will appear here with their retained history." : "Start with a name and project goal. You can add parts and files after that."} {...(projectView === "active" ? { action: "Create first project", onAction: () => setShowNewProject(true) } : {})} /></section>}
            {page === "capabilities" && <CapabilitiesPage expert={expert} onCopy={setToast} />}
            {page === "settings" && <><div className={workspaceAccess?.mode === "lan_open" ? "settings-page-lan-open" : undefined}><SettingsPage expert={expert} sampleMode={sampleMode} connection={connection} categories={categories} categoriesLoading={categoriesLoading} categoriesError={categoriesError} onRetryCategories={() => setCategoryReloadNonce((current) => current + 1)} onCreateCategory={createInventoryCategory} onUpdateCategory={updateInventoryCategory} onArchiveCategory={archiveInventoryCategory} hideLogout={workspaceAccess?.mode === "lan_open"} onExpert={() => setExpert((current) => !current)} onLogout={sampleMode ? returnToPrivateWorkspace : signOut} /></div>{workspaceAccess && !sampleMode && !workspaceAccess.demo && <div className="settings-layout"><WorkspaceAccessSection access={workspaceAccess} pendingRetry={adapter.getWorkspaceAccessRetry()} onUpdate={adapter.updateWorkspaceAccess} onChanged={setWorkspaceAccess} onClearRetry={adapter.clearWorkspaceAccessRetry} onRebootstrap={() => { setReloadNonce((current) => current + 1); }} /></div>}</>}
          </main>
        </div>
      </div>

      {selectedItem && <InventoryDrawer item={selectedItem} items={items} categories={categories} categoriesLoading={categoriesLoading} categoriesError={categoriesError} expert={expert} onClose={() => setSelectedItemId(undefined)} onCount={recordCount} onCommission={commissionInventoryItem} onUpdate={updateInventoryItem} onCreateReplacement={(record) => { setSelectedItemId(undefined); setReplacementFor(record); setShowNewItem(true); }} />}
      {showNewProject && <NewProjectDialog onClose={closeNewProject} onCreate={createProject} />}
      {showNewRevision && selectedProject && <NewRevisionDialog project={selectedProject} items={items} expert={expert} onClose={() => setShowNewRevision(false)} onCreate={createRevision} />}
      {showAddBom && selectedProject && <AddBomDialog items={items} project={selectedProject} onClose={() => setShowAddBom(false)} onCreate={addBomLine} />}
      {showNewItem && <NewInventoryDialog replacementFor={replacementFor} categories={categories} categoriesLoading={categoriesLoading} categoriesError={categoriesError} catalogQuery={catalogQuery} catalogProducts={catalogProducts} onCatalogQuery={setCatalogQuery} onSearchCatalog={searchCatalogProducts} onSearchCatalogPage={listCatalogProductPage} onCreateCatalogProduct={addCatalogProduct} onCreateExact={addExactInventoryItem} onClose={() => { setShowNewItem(false); setReplacementFor(undefined); }} onGoSettings={() => { setShowNewItem(false); setReplacementFor(undefined); navigate("settings"); }} onCreate={addInventoryItem} />}
      {bulkInventorySelection && <BulkInventoryDialog selectedItems={bulkInventorySelection.items} onClose={closeBulkInventory} onDone={closeBulkInventory} onApply={applyBulkInventory} />}
      {toast && <div className="toast" role="status"><Icon name="check-circle" size={18} /><span>{toast}</span><button className="toast-close" aria-label="Dismiss notification" onClick={() => setToast(undefined)}><Icon name="close" size={15} /></button></div>}
    </div>
  );
}

function Sidebar({ page, projectCount, sampleMode, onNavigate, mobileOpen, onClose }: { page: Page; projectCount: number; sampleMode: boolean; onNavigate: (page: Page) => void; mobileOpen: boolean; onClose: () => void }) {
  return <>
    {mobileOpen && <div className="nav-scrim" aria-hidden="true" onClick={onClose} />}
    <aside className={`sidebar ${mobileOpen ? "is-open" : ""}`} aria-label="Primary navigation">
      <div className="brand-lockup"><div className="brand-mark" aria-hidden="true"><span /><span /><span /></div><div><div className="wordmark">BenchLedger</div><div className="brand-caption">maker workspace</div></div><button className="icon-button sidebar-close" aria-label="Close navigation" onClick={onClose}><Icon name="close" size={18} /></button></div>
      <div className="workspace-switcher"><span className="workspace-avatar">W</span><span><strong>Workbench</strong><small>{sampleMode ? "Sample workspace" : "Private workspace"}</small></span><Icon name="chevron-down" size={14} /></div>
      <nav className="nav-list">
        <span className="nav-label">Workspace</span>
        {(["overview", "inventory", "projects"] as Page[]).map((entry) => <button key={entry} className={`nav-item ${page === entry ? "is-active" : ""}`} onClick={() => onNavigate(entry)}><Icon name={pageCopy[entry].icon} size={18} /><span>{pageCopy[entry].label}</span>{entry === "projects" && <span className="nav-count">{projectCount}</span>}</button>)}
        <span className="nav-label nav-label-agent">Agent access</span>
        <button className={`nav-item ${page === "capabilities" ? "is-active" : ""}`} onClick={() => onNavigate("capabilities")}><Icon name="spark" size={18} /><span>For agents</span><span className="status-dot" /></button>
      </nav>
      <div className="sidebar-bottom"><button className={`nav-item ${page === "settings" ? "is-active" : ""}`} onClick={() => onNavigate("settings")}><Icon name="settings" size={18} /><span>Settings</span></button><div className="connection-note"><span className="online-dot" /><span>{sampleMode ? "Sample workspace" : "Private workspace"}</span><small>{sampleMode ? "Synthetic data only" : "API connected"}</small></div></div>
    </aside>
  </>;
}

function LoadingScreen() {
  return <div className="loading-screen" role="status" aria-live="polite"><div className="loading-brand"><div className="brand-mark" aria-hidden="true"><span /><span /><span /></div><span>Loading workspace</span></div><div className="skeleton-line wide" /><div className="skeleton-line" /><div className="skeleton-table"><span /><span /><span /><span /></div></div>;
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

function isAmbiguousMutation(error: ApiError): boolean {
  return !["validation", "forbidden", "unauthenticated", "csrf"].includes(error.kind);
}

export function ConnectionScreen({ state, error, demoAvailable, onLogin, onRetry, onSample }: { state: Exclude<ConnectionState, "loading" | "ready" | "sample">; error: ApiError | undefined; demoAvailable: boolean; onLogin: (password: string) => Promise<void>; onRetry: () => void; onSample: () => void }) {
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
  return <main className="connection-screen"><section className="connection-card" aria-labelledby="connection-title"><div className="loading-brand"><div className="brand-mark" aria-hidden="true"><span /><span /><span /></div><span>BenchLedger · private workspace</span></div><div className="connection-state-icon"><Icon name={isAuth ? "info" : isOffline ? "link" : "warning"} size={22} /></div><h1 id="connection-title">{title}</h1><p className="connection-description">{description}</p>{detail && <p className="connection-detail" role="alert">{detail}</p>}{isAuth && <form className="login-form" onSubmit={submit} noValidate><label className="form-field" htmlFor="workspace-password"><span>Workspace password</span><input id="workspace-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby={formError ? "workspace-password-error" : undefined} aria-invalid={Boolean(formError)} autoFocus /></label>{formError && <p id="workspace-password-error" className="form-error" role="alert">{formError}</p>}<button className="button button-primary login-submit" type="submit" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}<Icon name="arrow-right" size={16} /></button></form>}{!isAuth && <button className="button button-secondary connection-retry" onClick={onRetry}><Icon name="refresh" size={16} /> Try again</button>}{demoAvailable && <div className="sample-choice"><span>Sample workspace</span><button className="text-button" onClick={onSample}>Open sample workspace <Icon name="arrow-right" size={15} /></button><small>Sample records are synthetic. BenchLedger does not mix them with private records.</small></div>}</section></main>;
}

function SampleBanner({ onReturn }: { onReturn: () => void }) {
  return <div className="offline-banner sample-banner" role="status"><Icon name="info" size={17} /><div><strong>Sample workspace</strong><span>This is synthetic data for exploring the workflow. It is not your inventory and nothing is saved to the private service.</span></div><button className="text-button" onClick={onReturn}><Icon name="arrow-left" size={15} /> Return to private workspace</button></div>;
}

function PageHeader({ eyebrow, title, description, action, onAction, actionIcon = "plus", children }: { eyebrow: string; title: string; description: string; action?: string | undefined; onAction?: ((event: React.MouseEvent<HTMLButtonElement>) => void) | undefined; actionIcon?: Parameters<typeof Icon>[0]["name"]; children?: ReactNode }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="header-actions">{children}{action && <button className="button button-primary" onClick={onAction}><Icon name={actionIcon} size={17} />{action}</button>}</div></div>;
}

function BuildRail({ currentStep, projectName, onProject }: { currentStep: number; projectName?: string | undefined; onProject?: (() => void) | undefined }) {
  return <section className="build-rail" aria-label="Build progress"><div className="rail-heading"><div><span className="eyebrow">Build path</span><strong>{projectName ?? "Your next build"}</strong></div>{onProject && <button className="text-button" onClick={onProject}>Open project <Icon name="arrow-right" size={15} /></button>}</div><div className="rail-track">{railSteps.map((step, index) => <div className={`rail-step ${index < currentStep ? "is-complete" : ""} ${index === currentStep ? "is-current" : ""}`} key={step}><span className="rail-marker">{index < currentStep ? <Icon name="check" size={13} /> : index + 1}</span><span>{step}</span>{index < railSteps.length - 1 && <span className="rail-line" aria-hidden="true" />}</div>)}</div></section>;
}

function OverviewPage({ items, projects, expert, sampleMode, onNavigate, onOpenProject, onSelectItem, onNewProject }: { items: InventoryItem[]; projects: Project[]; expert: boolean; sampleMode: boolean; onNavigate: (page: Page) => void; onOpenProject: (id: string, tab?: ProjectTab) => void; onSelectItem: (id: string) => void; onNewProject: (event: React.MouseEvent<HTMLButtonElement>) => void }) {
  const activeProject = projects.find((project) => project.status !== "complete" && project.status !== "archived") ?? projects[0];
  const activeSummary = activeProject ? calculateProjectSummary(activeProject, items) : undefined;
  const readinessUnavailable = activeSummary?.readinessUnavailable === true;
  const noRequirements = activeSummary?.totalLines === 0;
  const decideLine = readinessUnavailable ? undefined : activeSummary?.lineStatuses.find((line) => line.line.optional !== true && line.decision === "decide");
  const inspectLine = readinessUnavailable ? undefined : activeSummary?.lineStatuses.find((line) => line.line.optional !== true && line.state === "inspect-first");
  const sourceLine = activeSummary?.readinessUnavailable === true ? undefined : activeSummary?.lineStatuses.find((line) => line.line.optional !== true && line.decision === "source");
  const nextActionTitle = activeProject
    ? readinessUnavailable
      ? `Reload project readiness for ${activeProject.name}.`
      : noRequirements
      ? `Add requirements for ${activeProject.name}.`
      : decideLine
      ? `Decide ${decideLine.line.label} for ${activeProject.name}.`
      : inspectLine
        ? `Check ${inspectLine.line.label} for ${activeProject.name}.`
        : sourceLine
          ? `Source ${sourceLine.line.label} for ${activeProject.name}.`
        : "Review the next build step."
    : "Add your first project.";
  const nextActionDescription = activeProject
    ? readinessUnavailable
      ? "Inventory changed, but canonical readiness is unavailable. Do not source parts until it returns."
      : noRequirements
      ? "No requirements are recorded yet. Add the materials, parts, and files that this build needs."
      : decideLine
      ? decideLine.missingDecisions?.length
        ? `Resolve ${decideLine.missingDecisions.join(" and ")} before BenchLedger proposes a source.`
        : "Resolve the requirement details before BenchLedger proposes a source."
      : inspectLine
        ? `${formatQuantity(inspectLine.line.required, inspectLine.line.unit)} is listed, but its stock still needs a physical or compatibility check before you reserve it.`
        : sourceLine
          ? `${formatQuantity(sourceLine.remaining || sourceLine.line.required, sourceLine.line.unit)} is not covered by confirmed stock yet.`
          : "Every recorded requirement is covered by confirmed stock. Continue with files or validation."
    : "Enter a project name and goal. Add equipment and parts when you identify them.";
  return <>
    <PageHeader eyebrow="Workbench" title="Review build status." description="Check inventory and complete the next project task." action="New project" onAction={onNewProject} />
    <BuildRail currentStep={activeProject?.railStep ?? 0} projectName={activeProject?.name} onProject={activeProject ? () => onOpenProject(activeProject.id) : undefined} />
    <section className="decision-strip"><div className="decision-copy"><span className="decision-kicker"><Icon name="spark" size={15} /> Next task</span><h2>{nextActionTitle}</h2><p>{nextActionDescription}</p></div>{activeProject && <button className="button button-secondary" onClick={() => onOpenProject(activeProject.id)}>Review project<Icon name="arrow-right" size={16} /></button>}</section>
    <section className="metric-strip" aria-label="Workspace summary"><Metric value={String(activeSummary?.readyLines ?? 0)} label="Ready" detail="confirmed for this build" tone="good" /><Metric value={String(activeSummary?.checkLines ?? 0)} label="Check" detail="inspect stock first" tone="warn" /><Metric value={String(activeSummary?.decideLines ?? 0)} label="Decide" detail="specify before sourcing" tone="info" /><Metric value={String(activeSummary?.sourceLines ?? 0)} label="Source" detail="proposal only" tone="bad" /></section>
    <div className="overview-grid"><section className="surface project-overview"><SectionHeading eyebrow="Active project" title={activeProject?.name ?? "No active project"} action={activeProject ? "Open project" : undefined} onAction={activeProject ? () => onOpenProject(activeProject.id) : undefined} /><div className="project-overview-body">{activeProject ? <><div className="project-overview-copy"><span className="status-pill tone-info"><span className="status-symbol">●</span>{activeProject.status}</span><h3>{activeProject.subtitle}</h3><p>{activeProject.description}</p><div className="dossier-meta"><span><Icon name="layers" size={15} /> {activeProject.workItem}</span><span><Icon name="tag" size={15} /> Revision {activeProject.currentRevision}</span><span><Icon name="clock" size={15} /> Updated {activeProject.updated}</span></div></div><div className="project-progress"><div className="progress-ring" style={{ "--progress": `${Math.round(((activeSummary?.readyLines ?? 0) / (activeSummary?.totalLines || 1)) * 100)}%` } as React.CSSProperties}><strong>{activeSummary?.readyLines ?? 0}</strong><span>ready</span></div><div><strong>{activeSummary?.missingLines ?? 0} parts to source</strong><p>{activeSummary?.inspectLines ?? 0} more need a physical check</p></div></div></> : <EmptyState icon="folder" title="No project selected" description="Create a project to compare requirements with inventory." />}</div></section><section className="surface inventory-overview"><SectionHeading eyebrow="Inventory" title="Inventory summary" action="View all" onAction={() => onNavigate("inventory")} /><div className="mini-inventory">{items.slice(0, 5).map((item) => { const identity = inventoryCandidateLabel(item, items); return <button className="mini-row" key={item.id} onClick={() => onSelectItem(item.id)}><span className={`item-glyph accent-${item.accent}`}><Icon name={categoryIcons[item.category]} size={16} /></span><span className="mini-row-copy"><strong>{identity.name}</strong>{(identity.discriminator ?? item.variant) ? <small>{identity.discriminator ?? item.variant}</small> : null}</span><StatusPill state={displayedInventoryState(item)} compact /></button>; })}</div></section></div>
    <section className="surface activity-section">{sampleMode ? <><SectionHeading eyebrow="Sample activity" title="Recent changes" /><div className="activity-list">{activity.map((entry) => <div className="activity-row" key={entry.id}><span className={`activity-dot activity-${entry.tone}`} /><div><strong>{entry.title}</strong><span>{entry.detail}</span></div><time>{entry.time}</time></div>)}</div></> : <><SectionHeading eyebrow="Activity" title="Recent changes" /><p className="activity-empty">Project changes will appear here when the service provides activity history.</p></>}</section>
  </>;
}

function Metric({ value, label, detail, tone }: { value: string; label: string; detail: string; tone: StockLabelTone }) {
  return <div className="metric"><span className={`metric-value metric-${tone}`}>{value}</span><div><strong>{label}</strong><small>{detail}</small></div></div>;
}

function SectionHeading({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string | undefined; onAction?: (() => void) | undefined }) {
  return <div className="section-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{action && <button className="text-button" onClick={onAction}>{action}<Icon name="arrow-right" size={14} /></button>}</div>;
}

function hasObservedInventoryVersion(item: InventoryItem): item is VersionedInventoryItem {
  return typeof item.version === "number" && Number.isSafeInteger(item.version) && item.version > 0;
}

function InventoryPage({ adapter, categories, search, refreshKey, bulkSelectionResetKey, onSearch, onSessionExpired, onPageItems, onSelectItem, onNewItem, onBulkSelectionChange }: { adapter: WorkspaceAdapter; categories: readonly ManagedInventoryCategory[]; search: string; refreshKey: number; bulkSelectionResetKey: number; onSearch: (value: string) => void; onSessionExpired: (error: unknown) => void; onPageItems: (items: readonly InventoryItem[]) => void; onSelectItem: (id: string) => void; onNewItem: () => void; onBulkSelectionChange: (items: readonly VersionedInventoryItem[], onResult: (result: InventoryBulkUpdateResult) => void) => void }) {
  const initialUrlState = readInventoryUrlState();
  const [categoryNodeId, setCategoryNodeId] = useState(initialUrlState.categoryNodeId);
  const [kind, setKind] = useState<InventoryKindQuery | "All">(initialUrlState.kind);
  const [evidence, setEvidence] = useState<InventoryEvidenceState | "All">(initialUrlState.evidence);
  const [availability, setAvailability] = useState<"All" | "available" | "unavailable">(initialUrlState.availability);
  const [pageItems, setPageItems] = useState<InventoryItem[]>([]);
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
  const previousFilterKey = useRef(filterKey);

  const loadedSelectedCount = pageItems.reduce((count, item) => count + (selectedTargets.has(item.id) ? 1 : 0), 0);
  const allLoadedSelected = pageItems.length > 0 && loadedSelectedCount === pageItems.length;
  const unversionedItem = pageItems.find((item) => !hasObservedInventoryVersion(item));
  const unversionedNotice = unversionedItem ? "Some loaded inventory rows cannot be selected for bulk edit because their observed version is unavailable. Reload inventory first." : undefined;

  useEffect(() => {
    const changed = previousFilterKey.current !== filterKey;
    previousFilterKey.current = filterKey;
    setSelectedTargets(new Map());
    setSelectionNotice(changed ? "Selection cleared because the search or filters changed." : undefined);
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
  return <>
    <PageHeader eyebrow="Inventory" title="Review inventory." description="Check tools, materials, components, quantities, and evidence." action="Add item" onAction={onNewItem} />
    <section className="surface inventory-section">
      <div className="inventory-toolbar" aria-label="Inventory filters">
        <label className="field-search"><Icon name="search" size={17} /><span className="sr-only">Filter inventory</span><input value={search} maxLength={MAX_INVENTORY_SEARCH_LENGTH} onChange={(event) => onSearch(event.target.value)} placeholder="Search name, model, tag, or location" /></label>
        <div className="inventory-filter-grid">
          <InventoryFilter label="Category" value={categoryNodeId} onChange={setCategoryNodeId} options={[{ value: "", label: "All categories" }, ...inventoryCategoryFilterOptions(categories), { value: UNASSIGNED_CATEGORY_FILTER, label: "Unassigned items" }]} />
          <InventoryFilter label="Kind" value={kind} onChange={(value) => setKind(value as InventoryKindQuery | "All")} options={[{ value: "All", label: "All kinds" }, ...inventoryKindOptions]} />
          <InventoryFilter label="Evidence" value={evidence} onChange={(value) => setEvidence(value as InventoryEvidenceState | "All")} options={[{ value: "All", label: "All evidence" }, { value: "physically_counted", label: "Physically counted" }, { value: "commissioned", label: "Commissioned" }, { value: "delivered_uncounted", label: "Delivered, not counted" }, { value: "ordered_unverified", label: "Ordered, not verified" }, { value: "allocated", label: "Allocated" }, { value: "consumed", label: "Consumed" }, { value: "unknown", label: "Unknown" }]} />
          <InventoryFilter label="Availability" value={availability} onChange={(value) => setAvailability(value as typeof availability)} options={[{ value: "All", label: "All availability" }, { value: "available", label: "Available for reuse" }, { value: "unavailable", label: "Not available" }]} />
        </div>
      </div>
      <div className="inventory-page-status" role="status" aria-live="polite">{loading ? "Loading inventory…" : error ? "Inventory could not be loaded." : loadMoreError ? "Showing the loaded items. More items could not be loaded." : total === undefined ? `Showing ${pageItems.length} items` : `Showing ${pageItems.length} of ${total} items`}</div>
      {selectedTargets.size > 0 && <div className="inventory-selection-bar" aria-label="Bulk inventory selection"><div><strong>{selectedTargets.size} selected of {pageItems.length} loaded</strong><span>Select all applies only to the items currently loaded. You can select up to 100.</span></div><button className="button button-secondary" onClick={openBulkEditor}>Bulk edit<Icon name="sliders" size={16} /></button></div>}
      {unversionedNotice && <p id="inventory-version-notice" className="inventory-selection-notice" role="status" aria-live="polite">{unversionedNotice}</p>}
      {selectionNotice && <p className="inventory-selection-notice" role="status" aria-live="polite">{selectionNotice}</p>}
      {error ? <div className="inventory-load-error" role="alert"><span>{error.message}</span><button className="button button-secondary" onClick={() => setRetryNonce((value) => value + 1)}>Try again</button></div> : loading && pageItems.length === 0 ? <div className="inventory-loading" aria-label="Loading inventory">Loading inventory…</div> : pageItems.length ? <><InventoryTable items={pageItems} categories={categories} selectedIds={new Set(selectedTargets.keys())} selectAllRef={selectAllRef} allLoadedSelected={allLoadedSelected} hasUnversionedLoaded={Boolean(unversionedItem)} onToggleAll={toggleAllLoaded} onToggleSelected={toggleSelected} onSelectItem={onSelectItem} />{loadMoreError && <div className="inventory-load-error" role="alert"><span>{loadMoreError.message}</span><button className="button button-secondary" onClick={() => { void loadMore(); }}>Try again</button></div>}{nextCursor && <div className="inventory-load-more"><button className="button button-secondary" onClick={() => { void loadMore(); }} disabled={loadingMore} aria-busy={loadingMore}>{loadingMore ? "Loading…" : "Load more"}<Icon name="chevron-right" size={16} /></button></div>}</> : <EmptyState icon="search" title="No matching items" description="Change the search text or filters." action="Clear filters" onAction={clearFilters} />}
    </section>
  </>;
}

function InventoryFilter({ label, value, options, onChange }: { label: string; value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void }) {
  return <label className="category-control"><span className="category-control-label">{label}</span><select aria-label={`Filter inventory by ${label.toLowerCase()}`} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

export function managedInventoryLabel(categories: readonly ManagedInventoryCategory[], item: InventoryItem, expert = false): string {
  return selectedCategoryLabel(categories, item.categoryNodeId) ?? (item.categoryNodeId ? "Managed category unavailable" : expert ? "Unassigned legacy item" : "Unassigned item");
}

function InventoryTable({ items, categories, selectedIds, selectAllRef, allLoadedSelected, hasUnversionedLoaded, onToggleAll, onToggleSelected, onSelectItem }: { items: InventoryItem[]; categories: readonly ManagedInventoryCategory[]; selectedIds: ReadonlySet<string>; selectAllRef: React.RefObject<HTMLInputElement | null>; allLoadedSelected: boolean; hasUnversionedLoaded: boolean; onToggleAll: () => void; onToggleSelected: (id: string) => void; onSelectItem: (id: string) => void }) {
  return <div className="table-scroll"><table className="data-table inventory-table"><caption className="sr-only">Inventory items</caption><thead><tr><th scope="col" className="select-column"><input ref={selectAllRef} type="checkbox" className="inventory-checkbox" checked={allLoadedSelected} onChange={onToggleAll} disabled={hasUnversionedLoaded} aria-describedby={hasUnversionedLoaded ? "inventory-version-notice" : undefined} aria-label="Select all loaded inventory items" /></th><th scope="col">Item</th><th scope="col">Category</th><th scope="col">Quantity</th><th scope="col">Status</th><th scope="col">Location</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead><tbody>{items.map((item) => { const categoryLabel = managedInventoryLabel(categories, item); const versionAvailable = hasObservedInventoryVersion(item); const versionNoticeId = `inventory-version-${item.id}`; const identity = inventoryCandidateLabel(item, items); const identityText = inventoryCandidateText(item, items); return <tr key={item.id}><td className="select-column"><input type="checkbox" className="inventory-checkbox" checked={selectedIds.has(item.id)} onChange={() => onToggleSelected(item.id)} disabled={!versionAvailable} aria-describedby={!versionAvailable ? versionNoticeId : undefined} aria-label={`Select ${identityText}`} />{!versionAvailable && <span id={versionNoticeId} className="sr-only">Cannot select for bulk edit because this row has no positive observed version. Reload inventory first.</span>}</td><td><button className="table-item" onClick={() => onSelectItem(item.id)}><span className={`item-glyph accent-${item.accent}`}><Icon name={categoryIcons[item.category]} size={16} /></span><span><strong>{identity.name}</strong>{identity.discriminator ? <small>{identity.discriminator}</small> : item.variant ? <small>{item.variant}</small> : null}{(item.category === "Filament" || item.category === "Printers") && <small className={`exact-product-state ${item.productProfile?.linkState === "confirmed" ? "is-confirmed" : ""}`}>{exactProductLabel(item)}</small>}</span></button></td><td><span className="category-label"><Icon name={categoryIcons[item.category]} size={14} />{categoryLabel}</span></td><td className="quantity-cell"><strong>{formatQuantity(Math.max(item.quantity - item.reserved, 0), item.unit)}</strong>{item.reserved > 0 && <small>{formatQuantity(item.reserved, item.unit)} reserved</small>}</td><td><StatusPill state={displayedInventoryState(item)} /></td><td><span className="location-label"><Icon name="archive" size={14} />{item.location}</span></td><td><button className="row-open" onClick={() => onSelectItem(item.id)} aria-label={`Open ${identityText}`}><Icon name="chevron-right" size={17} /></button></td></tr>; })}</tbody></table></div>;
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
}

function projectedBulkTags(item: InventoryItem, changes: InventoryBulkUpdateInput["changes"]): string[] {
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
}

function BulkInventoryDialog({ selectedItems, onClose, onDone, onApply }: { selectedItems: readonly VersionedInventoryItem[]; onClose: () => void; onDone: () => void; onApply: (input: InventoryBulkUpdateInput) => Promise<InventoryBulkUpdateResult> }) {
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

  const reviewChanges = (event: FormEvent) => {
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
  return <Dialog title="Bulk edit inventory" onClose={dialogClose}>
    {step === "edit" && <form className="bulk-inventory-form" onSubmit={reviewChanges} aria-busy={saving}>
      <p className="dialog-intro">Apply the same storage, condition, or tag changes to <strong>{targetCount} selected item{targetCount === 1 ? "" : "s"}</strong>. Quantity and evidence are not included.</p>
      <label className="form-field"><span>Location</span><input autoFocus value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Leave blank to keep each location" disabled={saving} /></label>
      <label className="form-field"><span>Condition</span><select value={condition} onChange={(event) => setCondition(event.target.value as InventoryCondition | "")} disabled={saving}><option value="">Keep each current condition</option><option value="new">New</option><option value="good">Good</option><option value="worn">Worn</option><option value="needs_repair">Needs repair</option><option value="unknown">Unknown</option></select></label>
      <label className="form-field"><span>Tags to add</span><input value={tagsAdd} onChange={(event) => setTagsAdd(event.target.value)} placeholder="Comma or newline separated" disabled={saving} /></label>
      <label className="form-field"><span>Tags to remove</span><input value={tagsRemove} onChange={(event) => setTagsRemove(event.target.value)} placeholder="Comma or newline separated" disabled={saving} /></label>
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <p className="bulk-inventory-note">Nothing changes until you review and confirm.</p>
      <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="button button-primary" disabled={saving}>Review changes<Icon name="arrow-right" size={16} /></button></div>
    </form>}
    {step === "confirm" && <section className="bulk-inventory-confirmation" aria-busy={saving}>
      <p className="dialog-intro">Nothing changes until you confirm.</p>
      <div className="bulk-inventory-summary"><strong>{targetCount} item{targetCount === 1 ? "" : "s"}</strong>{location.trim() && <span>Location → {location.trim()}</span>}{condition && <span>Condition → {condition.replaceAll("_", " ")}</span>}{(tagsAdd.trim() || tagsRemove.trim()) && <span>Tags → {tagsAdd.trim() ? `add ${splitBulkTags(tagsAdd).join(", ")}` : ""}{tagsAdd.trim() && tagsRemove.trim() ? "; " : ""}{tagsRemove.trim() ? `remove ${splitBulkTags(tagsRemove).join(", ")}` : ""}</span>}</div>
      <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => setStep("edit")} disabled={saving}>Back to changes</button><button type="button" className="button button-primary" onClick={() => { void confirmChanges(); }} disabled={saving} aria-busy={saving}>{saving ? "Applying…" : "Confirm bulk edit"}</button></div>
      {saving && <p className="bulk-live-status" role="status" aria-live="polite">Applying changes to {targetCount} item{targetCount === 1 ? "" : "s"}…</p>}
    </section>}
    {step === "result" && outcome && <section className={`bulk-inventory-result bulk-result-${outcome.kind}`}>
      <p className="bulk-live-status" role={outcome.kind === "conflict" || outcome.kind === "error" || outcome.kind === "ambiguous" ? "alert" : "status"} aria-live="polite">{outcome.message}</p>
      {outcome.correlationId && <small className="bulk-correlation">Reference {outcome.correlationId}</small>}
      {outcome.kind === "ambiguous" && <p className="bulk-inventory-note">Retry safely reuses the retained idempotency key for this exact edit. Do not change the values if you want the service to replay the same command.</p>}
      {outcome.kind === "conflict" && <p className="bulk-inventory-note">Nothing was saved. Reload inventory and select the current rows before trying again.</p>}
      {outcome.kind === "error" && <p className="bulk-inventory-note">Nothing was saved. Correct the values or check the service connection.</p>}
      <div className="dialog-actions">{outcome.kind === "success" || outcome.kind === "noop" ? <button type="button" className="button button-primary" onClick={onDone}>Done</button> : outcome.kind === "ambiguous" ? <><button type="button" className="button button-primary" onClick={() => { void confirmChanges(); }} disabled={saving} aria-busy={saving}>Retry safely</button><button type="button" className="button button-secondary" onClick={onClose}>Close</button></> : <><button type="button" className="button button-quiet" onClick={() => { setOutcome(undefined); setStep("edit"); }}>Back to changes</button><button type="button" className="button button-secondary" onClick={onClose}>Close</button></>}</div>
    </section>}
  </Dialog>;
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

function StatusPill({ state, compact = false }: { state: StockState | "optional"; compact?: boolean }) {
  const status = state === "optional" ? { label: "Optional", tone: "muted" as const } : getStockLabel(state);
  return <span className={`status-pill tone-${status.tone} ${compact ? "status-compact" : ""}`}><span className="status-symbol" aria-hidden="true">{status.tone === "good" ? "✓" : status.tone === "bad" ? "!" : status.tone === "warn" ? "?" : "–"}</span>{status.label}</span>;
}

export function ProjectExpertContext({ project }: { project: Project }) {
  const workItems = project.workItems ?? [];
  return <div className="detail-grid expert-context-grid">
    {workItems.length ? workItems.map((item) => {
      const revisionId = item.currentRevisionId ?? item.currentRevision?.id;
      const value = `${item.name} · ${item.id} · ${revisionId ?? "No current revision"}`;
      return <div key={item.id}><span>Work item</span><div className="expert-value"><code>{value}</code><CopyValueButton value={value} /></div></div>;
    }) : <div><span>Work items</span><code>No work items recorded</code></div>}
    <div><span>Revision state</span><code>State is supplied by the connected service.</code></div>
    <div><span>Artifact policy</span><code>Retained revisions are not overwritten.</code></div>
  </div>;
}

function CopyValueButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permissions are optional; the full value remains selectable.
    }
  };
  return <button type="button" className="copy-value-button" onClick={() => { void copy(); }} aria-label={copied ? "Copied" : "Copy value"}>{copied ? "Copied" : "Copy"}</button>;
}

function ProjectPage({ project, projects, projectView, archivedProjectCount, items, offers, tab, expert, sampleMode, onTabChange, onSelectProject, onProjectViewChange, onOpenItem, onNavigate, onToast, onNewProject, onArchive, onRestore, onRemove, onNewRevision, onRetrySetup, onAddBom, onUpload, onReadReconciliation, onSaveReconciliation, onCommitReconciliation, onRefreshWorkspace, onListInspections, onReadInspection, onPreviewInspection, onConfirmInspection }: {
  project: Project;
  projects: Project[];
  projectView: "active" | "archived";
  archivedProjectCount: number;
  items: InventoryItem[];
  offers: typeof fixtureOffers;
  tab: ProjectTab;
  expert: boolean;
  sampleMode: boolean;
  onTabChange: (tab: ProjectTab) => void;
  onSelectProject: (id: string) => void;
  onProjectViewChange: (view: "active" | "archived") => void;
  onOpenItem: (id: string) => void;
  onNavigate: (page: Page) => void;
  onToast: (message: string) => void;
  onNewProject: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onArchive: (project: Project) => Promise<void>;
  onRestore: (project: Project) => Promise<void>;
  onRemove: (project: Project) => Promise<void>;
  onNewRevision: () => void;
  onRetrySetup?: (() => void) | undefined;
  onAddBom: () => void;
  onUpload: (projectId: string, file: File, role: string, target?: ArtifactUploadTarget) => Promise<void>;
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
  const hasServerRevision = !sampleMode && Boolean(project.serverRevisionId);
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
  const reconciliationRevisionId = project.serverRevisionId;
  const inspectionRevisionId = project.serverRevisionId;

  useEffect(() => {
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
    if (!hasServerRevision && tab === "reconciliation") onTabChange("plan");
  }, [hasServerRevision, tab, onTabChange]);

  const saveReconciliation = async (model: ReconciliationViewModel) => {
    if (!reconciliationRevisionId) return;
    const saved = await onSaveReconciliation(project.id, reconciliationRevisionId, model);
    setReconciliation(saved);
    onToast("Close-out review saved. Check the server preview before committing.");
  };

  const commitReconciliation = async (model: ReconciliationViewModel) => {
    if (!reconciliationRevisionId) return;
    const committed = await onCommitReconciliation(project.id, reconciliationRevisionId, model);
    setReconciliation(committed);
    const refreshed = await onRefreshWorkspace();
    if (refreshed) {
      onToast(committed.trace?.replayed ? "Close-out replayed safely; workspace refreshed." : "Close-out committed; inventory and project state refreshed.");
    } else {
      onToast("Close-out committed, but workspace refresh failed. The committed close-out remains visible; try refreshing again when the service is available.");
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
  return <InspectionContext.Provider value={inspectionContext}><>
    <PageHeader eyebrow="Project" title={project.name} description={project.subtitle} action="New project" onAction={onNewProject}><div className="project-view-switch" role="group" aria-label="Project view"><button type="button" className={projectView === "active" ? "is-active" : ""} onClick={() => onProjectViewChange("active")}>Active projects</button><button type="button" className={projectView === "archived" ? "is-active" : ""} onClick={() => onProjectViewChange("archived")}>Archived ({archivedProjectCount})</button></div><select className="project-select" aria-label="Choose project" value={project.id} onChange={(event) => onSelectProject(event.target.value)}>{projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select>{project.status === "archived" ? <button className="button button-primary" onClick={() => setRestoreConfirmationOpen(true)}><Icon name="refresh" size={16} /> Restore project</button> : <button className="button button-secondary" onClick={() => setArchiveConfirmationOpen(true)}><Icon name="archive" size={16} /> Archive project</button>}{onRetrySetup && project.status !== "archived" && <button className="button button-secondary" onClick={onRetrySetup}><Icon name="refresh" size={16} /> Retry setup</button>}{project.status !== "archived" && <button className="button button-secondary" onClick={onNewRevision}><Icon name="plus" size={16} /> New revision</button>}</PageHeader>
    {archiveConfirmationOpen && <Dialog title={`Archive ${project.name}?`} role="alertdialog" onClose={() => { if (!archiving) setArchiveConfirmationOpen(false); }}><p className="dialog-intro">This hides the project from active lists and releases its active reservations. Revisions, files, BOM, stock evidence, and audit history remain retained. Archive is reversible; restore returns it to idea without recreating reservations.</p><div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => setArchiveConfirmationOpen(false)} disabled={archiving}>Cancel</button><button type="button" className="button button-primary" onClick={() => { void confirmArchive(); }} disabled={archiving} aria-busy={archiving}>{archiving ? "Archiving…" : "Archive project"}</button></div></Dialog>}
    {restoreConfirmationOpen && <Dialog title={`Restore ${project.name}?`} role="alertdialog" onClose={() => { if (!restoring) setRestoreConfirmationOpen(false); }}><p className="dialog-intro">This moves the project to Idea. It does not recreate released reservations.</p><div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => setRestoreConfirmationOpen(false)} disabled={restoring}>Cancel</button><button type="button" className="button button-primary" onClick={() => { void confirmRestore(); }} disabled={restoring} aria-busy={restoring}>{restoring ? "Restoring…" : "Restore project"}</button></div></Dialog>}
    {removeConfirmationOpen && <Dialog title={`Remove ${project.name} from the workspace?`} role="alertdialog" onClose={() => { if (!removing) { setRemoveConfirmationOpen(false); setRemoveConfirmation(""); } }}><p className="dialog-intro"><strong>This action is irreversible.</strong> It removes this {project.status === "archived" ? "archived" : "active"} project from workspace lists. {project.status === "archived" ? "" : "Active reservations will be released. "} Its tombstone, revisions, files, reservations release evidence, and audit history remain retained for history, but the project cannot be restored.</p><label className="form-field" htmlFor="remove-project-confirmation"><span>Type <strong>{project.name}</strong> to confirm</span><input id="remove-project-confirmation" autoFocus value={removeConfirmation} onChange={(event) => setRemoveConfirmation(event.target.value)} disabled={removing} autoComplete="off" /></label><div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => { setRemoveConfirmationOpen(false); setRemoveConfirmation(""); }} disabled={removing}>Cancel</button><button type="button" className="button button-danger" onClick={() => { void confirmRemove(); }} disabled={removing || removeConfirmation !== project.name} aria-busy={removing}>{removing ? "Removing…" : "Remove from workspace"}</button></div></Dialog>}
    {project.status === "archived" && <div className="archive-notice" role="status"><Icon name="archive" size={17} /><span><strong>Archived project</strong> Hidden from active lists. Active reservations were released; revisions, files, BOM, stock evidence, and audit history remain retained. Restore is reversible and returns the project to idea without recreating reservations.</span></div>}
    <details className="project-actions"><summary>Project settings <Icon name="chevron-down" size={14} /></summary><div><span>Archive keeps revisions and audit history available. Removing a project keeps its tombstone but cannot be undone.</span><button className="button button-danger" onClick={() => { setRemoveConfirmation(""); setRemoveConfirmationOpen(true); }}><Icon name="close" size={16} /> Delete from workspace</button></div></details>
    <BuildRail currentStep={project.railStep} projectName={`${project.name} · ${project.currentRevision}`} />
    <div className="dossier-layout"><aside className="dossier-column"><div className="dossier-status"><span className={`status-pill tone-${project.status === "complete" ? "good" : "info"}`}><span className="status-symbol">●</span>{project.status}</span><span className="revision-label">{project.currentRevision}</span></div><h2>{project.workItem}</h2><p>{project.description}</p><div className="dossier-next"><span className="eyebrow">Next action</span><strong>{project.status === "archived" ? "Restore to continue work" : summary.readinessUnavailable ? "Reload project readiness" : summary.decideLines ? "Decide the open requirements" : summary.inspectLines ? "Check the physical stock" : summary.sourceLines ? "Source the remaining parts" : summary.totalLines === 0 ? "Add requirements" : "Ready to validate"}</strong><span>{project.status === "archived" ? "Archived projects reject new work, revisions, BOM lines, reservations, uploads, and commits until restored." : summary.readinessUnavailable ? "Inventory changed, but canonical project readiness could not be reloaded. Do not source parts until it returns." : summary.decideLines ? `${summary.decideLines} BOM line${summary.decideLines === 1 ? " needs" : "s need"} a specification decision before sourcing.` : summary.inspectLines ? `${summary.inspectLines} BOM line${summary.inspectLines === 1 ? " needs" : "s need"} a physical or compatibility check.` : summary.sourceLines ? `${summary.sourceLines} BOM line${summary.sourceLines === 1 ? " is" : "s are"} ready for a source proposal.` : summary.totalLines === 0 ? "No requirements are recorded yet." : "Every recorded requirement is covered by confirmed stock."}</span></div><dl className="dossier-facts"><div><dt>Current revision</dt><dd>{project.currentRevision}</dd></div><div><dt>Build files</dt><dd>{project.artifacts.length} artifacts</dd></div><div><dt>Last changed</dt><dd>{project.updated}</dd></div></dl>{project.buildConfigSnapshot && <BuildSetupSummary input={project.buildConfigSnapshot} printer={configuredPrinter} filament={configuredFilament} expert={expert} />}{expert && <details className="expert-detail"><summary>Expert context</summary><ProjectExpertContext project={project} /></details>}<button className="text-button dossier-inventory-link" onClick={() => onNavigate("inventory")}>Browse all inventory <Icon name="arrow-right" size={15} /></button></aside><section className="dossier-workspace"><div className="tab-list" role="tablist" aria-label="Project workspace"><button role="tab" aria-selected={tab === "plan"} className={tab === "plan" ? "is-active" : ""} onClick={() => onTabChange("plan")}><Icon name="clipboard" size={16} /> Plan <span>{summary.totalLines}</span></button><button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "is-active" : ""} onClick={() => onTabChange("files")}><Icon name="folder" size={16} /> Files <span>{project.artifacts.length}</span></button><button role="tab" aria-selected={tab === "offers"} className={tab === "offers" ? "is-active" : ""} onClick={() => onTabChange("offers")}><Icon name="tag" size={16} /> Shopping list <span>{summary.sourceLines}</span></button>{hasServerRevision && <button role="tab" aria-selected={tab === "reconciliation"} className={tab === "reconciliation" ? "is-active" : ""} onClick={() => onTabChange("reconciliation")}><Icon name="check-circle" size={16} /> Close out <span>{reconciliation?.status === "committed" ? "Done" : "Review"}</span></button>}</div>{tab === "plan" && <ProjectPlan project={project} summary={summary} expert={expert} onOpenItem={onOpenItem} onAddBom={project.status === "archived" ? () => onToast("Restore this project before adding a requirement.") : onAddBom} />}{tab === "files" && <ProjectFiles project={project} expert={expert} sampleMode={sampleMode} onUpload={(file, role, target) => onUpload(project.id, file, role, target)} archived={project.status === "archived"} />}{tab === "offers" && <ShoppingList project={project} summary={summary} offers={offers} expert={expert} onToast={onToast} onBackToPlan={() => onTabChange("plan")} />}{tab === "reconciliation" && hasServerRevision && <section className="reconciliation-page-surface">{reconciliationLoading && <div className="reconciliation-loading" role="status"><span className="eyebrow">Project close-out</span><strong>Loading the current review…</strong><p>Nothing changes in inventory while this review loads.</p></div>}{reconciliationError && !reconciliationLoading && <div className="reconciliation-loading reconciliation-load-error" role="alert"><span className="eyebrow">Could not load close-out</span><strong>{reconciliationError}</strong><button className="button button-secondary" onClick={() => onTabChange("plan")}>Back to plan</button></div>}{reconciliation && !reconciliationLoading && !reconciliationError && <ReconciliationUI model={reconciliation} expert={expert} onChange={setReconciliation} onRequestPreview={saveReconciliation} onConfirmCommit={commitReconciliation} />}</section>}</section></div>
  </></InspectionContext.Provider>;
}

function ProjectPlan({ project, summary, expert, onOpenItem, onAddBom }: { project: Project; summary: ReturnType<typeof calculateProjectSummary>; expert: boolean; onOpenItem: (id: string) => void; onAddBom: () => void }) {
  const inspection = useContext(InspectionContext);
  const empty = summary.totalLines === 0;
  return <div className="project-plan"><InspectionQueuePanel actions={inspection?.actions ?? (project as InspectionProject).inspectionActions ?? []} expert={expert} loadError={inspection?.error} onReadInspection={inspection?.onReadInspection} onPreviewInspection={inspection?.onPreviewInspection} onConfirmInspection={inspection?.onConfirmInspection} /><section className="surface bom-section"><SectionHeading eyebrow="Bill of materials" title="What this build needs" /><div className="bom-explainer"><Icon name="info" size={16} /><span>Only counted or commissioned stock is shown as ready. Delivered and ordered items stay Check; under-specified requirements stay Decide until their missing decisions are recorded.</span></div>{empty ? <div className="empty-state"><h3>No requirements are recorded yet.</h3><p>Add the materials, parts, and files that this build needs.</p></div> : <div className="bom-list">{summary.lineStatuses.map((line) => <BomLineRow key={line.line.id} line={line} expert={expert} onOpenItem={onOpenItem} />)}</div>}<button className="add-line-button" onClick={onAddBom}><Icon name="plus" size={16} /> {empty ? "Add requirements" : "Add a requirement"}</button></section><section className="surface learning-section"><SectionHeading eyebrow="Project memory" title="What we learned" /><div className="learning-list">{project.notes.length ? project.notes.map((note, index) => <div className="learning-row" key={note}><span className="learning-index">0{index + 1}</span><p>{note}</p><span className="learning-time">Recorded</span></div>) : <p className="activity-empty">No observations are recorded for this revision yet.</p>}</div></section></div>;
}

export function BomLineRow({ line, expert, onOpenItem }: { line: BomLineStatus; expert: boolean; onOpenItem: (id: string) => void }) {
  const display = getLineLabel(line.state);
  const required = line.gap?.requiredQuantity ?? line.line.required;
  const unit = line.gap?.unit ?? line.line.unit;
  const reasons = line.gap?.reasons ?? [];
  const diagnostics = unitDiagnostics(line);
  const candidates = line.gap?.candidates ?? [];
  const alternatives = line.gap?.alternatives ?? line.line.alternatives ?? [];
  const itemFor = (itemId: string) => (line.items ?? (line.item ? [line.item] : [])).find((item) => item.id === itemId);
  const correctionItem = line.item?.unitStatus === "needs_correction" ? line.item : undefined;
  const needsUnitCorrection = correctionItem !== undefined;
  const rowDisplay = needsUnitCorrection ? { label: "Unit needs correction", tone: "bad" as const } : display;
  const matchedItemLabel = line.item ? inventoryCandidateLabel(line.item, line.items ?? [line.item], expert) : undefined;
  return <div className={`bom-row bom-${line.state} ${needsUnitCorrection ? "bom-unit-mismatch" : ""}`}>
    <div className="bom-main"><span className={`bom-state-mark mark-${rowDisplay.tone}`} aria-hidden="true">{rowDisplay.tone === "good" ? "✓" : rowDisplay.tone === "bad" ? "!" : rowDisplay.tone === "warn" ? "?" : "–"}</span><div><strong>{line.line.label}</strong><span>{line.line.note ?? `${formatQuantity(required, unit)} required`}</span>{needsUnitCorrection && <small className="bom-unit-warning">{correctionItem.unitCorrectionReason ?? "Stock is not matched or reserved until its unit is corrected from observed evidence."}</small>}{line.missingDecisions?.length ? <small className="bom-missing-decisions">Decide: {line.missingDecisions.join(", ")}</small> : null}</div></div>
    <div className="bom-quantity"><strong>{line.supplied > 0 ? `${formatQuantity(line.supplied, unit)} / ` : ""}{formatQuantity(required, unit)}</strong>{line.remaining > 0 && <small>{formatQuantity(line.remaining, unit)} remaining</small>}</div>
    <div className="bom-match">{needsUnitCorrection ? <span className="match-none">No safe match</span> : line.item && matchedItemLabel ? <button className="match-link" onClick={() => onOpenItem(line.item!.id)}><span>{matchedItemLabel.name}</span>{matchedItemLabel.discriminator && <small>· {matchedItemLabel.discriminator}</small>}<Icon name="arrow-up-right" size={13} /></button> : <span className="match-none">No matching stock</span>}<span className={`status-pill tone-${rowDisplay.tone}`}><span className="status-symbol" aria-hidden="true">{rowDisplay.tone === "good" ? "✓" : rowDisplay.tone === "bad" ? "!" : rowDisplay.tone === "warn" ? "?" : "–"}</span>{rowDisplay.label}</span>{line.decision === "decide" && !needsUnitCorrection && <small className="bom-decision-label">Decide before source</small>}</div>
    {expert && <details className="bom-expert"><summary aria-label={`Show evidence for ${line.line.label}`}><Icon name="chevron-down" size={16} /></summary><div><span>Line ID</span><p>{line.line.id}</p><span>Line version</span><p>{line.line.version}</p><span>Canonical unit</span><p>{line.line.serverUnit ?? line.line.unit}</p><span>Match reason</span><p>{needsUnitCorrection ? "The inventory unit must be corrected from observed evidence before matching." : line.item ? `${line.item.variant} matches the requested category. Compatibility is based on the recorded project constraint.` : "No exact variant has been recorded in the workspace."}</p>{line.item?.dimensions && <span>Recorded dimensions: {formatDimensions(line.item.dimensions)}</span>}{reasons.length > 0 && <><span>Canonical gap reasons</span><ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></>}{diagnostics.length > 0 && <><span>Unit diagnostics</span><ul>{diagnostics.map((diagnostic) => <li key={diagnostic}>{diagnostic}</li>)}</ul></>}{candidates.length > 0 && <><span>Candidate evidence</span><ul>{candidates.map((candidate) => <li key={`${candidate.itemId}-${candidate.relationship}`}>{itemFor(candidate.itemId)?.name ?? candidate.itemId}: {candidate.reason}</li>)}</ul></>}{alternatives.length > 0 && <><span>Structured alternatives</span><ul>{alternatives.map((alternative) => <li key={alternative.itemId}>{alternative.itemId}{alternative.compatible ? ` · ${alternative.compatible}` : ""}{alternative.reason ? ` · ${alternative.reason}` : ""}{alternative.quantityConversion ? ` · 1 ${alternative.quantityConversion.inventory.unit} = ${alternative.quantityConversion.requirement.quantity} ${alternative.quantityConversion.requirement.unit}; ${alternative.quantityConversion.evidence.basis}, observed ${alternative.quantityConversion.evidence.observedAt.slice(0, 10)}` : ""}</li>)}</ul></>}</div></details>}
  </div>;
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

export function ProjectFiles({ project, expert, sampleMode, onUpload, archived = false }: { project: Project; expert: boolean; sampleMode: boolean; onUpload: (file: File, role: string, target?: ArtifactUploadTarget) => Promise<void>; archived?: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const choices = artifactScopeChoices(project, expert);
  const [scopeKey, setScopeKey] = useState(() => artifactScopeKey(defaultArtifactScope(project)));
  const [uploadRun, setUploadRun] = useState<UploadRun>();
  const selectedChoice = choices.find((choice) => choice.key === scopeKey) ?? choices[0];
  const scope = selectedChoice?.target ?? { kind: "all" as const };
  const allArtifacts = project.allArtifacts ?? project.artifacts;
  const visibleArtifacts = filterArtifactsForScope(allArtifacts, scope);
  const uploadsDisabled = archived || uploadRun?.active === true || scope.kind === "all";

  useEffect(() => {
    setScopeKey(artifactScopeKey(defaultArtifactScope(project)));
    setUploadRun(undefined);
  }, [project.id, project.serverRevisionId]);

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
  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!selected.length || uploadsDisabled) return;
    void processFiles(selected);
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
        : "New files will be saved with this work item revision.";

  return <section className="surface files-section">
    <div className="files-header"><div><span className="eyebrow">Project files</span><h2>Revisioned build evidence</h2><p>{archived ? "This archive keeps files and history available, but uploads resume only after you restore the project." : sampleMode ? "Uploads stay inside this explicitly synthetic sample workspace." : "Keep editable CAD, exports, slicer plates, and validation notes together without overwriting an older candidate."}</p></div><div><input ref={fileInput} type="file" multiple className="sr-only" aria-label="Choose files to upload" onChange={addFiles} disabled={uploadsDisabled} /><button className="button button-primary" onClick={() => fileInput.current?.click()} disabled={uploadsDisabled} aria-busy={uploadRun?.active}>{archived ? "Restore to add files" : scope.kind === "all" ? "Choose a revision to upload" : <><Icon name="upload" size={16} />{uploadRun?.active ? "Uploading…" : "Add files"}</>}</button></div></div>
    <div className="artifact-scope-control"><label className="form-field" htmlFor="artifact-scope"><span>File scope</span><select id="artifact-scope" aria-label="Choose file scope" value={selectedChoice?.key ?? "all"} onChange={(event) => setScopeKey(event.target.value)} disabled={uploadRun?.active || archived}>{choices.map((choice) => <option key={choice.key} value={choice.key} disabled={choice.disabled}>{choice.label}</option>)}</select></label><div className="file-scope-identity"><Icon name="folder" size={15} /><span><strong>{artifactScopeIdentity(scope, expert)}</strong><code>{scopeDescription}</code></span><span className="file-scope-context">{sampleMode ? "sample workspace" : "private workspace"}</span></div></div>
    {uploadRun && <div className={`upload-status ${errorCount ? "has-errors" : ""}`} role="status" aria-live="polite"><div className="upload-status-heading"><strong>{uploadRun.active ? `Uploading ${Math.min((uploadRun.currentIndex ?? uploadRun.completed) + 1, uploadRun.total)} of ${uploadRun.total}` : `${successCount} of ${uploadRun.total} file${uploadRun.total === 1 ? "" : "s"} uploaded`}</strong><span>{currentEntry?.name ?? (errorCount ? `${errorCount} failed` : `Target: ${uploadRun.targetLabel}`)}</span></div><progress max={uploadRun.total} value={uploadRun.completed} aria-label="Artifact upload progress" /><ul>{uploadRun.entries.map((entry) => <li key={`${entry.name}-${entry.role}`}><span><strong>{entry.name}</strong><small>{entry.role}</small></span><span className={`upload-entry-state upload-${entry.status}`}>{entry.status === "pending" ? "Waiting" : entry.status === "uploading" ? "Uploading…" : entry.status === "success" ? "Uploaded" : "Not uploaded"}</span>{entry.status === "error" && entry.message && <p role="alert">{entry.message}</p>}</li>)}</ul></div>}
    {visibleArtifacts.length ? <div className="table-scroll"><table className="data-table files-table"><caption className="sr-only">Artifacts in {artifactScopeIdentity(scope, expert)}</caption><thead><tr><th scope="col">File</th><th scope="col">Role</th><th scope="col">Scope</th><th scope="col">Revision</th><th scope="col">Updated</th><th scope="col">State</th>{expert && <th scope="col">SHA-256</th>}</tr></thead><tbody>{visibleArtifacts.map((file) => <tr key={file.id}><td><span className="file-name"><span className={`file-type type-${file.role.toLowerCase().replaceAll(" ", "-")}`}><Icon name={file.role === "Validation" ? "clipboard" : file.role === "Editable CAD" ? "code" : "file"} size={15} /></span><span><strong>{file.name}</strong><small>{file.size}{file.machine ? ` · ${file.machine}` : ""}</small></span></span></td><td>{file.role}</td><td className="file-scope-cell">{artifactIdentityLabel(file, expert)}</td><td><span className="revision-tag">{artifactRevisionLabel(file, expert)}</span></td><td>{file.updated}</td><td><span className={`file-state state-${file.status}`}>{file.status === "candidate" ? "Candidate" : file.status === "validated" ? "Validated" : "Superseded"}</span></td>{expert && <td><code className="hash-cell">{file.hash}</code></td>}</tr>)}</tbody></table></div> : <div className="files-empty"><Icon name="folder" size={20} /><strong>{scope.kind === "all" ? "No files in this workspace yet." : "No files in this revision yet."}</strong><span>{scope.kind === "all" ? expert ? "Legacy and unbound files will appear here when they are retained by the service." : "Files not assigned to a current revision will appear here." : "Add the editable source or first export when you have one."}</span></div>}
    {expert && <details className="expert-detail file-manifest-detail"><summary>Show manifest details</summary><div className="manifest-grid"><span>Binding</span><strong>{bindingLabel}</strong><span>Scope</span><strong>{artifactScopeIdentity(scope, true)}</strong><span>Retention</span><strong>Older revision files remain auditable when the service records them.</strong><span>Preview</span><strong>Browser-safe text and image previews only.</strong></div></details>}
  </section>;
}
function ShoppingList({ project, summary, offers, expert, onToast, onBackToPlan }: { project: Project; summary: ReturnType<typeof calculateProjectSummary>; offers: typeof fixtureOffers; expert: boolean; onToast: (message: string) => void; onBackToPlan: () => void }) {
  const missing = shoppingEligibleLines(summary);
  const rows = missing.map((line) => {
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
  const draftList = rows.length ? rows.map(({ line, offers: lineOffers }) => {
    const selectedOffer = lineOffers.find((offer) => offer.preferred) ?? lineOffers[0];
    const unit = line.gap?.unit ?? line.line.unit;
    const required = line.gap?.requiredQuantity ?? line.line.required;
    return `${line.line.label}: ${formatQuantity(line.remaining || required, unit)}${selectedOffer ? ` · ${selectedOffer.supplier} · ${formatMoney(selectedOffer.priceMinor, selectedOffer.currency)}` : ""}`;
  }).join("\n") : "Nothing is ready to source.";
  const copyDraftList = async () => {
    if (!navigator.clipboard?.writeText) {
      onToast("Copy is unavailable in this browser. Select the list manually instead.");
      return;
    }
    try {
      await navigator.clipboard.writeText(draftList);
      onToast("Draft shopping list copied to the clipboard.");
    } catch {
      onToast("Copy was blocked by the browser. Select the list manually instead.");
    }
  };
  const emptyState = shoppingEmptyState(summary);
  return <section className="surface shopping-section"><div className="shopping-header"><div><span className="eyebrow">Shopping proposal</span><h2>Review required items</h2><p>Each price is a recorded observation. BenchLedger does not place orders.</p></div><div className="shopping-total" aria-label="Estimated total by currency"><span>Estimated total</span>{currencies.length ? <div className="shopping-total-values">{currencies.map((currency) => <span className="shopping-total-line" key={currency}><strong>{formatMoney(totalsByCurrency[currency] ?? 0, currency)}</strong><small>{currency}</small></span>)}</div> : <strong className="shopping-total-empty">No priced offers</strong>}<small>{rows.length} required Source line{rows.length === 1 ? "" : "s"}</small></div></div>{summary.readinessUnavailable ? <EmptyState icon="warning" title={emptyState.title} description={emptyState.description} action="Back to plan" onAction={onBackToPlan} /> : rows.length ? <div className="shopping-list">{rows.map(({ line, offers: lineOffers }) => { const unit = line.gap?.unit ?? line.line.unit; const required = line.gap?.requiredQuantity ?? line.line.required; return <div className="shopping-row" key={line.line.id}><div className="shopping-item"><span className="bom-state-mark mark-bad">!</span><div><strong>{line.line.label}</strong><span>{formatQuantity(line.remaining || required, unit)} required</span></div></div><div className="offer-stack">{lineOffers.length ? lineOffers.map((offer) => <a className={`offer-row ${offer.preferred ? "is-preferred" : ""}`} href={offer.url} target="_blank" rel="noreferrer" key={offer.id}><span className="offer-supplier">{offer.preferred && <Icon name="check-circle" size={14} />}{offer.supplier}</span><span className="offer-title">{offer.title}<small>{offer.pack} · price recorded {offer.observed}</small></span><strong>{formatMoney(offer.priceMinor, offer.currency)}</strong><span className="offer-eta">{offer.eta}</span><Icon name="external" size={14} /></a>) : <div className="offer-empty"><Icon name="info" size={15} /> No supplier offer is recorded.</div>}</div></div>; })}</div> : <EmptyState icon="check-circle" title={emptyState.title} description={emptyState.description} action="Back to plan" onAction={onBackToPlan} />}{expert && <details className="expert-detail offer-notes"><summary>Offer matching rules</summary><p>BenchLedger uses exact or confirmed-alternative candidates from canonical readiness. Check and Decide lines never enter this proposal. Each offer retains its supplier, source currency, package quantity, and observation date. An offer is never purchase authority.</p></details>}<div className="shopping-actions"><button className="button button-secondary" onClick={() => { void copyDraftList(); }} disabled={summary.readinessUnavailable}><Icon name="copy" size={16} /> Copy draft list</button></div></section>;
}

 function CapabilitiesPage({ expert, onCopy }: { expert: boolean; onCopy: (message: string) => void }) {
  const capabilityText = `BenchLedger workspace context\n\nUse list_inventory before recommending purchases.\nTreat Ready to use as counted or commissioned only.\nTreat Check quantity as inspect-first, never as available.\nFor a project, read the BOM, calculate gaps, then explain reuse, inspection, substitutes, and observed offers.\nNever purchase, publish, or overwrite a retained artifact without approval.`;
  const copyContext = async () => {
    try { await navigator.clipboard.writeText(capabilityText); onCopy("Agent context copied to your clipboard."); } catch { onCopy("Select the context block to copy it manually."); }
  };
  return <>
    <PageHeader eyebrow="Agent access" title="Agent workspace context" description="Read the same inventory and project evidence through the web interface, REST API, or MCP." action="Copy context" actionIcon="copy" onAction={copyContext} />
    <section className="agent-callout"><div className="agent-callout-icon"><Icon name="spark" size={21} /></div><div><strong>Read capabilities before using tools.</strong><p>Use inventory and project evidence to identify reuse, required checks, and missing parts.</p></div><span className="api-status"><span className="online-dot" /> MCP available</span></section>
    <div className="capabilities-layout"><section className="surface context-section"><SectionHeading eyebrow="Technical quickstart" title="Workspace rules" action="Copy" onAction={copyContext} /><pre className="context-block"><code>{capabilityText}</code></pre><div className="context-footer"><span><Icon name="info" size={15} /> Context is read before writes.</span><code>benchledger://capabilities</code></div></section><section className="surface capability-list-section"><SectionHeading eyebrow="Capability map" title="What agents can do" /><div className="capability-list">{capabilityGroups.map((group) => <details key={group.title} className="capability-group" open={expert}><summary><span><strong>{group.title}</strong><small>{group.description}</small></span><span className="capability-count">{group.tools.length} tools <Icon name="chevron-down" size={15} /></span></summary><div className="tool-list">{group.tools.map((tool) => <code key={tool}>{tool}</code>)}</div></details>)}</div></section></div>
    <section className="surface agent-prompts"><SectionHeading eyebrow="Example requests" title="Common tasks" /><div className="prompt-list"><Prompt text="Can I build this with what I have?" /><Prompt text="Prepare a sourced shopping list. Do not place an order." /><Prompt text="Which stock needs a physical count before I reserve it?" /><Prompt text="Read the latest project revision and list the changes." /></div></section>
  </>;
}

function Prompt({ text }: { text: string }) { return <button className="prompt-row" onClick={() => navigator.clipboard?.writeText(text)}><Icon name="spark" size={15} /><span>{text}</span><Icon name="copy" size={14} /></button>; }

function SettingsPage({ expert, sampleMode, connection, categories, categoriesLoading, categoriesError, onRetryCategories, onCreateCategory, onUpdateCategory, onArchiveCategory, hideLogout, onExpert, onLogout }: { expert: boolean; sampleMode: boolean; connection: ConnectionState; categories: readonly ManagedInventoryCategory[]; categoriesLoading: boolean; categoriesError?: string | undefined; onRetryCategories: () => void; onCreateCategory: (input: CategoryCreateInput) => Promise<ManagedInventoryCategory | undefined>; onUpdateCategory: (id: string, input: CategoryUpdateInput, expectedVersion: number) => Promise<ManagedInventoryCategory | undefined>; onArchiveCategory: (id: string, expectedVersion: number) => Promise<ManagedInventoryCategory | undefined>; hideLogout: boolean; onExpert: () => void; onLogout: () => void }) {
  const connected = connection === "ready";
  return <><PageHeader eyebrow="Workspace settings" title="Review workspace settings" description="Set the detail level and review connection information." /><div className="settings-layout"><section className="surface settings-section"><SectionHeading eyebrow="Display" title="Display detail" /><div className="setting-row"><div><strong>Detail level</strong><span>Beginner view shows task labels. Expert view also shows identifiers and technical evidence.</span></div><button className={`mode-toggle setting-control ${expert ? "is-expert" : ""}`} aria-pressed={expert} onClick={onExpert}><span className="mode-dot" />{expert ? "Expert details on" : "Beginner view on"}</button></div><div className="setting-row"><div><strong>Measurements</strong><span>Current display units are millimetres, grams, metres, and pieces. This value is not editable.</span></div><span className="setting-value">mm · g · m · each</span></div><div className="setting-row"><div><strong>Currency</strong><span>Each supplier price keeps its source currency and observation date. This value is not editable.</span></div><span className="setting-value">Source currency</span></div></section>{categoriesLoading && <div className="category-loading" role="status" aria-live="polite"><Icon name="refresh" size={16} /> Loading inventory categories…</div>}{categoriesError ? <section className="surface settings-section category-load-error" role="alert"><Icon name="warning" size={18} /><div><strong>Could not load inventory categories.</strong><span>{categoriesError}</span></div><button type="button" className="button button-secondary" onClick={onRetryCategories}>Try again</button></section> : !categoriesLoading ? <CategoryManager categories={categories} onCreate={onCreateCategory} onUpdate={onUpdateCategory} onArchive={onArchiveCategory} /> : null}<section className="surface settings-section"><SectionHeading eyebrow="Connection" title="Private API" /><div className="connection-panel"><div className="connection-panel-top"><span className="connection-icon"><Icon name="link" size={18} /></span><div><strong>{sampleMode ? "Sample workspace" : "Local workspace adapter"}</strong><span>{sampleMode ? "Synthetic data only" : "Connected to /api/v1"}</span></div><span className="connection-badge"><span className={`online-dot ${connected || sampleMode ? "" : "is-offline"}`} /> {sampleMode ? "Sample mode" : connected ? "Connected" : "Session error"}</span></div><p>{sampleMode ? "This workspace contains synthetic records. Changes remain in the sample workspace." : "The browser sends supported reads and writes to the authenticated private service. It reports failed writes."}</p></div><div className="setting-row setting-row-last"><div><strong>MCP endpoint</strong><span>Use a scoped token. Read the capability manifest before you use tools.</span></div><code className="setting-value">benchledger://capabilities</code></div>{!hideLogout && <button className="button button-quiet settings-logout" onClick={onLogout}><Icon name="arrow-left" size={16} /> {sampleMode ? "Close sample workspace" : "Sign out"}</button>}</section><section className="surface settings-section"><SectionHeading eyebrow="Evidence states" title="Inventory evidence rules" /><div className="evidence-legend"><Legend tone="good" title="Ready to use" text="A physical count or commissioning record confirms the stock." /><Legend tone="warn" title="Check quantity" text="Count delivered or uncertain stock before you reuse it." /><Legend tone="bad" title="Need to buy" text="Confirmed compatible stock does not cover the requirement." /></div></section></div></>;
}

function Legend({ tone, title, text }: { tone: StockLabelTone; title: string; text: string }) { return <div className="legend-row"><span className={`legend-mark mark-${tone}`}>{tone === "good" ? "✓" : tone === "warn" ? "?" : "!"}</span><div><strong>{title}</strong><span>{text}</span></div></div>; }

const focusableOverlaySelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1'])";

function useOverlayBehavior(containerRef: React.RefObject<HTMLElement | null>, onClose: () => void, active = true) {
  const closeRef = useRef(onClose);
  const activeRef = useRef(active);
  closeRef.current = onClose;
  activeRef.current = active;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const container = containerRef.current;
    const focusFirstControl = () => {
      const first = container?.querySelector<HTMLElement>("[data-autofocus]")
        ?? container?.querySelector<HTMLElement>("form input:not([disabled]), form textarea:not([disabled]), form select:not([disabled])")
        ?? container?.querySelector<HTMLElement>(focusableOverlaySelector);
      first?.focus();
    };
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
          previousFocus.focus();
          restoreAttempts += 1;
          if (document.activeElement !== previousFocus && restoreAttempts < 3) window.setTimeout(restoreFocus, 16);
        };
        window.setTimeout(restoreFocus, 0);
      }
    };
  }, [containerRef]);
}

export function InventoryDrawer({ item, items = [item], categories, categoriesLoading, categoriesError, expert, onClose, onCount, onCommission, onUpdate, onCreateReplacement }: { item: InventoryItem; items?: readonly InventoryItem[]; categories: readonly ManagedInventoryCategory[]; categoriesLoading: boolean; categoriesError?: string | undefined; expert: boolean; onClose: () => void; onCount: (id: string, quantity: number) => Promise<InventoryItem>; onCommission: (id: string, input: InventoryCommissionInput, expectedVersion: number) => Promise<InventoryItem>; onUpdate: (id: string, input: Partial<InventoryUpdateInput>, expectedVersion?: number) => Promise<InventoryItem>; onCreateReplacement?: (item: InventoryItem) => void }) {
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

  return <>
    <div className="drawer-scrim" aria-hidden="true" onClick={onClose} />
    <aside ref={drawerRef} className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby={drawerTitleId} aria-hidden={mutationReview ? true : undefined} inert={mutationReview ? true : undefined} tabIndex={-1}>
      <div className="drawer-header"><span className={`item-glyph accent-${item.accent}`} aria-hidden="true"><Icon name={categoryIcons[item.category]} size={18} /></span><div><span className="eyebrow">{managedInventoryLabel(categories, item, expert)}</span><h2 id={drawerTitleId}>{itemIdentity}</h2></div><button type="button" className="icon-button" aria-label="Close item details" onClick={onClose}><Icon name="close" size={20} /></button></div>
      <div className="drawer-body">
        <div className="drawer-title-actions"><StatusPill state={displayedInventoryState(item)} />{!editing && <button type="button" className="button button-secondary" onClick={() => setEditing(true)}>Edit item</button>}</div>
        {item.unitStatus === "needs_correction" && <section className="unit-correction-callout" role="alert"><strong>This record cannot be used yet</strong><span>{item.unitCorrectionReason ?? "Its item type and unit do not form a safe inventory record."} The original stays blocked as history; create a corrected replacement with a compatible unit, then physically count it before use.</span>{onCreateReplacement && <button type="button" className="button button-secondary" onClick={() => onCreateReplacement(item)}>Create corrected replacement</button>}{expert && <small>Recorded unit: <code>{item.unit}</code>. Historical quantities and evidence are not rewritten.</small>}</section>}
        {editing ? <form className="inventory-edit-form" onSubmit={(event) => { void submitEdit(event); }} aria-busy={editSaving}>
          <p className="drawer-section-copy">Edit item identification and storage fields. Change quantity with a physical count.</p>
          <label className="form-field"><span>Name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} disabled={editSaving} /></label>
          <label className="form-field"><span>Description</span><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} disabled={editSaving} /></label>
          <div className="inventory-edit-grid">
            <label className="form-field"><span>Model or variant</span><input value={model} onChange={(event) => setModel(event.target.value)} disabled={editSaving} /></label>
            <label className="form-field"><span>Manufacturer</span><input value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} disabled={editSaving} /></label>
            <label className="form-field"><span>SKU</span><input value={sku} onChange={(event) => setSku(event.target.value)} disabled={editSaving} /></label>
            <label className="form-field"><span>Location</span><input value={location} onChange={(event) => setLocation(event.target.value)} disabled={editSaving} /></label>
          </div>
          <label className="form-field"><span>Tags</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Separate tags with commas" disabled={editSaving} /></label>
          {categoriesError ? <p className="field-hint category-edit-note" role="alert">Managed categories are unavailable: {categoriesError}</p> : categoriesLoading ? <p className="field-hint category-edit-note" role="status">Loading active categories…</p> : <CategorySelection categories={categories} value={categoryNodeId} onChange={setCategoryNodeId} required={Boolean(item.categoryNodeId)} ariaInvalid={Boolean(item.categoryNodeId && !managedCategoryForId(categories, item.categoryNodeId))} />}
          {editError && <p className="form-error" role="alert">{editError}</p>}
          <div className="drawer-form-actions"><button type="button" className="button button-quiet" onClick={cancelEdit} disabled={editSaving}>Cancel</button><button type="submit" className="button button-primary" disabled={!name.trim() || editSaving}>{editSaving ? "Saving…" : "Save changes"}</button></div>
        </form> : <>
          <p className="drawer-description">{item.description}</p>
          {(item.category === "Filament" || item.category === "Printers") && <div className="exact-product-callout"><strong>{exactProductLabel(item)}</strong><span>{item.productProfile?.linkState === "confirmed" ? "Use this link for exact setup matching." : "Check the physical item before you link an exact product."}</span></div>}
          <div className="drawer-facts"><div><span>Item type</span><strong>{item.kind ?? "Not recorded"}</strong></div>{item.variant ? <div><span>Model or variant</span><strong>{item.variant}</strong></div> : <div><span>Model or variant</span><strong>Model not recorded</strong></div>}<div><span>Location</span><strong>{item.location}</strong></div>{item.manufacturer && <div><span>Manufacturer</span><strong>{item.manufacturer}</strong></div>}{item.sku && <div><span>SKU</span><code>{item.sku}</code></div>}{item.productProfile?.filament?.lotBatch && <div><span>Lot or batch</span><strong>{item.productProfile.filament.lotBatch}</strong></div>}{item.productProfile?.printer?.assetLabel && <div><span>Asset label</span><strong>{item.productProfile.printer.assetLabel}</strong></div>}</div>
        </>}

        {expert && unverifiedQuantity && <section className="drawer-quantity" aria-labelledby="commission-heading"><div><span className="eyebrow" id="commission-heading">Expert stock evidence</span><strong>Commission received stock</strong><span>Record a physical observation while retaining the delivery evidence.</span><p>Use this only when you need an explicit source and observation time in the audit trail.</p></div><form className="count-form" onSubmit={(event) => reviewCommission(event)}><label htmlFor="commission-quantity">Observed quantity</label><div><input id="commission-quantity" type="number" min="0" step="any" inputMode="decimal" value={commissionQuantity} onChange={(event) => setCommissionQuantity(event.target.value)} disabled={commissionSaving} /><span>{item.unit}</span></div><label className="form-field"><span>Source</span><input required value={commissionSource} maxLength={500} placeholder="Physical check, delivery record, or project log" onChange={(event) => setCommissionSource(event.target.value)} disabled={commissionSaving} /></label><label className="form-field"><span>Observed</span><input required type="datetime-local" value={commissionObservedAt} onChange={(event) => setCommissionObservedAt(event.target.value)} disabled={commissionSaving} /></label><label className="form-field"><span>Source ID <small>(optional)</small></span><input value={commissionSourceId} maxLength={500} placeholder="Evidence reference" onChange={(event) => setCommissionSourceId(event.target.value)} disabled={commissionSaving} /></label><label className="form-field"><span>Note <small>(optional)</small></span><textarea rows={2} maxLength={1000} value={commissionNote} placeholder="What did you observe?" onChange={(event) => setCommissionNote(event.target.value)} disabled={commissionSaving} /></label><button type="submit" className="button button-secondary" disabled={commissionSaving}>{commissionSaving ? "Saving…" : "Review commissioning"}</button>{commissionError && <p className="form-error" role="alert">{commissionError}</p>}{commissionSaved && <p className="form-success" role="status">{commissionSaved}</p>}</form></section>}

        <section className="drawer-quantity" aria-labelledby="physical-count-heading"><div><span className="eyebrow">Stock check</span><strong id="physical-count-heading">Confirm physical count</strong><span>{item.reserved ? `${formatQuantity(item.reserved, item.unit)} reserved; ${formatQuantity(availableForReuse, item.unit)} currently available for reuse.` : `Recorded quantity: ${formatQuantity(item.quantity, item.unit)}.`}</span><p>Count what is physically in front of you, then enter that quantity here.</p></div><form className="count-form" onSubmit={(event) => reviewCount(event)}><label htmlFor="count-quantity">Counted quantity</label><div><input id="count-quantity" type="number" min="0" step="any" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={countSaving} /><span>{item.unit}</span></div><button type="submit" className="button button-secondary" disabled={countSaving}>{countSaving ? "Saving…" : "Review physical count"}</button>{countError && <p className="form-error" role="alert">{countError}</p>}{countSaved && <p className="form-success" role="status">{countSaved}</p>}</form></section>

        {expert && <section className="provenance-panel" aria-labelledby="provenance-heading"><div><span className="eyebrow" id="provenance-heading">Provenance</span><strong>{evidenceLabel(item.evidence, item.serverEvidence)}</strong></div><dl><div><dt>Source</dt><dd>{item.provenance?.source ?? "Not recorded"}</dd></div><div><dt>Observed</dt><dd>{item.provenance?.observedAt ? item.provenance.observedAt.slice(0, 10) : "Not recorded"}</dd></div>{item.provenance?.sourceId && <div><dt>Source record</dt><dd><code>{item.provenance.sourceId}</code></dd></div>}{item.provenance?.note && <div><dt>Note</dt><dd>{item.provenance.note}</dd></div>}</dl></section>}

        {expert && <details className="expert-detail" open><summary>Technical evidence</summary><div className="detail-grid"><div><span>Item ID</span><div className="expert-value"><code>{item.id}</code><CopyValueButton value={item.id} /></div></div><div><span>Item kind</span><code>{item.kind ?? "Not recorded"}</code></div><div><span>Category node</span><code>{item.categoryNodeId ?? "Not assigned"}</code></div><div><span>Evidence state</span><code>{item.evidence}</code></div><div><span>Exact link state</span><code>{item.productProfile?.linkState ?? "not linked"}</code></div><div><span>Catalog product</span><code>{item.catalogProduct?.id ?? "Not recorded"}</code></div><div><span>Version</span><code>{item.version ?? "Not recorded"}</code></div><div><span>Dimensions</span><code>{item.dimensions ? formatDimensions(item.dimensions) : "Not recorded"}</code></div><div><span>Tags</span><code>{item.tags.join(" · ") || "None"}</code></div></div><div className="compatibility-box"><span>Compatibility notes</span>{item.compatibility.length ? <ul>{item.compatibility.map((note) => <li key={note}>{note}</li>)}</ul> : <p>No compatibility evidence is recorded.</p>}</div></details>}
      </div>
    </aside>
    {mutationReview && <InventoryMutationReviewDialog item={item} review={mutationReview} saving={mutationReview.kind === "count" ? countSaving : commissionSaving} onClose={() => { if (!countSaving && !commissionSaving) setMutationReview(undefined); }} onConfirm={() => { void (mutationReview.kind === "count" ? submitCount() : submitCommission()); }} />}
  </>;
}

function InventoryMutationReviewDialog({ item, review, saving, onClose, onConfirm }: { item: InventoryItem; review: InventoryMutationReview; saving: boolean; onClose: () => void; onConfirm: () => void }) {
  const isCount = review.kind === "count";
  const newQuantity = isCount ? review.quantity : review.input.quantity;
  const oldEvidence = evidenceLabel(item.evidence, item.serverEvidence);
  const newEvidence = isCount ? "Physically counted" : "Commissioned";
  const effect = isCount
    ? "Records this physical count and updates the quantity available for reuse."
    : "Marks the received stock as commissioned and makes the observed quantity available for reuse; delivery evidence remains retained.";
  return <Dialog title={isCount ? "Review physical count" : "Review stock commissioning"} role="alertdialog" onClose={onClose}>
    <p className="dialog-intro">Check the recorded change before saving it to inventory.</p>
    <div className="inventory-selection-summary">
      <span><strong>Item</strong>{item.name}<small>{item.variant}</small></span>
      <span><strong>Old value</strong>{formatQuantity(item.quantity, item.unit)}<small>{oldEvidence}</small></span>
      <span><strong>New value</strong>{formatQuantity(newQuantity, item.unit)}<small>{newEvidence}</small></span>
      <span><strong>Effect</strong>{effect}</span>
      {!isCount && <span><strong>Observation</strong>{review.input.source} · {review.input.observedAt}</span>}
    </div>
    <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={saving}>Back to item</button><button type="button" className="button button-primary" onClick={onConfirm} disabled={saving} aria-busy={saving}>{saving ? "Saving…" : isCount ? "Confirm physical count" : "Commission stock"}<Icon name="check" size={16} /></button></div>
  </Dialog>;
}

function NewProjectDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (input: Pick<Project, "name" | "description">) => Promise<ProjectCreateOutcome> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setFormError(undefined);
    try {
      const outcome = await onCreate({ name: name.trim(), description: description.trim() || "Project goal not recorded." });
      if (outcome === "failed") setFormError("The project was not created. Check the service connection and try again.");
      if (outcome === "ambiguous") setFormError(ambiguousProjectCreationMessage);
    } catch (error: unknown) {
      setFormError(normalizeApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  };
  return <Dialog title="Create project" onClose={onClose}><form onSubmit={(event) => { void submit(event); }}><p className="dialog-intro">Enter a project name and goal. You can add parts and files after you create the project.</p><label className="form-field"><span>Project name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Desk sensor enclosure" disabled={submitting} /></label><label className="form-field"><span>Project goal</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder="Describe the required result" disabled={submitting} /></label>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}>Cancel</button><button type="submit" className="button button-primary" disabled={!name.trim() || submitting} aria-busy={submitting}>{submitting ? "Creating…" : "Create project"} {!submitting && <Icon name="arrow-right" size={16} />}</button></div></form></Dialog>;
}

function NewRevisionDialog({ project, items, expert, onClose, onCreate }: { project: Project; items: InventoryItem[]; expert: boolean; onClose: () => void; onCreate: (input: RevisionInput) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [status, setStatus] = useState("concept");
  const [notes, setNotes] = useState("");
  const [printer, setPrinter] = useState<InventoryItem>();
  const [filament, setFilament] = useState<InventoryItem>();
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
  const [formError, setFormError] = useState<string>();
  const printerEligibility = printer ? buildItemEligibility(printer, "Printers") : { eligible: false, reason: "Choose an exact owned printer before saving build setup." };
  const filamentEligibility = filament ? buildItemEligibility(filament, "Filament") : { eligible: true };
  const setupBlockers = [
    ...(printerEligibility.eligible ? [] : [printerEligibility.reason ?? "Choose an exact owned printer before saving build setup."]),
    ...(filamentEligibility.eligible ? [] : [filamentEligibility.reason ?? "Choose physical filament with confirmed evidence before saving build setup."])
  ];
  const buildConfig: BuildConfigInput = {
    ...(printer ? { printerItemId: printer.id, ...(printer.productProfile?.id ? { printerProfileId: printer.productProfile.id } : {}), ...(printer.catalogProduct ? { printerProductId: printer.catalogProduct.id } : {}) } : {}),
    ...(filament ? { filamentItemId: filament.id, ...(filament.productProfile?.id ? { filamentProfileId: filament.productProfile.id } : {}), ...(filament.catalogProduct ? { filamentProductId: filament.catalogProduct.id } : {}), filamentSelections: [buildFilamentSelection(filament)] } : {}),
    ...(hotendSide.trim() ? { hotendSide: hotendSide.trim() } : {}),
    ...(Number.isFinite(Number(nozzleDiameter)) && Number(nozzleDiameter) > 0 ? { nozzleDiameterMm: Number(nozzleDiameter) } : {}),
    ...(nozzleMaterial.trim() ? { nozzleMaterial: nozzleMaterial.trim() } : {}),
    ...(buildPlate.trim() ? { buildPlate: buildPlate.trim() } : {}),
    accessories: splitSetupValues(accessories),
    ...(firmware.trim() ? { firmware: firmware.trim() } : {}),
    ...(slicer.trim() ? { slicer: slicer.trim() } : {}),
    ...(slicerVersion.trim() ? { slicerVersion: slicerVersion.trim() } : {}),
    ...(profile.trim() ? { profile: profile.trim() } : {}),
    ...(calibration.trim() ? { calibration: calibration.trim() } : {}),
    unknowns: splitSetupValues(unknowns)
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setFormError(undefined);
    if (setupBlockers.length > 0) {
      setFormError(setupBlockers.join(" "));
      setSubmitting(false);
      return;
    }
    try {
      const created = await onCreate({ name: name.trim(), status, buildConfig, ...(notes.trim() ? { notes: notes.trim() } : {}) });
      if (!created) setFormError("The revision was not created. Check the service connection and try again.");
    } catch (error: unknown) {
      setFormError(normalizeApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  };
  return <Dialog title={`New revision for ${project.name}`} onClose={onClose}><form onSubmit={(event) => { void submit(event); }}><p className="dialog-intro">A revision preserves the previous evidence. Choose the owned printer and filament for this build; the setup is saved as an immutable snapshot after the revision is created.</p><label className="form-field"><span>Revision name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. R02 enclosure fit" disabled={submitting} /></label><label className="form-field"><span>Starting state</span><select value={status} onChange={(event) => setStatus(event.target.value)} disabled={submitting}><option value="concept">Concept</option><option value="CAD complete">CAD complete</option><option value="DFAM reviewed">DFAM reviewed</option></select></label><div className="setup-picker-grid"><OwnedItemCombobox category="Printers" items={items} value={printer} onSelect={setPrinter} label="Owned printer" /><OwnedItemCombobox category="Filament" items={items} value={filament} onSelect={setFilament} label="Owned filament" /></div>{setupBlockers.length > 0 && <div className="setup-blockers setup-dialog-blockers" role="alert"><strong>Build setup blocked</strong>{setupBlockers.map((blocker) => <span key={blocker}>{blocker}</span>)}</div>}<BuildSetupSummary input={buildConfig} printer={printer} filament={filament} expert={expert} /><details className="advanced-setup" open={expert}><summary>Build details</summary><div className="advanced-setup-grid"><label className="form-field"><span>Hotend side</span><input value={hotendSide} onChange={(event) => setHotendSide(event.target.value)} placeholder="Single nozzle / left / right" disabled={submitting} /></label><label className="form-field"><span>Nozzle diameter (mm)</span><input type="number" min="0.1" step="0.01" value={nozzleDiameter} onChange={(event) => setNozzleDiameter(event.target.value)} placeholder="0.4" disabled={submitting} /></label><label className="form-field"><span>Nozzle material</span><input value={nozzleMaterial} onChange={(event) => setNozzleMaterial(event.target.value)} placeholder="Hardened steel" disabled={submitting} /></label><label className="form-field"><span>Build plate</span><input value={buildPlate} onChange={(event) => setBuildPlate(event.target.value)} placeholder="Textured PEI" disabled={submitting} /></label><label className="form-field"><span>Accessories</span><input value={accessories} onChange={(event) => setAccessories(event.target.value)} placeholder="AMS 2 Pro, dryer" disabled={submitting} /></label><label className="form-field"><span>Firmware</span><input value={firmware} onChange={(event) => setFirmware(event.target.value)} placeholder="Version or not recorded" disabled={submitting} /></label><label className="form-field"><span>Slicer</span><input value={slicer} onChange={(event) => setSlicer(event.target.value)} placeholder="Bambu Studio / Cura" disabled={submitting} /></label><label className="form-field"><span>Slicer version</span><input value={slicerVersion} onChange={(event) => setSlicerVersion(event.target.value)} placeholder="e.g. 1.10.0" disabled={submitting} /></label><label className="form-field"><span>Profile</span><input value={profile} onChange={(event) => setProfile(event.target.value)} placeholder="0.20 mm Standard" disabled={submitting} /></label><label className="form-field"><span>Calibration state</span><input value={calibration} onChange={(event) => setCalibration(event.target.value)} placeholder="Flow / first layer / date" disabled={submitting} /></label><label className="form-field advanced-unknowns"><span>Explicit unknowns</span><textarea value={unknowns} onChange={(event) => setUnknowns(event.target.value)} rows={2} placeholder="One unknown per line" disabled={submitting} /></label></div></details><label className="form-field"><span>Notes <small>(optional)</small></span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} placeholder="What changed or what should be checked?" disabled={submitting} /></label>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}>Cancel</button><button type="submit" className="button button-primary" disabled={!name.trim() || submitting || setupBlockers.length > 0} aria-busy={submitting}>{submitting ? "Creating…" : "Create revision & save setup"} {!submitting && <Icon name="arrow-right" size={16} />}</button></div></form></Dialog>;
}

const bomUnitOptions: readonly { value: BomInput["unit"]; label: string }[] = [
  { value: "each", label: "pieces" },
  { value: "g", label: "grams" },
  { value: "m", label: "metres" },
  { value: "millimetre", label: "millimetres" },
  { value: "millilitre", label: "millilitres" },
  { value: "set", label: "sets" }
];

function AddBomDialog({ items, project, onClose, onCreate }: { items: InventoryItem[]; project: Project; onClose: () => void; onCreate: (input: BomInput) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState<BomInput["unit"]>("each");
  const [itemId, setItemId] = useState("");
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
      const created = await onCreate({ name: name.trim(), requiredQuantity, unit, ...(itemId ? { itemId } : {}), ...(optional ? { optional: true } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      if (!created) setFormError("The requirement was not added. Check the service connection and try again.");
    } catch (error: unknown) {
      setFormError(normalizeApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const filteredItems = items.filter((item) => {
    const needle = itemSearch.trim().toLocaleLowerCase();
    return !needle || [item.name, item.variant, item.location, item.manufacturer, item.sku, inventoryDiscriminator(item)].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle);
  });
  const selectedItem = items.find((item) => item.id === itemId);
  return <Dialog title={`Add a requirement to ${project.currentRevision}`} onClose={onClose}><form onSubmit={(event) => { void submit(event); }}><p className="dialog-intro">Describe one physical or digital requirement. Matching stock is evaluated from the recorded variant and evidence state.</p><label className="form-field"><span>Requirement name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. ESP32 development board" disabled={submitting} /></label><div className="form-row"><label className="form-field"><span>Quantity</span><input type="number" min="0.01" step="any" required value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={submitting} /></label><label className="form-field"><span>Unit</span><select value={unit} onChange={(event) => setUnit(event.target.value as BomInput["unit"])} disabled={submitting}>{bomUnitOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div><div className="form-field matching-stock-field"><span>Known matching stock <small>(optional)</small></span><input aria-label="Search matching inventory" value={itemSearch} onChange={(event) => setItemSearch(event.target.value)} placeholder="Search name, colour, location, or SKU" disabled={submitting} /><select aria-label="Choose matching inventory" value={itemId} onChange={(event) => setItemId(event.target.value)} disabled={submitting}><option value="">Let BenchLedger match it</option>{filteredItems.map((item) => <option key={item.id} value={item.id}>{inventoryCandidateText(item, items)}</option>)}</select>{selectedItem && <small className="matching-stock-hint">Selected: {inventoryCandidateText(selectedItem, items)}</small>}</div><label className="form-field"><span>Requirement note <small>(optional)</small></span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="Fit, material, or compatibility detail" disabled={submitting} /></label><label className="check-field"><input type="checkbox" checked={optional} onChange={(event) => setOptional(event.target.checked)} disabled={submitting} /><span>Mark as optional</span></label>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}>Cancel</button><button type="submit" className="button button-primary" disabled={!name.trim() || submitting} aria-busy={submitting}>{submitting ? "Adding…" : "Add requirement"} {!submitting && <Icon name="arrow-right" size={16} />}</button></div></form></Dialog>;
}

type InventoryItemType = "printer" | "filament" | "tool" | "accessory" | "consumable" | "electronic" | "fastener" | "wire" | "adhesive" | "other";
const itemTypeOptions: readonly { value: InventoryItemType; label: string }[] = [
  { value: "printer", label: "Printer" }, { value: "filament", label: "Filament" }, { value: "tool", label: "Tool" }, { value: "accessory", label: "Accessory" }, { value: "consumable", label: "Consumable" }, { value: "electronic", label: "Electronic" }, { value: "fastener", label: "Fastener" }, { value: "wire", label: "Wire & cable" }, { value: "adhesive", label: "Adhesive" }, { value: "other", label: "Other" }
];

function displayInventoryUnit(unit: ReturnType<typeof defaultUnitForItemKind>): InventoryItem["unit"] {
  if (unit === "gram") return "g";
  if (unit === "metre") return "m";
  return unit;
}

const inventoryUnitLabels: Readonly<Record<InventoryItem["unit"], string>> = {
  each: "pieces", g: "grams", m: "metres", set: "sets", millimetre: "millimetres", millilitre: "millilitres"
};

type InventoryMutationReview =
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

function NewInventoryDialog({ replacementFor, categories, categoriesLoading, categoriesError, catalogQuery, catalogProducts, onCatalogQuery, onSearchCatalog, onSearchCatalogPage, onCreateCatalogProduct, onCreateExact, onClose, onGoSettings, onCreate }: { replacementFor?: InventoryItem | undefined; categories: readonly ManagedInventoryCategory[]; categoriesLoading: boolean; categoriesError?: string | undefined; catalogQuery: string; catalogProducts: CatalogProduct[]; onCatalogQuery: (query: string) => void; onSearchCatalog: (kind: "filament" | "printer", query: string, options?: CatalogSearchOptions) => Promise<CatalogProduct[]>; onSearchCatalogPage: (kind: "filament" | "printer", query: string, options?: CatalogSearchOptions) => Promise<CatalogProductPage>; onCreateCatalogProduct: (input: CatalogProductDraft) => Promise<CatalogProduct | undefined>; onCreateExact: (input: ExactInventoryInput) => Promise<boolean>; onClose: () => void; onGoSettings: () => void; onCreate: (input: { name: string; category: InventoryCategory; categoryNodeId: string; kind: string; quantity: number; unit: InventoryItem["unit"] }) => Promise<boolean> }) {
  const replacementType = replacementFor?.kind as InventoryItemType | undefined;
  const [itemType, setItemType] = useState<InventoryItemType | undefined>(replacementType);
  const [categoryNodeId, setCategoryNodeId] = useState(replacementFor?.categoryNodeId ?? "");
  const [selectionConfirmed, setSelectionConfirmed] = useState(Boolean(replacementType && replacementFor?.categoryNodeId));
  const [name, setName] = useState(replacementFor ? `${replacementFor.name} (corrected)` : "");
  const [quantity, setQuantity] = useState(replacementFor ? String(replacementFor.quantity) : "1");
  const [unit, setUnit] = useState<InventoryItem["unit"]>(replacementType ? displayInventoryUnit(defaultUnitForItemKind(replacementType)) : "each");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const categoryHintId = useId();
  const selectedCategory = managedCategoryForId(categories, categoryNodeId);
  const setType = (next: InventoryItemType) => { setItemType(next); setSelectionConfirmed(false); setFormError(undefined); setName(""); setQuantity("1"); setUnit(displayInventoryUnit(defaultUnitForItemKind(next))); const suggested = categories.find((category) => !category.archived && !category.parentId && category.name.toLocaleLowerCase() === displayCategoryForKind(next).toLocaleLowerCase()); setCategoryNodeId(suggested?.id ?? ""); };
  const resetSelection = () => { setItemType(undefined); setCategoryNodeId(""); setSelectionConfirmed(false); setFormError(undefined); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!itemType || !categoryNodeId || !name.trim() || submitting) return;
    setSubmitting(true);
    setFormError(undefined);
    try {
      const created = await onCreate({ name: name.trim(), category: displayCategoryForKind(itemType), categoryNodeId, kind: itemType, quantity: Math.max(Number(quantity) || 0, 0), unit });
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
    const categoriesUnavailable = Boolean(categoriesError) || (!categoriesLoading && activeCategoryCount === 0);
    return <Dialog title="Add to inventory" onClose={onClose}><form className="inventory-start-form" onSubmit={(event) => { event.preventDefault(); }}><p className="dialog-intro">Choose the item type. BenchLedger suggests the matching managed category and compatible unit; you can adjust the category before continuing.</p><label className="form-field"><span>Item type <small>(required)</small></span><select autoFocus required value={itemType ?? ""} onChange={chooseItemType}><option value="">Choose an item type</option>{itemTypeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><CategorySelection categories={categories} value={categoryNodeId} onChange={(id) => { setCategoryNodeId(id); setSelectionConfirmed(false); }} disabled={categoriesLoading || categoriesUnavailable} ariaInvalid={categoriesUnavailable || (selectionConfirmed && !categoryNodeId)} ariaDescribedBy={categoryHintId} /><p id={categoryHintId} className="field-hint">{categoriesLoading ? "Refreshing active categories…" : categoriesError ? categoriesError : activeCategoryCount === 0 ? "No active categories are available. Add one in Settings before creating inventory." : itemType && categoryNodeId ? `Suggested category: ${selectedCategory?.name ?? displayCategoryForKind(itemType)}.` : "Choose an active category or subcategory."}</p>{categoriesUnavailable && <div className="category-unavailable" role="alert"><span>{categoriesError ? "Inventory categories could not be loaded." : "Inventory needs one active managed category before a new item can be added."}</span><button type="button" className="text-button" onClick={onGoSettings}>Open Settings <Icon name="arrow-right" size={15} /></button></div>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button type="button" className="button button-primary" disabled={!itemType || !categoryNodeId || categoriesUnavailable} onClick={() => setSelectionConfirmed(true)}>Continue <Icon name="arrow-right" size={16} /></button></div></form></Dialog>;
  }
  const availableCategory = selectedCategory!;
  if (exactCategory) return <Dialog title={`Add ${exactCategory === "Filament" ? "filament" : "a printer"}`} onClose={onClose}><div className="inventory-selection-summary"><span><strong>Item type</strong>{itemTypeOptions.find((option) => option.value === itemType)?.label}</span><span><strong>Category</strong>{availableCategory.name}</span><button type="button" className="text-button" onClick={resetSelection}>Change selection</button></div><CatalogInventoryFlow category={exactCategory} products={catalogProducts.filter((product) => product.kind === (exactCategory === "Filament" ? "filament" : "printer"))} query={catalogQuery} onQueryChange={onCatalogQuery} onSearch={onSearchCatalog} onSearchPage={onSearchCatalogPage} onCreateProduct={onCreateCatalogProduct} onCreate={(input) => onCreateExact({ ...input, categoryNodeId })} onBack={resetSelection} /></Dialog>;
  const compatibleUnits = validUnitsForItemKind(itemType).map(displayInventoryUnit);
  return <Dialog title={replacementFor ? "Create corrected replacement" : "Add an inventory item"} onClose={onClose}><form onSubmit={(event) => { void submit(event); }}><button type="button" className="text-button category-back" onClick={resetSelection} disabled={submitting}><Icon name="arrow-left" size={15} /> Choose another type or category</button><div className="inventory-selection-summary"><span><strong>Item type</strong>{itemTypeOptions.find((option) => option.value === itemType)?.label}</span><span><strong>Category</strong>{availableCategory.name}</span></div>{replacementFor && <p className="unit-replacement-note">The old record remains blocked as history. This replacement starts with a compatible unit and must be physically counted before it can supply a project.</p>}<p className="dialog-intro">This records what you received, but it starts as <strong>Check quantity</strong> until you physically count it. The entered quantity is not treated as available stock.</p><label className="form-field"><span>Name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. JST-PH 2-pin leads" disabled={submitting} /></label><div className="form-row"><label className="form-field"><span>Quantity received</span><input type="number" min="0" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={submitting} /></label><label className="form-field"><span>Unit</span><select value={unit} onChange={(event) => setUnit(event.target.value as InventoryItem["unit"])} disabled={submitting}>{compatibleUnits.map((option) => <option key={option} value={option}>{inventoryUnitLabels[option]}</option>)}</select></label></div>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}>Cancel</button><button type="submit" className="button button-primary" disabled={!name.trim() || submitting} aria-busy={submitting}>{submitting ? "Adding…" : replacementFor ? "Create replacement" : "Add item"} {!submitting && <Icon name="plus" size={16} />}</button></div></form></Dialog>;
}

function Dialog({ title, role = "dialog", onClose, children }: { title: string; role?: "dialog" | "alertdialog"; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  useOverlayBehavior(dialogRef, onClose);
  return <><div className="dialog-scrim" aria-hidden="true" onClick={onClose} /><section ref={dialogRef} className="dialog" role={role} aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><div className="dialog-header"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={19} /></button></div>{children}</section></>;
}

function EmptyState({ icon, title, description, action, onAction }: { icon: Parameters<typeof Icon>[0]["name"]; title: string; description: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={23} /></span><h2>{title}</h2><p>{description}</p>{action && <button className="button button-secondary" onClick={onAction}>{action}<Icon name="arrow-right" size={15} /></button>}</div>;
}

function formatDimensions(dimensions: NonNullable<InventoryItem["dimensions"]>): string {
  if (dimensions.diameter) return `Ø${dimensions.diameter} ${dimensions.unit}`;
  return [dimensions.length, dimensions.width, dimensions.height].filter((value) => value !== undefined).join(" × ") + ` ${dimensions.unit}`;
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
