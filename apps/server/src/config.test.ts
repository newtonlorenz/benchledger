import { describe, expect, it } from "vitest";
import { positiveIntegerFromEnvironment, publicBaseUrlFromEnvironment } from "./config.js";

describe("positiveIntegerFromEnvironment", () => {
  it("accepts omitted and empty settings, but rejects non-positive or unsafe values", () => {
    expect(positiveIntegerFromEnvironment({}, "LIMIT")).toBeUndefined();
    expect(positiveIntegerFromEnvironment({ LIMIT: "" }, "LIMIT")).toBeUndefined();
    for (const raw of ["0", "-1", "1.5", "1e3", "abc", " 2"]) {
      expect(() => positiveIntegerFromEnvironment({ LIMIT: raw }, "LIMIT")).toThrow(/positive integer/u);
    }
    expect(() => positiveIntegerFromEnvironment({ LIMIT: "9007199254740992" }, "LIMIT")).toThrow(/safe integer/u);
    expect(positiveIntegerFromEnvironment({ LIMIT: "42" }, "LIMIT")).toBe(42);
  });
});

describe("publicBaseUrlFromEnvironment", () => {
  it("requires an explicit HTTP(S) origin outside demo mode", () => {
    expect(() => publicBaseUrlFromEnvironment(undefined)).toThrow(/PUBLIC_BASE_URL/u);
    expect(publicBaseUrlFromEnvironment(undefined, true)).toBe("http://127.0.0.1:8792");
  });

  it("normalizes a configured origin and rejects URL injection surfaces", () => {
    expect(publicBaseUrlFromEnvironment("https://maker.example:8792/")).toBe("https://maker.example:8792");
    for (const invalid of [
      "https://maker.example/workspace",
      "https://user:pass@maker.example",
      "https://maker.example?redirect=evil",
      "https://maker.example?",
      "https://maker.example#",
      "file:///tmp/benchledger",
      "not-a-url",
    ]) {
      expect(() => publicBaseUrlFromEnvironment(invalid)).toThrow();
    }
  });

  it("rejects surrounding whitespace and invalid hosts while preserving a root origin", () => {
    expect(() => publicBaseUrlFromEnvironment(" https://maker.example ")).toThrow(/whitespace/u);
    expect(() => publicBaseUrlFromEnvironment("http://")).toThrow(/absolute HTTP/u);
    expect(publicBaseUrlFromEnvironment("http://127.0.0.1:8792/")).toBe("http://127.0.0.1:8792");
  });
});
