import type { Artifact, CatalogProduct, InventoryItem, Offer, Project } from "./domain";

/**
 * Public, synthetic fixtures only. The API adapter swaps this data for the
 * private instance once the server is available.
 */
export const inventory: InventoryItem[] = [
  {
    id: "eq-h2d",
    name: "Bambu Lab H2D",
    category: "Printers",
    variant: "H2D AMS Combo · 0.4 mm",
    description: "Dual-nozzle enclosed FFF printer with AMS 2 Pro and AMS HT.",
    quantity: 1,
    unit: "each",
    reserved: 0,
    state: "available",
    evidence: "commissioned",
    location: "Print room",
    dimensions: { length: 325, width: 320, height: 325, unit: "mm" },
    manufacturer: "Bambu Lab",
    sku: "H2D-AMS-COMBO",
    tags: ["fff", "dual nozzle", "enclosed"],
    compatibility: ["Bambu Studio", "AMS 2 Pro", "AMS HT"],
    lastCounted: "2026-08-28",
    accent: "teal"
  },
  {
    id: "eq-ender",
    name: "Creality Ender-3 V3 SE",
    category: "Printers",
    variant: "Ender-3 V3 SE · 0.4 mm",
    description: "Open-frame FFF printer for coupons and quick prototypes.",
    quantity: 1,
    unit: "each",
    reserved: 0,
    state: "available",
    evidence: "commissioned",
    location: "Print room",
    dimensions: { length: 220, width: 220, height: 250, unit: "mm" },
    manufacturer: "Creality",
    sku: "ENDER-3-V3-SE",
    tags: ["fff", "coupon", "prototype"],
    compatibility: ["Cura 5.13"],
    lastCounted: "2026-08-28",
    accent: "blue"
  },
  {
    id: "mat-petg-black",
    name: "PETG HF · Black",
    category: "Filament",
    variant: "Bambu PETG HF · 1 kg spool",
    description: "Fast PETG for functional parts and the current lamp enclosure.",
    quantity: 680,
    unit: "g",
    reserved: 140,
    state: "available",
    evidence: "counted",
    location: "Filament shelf A",
    dimensions: { diameter: 1.75, unit: "mm" },
    manufacturer: "Bambu Lab",
    sku: "PETG-HF-BLK-1KG",
    tags: ["petg", "black", "functional", "dry box"],
    compatibility: ["Bambu H2D", "Ender-3 V3 SE"],
    lastCounted: "2026-08-29",
    accent: "slate"
  },
  {
    id: "mat-pla-sage",
    name: "PLA Basic · Sage",
    category: "Filament",
    variant: "Bambu PLA Basic · 1 kg spool",
    description: "General-purpose PLA for fit checks and display parts.",
    quantity: 920,
    unit: "g",
    reserved: 0,
    state: "available",
    evidence: "counted",
    location: "Filament shelf A",
    dimensions: { diameter: 1.75, unit: "mm" },
    manufacturer: "Bambu Lab",
    sku: "PLA-BSC-SAGE-1KG",
    tags: ["pla", "sage", "prototype"],
    compatibility: ["Bambu H2D", "Ender-3 V3 SE"],
    lastCounted: "2026-08-29",
    accent: "teal"
  },
  {
    id: "tool-caliper",
    name: "Digital caliper",
    category: "Tools",
    variant: "150 mm · 0.01 mm resolution",
    description: "Measuring tool for fit-critical interfaces and inspection.",
    quantity: 1,
    unit: "each",
    reserved: 0,
    state: "available",
    evidence: "counted",
    location: "Workbench drawer 1",
    dimensions: { length: 240, width: 75, height: 15, unit: "mm" },
    manufacturer: "Mitutoyo",
    sku: "CAL-150-01",
    tags: ["measure", "inspection", "fit"],
    compatibility: ["All projects"],
    lastCounted: "2026-08-26",
    accent: "blue"
  },
  {
    id: "tool-soldering",
    name: "Temperature-controlled soldering iron",
    category: "Tools",
    variant: "65 W · 200–480 °C",
    description: "Bench soldering iron with fine tip for electronics work.",
    quantity: 1,
    unit: "each",
    reserved: 0,
    state: "available",
    evidence: "counted",
    location: "Electronics bench",
    manufacturer: "Pinecil",
    sku: "PINECIL-V2",
    tags: ["solder", "electronics", "usb-c"],
    compatibility: ["Lead-free solder", "JST connectors"],
    lastCounted: "2026-08-26",
    accent: "orange"
  },
  {
    id: "acc-nozzle-02",
    name: "H2D 0.2 mm hotend",
    category: "Accessories",
    variant: "Hardened steel · 0.2 mm",
    description: "Fine-detail hotend for small text and precision features.",
    quantity: 1,
    unit: "each",
    reserved: 0,
    state: "available",
    evidence: "counted",
    location: "Printer spares box",
    manufacturer: "Bambu Lab",
    sku: "H2D-HOTEND-02",
    tags: ["h2d", "hotend", "fine detail"],
    compatibility: ["Bambu Lab H2D"],
    lastCounted: "2026-08-27",
    accent: "yellow"
  },
  {
    id: "acc-nozzle-06",
    name: "H2D 0.6 mm hotend",
    category: "Accessories",
    variant: "Hardened steel · 0.6 mm",
    description: "High-flow hotend for larger functional parts.",
    quantity: 1,
    unit: "each",
    reserved: 0,
    state: "available",
    evidence: "counted",
    location: "Printer spares box",
    manufacturer: "Bambu Lab",
    sku: "H2D-HOTEND-06",
    tags: ["h2d", "hotend", "high flow"],
    compatibility: ["Bambu Lab H2D"],
    lastCounted: "2026-08-27",
    accent: "yellow"
  },
  {
    id: "elec-esp32",
    name: "ESP32 DevKitC",
    category: "Electronics",
    variant: "ESP32-WROOM-32E · USB-C",
    description: "Wi-Fi and Bluetooth microcontroller development board.",
    quantity: 4,
    unit: "each",
    reserved: 1,
    state: "available",
    evidence: "counted",
    location: "Electronics bin E2",
    dimensions: { length: 51, width: 28, height: 13, unit: "mm" },
    manufacturer: "Espressif",
    sku: "ESP32-DEVKITC-32E",
    tags: ["esp32", "wifi", "bluetooth", "microcontroller"],
    compatibility: ["Arduino", "PlatformIO", "3.3 V logic"],
    lastCounted: "2026-08-25",
    accent: "teal"
  },
  {
    id: "elec-wire",
    name: "Silicone hookup wire",
    category: "Wire & cable",
    variant: "22 AWG · assorted colours",
    description: "Flexible stranded wire for low-voltage prototypes.",
    quantity: 18,
    unit: "m",
    reserved: 3,
    state: "available",
    evidence: "counted",
    location: "Electronics bin W1",
    dimensions: { diameter: 1.7, unit: "mm" },
    tags: ["wire", "22 awg", "silicone", "low voltage"],
    compatibility: ["ESP32", "5 V projects"],
    lastCounted: "2026-08-25",
    accent: "orange"
  },
  {
    id: "fast-m3-inserts",
    name: "M3 heat-set inserts",
    category: "Fasteners",
    variant: "Brass knurled · 5 mm length",
    description: "Threaded inserts for serviceable printed enclosures.",
    quantity: 12,
    unit: "each",
    reserved: 0,
    state: "inspect-first",
    evidence: "delivered",
    location: "Fasteners drawer M3",
    dimensions: { diameter: 4.6, height: 5, unit: "mm" },
    manufacturer: "Ruthex",
    sku: "RX-M3-5",
    tags: ["m3", "insert", "brass", "threaded"],
    compatibility: ["PETG", "PLA", "0.4 mm nozzle"],
    lastCounted: "2026-08-12",
    accent: "yellow"
  },
  {
    id: "fast-m3-bolts",
    name: "M3 × 12 mm socket screws",
    category: "Fasteners",
    variant: "Stainless steel · pack of 25",
    description: "Machine screws for printed assemblies.",
    quantity: 25,
    unit: "each",
    reserved: 6,
    state: "available",
    evidence: "counted",
    location: "Fasteners drawer M3",
    dimensions: { diameter: 3, height: 12, unit: "mm" },
    tags: ["m3", "12 mm", "stainless", "socket"],
    compatibility: ["M3 heat-set inserts"],
    lastCounted: "2026-08-24",
    accent: "slate"
  },
  {
    id: "acc-ams-dryer",
    name: "AMS HT filament dryer",
    category: "Accessories",
    variant: "AMS HT · single spool",
    description: "Drying and storage accessory for moisture-sensitive materials.",
    quantity: 1,
    unit: "each",
    reserved: 0,
    state: "available",
    evidence: "commissioned",
    location: "Print room",
    manufacturer: "Bambu Lab",
    sku: "AMS-HT",
    tags: ["dryer", "filament", "ams"],
    compatibility: ["Bambu PETG HF", "Bambu H2D"],
    lastCounted: "2026-08-28",
    accent: "teal"
  },
  {
    id: "elec-header",
    name: "2.54 mm pin headers",
    category: "Electronics",
    variant: "Male breakaway · 40 pin",
    description: "Breakaway headers for breadboards and custom PCBs.",
    quantity: 8,
    unit: "each",
    reserved: 0,
    state: "ordered-unverified",
    evidence: "ordered",
    location: "Incoming",
    dimensions: { length: 102, width: 2.54, height: 8.5, unit: "mm" },
    tags: ["header", "2.54 mm", "electronics"],
    compatibility: ["ESP32 DevKitC", "Breadboard"],
    accent: "slate"
  }
];

const lampArtifacts: Artifact[] = [
  { id: "a-lamp-cad", name: "autonomous-lamp.scad", role: "Editable CAD", revision: "r03", size: "42 KB", hash: "sha256: 7d9e…e13a", updated: "2 hours ago", status: "candidate" },
  { id: "a-lamp-step", name: "autonomous-lamp.step", role: "STEP", revision: "r03", size: "1.8 MB", hash: "sha256: 1a67…0c91", updated: "2 hours ago", status: "candidate" },
  { id: "a-lamp-3mf", name: "h2d-lamp-r03.3mf", role: "Build plate", revision: "r03", size: "836 KB", hash: "sha256: b1fa…a044", updated: "1 hour ago", status: "validated", machine: "Bambu Lab H2D · 0.4 mm", material: "PETG HF · Black" },
  { id: "a-lamp-report", name: "fit-notes.md", role: "Validation", revision: "r02", size: "6 KB", hash: "sha256: 95a2…7b11", updated: "Yesterday", status: "validated" }
];

export const projects: Project[] = [
  {
    id: "project-lamp",
    name: "Autonomous lamp",
    subtitle: "A responsive desk light with a printed enclosure",
    description: "Explore a small servo-driven lamp with an ESP32 controller and a serviceable printed shell.",
    status: "building",
    updated: "Today, 09:42",
    currentRevision: "r03",
    workItem: "H2D robot enclosure",
    railStep: 3,
    bom: [
      { id: "bom-h2d", label: "H2D printer", itemId: "eq-h2d", required: 1, unit: "each", note: "Single-nozzle print · 0.4 mm" },
      { id: "bom-petg", label: "PETG HF · Black", itemId: "mat-petg-black", required: 400, unit: "g", note: "Estimated from r03 plate" },
      { id: "bom-inserts", label: "M3 heat-set inserts", itemId: "fast-m3-inserts", required: 8, unit: "each", note: "Physical count needed before allocation" },
      { id: "bom-servo", label: "STS3215 smart servo", required: 1, unit: "each", note: "Requires 6 V supply and serial control" },
      { id: "bom-led-resistor", label: "LED resistor", required: 1, unit: "each", note: "Resolve resistance and power rating before sourcing" },
      { id: "bom-bearing", label: "608-2RS bearing", required: 2, unit: "each", note: "8 × 22 × 7 mm" }
    ],
    artifacts: lampArtifacts,
    notes: ["r03 moved the service hatch away from the support face.", "Need a measured 608 bearing before freezing the axis clearance."],
    accent: "orange"
  },
  {
    id: "project-circadian",
    name: "Horizon wallwash",
    subtitle: "A low-glare circadian night light",
    description: "A soft wallwash lamp with a replaceable diffuser and a measured inner aperture.",
    status: "building",
    updated: "Yesterday",
    currentRevision: "r09",
    workItem: "Wallwash body",
    railStep: 4,
    bom: [
      { id: "bom-wall-h2d", label: "H2D printer", itemId: "eq-h2d", required: 1, unit: "each" },
      { id: "bom-wall-petg", label: "PETG HF · Black", itemId: "mat-petg-black", required: 220, unit: "g" },
      { id: "bom-wall-esp", label: "ESP32 DevKitC", itemId: "elec-esp32", required: 1, unit: "each" },
      { id: "bom-wall-wire", label: "Silicone hookup wire", itemId: "elec-wire", required: 2, unit: "m" },
      { id: "bom-wall-diffuser", label: "Opal diffuser sheet", required: 1, unit: "each", optional: true }
    ],
    artifacts: [
      { id: "a-wall-cad", name: "horizon-wallwash.scad", role: "Editable CAD", revision: "r09", size: "36 KB", hash: "sha256: 82ca…11d0", updated: "Yesterday", status: "candidate" },
      { id: "a-wall-3mf", name: "horizon-wallwash.3mf", role: "Build plate", revision: "r09", size: "512 KB", hash: "sha256: 70e8…3a11", updated: "Yesterday", status: "validated", machine: "Bambu Lab H2D · 0.4 mm", material: "PETG HF · Black" },
      { id: "a-wall-report", name: "validation-report.md", role: "Validation", revision: "r08", size: "11 KB", hash: "sha256: 0f3a…a670", updated: "3 days ago", status: "validated" }
    ],
    notes: ["Melanopic-EDI research notes are linked from the project context."],
    accent: "teal"
  },
  {
    id: "project-battery",
    name: "Memory Loop v2",
    subtitle: "A chaptered audio player enclosure",
    description: "Modular shell and service door for a small family audio player.",
    status: "complete",
    updated: "12 Aug 2026",
    currentRevision: "r02",
    workItem: "Shell assembly",
    railStep: 5,
    bom: [
      { id: "bom-battery-ender", label: "Ender-3 V3 SE", itemId: "eq-ender", required: 1, unit: "each" },
      { id: "bom-battery-pla", label: "PLA Basic · Sage", itemId: "mat-pla-sage", required: 560, unit: "g" },
      { id: "bom-battery-wire", label: "Silicone hookup wire", itemId: "elec-wire", required: 1, unit: "m" },
      { id: "bom-battery-esp", label: "ESP32 DevKitC", itemId: "elec-esp32", required: 1, unit: "each" }
    ],
    artifacts: [
      { id: "a-battery-cad", name: "memory_loop_v2.scad", role: "Editable CAD", revision: "r02", size: "28 KB", hash: "sha256: 8c07…a022", updated: "12 Aug 2026", status: "validated" },
      { id: "a-battery-plate", name: "plate-shell.3mf", role: "Build plate", revision: "r02", size: "421 KB", hash: "sha256: 0c3e…88b4", updated: "12 Aug 2026", status: "validated", machine: "Creality Ender-3 V3 SE · 0.4 mm", material: "PLA Basic · Sage" },
      { id: "a-battery-validation", name: "validation-manifest.json", role: "Validation", revision: "r02", size: "3 KB", hash: "sha256: 9dd2…e031", updated: "12 Aug 2026", status: "validated" }
    ],
    notes: ["Fit/function verified after the service door coupon."],
    accent: "blue"
  }
];

export const offers: Offer[] = [
  { id: "offer-servo-1", itemId: "bom-servo", supplier: "RobotShop", title: "STS3215 serial bus servo", priceMinor: 2499, currency: "EUR", pack: "1 piece", eta: "3–5 days", url: "https://example.com/robotshop/sts3215", observed: "30 Aug 2026", preferred: true },
  { id: "offer-servo-2", itemId: "bom-servo", supplier: "Makersupply", title: "STS3215 smart servo · metal gear", priceMinor: 2890, currency: "EUR", pack: "1 piece", eta: "1 week", url: "https://example.com/makersupply/sts3215", observed: "28 Aug 2026" },
  { id: "offer-bearing-1", itemId: "bom-bearing", supplier: "123Bearing", title: "608-2RS sealed bearing", priceMinor: 380, currency: "EUR", pack: "2 pieces", eta: "2–4 days", url: "https://example.com/123bearing/608-2rs", observed: "30 Aug 2026", preferred: true },
  { id: "offer-bearing-2", itemId: "bom-bearing", supplier: "Local hardware", title: "608 skate bearing", priceMinor: 650, currency: "EUR", pack: "4 pieces", eta: "Check local stock", url: "https://example.com/local/608", observed: "20 Aug 2026" },
  { id: "offer-diffuser", itemId: "bom-wall-diffuser", supplier: "LightParts", title: "Opal acrylic diffuser 2 mm", priceMinor: 1190, currency: "EUR", pack: "A4 sheet", eta: "4–6 days", url: "https://example.com/lightparts/opal-a4", observed: "29 Aug 2026" }
];

export const activity = [
  { id: "activity-1", title: "r03 build plate added", detail: "H2D robot enclosure · 3MF · verified hash", time: "1 hour ago", tone: "good" as const },
  { id: "activity-2", title: "PETG HF counted", detail: "680 g remaining · Filament shelf A", time: "Yesterday", tone: "good" as const },
  { id: "activity-3", title: "M3 inserts need a count", detail: "Delivery evidence is not a physical count", time: "18 days ago", tone: "warn" as const },
  { id: "activity-4", title: "Horizon wallwash r09 revised", detail: "sealed_inner_aperture · design-open", time: "21 Aug 2026", tone: "info" as const }
];

export const categoryOptions = ["All", "Printers", "Filament", "Tools", "Accessories", "Electronics", "Fasteners", "Wire & cable"] as const;

/** Synthetic catalog records used only by sample mode and unit-level adapter
 * checks. Legacy inventory above intentionally has no product link so the
 * guided confirmation copy stays visible until a user completes it. */
export const catalogProducts: CatalogProduct[] = [
  {
    id: "catalog-h2d",
    kind: "printer",
    manufacturer: "Bambu Lab",
    family: "H2D",
    model: "H2D",
    variant: "AMS Combo",
    productCode: "H2D-AMS-COMBO",
    version: 1,
    evidence: "manufacturer"
  },
  {
    id: "catalog-ender-v3-se",
    kind: "printer",
    manufacturer: "Creality",
    family: "Ender",
    model: "Ender-3 V3 SE",
    variant: "Standard",
    productCode: "ENDER-3-V3-SE",
    version: 1,
    evidence: "manufacturer"
  },
  {
    id: "catalog-bambu-petg-hf-black",
    kind: "filament",
    manufacturer: "Bambu Lab",
    family: "PETG HF",
    model: "PETG HF",
    variant: "1 kg spool",
    colour: "Black",
    colourCode: "#000000",
    diameterMm: 1.75,
    netMassG: 1000,
    productCode: "PETG-HF-BLK-1KG",
    version: 1,
    evidence: "manufacturer"
  },
  {
    id: "catalog-bambu-pla-basic-sage",
    kind: "filament",
    manufacturer: "Bambu Lab",
    family: "PLA Basic",
    model: "PLA Basic",
    variant: "1 kg spool",
    colour: "Sage",
    colourCode: "#8A9A75",
    diameterMm: 1.75,
    netMassG: 1000,
    productCode: "PLA-BSC-SAGE-1KG",
    version: 1,
    evidence: "manufacturer"
  }
];

export const capabilityGroups = [
  {
    title: "Inventory",
    description: "Check recorded stock before you propose a purchase.",
    tools: ["list_inventory", "read_inventory_item", "record_stock_event", "list_stock_events"]
  },
  {
    title: "Projects & BOMs",
    description: "Move from an idea to a gap-aware build plan.",
    tools: ["list_projects", "read_project", "create_project_revision", "calculate_bom_gaps", "create_reservation"]
  },
  {
    title: "Project files",
    description: "Inspect source, exports, and evidence without losing revisions.",
    tools: ["list_artifacts", "read_artifact_metadata", "create_artifact_revision"]
  },
  {
    title: "Procurement",
    description: "Compare recorded offers. BenchLedger has no purchase authority.",
    tools: ["list_offers", "record_offer_snapshot"]
  }
];
