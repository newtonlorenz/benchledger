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
  it("advertises canonical evidence and units first and still accepts the legacy aliases", () => {
    const schema = schemaFor("create_inventory_item") as { properties: { evidence: { properties: { state: { enum: string[] } } }; quantity: { properties: { unit: { enum: string[] } } } } };
    const states = schema.properties.evidence.properties.state.enum;
    const units = schema.properties.quantity.properties.unit.enum;
    expect(states.slice(0, 7)).toEqual(["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"]);
    expect(states).toContain("physical_count"); expect(states).toContain("delivery");
    expect(units.slice(0, 6)).toEqual(["each", "gram", "millimetre", "millilitre", "metre", "set"]);
    expect(units).toContain("piece");
    for (const state of states) expect(() => evidence({ state, source: "synthetic", recordedAt: "2026-09-07T00:00:00Z" }, "evidence")).not.toThrow();
    for (const unit of units) expect(() => quantity({ value: 1, unit }, "quantity")).not.toThrow();
  });

  it("publishes only flat object input schemas that model tool APIs accept", () => {
    for (const tool of publicToolDefinitions()) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type, String(tool.name)).toBe("object");
      for (const keyword of ["oneOf", "anyOf", "allOf", "not", "if", "enum"]) expect(schema, `${String(tool.name)} root ${keyword}`).not.toHaveProperty(keyword);
    }
    const artifacts = ajv.compile(schemaFor("list_artifacts"));
    expect(artifacts({ projectId: "p" })).toBe(true);
    expect(artifacts({ projectId: "p", projectRevisionId: "r" })).toBe(true);
    expect(artifacts({ projectRevisionId: "r" })).toBe(false);
    const catalog = ajv.compile(schemaFor("create_catalog_product"));
    expect(catalog({ kind: "printer", manufacturer: "Synthetic", exactModel: "S1", technology: "fff", buildVolumeMm: { x: 1, y: 1, z: 1 } })).toBe(true);
    expect(catalog({ kind: "laser", manufacturer: "Synthetic" })).toBe(false);
  });

  it("advertises enums wherever the validator enforces a closed vocabulary", () => {
    const props = (name: string) => (schemaFor(name) as { properties: Record<string, { enum?: string[]; type?: string }> }).properties;
    expect(props("list_inventory").availability?.enum).toContain("inspect_first");
    expect(props("list_inventory").category?.enum).toEqual(["printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"]);
    expect(props("record_stock_event").kind?.enum).toContain("count_correction");
    expect(props("create_bom_line").unit?.enum).toContain("each");
    expect(props("create_bom_line").requirement?.enum).toEqual(["required", "optional"]);
    expect(props("update_bom_line").unit?.enum).toContain("set");
    expect(props("create_work_item").kind?.enum).toContain("part");
    expect(props("update_inventory_item").condition?.enum).toContain("needs_repair");
  });

  it("requires expectedVersion on every update of an existing record", () => {
    for (const name of ["update_inventory_item", "update_catalog_product", "update_project", "archive_project", "restore_project", "update_bom_line", "release_reservation", "retire_artifact", "retire_inventory_item", "commit_reconciliation", "update_inventory_category", "archive_inventory_category", "retire_bom_line", "restore_bom_line", "update_project_revision", "remove_project", "commission_inventory_item"]) {
      expect((schemaFor(name) as { required?: string[] }).required, name).toContain("expectedVersion");
    }
  });

  it("publishes MCP annotations and an optional idempotencyKey on every write", () => {
    const tools = publicToolDefinitions();
    for (const tool of tools) {
      const annotations = tool.annotations as Record<string, boolean>;
      expect(annotations.openWorldHint, String(tool.name)).toBe(false);
      expect(typeof annotations.readOnlyHint).toBe("boolean");
      const properties = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
      if (annotations.readOnlyHint) expect(properties, String(tool.name)).not.toHaveProperty("idempotencyKey");
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations as Record<string, boolean>]));
    expect(byName.get("list_inventory")).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(byName.get("remove_project")).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(byName.get("retire_inventory_item")).toMatchObject({ destructiveHint: true });
    expect(byName.get("archive_project")).toMatchObject({ destructiveHint: true });
    expect(byName.get("create_project")).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(byName.get("preview_project_setup")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.has("retire_project")).toBe(false);
    for (const name of ["commission_inventory_item", "save_build_plan", "commit_bom_import", "create_project"]) {
      expect((schemaFor(name) as { properties: Record<string, unknown> }).properties, name).toHaveProperty("idempotencyKey");
    }
  });

  it("keeps tool descriptions short enough for the token budget", () => {
    for (const tool of publicToolDefinitions()) expect(String(tool.description).length, String(tool.name)).toBeLessThanOrEqual(400);
  });
});
