import { describe, expect, it } from "vitest";
import { isLocalHost, normaliseServer } from "./connection";

describe("local HTTP allow-list", () => {
  it.each([
    ["localhost"], ["127.0.0.1"], ["127.8.9.10"], ["10.0.0.4"], ["172.16.0.1"], ["172.31.255.255"], ["192.168.1.20"], ["169.254.10.1"],
    // Tailscale and other carrier-grade NAT ranges: 100.64.0.0/10
    ["100.64.0.1"], ["100.100.100.100"], ["100.127.255.254"],
    // Local DNS suffixes
    ["workshop.local"], ["bench.lan"], ["nas.home.arpa"],
    // IPv6 loopback, link-local fe80::/10 and unique-local fc00::/7
    ["[::1]"], ["[fe80::1]"], ["[febf::1]"], ["[fd12:3456::1]"], ["[fc00::2]"]
  ])("treats %s as a local host", (host) => expect(isLocalHost(host)).toBe(true));
  it.each([
    ["8.8.8.8"], ["100.63.255.255"], ["100.128.0.1"], ["172.32.0.1"], ["192.169.0.1"], ["workspace.example.com"], ["local.example.com"],
    ["lan.example.org"],
    // Single-label names may resolve through a DNS search domain to a public host.
    ["benchledger"], ["nas"],
    ["[2001:db8::1]"], ["[fec0::1]"], ["[::ffff:8.8.8.8]"], ["999.1.1.1"], [""]
  ])("treats %s as public", (host) => expect(isLocalHost(host)).toBe(false));
  it.each([
    ["http://100.101.102.103:8792", "http://100.101.102.103:8792"],
    ["http://bench.lan:8792/", "http://bench.lan:8792"],
    ["http://nas.home.arpa", "http://nas.home.arpa"],
    ["http://[fd00::10]:8792", "http://[fd00::10]:8792"],
    ["http://[fe80::1]:8792", "http://[fe80::1]:8792"]
  ])("allows local HTTP for %s only with consent", (address, expected) => {
    expect(normaliseServer(address, true)).toBe(expected);
    expect(() => normaliseServer(address, false)).toThrow();
  });
  it.each(["http://public.example.com", "http://[2001:db8::1]", "http://100.128.0.1", "http://benchledger:8792"])("still requires HTTPS for public %s", (address) => {
    expect(() => normaliseServer(address, true)).toThrow("HTTPS");
  });
});
