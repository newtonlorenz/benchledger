import { describe, it, expect } from "vitest";
import { matchesInventorySearch } from "./inventory-search.js";
describe("inventory discovery search", () => {
  it("matches words in any order across fields, punctuation and accents", () => {
    expect(matchesInventorySearch(["Café heat-shrink kit", "LED", "Maker"], "maker LED cafe")).toBe(true);
    expect(matchesInventorySearch(["Café heat-shrink kit", "LED"], "heat shrink")).toBe(true);
    expect(matchesInventorySearch(["電気部品", "LED"], "LED 電気")).toBe(true);
  });
  it("keeps empty browsing distinct from punctuation-only and missing terms", () => {
    expect(matchesInventorySearch([undefined, "LED"], "")).toBe(true);
    expect(matchesInventorySearch([undefined], undefined)).toBe(true);
    expect(matchesInventorySearch(["LED"], "***")).toBe(false);
    expect(matchesInventorySearch(["LED", "red"], "LED blue")).toBe(false);
  });
});
