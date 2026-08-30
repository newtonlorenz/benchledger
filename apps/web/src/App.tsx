import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import type * as React from "react";
import { ApiError, createSampleWorkspaceAdapter, createWorkspaceAdapter } from "./api";
import type { WorkspaceAdapter } from "./api";
import type { BomInput, CatalogProductDraft, ExactInventoryInput, RevisionInput } from "./api";
import { CatalogInventoryFlow, BuildSetupSummary, OwnedItemCombobox, splitSetupValues } from "./catalog-ui";
import type { BuildConfigInput, CatalogProduct } from "./domain";
import {
  calculateProjectSummary,
  countByState,
  filterInventory,
  formatMoney,
  formatQuantity,
  getLineLabel,
  getStockLabel,
  exactProductLabel,
  railSteps,
  sumMoneyByCurrency
} from "./domain";
import type { BomLineStatus, InventoryCategory, InventoryItem, Project, StockLabelTone, StockState } from "./domain";
import { activity, capabilityGroups, categoryOptions, offers as fixtureOffers } from "./mock-data";
import { Icon } from "./icons";
import { ReconciliationUI } from "./reconciliation-ui";
import type { ReconciliationViewModel } from "./reconciliation-ui";

type Page = "overview" | "inventory" | "projects" | "capabilities" | "settings";
type ProjectTab = "plan" | "files" | "offers" | "reconciliation";
type ConnectionState = "loading" | "ready" | "sample" | "unauthenticated" | "offline" | "error";
type PendingRevisionSetup = { readonly projectId: string; readonly revisionId: string; readonly input: BuildConfigInput };

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
const addableCategories: readonly InventoryCategory[] = categoryOptions.slice(1) as readonly InventoryCategory[];

function App() {
  const [adapter, setAdapter] = useState<WorkspaceAdapter>(() => createWorkspaceAdapter());
  const [page, setPage] = useState<Page>("overview");
  const [projects, setProjects] = useState<Project[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [offers, setOffers] = useState(fixtureOffers);
  const [selectedProjectId, setSelectedProjectId] = useState("project-lamp");
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [projectTab, setProjectTab] = useState<ProjectTab>("plan");
  const [search, setSearch] = useState("");
  const [expert, setExpert] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [connectionError, setConnectionError] = useState<ApiError>();
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [sampleMode, setSampleMode] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewRevision, setShowNewRevision] = useState(false);
  const [showAddBom, setShowAddBom] = useState(false);
  const [showNewItem, setShowNewItem] = useState(false);
  const [pendingRevisionSetup, setPendingRevisionSetup] = useState<PendingRevisionSetup>();
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogProducts, setCatalogProducts] = useState<CatalogProduct[]>([]);
  const catalogSearchSequence = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setConnection("loading");
    adapter.loadWorkspace().then((snapshot) => {
      if (!active) return;
      setItems(snapshot.inventory);
      setProjects(snapshot.projects);
      setOffers(snapshot.offers);
      setSelectedProjectId(snapshot.projects[0]?.id ?? "");
      setSampleMode(snapshot.source === "synthetic");
      setDemoAvailable(Boolean(snapshot.health?.demo));
      setConnection(snapshot.source === "synthetic" ? "sample" : "ready");
      setConnectionError(undefined);
      setLoading(false);
    }).catch((error: unknown) => {
      if (!active) return;
      const normalized = normalizeApiError(error);
      setConnectionError(normalized);
      setDemoAvailable(Boolean(normalized.demo));
      setConnection(normalized.kind === "unauthenticated" ? "unauthenticated" : normalized.kind === "offline" ? "offline" : "error");
      setLoading(false);
    });
    return () => { active = false; };
  }, [adapter, reloadNonce]);

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

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const selectedItem = items.find((item) => item.id === selectedItemId);
  const overlayOpen = Boolean(selectedItem || showNewProject || showNewRevision || showAddBom || showNewItem);

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
    setSearch(value);
    navigate("inventory");
  };

  const retryConnection = () => {
    setConnectionError(undefined);
    setReloadNonce((current) => current + 1);
  };

  const refreshWorkspace = async (): Promise<boolean> => {
    try {
      const snapshot = await adapter.loadWorkspace();
      setItems(snapshot.inventory);
      setProjects(snapshot.projects);
      setOffers(snapshot.offers);
      setSampleMode(snapshot.source === "synthetic");
      setDemoAvailable(Boolean(snapshot.health?.demo));
      setConnection(snapshot.source === "synthetic" ? "sample" : "ready");
      setConnectionError(undefined);
      return true;
    } catch (error: unknown) {
      // A close-out commit is already durable by the time this refresh runs.
      // Keep the current project/reconciliation visible and let the caller
      // report refresh trouble separately from the successful commit.
      setConnectionError(normalizeApiError(error));
      return false;
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
      setOffers([]);
      setPendingRevisionSetup(undefined);
      setSampleMode(false);
      setConnectionError(undefined);
      setConnection("unauthenticated");
    } catch (error: unknown) {
      handleMutationError(error, "signing out");
    }
  };

  const handleMutationError = (error: unknown, action: string) => {
    const normalized = normalizeApiError(error);
    setConnectionError(normalized);
    if (!sampleMode && (normalized.kind === "unauthenticated" || normalized.kind === "csrf")) {
      setConnection("unauthenticated");
      setItems([]);
      setProjects([]);
      setOffers([]);
    }
    setToast(writeFailureMessage(normalized, action));
  };

  const recordCount = async (itemId: string, quantity: number) => {
    try {
      const result = await adapter.recordCount(itemId, quantity);
      setItems((current) => current.map((item) => item.id === itemId ? result : item));
      setToast(`${result.name} is now counted at ${formatQuantity(result.quantity, result.unit)}.`);
      setSelectedItemId(undefined);
    } catch (error: unknown) {
      handleMutationError(error, "recording that count");
    }
  };

  const createProject = async (input: Pick<Project, "name" | "description">): Promise<boolean> => {
    try {
      const project = await adapter.createProject(input);
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id);
      setShowNewProject(false);
      setPage("projects");
      setToast(`${project.name} is ready for its first requirements.`);
      return true;
    } catch (error: unknown) {
      handleMutationError(error, "creating that project");
      return false;
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

  const uploadArtifact = async (projectId: string, file: File, role: string) => {
    try {
      const project = await adapter.uploadArtifact(projectId, file, role);
      setProjects((current) => current.map((candidate) => candidate.id === project.id ? project : candidate));
      setToast(`${file.name} was uploaded to ${project.currentRevision}.`);
    } catch (error: unknown) {
      handleMutationError(error, "uploading that file");
      throw normalizeApiError(error);
    }
  };

  const addInventoryItem = async (input: { name: string; category: InventoryCategory; quantity: number; unit: InventoryItem["unit"] }): Promise<boolean> => {
    try {
      const item = await adapter.createInventoryItem(input);
      setItems((current) => [item, ...current]);
      setShowNewItem(false);
      setToast(`${item.name} added as Check quantity. Record a physical count before reserving it.`);
      return true;
    } catch (error: unknown) {
      handleMutationError(error, "adding that inventory item");
      return false;
    }
  };

  const searchCatalogProducts = async (kind: "filament" | "printer", query: string): Promise<CatalogProduct[]> => {
    const sequence = ++catalogSearchSequence.current;
    try {
      const results = await adapter.searchCatalogProducts(kind, query);
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
      setShowNewItem(false);
      setCatalogQuery("");
      setCatalogProducts([]);
      setToast(`${item.name} added. Its exact product link is ${item.productProfile?.linkState === "confirmed" ? "confirmed" : "reported until you check it"}.`);
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
                <input ref={searchInputRef} value={search} onChange={(event) => searchInventory(event.target.value)} placeholder="Search inventory" aria-label="Search inventory" />
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
            {page === "overview" && <OverviewPage items={items} projects={projects} expert={expert} sampleMode={sampleMode} onNavigate={navigate} onOpenProject={openProject} onSelectItem={setSelectedItemId} onNewProject={() => setShowNewProject(true)} />}
            {page === "inventory" && <InventoryPage items={items} search={search} expert={expert} onSearch={setSearch} onSelectItem={setSelectedItemId} onNewItem={() => setShowNewItem(true)} />}
            {page === "projects" && selectedProject && <ProjectPage project={selectedProject} projects={projects} items={items} offers={offers} tab={projectTab} expert={expert} sampleMode={sampleMode} onTabChange={setProjectTab} onSelectProject={setSelectedProjectId} onOpenItem={setSelectedItemId} onNavigate={navigate} onToast={setToast} onNewRevision={() => setShowNewRevision(true)} onRetrySetup={pendingRevisionSetup?.projectId === selectedProject.id && pendingRevisionSetup.revisionId === selectedProject.serverRevisionId ? retryRevisionSetup : undefined} onAddBom={() => setShowAddBom(true)} onUpload={uploadArtifact} onReadReconciliation={adapter.readReconciliation} onSaveReconciliation={adapter.saveReconciliationDraft} onCommitReconciliation={adapter.commitReconciliation} onRefreshWorkspace={refreshWorkspace} />}
            {page === "projects" && !selectedProject && <EmptyState icon="folder" title="No projects yet" description="Start with a name and a plain-language goal. You can add parts and files as the idea becomes real." action="Create first project" onAction={() => setShowNewProject(true)} />}
            {page === "capabilities" && <CapabilitiesPage expert={expert} onCopy={setToast} />}
            {page === "settings" && <SettingsPage expert={expert} sampleMode={sampleMode} connection={connection} onExpert={() => setExpert((current) => !current)} onLogout={sampleMode ? returnToPrivateWorkspace : signOut} />}
          </main>
        </div>
      </div>

      {selectedItem && <InventoryDrawer item={selectedItem} expert={expert} onClose={() => setSelectedItemId(undefined)} onCount={recordCount} />}
      {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} onCreate={createProject} />}
      {showNewRevision && selectedProject && <NewRevisionDialog project={selectedProject} items={items} expert={expert} onClose={() => setShowNewRevision(false)} onCreate={createRevision} />}
      {showAddBom && selectedProject && <AddBomDialog items={items} project={selectedProject} onClose={() => setShowAddBom(false)} onCreate={addBomLine} />}
      {showNewItem && <NewInventoryDialog catalogQuery={catalogQuery} catalogProducts={catalogProducts} onCatalogQuery={setCatalogQuery} onSearchCatalog={searchCatalogProducts} onCreateCatalogProduct={addCatalogProduct} onCreateExact={addExactInventoryItem} onClose={() => setShowNewItem(false)} onCreate={addInventoryItem} />}
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

function writeFailureMessage(error: ApiError, action: string): string {
  if (error.kind === "offline") return `We could not finish ${action} because the private service is offline. Nothing was saved.`;
  if (error.kind === "unauthenticated" || error.kind === "csrf") return `Your session is no longer ready for ${action}. Sign in again; nothing was saved.`;
  if (error.kind === "validation") return `We could not finish ${action}. Check the details and try again.`;
  return `We could not finish ${action}. Nothing was saved.`;
}

function ConnectionScreen({ state, error, demoAvailable, onLogin, onRetry, onSample }: { state: Exclude<ConnectionState, "loading" | "ready" | "sample">; error: ApiError | undefined; demoAvailable: boolean; onLogin: (password: string) => Promise<void>; onRetry: () => void; onSample: () => void }) {
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
  const title = isAuth ? "Sign in to your private workspace" : isOffline ? "The private workspace is offline" : "We could not open the workspace";
  const description = isAuth ? "Your inventory, project files, and supplier observations stay on your connected service." : isOffline ? "BenchLedger cannot reach the service right now. Your private data has not been replaced with sample data." : "The service returned an error before the workspace could be loaded. Nothing was changed.";
  const detail = error && !isAuth && !isOffline ? error.correlationId ? `Reference ${error.correlationId}` : error.message : undefined;
  return <main className="connection-screen"><section className="connection-card" aria-labelledby="connection-title"><div className="loading-brand"><div className="brand-mark" aria-hidden="true"><span /><span /><span /></div><span>BenchLedger · private workspace</span></div><div className="connection-state-icon"><Icon name={isAuth ? "info" : isOffline ? "link" : "warning"} size={22} /></div><h1 id="connection-title">{title}</h1><p className="connection-description">{description}</p>{detail && <p className="connection-detail" role="alert">{detail}</p>}{(isAuth || state === "error") && <form className="login-form" onSubmit={submit} noValidate><label className="form-field" htmlFor="workspace-password"><span>Workspace password</span><input id="workspace-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby={formError ? "workspace-password-error" : undefined} aria-invalid={Boolean(formError)} autoFocus /></label>{formError && <p id="workspace-password-error" className="form-error" role="alert">{formError}</p>}<button className="button button-primary login-submit" type="submit" disabled={submitting}>{submitting ? "Signing in…" : "Open workspace"}<Icon name="arrow-right" size={16} /></button></form>}{!isAuth && <button className="button button-secondary connection-retry" onClick={onRetry}><Icon name="refresh" size={16} /> Try again</button>}{demoAvailable && <div className="sample-choice"><span>Want to explore the interface first?</span><button className="text-button" onClick={onSample}>Open sample workspace <Icon name="arrow-right" size={15} /></button><small>Sample data is clearly labeled and never mixed with your private workspace.</small></div>}</section></main>;
}

function SampleBanner({ onReturn }: { onReturn: () => void }) {
  return <div className="offline-banner sample-banner" role="status"><Icon name="info" size={17} /><div><strong>Sample workspace</strong><span>This is synthetic data for exploring the workflow. It is not your inventory and nothing is saved to the private service.</span></div><button className="text-button" onClick={onReturn}><Icon name="arrow-left" size={15} /> Return to private workspace</button></div>;
}

function PageHeader({ eyebrow, title, description, action, onAction, actionIcon = "plus", children }: { eyebrow: string; title: string; description: string; action?: string | undefined; onAction?: (() => void) | undefined; actionIcon?: Parameters<typeof Icon>[0]["name"]; children?: ReactNode }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="header-actions">{children}{action && <button className="button button-primary" onClick={onAction}><Icon name={actionIcon} size={17} />{action}</button>}</div></div>;
}

function BuildRail({ currentStep, projectName, onProject }: { currentStep: number; projectName?: string | undefined; onProject?: (() => void) | undefined }) {
  return <section className="build-rail" aria-label="Build progress"><div className="rail-heading"><div><span className="eyebrow">Build path</span><strong>{projectName ?? "Your next build"}</strong></div>{onProject && <button className="text-button" onClick={onProject}>Open project <Icon name="arrow-right" size={15} /></button>}</div><div className="rail-track">{railSteps.map((step, index) => <div className={`rail-step ${index < currentStep ? "is-complete" : ""} ${index === currentStep ? "is-current" : ""}`} key={step}><span className="rail-marker">{index < currentStep ? <Icon name="check" size={13} /> : index + 1}</span><span>{step}</span>{index < railSteps.length - 1 && <span className="rail-line" aria-hidden="true" />}</div>)}</div></section>;
}

function OverviewPage({ items, projects, expert, sampleMode, onNavigate, onOpenProject, onSelectItem, onNewProject }: { items: InventoryItem[]; projects: Project[]; expert: boolean; sampleMode: boolean; onNavigate: (page: Page) => void; onOpenProject: (id: string, tab?: ProjectTab) => void; onSelectItem: (id: string) => void; onNewProject: () => void }) {
  const counts = countByState(items);
  const activeProject = projects.find((project) => project.status === "In progress") ?? projects[0];
  const activeSummary = activeProject ? calculateProjectSummary(activeProject, items) : undefined;
  const inspectLine = activeSummary?.lineStatuses.find((line) => line.state === "inspect-first");
  const openLine = activeSummary?.lineStatuses.find((line) => ["missing", "partial"].includes(line.state));
  const nextLine = inspectLine ?? openLine;
  const nextActionTitle = activeProject
    ? inspectLine
      ? `Check ${inspectLine.line.label} for ${activeProject.name}.`
      : openLine
        ? `Source ${openLine.line.label} for ${activeProject.name}.`
        : "Review the next build step."
    : "Add your first project.";
  const nextActionDescription = activeProject
    ? inspectLine
      ? `${formatQuantity(inspectLine.line.required, inspectLine.line.unit)} is listed, but its stock still needs a physical count before you reserve it.`
      : openLine
        ? `${formatQuantity(openLine.remaining || openLine.line.required, openLine.line.unit)} is not covered by confirmed stock yet.`
        : "Every recorded requirement is covered by confirmed stock. Continue with files or validation."
    : "A plain-language goal is enough to begin. Add the equipment and parts as you go.";
  return <>
    <PageHeader eyebrow="Workbench" title="Make the next build clear." description="Start with what you have, then move one decision forward." action="New project" onAction={onNewProject} />
    <BuildRail currentStep={activeProject?.railStep ?? 0} projectName={activeProject?.name} onProject={activeProject ? () => onOpenProject(activeProject.id) : undefined} />
    <section className="decision-strip"><div className="decision-copy"><span className="decision-kicker"><Icon name="spark" size={15} /> Next useful action</span><h2>{nextActionTitle}</h2><p>{nextActionDescription}</p></div>{activeProject && <button className="button button-secondary" onClick={() => onOpenProject(activeProject.id)}>{nextLine ? "Review project" : "Open dossier"}<Icon name="arrow-right" size={16} /></button>}</section>
    <section className="metric-strip" aria-label="Workspace summary"><Metric value={String(counts.available)} label="Ready to use" detail="counted or commissioned" tone="good" /><Metric value={String(counts["inspect-first"])} label="Need a check" detail="physical count required" tone="warn" /><Metric value={String(projects.length)} label="Projects" detail={`${projects.filter((project) => project.status === "In progress").length} in progress`} tone="info" /><Metric value={String(activeSummary?.missingLines ?? 0)} label="Open buys" detail={activeProject?.name ?? "No active project"} tone="bad" /></section>
    <div className="overview-grid"><section className="surface project-overview"><SectionHeading eyebrow="Active project" title={activeProject?.name ?? "No active project"} action={activeProject ? "Open dossier" : undefined} onAction={activeProject ? () => onOpenProject(activeProject.id) : undefined} /><div className="project-overview-body">{activeProject ? <><div className="project-overview-copy"><span className="status-pill tone-info"><span className="status-symbol">●</span>{activeProject.status}</span><h3>{activeProject.subtitle}</h3><p>{activeProject.description}</p><div className="dossier-meta"><span><Icon name="layers" size={15} /> {activeProject.workItem}</span><span><Icon name="tag" size={15} /> Revision {activeProject.currentRevision}</span><span><Icon name="clock" size={15} /> Updated {activeProject.updated}</span></div></div><div className="project-progress"><div className="progress-ring" style={{ "--progress": `${Math.round(((activeSummary?.readyLines ?? 0) / (activeSummary?.totalLines || 1)) * 100)}%` } as React.CSSProperties}><strong>{activeSummary?.readyLines ?? 0}</strong><span>ready</span></div><div><strong>{activeSummary?.missingLines ?? 0} parts to source</strong><p>{activeSummary?.inspectLines ?? 0} more need a physical check</p></div></div></> : <EmptyState icon="folder" title="A project gives your inventory a purpose" description="Create one to see reuse, checks, purchases, and files in one place." />}</div></section><section className="surface inventory-overview"><SectionHeading eyebrow="Inventory" title="A quick look at your bench" action="View all" onAction={() => onNavigate("inventory")} /><div className="mini-inventory">{items.slice(0, 5).map((item) => <button className="mini-row" key={item.id} onClick={() => onSelectItem(item.id)}><span className={`item-glyph accent-${item.accent}`}><Icon name={categoryIcons[item.category]} size={16} /></span><span className="mini-row-copy"><strong>{item.name}</strong><small>{item.variant}</small></span><StatusPill state={item.state} compact /></button>)}</div></section></div>
    <section className="surface activity-section">{sampleMode ? <><SectionHeading eyebrow="Recent learning · sample" title="What changed" /><div className="activity-list">{activity.map((entry) => <div className="activity-row" key={entry.id}><span className={`activity-dot activity-${entry.tone}`} /><div><strong>{entry.title}</strong><span>{entry.detail}</span></div><time>{entry.time}</time></div>)}</div></> : <><SectionHeading eyebrow="Recent learning" title="What changed" /><p className="activity-empty">Recorded project changes will appear here when the connected service provides activity history.</p></>}</section>
  </>;
}

function Metric({ value, label, detail, tone }: { value: string; label: string; detail: string; tone: StockLabelTone }) {
  return <div className="metric"><span className={`metric-value metric-${tone}`}>{value}</span><div><strong>{label}</strong><small>{detail}</small></div></div>;
}

function SectionHeading({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string | undefined; onAction?: (() => void) | undefined }) {
  return <div className="section-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{action && <button className="text-button" onClick={onAction}>{action}<Icon name="arrow-right" size={14} /></button>}</div>;
}

function InventoryPage({ items, search, expert, onSearch, onSelectItem, onNewItem }: { items: InventoryItem[]; search: string; expert: boolean; onSearch: (value: string) => void; onSelectItem: (id: string) => void; onNewItem: () => void }) {
  const [category, setCategory] = useState<(typeof categoryOptions)[number]>("All");
  const filtered = filterInventory(items, search, category);
  return <>
    <PageHeader eyebrow="Inventory" title="Know what is on the bench." description="Printers, material, tools, and components in one evidence-backed view." action="Add item" onAction={onNewItem} />
    <div className="inventory-summary"><div><strong>{items.length}</strong><span>tracked items</span></div><div><strong>{items.filter((item) => item.category === "Printers").length}</strong><span>printers</span></div><div><strong>{items.filter((item) => item.category === "Filament").length}</strong><span>filaments</span></div><div><strong>{items.filter((item) => ["Electronics", "Wire & cable"].includes(item.category)).length}</strong><span>electronics lines</span></div></div>
    <section className="surface inventory-section"><div className="inventory-toolbar"><label className="field-search"><Icon name="search" size={17} /><span className="sr-only">Filter inventory</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search by name, variant, tag, or location" /></label><label className="category-control"><Icon name="filter" size={15} /><span className="category-control-label">Category</span><select aria-label="Filter inventory by category" value={category} onChange={(event) => setCategory(event.target.value as (typeof categoryOptions)[number])}>{categoryOptions.map((option) => <option key={option} value={option}>{option === "All" ? "All categories" : option}</option>)}</select></label></div>{filtered.length ? <InventoryTable items={filtered} expert={expert} onSelectItem={onSelectItem} /> : <EmptyState icon="search" title="No matching items" description="Try a broader search or clear the category filter." action="Clear search" onAction={() => { onSearch(""); setCategory("All"); }} />}</section>
  </>;
}

function InventoryTable({ items, expert, onSelectItem }: { items: InventoryItem[]; expert: boolean; onSelectItem: (id: string) => void }) {
  return <div className="table-scroll"><table className="data-table inventory-table"><caption className="sr-only">Inventory items</caption><thead><tr><th scope="col">Item</th><th scope="col">Category</th><th scope="col">Quantity</th><th scope="col">Status</th><th scope="col">Location</th>{expert && <th scope="col">Evidence</th>}<th scope="col"><span className="sr-only">Open</span></th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><button className="table-item" onClick={() => onSelectItem(item.id)}><span className={`item-glyph accent-${item.accent}`}><Icon name={categoryIcons[item.category]} size={16} /></span><span><strong>{item.name}</strong><small>{item.variant}</small>{(item.category === "Filament" || item.category === "Printers") && <small className={`exact-product-state ${item.productProfile?.linkState === "confirmed" ? "is-confirmed" : ""}`}>{exactProductLabel(item)}</small>}</span></button></td><td><span className="category-label"><Icon name={categoryIcons[item.category]} size={14} />{item.category}</span></td><td className="quantity-cell"><strong>{formatQuantity(Math.max(item.quantity - item.reserved, 0), item.unit)}</strong>{item.reserved > 0 && <small>{item.reserved} reserved</small>}</td><td><StatusPill state={item.state} /></td><td><span className="location-label"><Icon name="archive" size={14} />{item.location}</span></td>{expert && <td><span className="evidence-label">{item.evidence}</span>{item.lastCounted && <small className="table-date">{item.lastCounted}</small>}</td>}<td><button className="row-open" onClick={() => onSelectItem(item.id)} aria-label={`Open ${item.name}`}><Icon name="chevron-right" size={17} /></button></td></tr>)}</tbody></table></div>;
}

function StatusPill({ state, compact = false }: { state: StockState | "optional"; compact?: boolean }) {
  const status = state === "optional" ? { label: "Optional", tone: "muted" as const } : getStockLabel(state);
  return <span className={`status-pill tone-${status.tone} ${compact ? "status-compact" : ""}`}><span className="status-symbol" aria-hidden="true">{status.tone === "good" ? "✓" : status.tone === "bad" ? "!" : status.tone === "warn" ? "?" : "–"}</span>{status.label}</span>;
}

function ProjectPage({ project, projects, items, offers, tab, expert, sampleMode, onTabChange, onSelectProject, onOpenItem, onNavigate, onToast, onNewRevision, onRetrySetup, onAddBom, onUpload, onReadReconciliation, onSaveReconciliation, onCommitReconciliation, onRefreshWorkspace }: {
  project: Project;
  projects: Project[];
  items: InventoryItem[];
  offers: typeof fixtureOffers;
  tab: ProjectTab;
  expert: boolean;
  sampleMode: boolean;
  onTabChange: (tab: ProjectTab) => void;
  onSelectProject: (id: string) => void;
  onOpenItem: (id: string) => void;
  onNavigate: (page: Page) => void;
  onToast: (message: string) => void;
  onNewRevision: () => void;
  onRetrySetup?: (() => void) | undefined;
  onAddBom: () => void;
  onUpload: (projectId: string, file: File, role: string) => Promise<void>;
  onReadReconciliation: WorkspaceAdapter["readReconciliation"];
  onSaveReconciliation: WorkspaceAdapter["saveReconciliationDraft"];
  onCommitReconciliation: WorkspaceAdapter["commitReconciliation"];
  onRefreshWorkspace: () => Promise<boolean>;
}) {
  const summary = calculateProjectSummary(project, items);
  const configuredPrinter = project.buildConfigSnapshot?.printerItemId ? items.find((item) => item.id === project.buildConfigSnapshot?.printerItemId) : undefined;
  const configuredFilament = project.buildConfigSnapshot?.filamentItemId ? items.find((item) => item.id === project.buildConfigSnapshot?.filamentItemId) : undefined;
  const hasServerRevision = !sampleMode && Boolean(project.serverRevisionId);
  const [reconciliation, setReconciliation] = useState<ReconciliationViewModel>();
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [reconciliationError, setReconciliationError] = useState<string>();
  const reconciliationRevisionId = project.serverRevisionId;

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
  return <>
    <PageHeader eyebrow="Projects / dossier" title={project.name} description={project.subtitle}><select className="project-select" aria-label="Choose project" value={project.id} onChange={(event) => onSelectProject(event.target.value)}>{projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select>{onRetrySetup && <button className="button button-secondary" onClick={onRetrySetup}><Icon name="refresh" size={16} /> Retry setup</button>}<button className="button button-secondary" onClick={onNewRevision}><Icon name="plus" size={16} /> New revision</button></PageHeader>
    <BuildRail currentStep={project.railStep} projectName={`${project.name} · ${project.currentRevision}`} />
    <div className="dossier-layout"><aside className="dossier-column"><div className="dossier-status"><span className={`status-pill tone-${project.status === "Complete" ? "good" : "info"}`}><span className="status-symbol">●</span>{project.status}</span><span className="revision-label">{project.currentRevision}</span></div><h2>{project.workItem}</h2><p>{project.description}</p><div className="dossier-next"><span className="eyebrow">Next action</span><strong>{summary.inspectLines ? "Check the physical stock" : summary.missingLines ? "Source the remaining parts" : "Ready to validate"}</strong><span>{summary.inspectLines ? `${summary.inspectLines} BOM line needs a count before it can be reserved.` : `${summary.missingLines} BOM lines are not covered by confirmed stock.`}</span></div><dl className="dossier-facts"><div><dt>Current revision</dt><dd>{project.currentRevision}</dd></div><div><dt>Build files</dt><dd>{project.artifacts.length} artifacts</dd></div><div><dt>Last changed</dt><dd>{project.updated}</dd></div></dl>{project.buildConfigSnapshot && <BuildSetupSummary input={project.buildConfigSnapshot} printer={configuredPrinter} filament={configuredFilament} expert={expert} />}{expert && <details className="expert-detail" open><summary>Expert context</summary><div className="detail-grid"><div><span>Work item ID</span><code>{project.id}/work-item</code></div><div><span>Revision state</span><code>State is supplied by the connected service.</code></div><div><span>Artifact policy</span><code>Retained revisions are not overwritten.</code></div></div></details>}<button className="text-button dossier-inventory-link" onClick={() => onNavigate("inventory")}>Browse all inventory <Icon name="arrow-right" size={15} /></button></aside><section className="dossier-workspace"><div className="tab-list" role="tablist" aria-label="Project workspace"><button role="tab" aria-selected={tab === "plan"} className={tab === "plan" ? "is-active" : ""} onClick={() => onTabChange("plan")}><Icon name="clipboard" size={16} /> Plan <span>{summary.totalLines}</span></button><button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "is-active" : ""} onClick={() => onTabChange("files")}><Icon name="folder" size={16} /> Files <span>{project.artifacts.length}</span></button><button role="tab" aria-selected={tab === "offers"} className={tab === "offers" ? "is-active" : ""} onClick={() => onTabChange("offers")}><Icon name="tag" size={16} /> Shopping list <span>{summary.missingLines}</span></button>{hasServerRevision && <button role="tab" aria-selected={tab === "reconciliation"} className={tab === "reconciliation" ? "is-active" : ""} onClick={() => onTabChange("reconciliation")}><Icon name="check-circle" size={16} /> Close out <span>{reconciliation?.status === "committed" ? "Done" : "Review"}</span></button>}</div>{tab === "plan" && <ProjectPlan project={project} summary={summary} expert={expert} onOpenItem={onOpenItem} onAddBom={onAddBom} />}{tab === "files" && <ProjectFiles project={project} expert={expert} sampleMode={sampleMode} onUpload={(file, role) => onUpload(project.id, file, role)} />}{tab === "offers" && <ShoppingList project={project} summary={summary} offers={offers} expert={expert} onToast={onToast} onBackToPlan={() => onTabChange("plan")} />}{tab === "reconciliation" && hasServerRevision && <section className="reconciliation-page-surface">{reconciliationLoading && <div className="reconciliation-loading" role="status"><span className="eyebrow">Project close-out</span><strong>Loading the current review…</strong><p>Nothing changes in inventory while this review loads.</p></div>}{reconciliationError && !reconciliationLoading && <div className="reconciliation-loading reconciliation-load-error" role="alert"><span className="eyebrow">Could not load close-out</span><strong>{reconciliationError}</strong><button className="button button-secondary" onClick={() => onTabChange("plan")}>Back to plan</button></div>}{reconciliation && !reconciliationLoading && !reconciliationError && <ReconciliationUI model={reconciliation} expert={expert} onChange={setReconciliation} onRequestPreview={saveReconciliation} onConfirmCommit={commitReconciliation} />}</section>}</section></div>
  </>;
}

function ProjectPlan({ project, summary, expert, onOpenItem, onAddBom }: { project: Project; summary: ReturnType<typeof calculateProjectSummary>; expert: boolean; onOpenItem: (id: string) => void; onAddBom: () => void }) {
  return <div className="project-plan"><section className="surface bom-section"><SectionHeading eyebrow="Bill of materials" title="What this build needs" /><div className="bom-explainer"><Icon name="info" size={16} /><span>Only counted or commissioned stock is shown as ready. Delivered and ordered items stay visible until you check them.</span></div><div className="bom-list">{summary.lineStatuses.map((line) => <BomRow key={line.line.id} line={line} expert={expert} onOpenItem={onOpenItem} />)}</div><button className="add-line-button" onClick={onAddBom}><Icon name="plus" size={16} /> Add a requirement</button></section><section className="surface learning-section"><SectionHeading eyebrow="Project memory" title="What we learned" /><div className="learning-list">{project.notes.length ? project.notes.map((note, index) => <div className="learning-row" key={note}><span className="learning-index">0{index + 1}</span><p>{note}</p><span className="learning-time">Recorded</span></div>) : <p className="activity-empty">No observations are recorded for this revision yet.</p>}</div></section></div>;
}

function BomRow({ line, expert, onOpenItem }: { line: BomLineStatus; expert: boolean; onOpenItem: (id: string) => void }) {
  const display = getLineLabel(line.state);
  return <div className={`bom-row bom-${line.state}`}><div className="bom-main"><span className={`bom-state-mark mark-${display.tone}`} aria-hidden="true">{display.tone === "good" ? "✓" : display.tone === "bad" ? "!" : display.tone === "warn" ? "?" : "–"}</span><div><strong>{line.line.label}</strong><span>{line.line.note ?? `${formatQuantity(line.line.required, line.line.unit)} required`}</span></div></div><div className="bom-quantity"><strong>{line.supplied > 0 ? `${formatQuantity(line.supplied, line.line.unit)} / ` : ""}{formatQuantity(line.line.required, line.line.unit)}</strong>{line.remaining > 0 && <small>{formatQuantity(line.remaining, line.line.unit)} remaining</small>}</div><div className="bom-match">{line.item ? <button className="match-link" onClick={() => onOpenItem(line.item!.id)}><span>{line.item.name}</span><Icon name="arrow-up-right" size={13} /></button> : <span className="match-none">No matching stock</span>}<StatusPill state={line.state === "ready" ? "available" : line.state === "inspect-first" ? "inspect-first" : line.state === "optional" ? "optional" : "depleted"} /></div>{expert && <details className="bom-expert"><summary aria-label={`Show evidence for ${line.line.label}`}><Icon name="chevron-down" size={16} /></summary><div><span>Match reason</span><p>{line.item ? `${line.item.variant} matches the requested category. Compatibility is based on the recorded project constraint.` : "No exact variant has been recorded in the workspace."}</p>{line.item?.dimensions && <span>Recorded dimensions: {formatDimensions(line.item.dimensions)}</span>}</div></details>}</div>;
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
}

function ProjectFiles({ project, expert, sampleMode, onUpload }: { project: Project; expert: boolean; sampleMode: boolean; onUpload: (file: File, role: string) => Promise<void> }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadRun, setUploadRun] = useState<UploadRun>();
  const processFiles = async (selected: File[]) => {
    const entries = selected.map((file) => ({ name: file.name, role: roleForFile(file.name), status: "pending" as const }));
    setUploadRun({ entries, total: selected.length, completed: 0, active: true });
    for (const [index, file] of selected.entries()) {
      const role = roleForFile(file.name);
      setUploadRun((current) => current ? { ...current, active: true, currentIndex: index, entries: current.entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, status: "uploading" } : entry) } : current);
      try {
        await onUpload(file, role);
        setUploadRun((current) => current ? { ...current, entries: current.entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, status: "success", message: "Uploaded to the current revision." } : entry) } : current);
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
    if (!selected.length || uploadRun?.active) return;
    void processFiles(selected);
  };
  const successCount = uploadRun?.entries.filter((entry) => entry.status === "success").length ?? 0;
  const errorCount = uploadRun?.entries.filter((entry) => entry.status === "error").length ?? 0;
  const currentEntry = uploadRun?.currentIndex === undefined ? undefined : uploadRun.entries[uploadRun.currentIndex];
  const bindings = [...new Set(project.artifacts.map((file) => [file.machine, file.material].filter(Boolean).join(" · ")).filter(Boolean))];
  const bindingLabel = bindings.length ? bindings.join(", ") : "No machine binding recorded";
  return <section className="surface files-section"><div className="files-header"><div><span className="eyebrow">Project files</span><h2>Revisioned build evidence</h2><p>{sampleMode ? "Uploads stay inside this explicitly synthetic sample workspace." : "Keep editable CAD, exports, slicer plates, and validation notes together without overwriting an older candidate."}</p></div><div><input ref={fileInput} type="file" multiple className="sr-only" aria-label="Choose files to upload" onChange={addFiles} disabled={uploadRun?.active} /><button className="button button-primary" onClick={() => fileInput.current?.click()} disabled={uploadRun?.active} aria-busy={uploadRun?.active}><Icon name="upload" size={16} />{uploadRun?.active ? "Uploading…" : "Add files"}</button></div></div>{uploadRun && <div className={`upload-status ${errorCount ? "has-errors" : ""}`} role="status" aria-live="polite"><div className="upload-status-heading"><strong>{uploadRun.active ? `Uploading ${Math.min((uploadRun.currentIndex ?? uploadRun.completed) + 1, uploadRun.total)} of ${uploadRun.total}` : `${successCount} of ${uploadRun.total} file${uploadRun.total === 1 ? "" : "s"} uploaded`}</strong><span>{currentEntry?.name ?? (errorCount ? `${errorCount} failed` : "Complete")}</span></div><progress max={uploadRun.total} value={uploadRun.completed} aria-label="Artifact upload progress" /><ul>{uploadRun.entries.map((entry) => <li key={`${entry.name}-${entry.role}`}><span><strong>{entry.name}</strong><small>{entry.role}</small></span><span className={`upload-entry-state upload-${entry.status}`}>{entry.status === "pending" ? "Waiting" : entry.status === "uploading" ? "Uploading…" : entry.status === "success" ? "Uploaded" : "Not uploaded"}</span>{entry.status === "error" && entry.message && <p role="alert">{entry.message}</p>}</li>)}</ul></div>}<div className="file-path"><Icon name="folder" size={15} /><code>{project.id}/work-items/{project.workItem.toLowerCase().replaceAll(" ", "-")}/{project.currentRevision}</code><span>{sampleMode ? "sample workspace" : "private workspace"}</span></div>{project.artifacts.length ? <div className="table-scroll"><table className="data-table files-table"><caption className="sr-only">Project artifacts and revisions</caption><thead><tr><th scope="col">File</th><th scope="col">Role</th><th scope="col">Revision</th><th scope="col">Updated</th><th scope="col">State</th>{expert && <th scope="col">SHA-256</th>}</tr></thead><tbody>{project.artifacts.map((file) => <tr key={file.id}><td><span className="file-name"><span className={`file-type type-${file.role.toLowerCase().replaceAll(" ", "-")}`}><Icon name={file.role === "Validation" ? "clipboard" : file.role === "Editable CAD" ? "code" : "file"} size={15} /></span><span><strong>{file.name}</strong><small>{file.size}{file.machine ? ` · ${file.machine}` : ""}</small></span></span></td><td>{file.role}</td><td><span className="revision-tag">{file.revision}</span></td><td>{file.updated}</td><td><span className={`file-state state-${file.status}`}>{file.status === "candidate" ? "Candidate" : file.status === "validated" ? "Validated" : "Superseded"}</span></td>{expert && <td><code className="hash-cell">{file.hash}</code></td>}</tr>)}</tbody></table></div> : <div className="files-empty"><Icon name="folder" size={20} /><strong>No files in this revision yet.</strong><span>Add the editable source or first export when you have one.</span></div>}{expert && <details className="expert-detail file-manifest-detail"><summary>Show manifest details</summary><div className="manifest-grid"><span>Binding</span><strong>{bindingLabel}</strong><span>Retention</span><strong>Older revision files remain auditable when the service records them.</strong><span>Preview</span><strong>Browser-safe text and image previews only.</strong></div></details>}</section>;
}

function ShoppingList({ project, summary, offers, expert, onToast, onBackToPlan }: { project: Project; summary: ReturnType<typeof calculateProjectSummary>; offers: typeof fixtureOffers; expert: boolean; onToast: (message: string) => void; onBackToPlan: () => void }) {
  const missing = summary.lineStatuses.filter((line) => ["missing", "partial"].includes(line.state));
  const rows = missing.map((line) => ({ line, offers: offers.filter((offer) => offer.itemId === (line.line.itemId ?? line.line.id)) }));
  const selectedOffers = rows.flatMap((row) => {
    const selectedOffer = row.offers.find((offer) => offer.preferred) ?? row.offers[0];
    return selectedOffer ? [selectedOffer] : [];
  });
  const totalsByCurrency = sumMoneyByCurrency(selectedOffers);
  const currencies = (["EUR", "USD"] as const).filter((currency) => totalsByCurrency[currency] !== undefined);
  const draftList = rows.length ? rows.map(({ line, offers: lineOffers }) => {
    const selectedOffer = lineOffers.find((offer) => offer.preferred) ?? lineOffers[0];
    return `${line.line.label}: ${formatQuantity(line.remaining || line.line.required, line.line.unit)}${selectedOffer ? ` · ${selectedOffer.supplier} · ${formatMoney(selectedOffer.priceMinor, selectedOffer.currency)}` : ""}`;
  }).join("\n") : "No uncovered requirements.";
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
  return <section className="surface shopping-section"><div className="shopping-header"><div><span className="eyebrow">Procurement proposal</span><h2>Source the real gaps</h2><p>Prices are observations, not a live cart. BenchLedger will never purchase without your approval.</p></div><div className="shopping-total" aria-label="Estimated total by currency"><span>Estimated total</span>{currencies.length ? <div className="shopping-total-values">{currencies.map((currency) => <span className="shopping-total-line" key={currency}><strong>{formatMoney(totalsByCurrency[currency] ?? 0, currency)}</strong><small>{currency}</small></span>)}</div> : <strong className="shopping-total-empty">No priced offers</strong>}<small>{rows.length} required line{rows.length === 1 ? "" : "s"}</small></div></div>{rows.length ? <div className="shopping-list">{rows.map(({ line, offers: lineOffers }) => <div className="shopping-row" key={line.line.id}><div className="shopping-item"><span className="bom-state-mark mark-bad">!</span><div><strong>{line.line.label}</strong><span>{formatQuantity(line.remaining || line.line.required, line.line.unit)} still needed</span></div></div><div className="offer-stack">{lineOffers.length ? lineOffers.map((offer) => <a className={`offer-row ${offer.preferred ? "is-preferred" : ""}`} href={offer.url} target="_blank" rel="noreferrer" key={offer.id}><span className="offer-supplier">{offer.preferred && <Icon name="check-circle" size={14} />}{offer.supplier}</span><span className="offer-title">{offer.title}<small>{offer.pack} · observed {offer.observed}</small></span><strong>{formatMoney(offer.priceMinor, offer.currency)}</strong><span className="offer-eta">{offer.eta}</span><Icon name="external" size={14} /></a>) : <div className="offer-empty"><Icon name="info" size={15} /> No supplier offer recorded yet. Add one from the item detail.</div>}</div></div>)}</div> : <EmptyState icon="check-circle" title="Nothing to buy yet" description="Every required line is covered by the current project inventory." action="Back to plan" onAction={onBackToPlan} />}{expert && <details className="expert-detail offer-notes" open><summary>How these recommendations are made</summary><p>Matches use the exact recorded variant where available. Prices show the most recent observation date, package quantity, and supplier link. A stale or unverified offer never becomes an automatic purchase.</p></details>}<div className="shopping-actions"><button className="button button-secondary" onClick={() => { void copyDraftList(); }}><Icon name="copy" size={16} /> Copy draft list</button></div></section>;
}

function CapabilitiesPage({ expert, onCopy }: { expert: boolean; onCopy: (message: string) => void }) {
  const capabilityText = `BenchLedger workspace context\n\nUse list_inventory before recommending purchases.\nTreat Ready to use as counted or commissioned only.\nTreat Check quantity as inspect-first, never as available.\nFor a project, read the BOM, calculate gaps, then explain reuse, inspection, substitutes, and observed offers.\nNever purchase, publish, or overwrite a retained artifact without approval.`;
  const copyContext = async () => {
    try { await navigator.clipboard.writeText(capabilityText); onCopy("Agent context copied to your clipboard."); } catch { onCopy("Select the context block to copy it manually."); }
  };
  return <>
    <PageHeader eyebrow="Agent access" title="Give an agent the right context." description="BenchLedger exposes the same workspace truth through the frontend, REST API, and MCP." action="Copy context" actionIcon="copy" onAction={copyContext} />
    <section className="agent-callout"><div className="agent-callout-icon"><Icon name="spark" size={21} /></div><div><strong>Small tools. Clear evidence. Good decisions.</strong><p>An unfamiliar agent should be able to read this page, discover MCP, and answer “Can I build this?” without learning database terms first.</p></div><span className="api-status"><span className="online-dot" /> MCP surface ready</span></section>
    <div className="capabilities-layout"><section className="surface context-section"><SectionHeading eyebrow="Technical quickstart" title="Workspace rules" action="Copy" onAction={copyContext} /><pre className="context-block"><code>{capabilityText}</code></pre><div className="context-footer"><span><Icon name="info" size={15} /> Context is read before writes.</span><code>benchledger://capabilities</code></div></section><section className="surface capability-list-section"><SectionHeading eyebrow="Capability map" title="What agents can do" /><div className="capability-list">{capabilityGroups.map((group) => <details key={group.title} className="capability-group" open={expert}><summary><span><strong>{group.title}</strong><small>{group.description}</small></span><span className="capability-count">{group.tools.length} tools <Icon name="chevron-down" size={15} /></span></summary><div className="tool-list">{group.tools.map((tool) => <code key={tool}>{tool}</code>)}</div></details>)}</div></section></div>
    <section className="surface agent-prompts"><SectionHeading eyebrow="Useful prompts" title="Start with the outcome" /><div className="prompt-list"><Prompt text="Can I build this with what I have?" /><Prompt text="Prepare a sourced shopping list, but don't buy anything." /><Prompt text="Which stock needs a physical count before I reserve it?" /><Prompt text="Read the latest project revision and tell me what changed." /></div></section>
  </>;
}

function Prompt({ text }: { text: string }) { return <button className="prompt-row" onClick={() => navigator.clipboard?.writeText(text)}><Icon name="spark" size={15} /><span>{text}</span><Icon name="copy" size={14} /></button>; }

function SettingsPage({ expert, sampleMode, connection, onExpert, onLogout }: { expert: boolean; sampleMode: boolean; connection: ConnectionState; onExpert: () => void; onLogout: () => void }) {
  const connected = connection === "ready";
  return <><PageHeader eyebrow="Workspace settings" title="A workspace that stays understandable." description="Set the level of detail and connection behavior that suits the way you build." /><div className="settings-layout"><section className="surface settings-section"><SectionHeading eyebrow="Display" title="How BenchLedger speaks" /><div className="setting-row"><div><strong>Detail level</strong><span>Beginner labels stay visible. Expert evidence can be opened in place.</span></div><button className={`mode-toggle setting-control ${expert ? "is-expert" : ""}`} aria-pressed={expert} onClick={onExpert}><span className="mode-dot" />{expert ? "Expert details on" : "Beginner view on"}</button></div><div className="setting-row"><div><strong>Measurements</strong><span>Millimetres for dimensions; grams, metres, or pieces for quantities.</span></div><span className="setting-value">mm · g · m · each</span></div><div className="setting-row"><div><strong>Currency</strong><span>Observed supplier prices are stored with their source and date.</span></div><span className="setting-value">EUR · observed</span></div></section><section className="surface settings-section"><SectionHeading eyebrow="Connection" title="Private API" /><div className="connection-panel"><div className="connection-panel-top"><span className="connection-icon"><Icon name="link" size={18} /></span><div><strong>{sampleMode ? "Sample workspace" : "Local workspace adapter"}</strong><span>{sampleMode ? "Synthetic data only" : "Connected to /api/v1"}</span></div><span className="connection-badge"><span className={`online-dot ${connected || sampleMode ? "" : "is-offline"}`} /> {sampleMode ? "Sample mode" : connected ? "Connected" : "Session needs attention"}</span></div><p>{sampleMode ? "This workspace is intentionally synthetic. Changes stay local to the sample and never represent private inventory." : "Reads and supported writes are sent to the authenticated private service. Failed writes are reported and never stored only in the browser."}</p></div><div className="setting-row setting-row-last"><div><strong>MCP endpoint</strong><span>Agents should use scoped tokens and read the capability manifest first.</span></div><code className="setting-value">benchledger://capabilities</code></div><button className="button button-quiet settings-logout" onClick={onLogout}><Icon name="arrow-left" size={16} /> {sampleMode ? "Close sample workspace" : "Sign out of private workspace"}</button></section><section className="surface settings-section"><SectionHeading eyebrow="Evidence semantics" title="Never smooth away uncertainty" /><div className="evidence-legend"><Legend tone="good" title="Ready to use" text="Counted or commissioned stock can be proposed for reuse." /><Legend tone="warn" title="Check quantity" text="Delivered or uncertain stock needs a physical check first." /><Legend tone="bad" title="Need to buy" text="No confirmed compatible stock covers the requirement." /></div></section></div></>;
}

function Legend({ tone, title, text }: { tone: StockLabelTone; title: string; text: string }) { return <div className="legend-row"><span className={`legend-mark mark-${tone}`}>{tone === "good" ? "✓" : tone === "warn" ? "?" : "!"}</span><div><strong>{title}</strong><span>{text}</span></div></div>; }

const focusableOverlaySelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1'])";

function useOverlayBehavior(containerRef: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const container = containerRef.current;
    const focusFirstControl = () => {
      const first = container?.querySelector<HTMLElement>("[autofocus]") ?? container?.querySelector<HTMLElement>(focusableOverlaySelector);
      first?.focus();
    };
    focusFirstControl();
    const handleKeyDown = (event: KeyboardEvent) => {
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
      if (previousFocus?.isConnected) {
        window.setTimeout(() => previousFocus.focus(), 0);
      }
    };
  }, [containerRef]);
}

function InventoryDrawer({ item, expert, onClose, onCount }: { item: InventoryItem; expert: boolean; onClose: () => void; onCount: (id: string, quantity: number) => Promise<void> }) {
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [saving, setSaving] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerTitleId = useId();
  useOverlayBehavior(drawerRef, onClose);
  const submitCount = async () => {
    const parsed = Number(quantity);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setSaving(true);
    try { await onCount(item.id, parsed); } finally { setSaving(false); }
  };
  return <><div className="drawer-scrim" aria-hidden="true" onClick={onClose} /><aside ref={drawerRef} className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby={drawerTitleId} tabIndex={-1}><div className="drawer-header"><span className={`item-glyph accent-${item.accent}`} aria-hidden="true"><Icon name={categoryIcons[item.category]} size={18} /></span><div><span className="eyebrow">{item.category}</span><h2 id={drawerTitleId}>{item.name}</h2></div><button type="button" className="icon-button" aria-label="Close item details" onClick={onClose}><Icon name="close" size={20} /></button></div><div className="drawer-body"><StatusPill state={item.state} /><p className="drawer-description">{item.description}</p>{(item.category === "Filament" || item.category === "Printers") && <div className="exact-product-callout"><strong>{exactProductLabel(item)}</strong><span>{item.productProfile?.linkState === "confirmed" ? "This link can be used for exact setup matching." : "Use Add item to record the exact product after checking the physical item."}</span></div>}<div className="drawer-quantity"><div><span className="eyebrow">Current quantity</span><strong>{formatQuantity(Math.max(item.quantity - item.reserved, 0), item.unit)}</strong><span>{item.reserved ? `${formatQuantity(item.reserved, item.unit)} reserved in projects` : "Nothing reserved"}</span></div><div className="count-form"><label htmlFor="count-quantity">Physical count</label><div><input id="count-quantity" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} /><span>{item.unit}</span></div><button className="button button-secondary" onClick={submitCount} disabled={saving}>{saving ? "Saving…" : "Record count"}</button></div></div><div className="drawer-facts"><div><span>Variant</span><strong>{item.variant}</strong></div><div><span>Location</span><strong>{item.location}</strong></div>{item.manufacturer && <div><span>Manufacturer</span><strong>{item.manufacturer}</strong></div>}{item.sku && <div><span>SKU</span><code>{item.sku}</code></div>}{item.productProfile?.filament?.lotBatch && <div><span>Lot / batch</span><strong>{item.productProfile.filament.lotBatch}</strong></div>}{item.productProfile?.printer?.assetLabel && <div><span>Asset label</span><strong>{item.productProfile.printer.assetLabel}</strong></div>}</div>{expert && <details className="expert-detail" open><summary>Expert evidence</summary><div className="detail-grid"><div><span>Evidence state</span><code>{item.evidence}</code></div><div><span>Exact link state</span><code>{item.productProfile?.linkState ?? "not linked"}</code></div><div><span>Catalog product</span><code>{item.catalogProduct?.id ?? "Not recorded"}</code></div><div><span>Last counted</span><code>{item.lastCounted ?? "Not recorded"}</code></div><div><span>Dimensions</span><code>{item.dimensions ? formatDimensions(item.dimensions) : "Not recorded"}</code></div><div><span>Tags</span><code>{item.tags.join(" · ") || "None"}</code></div></div><div className="compatibility-box"><span>Compatibility notes</span>{item.compatibility.length ? <ul>{item.compatibility.map((note) => <li key={note}>{note}</li>)}</ul> : <p>No compatibility evidence recorded yet.</p>}</div></details>}<div className="drawer-history"><div className="drawer-history-heading"><span className="eyebrow">History</span>{expert && <button className="text-button">View all <Icon name="arrow-right" size={14} /></button>}</div><div className="history-entry"><span className="history-icon"><Icon name="check" size={13} /></span><div><strong>{item.evidence === "counted" ? "Physical count recorded" : "Evidence imported"}</strong><span>{item.lastCounted ?? "Source evidence retained"}</span></div></div></div></div></aside></>;
}

function NewProjectDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (input: Pick<Project, "name" | "description">) => Promise<boolean> }) {
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
      const created = await onCreate({ name: name.trim(), description: description.trim() || "A new maker project to explore." });
      if (!created) setFormError("The project was not created. Check the service connection and try again.");
    } catch (error: unknown) {
      setFormError(normalizeApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  };
  return <Dialog title="Start a project" onClose={onClose}><form onSubmit={(event) => { void submit(event); }}><p className="dialog-intro">Give the idea a name and say what you want to make. You can add exact parts and files once the direction is clearer.</p><label className="form-field"><span>Project name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Desk sensor enclosure" disabled={submitting} /></label><label className="form-field"><span>What are you making?</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder="A short description in your own words" disabled={submitting} /></label>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}>Cancel</button><button type="submit" className="button button-primary" disabled={!name.trim() || submitting} aria-busy={submitting}>{submitting ? "Creating…" : "Create project"} {!submitting && <Icon name="arrow-right" size={16} />}</button></div></form></Dialog>;
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
  const buildConfig = {
    ...(printer ? { printerItemId: printer.id, ...(printer.productProfile?.id ? { printerProfileId: printer.productProfile.id } : {}), ...(printer.catalogProduct ? { printerProductId: printer.catalogProduct.id } : {}) } : {}),
    ...(filament ? { filamentItemId: filament.id, ...(filament.productProfile?.id ? { filamentProfileId: filament.productProfile.id } : {}), ...(filament.catalogProduct ? { filamentProductId: filament.catalogProduct.id } : {}) } : {}),
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
    try {
      const created = await onCreate({ name: name.trim(), status, buildConfig, ...(notes.trim() ? { notes: notes.trim() } : {}) });
      if (!created) setFormError("The revision was not created. Check the service connection and try again.");
    } catch (error: unknown) {
      setFormError(normalizeApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  };
  return <Dialog title={`New revision for ${project.name}`} onClose={onClose}><form onSubmit={(event) => { void submit(event); }}><p className="dialog-intro">A revision preserves the previous evidence. Choose the owned printer and filament for this build; the setup is saved as an immutable snapshot after the revision is created.</p><label className="form-field"><span>Revision name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. R02 enclosure fit" disabled={submitting} /></label><label className="form-field"><span>Starting state</span><select value={status} onChange={(event) => setStatus(event.target.value)} disabled={submitting}><option value="concept">Concept</option><option value="CAD complete">CAD complete</option><option value="DFAM reviewed">DFAM reviewed</option></select></label><div className="setup-picker-grid"><OwnedItemCombobox category="Printers" items={items} value={printer} onSelect={setPrinter} label="Owned printer" /><OwnedItemCombobox category="Filament" items={items} value={filament} onSelect={setFilament} label="Owned filament" /></div><BuildSetupSummary input={buildConfig} printer={printer} filament={filament} expert={expert} /><details className="advanced-setup" open={expert}><summary>Advanced setup <small>optional</small></summary><div className="advanced-setup-grid"><label className="form-field"><span>Hotend side</span><input value={hotendSide} onChange={(event) => setHotendSide(event.target.value)} placeholder="Single nozzle / left / right" disabled={submitting} /></label><label className="form-field"><span>Nozzle diameter (mm)</span><input type="number" min="0.1" step="0.01" value={nozzleDiameter} onChange={(event) => setNozzleDiameter(event.target.value)} placeholder="0.4" disabled={submitting} /></label><label className="form-field"><span>Nozzle material</span><input value={nozzleMaterial} onChange={(event) => setNozzleMaterial(event.target.value)} placeholder="Hardened steel" disabled={submitting} /></label><label className="form-field"><span>Build plate</span><input value={buildPlate} onChange={(event) => setBuildPlate(event.target.value)} placeholder="Textured PEI" disabled={submitting} /></label><label className="form-field"><span>Accessories</span><input value={accessories} onChange={(event) => setAccessories(event.target.value)} placeholder="AMS 2 Pro, dryer" disabled={submitting} /></label><label className="form-field"><span>Firmware</span><input value={firmware} onChange={(event) => setFirmware(event.target.value)} placeholder="Version or not recorded" disabled={submitting} /></label><label className="form-field"><span>Slicer</span><input value={slicer} onChange={(event) => setSlicer(event.target.value)} placeholder="Bambu Studio / Cura" disabled={submitting} /></label><label className="form-field"><span>Slicer version</span><input value={slicerVersion} onChange={(event) => setSlicerVersion(event.target.value)} placeholder="e.g. 1.10.0" disabled={submitting} /></label><label className="form-field"><span>Profile</span><input value={profile} onChange={(event) => setProfile(event.target.value)} placeholder="0.20 mm Standard" disabled={submitting} /></label><label className="form-field"><span>Calibration state</span><input value={calibration} onChange={(event) => setCalibration(event.target.value)} placeholder="Flow / first layer / date" disabled={submitting} /></label><label className="form-field advanced-unknowns"><span>Explicit unknowns</span><textarea value={unknowns} onChange={(event) => setUnknowns(event.target.value)} rows={2} placeholder="One unknown per line" disabled={submitting} /></label></div></details><label className="form-field"><span>Notes <small>(optional)</small></span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} placeholder="What changed or what should be checked?" disabled={submitting} /></label>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}>Cancel</button><button type="submit" className="button button-primary" disabled={!name.trim() || submitting} aria-busy={submitting}>{submitting ? "Creating…" : "Create revision & save setup"} {!submitting && <Icon name="arrow-right" size={16} />}</button></div></form></Dialog>;
}

function AddBomDialog({ items, project, onClose, onCreate }: { items: InventoryItem[]; project: Project; onClose: () => void; onCreate: (input: BomInput) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState<BomInput["unit"]>("each");
  const [itemId, setItemId] = useState("");
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
  return <Dialog title={`Add a requirement to ${project.currentRevision}`} onClose={onClose}><form onSubmit={(event) => { void submit(event); }}><p className="dialog-intro">Describe one physical or digital requirement. Matching stock is evaluated from the recorded variant and evidence state.</p><label className="form-field"><span>Requirement name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. ESP32 development board" disabled={submitting} /></label><div className="form-row"><label className="form-field"><span>Quantity</span><input type="number" min="0.01" step="any" required value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={submitting} /></label><label className="form-field"><span>Unit</span><select value={unit} onChange={(event) => setUnit(event.target.value as BomInput["unit"])} disabled={submitting}><option value="each">pieces</option><option value="g">grams</option><option value="m">metres</option></select></label></div><label className="form-field"><span>Known matching stock <small>(optional)</small></span><select value={itemId} onChange={(event) => setItemId(event.target.value)} disabled={submitting}><option value="">Let BenchLedger match it</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.variant}</option>)}</select></label><label className="form-field"><span>Requirement note <small>(optional)</small></span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="Fit, material, or compatibility detail" disabled={submitting} /></label><label className="check-field"><input type="checkbox" checked={optional} onChange={(event) => setOptional(event.target.checked)} disabled={submitting} /><span>Mark as optional</span></label>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}>Cancel</button><button type="submit" className="button button-primary" disabled={!name.trim() || submitting} aria-busy={submitting}>{submitting ? "Adding…" : "Add requirement"} {!submitting && <Icon name="arrow-right" size={16} />}</button></div></form></Dialog>;
}

function NewInventoryDialog({ catalogQuery, catalogProducts, onCatalogQuery, onSearchCatalog, onCreateCatalogProduct, onCreateExact, onClose, onCreate }: { catalogQuery: string; catalogProducts: CatalogProduct[]; onCatalogQuery: (query: string) => void; onSearchCatalog: (kind: "filament" | "printer", query: string) => Promise<CatalogProduct[]>; onCreateCatalogProduct: (input: CatalogProductDraft) => Promise<CatalogProduct | undefined>; onCreateExact: (input: ExactInventoryInput) => Promise<boolean>; onClose: () => void; onCreate: (input: { name: string; category: InventoryCategory; quantity: number; unit: InventoryItem["unit"] }) => Promise<boolean> }) {
  const [category, setCategory] = useState<InventoryCategory>();
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState<InventoryItem["unit"]>("each");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!category || !name.trim() || submitting) return;
    setSubmitting(true);
    setFormError(undefined);
    try {
      const created = await onCreate({ name: name.trim(), category, quantity: Math.max(Number(quantity) || 0, 0), unit });
      if (!created) setFormError("The item was not added. Check the service connection and try again.");
    } catch (error: unknown) {
      setFormError(normalizeApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const chooseCategory = (next: InventoryCategory) => { setCategory(next); setFormError(undefined); setName(""); setQuantity("1"); setUnit(next === "Filament" ? "g" : "each"); };
  if (!category) return <Dialog title="Add to inventory" onClose={onClose}><div className="category-picker"><p className="dialog-intro">Start with a category. Filament and printers use an exact-product check; other categories keep the quick add form.</p><div className="category-choice-grid">{addableCategories.map((option) => <button type="button" className="category-choice" key={option} onClick={() => chooseCategory(option)}><span className={`item-glyph accent-${option === "Filament" ? "slate" : option === "Printers" ? "teal" : "blue"}`}><Icon name={categoryIcons[option]} size={18} /></span><span><strong>{option}</strong><small>{option === "Filament" || option === "Printers" ? "Choose an exact product" : "Quick add"}</small></span><Icon name="chevron-right" size={15} /></button>)}</div><div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button></div></div></Dialog>;
  if (category === "Filament" || category === "Printers") return <Dialog title={`Add ${category === "Filament" ? "filament" : "a printer"}`} onClose={onClose}><CatalogInventoryFlow category={category} products={catalogProducts.filter((product) => product.kind === (category === "Filament" ? "filament" : "printer"))} query={catalogQuery} onQueryChange={onCatalogQuery} onSearch={onSearchCatalog} onCreateProduct={onCreateCatalogProduct} onCreate={onCreateExact} onBack={() => { setCategory(undefined); onCatalogQuery(""); }} /></Dialog>;
  return <Dialog title="Add an inventory item" onClose={onClose}><form onSubmit={(event) => { void submit(event); }}><button type="button" className="text-button category-back" onClick={() => setCategory(undefined)} disabled={submitting}><Icon name="arrow-left" size={15} /> Choose another category</button><p className="dialog-intro">This records what you received, but it starts as <strong>Check quantity</strong> until you physically count it. The entered quantity is not treated as available stock.</p><label className="form-field"><span>Name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. JST-PH 2-pin leads" disabled={submitting} /></label><div className="form-row"><label className="form-field"><span>Category</span><select value={category} onChange={(event) => chooseCategory(event.target.value as InventoryCategory)} disabled={submitting}>{addableCategories.filter((option) => option !== "Filament" && option !== "Printers").map((option) => <option key={option} value={option}>{option}</option>)}</select></label><label className="form-field"><span>Quantity received</span><input type="number" min="0" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={submitting} /></label><label className="form-field"><span>Unit</span><select value={unit} onChange={(event) => setUnit(event.target.value as InventoryItem["unit"])} disabled={submitting}><option value="each">pieces</option><option value="g">grams</option><option value="m">metres</option></select></label></div>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={submitting}>Cancel</button><button type="submit" className="button button-primary" disabled={!name.trim() || submitting} aria-busy={submitting}>{submitting ? "Adding…" : "Add item"} {!submitting && <Icon name="plus" size={16} />}</button></div></form></Dialog>;
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  useOverlayBehavior(dialogRef, onClose);
  return <><div className="dialog-scrim" aria-hidden="true" onClick={onClose} /><section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><div className="dialog-header"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={19} /></button></div>{children}</section></>;
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
