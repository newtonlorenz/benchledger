import { describe, expect, it } from "vitest";
import { createAuditRecord } from "./audit.js";

describe("audit records", () => {
  it("records actor, surface, correlation and versions", () => {
    const record = createAuditRecord({ id: "a1", action: "stock.counted", entityType: "inventory_item", entityId: "item-1", actor: { type: "human", id: "alex" }, sourceSurface: "ui", beforeVersion: 1, afterVersion: 2, metadata: { quantity: 3 } });
    expect(record).toMatchObject({ id: "a1", action: "stock.counted", sourceSurface: "ui", beforeVersion: 1, afterVersion: 2 });
    expect(record.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
