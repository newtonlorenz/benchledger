import { describe, expect, it } from "vitest";
import { exceedsReservableQuantity, quantitiesEqual, quantityExceeds, roundQuantity } from "./quantity-compare.js";

describe("decimal quantity comparison", () => {
  it("treats decimal sums as equal despite binary rounding", () => {
    expect(0.1 + 0.2 > 0.3).toBe(true);
    expect(quantitiesEqual(0.1 + 0.2, 0.3)).toBe(true);
    expect(quantityExceeds(0.1 + 0.2, 0.3)).toBe(false);
    expect(quantityExceeds(1000.1 + 0.2, 1000.3)).toBe(false);
  });

  it("still detects a real excess or difference", () => {
    expect(quantityExceeds(0.31, 0.3)).toBe(true);
    expect(quantityExceeds(3, 2)).toBe(true);
    expect(quantityExceeds(2, 3)).toBe(false);
    expect(quantitiesEqual(1, 1.000001)).toBe(false);
    expect(quantitiesEqual(Number.NaN, Number.NaN)).toBe(false);
    expect(quantityExceeds(Number.POSITIVE_INFINITY, 1)).toBe(true);
  });

  it("rounds computed quantities to nine decimal places", () => {
    expect(roundQuantity(0.1 + 0.2)).toBe(0.3);
    expect(roundQuantity(-0.0000000001)).toBe(0);
    expect(roundQuantity(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("over-reservation rule", () => {
  it("lets same-unit reservations fill a decimal requirement exactly", () => {
    expect(exceedsReservableQuantity(0.2, 0.3, 0.1)).toBe(false);
    expect(exceedsReservableQuantity(0.1 + 0.2, 0.3, 0)).toBe(false);
    expect(exceedsReservableQuantity(0.21, 0.3, 0.1)).toBe(true);
    expect(exceedsReservableQuantity(3, 2.5, 0)).toBe(true);
  });

  it("rounds converted requirements up to whole sets without adding a set after coverage", () => {
    expect(exceedsReservableQuantity(2, 15, 0, 10)).toBe(false);
    expect(exceedsReservableQuantity(3, 15, 0, 10)).toBe(true);
    expect(exceedsReservableQuantity(1, 0.3, 0.1 + 0.2, 0.1)).toBe(true);
    expect(exceedsReservableQuantity(1, 0.3, 0.1 + 0.1, 0.1)).toBe(false);
    expect(exceedsReservableQuantity(1, 10, 12, 5)).toBe(true);
  });
});
