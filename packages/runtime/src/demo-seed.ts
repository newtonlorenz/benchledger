import type { CreateCatalogProduct, CreateInventoryItem, CreateInventoryProductProfile, CreateBomLine } from "@benchledger/api-contract";
import type { ApplicationPorts, RequestContext } from "@benchledger/application";

/**
 * Synthetic demo workspace content. Every identifier and value is fictional
 * reference data; the web e2e suite and the mobile demo depend on these IDs.
 *
 * The seed is written through the same ports as normal mutations, so stock
 * ledgers, versions and evidence are produced by the production adapters
 * instead of being hand-built. It intentionally does not append audit
 * events: the demo starts with an empty history, like a fresh workspace.
 */
export const SYNTHETIC_DEMO_SOURCE = "synthetic-demo";
export const SYNTHETIC_DEMO_PROJECT_ID = "synthetic-project-lamp";
export const SYNTHETIC_DEMO_REVISION_ID = "synthetic-revision-lamp-r01";

const SEED_CONTEXT: RequestContext = {
  actor: "system:demo-seed",
  source: "system",
  correlationId: "demo-seed",
  scopes: new Set(["read", "write"])
};

const SEED_TIMESTAMP = "2026-08-30T00:00:00.000Z";

export const SYNTHETIC_DEMO_INVENTORY: readonly CreateInventoryItem[] = [
  { id: "printer-h2d", name: "Bambu Lab H2D", kind: "printer", quantity: 1, availableQuantity: 1, unit: "each", tags: ["3d-printing", "bambu"], links: [], evidence: { state: "commissioned", source: SYNTHETIC_DEMO_SOURCE } },
  { id: "filament-petg-hf", name: "Bambu PETG HF", kind: "filament", quantity: 1000, availableQuantity: 1000, unit: "gram", tags: ["petg", "bambu"], links: [], evidence: { state: "physically_counted", source: SYNTHETIC_DEMO_SOURCE } },
  { id: "board-esp32", name: "ESP32 development board", kind: "electronic", quantity: 2, availableQuantity: 2, unit: "each", tags: ["esp32", "microcontroller"], links: [], evidence: { state: "physically_counted", source: SYNTHETIC_DEMO_SOURCE } },
  { id: "wire-dupont", name: "Dupont jumper wire assortment", kind: "wire", quantity: 1, availableQuantity: 0, unit: "set", tags: ["wire", "electronics"], links: [], evidence: { state: "delivered_uncounted", source: SYNTHETIC_DEMO_SOURCE } }
];

const SYNTHETIC_DEMO_CATALOG: readonly (CreateCatalogProduct & { readonly id: string; readonly createdAt: string; readonly updatedAt: string })[] = [
  { id: "catalog-printer-h2d", kind: "printer", manufacturer: "Bambu Lab", exactModel: "H2D", technology: "fff", buildVolumeMm: { x: 325, y: 320, z: 325 }, createdAt: SEED_TIMESTAMP, updatedAt: SEED_TIMESTAMP },
  {
    id: "catalog-filament-petg-hf", kind: "filament", manufacturer: "Bambu Lab", productName: "PETG HF", materialFamily: "PETG", colourName: "Black",
    diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown", createdAt: SEED_TIMESTAMP, updatedAt: SEED_TIMESTAMP
  }
] as never;

const SYNTHETIC_DEMO_PROFILES: readonly { readonly itemId: string; readonly profile: CreateInventoryProductProfile & { readonly id: string } }[] = [
  { itemId: "printer-h2d", profile: { id: "profile-printer-h2d", catalogProductId: "catalog-printer-h2d", profileType: "printer_asset", linkState: "confirmed", details: { assetLabel: "Synthetic H2D" } } as never },
  { itemId: "filament-petg-hf", profile: { id: "profile-filament-petg-hf", catalogProductId: "catalog-filament-petg-hf", profileType: "filament_spool", linkState: "confirmed", details: { openedState: "sealed" } } as never }
];

const SYNTHETIC_DEMO_BOM: readonly CreateBomLine[] = [
  { id: "synthetic-bom-filament", name: "Bambu PETG HF", role: "consumed", itemId: "filament-petg-hf", requiredQuantity: 250, unit: "gram", optional: false, constraints: {}, alternatives: [], notes: "Representative material allowance for the first prototype." },
  { id: "synthetic-bom-board", name: "ESP32 development board", role: "consumed", itemId: "board-esp32", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] },
  { id: "synthetic-bom-wire", name: "Dupont jumper wire assortment", role: "consumed", itemId: "wire-dupont", requiredQuantity: 1, unit: "set", optional: false, constraints: {}, alternatives: [], notes: "Delivery is recorded; physical count is still required." },
  { id: "synthetic-bom-fasteners", name: "M3 mounting screws", role: "consumed", requiredQuantity: 4, unit: "each", optional: false, constraints: { kind: "fastener" }, alternatives: [], notes: "Synthetic missing line to exercise shopping guidance." }
];

/** Write the synthetic demo workspace through the runtime ports in one transaction. */
export async function seedSyntheticDemoWorkspace(ports: ApplicationPorts): Promise<void> {
  await ports.unitOfWork.transactional(async () => {
    for (const item of SYNTHETIC_DEMO_INVENTORY) await ports.inventory.createItem(item, SEED_CONTEXT);
    if (ports.catalog !== undefined) {
      for (const product of SYNTHETIC_DEMO_CATALOG) await ports.catalog.createProduct(product, SEED_CONTEXT);
      for (const { itemId, profile } of SYNTHETIC_DEMO_PROFILES) await ports.catalog.putInventoryProductProfile(itemId, profile, undefined, SEED_CONTEXT);
    }
    const create = ports.projects.createProjectWithInitialRevision;
    if (create === undefined) throw new Error("demo seed requires atomic project creation");
    await create.call(ports.projects, {
      project: {
        id: SYNTHETIC_DEMO_PROJECT_ID,
        name: "Synthetic H2D desk lamp",
        description: "Synthetic reference project covering reuse, inspect-first stock, and a missing requirement.",
        status: "planned"
      },
      revision: {
        id: SYNTHETIC_DEMO_REVISION_ID,
        name: "Initial concept",
        notes: "Synthetic reference project for the guided planning flow.",
        status: "concept",
        fabricationRoute: "undecided"
      }
    }, SEED_CONTEXT);
    for (const line of SYNTHETIC_DEMO_BOM) await ports.projects.createBomLine(SYNTHETIC_DEMO_REVISION_ID, line, SEED_CONTEXT);
  });
}
