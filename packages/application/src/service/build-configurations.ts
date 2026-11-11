import { ApplicationError, conflict, notFound } from "../errors.js";
import { isConfirmedEvidence } from "@benchledger/domain";
import type { ApplicationPorts, BuildConfigurationListOptions, Mutation, Page, RequestContext } from "../ports.js";
import { FILAMENT_CATALOG_IDENTITY_UNKNOWN, catalogPort } from "./catalog.js";
import { canonicalize, assertCompatibleInventoryUnit, boundedCursor, boundedLimit, buildConfigurationPort, nowIso, requireId } from "./shared.js";
import { buildConfigurationSnapshotSchema, createBuildConfigurationSnapshotSchema } from "@benchledger/api-contract";
import type { BuildConfigurationSnapshot, CatalogProduct, InventoryItem, InventoryProductProfile } from "@benchledger/api-contract";
import { createHash, randomUUID } from "node:crypto";
import { ServiceModule } from "./module.js";

export function configurationListOptions(query: Partial<BuildConfigurationListOptions> | undefined): BuildConfigurationListOptions {
  const cursor = boundedCursor(query?.cursor);
  return {
    limit: boundedLimit(query?.limit, 50, "limit"),
    ...(cursor === undefined ? {} : { cursor })
  };
}

export function snapshotHash(snapshot: Omit<BuildConfigurationSnapshot, "contentSha256">): string {
  const {
    id: _id,
    createdAt: _createdAt,
    projectRevisionId: _projectRevisionId,
    contentSha256: _contentSha256,
    supersedesSnapshotId: _supersedesSnapshotId,
    capturedAt: _capturedAt,
    createdBy: _createdBy,
    ...content
  } = snapshot as Partial<BuildConfigurationSnapshot>;
  return createHash("sha256").update(JSON.stringify(canonicalize(content))).digest("hex");
}

export type SnapshotSelection = BuildConfigurationSnapshot["filamentSelections"][number];

export function productForSnapshot(product: CatalogProduct, item: InventoryItem, profile: InventoryProductProfile | null): Record<string, unknown> {
  if (product.kind === "printer") {
    return {
      itemId: item.id,
      catalogProductId: product.id,
      ...(profile === null ? { linkState: "reported" as const } : { profileId: profile.id, linkState: profile.linkState }),
      name: item.name,
      manufacturer: product.manufacturer,
      exactModel: product.exactModel,
      ...(product.exactVariant === undefined ? {} : { exactVariant: product.exactVariant }),
      technology: product.technology,
      buildVolumeMm: product.buildVolumeMm
    };
  }
  return {
    itemId: item.id,
    catalogProductId: product.id,
    ...(profile === null ? { linkState: "reported" as const } : { profileId: profile.id, linkState: profile.linkState }),
    ...(product.productName === undefined ? {} : { name: product.productName }),
    manufacturer: product.manufacturer,
    ...(product.sku === undefined ? {} : { sku: product.sku }),
    ...(product.materialFamily === undefined ? {} : { materialFamily: product.materialFamily }),
    ...(product.materialSubtype === undefined ? {} : { materialSubtype: product.materialSubtype }),
    colourName: product.colourName,
    ...(product.colourCode === undefined ? {} : { colourCode: product.colourCode }),
    ...(profile?.profileType === "filament_spool" && profile.details.lot === undefined ? {} : profile?.profileType === "filament_spool" ? { lot: profile.details.lot } : {}),
    ...(profile?.profileType === "filament_spool" && profile.details.batch === undefined ? {} : profile?.profileType === "filament_spool" ? { batch: profile.details.batch } : {}),
    diameterMm: product.diameterMm,
    nominalNetMassG: product.nominalNetMassG,
    ...(product.nominalLengthM === undefined ? {} : { nominalLengthM: product.nominalLengthM }),
    lengthBasis: product.lengthBasis,
    ...(product.densityGcm3 === undefined ? {} : { densityGcm3: product.densityGcm3 })
  };
}

export async function linkedProfile(
  catalog: NonNullable<ApplicationPorts["catalog"]>,
  itemId: string,
  expectedProfileId: string | undefined,
  productId: string,
  kind: "filament" | "printer",
  unknowns: string[]
): Promise<InventoryProductProfile | null> {
  const profile = await catalog.getInventoryProductProfile(itemId);
  if (expectedProfileId !== undefined && profile === null) throw notFound("Inventory product profile", expectedProfileId);
  if (expectedProfileId !== undefined && profile?.id !== expectedProfileId) {
    throw new ApplicationError("validation", `Profile '${expectedProfileId}' is not linked to inventory item '${itemId}'`);
  }
  if (profile === null) {
    unknowns.push(`No ${kind} product profile is recorded for inventory item '${itemId}'`);
    return null;
  }
  if (profile.itemId !== itemId || profile.catalogProductId !== productId) {
    throw new ApplicationError("validation", `Product profile '${profile.id}' does not match the selected product or inventory item`);
  }
  if (profile.profileType !== (kind === "filament" ? "filament_spool" : "printer_asset")) {
    throw new ApplicationError("validation", `Product profile '${profile.id}' has the wrong profile type`);
  }
  if (profile.linkState !== "confirmed") {
    unknowns.push(`Product profile '${profile.id}' has non-confirmed link state '${profile.linkState}'`);
  }
  return profile;
}

/** Immutable, hashed build-configuration snapshots owned by a project revision. */
export class BuildConfigurationModule extends ServiceModule {
  async listBuildConfigurations(revisionId: string, query: Partial<BuildConfigurationListOptions> = {}): Promise<Page<BuildConfigurationSnapshot>> {
    const parsedRevisionId = requireId(revisionId, "project revision id");
    const options = configurationListOptions(query);
    await this.app.getProjectRevision(parsedRevisionId);
    return this.ports.unitOfWork.exclusive(() => buildConfigurationPort(this.ports).listBuildConfigurations(parsedRevisionId, options));
  }

  async getLatestBuildConfiguration(revisionId: string): Promise<BuildConfigurationSnapshot | null> {
    const parsedRevisionId = requireId(revisionId, "project revision id");
    await this.app.getProjectRevision(parsedRevisionId);
    return this.ports.unitOfWork.exclusive(async () => {
      const configuration = await buildConfigurationPort(this.ports).getLatestBuildConfiguration(parsedRevisionId);
      return configuration === null ? null : buildConfigurationSnapshotSchema.parse(configuration);
    });
  }

  async getBuildConfiguration(id: string): Promise<BuildConfigurationSnapshot> {
    const configurationId = requireId(id, "build configuration id");
    return this.ports.unitOfWork.exclusive(async () => {
      const configuration = await buildConfigurationPort(this.ports).getBuildConfiguration(configurationId);
      if (configuration === null) throw notFound("Build configuration", configurationId);
      await this.assertProjectReadableFromRevision(configuration.projectRevisionId);
      return buildConfigurationSnapshotSchema.parse(configuration);
    });
  }

  async createBuildConfiguration(revisionId: string, input: unknown, ctx: RequestContext): Promise<Mutation<BuildConfigurationSnapshot>> {
    const parsedRevisionId = requireId(revisionId, "project revision id");
    const revision = await this.app.getProjectRevision(parsedRevisionId);
    // Keep legacy revision-only adapters readable while still closing the
    // mutation boundary for archived projects in authoritative runtimes.
    const revisionProject = await this.ports.projects.getProject(revision.projectId);
    if (revisionProject?.status === "archived") {
      throw conflict(`Project '${revisionProject.id}' is archived; restore it before creating or committing work`);
    }
    if (input === null || typeof input !== "object") throw new ApplicationError("validation", "Build configuration body must be an object");
    const raw = input as Record<string, unknown>;
    if (raw.projectRevisionId !== undefined && raw.projectRevisionId !== parsedRevisionId) {
      throw new ApplicationError("validation", "projectRevisionId must match the revision path");
    }
    const supplied: Record<string, unknown> = { ...raw, projectRevisionId: parsedRevisionId };
    delete supplied.contentSha256;
    delete supplied.createdAt;
    const parsed = createBuildConfigurationSnapshotSchema.parse(supplied);
    const unknowns = [...parsed.explicitUnknowns];
    const hasPhysicalOnlyFilament = parsed.filamentSelections.some((selection) => "catalogIdentityState" in selection);
    if (hasPhysicalOnlyFilament && revision.status === "production approved") {
      throw conflict("A production-approved revision cannot use a filament with unknown catalog identity");
    }
    const catalog = catalogPort(this.ports);
    const printerItem = await this.ports.inventory.getItem(parsed.printerItemSnapshot.itemId);
    if (printerItem === null) throw notFound("Inventory item", parsed.printerItemSnapshot.itemId);
    if (printerItem.kind !== "printer") throw new ApplicationError("validation", "Build configurations require a printer inventory item");
    assertCompatibleInventoryUnit(printerItem, "Cannot use printer in build configuration");
    const printerProduct = await catalog.getProduct(parsed.printerItemSnapshot.catalogProductId);
    if (printerProduct === null) throw notFound("Catalog product", parsed.printerItemSnapshot.catalogProductId);
    if (printerProduct.kind !== "printer") throw new ApplicationError("validation", "Printer inventory item must link to a printer catalog product");
    const printerProfile = await linkedProfile(catalog, printerItem.id, parsed.printerItemSnapshot.profileId, printerProduct.id, "printer", unknowns);
    const printerItemSnapshot = productForSnapshot(printerProduct, printerItem, printerProfile) as BuildConfigurationSnapshot["printerItemSnapshot"];

    const filamentSelections: SnapshotSelection[] = [];
    for (const selection of parsed.filamentSelections) {
      const item = await this.ports.inventory.getItem(selection.itemId);
      if (item === null) throw notFound("Inventory item", selection.itemId);
      if (item.kind !== "filament") throw new ApplicationError("validation", `Inventory item '${item.id}' is not a filament`);
      assertCompatibleInventoryUnit(item, "Cannot use filament in build configuration");
      if ("catalogIdentityState" in selection) {
        if (item.retiredAt !== undefined) {
          throw new ApplicationError("validation", `Inventory item '${item.id}' is retired and cannot be selected as a physical filament`);
        }
        if (!isConfirmedEvidence(item.evidence.state)) {
          throw new ApplicationError("validation", `Inventory item '${item.id}' requires physically_counted or commissioned evidence before an unlinked filament can be selected`);
        }
        filamentSelections.push({
          itemId: item.id,
          catalogIdentityState: "unknown",
          physicalLabel: item.name,
          physicalEvidence: { ...item.evidence },
          ...(selection.role === undefined ? {} : { role: selection.role }),
          ...(selection.quantity === undefined ? {} : { quantity: selection.quantity }),
        });
        unknowns.push(FILAMENT_CATALOG_IDENTITY_UNKNOWN);
        continue;
      }
      const product = await catalog.getProduct(selection.catalogProductId);
      if (product === null) throw notFound("Catalog product", selection.catalogProductId);
      if (product.kind !== "filament") throw new ApplicationError("validation", `Catalog product '${product.id}' is not a filament`);
      const profile = await linkedProfile(catalog, item.id, selection.profileId, product.id, "filament", unknowns);
      filamentSelections.push({
        ...productForSnapshot(product, item, profile),
        ...(selection.role === undefined ? {} : { role: selection.role }),
        ...(selection.quantity === undefined ? {} : { quantity: selection.quantity }),
      } as SnapshotSelection);
    }

    const snapshotWithoutHash = {
      id: parsed.id ?? `build-config-${randomUUID()}`,
      projectRevisionId: revision.id,
      printerItemSnapshot,
      filamentSelections,
      activeHotend: parsed.activeHotend,
      nozzle: parsed.nozzle,
      plate: parsed.plate,
      accessories: parsed.accessories,
      firmware: parsed.firmware,
      slicer: parsed.slicer,
      profile: parsed.profile,
      calibration: parsed.calibration,
      explicitUnknowns: [...new Set(unknowns)].sort(),
      ...(parsed.supersedesSnapshotId === undefined ? {} : { supersedesSnapshotId: parsed.supersedesSnapshotId }),
      createdAt: nowIso()
    } satisfies Omit<BuildConfigurationSnapshot, "contentSha256">;
    if (snapshotWithoutHash.supersedesSnapshotId !== undefined) {
      const prior = await buildConfigurationPort(this.ports).getBuildConfiguration(snapshotWithoutHash.supersedesSnapshotId);
      if (prior === null) throw notFound("Build configuration", snapshotWithoutHash.supersedesSnapshotId);
      if (prior.projectRevisionId !== revision.id) throw new ApplicationError("validation", "A superseded snapshot must belong to the same project revision");
    }
    const snapshot = buildConfigurationSnapshotSchema.parse({ ...snapshotWithoutHash, contentSha256: snapshotHash(snapshotWithoutHash) });
    return this.mutate(ctx, "project.build_configuration.create", "build_configuration_snapshot", snapshot.id, async () => {
      const created = buildConfigurationSnapshotSchema.parse(await buildConfigurationPort(this.ports).createBuildConfiguration(snapshot, ctx));
      return { value: created, entityId: created.id };
    });
  }
}
