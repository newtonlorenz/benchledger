import { describe, expect, it, vi } from "vitest";
import { canWriteWorkspace } from "./client";
import { createDemoClient, demoFetcher } from "./demo";

describe("offline sample workspace", () => {
  it("browses validated synthetic records without network access", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
    const client = createDemoClient();
    try {
      const { session } = await client.connect();
      expect(canWriteWorkspace(session)).toBe(false);
      const inventory = await client.inventory();
      expect(inventory.data.length).toBeGreaterThan(0);
      expect((await client.item(inventory.data[0]!.id)).id).toBe(inventory.data[0]!.id);
      expect((await client.inventory("no such sample item")).data).toEqual([]);
      for (const project of (await client.projects()).data) {
        const detail = await client.project(project.id);
        if (detail.project.currentRevisionId) {
          await client.revision(detail.project.currentRevisionId);
          await client.bom(detail.project.currentRevisionId);
        }
      }
      expect(network).not.toHaveBeenCalled();
    } finally { client.dispose(); network.mockRestore(); }
  });
  it("rejects writes, unknown routes and other origins", async () => {
    for (const [url, method, status] of [
      ["https://sample.invalid/api/v1/inventory", "POST", 403],
      ["https://other.invalid/api/v1/health", "GET", 403],
      ["https://sample.invalid/api/v1/missing", "GET", 404]
    ] as const) expect((await demoFetcher(url, { method })).status).toBe(status);
  });
});
