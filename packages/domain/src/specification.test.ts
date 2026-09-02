import { describe, expect, it } from "vitest";
import {
  createBomLine,
  isLedResistorRequirement,
  isPowerSupplyRequirement,
  resolveBomSpecification,
} from "./index.js";

describe("BOM specification resolver", () => {
  it("recognises power-supply punctuation and case variants", () => {
    expect(isPowerSupplyRequirement("12 V Power-Supply")).toBe(true);
    expect(isPowerSupplyRequirement("DC ADAPTER")).toBe(true);
    expect(isPowerSupplyRequirement("power supply bracket")).toBe(true);
  });

  it("recognises only a whole-word LED resistor phrase", () => {
    expect(isLedResistorRequirement("LED resistor")).toBe(true);
    expect(isLedResistorRequirement("led-current-limiting resistors")).toBe(true);
    expect(isLedResistorRequirement("LED / current limiting resistor")).toBe(true);
    expect(isLedResistorRequirement("resistor for LED")).toBe(true);
    expect(isLedResistorRequirement("LED series resistor")).toBe(true);
    expect(isLedResistorRequirement("LED limiting resistor")).toBe(true);
    expect(isLedResistorRequirement("LED board")).toBe(false);
    expect(isLedResistorRequirement("resistor bracket")).toBe(false);
    expect(isLedResistorRequirement("LED board resistor bracket")).toBe(false);
    expect(isLedResistorRequirement("resistor bracket for LED")).toBe(false);
    expect(isLedResistorRequirement("delivered resistor")).toBe(false);
  });

  it("fails closed for exact LED resistor identities until both decisions resolve", () => {
    expect(resolveBomSpecification({ name: "LED resistor", itemId: "stock-1", constraints: {} })).toEqual({
      sufficient: false,
      missingDecisions: ["resistance", "power_rating"],
    });
    const line = createBomLine({ revisionId: "revision-1", name: "LED resistor", quantity: 1, unit: "piece", itemId: "stock-1" });
    expect(line.constraints?.specification).toEqual({ status: "insufficient", missingDecisions: ["resistance", "power_rating"] });
    expect(() => createBomLine({
      revisionId: "revision-1",
      name: "LED resistor",
      quantity: 1,
      unit: "piece",
      constraints: { specification: { status: "sufficient", decisions: { resistance: "330 ohm" } } },
    })).toThrow(/sufficient.*resistance.*power_rating/i);
  });

  it("unions explicit and derived blockers in canonical order without duplicates", () => {
    expect(resolveBomSpecification({
      name: "LED-resistor",
      constraints: { specification: { status: "insufficient", missingDecisions: ["power_rating"] } },
    })).toEqual({ sufficient: false, missingDecisions: ["resistance", "power_rating"] });
    expect(resolveBomSpecification({
      name: "12 V power-supply",
      constraints: { specification: { status: "insufficient", missingDecisions: ["connector", "voltage", "connector"] } },
    })).toEqual({ sufficient: false, missingDecisions: ["voltage", "current_or_load", "connector"] });
  });

  it("accepts a fully resolved LED resistor specification", () => {
    expect(resolveBomSpecification({
      name: "LED resistor",
      constraints: {
        specification: {
          status: "sufficient",
          decisions: { resistance: "330 ohm", power_rating: "0.25 W" },
        },
      },
    })).toEqual({ sufficient: true, missingDecisions: [] });
  });
});
