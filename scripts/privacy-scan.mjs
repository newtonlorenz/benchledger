import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../", import.meta.url);
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
]);
const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "private",
  "data",
  "backups"
]);
const extensionlessTextFiles = new Set([
  ".dockerignore",
  ".env.example",
  ".gitignore",
  ".npmrc",
  "LICENSE"
]);

const prohibited = [
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

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (textExtensions.has(extname(entry.name)) || extensionlessTextFiles.has(entry.name)) files.push(path);
  }
  return files;
}

const findings = [];
for (const path of await collect(root.pathname)) {
  const content = await readFile(path, "utf8");
  for (const rule of prohibited) {
    if (rule.pattern.test(content)) {
      findings.push(`${relative(root.pathname, path)}: ${rule.label}`);
    }
  }
}

if (findings.length > 0) {
  console.error("BenchLedger privacy scan failed:\n" + findings.map((finding) => `- ${finding}`).join("\n"));
  process.exit(1);
}

console.log("BenchLedger privacy scan passed.");
