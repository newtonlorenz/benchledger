import type { z } from "zod";
import type {
  artifactSchema, auditEventSchema, beginUploadSchema, bomGapCandidateSchema, bomGapSchema, bomLineSchema, createBomLineSchema,
  commissionInventoryItemSchema, createInventoryItemSchema, createOfferSchema, createProjectRevisionSchema,
  createProjectSchema, createProjectWithInitialRevisionSchema, createReservationSchema, createWorkItemRevisionSchema,
  createWorkItemSchema, dimensionSchema, healthSchema, inventoryItemSchema,
  inventoryListQuerySchema, inventoryCategoryListQuerySchema, inventoryCategorySchema, createInventoryCategorySchema, updateInventoryCategorySchema, offerSchema, projectRevisionSchema, projectSchema, projectWithInitialRevisionSchema,
  readinessSchema, reservationSchema, stockEventInputSchema, stockEventSchema,
  updateBomLineSchema, updateInventoryItemSchema, updateProjectSchema, usageInputSchema,
  uploadSessionSchema, workItemRevisionSchema, workItemSchema,
  artifactBuildConfigurationBindingSchema, buildConfigurationSnapshotSchema, catalogProductSchema,
  catalogProductFilamentSchema, catalogProductPrinterSchema, createArtifactBuildConfigurationBindingSchema,
  buildConfigurationSnapshotStorageInputSchema, createBuildConfigurationSnapshotSchema, createCatalogProductSchema, createInventoryProductProfileSchema,
  filamentSpoolProfileDetailsSchema, inventoryProductProfileFilamentSchema, inventoryProductProfilePrinterSchema,
  inventoryProductProfileSchema, printerAssetProfileDetailsSchema, updateCatalogProductSchema,
  updateInventoryProductProfileSchema, createInventoryProductProfileWithoutItemSchema,
  createInventoryWithProductProfileSchema,
  reconciliationOutcomeKindSchema, reconciliationEvidenceSchema, reconciliationOutcomeSchema,
  reconciliationLineSchema, reconciliationBasisSchema, reconciliationBasisItemSchema,
  reconciliationBasisReservationSchema, reconciliationBasisBomLineSchema,
  reconciliationPreviewSchema, reconciliationPreviewLineSchema,
  reconciliationPreviewReservationChangeSchema, reconciliationPreviewStockChangeSchema,
  reconciliationPreviewAssetSchema, reconciliationStockChangeSchema,
  reconciliationReservationChangeSchema,
  reconciliationDraftSchema, saveReconciliationDraftSchema, commitReconciliationSchema,
  reconciliationCommitSchema
} from "./schemas.js";

export type Dimension = z.infer<typeof dimensionSchema>;
export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export type InventoryCategory = z.infer<typeof inventoryCategorySchema>;
export type InventoryCategoryListQuery = z.infer<typeof inventoryCategoryListQuerySchema>;
export type CreateInventoryCategory = z.infer<typeof createInventoryCategorySchema>;
export type UpdateInventoryCategory = z.infer<typeof updateInventoryCategorySchema>;
export type InventoryListQuery = z.infer<typeof inventoryListQuerySchema>;
export type CreateInventoryItem = z.infer<typeof createInventoryItemSchema>;
export type CommissionInventoryItem = z.infer<typeof commissionInventoryItemSchema>;
export type UpdateInventoryItem = z.infer<typeof updateInventoryItemSchema>;
export type StockEventInput = z.infer<typeof stockEventInputSchema>;
export type StockEvent = z.infer<typeof stockEventSchema>;
export type UsageInput = z.infer<typeof usageInputSchema>;
export type Project = z.infer<typeof projectSchema>;
export type CreateProject = z.infer<typeof createProjectSchema>;
export type UpdateProject = z.infer<typeof updateProjectSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;
export type CreateWorkItem = z.infer<typeof createWorkItemSchema>;
export type ProjectRevision = z.infer<typeof projectRevisionSchema>;
export type CreateProjectRevision = z.infer<typeof createProjectRevisionSchema>;
export type CreateProjectWithInitialRevision = z.infer<typeof createProjectWithInitialRevisionSchema>;
export type ProjectWithInitialRevision = z.infer<typeof projectWithInitialRevisionSchema>;
export type WorkItemRevision = z.infer<typeof workItemRevisionSchema>;
export type CreateWorkItemRevision = z.infer<typeof createWorkItemRevisionSchema>;
export type BomLine = z.infer<typeof bomLineSchema>;
export type CreateBomLine = z.infer<typeof createBomLineSchema>;
export type UpdateBomLine = z.infer<typeof updateBomLineSchema>;
export type BomGapCandidate = z.infer<typeof bomGapCandidateSchema>;
export type BomGap = z.infer<typeof bomGapSchema>;
export type Reservation = z.infer<typeof reservationSchema>;
export type CreateReservation = z.infer<typeof createReservationSchema>;
export type Offer = z.infer<typeof offerSchema>;
export type CreateOffer = z.infer<typeof createOfferSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type BeginUpload = z.infer<typeof beginUploadSchema>;
export type UploadSession = z.infer<typeof uploadSessionSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type Health = z.infer<typeof healthSchema>;
export type Readiness = z.infer<typeof readinessSchema>;
export type CatalogProduct = z.infer<typeof catalogProductSchema>;
export type CatalogProductFilament = z.infer<typeof catalogProductFilamentSchema>;
export type CatalogProductPrinter = z.infer<typeof catalogProductPrinterSchema>;
export type CreateCatalogProduct = z.infer<typeof createCatalogProductSchema>;
export type UpdateCatalogProduct = z.infer<typeof updateCatalogProductSchema>;
export type FilamentSpoolProfileDetails = z.infer<typeof filamentSpoolProfileDetailsSchema>;
export type PrinterAssetProfileDetails = z.infer<typeof printerAssetProfileDetailsSchema>;
export type InventoryProductProfile = z.infer<typeof inventoryProductProfileSchema>;
export type InventoryProductProfileFilament = z.infer<typeof inventoryProductProfileFilamentSchema>;
export type InventoryProductProfilePrinter = z.infer<typeof inventoryProductProfilePrinterSchema>;
export type CreateInventoryProductProfile = z.infer<typeof createInventoryProductProfileSchema>;
export type CreateInventoryProductProfileWithoutItem = z.infer<typeof createInventoryProductProfileWithoutItemSchema>;
export type UpdateInventoryProductProfile = z.infer<typeof updateInventoryProductProfileSchema>;
export type CreateInventoryWithProductProfile = z.infer<typeof createInventoryWithProductProfileSchema>;
export type BuildConfigurationSnapshot = z.infer<typeof buildConfigurationSnapshotSchema>;
export type CreateBuildConfigurationSnapshot = z.infer<typeof createBuildConfigurationSnapshotSchema>;
export type BuildConfigurationSnapshotStorageInput = z.infer<typeof buildConfigurationSnapshotStorageInputSchema>;
export type ArtifactBuildConfigurationBinding = z.infer<typeof artifactBuildConfigurationBindingSchema>;
export type ReconciliationOutcomeKind = z.infer<typeof reconciliationOutcomeKindSchema>;
export type ReconciliationEvidence = z.infer<typeof reconciliationEvidenceSchema>;
export type ReconciliationOutcome = z.infer<typeof reconciliationOutcomeSchema>;
export type ReconciliationLine = z.infer<typeof reconciliationLineSchema>;
export type ReconciliationBasis = z.infer<typeof reconciliationBasisSchema>;
export type ReconciliationBasisItem = z.infer<typeof reconciliationBasisItemSchema>;
export type ReconciliationBasisReservation = z.infer<typeof reconciliationBasisReservationSchema>;
export type ReconciliationBasisBomLine = z.infer<typeof reconciliationBasisBomLineSchema>;
export type ReconciliationPreview = z.infer<typeof reconciliationPreviewSchema>;
export type ReconciliationPreviewLine = z.infer<typeof reconciliationPreviewLineSchema>;
export type ReconciliationPreviewReservationChange = z.infer<typeof reconciliationPreviewReservationChangeSchema>;
export type ReconciliationPreviewStockChange = z.infer<typeof reconciliationPreviewStockChangeSchema>;
export type ReconciliationPreviewAsset = z.infer<typeof reconciliationPreviewAssetSchema>;
export type ReconciliationStockChange = z.infer<typeof reconciliationStockChangeSchema>;
export type ReconciliationReservationChange = z.infer<typeof reconciliationReservationChangeSchema>;
export type ReconciliationDraft = z.infer<typeof reconciliationDraftSchema>;
export type SaveReconciliationDraft = z.infer<typeof saveReconciliationDraftSchema>;
export type CommitReconciliation = z.infer<typeof commitReconciliationSchema>;
export type ReconciliationCommit = z.infer<typeof reconciliationCommitSchema>;
export type CreateArtifactBuildConfigurationBinding = z.infer<typeof createArtifactBuildConfigurationBindingSchema>;
