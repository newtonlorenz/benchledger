import type { CatalogProduct } from "@benchledger/api-contract";

/**
 * The starter catalog is deliberately a small, reviewed identity dataset. It
 * is not an inventory import and it does not assert that any of these products
 * are owned by the workspace. Keep this date in sync with the review note in
 * docs/starter-catalog.md when refreshing manufacturer facts.
 */
export const STARTER_CATALOG_DATASET_VERSION = 1;
export const STARTER_CATALOG_REVIEWED_AT = "2026-09-01T00:00:00.000Z";

const source = (sourceUrl: string, sourceLabel: string) => ({
  sourceUrl,
  sourceLabel,
  verifiedAt: STARTER_CATALOG_REVIEWED_AT,
});

const printer = (
  id: string,
  manufacturer: string,
  exactModel: string,
  buildVolumeMm: { readonly x: number; readonly y: number; readonly z: number },
  sourceUrl: string,
  exactVariant?: string,
): CatalogProduct => ({
  id,
  kind: "printer",
  manufacturer,
  exactModel,
  ...(exactVariant === undefined ? {} : { exactVariant }),
  technology: "fff",
  buildVolumeMm,
  createdAt: STARTER_CATALOG_REVIEWED_AT,
  updatedAt: STARTER_CATALOG_REVIEWED_AT,
  version: 1,
  provenance: source(sourceUrl, `${manufacturer} official product page`),
});

interface FilamentFacts {
  readonly colourName: string;
  readonly diameterMm: number;
  readonly nominalNetMassG: number;
  readonly lengthBasis: "manufacturer_declared" | "calculated" | "unknown";
  readonly colourCode?: string;
  readonly sku?: string;
  readonly nominalLengthM?: number;
  readonly densityGcm3?: number;
}

const filament = (
  id: string,
  manufacturer: string,
  productName: string,
  materialFamily: string,
  sourceUrl: string,
  facts: FilamentFacts,
  materialSubtype?: string,
): CatalogProduct => ({
  id,
  kind: "filament",
  manufacturer,
  productName,
  ...(materialSubtype === undefined ? {} : { materialSubtype }),
  materialFamily,
  ...facts,
  createdAt: STARTER_CATALOG_REVIEWED_AT,
  updatedAt: STARTER_CATALOG_REVIEWED_AT,
  version: 1,
  provenance: source(sourceUrl, `${manufacturer} official product page`),
});

// Every provenance URL points at a specific product page. Collection pages
// are useful discovery aids but do not establish the identity or variant
// facts stored in an exact catalog record.
const bambuA1Mini = "https://bambulab.com/en-us/a1-mini";
const bambuA1 = "https://bambulab.com/en-us/a1";
const bambuP1P = "https://bambulab.com/en-us/p1p";
const bambuP1S = "https://us.store.bambulab.com/products/p1s?id=583855874739507213";
const bambuX1Carbon = "https://us.store.bambulab.com/products/x1-carbon?variant=42698346037384";
const bambuX1E = "https://bambulab.com/en-us/x1e";
const bambuH2D = "https://bambulab.com/en-us/h2d";
const prusaMiniPlus = "https://www.prusa3d.com/product/original-prusa-mini-3d-printer-2/";
const prusaMk4s = "https://www.prusa3d.com/product/original-prusa-mk4s-3d-printer-7/";
const prusaCoreOne = "https://www.prusa3d.com/product/prusa-core-one-12/";
const prusaXl = "https://www.prusa3d.com/product/original-prusa-xl-3d-printer/";
const crealityEnder3V3Se = "https://store.creality.com/products/ender-3-v3-se-3d-printer";
const crealityEnder3V3Ke = "https://store.creality.com/products/ender-3-v3-ke-3d-printer";
const crealityK1 = "https://store.creality.com/products/k1-3d-printer";
const crealityK1c = "https://store.creality.com/products/k1c-3d-printer";
const crealityK1Max = "https://store.creality.com/products/k1-max-3d-printer";
const crealityK2 = "https://store.creality.com/products/k2-3d-printer";
const crealityK2Plus = "https://store.creality.com/products/k2-plus-3d-printer-with-premium-accessory-pack";
const crealityCrM4 = "https://store.creality.com/products/cr-m4-3d-printer";
const elegooNeptune4 = "https://us.elegoo.com/products/elegoo-neptune-4-fdm-3d-printer";
const elegooNeptune4Pro = "https://us.elegoo.com/products/elegoo-neptune-4-pro-fdm-3d-printer";
const elegooNeptune4Plus = "https://us.elegoo.com/products/elegoo-neptune-4-plus-fdm-3d-printer";
const elegooNeptune4Max = "https://us.elegoo.com/products/elegoo-neptune-4-max-fdm-3d-printer";
const elegooCentauriCarbon = "https://us.elegoo.com/products/centauri-carbon";
const anycubicKobra2 = "https://store.anycubic.com/products/kobra-2";
const anycubicKobra2Pro = "https://store.anycubic.com/products/kobra-2-pro";
const anycubicKobra2Max = "https://store.anycubic.com/products/kobra-2-max";
const anycubicKobra3 = "https://store.anycubic.com/products/anycubic-kobra-3";
const anycubicKobra3Combo = "https://store.anycubic.com/products/kobra-3-combo";
const anycubicKobraS1 = "https://store.anycubic.com/products/anycubic-kobra-s1";

const bambuPlaBasic = "https://us.store.bambulab.com/products/pla-basic-filament?variant=43045599019144";
const bambuPlaMatteCharcoal = "https://jp.store.bambulab.com/products/pla-matte-filament?variant=48933736743204";
const bambuPetgHf = "https://us.store.bambulab.com/products/petg-hf?from=home_web";
const bambuAbsGf = "https://us.store.bambulab.com/products/abs-gf";
const bambuAsa = "https://us.store.bambulab.com/products/asa-filament";
const bambuTpu95aHf = "https://bambulab-us.myshopify.com/products/tpu-95a-hf";
const bambuPlaCf = "https://us.store.bambulab.com/products/pla-cf?id=41158283591816";
const prusamentPla = "https://www.prusa3d.com/product/prusament-pla-jet-black-1kg/";
const prusamentPetg = "https://www.prusa3d.com/product/prusament-petg-jet-black-1kg/";
const prusamentPlaGalaxyBlack = "https://www.prusa3d.com/product/prusament-pla-prusa-galaxy-black-1kg/";
const prusamentAsa = "https://www.prusa3d.com/product/prusament-asa-jet-black-850g/";
const prusamentPcBlend = "https://www.prusa3d.com/product/prusament-pc-blend-jet-black-970g/";
const polymakerPolyLitePla = "https://shop.polymaker.com/products/polylite-pla?variant=43818025812025";
const polymakerPolyTerraPla = "https://us-wholesale.polymaker.com/products/polymaker-polyterra?variant=46581395619942";
const polymakerPolyLitePetg = "https://shop.polymaker.com/products/petg?variant=41266031132729";
const polymakerPolyMaxPetg = "https://shop.polymaker.com/products/polymax-PETG";
const polymakerPolyLiteAsa = "https://shop.polymaker.com/products/asa?variant=39574343254073";
const polymakerPolyMidePa6Gf = "https://us-wholesale.polymaker.com/products/polymide-pa6-gf";
const esunPlaPlus = "https://www.esun3d.com/pla-pro-product";
const esunPetg = "https://www.esun3d.com/petg-product/";
const esunAbsPlus = "https://www.esun3d.com/abs-pro-product";
const esunPlaMatte = "https://www.esun3d.com/epla-matte-product/";
const sunluPlaMeta = "https://www.sunlu.com/products/261";
const sunluPlaPlus = "https://uk.store.sunlu.com/products/1-75mm-sunlu-pla-plus-3d-printer-filament-1kg-roll";
const sunluPetg = "https://www.sunlu.com/products/petg-3d-printing-filament";
const sunluTpu = "https://www.sunlu.com/products/267";
const overturePla = "https://overture3d.com/products/overture-pla";
const overturePetg = "https://overture3d.com/products/overture-high-speed-petg";
const overtureTpu = "https://overture3d.com/products/overture-tpu?variant=46988794921214";

/** Curated exact FFF printer identities with only manufacturer-published core dimensions. */
export const STARTER_PRINTERS: readonly CatalogProduct[] = [
  printer("starter-printer-bambu-a1-mini", "Bambu Lab", "A1 mini", { x: 180, y: 180, z: 180 }, bambuA1Mini),
  printer("starter-printer-bambu-a1", "Bambu Lab", "A1", { x: 256, y: 256, z: 256 }, bambuA1),
  printer("starter-printer-bambu-p1p", "Bambu Lab", "P1P", { x: 256, y: 256, z: 256 }, bambuP1P),
  printer("starter-printer-bambu-p1s", "Bambu Lab", "P1S", { x: 256, y: 256, z: 256 }, bambuP1S),
  printer("starter-printer-bambu-x1-carbon", "Bambu Lab", "X1 Carbon", { x: 256, y: 256, z: 256 }, bambuX1Carbon),
  printer("starter-printer-bambu-x1e", "Bambu Lab", "X1E", { x: 256, y: 256, z: 256 }, bambuX1E),
  printer("starter-printer-bambu-h2d", "Bambu Lab", "H2D", { x: 325, y: 320, z: 325 }, bambuH2D),

  printer("starter-printer-prusa-mini-plus", "Prusa Research", "MINI+", { x: 180, y: 180, z: 180 }, prusaMiniPlus),
  printer("starter-printer-prusa-mk4s", "Prusa Research", "MK4S", { x: 250, y: 210, z: 220 }, prusaMk4s),
  printer("starter-printer-prusa-core-one", "Prusa Research", "CORE One", { x: 250, y: 220, z: 270 }, prusaCoreOne),
  printer("starter-printer-prusa-xl-single-tool", "Prusa Research", "XL", { x: 360, y: 360, z: 360 }, prusaXl, "Single-toolhead"),
  printer("starter-printer-prusa-xl-five-tool", "Prusa Research", "XL", { x: 360, y: 360, z: 360 }, prusaXl, "Five-toolhead"),

  printer("starter-printer-creality-ender-3-v3-se", "Creality", "Ender-3 V3 SE", { x: 220, y: 220, z: 250 }, crealityEnder3V3Se),
  printer("starter-printer-creality-ender-3-v3-ke", "Creality", "Ender-3 V3 KE", { x: 220, y: 220, z: 240 }, crealityEnder3V3Ke),
  printer("starter-printer-creality-k1", "Creality", "K1", { x: 220, y: 220, z: 250 }, crealityK1),
  printer("starter-printer-creality-k1c", "Creality", "K1C", { x: 220, y: 220, z: 250 }, crealityK1c),
  printer("starter-printer-creality-k1-max", "Creality", "K1 Max", { x: 300, y: 300, z: 300 }, crealityK1Max),
  printer("starter-printer-creality-k2", "Creality", "K2", { x: 260, y: 260, z: 260 }, crealityK2),
  printer("starter-printer-creality-k2-plus", "Creality", "K2 Plus", { x: 350, y: 350, z: 350 }, crealityK2Plus),
  printer("starter-printer-creality-cr-m4", "Creality", "CR-M4", { x: 450, y: 450, z: 470 }, crealityCrM4),

  printer("starter-printer-elegoo-neptune-4", "ELEGOO", "Neptune 4", { x: 225, y: 225, z: 265 }, elegooNeptune4),
  printer("starter-printer-elegoo-neptune-4-pro", "ELEGOO", "Neptune 4 Pro", { x: 225, y: 225, z: 265 }, elegooNeptune4Pro),
  printer("starter-printer-elegoo-neptune-4-plus", "ELEGOO", "Neptune 4 Plus", { x: 320, y: 320, z: 385 }, elegooNeptune4Plus),
  printer("starter-printer-elegoo-neptune-4-max", "ELEGOO", "Neptune 4 Max", { x: 420, y: 420, z: 480 }, elegooNeptune4Max),
  printer("starter-printer-elegoo-centauri-carbon", "ELEGOO", "Centauri Carbon", { x: 256, y: 256, z: 256 }, elegooCentauriCarbon),

  printer("starter-printer-anycubic-kobra-2", "Anycubic", "Kobra 2", { x: 250, y: 220, z: 220 }, anycubicKobra2),
  printer("starter-printer-anycubic-kobra-2-pro", "Anycubic", "Kobra 2 Pro", { x: 250, y: 220, z: 220 }, anycubicKobra2Pro),
  printer("starter-printer-anycubic-kobra-2-max", "Anycubic", "Kobra 2 Max", { x: 420, y: 420, z: 500 }, anycubicKobra2Max),
  printer("starter-printer-anycubic-kobra-3", "Anycubic", "Kobra 3", { x: 250, y: 250, z: 260 }, anycubicKobra3),
  printer("starter-printer-anycubic-kobra-3-combo", "Anycubic", "Kobra 3", { x: 250, y: 250, z: 260 }, anycubicKobra3Combo, "Combo"),
  printer("starter-printer-anycubic-kobra-s1", "Anycubic", "Kobra S1", { x: 250, y: 250, z: 270 }, anycubicKobraS1),
];

/** Curated exact filament identities. A missing length is intentional: it is not inferred from density. */
export const STARTER_FILAMENTS: readonly CatalogProduct[] = [
  filament("starter-filament-bambu-pla-basic-black", "Bambu Lab", "PLA Basic", "PLA", bambuPlaBasic, { colourName: "Black", colourCode: "#000000", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }),
  filament("starter-filament-bambu-pla-matte-charcoal", "Bambu Lab", "PLA Matte", "PLA", bambuPlaMatteCharcoal, { colourName: "Matte Charcoal", colourCode: "11101", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "Matte"),
  filament("starter-filament-bambu-petg-hf-black", "Bambu Lab", "PETG HF", "PETG", bambuPetgHf, { colourName: "Black", colourCode: "#000000", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "HF"),
  filament("starter-filament-bambu-abs-gf-black", "Bambu Lab", "ABS-GF", "ABS", bambuAbsGf, { colourName: "Black", colourCode: "41101", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "ABS-GF"),
  filament("starter-filament-bambu-asa-black", "Bambu Lab", "ASA", "ASA", bambuAsa, { colourName: "Black", colourCode: "#000000", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }),
  filament("starter-filament-bambu-tpu-95a-hf-black", "Bambu Lab", "TPU 95A HF", "TPU", bambuTpu95aHf, { colourName: "Black", colourCode: "51100", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "95A HF"),
  filament("starter-filament-bambu-pla-cf-black", "Bambu Lab", "PLA-CF", "PLA", bambuPlaCf, { colourName: "Black", colourCode: "#000000", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "PLA-CF"),

  filament("starter-filament-prusament-pla-jet-black", "Prusament", "PLA", "PLA", prusamentPla, { colourName: "Jet Black", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }),
  filament("starter-filament-prusament-petg-jet-black", "Prusament", "PETG", "PETG", prusamentPetg, { colourName: "Jet Black", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }),
  filament("starter-filament-prusament-asa-jet-black", "Prusament", "ASA", "ASA", prusamentAsa, { colourName: "Jet Black", diameterMm: 1.75, nominalNetMassG: 800, lengthBasis: "unknown" }),
  filament("starter-filament-prusament-pc-blend-black", "Prusament", "PC Blend", "PC", prusamentPcBlend, { colourName: "Jet Black", diameterMm: 1.75, nominalNetMassG: 900, lengthBasis: "unknown" }),
  filament("starter-filament-prusament-pla-galaxy-black", "Prusament", "PLA", "PLA", prusamentPlaGalaxyBlack, { colourName: "Prusa Galaxy Black", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "Galaxy"),

  filament("starter-filament-polymaker-polylite-pla-black", "Polymaker", "PolyLite PLA", "PLA", polymakerPolyLitePla, { colourName: "Black", colourCode: "#030305", sku: "PA02001", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown", densityGcm3: 1.19 }),
  filament("starter-filament-polymaker-polyterra-pla-charcoal-black", "Polymaker", "PolyTerra PLA", "PLA", polymakerPolyTerraPla, { colourName: "Matte Charcoal Black", colourCode: "#2F2E30", sku: "PM70820", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "PolyTerra"),
  filament("starter-filament-polymaker-polylite-petg-black", "Polymaker", "Polymaker PETG", "PETG", polymakerPolyLitePetg, { colourName: "Black", colourCode: "#070908", sku: "PB05001", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "New Formula"),
  filament("starter-filament-polymaker-polymax-petg-black", "Polymaker", "PolyMax PETG", "PETG", polymakerPolyMaxPetg, { colourName: "Black", sku: "PB02001", diameterMm: 1.75, nominalNetMassG: 750, lengthBasis: "unknown" }),
  filament("starter-filament-polymaker-polylite-asa-black", "Polymaker", "Polymaker ASA", "ASA", polymakerPolyLiteAsa, { colourName: "Black", sku: "PF01001", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "Formerly PolyLite ASA"),
  filament("starter-filament-polymaker-polymide-pa6-gf-black", "Polymaker", "PolyMide PA6-GF", "PA", polymakerPolyMidePa6Gf, { colourName: "Grey", sku: "PG02001", diameterMm: 1.75, nominalNetMassG: 500, lengthBasis: "unknown" }, "PA6-GF"),

  filament("starter-filament-esun-pla-plus-black", "eSUN", "PLA+", "PLA", esunPlaPlus, { colourName: "Black", colourCode: "#272729", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }),
  filament("starter-filament-esun-petg-black", "eSUN", "PETG", "PETG", esunPetg, { colourName: "Black", colourCode: "#272729", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }),
  filament("starter-filament-esun-abs-plus-black", "eSUN", "ABS+", "ABS", esunAbsPlus, { colourName: "Black", colourCode: "#272729", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }),
  filament("starter-filament-esun-epla-matte-black", "eSUN", "ePLA-Matte", "PLA", esunPlaMatte, { colourName: "Black", colourCode: "#272729", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "Matte"),

  filament("starter-filament-sunlu-pla-meta-black", "SUNLU", "PLA Meta", "PLA", sunluPlaMeta, { colourName: "Black", colourCode: "#000000", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "manufacturer_declared", nominalLengthM: 330 }),
  filament("starter-filament-sunlu-pla-plus-black", "SUNLU", "PLA+", "PLA", sunluPlaPlus, { colourName: "Black", colourCode: "#000000", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "manufacturer_declared", nominalLengthM: 330 }),
  filament("starter-filament-sunlu-petg-black", "SUNLU", "PETG", "PETG", sunluPetg, { colourName: "Black", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }),
  filament("starter-filament-sunlu-tpu-black", "SUNLU", "TPU", "TPU", sunluTpu, { colourName: "Black", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }),

  filament("starter-filament-overture-pla-black", "OVERTURE", "PLA", "PLA", overturePla, { colourName: "Black", colourCode: "#000000", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }),
  filament("starter-filament-overture-petg-black", "OVERTURE", "High Speed PETG", "PETG", overturePetg, { colourName: "Black", colourCode: "#000000", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "High Speed"),
  filament("starter-filament-overture-tpu-black", "OVERTURE", "TPU 95A", "TPU", overtureTpu, { colourName: "Matte Black", colourCode: "#000000", diameterMm: 1.75, nominalNetMassG: 1000, lengthBasis: "unknown" }, "95A"),
];

export const STARTER_CATALOG_PRODUCTS: readonly CatalogProduct[] = [...STARTER_PRINTERS, ...STARTER_FILAMENTS];

/** Short aliases for hosts and tests that treat the dataset as one catalog. */
export const STARTER_CATALOG = STARTER_CATALOG_PRODUCTS;
export const STARTER_CATALOG_VERSION = STARTER_CATALOG_DATASET_VERSION;
