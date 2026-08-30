import { readFile, stat } from "node:fs/promises";
import { AuditRepository, InventoryRepository, type BenchDatabase, type SqliteRow } from "@benchledger/database";
import { buildImportPlan, importInventory, parseInventoryDocument, type ImportPlan, type InventoryImportTarget } from "@benchledger/importers";
import { createProductionRuntime, type ProductionRuntime } from "@benchledger/runtime";
import { UnsafeImportPathError, validateImportPaths } from "./paths.js";

const MAX_INVENTORY_BYTES = 8 * 1024 * 1024;
const IMPORT_ACTOR = "private-inventory-import";

type CommandErrorCode = "usage" | "unsafe_path" | "invalid_inventory" | "import_failed";

class CommandError extends Error {
  constructor(readonly code: CommandErrorCode) {
    super(code);
    this.name = "CommandError";
  }
}

interface CommandArguments {
  readonly inventoryFile: string;
  readonly dataDir: string;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export interface CommandOutput {
  readonly exitCode: 0 | 1;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ImportSummary {
  readonly ok: true;
  readonly mode: "dry-run" | "apply";
  readonly sourceItems: number;
  readonly createdItems: number;
  readonly updatedItems: number;
  readonly eventsToInsert: number;
  readonly duplicateEvents: number;
  readonly auditRecordsToInsert: number;
  readonly confirmedItems: number;
  readonly uncertainItems: number;
}

interface SourceSnapshot {
  readonly value: unknown;
  readonly plan: ImportPlan;
  readonly sourceKey: string;
  readonly importedAt: string;
}

interface ExistingImportRows {
  readonly itemIds: ReadonlySet<string>;
  readonly eventIds: ReadonlySet<string>;
  readonly eventIdempotencyKeys: ReadonlySet<string>;
  readonly auditIds: ReadonlySet<string>;
}

function parseArguments(argv: readonly string[]): CommandArguments {
  let inventoryFile: string | undefined;
  let dataDir: string | undefined;
  let dryRun = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--inventory-file") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new CommandError("usage");
      inventoryFile = value;
      index += 1;
      continue;
    }
    if (argument === "--data-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new CommandError("usage");
      dataDir = value;
      index += 1;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") throw new CommandError("usage");
    throw new CommandError("usage");
  }

  if (inventoryFile === undefined || dataDir === undefined) throw new CommandError("usage");
  return { inventoryFile, dataDir, dryRun, json };
}

function sourceTimestamp(asOf: string | undefined, modifiedAt: Date): string {
  if (asOf !== undefined) {
    const parsed = new Date(asOf);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return modifiedAt.toISOString();
}

async function readSource(path: string): Promise<SourceSnapshot> {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new CommandError("invalid_inventory");
  }
  if (!details.isFile() || details.size > MAX_INVENTORY_BYTES) throw new CommandError("invalid_inventory");

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new CommandError("invalid_inventory");
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new CommandError("invalid_inventory");
  }

  try {
    const document = parseInventoryDocument(value);
    // The source date is the logical evidence batch. Replaying the same dated
    // export is idempotent, and edits to a purchase snapshot cannot silently
    // become a second receipt event.
    const sourceKey = `inventory-json-v${document.schemaVersion}:${document.asOf ?? "undated"}`;
    const importedAt = sourceTimestamp(document.asOf, details.mtime);
    const plan = buildImportPlan(value, { sourceKey, importedAt, actorId: IMPORT_ACTOR });
    return { value, plan, sourceKey, importedAt };
  } catch {
    // Parser/domain errors can contain an item id or source text. The CLI
    // deliberately collapses them to a stable code before anything is emitted.
    throw new CommandError("invalid_inventory");
  }
}

function textSet(rows: readonly SqliteRow[], key: string): ReadonlySet<string> {
  const values = rows.flatMap((row) => {
    const value = row[key];
    return typeof value === "string" ? [value] : [];
  });
  return new Set(values);
}

function existingRows(database: BenchDatabase): ExistingImportRows {
  return {
    itemIds: textSet(database.all("SELECT id FROM inventory_items"), "id"),
    eventIds: textSet(database.all("SELECT id FROM stock_events"), "id"),
    eventIdempotencyKeys: textSet(database.all("SELECT idempotency_key FROM stock_events WHERE idempotency_key IS NOT NULL"), "idempotency_key"),
    auditIds: textSet(database.all("SELECT id FROM audit_log"), "id")
  };
}

function countSummary(plan: ImportPlan, database: BenchDatabase, mode: ImportSummary["mode"]): ImportSummary {
  const existing = existingRows(database);
  let createdItems = 0;
  let updatedItems = 0;
  let eventsToInsert = 0;
  let duplicateEvents = 0;
  let auditRecordsToInsert = 0;
  let confirmedItems = 0;
  let uncertainItems = 0;

  for (const item of plan.items) {
    if (existing.itemIds.has(item.id)) updatedItems += 1;
    else createdItems += 1;
    if (item.confidence === "confirmed") confirmedItems += 1;
    else uncertainItems += 1;
  }
  for (const event of plan.events) {
    if (existing.eventIds.has(event.id) || (event.idempotencyKey !== undefined && existing.eventIdempotencyKeys.has(event.idempotencyKey))) duplicateEvents += 1;
    else eventsToInsert += 1;
  }
  for (const record of plan.auditRecords) {
    if (!existing.auditIds.has(record.id)) auditRecordsToInsert += 1;
  }
  return {
    ok: true,
    mode,
    sourceItems: plan.items.length,
    createdItems,
    updatedItems,
    eventsToInsert,
    duplicateEvents,
    auditRecordsToInsert,
    confirmedItems,
    uncertainItems
  };
}

function runtimeTarget(runtime: ProductionRuntime): InventoryImportTarget {
  const inventory = new InventoryRepository(runtime.database);
  const audits = new AuditRepository(runtime.database);
  return {
    get: (id) => inventory.get(id),
    upsert: (item) => inventory.upsert(item),
    appendStockEvent: (event) => inventory.appendStockEvent(event),
    appendAuditRecord: (record) => {
      // Audit ids are deterministic for a source batch. Treat an existing id
      // as a replay instead of allowing a primary-key error on the second run.
      const existing = runtime.database.get("SELECT id FROM audit_log WHERE id = ?", [record.id]);
      if (existing !== undefined) return { inserted: false, record };
      return { inserted: true, record: audits.append(record) };
    }
  };
}

function humanSummary(summary: ImportSummary): string {
  return [
    `BenchLedger inventory import (${summary.mode})`,
    `Source items: ${summary.sourceItems}`,
    `New items: ${summary.createdItems}`,
    `Existing items refreshed: ${summary.updatedItems}`,
    `Stock events: ${summary.eventsToInsert} new, ${summary.duplicateEvents} replayed`,
    `Audit records: ${summary.auditRecordsToInsert} new`,
    `Confirmed: ${summary.confirmedItems}; physical count required: ${summary.uncertainItems}`
  ].join("\n");
}

function safeErrorCode(error: unknown): CommandErrorCode {
  if (error instanceof CommandError) return error.code;
  if (error instanceof UnsafeImportPathError) return "unsafe_path";
  return "import_failed";
}

function successOutput(summary: ImportSummary, json: boolean): CommandOutput {
  return { exitCode: 0, stdout: json ? `${JSON.stringify(summary)}\n` : `${humanSummary(summary)}\n`, stderr: "" };
}

function failureOutput(code: CommandErrorCode, json: boolean): CommandOutput {
  const payload = { ok: false, error: { code } };
  if (json) return { exitCode: 1, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
  return { exitCode: 1, stdout: "", stderr: `BenchLedger inventory import failed (${code})\n` };
}

/**
 * Run the private import without exposing a route or a raw source payload.
 * The command reads and validates the complete source before opening the
 * runtime, then applies all repository writes in one SQLite transaction.
 */
export async function runImportCommand(argv: readonly string[]): Promise<CommandOutput> {
  let argumentsValue: CommandArguments;
  try {
    argumentsValue = parseArguments(argv);
  } catch (error: unknown) {
    return failureOutput(safeErrorCode(error), argv.includes("--json"));
  }

  let snapshot: SourceSnapshot;
  try {
    const paths = await validateImportPaths(argumentsValue.inventoryFile, argumentsValue.dataDir);
    snapshot = await readSource(paths.inventoryFile);
    const runtime = await createProductionRuntime({ dataDir: paths.dataDir });
    try {
      const mode: ImportSummary["mode"] = argumentsValue.dryRun ? "dry-run" : "apply";
      const before = countSummary(snapshot.plan, runtime.database, mode);
      if (argumentsValue.dryRun) return successOutput(before, argumentsValue.json);

      try {
        runtime.database.transaction(() => {
          importInventory(snapshot.value, runtimeTarget(runtime), {
            sourceKey: snapshot.sourceKey,
            importedAt: snapshot.importedAt,
            actorId: IMPORT_ACTOR
          });
        });
      } catch {
        throw new CommandError("import_failed");
      }
      return successOutput(before, argumentsValue.json);
    } finally {
      await runtime.close();
    }
  } catch (error: unknown) {
    return failureOutput(safeErrorCode(error), argumentsValue.json);
  }
}

export function usageText(): string {
  return [
    "Usage: benchledger-import --inventory-file ABSOLUTE_JSON --data-dir ABSOLUTE_DATA_DIR [--dry-run] [--json]",
    "The data directory must be a dedicated path outside the BenchLedger checkout."
  ].join("\n");
}
