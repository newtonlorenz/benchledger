import { describe, expect, it } from "vitest";
import { formatMoney, preferredCurrency } from "./domain";
import { quotedMoney } from "./workflow-ui";

describe("locale-aware money", () => {
  it("formats in the given locale instead of a hard-coded English one", () => {
    expect(formatMoney(2499, "EUR", "de-DE")).toBe("24,99 €");
    expect(quotedMoney(2499, "EUR", "de-DE")).toBe("24,99 €");
  });

  it("defaults a new quote to the workspace's existing currency, then the browser region", () => {
    expect(preferredCurrency(["GBP", "GBP", "USD"], "de-DE")).toBe("GBP");
    expect(preferredCurrency([], "en-US")).toBe("USD");
    expect(preferredCurrency([], "en-GB")).toBe("GBP");
    expect(preferredCurrency([], "fi-FI")).toBe("EUR");
    expect(preferredCurrency([], "en")).toBe("EUR");
  });
});
