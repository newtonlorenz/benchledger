import { AssemblyService } from "./assembly.js";
import { InventoryImageService } from "./inventory-images.js";
import { TeamService } from "./team-service.js";
import { MakerWorkflowService } from "./maker-workflows.js";
import type { ApplicationPorts, ArtifactDownload, EventBusEvent, AuditEvent, BuildConfigurationListOptions, BulkMutation, CatalogProductListOptions, GapEvaluation, InventoryBulkUpdateResult, InventoryCategoryListOptions, Mutation, Page, ProjectListOptions, RequestContext, ReservationDetails, StockMutation, UploadSessionDetails, UsageInput } from "./ports.js";
import type { LegacyBomLineInput } from "./service/bom-rules.js";
import type { BeginUpload as ApiBeginUpload, Artifact, ArtifactListQuery, BomLine, BuildConfigurationSnapshot, CatalogProduct, CommissionInventoryItem, CommitProjectSetup, CreateBomLine, CreateCatalogProduct, CreateInventoryCategory, CreateInventoryItem, CreateOffer, CreateProject, CreateProjectRevision, CreateProjectWithInitialRevision, CreateReservation, CreateWorkItem, CreateWorkItemRevision, InspectionAction, InspectionCompletionCommit, InspectionCompletionPreview, InventoryCategory, InventoryItem, InventoryListQuery, InventoryProductProfile, Offer, Project, ProjectRevision, ProjectSetupCommitResult, ProjectSetupPreview, ProjectSetupProposal, ProjectTombstone, ProjectWithInitialRevision, ReconciliationCommit, ReconciliationDraft, Reservation, StockEventInput, UpdateProjectRevision, UploadSession, WorkItem, WorkItemRevision, WorkspaceSecurityMutation } from "@benchledger/api-contract";
import { CommandRunner } from "./service/command-runner.js";
import { ProjectAccess } from "./service/project-access.js";
import type { ServiceModuleDependencies } from "./service/module.js";
import { nowIso } from "./service/shared.js";
import { WorkspaceSecurityModule } from "./service/workspace-security.js";
import { CatalogModule } from "./service/catalog.js";
import { BuildConfigurationModule } from "./service/build-configurations.js";
import { InventoryModule } from "./service/inventory.js";
import { ProjectModule } from "./service/projects.js";
import { ProjectSetupModule } from "./service/project-setup.js";
import { BomModule } from "./service/bom.js";
import { InspectionModule } from "./service/inspections.js";
import { ReservationModule } from "./service/reservations.js";
import { ReconciliationModule } from "./service/reconciliation.js";
import { OfferModule } from "./service/offers.js";
import { ArtifactModule } from "./service/artifacts.js";

export { SUPPORTED_BOM_CONSTRAINT_KEYS, bomSpecification, matchesBomConstraints, unsupportedBomConstraintKeys } from "./service/bom-rules.js";
export { FILAMENT_CATALOG_IDENTITY_UNKNOWN, assertOwnedPrinter } from "./service/catalog.js";

/**
 * Public application facade shared by REST, MCP and import surfaces.
 *
 * The use cases live in per-area modules under `./service/` (inventory,
 * catalog, build configurations, projects, project setup, BOM and gap
 * evaluation, inspection, reservations and usage, reconciliation, offers,
 * artifacts and workspace security). Every module shares one audited
 * `CommandRunner` and the project ancestry guards; this class only wires
 * them together and keeps the stable public method surface.
 */
export class ApplicationService {
  readonly inventoryImages: InventoryImageService;
  readonly makerWorkflows: MakerWorkflowService;
  readonly assemblies: AssemblyService;
  readonly team: TeamService;
  private readonly runner: CommandRunner;
  private readonly workspaceSecurityModule: WorkspaceSecurityModule;
  private readonly catalogModule: CatalogModule;
  private readonly buildConfigurationModule: BuildConfigurationModule;
  private readonly inventoryModule: InventoryModule;
  private readonly projectModule: ProjectModule;
  private readonly projectSetupModule: ProjectSetupModule;
  private readonly bomModule: BomModule;
  private readonly inspectionModule: InspectionModule;
  private readonly reservationModule: ReservationModule;
  private readonly reconciliationModule: ReconciliationModule;
  private readonly offerModule: OfferModule;
  private readonly artifactModule: ArtifactModule;

  constructor(private readonly ports: ApplicationPorts, private readonly version = "0.1.0") {
    this.runner = new CommandRunner(ports);
    const modules: ServiceModuleDependencies = { ports, runner: this.runner, access: new ProjectAccess(ports), app: this };
    this.workspaceSecurityModule = new WorkspaceSecurityModule(modules);
    this.catalogModule = new CatalogModule(modules);
    this.buildConfigurationModule = new BuildConfigurationModule(modules);
    this.inventoryModule = new InventoryModule(modules);
    this.projectModule = new ProjectModule(modules);
    this.projectSetupModule = new ProjectSetupModule(modules);
    this.bomModule = new BomModule(modules);
    this.inspectionModule = new InspectionModule(modules);
    this.reservationModule = new ReservationModule(modules);
    this.reconciliationModule = new ReconciliationModule(modules);
    this.offerModule = new OfferModule(modules);
    this.artifactModule = new ArtifactModule(modules);
    const mutate = this.runner.mutate.bind(this.runner);
    this.assemblies = new AssemblyService(ports, this, mutate);
    this.inventoryImages = new InventoryImageService(ports, this, mutate);
    this.makerWorkflows = new MakerWorkflowService(ports, this, mutate);
    this.team = new TeamService(ports, this, mutate);
  }

  getVersion(): string {
    return this.version;
  }

  /** Report whether this runtime can provide revision-scoped reconciliation. */
  supportsReconciliation(): boolean {
    return this.ports.reconciliations !== undefined;
  }

  async health() {
    return this.ports.unitOfWork.exclusive(async () => {
      const checks = this.ports.health ? await this.ports.health.check() : { database: "ok", artifacts: "ok" } as const;
      const status = Object.values(checks).every((value) => value === "ok") ? "ok" : "degraded";
      return { status, service: "benchledger", version: this.version, demo: false, now: nowIso(), checks };
    });
  }

  subscribe(listener: (event: EventBusEvent) => void): () => void {
    return this.ports.events.subscribe(listener);
  }

  getWorkspaceSecurityStatus(): Promise<import("@benchledger/api-contract").WorkspaceSecurityStatus> {
    return this.workspaceSecurityModule.getWorkspaceSecurityStatus();
  }

  verifyWorkspacePassword(password: string): Promise<boolean> {
    return this.workspaceSecurityModule.verifyWorkspacePassword(password);
  }

  enableWorkspacePassword(newPassword: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    return this.workspaceSecurityModule.enableWorkspacePassword(newPassword, expectedVersion, ctx);
  }

  disableWorkspacePassword(currentPassword: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    return this.workspaceSecurityModule.disableWorkspacePassword(currentPassword, expectedVersion, ctx);
  }

  changeWorkspacePassword(input: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    return this.workspaceSecurityModule.changeWorkspacePassword(input, expectedVersion, ctx);
  }

  updateWorkspaceSecurity(input: WorkspaceSecurityMutation, ctx: RequestContext): Promise<Mutation<import("@benchledger/api-contract").WorkspaceSecurityStatus>> {
    return this.workspaceSecurityModule.updateWorkspaceSecurity(input, ctx);
  }

  listCatalogProducts(query: Partial<CatalogProductListOptions> = {}): Promise<Page<CatalogProduct>> {
    return this.catalogModule.listCatalogProducts(query);
  }

  getCatalogProduct(id: string): Promise<CatalogProduct> {
    return this.catalogModule.getCatalogProduct(id);
  }

  createCatalogProduct(input: CreateCatalogProduct, ctx: RequestContext): Promise<Mutation<CatalogProduct>> {
    return this.catalogModule.createCatalogProduct(input, ctx);
  }

  updateCatalogProduct(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<CatalogProduct>> {
    return this.catalogModule.updateCatalogProduct(id, input, expectedVersion, ctx);
  }

  getInventoryProductProfile(itemId: string): Promise<InventoryProductProfile> {
    return this.catalogModule.getInventoryProductProfile(itemId);
  }

  putInventoryProductProfile(itemId: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<InventoryProductProfile>> {
    return this.catalogModule.putInventoryProductProfile(itemId, input, expectedVersion, ctx);
  }

  listBuildConfigurations(revisionId: string, query: Partial<BuildConfigurationListOptions> = {}): Promise<Page<BuildConfigurationSnapshot>> {
    return this.buildConfigurationModule.listBuildConfigurations(revisionId, query);
  }

  getLatestBuildConfiguration(revisionId: string): Promise<BuildConfigurationSnapshot | null> {
    return this.buildConfigurationModule.getLatestBuildConfiguration(revisionId);
  }

  getBuildConfiguration(id: string): Promise<BuildConfigurationSnapshot> {
    return this.buildConfigurationModule.getBuildConfiguration(id);
  }

  createBuildConfiguration(revisionId: string, input: unknown, ctx: RequestContext): Promise<Mutation<BuildConfigurationSnapshot>> {
    return this.buildConfigurationModule.createBuildConfiguration(revisionId, input, ctx);
  }

  listInventory(query: InventoryListQuery): Promise<Page<InventoryItem>> {
    return this.inventoryModule.listInventory(query);
  }

  getInventoryItem(id: string): Promise<InventoryItem> {
    return this.inventoryModule.getInventoryItem(id);
  }

  listInventoryCategories(query: Partial<InventoryCategoryListOptions> = {}): Promise<Page<InventoryCategory>> {
    return this.inventoryModule.listInventoryCategories(query);
  }

  getInventoryCategory(id: string): Promise<InventoryCategory> {
    return this.inventoryModule.getInventoryCategory(id);
  }

  createInventoryCategory(input: CreateInventoryCategory, ctx: RequestContext): Promise<Mutation<InventoryCategory>> {
    return this.inventoryModule.createInventoryCategory(input, ctx);
  }

  updateInventoryCategory(id: string, input: unknown, expectedVersion: number, ctx: RequestContext): Promise<Mutation<InventoryCategory>> {
    return this.inventoryModule.updateInventoryCategory(id, input, expectedVersion, ctx);
  }

  archiveInventoryCategory(id: string, expectedVersion: number, ctx: RequestContext): Promise<Mutation<InventoryCategory>> {
    return this.inventoryModule.archiveInventoryCategory(id, expectedVersion, ctx);
  }

  createInventoryItem(input: CreateInventoryItem, ctx: RequestContext): Promise<Mutation<InventoryItem>> {
    return this.inventoryModule.createInventoryItem(input, ctx);
  }

  createInventoryWithProductProfile(input: unknown, ctx: RequestContext): Promise<Mutation<{ readonly item: InventoryItem; readonly profile: InventoryProductProfile }>> {
    return this.inventoryModule.createInventoryWithProductProfile(input, ctx);
  }

  deleteInventoryItem(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<InventoryItem>> {
    return this.inventoryModule.deleteInventoryItem(id, expectedVersion, ctx);
  }

  updateInventoryItem(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<InventoryItem>> {
    return this.inventoryModule.updateInventoryItem(id, input, expectedVersion, ctx);
  }

  bulkUpdateInventoryItems(input: unknown, ctx: RequestContext): Promise<BulkMutation<InventoryBulkUpdateResult>> {
    return this.inventoryModule.bulkUpdateInventoryItems(input, ctx);
  }

  recordStockEvent(input: StockEventInput, ctx: RequestContext): Promise<Mutation<StockMutation>> {
    return this.inventoryModule.recordStockEvent(input, ctx);
  }

  recordPhysicalCount(itemId: string, quantity: number, ctx: RequestContext, unit?: InventoryItem["unit"], note?: string): Promise<Mutation<StockMutation>> {
    return this.inventoryModule.recordPhysicalCount(itemId, quantity, ctx, unit, note);
  }

  commissionInventoryItem(itemId: string, input: CommissionInventoryItem, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<StockMutation>> {
    return this.inventoryModule.commissionInventoryItem(itemId, input, expectedVersion, ctx);
  }

  listStockEvents(itemId: string, limit = 50, cursor?: string) {
    return this.inventoryModule.listStockEvents(itemId, limit, cursor);
  }

  listProjects(query: ProjectListOptions): Promise<Page<Project>> {
    return this.projectModule.listProjects(query);
  }

  getProject(id: string): Promise<Project> {
    return this.projectModule.getProject(id);
  }

  listRemovedProjects(): Promise<readonly ProjectTombstone[]> {
    return this.projectModule.listRemovedProjects();
  }

  listRemovedProjectPage(limit = 50, cursor?: string): Promise<Page<ProjectTombstone>> {
    return this.projectModule.listRemovedProjectPage(limit, cursor);
  }

  readRemovedProjectHistory(id: string, limit = 50, cursor?: string): Promise<Page<AuditEvent>> {
    return this.projectModule.readRemovedProjectHistory(id, limit, cursor);
  }

  removeProject(id: string, expectedVersion: number | undefined, confirmationName: string, ctx: RequestContext): Promise<Mutation<ProjectTombstone>> {
    return this.projectModule.removeProject(id, expectedVersion, confirmationName, ctx);
  }

  createProject(input: CreateProject, ctx: RequestContext): Promise<Mutation<Project>> {
    return this.projectModule.createProject(input, ctx);
  }

  updateProject(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Project>> {
    return this.projectModule.updateProject(id, input, expectedVersion, ctx);
  }

  archiveProject(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Project>> {
    return this.projectModule.archiveProject(id, expectedVersion, ctx);
  }

  restoreProject(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Project>> {
    return this.projectModule.restoreProject(id, expectedVersion, ctx);
  }

  listWorkItems(projectId: string): Promise<readonly WorkItem[]> {
    return this.projectModule.listWorkItems(projectId);
  }

  getWorkItem(id: string): Promise<WorkItem> {
    return this.projectModule.getWorkItem(id);
  }

  createWorkItem(projectId: string, input: CreateWorkItem, ctx: RequestContext): Promise<Mutation<WorkItem>> {
    return this.projectModule.createWorkItem(projectId, input, ctx);
  }

  createProjectRevision(projectId: string, input: CreateProjectRevision, ctx: RequestContext): Promise<Mutation<ProjectRevision>> {
    return this.projectModule.createProjectRevision(projectId, input, ctx);
  }

  updateProjectRevision(id: string, input: UpdateProjectRevision, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<ProjectRevision>> {
    return this.projectModule.updateProjectRevision(id, input, expectedVersion, ctx);
  }

  createProjectWithInitialRevision(input: CreateProjectWithInitialRevision, ctx: RequestContext): Promise<Mutation<ProjectWithInitialRevision>> {
    return this.projectModule.createProjectWithInitialRevision(input, ctx);
  }

  getProjectRevision(id: string): Promise<ProjectRevision> {
    return this.projectModule.getProjectRevision(id);
  }

  createWorkItemRevision(workItemId: string, input: CreateWorkItemRevision, ctx: RequestContext): Promise<Mutation<WorkItemRevision>> {
    return this.projectModule.createWorkItemRevision(workItemId, input, ctx);
  }

  getWorkItemRevision(id: string): Promise<WorkItemRevision> {
    return this.projectModule.getWorkItemRevision(id);
  }

  previewProjectSetup(input: ProjectSetupProposal, ctx: RequestContext): Promise<ProjectSetupPreview> {
    return this.projectSetupModule.previewProjectSetup(input, ctx);
  }

  commitProjectSetup(input: CommitProjectSetup, ctx: RequestContext): Promise<Mutation<ProjectSetupCommitResult>> {
    return this.projectSetupModule.commitProjectSetup(input, ctx);
  }

  listBomLines(revisionId: string, options?: { readonly includeRetired?: boolean }): Promise<readonly BomLine[]> {
    return this.bomModule.listBomLines(revisionId, options);
  }

  getBomLine(id: string): Promise<BomLine> {
    return this.bomModule.getBomLine(id);
  }

  prepareBomLine(revisionId: string, input: CreateBomLine | LegacyBomLineInput): Promise<CreateBomLine> {
    return this.bomModule.prepareBomLine(revisionId, input);
  }

  createBomLine(revisionId: string, input: CreateBomLine | LegacyBomLineInput, ctx: RequestContext): Promise<Mutation<BomLine>> {
    return this.bomModule.createBomLine(revisionId, input, ctx);
  }

  updateBomLine(id: string, input: unknown, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<BomLine>> {
    return this.bomModule.updateBomLine(id, input, expectedVersion, ctx);
  }

  retireBomLine(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<BomLine>> {
    return this.bomModule.retireBomLine(id, expectedVersion, ctx);
  }

  restoreBomLine(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<BomLine>> {
    return this.bomModule.restoreBomLine(id, expectedVersion, ctx);
  }

  evaluateBomGaps(revisionId: string): Promise<GapEvaluation> {
    return this.bomModule.evaluateBomGaps(revisionId);
  }

  listInspections(revisionId: string, options: { readonly limit?: number; readonly cursor?: string } = {}): Promise<Page<InspectionAction> & { readonly revisionId: string }> {
    return this.inspectionModule.listInspections(revisionId, options);
  }

  getInspection(revisionId: string, inspectionId: string): Promise<InspectionAction> {
    return this.inspectionModule.getInspection(revisionId, inspectionId);
  }

  previewInspectionCompletion(revisionId: string, input: unknown, ctx: RequestContext): Promise<InspectionCompletionPreview> {
    return this.inspectionModule.previewInspectionCompletion(revisionId, input, ctx);
  }

  commitInspectionCompletion(revisionId: string, input: unknown, ctx: RequestContext): Promise<Mutation<InspectionCompletionCommit>> {
    return this.inspectionModule.commitInspectionCompletion(revisionId, input, ctx);
  }

  createReservation(revisionId: string, input: CreateReservation, ctx: RequestContext): Promise<Mutation<Reservation>> {
    return this.reservationModule.createReservation(revisionId, input, ctx);
  }

  releaseReservation(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Reservation>> {
    return this.reservationModule.releaseReservation(id, expectedVersion, ctx);
  }

  listReservations(revisionId: string): Promise<readonly Reservation[]> {
    return this.reservationModule.listReservations(revisionId);
  }

  getReservationDetails(id: string): Promise<ReservationDetails> {
    return this.reservationModule.getReservationDetails(id);
  }

  recordUsage(input: UsageInput, ctx: RequestContext): Promise<Mutation<StockMutation>> {
    return this.reservationModule.recordUsage(input, ctx);
  }

  getReconciliation(revisionId: string): Promise<ReconciliationDraft | null> {
    return this.reconciliationModule.getReconciliation(revisionId);
  }

  saveReconciliationDraft(revisionId: string, input: unknown, ctx: RequestContext): Promise<Mutation<ReconciliationDraft>> {
    return this.reconciliationModule.saveReconciliationDraft(revisionId, input, ctx);
  }

  commitReconciliation(revisionId: string, input: unknown, ctx: RequestContext): Promise<Mutation<ReconciliationCommit>> {
    return this.reconciliationModule.commitReconciliation(revisionId, input, ctx);
  }

  listOffers(itemId: string | undefined, limit = 50, cursor?: string): Promise<Page<Offer>> {
    return this.offerModule.listOffers(itemId, limit, cursor);
  }

  createOffer(input: CreateOffer, ctx: RequestContext): Promise<Mutation<Offer>> {
    return this.offerModule.createOffer(input, ctx);
  }

  listArtifacts(projectId: string, query?: ArtifactListQuery) {
    return this.artifactModule.listArtifacts(projectId, query);
  }

  getArtifact(id: string) {
    return this.artifactModule.getArtifact(id);
  }

  getUploadSessionDetails(id: string): Promise<UploadSessionDetails> {
    return this.artifactModule.getUploadSessionDetails(id);
  }

  beginArtifactUpload(input: ApiBeginUpload, ctx: RequestContext): Promise<Mutation<UploadSession>> {
    return this.artifactModule.beginArtifactUpload(input, ctx);
  }

  writeArtifactUpload(sessionId: string, body: Uint8Array) {
    return this.artifactModule.writeArtifactUpload(sessionId, body);
  }

  finalizeArtifactUpload(sessionId: string, ctx: RequestContext): Promise<Mutation<Artifact>> {
    return this.artifactModule.finalizeArtifactUpload(sessionId, ctx);
  }

  readArtifact(id: string): Promise<ArtifactDownload> {
    return this.artifactModule.readArtifact(id);
  }

  retireArtifact(id: string, expectedVersion: number | undefined, ctx: RequestContext): Promise<Mutation<Artifact>> {
    return this.artifactModule.retireArtifact(id, expectedVersion, ctx);
  }
}
