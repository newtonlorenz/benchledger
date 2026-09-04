import { describe, expect, it } from "vitest";
import {
  calculateProjectSummary,
  countByState,
  filterInventory,
  formatMoney,
  formatQuantity,
  getLineLabel,
  getStockLabel,
  inventoryKindOptions,
  shoppingEligibleLines,
  shoppingOfferItemIds,
  shoppingEmptyState,
  sumMoneyByCurrency,
  unitDiagnostics
} from "./domain";
import { inventory, projects } from "./mock-data";
import type { BomLine, BomLineStatus, InventoryItem, Project } from "./domain";

describe("BenchLedger beginner-friendly domain language", () => {
  it("translates evidence states into language a first-time maker can understand", () => {
    expect(getStockLabel("available")).toEqual({ label: "Ready", tone: "good" });
    expect(getStockLabel("inspect-first")).toEqual({ label: "Check", tone: "warn" });
    expect(getStockLabel("ordered-unverified")).toEqual({ label: "Check", tone: "warn" });
    expect(getStockLabel("reserved")).toEqual({ label: "Check", tone: "warn" });
    expect(getStockLabel("depleted")).toEqual({ label: "Source", tone: "bad" });
  });

  it("filters inventory by the words a maker is likely to use", () => {
    const result = filterInventory(inventory, "PETG");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((item) => `${item.name} ${item.category} ${item.variant}`.toLowerCase().includes("petg"))).toBe(true);
  });

  it("keeps uncertain stock out of the ready-to-build count", () => {
    const summary = calculateProjectSummary(projects[0]!, inventory);
    expect(summary.readyLines).toBe(1);
    expect(summary.inspectLines).toBe(1);
    expect(summary.missingLines).toBe(2);
    expect(summary.decideLines).toBe(1);
    expect(summary.readyLines + summary.inspectLines + summary.missingLines + summary.decideLines).toBe(summary.totalLines);
  });

  it("formats money without leaking internal minor-unit details", () => {
    expect(formatMoney(2499, "EUR")).toBe("€24.99");
    expect(formatMoney(1299, "USD")).toBe("$12.99");
    expect(formatMoney(789, "GBP")).toBe("£7.89");
  });

  it("keeps shopping totals grouped by their source currency", () => {
    expect(sumMoneyByCurrency([
      { priceMinor: 2499, currency: "EUR" },
      { priceMinor: 1299, currency: "USD" },
      { priceMinor: 380, currency: "EUR" },
      { priceMinor: 789, currency: "GBP" }
    ])).toEqual({ EUR: 2879, USD: 1299, GBP: 789 });
    expect(sumMoneyByCurrency([])).toEqual({});
  });

  it("formats measured quantities with the right unit and singular language", () => {
    expect(formatQuantity(1, "each")).toBe("1 piece");
    expect(formatQuantity(2, "each")).toBe("2 pieces");
    expect(formatQuantity(1250, "g")).toBe("1,250 g");
    expect(formatQuantity(1.5, "m")).toBe("1.5 m");
    expect(formatQuantity(1, "set")).toBe("1 set");
    expect(formatQuantity(2, "set")).toBe("2 sets");
  });

  it("searches every user-facing inventory field and honours category filters", () => {
    const source: InventoryItem[] = [
      { ...inventory[0]!, id: "printer", tags: ["quiet"] },
      { ...inventory[2]!, id: "filament", location: "Shelf Z", tags: ["special spool"] },
      { ...inventory[5]!, id: "tool", description: "A calibrated bench instrument", tags: ["precision"] }
    ];

    expect(filterInventory(source, "").map((item) => item.id)).toEqual(["printer", "filament", "tool"]);
    expect(filterInventory(source, "  QUIET  ").map((item) => item.id)).toEqual(["printer"]);
    expect(filterInventory(source, "shelf z").map((item) => item.id)).toEqual(["filament"]);
    expect(filterInventory(source, "calibrated").map((item) => item.id)).toEqual(["tool"]);
    expect(filterInventory(source, "special spool").map((item) => item.id)).toEqual(["filament"]);
    expect(filterInventory(source, "printer", "Filament")).toEqual([]);
    expect(filterInventory(source, "printer", "All").map((item) => item.id)).toEqual(["printer"]);
    expect(filterInventory(source, "printer", undefined).map((item) => item.id)).toEqual(["printer"]);
  });

  it("filters inventory by kind, evidence, and verified availability", () => {
    const source: InventoryItem[] = [
      { ...inventory[0]!, id: "printer", kind: "printer", evidence: "commissioned", availableQuantity: 1 },
      { ...inventory[2]!, id: "filament", kind: "filament", evidence: "counted", availableQuantity: 540 },
      { ...inventory[5]!, id: "tool", kind: "tool", evidence: "delivered", state: "inspect-first", availableQuantity: 0 }
    ];

    expect(filterInventory(source, "", { kind: "filament" }).map((item) => item.id)).toEqual(["filament"]);
    expect(filterInventory(source, "", { evidence: "commissioned" }).map((item) => item.id)).toEqual(["printer"]);
    expect(filterInventory(source, "", { available: true }).map((item) => item.id)).toEqual(["printer", "filament"]);
    expect(filterInventory(source, "", { available: false }).map((item) => item.id)).toEqual(["tool"]);
    expect(filterInventory(source, "", { category: "Tools", evidence: "counted" })).toEqual([]);
  });

  it("filters by managed category assignment independently from semantic kind", () => {
    const source: InventoryItem[] = [
      { ...inventory[5]!, id: "tool-in-cabinet", kind: "tool", categoryNodeId: "category-cabinet", category: "Tools" },
      { ...inventory[5]!, id: "tool-in-drawer", kind: "tool", categoryNodeId: "category-drawer", category: "Tools" },
      { ...inventory[8]!, id: "electronic-in-cabinet", kind: "electronic", categoryNodeId: "category-cabinet", category: "Electronics" }
    ];

    expect(filterInventory(source, "", { categoryNodeId: "category-cabinet" }).map((item) => item.id)).toEqual([
      "tool-in-cabinet",
      "electronic-in-cabinet"
    ]);
    expect(filterInventory(source, "", { kind: "tool" }).map((item) => item.id)).toEqual([
      "tool-in-cabinet",
      "tool-in-drawer"
    ]);
  });

  it("offers every inventory kind accepted by the public API", () => {
    expect(inventoryKindOptions.map((option) => option.value)).toEqual([
      "printer",
      "tool",
      "accessory",
      "consumable",
      "electronic",
      "fastener",
      "filament",
      "wire",
      "adhesive",
      "other"
    ]);
  });

  it("distinguishes optional, missing, partial, depleted, ordered, and inspect-first BOM lines", () => {
    const item = (id: string, state: InventoryItem["state"], quantity: number, reserved = 0): InventoryItem => ({
      ...inventory[0]!,
      id,
      name: id,
      quantity,
      reserved,
      state,
      evidence: state === "available" ? "counted" : "delivered"
    });
    const lines: BomLine[] = [
      { version: 1, id: "ready", label: "ready", itemId: "ready-item", required: 2, unit: "each" },
      { version: 1, id: "partial", label: "partial", itemId: "partial-item", required: 3, unit: "each" },
      { version: 1, id: "inspect", label: "inspect", itemId: "inspect-item", required: 1, unit: "each" },
      { version: 1, id: "depleted", label: "depleted", itemId: "depleted-item", required: 1, unit: "each" },
      { version: 1, id: "ordered", label: "ordered", itemId: "ordered-item", required: 1, unit: "each" },
      { version: 1, id: "missing", label: "missing", itemId: "not-in-stock", required: 1, unit: "each" },
      { version: 1, id: "optional", label: "optional", itemId: "optional-not-in-stock", required: 1, unit: "each", optional: true }
    ];
    const project: Project = { ...projects[0]!, id: "summary-project", bom: lines };
    const summary = calculateProjectSummary(project, [
      item("ready-item", "available", 2),
      item("partial-item", "available", 1),
      item("inspect-item", "inspect-first", 1),
      item("depleted-item", "depleted", 4),
      item("ordered-item", "ordered-unverified", 4)
    ]);

    expect(summary.totalLines).toBe(7);
    expect(summary.readyLines).toBe(1);
    expect(summary.inspectLines).toBe(2);
    expect(summary.missingLines).toBe(3);
    expect(summary.optionalLines).toBe(1);
    expect(summary.lineStatuses.map((line) => [line.state, line.supplied, line.remaining])).toEqual([
      ["ready", 2, 0],
      ["partial", 1, 2],
      ["inspect-first", 0, 1],
      ["missing", 0, 1],
      ["inspect-first", 0, 1],
      ["missing", 0, 1],
      ["optional", 0, 1]
    ]);
    expect(calculateProjectSummary({ ...project, bom: [] }, []).lineStatuses).toEqual([]);
  });

  it("shows Decide for under-specified requirements and only sources safe required gaps", () => {
    const project: Project = {
      ...projects[0]!,
      id: "decision-project",
      bom: [
        { version: 1, id: "power", label: "12 V power supply", required: 1, unit: "each", constraints: { specification: { status: "insufficient", decisions: { current_or_load: "5 A" }, missingDecisions: ["voltage"] } } },
        { version: 1, id: "missing", label: "Controller", required: 1, unit: "each", constraints: { specification: { status: "sufficient", decisions: { identity: "CTRL-1" } } } },
        { version: 1, id: "optional", label: "Optional cover", required: 1, unit: "each", optional: true },
        { version: 1, id: "inspect", label: "Delivered board", itemId: "inspect", required: 1, unit: "each", constraints: { specification: { status: "sufficient", decisions: { identity: "BOARD-1" } } } },
        { version: 1, id: "conditional", label: "Conditional board", itemId: "conditional", required: 1, unit: "each", alternatives: [{ itemId: "conditional", compatible: "conditional" }] }
      ]
    };
    const summary = calculateProjectSummary(project, [
      { ...inventory[0]!, id: "inspect", name: "Delivered board", state: "inspect-first", evidence: "delivered", quantity: 1, reserved: 0 },
      { ...inventory[0]!, id: "conditional", name: "Conditional board", state: "available", evidence: "counted", quantity: 1, reserved: 0 }
    ]);

    expect(summary.lineStatuses.map((line) => [line.state, line.decision])).toEqual([
      ["specify-first", "decide"],
      ["missing", "source"],
      ["optional", "source"],
      ["inspect-first", "check"],
      ["inspect-first", "check"]
    ]);
    expect(summary.lineStatuses[0]).toMatchObject({ missingDecisions: ["voltage", "connector"] });
    expect(summary).toMatchObject({ decideLines: 1, sourceLines: 1, checkLines: 2, optionalLines: 1 });
    expect(getLineLabel("specify-first")).toEqual({ label: "Decide", tone: "info" });
  });

  it("uses the shared resolver for LED resistor decisions in offline/sample fallback", () => {
    const project: Project = {
      ...projects[0]!,
      id: "resistor-project",
      bom: [
        { version: 1, id: "resistor", label: "LED resistor", itemId: "resistor-stock", required: 1, unit: "each" },
        { version: 1, id: "board", label: "LED board resistor bracket", required: 1, unit: "each" },
        { version: 1, id: "complete", label: "LED resistor", required: 1, unit: "each", constraints: { specification: { status: "sufficient", decisions: { resistance: "330 ohm", power_rating: "0.25 W" } } } },
      ],
    };

    const summary = calculateProjectSummary(project, []);

    expect(summary.lineStatuses.map((line) => [line.state, line.decision])).toEqual([
      ["specify-first", "decide"],
      ["missing", "source"],
      ["missing", "source"],
    ]);
    expect(summary.lineStatuses[0]).toMatchObject({ missingDecisions: ["resistance", "power_rating"] });
  });

  it("keeps confirmed set conversions usable offline while mismatches remain Check", () => {
    const setItem = (id: string, unit: InventoryItem["unit"]): InventoryItem => ({
      ...inventory[0]!,
      id,
      name: id,
      unit,
      quantity: 2,
      availableQuantity: 2,
      reserved: 0,
      state: "available",
      evidence: "counted"
    });
    const converted: BomLine = {
      id: "converted",
      version: 1,
      label: "LED pack",
      required: 15,
      unit: "each",
      alternatives: [{
        itemId: "led-sets",
        compatible: "confirmed",
        reason: "Manufacturer package count",
        quantityConversion: {
          inventory: { quantity: 1, unit: "set" },
          requirement: { quantity: 8, unit: "each" },
          evidence: { basis: "package_label", observedAt: "2026-08-30T00:00:00.000Z", source: "https://example.test/led-sets" }
        }
      }]
    };
    const mismatch: BomLine = {
      id: "mismatch",
      version: 1,
      label: "Unverified set",
      required: 3,
      unit: "each",
      alternatives: [{ itemId: "unknown-set", compatible: "confirmed" }]
    };
    const project: Project = { ...projects[0]!, id: "conversion-project", bom: [converted, mismatch] };
    const summary = calculateProjectSummary(project, [setItem("led-sets", "set"), setItem("unknown-set", "set")]);

    expect(summary.lineStatuses[0]).toMatchObject({ state: "ready", decision: "ready", supplied: 15, remaining: 0 });
    expect(summary.lineStatuses[1]).toMatchObject({ state: "inspect-first", decision: "check", supplied: 0, remaining: 3 });
    expect(shoppingEligibleLines(summary).map((line) => line.line.id)).toEqual([]);
  });

  it("reports canonical unit diagnostics for connected candidates", () => {
    const line: BomLine = {
      id: "diagnostic",
      version: 1,
      label: "LED pack",
      required: 8,
      unit: "each",
      alternatives: [{
        itemId: "led-sets",
        compatible: "confirmed",
        quantityConversion: {
          inventory: { quantity: 1, unit: "set" },
          requirement: { quantity: 8, unit: "each" },
          evidence: { basis: "manufacturer_spec", observedAt: "2026-08-30T00:00:00.000Z" }
        }
      }]
    };
    const item = { ...inventory[0]!, id: "led-sets", unit: "set" as const };
    const status: BomLineStatus = {
      line,
      item,
      items: [item],
      supplied: 8,
      remaining: 0,
      state: "ready",
      decision: "ready",
      gap: {
        lineId: line.id,
        status: "supplied",
        decision: "ready",
        suppliedQuantity: 8,
        inspectQuantity: 0,
        missingQuantity: 0,
        matchedItemIds: [item.id],
        reasons: [],
        requiredQuantity: 8,
        unit: "each",
        candidates: [{ itemId: item.id, relationship: "confirmed_alternative", compatibility: "confirmed", availableQuantity: 16, suppliedQuantity: 8, inspectQuantity: 0, reason: "Conversion: 1 set = 8 each. Capacity: 2 set(s) = 16 each." }]
      }
    };
    expect(unitDiagnostics(status)).toEqual(["Conversion: 1 set = 8 each (observed 2026-08-30)."]);
  });

  it("keeps shopping proposals limited to required Source lines and explains blocked proposals", () => {
    const source: BomLineStatus[] = [
      { line: { version: 1, id: "source", label: "Insert", required: 1, unit: "each" }, supplied: 0, remaining: 1, state: "missing", decision: "source" },
      { line: { version: 1, id: "decide", label: "LED resistor", required: 1, unit: "each" }, supplied: 0, remaining: 1, state: "specify-first", decision: "decide", missingDecisions: ["resistance", "power_rating"] },
      { line: { version: 1, id: "check", label: "Delivered board", required: 1, unit: "each" }, supplied: 0, remaining: 1, state: "inspect-first", decision: "check" },
      { line: { version: 1, id: "optional", label: "Optional cover", required: 1, unit: "each", optional: true }, supplied: 0, remaining: 1, state: "optional", decision: "source" },
    ];
    const summary: ReturnType<typeof calculateProjectSummary> = {
      totalLines: source.length,
      readyLines: 0,
      inspectLines: 1,
      missingLines: 1,
      optionalLines: 1,
      readyDecisionLines: 0,
      checkLines: 1,
      decideLines: 1,
      sourceLines: 1,
      partialLines: 0,
      readinessUnavailable: false,
      lineStatuses: source,
    };

    expect(shoppingEligibleLines(summary).map((line) => line.line.id)).toEqual(["source"]);
    expect(shoppingOfferItemIds({
      ...source[0]!,
      line: { ...source[0]!.line, itemId: "exact-item", alternatives: [{ itemId: "confirmed-alt", compatible: "confirmed" }, { itemId: "conditional-alt", compatible: "conditional" }] },
      gap: {
        lineId: "source",
        status: "missing",
        decision: "source",
        suppliedQuantity: 0,
        inspectQuantity: 0,
        missingQuantity: 1,
        matchedItemIds: ["exact-item", "confirmed-alt", "conditional-alt"],
        reasons: [],
        candidates: [
          { itemId: "exact-item", relationship: "exact", compatibility: "confirmed", availableQuantity: 0, suppliedQuantity: 0, inspectQuantity: 0, reason: "Exact" },
          { itemId: "confirmed-alt", relationship: "confirmed_alternative", compatibility: "confirmed", availableQuantity: 0, suppliedQuantity: 0, inspectQuantity: 0, reason: "Confirmed" },
          { itemId: "conditional-alt", relationship: "uncertain_alternative", compatibility: "conditional", availableQuantity: 1, suppliedQuantity: 0, inspectQuantity: 1, reason: "Check" }
        ]
      }
    })).toEqual(["source", "exact-item", "confirmed-alt"]);
    expect(shoppingOfferItemIds(source[2]!)).toEqual([]);
    expect(shoppingEmptyState({ ...summary, sourceLines: 0, lineStatuses: source.slice(1) })).toEqual({
      title: "Nothing is ready to source",
      description: "1 requirement still needs a decision and 1 requirement still needs checking. Optional requirements are not included in shopping proposals.",
    });
  });

  it("combines explicit candidates and excludes stocked optional lines from required totals", () => {
    const project: Project = {
      ...projects[0]!,
      id: "candidate-project",
      bom: [
        { version: 1, id: "combined", label: "Controller pair", itemId: "controller-a", required: 2, unit: "each", alternatives: [{ itemId: "controller-b", compatible: "confirmed" }] },
        { version: 1, id: "stocked-optional", label: "Optional cover", itemId: "cover", required: 2, unit: "each", optional: true },
      ],
    };
    const counted = (id: string): InventoryItem => ({ ...inventory[0]!, id, name: id, quantity: 1, availableQuantity: 1, reserved: 0, state: "available", evidence: "counted" });

    const summary = calculateProjectSummary(project, [counted("controller-a"), counted("controller-b"), counted("cover")]);

    expect(summary.lineStatuses.map((line) => [line.state, line.decision, line.supplied])).toEqual([["ready", "ready", 2], ["partial", "source", 1]]);
    expect(summary).toMatchObject({ totalLines: 2, optionalLines: 1, readyLines: 1, readyDecisionLines: 1, sourceLines: 0 });
  });

  it("blocks source outcomes while connected readiness is unavailable", () => {
    const project: Project = {
      ...projects[0]!,
      id: "unavailable-readiness",
      readinessUnavailable: true,
      bom: [{ version: 1, id: "missing", label: "Controller", required: 1, unit: "each", constraints: { specification: { status: "sufficient", decisions: { identity: "CTRL-1" } } } }],
    };

    const summary = calculateProjectSummary(project, []);

    expect(summary.lineStatuses[0]).toMatchObject({ state: "missing", decision: "source" });
    expect(summary).toMatchObject({ readinessUnavailable: true, sourceLines: 0 });
  });

  it("uses the canonical application gap evaluation for connected projects", () => {
    const project: Project = {
      ...projects[0]!,
      bom: [
        { version: 1, id: "power", label: "12 V power supply", itemId: "misleading-stock", required: 1, unit: "each" },
        { version: 1, id: "controller", label: "Controller", required: 1, unit: "each" },
        { version: 1, id: "optional", label: "Optional cover", required: 1, unit: "each", optional: true },
      ],
      gapEvaluation: {
        lines: [
          { lineId: "power", status: "specify_first", decision: "decide", missingDecisions: ["current_or_load", "connector"], suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, matchedItemIds: [], reasons: ["Specify first."] },
          { lineId: "controller", status: "missing", decision: "source", suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, matchedItemIds: [], reasons: ["No stock."] },
          { lineId: "optional", status: "optional", decision: "source", suppliedQuantity: 0, inspectQuantity: 0, missingQuantity: 1, matchedItemIds: [], reasons: [] },
        ],
        totals: { requiredLines: 2, optionalLines: 1, readyLines: 0, checkLines: 0, decideLines: 1, sourceLines: 1, partialLines: 0, missingLines: 1 },
      },
    };
    const misleadingStock = [{ ...inventory[0]!, id: "misleading-stock", quantity: 20, availableQuantity: 20, reserved: 0, state: "available" as const }];

    const summary = calculateProjectSummary(project, misleadingStock);

    expect(summary.lineStatuses.map((line) => [line.state, line.decision])).toEqual([["specify-first", "decide"], ["missing", "source"], ["optional", "source"]]);
    expect(summary).toMatchObject({ totalLines: 3, optionalLines: 1, readyLines: 0, checkLines: 0, decideLines: 1, sourceLines: 1, partialLines: 0 });
  });

  it("subtracts reserved stock before declaring a BOM line ready", () => {
    const project: Project = { ...projects[0]!, bom: [{ version: 1, id: "reserved", label: "reserved", itemId: "reserved-item", required: 2, unit: "each" }] };
    const source = { ...inventory[0]!, id: "reserved-item", quantity: 3, reserved: 2, state: "available" as const };
    const summary = calculateProjectSummary(project, [source]);
    expect(summary.lineStatuses[0]).toMatchObject({ supplied: 1, remaining: 1, state: "partial" });
  });

  it("labels every BOM outcome for the beginner-facing UI", () => {
    expect(getLineLabel("ready")).toEqual({ label: "Ready", tone: "good" });
    expect(getLineLabel("inspect-first")).toEqual({ label: "Check", tone: "warn" });
    expect(getLineLabel("partial")).toEqual({ label: "Source", tone: "bad" });
    expect(getLineLabel("missing")).toEqual({ label: "Source", tone: "bad" });
    expect(getLineLabel("optional")).toEqual({ label: "Optional", tone: "muted" });
  });

  it("counts stock states without losing zero-valued categories", () => {
    expect(countByState([])).toEqual({ available: 0, "inspect-first": 0, "ordered-unverified": 0, reserved: 0, depleted: 0 });
    expect(countByState([
      inventory[0]!,
      { ...inventory[0]!, id: "inspect", state: "inspect-first" },
      { ...inventory[0]!, id: "ordered", state: "ordered-unverified" },
      { ...inventory[0]!, id: "reserved", state: "reserved" },
      { ...inventory[0]!, id: "depleted", state: "depleted" },
      { ...inventory[0]!, id: "available-2", state: "available" }
    ])).toEqual({ available: 2, "inspect-first": 1, "ordered-unverified": 1, reserved: 1, depleted: 1 });
  });

  it("formats money with the default currency", () => {
    expect(formatMoney(0)).toBe("€0.00");
    expect(formatMoney(100)).toBe("€1.00");
  });
});
