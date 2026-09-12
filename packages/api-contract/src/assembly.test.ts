import { expect, it } from "vitest";
import { z } from "zod/v3";
import { assemblyInputSchema, assemblyVectorSchema, inspectAssemblySchema } from "./assembly.js";
import { commandJsonSchema } from "./json-schema.js";
it("advertises precise vector bounds and rejects malformed assembly identities", () => {
  expect(commandJsonSchema(assemblyVectorSchema)).toMatchObject({ type: "array", minItems: 3, maxItems: 3, items: { type: "number", minimum: -1e7, maximum: 1e7 } });
  expect(() => commandJsonSchema(z.tuple([z.string(), z.number()]))).toThrow(/homogeneous/);
  expect(assemblyVectorSchema.safeParse([Infinity, 0, 0]).success).toBe(false);
  const source = { artifactId: "file", sha256: "a".repeat(64), unit: "millimetre" };
  const part = { id: "part", artifactId: "file", nodeId: "mesh-0", name: "Part", explode: [0, 10, 0] };
  const value = { expectedVersion: 0, name: "Assembly", sources: [source], parts: [part], steps: [] };
  expect(assemblyInputSchema.parse(value).parts[0]!.position).toEqual([0, 0, 0]);
  for (const changed of [{ ...value, sources: [source, source] }, { ...value, parts: [part, part] }, { ...value, parts: [{ ...part, artifactId: "other" }] }, { ...value, steps: [{ id: "step", name: "Step", partIds: ["absent"] }] }, { ...value, url: "https://example.org/model.glb" }]) expect(assemblyInputSchema.safeParse(changed).success).toBe(false);
  expect(inspectAssemblySchema.safeParse({ sources: [source, source] }).success).toBe(false);
});
