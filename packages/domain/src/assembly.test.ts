import { expect, it } from "vitest";
import { suggestAssemblyExplosion } from "./assembly.js";
it("separates concentric and offset parts deterministically without moving a single part", () => {
  expect(suggestAssemblyExplosion([])).toEqual({});
  const a = { id: "a", min: [-5, -5, -5] as [number, number, number], max: [5, 5, 5] as [number, number, number] };
  expect(suggestAssemblyExplosion([a]).a).toEqual([0, 0, 0]);
  const result = suggestAssemblyExplosion([a, { ...a, id: "b" }]);
  expect(result.a).not.toEqual(result.b);
  expect(suggestAssemblyExplosion([a, { id: "c", min: [10, 0, 0], max: [15, 5, 5] }]).c![0]).toBeGreaterThan(0);
});
