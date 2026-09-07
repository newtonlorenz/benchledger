import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { publicToolDefinitions } from "./capabilities.js";
import { evidence, quantity, projectSetupProposal } from "./validation.js";
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const schemaFor = (name: string) => publicToolDefinitions().find((tool) => tool.name === name)!.inputSchema as object;
const proposal = { project: { name: "Synthetic agent setup", status: "planned" }, revision: { name: "Initial", status: "concept", fabricationRoute: "none" }, workItems: [], bomLines: [{ localRef: "part", name: "Synthetic bracket", requiredQuantity: 1, unit: "each", role: "consumed", optional: false, alternatives: [] }], reservations: [] };
describe("published MCP schemas", () => {
  it("passes the official client discovery envelope and JSON Schema validation for every tool", () => {
    const tools = publicToolDefinitions();
    expect(ListToolsResultSchema.safeParse({ tools }).success).toBe(true);
    for (const tool of tools) {
      expect(ajv.validateSchema(tool.inputSchema as object), `${tool.name}: ${ajv.errorsText()}`).toBe(true);
      expect(() => ajv.compile(tool.inputSchema as object), String(tool.name)).not.toThrow();
    }
  });
  it("accepts the same atomic-setup payload as the application and rejects accidental nesting", () => {
    const validate = ajv.compile(schemaFor("preview_project_setup"));
    expect(validate(proposal), ajv.errorsText(validate.errors)).toBe(true);
    expect(() => projectSetupProposal(proposal)).not.toThrow();
    expect(validate({ type: "object", properties: proposal })).toBe(false);
    expect(validate({ ...proposal, notAnArgument: true })).toBe(false);
  });
  it("advertises the legacy MCP evidence and unit vocabulary, rather than REST labels", () => {
    const schema = schemaFor("create_inventory_item") as { properties: { evidence: { properties: { state: { enum: string[] } } }; quantity: { properties: { unit: { enum: string[] } } } } };
    const states = schema.properties.evidence.properties.state.enum;
    const units = schema.properties.quantity.properties.unit.enum;
    expect(states).toContain("physical_count"); expect(states).toContain("delivery");
    expect(states).not.toContain("physically_counted");
    expect(units).toContain("piece"); expect(units).not.toContain("each");
    for (const state of states) expect(() => evidence({ state, source: "synthetic", recordedAt: "2026-09-07T00:00:00Z" }, "evidence")).not.toThrow();
    for (const unit of units) expect(() => quantity({ value: 1, unit }, "quantity")).not.toThrow();
  });
});
