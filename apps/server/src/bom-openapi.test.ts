import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

type OpenApiSchema = {
  additionalProperties?: boolean;
  properties?: Record<string, OpenApiSchema>;
  oneOf?: OpenApiSchema[];
  required?: string[];
  type?: string;
};

type OpenApiDocument = {
  components: { schemas: Record<string, OpenApiSchema> };
  paths: Record<string, Record<string, { requestBody?: { content?: { "application/json"?: { schema?: { $ref?: string } } } } }>>;
};

describe("BOM OpenAPI contract", () => {
  it("documents nullable BOM roles and both write request bodies", async () => {
    const app = await createApp({ demo: true, logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
      expect(response.statusCode).toBe(200);
      const document = response.json<OpenApiDocument>();
      const roleSchema = document.components.schemas.BomLine?.properties?.role;
      expect(document.components.schemas).toEqual(expect.objectContaining({ BomLine: expect.any(Object), CreateBomLine: expect.any(Object), UpdateBomLine: expect.any(Object) }));
      expect(roleSchema?.oneOf).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "string", enum: ["consumed", "reusable"] }),
        expect.objectContaining({ type: "null" })
      ]));
      expect(document.components.schemas.CreateBomLine).toMatchObject({ required: ["name", "requiredQuantity", "unit", "optional", "alternatives"], additionalProperties: false });
      expect(document.components.schemas.CreateBomLine?.properties?.role?.oneOf).toEqual(expect.arrayContaining([expect.objectContaining({ type: "null" })]));
      expect(document.components.schemas.UpdateBomLine).toMatchObject({ additionalProperties: false });
      expect(document.components.schemas.UpdateBomLine?.properties?.role?.oneOf).toEqual(expect.arrayContaining([expect.objectContaining({ type: "null" })]));
      expect(document.paths["/project-revisions/{id}/bom"]?.post?.requestBody?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/CreateBomLine" });
      expect(document.paths["/bom-lines/{id}"]?.patch?.requestBody?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/UpdateBomLine" });
    } finally {
      await app.close();
    }
  });
});
