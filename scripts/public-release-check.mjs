import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const root = new URL("../", import.meta.url);
const rootPath = root.pathname;
const findings = [];

const requiredFiles = [
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "docs/assets/benchledger-lockup.svg",
  "docs/assets/benchledger-workspace.png",
  ".github/pull_request_template.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml"
];

const ignoredDirectories = new Set([
  ".git",
  "backups",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "playwright-report",
  "private",
  "test-results"
]);

const dangerousExtensions = new Set([
  ".db",
  ".key",
  ".log",
  ".p12",
  ".pem",
  ".pfx",
  ".sqlite",
  ".sqlite3"
]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      findings.push(`${relative(rootPath, path)}: symbolic links are not allowed in the public source archive`);
    } else if (entry.isDirectory()) {
      files.push(...(await collect(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

for (const required of requiredFiles) {
  if (!(await exists(join(rootPath, required)))) findings.push(`${required}: required public-project file is missing`);
}

const files = await collect(rootPath);
for (const path of files) {
  const name = basename(path);
  const relativePath = relative(rootPath, path);
  const extension = extname(name).toLowerCase();
  if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") {
    findings.push(`${relativePath}: environment file must not be published`);
  }
  if (dangerousExtensions.has(extension) || name === "id_rsa" || name === "id_ed25519") {
    findings.push(`${relativePath}: possible credential, database, or runtime file`);
  }
}

const packagePaths = files.filter((path) => basename(path) === "package.json");
for (const path of packagePaths) {
  const packageJson = JSON.parse(await readFile(path, "utf8"));
  const relativePath = relative(rootPath, path);
  if (packageJson.license !== "Apache-2.0") {
    findings.push(`${relativePath}: license must be Apache-2.0`);
  }
  if (packageJson.private !== true) {
    findings.push(`${relativePath}: workspace must remain private until coordinated package publishing is approved`);
  }
}

const lockfile = JSON.parse(await readFile(join(rootPath, "package-lock.json"), "utf8"));
for (const [path, metadata] of Object.entries(lockfile.packages ?? {})) {
  if (!path.startsWith("node_modules/") || metadata.link) continue;
  if (!metadata.license) findings.push(`package-lock.json: ${path} has no recorded license`);
  if (/\b(?:AGPL|GPL|SSPL)\b|Commons-Clause/i.test(metadata.license ?? "")) {
    findings.push(`package-lock.json: ${path} uses review-required license ${metadata.license}`);
  }
}

for (const path of files.filter((file) => extname(file) === ".md")) {
  const content = await readFile(path, "utf8");
  const links = content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/i.test(rawTarget)) continue;
    const target = decodeURIComponent(rawTarget.split("#", 1)[0]);
    if (target && !(await exists(resolve(dirname(path), target)))) {
      findings.push(`${relative(rootPath, path)}: local link target does not exist: ${target}`);
    }
  }
}

const npmrcPath = join(rootPath, ".npmrc");
if (await exists(npmrcPath)) {
  const npmrc = await readFile(npmrcPath, "utf8");
  if (/(?:_authToken|_password|username)\s*=\s*(?!\$\{)[^\s#]+/i.test(npmrc)) {
    findings.push(".npmrc: possible literal registry credential");
  }
}

if (findings.length > 0) {
  console.error("Public release check failed:\n" + findings.map((finding) => `- ${finding}`).join("\n"));
  process.exit(1);
}

console.log(`Public release check passed (${requiredFiles.length} community files, ${packagePaths.length} private packages).`);
