import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const BENCHLEDGER_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const BROAD_DATA_DIRECTORIES = new Set([
  "/",
  "/tmp",
  "/private",
  "/private/tmp",
  "/var",
  "/var/lib",
  "/Users",
  "/home",
  "/opt",
  "/Volumes",
  "/Applications",
  "/System",
  "/usr"
]);
BROAD_DATA_DIRECTORIES.add(resolve(homedir()));

export class UnsafeImportPathError extends Error {
  constructor() {
    super("unsafe import path");
    this.name = "UnsafeImportPathError";
  }
}

export interface ValidatedImportPaths {
  readonly inventoryFile: string;
  readonly dataDir: string;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isBroadDataDirectory(path: string): boolean {
  return BROAD_DATA_DIRECTORIES.has(resolve(path));
}

async function existingPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function validateInventoryFile(path: string): Promise<string> {
  if (path.trim().length === 0 || !isAbsolute(path)) throw new UnsafeImportPathError();
  const resolved = resolve(path);
  if (isInside(BENCHLEDGER_ROOT, resolved)) throw new UnsafeImportPathError();
  const canonical = await existingPath(resolved);
  if (canonical === undefined || isInside(BENCHLEDGER_ROOT, canonical)) throw new UnsafeImportPathError();
  try {
    const details = await stat(canonical);
    if (!details.isFile()) throw new UnsafeImportPathError();
  } catch {
    throw new UnsafeImportPathError();
  }
  return canonical;
}

async function validateDataDirectory(path: string): Promise<string> {
  if (path.trim().length === 0 || !isAbsolute(path)) throw new UnsafeImportPathError();
  const resolved = resolve(path);
  if (isBroadDataDirectory(resolved) || isInside(BENCHLEDGER_ROOT, resolved)) throw new UnsafeImportPathError();

  const canonical = await existingPath(resolved);
  if (canonical !== undefined) {
    try {
      const details = await stat(canonical);
      if (!details.isDirectory() || isBroadDataDirectory(canonical) || isInside(BENCHLEDGER_ROOT, canonical)) throw new UnsafeImportPathError();
    } catch {
      throw new UnsafeImportPathError();
    }
    return canonical;
  }

  // The production runtime can create the final directory, but its parent
  // must already exist and resolve outside the public checkout. This prevents
  // a typo from turning a broad or checkout path into a new data root.
  const parent = await existingPath(dirname(resolved));
  if (parent === undefined || isBroadDataDirectory(parent) || isInside(BENCHLEDGER_ROOT, parent)) throw new UnsafeImportPathError();
  return resolved;
}

export async function validateImportPaths(inventoryFile: string, dataDir: string): Promise<ValidatedImportPaths> {
  const [validatedInventoryFile, validatedDataDir] = await Promise.all([
    validateInventoryFile(inventoryFile),
    validateDataDirectory(dataDir)
  ]);
  if (validatedInventoryFile === validatedDataDir || isInside(validatedDataDir, validatedInventoryFile)) {
    // Keeping the source outside the persistent data root prevents a later
    // operator from mistaking the imported source document for ledger state.
    throw new UnsafeImportPathError();
  }
  return { inventoryFile: validatedInventoryFile, dataDir: validatedDataDir };
}
