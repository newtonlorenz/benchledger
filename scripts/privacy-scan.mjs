import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatedMobilePaths } from "./generated-mobile-paths.mjs";

// The scan covers what could be published: files tracked by Git plus untracked
// files that are not ignored (.gitignore, .git/info/exclude, global excludes).
// Locally excluded scratch files are never part of the public source, so they
// must not fail the gate. Without Git, fall back to a filesystem walk.

// Generated local caches (for example .impeccable/hook.cache.json) are ignored
// by Git and so skipped; a tracked or staged copy is listed and still scanned.

export const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".cjs",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
]);
export const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "private",
  "data",
  "backups"
]);
export const extensionlessTextFiles = new Set([
  ".dockerignore",
  ".env.example",
  ".gitignore",
  ".npmrc",
  "LICENSE"
]);

export const prohibited = [
  {
    label: "private Gmail message identifier",
    // Match a populated Gmail-style hexadecimal message ID, not the legacy
    // schema field name used by synthetic importer tests.
    pattern: /\b(?:email|gmail)_id\b\s*:\s*["'`][0-9a-f]{12,}["'`]/i
  },
  { label: "Amazon order number", pattern: /\b\d{3}-\d{7}-\d{7}\b/ },
  { label: "Bambu order number", pattern: /\bEN\d{18,}\b/ },
  { label: "private inventory source path", pattern: /(?:^|["'`\s])\.\.\/inventory\/inventory\.json\b/ },
  { label: "plaintext bearer token", pattern: /authorization\s*[:=]\s*["'`]bearer\s+[a-z0-9._~-]{32,}/i },
  {
    label: "legacy brand identifier",
    pattern: new RegExp(["forge", "[ _-]?", "ledger"].join(""), "i")
  },
  { label: "local macOS user path", pattern: /\/Users\/[^/\s]+\// },
  { label: "private deployment address", pattern: /\b192\.168\.4\.(?:34|54)\b/ },
  {
    label: "maintainer private identity",
    pattern: new RegExp(`\\b${["Grae", "tzer"].join("")}\\b`, "i")
  }
];

export function isScannedTextFile(relativePath) {
  const name = basename(relativePath);
  return textExtensions.has(extname(name)) || extensionlessTextFiles.has(name);
}

/** Returns the labels of every prohibited pattern found in the content. */
export function findProhibited(content) {
  return prohibited.filter((rule) => rule.pattern.test(content)).map((rule) => rule.label);
}

/**
 * Lists repository-relative paths Git would publish: tracked files plus
 * untracked files that are not ignored. Returns null when Git is unavailable
 * or the directory is not a work tree, so callers can fall back to a walk.
 */
export function gitCandidateFiles(rootPath) {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: rootPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }
    );
    return [...new Set(output.split("\0").filter(Boolean))];
  } catch {
    return null;
  }
}

async function walk(rootPath, directory, generatedMobile) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    const rel = relative(rootPath, path);
    if (entry.isDirectory() && generatedMobile.has(rel)) continue;
    if (entry.isDirectory()) files.push(...(await walk(rootPath, path, generatedMobile)));
    else if (isScannedTextFile(rel)) files.push(rel);
  }
  return files;
}

/** Collects repository-relative text files to scan. */
export async function collectFiles(rootPath, { useGit = true } = {}) {
  const listed = useGit ? gitCandidateFiles(rootPath) : null;
  if (listed) {
    const files = [];
    for (const rel of listed) {
      if (!isScannedTextFile(rel)) continue;
      // Tracked files deleted from the work tree have nothing to publish.
      try {
        if (!(await stat(join(rootPath, rel))).isFile()) continue;
      } catch {
        continue;
      }
      files.push(rel);
    }
    return files.sort();
  }
  // Without Git nothing proves the cache or native projects are untracked, so
  // the walk scans them rather than risk hiding a file that would be published.
  const generatedMobile = useGit ? generatedMobilePaths(rootPath) : new Set();
  return (await walk(rootPath, rootPath, generatedMobile)).sort();
}

export async function scan(rootPath, options) {
  const findings = [];
  for (const rel of await collectFiles(rootPath, options)) {
    const content = await readFile(join(rootPath, rel), "utf8");
    for (const label of findProhibited(content)) findings.push(`${rel.split(sep).join("/")}: ${label}`);
  }
  return findings;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const rootPath = fileURLToPath(new URL("../", import.meta.url));
  const findings = await scan(rootPath);
  if (findings.length > 0) {
    console.error("BenchLedger privacy scan failed:\n" + findings.map((finding) => `- ${finding}`).join("\n"));
    process.exit(1);
  }
  console.log("BenchLedger privacy scan passed.");
}
