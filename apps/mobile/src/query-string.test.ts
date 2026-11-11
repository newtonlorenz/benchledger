import { describe, expect, it } from "vitest";
import { parse, stringify } from "./query-string";

describe("navigation query parser compatibility", () => {
  it("preserves the named parse/stringify API used by React Navigation", () => {
    expect(parse("name=Desk%20lamp&tag=a&tag=b")).toEqual({ name: "Desk lamp", tag: ["a", "b"] });
    expect(stringify({ name: "Desk lamp", page: 2 }, { sort: false })).toBe("name=Desk%20lamp&page=2");
  });
  it("handles malformed percent encoding without recursive expansion", () => {
    const input = "%C0%AF".repeat(1000);
    expect(parse(`value=${input}`).value).toBe(input);
  });
});
