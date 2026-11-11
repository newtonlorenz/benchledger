import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFiles, findProhibited, scan } from "./privacy-scan.mjs";

// Build prohibited samples at runtime so this file never trips the scanner.
const legacyBrand = ["Forge", "Ledger"].join("");
const macPath = ["", "Users", "someone", "notes.md"].join("/");

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("privacy scan matcher", () => {
  it("passes synthetic content", () => {
    expect(findProhibited("BenchLedger demo: 3 spools of PLA\n")).toEqual([]);
  });

  it("flags prohibited content", () => {
    expect(findProhibited(`legacy ${legacyBrand} at ${macPath}`)).toEqual([
      "legacy brand identifier",
      "local macOS user path"
    ]);
  });
});

describe("privacy scan file selection", () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "benchledger-privacy-"));
    git(root, "init", "-q");
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await writeFile(join(root, "README.md"), "Synthetic project\n");
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored", "notes.md"), `${legacyBrand}\n`);
    await writeFile(join(root, "local-handoff.md"), `${macPath}\n`);
    await writeFile(join(root, ".git", "info", "exclude"), "/local-handoff.md\n");
    git(root, "add", "README.md", ".gitignore");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("skips ignored and locally excluded files", async () => {
    expect(await collectFiles(root)).toEqual([".gitignore", "README.md"]);
    expect(await scan(root)).toEqual([]);
  });

  it("flags untracked files that are not ignored", async () => {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "draft.md"), `${legacyBrand}\n`);
    expect(await scan(root)).toEqual(["docs/draft.md: legacy brand identifier"]);
  });

  it("flags tracked files even when they match an ignore rule", async () => {
    git(root, "add", "-f", "ignored/notes.md");
    expect(await scan(root)).toEqual(["ignored/notes.md: legacy brand identifier"]);
  });

  it("falls back to a filesystem walk without Git", async () => {
    const findings = await scan(root, { useGit: false });
    expect(findings).toContain("local-handoff.md: local macOS user path");
    expect(findings).toContain("ignored/notes.md: legacy brand identifier");
  });
});
