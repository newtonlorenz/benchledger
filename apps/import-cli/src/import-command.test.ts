import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InventoryRepository } from "@benchledger/database";
import { createStockEvent } from "@benchledger/domain";
import { buildImportPlan } from "@benchledger/importers";
import { createProductionRuntime, type ProductionRuntime } from "@benchledger/runtime";
import { runImportCommand, type CommandOutput } from "./import-command.js";

const privateOrder = "PRIVATE-ORDER-DO-NOT-PRINT";
const privateEmail = "PRIVATE-EMAIL-DO-NOT-PRINT";
const privateItemBody = "PRIVATE ITEM BODY DO NOT PRINT";

const source = {
  schema_version: 1,
  as_of: "2026-08-30",
  currency: "EUR",
  items: [
    {
      id: "board-confirmed",
      category: "electronics",
      name: "ESP32 board",
      purchased_qty: 2,
      unit: "board",
      status: "physically_confirmed",
      reuse_policy: "available",
      source: { vendor: "Fixture Vendor", order: privateOrder, email_id: privateEmail, unit_price: 4.5 },
      notes: privateItemBody
    },
    {
      id: "wire-uncounted",
      category: "electrical",
      name: "Silicone wire",
      purchased_qty: 10,
      unit: "meter",
      status: "delivered_uncounted",
      reuse_policy: "inspect_first",
      source: { vendor: "Fixture Vendor", order: privateOrder, email_id: privateEmail }
    }
  ]
} as const;

const contexts = new Set<ProductionRuntime>();
const directories: string[] = [];

async function fixture(): Promise<{ readonly inventoryFile: string; readonly dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "benchledger-import-cli-"));
  directories.push(root);
  const inventoryFile = join(root, "private-inventory.json");
  const dataDir = join(root, "data");
  await writeFile(inventoryFile, `${JSON.stringify(source)}\n`, { encoding: "utf8", mode: 0o600 });
  return { inventoryFile, dataDir };
}

function outputJson(output: CommandOutput): Record<string, unknown> {
  return JSON.parse(output.stdout) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all([...contexts].map((runtime) => runtime.close()));
  contexts.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("private legacy inventory import command", () => {
  it("validates paths before opening the database and refuses relative or checkout data paths", async () => {
    const files = await fixture();
    const relative = await runImportCommand(["--inventory-file", files.inventoryFile, "--data-dir", "relative-data", "--json"]);
    expect(relative.exitCode).toBe(1);
    expect(relative.stdout).toContain('"code":"unsafe_path"');
    expect(relative.stderr).not.toContain(privateItemBody);

    const checkoutData = await runImportCommand(["--inventory-file", files.inventoryFile, "--data-dir", resolve("benchledger"), "--json"]);
    expect(checkoutData.exitCode).toBe(1);
    expect(checkoutData.stdout).toContain('"code":"unsafe_path"');
    expect(checkoutData.stdout).not.toContain("benchledger.sqlite");

    const broadData = await runImportCommand(["--inventory-file", files.inventoryFile, "--data-dir", "/", "--json"]);
    expect(broadData.exitCode).toBe(1);
    expect(broadData.stdout).toContain('"code":"unsafe_path"');
  });

  it("supports a privacy-safe dry run and leaves item/event rows untouched", async () => {
    const files = await fixture();
    const output = await runImportCommand(["--inventory-file", files.inventoryFile, "--data-dir", files.dataDir, "--dry-run", "--json"]);
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe("");
    expect(outputJson(output)).toMatchObject({
      ok: true,
      mode: "dry-run",
      sourceItems: 2,
      createdItems: 2,
      updatedItems: 0,
      eventsToInsert: 2,
      duplicateEvents: 0,
      auditRecordsToInsert: 2,
      confirmedItems: 1,
      uncertainItems: 1
    });
    expect(output.stdout).not.toContain(privateOrder);
    expect(output.stdout).not.toContain(privateEmail);
    expect(output.stdout).not.toContain(privateItemBody);

    const runtime = await createProductionRuntime({ dataDir: files.dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    contexts.add(runtime);
    expect(runtime.database.all("SELECT COUNT(*) AS count FROM inventory_items")[0]?.count).toBe(0);
    expect(runtime.database.all("SELECT COUNT(*) AS count FROM stock_events")[0]?.count).toBe(0);
    expect(runtime.database.all("SELECT COUNT(*) AS count FROM audit_log")[0]?.count).toBe(0);
  });

  it("applies once, preserves uncertain stock as evidence, and is idempotent on replay", async () => {
    const files = await fixture();
    const first = await runImportCommand(["--inventory-file", files.inventoryFile, "--data-dir", files.dataDir, "--json"]);
    expect(first.exitCode).toBe(0);
    expect(outputJson(first)).toMatchObject({ ok: true, mode: "apply", createdItems: 2, updatedItems: 0, eventsToInsert: 2, auditRecordsToInsert: 2 });

    const second = await runImportCommand(["--inventory-file", files.inventoryFile, "--data-dir", files.dataDir, "--json"]);
    expect(second.exitCode).toBe(0);
    expect(outputJson(second)).toMatchObject({ ok: true, mode: "apply", createdItems: 0, updatedItems: 2, eventsToInsert: 0, duplicateEvents: 2, auditRecordsToInsert: 0 });

    const runtime = await createProductionRuntime({ dataDir: files.dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    contexts.add(runtime);
    const confirmed = await runtime.ports.inventory.getItem("board-confirmed");
    const uncounted = await runtime.ports.inventory.getItem("wire-uncounted");
    expect(confirmed).toMatchObject({ quantity: 2, availableQuantity: 2, evidence: { state: "physically_counted" } });
    expect(uncounted).toMatchObject({ quantity: 10, availableQuantity: 0, evidence: { state: "delivered_uncounted" } });
    expect(runtime.database.all("SELECT COUNT(*) AS count FROM inventory_items")[0]?.count).toBe(2);
    expect(runtime.database.all("SELECT COUNT(*) AS count FROM stock_events")[0]?.count).toBe(2);
    expect(runtime.database.all("SELECT COUNT(*) AS count FROM audit_log")[0]?.count).toBe(2);
    expect(second.stdout).not.toContain(privateOrder);
    expect(second.stdout).not.toContain(privateEmail);
    expect(second.stdout).not.toContain(privateItemBody);
  });

  it("rolls the whole import back when a later SQLite write fails", async () => {
    const files = await fixture();
    const seeded = await createProductionRuntime({ dataDir: files.dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    contexts.add(seeded);
    await seeded.ports.inventory.createItem({ id: "wire-uncounted", name: "Existing wire", kind: "wire", quantity: 1, unit: "metre", tags: [], links: [], evidence: { state: "physically_counted" } }, {
      actor: "test", source: "test", correlationId: "rollback", scopes: new Set(["read", "write"])
    });
    const plan = buildImportPlan(source);
    const repository = new InventoryRepository(seeded.database);
    repository.appendStockEvent(createStockEvent({
      id: plan.events[1]?.id ?? "collision",
      itemId: "wire-uncounted",
      kind: "count",
      quantity: 1,
      unit: "meter",
      reason: "seed collision",
      source: "test",
      idempotencyKey: "seed-collision",
      occurredAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z"
    }));
    await seeded.close();
    contexts.delete(seeded);

    const output = await runImportCommand(["--inventory-file", files.inventoryFile, "--data-dir", files.dataDir, "--json"]);
    expect(output.exitCode).toBe(1);
    expect(output.stdout).toContain('"code":"import_failed"');
    expect(output.stdout).not.toContain(privateOrder);
    expect(output.stdout).not.toContain(privateEmail);
    expect(output.stdout).not.toContain(privateItemBody);

    const reopened = await createProductionRuntime({ dataDir: files.dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    contexts.add(reopened);
    expect(await reopened.ports.inventory.getItem("board-confirmed")).toBeNull();
    expect(await reopened.ports.inventory.getItem("wire-uncounted")).toMatchObject({ name: "Existing wire", quantity: 1 });
    expect(reopened.database.all("SELECT COUNT(*) AS count FROM audit_log")[0]?.count).toBe(0);
    expect(reopened.database.all("SELECT COUNT(*) AS count FROM stock_events")[0]?.count).toBe(2);
  });

  it("does not leak malformed input bodies or private source details in errors", async () => {
    const files = await fixture();
    await writeFile(files.inventoryFile, `{ "items": ["${privateItemBody}"], "order": "${privateOrder}",`, { encoding: "utf8", mode: 0o600 });
    const output = await runImportCommand(["--inventory-file", files.inventoryFile, "--data-dir", files.dataDir, "--json"]);
    expect(output.exitCode).toBe(1);
    expect(output.stdout).toContain('"code":"invalid_inventory"');
    expect(output.stdout).not.toContain(privateOrder);
    expect(output.stdout).not.toContain(privateEmail);
    expect(output.stdout).not.toContain(privateItemBody);
    expect(output.stderr).not.toContain(privateOrder);
    expect(output.stderr).not.toContain(privateEmail);
    expect(output.stderr).not.toContain(privateItemBody);
    const bytes = await readFile(files.inventoryFile);
    expect(createHash("sha256").update(bytes).digest("hex")).toHaveLength(64);
  });
});
