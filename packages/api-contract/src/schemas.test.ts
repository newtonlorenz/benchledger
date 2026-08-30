import { describe, expect, it } from "vitest";
import { createBomLineSchema, updateBomLineSchema } from "./schemas.js";

const constraints = {
  kind: "electronic",
  manufacturer: "Maker Co",
  model: "ESP32-S3",
  sku: "DEV-32",
  tag: "controller",
  nameIncludes: "board",
};

describe("REST BOM constraint schema", () => {
  it("accepts exactly the supported constraint keys for create and update", () => {
    const created = createBomLineSchema.parse({
      name: "Controller",
      requiredQuantity: 1,
      unit: "each",
      optional: false,
      alternatives: [],
      constraints,
    });
    const updated = updateBomLineSchema.parse({ constraints });

    expect(created.constraints).toEqual(constraints);
    expect(updated.constraints).toEqual(constraints);
  });

  it("rejects unknown and non-string constraint values at the REST boundary", () => {
    expect(() => createBomLineSchema.parse({ name: "Controller", requiredQuantity: 1, unit: "each", optional: false, alternatives: [], constraints: { unsupported: "value" } })).toThrow();
    expect(() => updateBomLineSchema.parse({ constraints: { kind: 42 } })).toThrow();
  });
});
