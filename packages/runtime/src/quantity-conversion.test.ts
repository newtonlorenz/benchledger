import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestContext } from "@benchledger/application";
import { createProductionRuntime, type ProductionRuntime } from "./index.js";

const runtimes: ProductionRuntime[] = [];
const directories: string[] = [];

const context: RequestContext = {
  actor: "runtime-quantity-conversion-test",
  source: "api",
  correlationId: "runtime-quantity-conversion-correlation",
  scopes: new Set(["read", "write"]),
};

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production BOM quantity conversion persistence", () => {
  it("round-trips the canonical nested conversion after a runtime restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "benchledger-quantity-conversion-"));
    directories.push(dataDir);
    const first = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(first);

    const project = await first.ports.projects.createProject({ id: "conversion-project", name: "Conversion project", status: "planned" }, context);
    const revision = await first.ports.projects.createProjectRevision(project.id, { id: "conversion-revision", name: "Initial", status: "concept" }, context);
    await first.ports.inventory.createItem({
      id: "conversion-set",
      name: "LED set",
      kind: "electronic",
      quantity: 2,
      availableQuantity: 2,
      unit: "set",
      tags: [],
      links: [],
      evidence: { state: "physically_counted" },
    }, context);
    const conversion = {
      inventory: { quantity: 1, unit: "set" as const },
      requirement: { quantity: 10, unit: "each" as const },
      evidence: {
        basis: "package_label" as const,
        observedAt: "2026-09-02T10:00:00.000Z",
        source: "synthetic package label",
        sourceId: "synthetic-label-1",
        note: "Ten pieces per sealed set.",
      },
    } as const;
    const alternatives = [{
      itemId: "conversion-set",
      reason: "Reviewed package alternative",
      compatible: "confirmed" as const,
      quantityConversion: conversion,
    }];

    const created = await first.ports.projects.createBomLine(revision.id, {
      id: "conversion-line",
      name: "LEDs",
      requiredQuantity: 15,
      unit: "each",
      optional: false,
      constraints: {},
      alternatives,
    }, context);
    expect(created.alternatives).toEqual(alternatives);

    await first.close();
    const second = await createProductionRuntime({ dataDir, maxUploadBytes: 1024 * 1024, maxStorageBytes: 4 * 1024 * 1024 });
    runtimes.push(second);

    await expect(second.ports.projects.getBomLine(created.id)).resolves.toEqual(created);
    await expect(second.ports.projects.listBomLines(revision.id)).resolves.toEqual([created]);

    const updated = await second.ports.projects.updateBomLine(created.id, { alternatives }, created.version, context);
    expect(updated.alternatives).toEqual(alternatives);
  });
});
