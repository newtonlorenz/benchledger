import { describe, expect, it } from "vitest";
import { adjustmentPreview, parseQuantity, stepQuantity, stepsFor, validateAdjustment } from "./stock-adjust";

describe("quick count and receipt maths", () => {
  it("uses whole-number steps for counted units and larger steps for measured units", () => {
    expect(stepsFor("each")).toEqual([1, 10]);
    expect(stepsFor("set")).toEqual([1, 10]);
    expect(stepsFor("gram")).toEqual([1, 10, 100]);
    expect(stepsFor("metre")).toEqual([0.1, 1]);
  });
  it("never steps below zero and avoids floating point drift", () => {
    expect(stepQuantity(0, -1)).toBe(0);
    expect(stepQuantity(3, -10)).toBe(0);
    expect(stepQuantity(0.1, 0.2)).toBe(0.3);
    expect(stepQuantity(5, 10)).toBe(15);
  });
  it("shows before and after for a count and a receipt", () => {
    expect(adjustmentPreview("count", 12, 9)).toEqual({ before: 12, after: 9, delta: -3 });
    expect(adjustmentPreview("receipt", 12, 5)).toEqual({ before: 12, after: 17, delta: 5 });
  });
  it("validates quantities against the unit and kind", () => {
    expect(validateAdjustment("count", 0, "each")).toBeUndefined();
    expect(validateAdjustment("count", -1, "each")).toMatch(/zero or more/u);
    expect(validateAdjustment("count", 2.5, "each")).toMatch(/whole/u);
    expect(validateAdjustment("count", 2.5, "gram")).toBeUndefined();
    expect(validateAdjustment("receipt", 0, "gram")).toMatch(/more than zero/u);
    expect(validateAdjustment("receipt", Number.NaN, "gram")).toMatch(/number/u);
    expect(validateAdjustment("count", 1e12, "gram")).toMatch(/too large/u);
  });
  it("parses typed quantities, including a decimal comma", () => {
    expect(parseQuantity("12")).toBe(12);
    expect(parseQuantity(" 2,5 ")).toBe(2.5);
    expect(parseQuantity("")).toBeNaN();
    expect(parseQuantity("1e3")).toBeNaN();
    expect(parseQuantity("-4")).toBeNaN();
  });
});
