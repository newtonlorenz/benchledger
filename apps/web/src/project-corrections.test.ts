import { describe, expect, it, vi } from "vitest";
import { createSampleWorkspaceAdapter } from "./api";

describe("sample correction parity", () => {
  it("preserves project contents through metadata edits and reversible removal", async () => {
    const adapter = createSampleWorkspaceAdapter();
    const original = await adapter.createProject({ name: "Synthetic correction", description: "A useful fixture", fabricationRoute: "none" });
    expect(original.version).toBe(1);
    const withLine = await adapter.createBomLine(original.id, { name: "Fixing screws", requiredQuantity: 4, unit: "each", role: "consumed" });
    const line = withLine.bom[0]!;
    const corrected = await adapter.updateBomLine(original.id, line.id, { name: "M3 screws", requiredQuantity: 8, note: "Count before building" }, line.version);
    await expect(adapter.updateBomLine(original.id, line.id, { requiredQuantity: -1 }, corrected.bom[0]!.version)).rejects.toMatchObject({ status: 400 });
    expect(corrected.bom[0]).toMatchObject({ label: "M3 screws", required: 8, version: line.version + 1 });
    await expect(adapter.updateBomLine(original.id, line.id, { requiredQuantity: 3 }, line.version)).rejects.toMatchObject({ status: 409 });
    const edited = await adapter.updateProject(original.id, { name: "Reusable fixture", description: "Test the fit", status: "building" }, corrected.version!);
    expect(edited.bom).toHaveLength(1);
    const retired = await adapter.retireBomLine(original.id, line.id, corrected.bom[0]!.version);
    expect(retired.bom).toHaveLength(0);
    const history = await adapter.listRetiredBomLines(original.id); expect(history).toHaveLength(1);
    const restored = await adapter.restoreBomLine(original.id, line.id, history[0]!.version);
    expect(restored.bom[0]).toMatchObject({ label: "M3 screws", required: 8 });
    expect(await adapter.listRetiredBomLines(original.id)).toEqual([]);
  });
});

it("sample requirements and projects remain distinct within one clock tick", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1234567890);
  try {
    const adapter = createSampleWorkspaceAdapter();
    const first = await adapter.createProject({ name: "First", description: "Synthetic" });
    const second = await adapter.createProject({ name: "Second", description: "Synthetic" });
    expect(first.id).not.toBe(second.id);
    await adapter.createBomLine(first.id, { name: "First screw", requiredQuantity: 1, unit: "each" });
    const result = await adapter.createBomLine(first.id, { name: "Second screw", requiredQuantity: 1, unit: "each" });
    expect(new Set(result.bom.map((line) => line.id)).size).toBe(2);
  } finally { clock.mockRestore(); }
});
