import { describe, expect, it } from "vitest";
import { getStateFromPath } from "@react-navigation/core";
import { linking, parsePairLink } from "./links";

const route = (url: string) => getStateFromPath(url.replace(/^benchledger:\/\//u, ""), linking.config);
const leaf = (state: ReturnType<typeof route>): unknown => {
  let current: any = state;
  const names: string[] = [];
  while (current) { const r = current.routes[current.index ?? current.routes.length - 1]; names.push(r.name); if (!r.state) return { names, params: r.params }; current = r.state; }
  return { names };
};

describe("record deep links", () => {
  it("opens an inventory item inside the inventory tab with a back stack", () => {
    const state = route("benchledger://item/printer-h2d");
    expect(leaf(state)).toEqual({ names: ["Stock", "Item"], params: { id: "printer-h2d" } });
    expect((state as any).routes[0].state.routes.map((r: { name: string }) => r.name)).toEqual(["Inventory", "Item"]);
  });
  it("opens a project inside the projects tab", () => {
    expect(leaf(route("benchledger://project/synthetic-project-lamp"))).toEqual({ names: ["Builds", "Project"], params: { id: "synthetic-project-lamp" } });
  });
  it("keeps pairing links away from the navigator", () => {
    expect(linking.filter?.("benchledger://pair?url=https%3A%2F%2Fa.example&token=t")).toBe(false);
    expect(linking.filter?.("benchledger://item/x")).toBe(true);
    expect(linking.prefixes).toEqual(["benchledger://"]);
  });
});

describe("pairing links", () => {
  it("prefills an HTTPS server and token", () => {
    expect(parsePairLink("benchledger://pair?url=https%3A%2F%2Fbench.example.com&token=abc.DEF-123"))
      .toEqual({ server: "https://bench.example.com", token: "abc.DEF-123", allowLocalHttp: false });
  });
  it("never turns on local HTTP by itself; the user must opt in", () => {
    expect(parsePairLink("benchledger://pair?url=http%3A%2F%2F192.168.1.20%3A8792&token=abc"))
      .toMatchObject({ server: "http://192.168.1.20:8792", allowLocalHttp: false });
    expect(parsePairLink("benchledger://pair?url=http%3A%2F%2Fpublic.example.com&token=abc"))
      .toMatchObject({ server: "http://public.example.com", allowLocalHttp: false });
  });
  it("drops a malformed token but keeps the address", () => {
    expect(parsePairLink("benchledger://pair?url=https%3A%2F%2Fbench.example.com&token=bad%20token%0A"))
      .toEqual({ server: "https://bench.example.com", token: "", allowLocalHttp: false });
  });
  it.each(["benchledger://item/x", "https://pair?url=https://a.example", "benchledger://pair", "benchledger://pair?url=javascript%3Aalert(1)", "not a url"])
    ("ignores %s", (url) => expect(parsePairLink(url)).toBeNull());
});
