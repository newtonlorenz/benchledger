import { describe, expect, it } from "vitest";
import {
  bomSpecificationSchema,
  createBomLineSchema,
} from "./schemas.js";

describe("LED resistor BOM specification contract", () => {
  it("accepts the extended resistor decision vocabulary", () => {
    expect(bomSpecificationSchema.parse({ status: "insufficient", missingDecisions: ["resistance", "power_rating"] })).toEqual({
      status: "insufficient",
      missingDecisions: ["resistance", "power_rating"],
    });
  });

  it("accepts an unrelated sufficient resistance-only specification", () => {
    const line = createBomLineSchema.parse({
      name: "Resistor component",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [],
      constraints: { specification: { status: "sufficient", decisions: { resistance: "330 ohm" } } },
    });
    expect(line.constraints?.specification).toEqual({ status: "sufficient", decisions: { resistance: "330 ohm" } });
  });

  it("accepts a complete resistor specification", () => {
    const specification = {
      status: "sufficient" as const,
      decisions: { resistance: "330 ohm", power_rating: "0.25 W" },
    };
    expect(bomSpecificationSchema.parse(specification)).toEqual(specification);
  });
});
