import { describe, expect, it } from "vitest";
import { z } from "zod/v3";
import { tolerant } from "./tolerant";

const leaf = z.object({ a: z.string() }).strict();
describe("tolerant read schemas", () => {
  it.each([
    ["optional", z.object({ x: leaf.optional() }).strict(), { x: { a: "1", extra: 1 } }, { x: { a: "1" } }],
    ["nullable", z.object({ x: leaf.nullable() }).strict(), { x: { a: "1", extra: 1 } }, { x: { a: "1" } }],
    ["default", z.object({ x: leaf.default({ a: "d" }) }).strict(), { x: { a: "1", extra: 1 } }, { x: { a: "1" } }],
    ["catch", leaf.catch({ a: "c" }), { a: "1", extra: 1 }, { a: "1" }],
    ["record", z.record(leaf), { k: { a: "1", extra: 1 } }, { k: { a: "1" } }],
    ["union", z.union([leaf, z.object({ b: z.number() }).strict()]), { a: "1", extra: 1 }, { a: "1" }],
    ["discriminated union", z.discriminatedUnion("t", [z.object({ t: z.literal("x"), a: z.string() }).strict(), z.object({ t: z.literal("y") }).strict()]), { t: "x", a: "1", extra: 1 }, { t: "x", a: "1" }],
    ["intersection", z.intersection(leaf, z.object({ b: z.number() })), { a: "1", b: 2 }, { a: "1", b: 2 }],
    ["tuple", z.tuple([leaf]), [{ a: "1", extra: 1 }], [{ a: "1" }]],
    ["lazy", z.lazy(() => leaf), { a: "1", extra: 1 }, { a: "1" }],
    ["pipeline", leaf.pipe(leaf), { a: "1", extra: 1 }, { a: "1" }],
    ["transform", leaf.transform((v) => v.a), { a: "1", extra: 1 }, "1"]
  ] as const)("strips unknown keys through %s", (_name, schema, input, expected) => {
    const original = (schema as z.ZodTypeAny).safeParse(input);
    expect(original.success && original.data).not.toEqual(expected);
    expect(tolerant(schema as z.ZodTypeAny).parse(input)).toEqual(expected);
  });
  it("keeps required fields and enums strict", () => {
    const schema = tolerant(z.object({ state: z.enum(["ok"]), a: z.string() }).strict());
    expect(() => schema.parse({ state: "new", a: "1" })).toThrow();
    expect(() => schema.parse({ state: "ok" })).toThrow();
  });
});
