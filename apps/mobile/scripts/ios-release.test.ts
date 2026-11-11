import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { outsideCheckout, validateConfig } from "./ios-release.mjs";

describe("iOS release boundaries", () => {
  it("keeps credentials and release output out of source, including symlink paths", () => {
    const temp = mkdtempSync(join(tmpdir(), "benchledger-release-test-"));
    try {
      const checkout = join(temp, "source"); mkdirSync(checkout);
      symlinkSync(checkout, join(temp, "alias"));
      expect(() => outsideCheckout(join(checkout, "credentials.json"), checkout)).toThrow();
      expect(() => outsideCheckout(join(temp, "alias", "release"), checkout)).toThrow();
      expect(() => outsideCheckout("relative.json", checkout)).toThrow();
      expect(outsideCheckout(join(temp, "private", "build"), checkout)).toContain("private");
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it("requires an explicit distribution identity for export", () => {
    const config = { teamId: "AAAAAAAAAA", keyId: "BBBBBBBBBB", issuerId: "00000000-0000-0000-0000-000000000001",
      keyPath: "/tmp/synthetic-signing/key.p8", outputDirectory: "/tmp/synthetic-signing/releases" };
    expect(validateConfig(config, false)).toBe(config);
    expect(() => validateConfig(config)).toThrow("distributionCertificate");
    expect(() => validateConfig({ ...config, keyId: "bad" }, false)).toThrow("keyId");
  });
  it("checks the symbol installer against malicious archive entries and UUID parsing", () => {
    execFileSync("python3", ["apps/mobile/scripts/ios-symbols.test.py"], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  });
});
