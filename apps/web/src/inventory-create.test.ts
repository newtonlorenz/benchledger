import { describe, expect, it, vi } from "vitest";
import { ApiError, createSampleWorkspaceAdapter } from "./api";
import type { InventoryCreateInput } from "./api";
import { createInventoryWithCount } from "./inventory-create";

const input: InventoryCreateInput = { name: "M3 heat-set inserts", category: "Hardware", kind: "part", quantity: 50, unit: "each" } as unknown as InventoryCreateInput;

describe("add item with an inline count", () => {
  it("only records a physical count when the maker ticked it", async () => {
    const adapter = createSampleWorkspaceAdapter();
    const recordCount = vi.spyOn(adapter, "recordCount");
    const plain = await createInventoryWithCount(adapter, input, false);
    expect(recordCount).not.toHaveBeenCalled();
    expect(plain.counted).toBe(false);
    const counted = await createInventoryWithCount(adapter, input, true);
    expect(recordCount).toHaveBeenCalledWith(counted.item.id, 50);
    expect(counted.counted).toBe(true);
  });

  it("keeps the created item when the count could not be saved", async () => {
    const adapter = createSampleWorkspaceAdapter();
    vi.spyOn(adapter, "recordCount").mockRejectedValue(new ApiError("offline", { kind: "offline" }));
    const result = await createInventoryWithCount(adapter, input, true);
    expect(result.item.name).toBe("M3 heat-set inserts");
    expect(result.counted).toBe(false);
    expect(result.countError).toBeInstanceOf(ApiError);
  });
});
