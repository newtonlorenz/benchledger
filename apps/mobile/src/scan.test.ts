import { describe, expect, it } from "vitest";
import { itemLabelLink, routeScan } from "./scan";

const signedIn = { signedIn: true };
const signedOut = { signedIn: false };

describe("scan result routing", () => {
  it("opens an item from a printed label link", () => {
    expect(routeScan("benchledger://item/item-m3-screws", signedIn)).toEqual({ kind: "item", id: "item-m3-screws" });
    expect(routeScan("  benchledger://item/item-m3-screws\n", signedIn)).toEqual({ kind: "item", id: "item-m3-screws" });
    expect(routeScan("benchledger://project/project-lamp", signedIn)).toEqual({ kind: "project", id: "project-lamp" });
  });
  it("round-trips the documented label format", () => {
    expect(itemLabelLink("item-m3-screws")).toBe("benchledger://item/item-m3-screws");
    expect(routeScan(itemLabelLink("item-m3-screws"), signedIn)).toEqual({ kind: "item", id: "item-m3-screws" });
  });
  it("rejects malformed record IDs before any request", () => {
    expect(routeScan("benchledger://item/../../auth", signedIn)).toMatchObject({ kind: "ignored" });
    expect(routeScan("benchledger://item/", signedIn)).toMatchObject({ kind: "ignored" });
    expect(routeScan("benchledger://item/a%2Fb", signedIn)).toMatchObject({ kind: "ignored" });
  });
  it("searches inventory with other scanned text such as a product barcode", () => {
    expect(routeScan("5012345678900", signedIn)).toEqual({ kind: "search", text: "5012345678900" });
    expect(routeScan("M3 x 8 socket\u0007 head", signedIn)).toEqual({ kind: "search", text: "M3 x 8 socket head" });
    expect(routeScan("x".repeat(500), signedIn)).toMatchObject({ kind: "search", text: "x".repeat(200) });
  });
  it("never opens or searches arbitrary web addresses", () => {
    expect(routeScan("https://evil.example/login", signedIn)).toMatchObject({ kind: "ignored", reason: expect.stringMatching(/web address/u) });
    expect(routeScan("benchledger://unknown/thing", signedIn)).toMatchObject({ kind: "ignored" });
  });
  it("only prefills pairing while signed out and keeps the token out of the reason", () => {
    const link = "benchledger://pair?url=https%3A%2F%2Fbench.example&token=synthetic-secret-token";
    expect(routeScan(link, signedOut)).toEqual({ kind: "pair", url: link });
    const ignored = routeScan(link, signedIn);
    expect(ignored).toMatchObject({ kind: "ignored", reason: expect.stringMatching(/Disconnect/u) });
    expect(JSON.stringify(ignored)).not.toContain("synthetic-secret-token");
    expect(routeScan("benchledger://pair?url=ftp%3A%2F%2Fx&token=t", signedOut)).toMatchObject({ kind: "ignored" });
  });
  it("asks the user to connect before opening records from the connect screen", () => {
    expect(routeScan("benchledger://item/item-m3-screws", signedOut)).toMatchObject({ kind: "ignored", reason: expect.stringMatching(/Connect/u) });
    expect(routeScan("5012345678900", signedOut)).toMatchObject({ kind: "ignored" });
  });
  it("ignores empty or oversized payloads", () => {
    expect(routeScan("   ", signedIn)).toMatchObject({ kind: "ignored" });
    expect(routeScan(`benchledger://item/${"a".repeat(5000)}`, signedIn)).toMatchObject({ kind: "ignored" });
  });
});
