import { describe, expect, it } from "vitest";
import {
  calculateProjectSummary,
  countByState,
  filterInventory,
  formatMoney,
  formatQuantity,
  getLineLabel,
  getStockLabel,
  sumMoneyByCurrency
} from "./domain";
import { inventory, projects } from "./mock-data";
import type { BomLine, InventoryItem, Project } from "./domain";

describe("BenchLedger beginner-friendly domain language", () => {
  it("translates evidence states into language a first-time maker can understand", () => {
    expect(getStockLabel("available")).toEqual({ label: "Ready to use", tone: "good" });
    expect(getStockLabel("inspect-first")).toEqual({ label: "Check quantity", tone: "warn" });
    expect(getStockLabel("ordered-unverified")).toEqual({ label: "Ordered, not verified", tone: "muted" });
    expect(getStockLabel("reserved")).toEqual({ label: "Reserved", tone: "warn" });
    expect(getStockLabel("depleted")).toEqual({ label: "Need to buy", tone: "bad" });
  });

  it("filters inventory by the words a maker is likely to use", () => {
    const result = filterInventory(inventory, "PETG");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((item) => `${item.name} ${item.category} ${item.variant}`.toLowerCase().includes("petg"))).toBe(true);
  });

  it("keeps uncertain stock out of the ready-to-build count", () => {
    const summary = calculateProjectSummary(projects[0]!, inventory);
    expect(summary.readyLines).toBe(2);
    expect(summary.inspectLines).toBe(1);
    expect(summary.missingLines).toBe(2);
    expect(summary.readyLines + summary.inspectLines + summary.missingLines).toBe(summary.totalLines);
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
      { id: "ready", label: "ready", itemId: "ready-item", required: 2, unit: "each" },
      { id: "partial", label: "partial", itemId: "partial-item", required: 3, unit: "each" },
      { id: "inspect", label: "inspect", itemId: "inspect-item", required: 1, unit: "each" },
      { id: "depleted", label: "depleted", itemId: "depleted-item", required: 1, unit: "each" },
      { id: "ordered", label: "ordered", itemId: "ordered-item", required: 1, unit: "each" },
      { id: "missing", label: "missing", itemId: "not-in-stock", required: 1, unit: "each" },
      { id: "optional", label: "optional", itemId: "optional-not-in-stock", required: 1, unit: "each", optional: true }
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
    expect(summary.inspectLines).toBe(1);
    expect(summary.missingLines).toBe(4);
    expect(summary.optionalLines).toBe(1);
    expect(summary.lineStatuses.map((line) => [line.state, line.supplied, line.remaining])).toEqual([
      ["ready", 2, 0],
      ["partial", 1, 2],
      ["inspect-first", 1, 0],
      ["partial", 1, 0],
      ["partial", 1, 0],
      ["missing", 0, 1],
      ["optional", 0, 1]
    ]);
    expect(calculateProjectSummary({ ...project, bom: [] }, []).lineStatuses).toEqual([]);
  });

  it("subtracts reserved stock before declaring a BOM line ready", () => {
    const project: Project = { ...projects[0]!, bom: [{ id: "reserved", label: "reserved", itemId: "reserved-item", required: 2, unit: "each" }] };
    const source = { ...inventory[0]!, id: "reserved-item", quantity: 3, reserved: 2, state: "available" as const };
    const summary = calculateProjectSummary(project, [source]);
    expect(summary.lineStatuses[0]).toMatchObject({ supplied: 1, remaining: 1, state: "partial" });
  });

  it("labels every BOM outcome for the beginner-facing UI", () => {
    expect(getLineLabel("ready")).toEqual({ label: "Ready to use", tone: "good" });
    expect(getLineLabel("inspect-first")).toEqual({ label: "Check quantity", tone: "warn" });
    expect(getLineLabel("partial")).toEqual({ label: "Partly covered", tone: "warn" });
    expect(getLineLabel("missing")).toEqual({ label: "Need to buy", tone: "bad" });
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
