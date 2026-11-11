import { expect, it } from "vitest";
import { inventoryList } from "./validation.js";
import { TOOL_DEFINITIONS } from "./capabilities.js";
it("advertises and validates the shared inventory queues and ordering", () => {
  expect(inventoryList({ stockView: "check", sort: "location" })).toMatchObject({ stockView: "check", sort: "location" });
  for (const input of [{ stockView: "ready_to_build" }, { sort: "quantity" }]) expect(() => inventoryList(input)).toThrow();
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "list_inventory")!;
  expect(definition.inputSchema.properties).toMatchObject({ stockView: { enum: ["available", "check", "reserved", "depleted"] }, sort: { enum: ["name", "name_desc", "location"] } });
});
