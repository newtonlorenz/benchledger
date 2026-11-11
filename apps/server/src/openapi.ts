import { inventoryImageOpenApi } from "./inventory-image-routes.js";
import { makerWorkflowOpenApi } from "./maker-workflow-routes.js";

/**
 * Hand-maintained OpenAPI 3 description of the REST API served at
 * `/api/v1/openapi.json` (and registered with @fastify/swagger). Keep it in
 * step with the route handlers in app.ts and the api-contract schemas.
 */
export function jsonOpenApi(version: string): Record<string, unknown> {
  // Keep the public description aligned with the canonical
  // createInventoryWithProductProfileSchema. The item half is the existing
  // createInventoryItem contract; the profile half deliberately has no
  // itemId because the service assigns the newly-created item's identity.
  const inventoryWithProductProfileSchema = {
    type: "object",
    additionalProperties: false,
    required: ["item", "profile"],
    properties: {
      item: { $ref: "#/components/schemas/CreateInventoryItem" },
      profile: { $ref: "#/components/schemas/CreateInventoryProductProfileWithoutItem" }
    }
  };
  const inventoryBulkUpdateSchema = {
    type: "object",
    additionalProperties: false,
    required: ["targets", "changes"],
    properties: {
      targets: {
        type: "array", minItems: 1, maxItems: 100,
        items: {
          type: "object", additionalProperties: false, required: ["itemId", "expectedVersion"],
          properties: {
            itemId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
            expectedVersion: { type: "integer", minimum: 1 }
          }
        }
      },
      changes: {
        type: "object", additionalProperties: false, minProperties: 1,
        properties: {
          location: { type: "string", minLength: 1, maxLength: 240 },
          condition: { type: "string", enum: ["new", "good", "worn", "needs_repair", "unknown"] },
          tags: {
            type: "object", additionalProperties: false, minProperties: 1,
            properties: {
              add: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 80 } },
              remove: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 80 } }
            }
          }
        }
      }
    }
  };
  const createInventoryItemSchema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "kind", "quantity", "unit", "tags", "links", "evidence"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      name: { type: "string", minLength: 1, maxLength: 240 },
      kind: { type: "string", enum: ["printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"] },
      categoryNodeId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", description: "Optional user-managed category or subcategory assignment." },
      description: { type: "string", maxLength: 5000 },
      manufacturer: { type: "string", maxLength: 200 },
      model: { type: "string", maxLength: 200 },
      sku: { type: "string", maxLength: 200 },
      quantity: { type: "number", minimum: 0 },
      availableQuantity: { type: "number", minimum: 0, description: "Available confirmed stock. availableQuantity cannot exceed quantity; the server rejects requests that violate this cross-field invariant." },
      unit: { type: "string", enum: ["each", "gram", "millimetre", "millilitre", "metre", "set"] },
      location: { type: "string", maxLength: 240 },
      condition: { type: "string", enum: ["new", "good", "worn", "needs_repair", "unknown"] },
      dimensions: {
        type: "object", additionalProperties: false,
        properties: {
          lengthMm: { type: "number", minimum: 0 }, widthMm: { type: "number", minimum: 0 },
          heightMm: { type: "number", minimum: 0 }, diameterMm: { type: "number", minimum: 0 },
          measured: { type: "boolean" }, uncertaintyMm: { type: "number", minimum: 0 }, note: { type: "string", maxLength: 500 }
        }
      },
      tags: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 80 } },
      links: {
        type: "array", maxItems: 30,
        items: {
          type: "object", additionalProperties: false, required: ["supplier", "url"],
          properties: {
            supplier: { type: "string", minLength: 1, maxLength: 160 }, url: { type: "string", format: "uri", maxLength: 2000 },
            label: { type: "string", maxLength: 200 }, currentPriceMinor: { type: "integer", minimum: 0 }, currency: { type: "string", minLength: 3, maxLength: 3 },
            observedAt: { type: "string", format: "date-time" }, packageQuantity: { type: "number", exclusiveMinimum: 0 }
          }
        }
      },
      evidence: {
        type: "object", additionalProperties: false, required: ["state"],
        properties: {
          state: { type: "string", enum: ["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"] },
          source: { type: "string", maxLength: 500 }, sourceId: { type: "string", maxLength: 500 },
          observedAt: { type: "string", format: "date-time" }, note: { type: "string", maxLength: 1000 }
        }
      }
    }
  };
  const commissionInventoryItemSchema = {
    type: "object", additionalProperties: false,
    required: ["quantity", "unit", "evidence"],
    properties: {
      quantity: { type: "number", minimum: 0, description: "Observed usable quantity after commissioning." },
      unit: { type: "string", enum: ["each", "gram", "millimetre", "millilitre", "metre", "set"] },
      evidence: {
        type: "object", additionalProperties: false, required: ["state", "source", "observedAt"],
        properties: {
          state: { const: "commissioned" }, source: { type: "string", minLength: 1, maxLength: 500 }, sourceId: { type: "string", maxLength: 500 },
          observedAt: { type: "string", format: "date-time" }, note: { type: "string", maxLength: 1000 }
        }
      }
    }
  };
  const createInventoryProductProfileWithoutItemSchema = {
    oneOf: [
      {
        type: "object", additionalProperties: false,
        required: ["catalogProductId", "profileType", "linkState", "details"],
        properties: {
          catalogProductId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
          profileType: { const: "filament_spool" },
          linkState: { type: "string", enum: ["confirmed", "reported", "suggested"] },
          details: {
            type: "object", additionalProperties: false,
            properties: {
              lot: { type: "string", minLength: 1, maxLength: 160 }, batch: { type: "string", minLength: 1, maxLength: 160 },
              lotCode: { type: "string", minLength: 1, maxLength: 160 }, openedState: { type: "string", enum: ["sealed", "open", "unknown"] },
              openedAt: { type: "string", format: "date-time" }, tareMassG: { type: "number", minimum: 0 },
              currentPlacement: { type: "string", minLength: 1, maxLength: 240 }, dryingHistory: { type: "string", maxLength: 2000 }
            }
          }
        }
      },
      {
        type: "object", additionalProperties: false,
        required: ["catalogProductId", "profileType", "linkState", "details"],
        properties: {
          catalogProductId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
          profileType: { const: "printer_asset" },
          linkState: { type: "string", enum: ["confirmed", "reported", "suggested"] },
          details: {
            type: "object", additionalProperties: false,
            properties: {
              assetLabel: { type: "string", minLength: 1, maxLength: 240 }, commissionedAt: { type: "string", format: "date-time" },
              location: { type: "string", minLength: 1, maxLength: 240 }, condition: { type: "string", enum: ["new", "good", "worn", "needs_repair", "unknown"] }
            }
          }
        }
      }
    ]
  };
  const inventoryCategorySchema = {
    type: "object", additionalProperties: false,
    required: ["id", "name", "sortOrder", "archived", "createdAt", "updatedAt", "version"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      name: { type: "string", minLength: 1, maxLength: 120 },
      parentId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      sortOrder: { type: "integer", minimum: 0 },
      archived: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      version: { type: "integer", minimum: 1 }
    }
  };
  const createInventoryCategorySchema = {
    type: "object", additionalProperties: false,
    required: ["name"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      name: { type: "string", minLength: 1, maxLength: 120 },
      parentId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      sortOrder: { type: "integer", minimum: 0, default: 0 }
    }
  };
  const updateInventoryCategorySchema = {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 },
      sortOrder: { type: "integer", minimum: 0 }
    }
  };
  const categoryIdParameter = { name: "id", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" } };
  const categoryVersionParameter = { name: "If-Match", in: "header", required: true, description: "Required category version for optimistic concurrency.", schema: { type: "string", pattern: "^[1-9][0-9]*$" } };
  const inventoryQueryParameters = [
    { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 200 } },
    { name: "kind", in: "query", required: false, schema: { type: "string", enum: ["printer", "tool", "accessory", "consumable", "electronic", "fastener", "filament", "wire", "adhesive", "other"] } },
    { name: "evidence", in: "query", required: false, schema: { type: "string", enum: ["physically_counted", "commissioned", "delivered_uncounted", "ordered_unverified", "allocated", "consumed", "unknown"] } },
    { name: "available", in: "query", required: false, schema: { type: "boolean" } },
    { name: "includeRetired", in: "query", required: false, description: "Include retired inventory history; active rows are returned by default.", schema: { type: "boolean", default: false } },
    { name: "categoryNodeId", in: "query", required: false, description: "Exact managed category or subcategory ID. Mutually exclusive with unassigned=true.", schema: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" } },
    { name: "unassigned", in: "query", required: false, description: "Return inventory without a managed category assignment. Mutually exclusive with categoryNodeId.", schema: { type: "boolean" } },
    { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
    { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 200 } }
  ];
  const projectLifecycleValues = ["idea", "planned", "ready", "building", "validating", "complete", "archived"];
  const fabricationRouteSchema = {
    type: "string",
    enum: ["printed", "ready_made", "none", "undecided"],
    description: "Planning-only manufacturing route. An intended printer is valid only with printed."
  };
  const projectRevisionSchema = {
    type: "object", additionalProperties: false,
    required: ["id", "projectId", "number", "name", "status", "fabricationRoute", "createdAt", "version"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      projectId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      number: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1, maxLength: 240 },
      notes: { type: "string", maxLength: 10000 },
      status: { type: "string", enum: ["concept", "CAD complete", "DFAM reviewed", "mesh validated", "slicer validated", "test printed", "fit/function verified", "production approved"] },
      fabricationRoute: fabricationRouteSchema,
      intendedPrinterItemId: { oneOf: [{ type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }, { type: "null" }], description: "Planning-only owned printer item; null is an explicit clear and omission means no field was supplied." },
      createdAt: { type: "string", format: "date-time" },
      version: { type: "integer", minimum: 1 }
    }
  };
  const createProjectRevisionSchema = {
    type: "object", additionalProperties: false, required: ["name", "status"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
      name: { type: "string", minLength: 1, maxLength: 240 },
      notes: { type: "string", maxLength: 10000 },
      status: { type: "string", enum: ["concept", "CAD complete", "DFAM reviewed", "mesh validated", "slicer validated", "test printed", "fit/function verified", "production approved"] },
      fabricationRoute: fabricationRouteSchema,
      intendedPrinterItemId: { oneOf: [{ type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }, { type: "null" }], description: "Planning-only owned printer item; omit to inherit, or pass null to explicitly clear. A non-null value requires fabricationRoute=printed." }
    },
    description: "When omitted, fabricationRoute and intendedPrinterItemId carry forward from the current revision. A printer assignment requires printed."
  };
  const updateProjectRevisionSchema = {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: {
      fabricationRoute: fabricationRouteSchema,
      intendedPrinterItemId: { oneOf: [{ type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }, { type: "null" }], description: "Planning-only owned printer item; null clears the assignment. A non-null value requires fabricationRoute=printed." }
    },
    description: "Narrow planning update; lifecycle, evidence, BOM, and build configuration are unchanged."
  };
  const createProjectWithInitialRevisionSchema = {
    type: "object", additionalProperties: false, required: ["project", "revision"],
    properties: {
      project: {
        type: "object", additionalProperties: false, required: ["name", "status"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", description: "Optional caller-provided stable project identifier. It is never regenerated or reclaimed after removal." },
          name: { type: "string", minLength: 1, maxLength: 240 },
          description: { type: "string", maxLength: 5000 },
          status: { type: "string", enum: projectLifecycleValues }
        }
      },
      revision: {
        type: "object", additionalProperties: false, required: ["name", "status"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", description: "Optional caller-provided stable initial revision identifier. It must not already exist." },
          name: { type: "string", minLength: 1, maxLength: 240 },
          notes: { type: "string", maxLength: 10000 },
          status: { type: "string", enum: ["concept", "CAD complete", "DFAM reviewed", "mesh validated", "slicer validated", "test printed", "fit/function verified", "production approved"] },
          fabricationRoute: fabricationRouteSchema,
          intendedPrinterItemId: { oneOf: [{ type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }, { type: "null" }], description: "Planning-only owned printer item; omit to leave unassigned, or pass null to explicitly clear. A non-null value requires fabricationRoute=printed." }
        }
      }
    }
  };
  const projectCreationConflictDetailsSchema = {
    type: "object", additionalProperties: false,
    required: ["reason", "field", "id", "retryable", "commitState"],
    description: "Safe conflict details identify only the requested target. No project, revision, record, SQL, or backend details are exposed.",
    properties: {
      reason: { type: "string", enum: ["project_id_exists", "revision_id_exists", "project_name_exists", "idempotency_key_reused"] },
      field: { type: "string", enum: ["projectId", "revisionId", "projectName", "idempotencyKey"] },
      id: { type: "string", minLength: 1, maxLength: 240 },
      retryable: { const: false },
      commitState: { const: "not_committed" },
      commandId: { type: "string", minLength: 1, maxLength: 200 }
    }
  };
  const errorResponseSchema = {
    type: "object", additionalProperties: false, required: ["error"],
    properties: {
      error: {
        type: "object", additionalProperties: false, required: ["code", "message"],
        properties: {
          code: { type: "string", minLength: 1, maxLength: 80 },
          message: { type: "string", minLength: 1, maxLength: 1000 },
          details: { $ref: "#/components/schemas/ProjectCreationConflictDetails" },
          correlationId: { type: "string", minLength: 1, maxLength: 160 }
        }
      }
    }
  };
  const setupProposalSchema = {
    type: "object", additionalProperties: false, required: ["project", "revision", "bomLines"],
    properties: {
      project: { type: "object", additionalProperties: false, required: ["name", "status"], properties: { id: { type: "string", minLength: 1, maxLength: 160 }, name: { type: "string", minLength: 1, maxLength: 240 }, description: { type: "string", maxLength: 5000 }, status: { $ref: "#/components/schemas/ProjectLifecycle" } } },
      revision: { type: "object", additionalProperties: false, required: ["name", "status"], properties: { id: { type: "string", minLength: 1, maxLength: 160 }, name: { type: "string", minLength: 1, maxLength: 240 }, notes: { type: "string", maxLength: 10000 }, status: { type: "string" }, fabricationRoute: fabricationRouteSchema, intendedPrinterItemId: { oneOf: [{ type: "string", minLength: 1, maxLength: 160 }, { type: "null" }] } } },
      workItems: { type: "array", maxItems: 6, default: [], items: { type: "object", additionalProperties: false, required: ["localRef", "name", "kind", "revision"], properties: { localRef: { type: "string", minLength: 1, maxLength: 160 }, id: { type: "string", minLength: 1, maxLength: 160 }, name: { type: "string", minLength: 1, maxLength: 240 }, kind: { type: "string" }, description: { type: "string", maxLength: 5000 }, revision: { type: "object", additionalProperties: false, required: ["name", "status"], properties: { id: { type: "string", minLength: 1, maxLength: 160 }, name: { type: "string", minLength: 1, maxLength: 240 }, notes: { type: "string", maxLength: 10000 }, status: { type: "string" } } } } } },
      bomLines: { type: "array", minItems: 1, maxItems: 24, items: { type: "object", additionalProperties: false, required: ["localRef", "name", "requiredQuantity", "unit"], properties: { localRef: { type: "string", minLength: 1, maxLength: 160 }, revisionLocalRef: { type: "string", minLength: 1, maxLength: 160 }, id: { type: "string", minLength: 1, maxLength: 160 }, name: { type: "string", minLength: 1, maxLength: 240 }, itemId: { type: "string", minLength: 1, maxLength: 160 }, role: { anyOf: [{ type: "string", enum: ["consumed", "reusable"] }, { type: "null" }] }, requiredQuantity: { type: "number", exclusiveMinimum: 0 }, unit: { type: "string" }, optional: { type: "boolean", default: false }, constraints: { type: "object", additionalProperties: false, properties: { kind: { type: "string" }, manufacturer: { type: "string" }, model: { type: "string" }, sku: { type: "string" }, tag: { type: "string" }, nameIncludes: { type: "string" }, specification: { type: "object", additionalProperties: true } } }, alternatives: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["itemId"], properties: { itemId: { type: "string", minLength: 1, maxLength: 160 }, reason: { type: "string", maxLength: 1000 }, compatible: { type: "string", enum: ["confirmed", "conditional", "unknown"] } } } }, notes: { type: "string", maxLength: 2000 } } } },
      reservations: { type: "array", maxItems: 48, default: [], items: { type: "object", additionalProperties: false, required: ["localRef", "bomLineLocalRef", "itemId", "quantity"], properties: { localRef: { type: "string", minLength: 1, maxLength: 160 }, bomLineLocalRef: { type: "string", minLength: 1, maxLength: 160 }, id: { type: "string", minLength: 1, maxLength: 160 }, itemId: { type: "string", minLength: 1, maxLength: 160 }, quantity: { type: "number", exclusiveMinimum: 0 }, unit: { type: "string" } } } }
    }
  };
  const setupPreviewSchema = {
    type: "object", additionalProperties: false, required: ["id", "version", "status", "createdAt", "updatedAt", "expiresAt", "contentSha256", "proposal", "fieldErrors", "unresolvedSpecifications", "gaps", "plannedReservations", "affectedInventory", "correlationId"],
    properties: {
      id: { type: "string" }, version: { type: "integer", minimum: 1 }, status: { type: "string", enum: ["active", "committed", "expired"] }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, expiresAt: { type: "string", format: "date-time" }, contentSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, proposal: setupProposalSchema,
      fieldErrors: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, required: ["path", "code", "message"], properties: { path: { type: "string" }, code: { type: "string" }, message: { type: "string" } } } },
      unresolvedSpecifications: { type: "array", maxItems: 24, items: { type: "object", additionalProperties: false, required: ["bomLineLocalRef", "missingDecisions"], properties: { bomLineLocalRef: { type: "string" }, missingDecisions: { type: "array", items: { type: "string" } } } } },
      gaps: { type: "object", additionalProperties: false, required: ["revisionId", "lines", "totals"], properties: { revisionId: { type: "string" }, lines: { type: "array", maxItems: 24 }, totals: { type: "object", additionalProperties: true } } },
      plannedReservations: { type: "array", maxItems: 48 }, affectedInventory: { type: "array", maxItems: 48 }, correlationId: { type: "string" }
    }
  };
  const artifactIdSchema = { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" };
  const bomRoleSchema = {
    oneOf: [
      { type: "string", enum: ["consumed", "reusable"] },
      { type: "null" }
    ],
    description: "Null is retained for legacy requirements whose stock role was not recorded; it must be reviewed before use."
  };
  const bomSpecificationSchema = {
    type: "object", additionalProperties: false, required: ["status"],
    properties: {
      status: { type: "string", enum: ["sufficient", "insufficient"] },
      decisions: {
        type: "object", additionalProperties: false,
        properties: {
          identity: { type: "string", minLength: 1, maxLength: 240 }, purpose: { type: "string", minLength: 1, maxLength: 240 },
          voltage: { type: "string", minLength: 1, maxLength: 240 }, current_or_load: { type: "string", minLength: 1, maxLength: 240 },
          connector: { type: "string", minLength: 1, maxLength: 240 }, compatibility: { type: "string", minLength: 1, maxLength: 240 },
          dimensions: { type: "string", minLength: 1, maxLength: 240 }, resistance: { type: "string", minLength: 1, maxLength: 240 },
          power_rating: { type: "string", minLength: 1, maxLength: 240 }
        }
      },
      missingDecisions: { type: "array", minItems: 1, maxItems: 9, uniqueItems: true, items: { type: "string", enum: ["identity", "purpose", "voltage", "current_or_load", "connector", "compatibility", "dimensions", "resistance", "power_rating"] } }
    },
    description: "Insufficient specifications must name missing decisions; sufficient specifications must record at least one decision."
  };
  const bomConstraintsSchema = {
    type: "object", additionalProperties: false,
    properties: {
      kind: { type: "string" }, manufacturer: { type: "string" }, model: { type: "string" }, sku: { type: "string" },
      tag: { type: "string" }, nameIncludes: { type: "string" }, specification: bomSpecificationSchema
    }
  };
  const bomQuantityConversionSchema = {
    type: "object", additionalProperties: false, required: ["inventory", "requirement", "evidence"],
    properties: {
      inventory: { type: "object", additionalProperties: false, required: ["quantity", "unit"], properties: { quantity: { const: 1 }, unit: { const: "set" } } },
      requirement: { type: "object", additionalProperties: false, required: ["quantity", "unit"], properties: { quantity: { type: "integer", minimum: 1 }, unit: { const: "each" } } },
      evidence: {
        type: "object", additionalProperties: false, required: ["basis", "observedAt"],
        properties: {
          basis: { type: "string", enum: ["package_label", "manufacturer_spec", "physical_count", "user_assertion"] },
          observedAt: { type: "string", format: "date-time" }, source: { type: "string", maxLength: 500 }, sourceId: { type: "string", maxLength: 500 }, note: { type: "string", maxLength: 1000 }
        }
      }
    }
  };
  const bomAlternativeSchema = {
    type: "object", additionalProperties: false, required: ["itemId"],
    properties: {
      itemId: artifactIdSchema, reason: { type: "string", maxLength: 1000 }, compatible: { type: "string", enum: ["confirmed", "conditional", "unknown"], default: "conditional" },
      quantityConversion: bomQuantityConversionSchema
    }
  };
  const bomWriteProperties = {
    name: { type: "string", minLength: 1, maxLength: 240 }, itemId: artifactIdSchema, role: bomRoleSchema,
    requiredQuantity: { type: "number", exclusiveMinimum: 0 }, unit: { type: "string", enum: ["each", "gram", "millimetre", "millilitre", "metre", "set"] },
    optional: { type: "boolean" }, constraints: bomConstraintsSchema, alternatives: { type: "array", maxItems: 20, items: bomAlternativeSchema }, notes: { type: "string", maxLength: 2000 }
  };
  const bomLineSchema = {
    type: "object", additionalProperties: false,
    required: ["id", "revisionId", "name", "requiredQuantity", "unit", "optional", "constraints", "alternatives", "createdAt", "updatedAt", "version"],
    properties: {
      id: artifactIdSchema, revisionId: artifactIdSchema, ...bomWriteProperties,
      retiredAt: { type: "string", format: "date-time" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, version: { type: "integer", minimum: 1 }
    }
  };
  const createBomLineOpenApiSchema = {
    type: "object", additionalProperties: false,
    required: ["name", "requiredQuantity", "unit", "optional", "alternatives"],
    properties: { id: artifactIdSchema, ...bomWriteProperties }
  };
  const updateBomLineOpenApiSchema = { type: "object", additionalProperties: false, properties: { ...bomWriteProperties, itemId: { anyOf: [artifactIdSchema, { type: "null" }], description: "Null clears the selected inventory item; omission preserves it." } } };
  const artifactRoleSchema = {
    type: "string",
    enum: ["source", "cad", "document", "brief", "design_record", "cad_source", "step", "stl", "three_mf", "slicer_project", "gcode", "firmware", "drawing", "validation", "photo", "text", "other"]
  };
  const artifactScopeSchema = {
    oneOf: [
      { type: "object", additionalProperties: false, required: ["projectRevisionId"], properties: { projectRevisionId: artifactIdSchema } },
      { type: "object", additionalProperties: false, required: ["workItemId", "workItemRevisionId"], properties: { workItemId: artifactIdSchema, workItemRevisionId: artifactIdSchema } }
    ],
    description: "Exactly one revisioned scope: a project revision or a work-item revision."
  };
  const artifactUploadCommonProperties = {
    projectId: artifactIdSchema,
    role: artifactRoleSchema,
    filename: { type: "string", minLength: 1, maxLength: 255 },
    mediaType: { type: "string", minLength: 1, maxLength: 200 },
    byteSize: { type: "integer", exclusiveMinimum: 0, maximum: 104857600 },
    sha256: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" },
    author: { type: "string", maxLength: 200 },
    source: { type: "string", maxLength: 500 }
  };
  const beginUploadSchema = {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["projectId", "projectRevisionId", "role", "filename", "mediaType", "byteSize", "sha256"],
        properties: { ...artifactUploadCommonProperties, projectRevisionId: artifactIdSchema, buildConfigurationSnapshotId: artifactIdSchema }
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["projectId", "workItemId", "workItemRevisionId", "role", "filename", "mediaType", "byteSize", "sha256"],
        properties: { ...artifactUploadCommonProperties, workItemId: artifactIdSchema, workItemRevisionId: artifactIdSchema }
      }
    ],
    description: "Every new upload must contain exactly one revisioned scope and its owning projectId. Legacy revisionId and ambiguous scopes are rejected."
  };
  const artifactListQuerySchema = {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["projectRevisionId"],
        properties: { projectRevisionId: artifactIdSchema, role: artifactRoleSchema }
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["workItemId", "workItemRevisionId"],
        properties: { workItemId: artifactIdSchema, workItemRevisionId: artifactIdSchema, role: artifactRoleSchema }
      },
      {
        type: "object",
        additionalProperties: false,
        properties: { role: artifactRoleSchema }
      }
    ],
    description: "Read-only listing supports one exact project revision, one exact work-item revision, or all artifacts in the project."
  };
  return {
    openapi: "3.1.0",
    info: { title: "BenchLedger API", version, description: "Evidence-based maker inventory and project workspace API." },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    components: {
      securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "Scoped MCP/API token. Store the plaintext token only in the client secret store." },
      cookieAuth: { type: "apiKey", in: "cookie", name: "forge_session" },
      transferAuth: { type: "apiKey", in: "header", name: "X-Bench-Transfer-Token", description: "Short-lived single-purpose capability issued by the authenticated browser/host transfer flow; keep it in the header and never put it in a URL." }
      },
      schemas: {
        CreateInventoryItem: createInventoryItemSchema,
        CommissionInventoryItem: commissionInventoryItemSchema,
        InventoryBulkUpdate: inventoryBulkUpdateSchema,
        CreateInventoryProductProfileWithoutItem: createInventoryProductProfileWithoutItemSchema,
        CreateInventoryWithProductProfile: inventoryWithProductProfileSchema,
        CreateProjectWithInitialRevision: createProjectWithInitialRevisionSchema,
        FabricationRoute: fabricationRouteSchema,
        ProjectRevision: projectRevisionSchema,
        CreateProjectRevision: createProjectRevisionSchema,
        UpdateProjectRevision: updateProjectRevisionSchema,
        BomLine: bomLineSchema,
        CreateBomLine: createBomLineOpenApiSchema,
        UpdateBomLine: updateBomLineOpenApiSchema,
        ProjectSetupProposal: { ...setupProposalSchema, description: "Strict bounded project setup proposal (maximum 6 work items, 24 BOM lines, 48 reservations, 256 KiB)." },
        ProjectSetupPreview: { ...setupPreviewSchema, description: "Strict actor-owned 30-minute project setup preview." },
        CommitProjectSetup: { type: "object", additionalProperties: false, required: ["expectedPreviewVersion", "contentSha256", "confirmReservations"], properties: { expectedPreviewVersion: { type: "integer", minimum: 1 }, contentSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, confirmReservations: { type: "boolean" } } },
        ProjectCreationConflictDetails: projectCreationConflictDetailsSchema,
        ErrorResponse: errorResponseSchema,
        ArtifactScope: artifactScopeSchema,
        BeginUpload: beginUploadSchema,
        ArtifactListQuery: artifactListQuerySchema,
        InventoryCategory: inventoryCategorySchema,
        CreateInventoryCategory: createInventoryCategorySchema,
        UpdateInventoryCategory: updateInventoryCategorySchema,
        ProjectTombstone: { type: "object", additionalProperties: false, required: ["id", "name", "removedAt", "removedBy", "lastLifecycleStatus", "releasedReservationIds", "version"], properties: { id: { type: "string" }, name: { type: "string" }, removedAt: { type: "string", format: "date-time" }, removedBy: { type: "string" }, lastLifecycleStatus: { $ref: "#/components/schemas/ProjectLifecycle" }, releasedReservationIds: { type: "array", items: { type: "string" } }, version: { type: "integer", minimum: 1 }, auditId: { type: "string" } } },
        ProjectLifecycle: { type: "string", enum: projectLifecycleValues, description: "Canonical project lifecycle. Blocked is derived from reasons and is not a lifecycle value." }
      }
    },
    paths: {
      ...makerWorkflowOpenApi(),
      ...inventoryImageOpenApi(),
      "/health": { get: { security: [], responses: { "200": { description: "Service health" } } } },
      "/ready": { get: { security: [], responses: { "200": { description: "Readiness checks" }, "503": { description: "Not ready" } } } },
      "/auth/login": { post: { security: [], responses: { "200": { description: "Session created" }, "401": { description: "Invalid credentials" }, "429": { description: "Too many attempts" } } } },
      "/auth/access": {
        get: { security: [], responses: { "200": { description: "Workspace access mode (mode, passwordConfigured, and version only)" } } },
        patch: {
          security: [{ cookieAuth: [] }],
          summary: "Update browser workspace access mode (operation form)",
          description: "UI-only unscoped administrator session. Requires CSRF, Idempotency-Key, and an operation-first body with expectedVersion (If-Match may also carry the same version). A successful mutation rotates the browser session and invalidates prior sessions.",
          parameters: [
            { in: "header", name: "If-Match", required: false, schema: { type: "string", pattern: "^(W/)?\\\"?[1-9][0-9]*\\\"?$" }, description: "Optional when expectedVersion is present in the body; if both are supplied they must match." },
            { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } }
          ],
          requestBody: { required: true, content: { "application/json": { schema: { oneOf: [
            { type: "object", additionalProperties: false, required: ["operation", "newPassword", "expectedVersion"], properties: { operation: { const: "enable" }, newPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } },
            { type: "object", additionalProperties: false, required: ["operation", "currentPassword", "expectedVersion"], properties: { operation: { const: "disable" }, currentPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } },
            { type: "object", additionalProperties: false, required: ["operation", "currentPassword", "newPassword", "expectedVersion"], properties: { operation: { const: "change_password" }, currentPassword: { type: "string", minLength: 12, maxLength: 512 }, newPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } }
          ] } } } },
          responses: { "200": { description: "Updated workspace access mode and fresh session" }, "400": { description: "Invalid operation" }, "401": { description: "Current password is invalid" }, "403": { description: "UI administrator session required" }, "409": { description: "Stale access version or idempotency conflict" }, "429": { description: "Too many attempts" } }
        }
      },
      "/auth/lan-session": { post: { security: [], responses: { "200": { description: "Explicit LAN session" }, "403": { description: "Password mode is enabled" } } } },
      "/auth/security": {
        post: {
          security: [{ cookieAuth: [] }],
          summary: "Update browser workspace access mode (operation form)",
          parameters: [
            { in: "header", name: "If-Match", required: false, schema: { type: "string", pattern: "^(W/)?\\\"?[1-9][0-9]*\\\"?$" }, description: "Required when expectedVersion is omitted from the body." },
            { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } }
          ],
          requestBody: { required: true, content: { "application/json": { schema: { oneOf: [
            { type: "object", additionalProperties: false, required: ["operation", "newPassword", "expectedVersion"], properties: { operation: { const: "enable" }, newPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } },
            { type: "object", additionalProperties: false, required: ["operation", "currentPassword", "expectedVersion"], properties: { operation: { const: "disable" }, currentPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } },
            { type: "object", additionalProperties: false, required: ["operation", "currentPassword", "newPassword", "expectedVersion"], properties: { operation: { const: "change_password" }, currentPassword: { type: "string", minLength: 12, maxLength: 512 }, newPassword: { type: "string", minLength: 12, maxLength: 512 }, expectedVersion: { type: "integer", minimum: 1 } } }
          ] } } } },
          responses: { "200": { description: "Updated workspace access mode and fresh session" }, "400": { description: "Invalid operation" }, "401": { description: "Current password is invalid" }, "403": { description: "UI administrator session required" }, "409": { description: "Stale access version or idempotency conflict" }, "429": { description: "Too many attempts" } }
        }
      },
      "/workspace": { get: { responses: { "200": { description: "Authenticated aggregate workspace snapshot" } } } },
      "/inventory": { get: { description: "Returns a bounded inventory page; categoryNodeId and unassigned=true are mutually exclusive.", parameters: inventoryQueryParameters, responses: { "200": { description: "Inventory page" } } }, post: { responses: { "201": { description: "Inventory item" } } } },
      "/inventory/categories": {
        get: { parameters: [
          { name: "includeArchived", in: "query", required: false, schema: { type: "boolean", default: false } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 512 } },
        ], responses: { "200": { description: "Managed inventory category page" } } },
        post: { requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateInventoryCategory" } } } }, responses: { "201": { description: "Managed inventory category" } } }
      },
      "/inventory/categories/{id}": {
        parameters: [categoryIdParameter],
        get: { responses: { "200": { description: "Managed inventory category" } } },
        patch: { parameters: [categoryVersionParameter], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateInventoryCategory" } } } }, responses: { "200": { description: "Updated managed inventory category" } } }
      },
      "/inventory/categories/{id}/archive": { parameters: [categoryIdParameter], post: { parameters: [categoryVersionParameter], responses: { "200": { description: "Archived managed inventory category" } } } },
      "/inventory/bulk": {
        patch: {
          summary: "Apply one bounded metadata batch to explicit inventory items",
          description: "Targets carry explicit optimistic versions. The server preflights every target and commits location, condition, and tag add/remove changes atomically; no-op targets keep their version and produce no audit or event.",
          parameters: [{
            name: "Idempotency-Key",
            in: "header",
            required: true,
            description: "Stable command identity used to safely replay an identical bulk update.",
            schema: { type: "string", minLength: 8, maxLength: 200 }
          }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/InventoryBulkUpdate" } } } },
          responses: { "200": { description: "Bulk inventory mutation with per-item audits" }, "400": { description: "Invalid request or missing idempotency key" }, "403": { description: "CSRF, write-scope, or project-scoped denial" }, "409": { description: "Version, idempotency, or atomic commit conflict" } }
        }
      },
      "/inventory/with-product-profile": {
        post: {
          summary: "Create an inventory item and exact physical product profile atomically",
          description: "The strict request contains only item and profile. The profile omits itemId; the server assigns it to the newly-created inventory item and rolls both records back if the compound command cannot commit.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateInventoryWithProductProfile" } } }
          },
          responses: {
            "201": { description: "Inventory item and physical profile mutation" },
            "400": { description: "Invalid compound request" },
            "409": { description: "Conflict or failed atomic commit" }
          }
        }
      },
      "/inventory/{id}": { delete: {
        summary: "Delete an inventory item or printer from active lists, retaining history",
        description: "Workspace-wide write access and session CSRF protection apply. Allocated stock must be released first. No physical stock event is invented. Existing project references retain their identity and need replacement stock. Use a stable Idempotency-Key when retrying.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "If-Match", in: "header", required: true, schema: { type: "integer", minimum: 1 } }, { name: "Idempotency-Key", in: "header", schema: { type: "string" } }],
        responses: { "200": { description: "Retired item with audit receipt" }, "400": { description: "Current item version required" }, "401": { description: "Authentication required" }, "403": { description: "Write access or CSRF rejected" }, "404": { description: "Item not found" }, "409": { description: "Stale version or allocated stock; refresh or release stock first" } }
      }, get: { responses: { "200": { description: "Inventory item" } } }, patch: { responses: { "200": { description: "Updated inventory item" } } } },
      "/inventory/{id}/commission": {
        post: {
          summary: "Commission an uncertain inventory item",
          description: "Records the observed quantity and commissioned provenance as an append-only count event. The item evidence state cannot be changed by generic PATCH.",
          parameters: [
            { name: "If-Match", in: "header", required: true, schema: { type: "integer", minimum: 1 }, description: "Expected inventory item version; stale versions are rejected with 409." },
            { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 }, description: "Stable key for retrying this exact commissioning command; reusing it with different input is rejected." }
          ],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CommissionInventoryItem" } } } },
          responses: { "201": { description: "Commissioning event and resulting inventory item" }, "400": { description: "Invalid commissioning request" }, "409": { description: "Version conflict or invalid evidence transition" } }
        }
      },
      "/inventory/{id}/product-profile": { get: { responses: { "200": { description: "Physical inventory product profile" }, "404": { description: "Profile not found" } } }, put: { responses: { "200": { description: "Updated physical inventory product profile" } } } },
      "/inventory/{id}/count": { post: { responses: { "201": { description: "Recorded physical count" } } } },
      "/inventory/{id}/stock-events": { get: { responses: { "200": { description: "Stock event page" } } }, post: { responses: { "201": { description: "Stock mutation" } } } },
      "/projects": { get: { description: "Returns a bounded project page. Archived and removed projects are hidden by default; status=archived is the explicit reversible Archived view.", parameters: [{ name: "status", in: "query", required: false, schema: { $ref: "#/components/schemas/ProjectLifecycle" } }], responses: { "200": { description: "Project page" } } }, post: { responses: { "201": { description: "Project" } } } },
      "/projects/removed": { get: { description: "List retained project removal tombstones as a bounded page. Removed projects cannot be restored or purged.", parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 200 }, description: "Opaque continuation cursor from the preceding page." }], responses: { "200": { description: "Removed project tombstone page" } } } },
      "/projects/with-initial-revision": {
        post: {
          summary: "Create a project and its first planning revision atomically",
          description: "Accepts optional caller-provided stable project and revision IDs. An identical retry with the same Idempotency-Key replays exactly once. A 409 identifies a project ID, revision ID, generated project name/slug, or reused idempotency key; read the existing project, choose a different ID, or choose a different project name as directed. No records are committed on conflict.",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateProjectWithInitialRevision" } } } },
          responses: {
            "201": { description: "Project and initial revision mutation" },
            "400": { description: "Invalid project, revision, or stable identifier" },
            "409": { description: "Project ID, revision ID, generated project name/slug, or idempotency-key conflict; no records were committed.", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } }
          }
        }
      },
      "/project-setup/previews": { post: { summary: "Preview a bounded project graph setup", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ProjectSetupProposal" } } } }, responses: { "201": { description: "Actor-owned project setup preview" }, "400": { description: "Invalid proposal or semantic field errors" }, "403": { description: "Project-scoped token denied" } } } },
      "/project-setup/previews/{id}/commit": { post: { summary: "Commit an exact project setup preview atomically", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 160 } }, { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CommitProjectSetup" } } } }, responses: { "200": { description: "Complete project graph, one aggregate audit, and context" }, "400": { description: "Invalid commit or missing reservation confirmation" }, "403": { description: "Project-scoped or insufficient scope" }, "409": { description: "Stale basis, identity, reservation, or idempotency conflict" } } } },
      "/projects/{id}/revisions": { post: { requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateProjectRevision" } } } }, responses: { "201": { description: "Project revision" }, "400": { description: "Invalid route/printer planning fields" }, "404": { description: "Project not found" } } } },
      "/project-revisions/{id}": {
        get: { summary: "Read one project revision", responses: { "200": { description: "Project revision", content: { "application/json": { schema: { $ref: "#/components/schemas/ProjectRevision" } } } }, "403": { description: "Revision scope denied" }, "404": { description: "Revision not found" } } },
        patch: {
          summary: "Update revision fabrication route planning",
          description: "Narrow update of fabricationRoute and intendedPrinterItemId. intendedPrinterItemId is planning equipment only; a non-null value requires printed, and null clears the assignment. Lifecycle, evidence, BOM, and build configuration are unchanged.",
          parameters: [{ name: "id", in: "path", required: true, schema: artifactIdSchema }, { name: "If-Match", in: "header", required: true, description: "Expected project revision version for optimistic concurrency.", schema: { type: "string", pattern: "^[1-9][0-9]*$" } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateProjectRevision" } } } },
          responses: { "200": { description: "Updated project revision", content: { "application/json": { schema: { type: "object" } } } }, "400": { description: "Invalid route/printer planning fields or missing If-Match" }, "403": { description: "Revision scope denied" }, "404": { description: "Revision not found" }, "409": { description: "Revision version conflict" } }
        }
      },
      "/projects/{id}/restore": { post: { description: "Restore an archived project to idea; retained history stays in place and released reservations are not recreated.", responses: { "200": { description: "Restored project" }, "400": { description: "Invalid version precondition" }, "409": { description: "Version or project lifecycle conflict" } } } },
      "/projects/{id}": { delete: { description: "Irreversibly remove an archived or active project from ordinary workspace views. Requires exact name confirmation, If-Match, and Idempotency-Key; retained history remains discoverable and no purge is available.", parameters: [{ in: "header", name: "If-Match", required: true, schema: { type: "string" } }, { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 240 } } } } } }, responses: { "200": { description: "Project tombstone and released reservation IDs" }, "400": { description: "Missing preconditions or invalid confirmation" }, "409": { description: "Version, confirmation, or idempotency conflict" }, "410": { description: "Project was already removed" } } } },
      "/projects/{id}/removed-history": { get: { description: "Read a bounded page of append-only audit history for a removed project.", parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 200 }, description: "Opaque continuation cursor from the preceding page." }], responses: { "200": { description: "Removed project audit page" }, "409": { description: "Project has not been removed" } } } },
      "/catalog/products": { get: { responses: { "200": { description: "Bounded exact catalog product page" } } }, post: { responses: { "201": { description: "Catalog product mutation" } } } },
      "/catalog/products/{id}": { get: { responses: { "200": { description: "Exact catalog product" } } }, patch: { responses: { "200": { description: "Updated exact catalog product" } } } },
      "/project-revisions/{id}/bom": { get: { parameters: [{ name: "includeRetired", in: "query", required: false, schema: { type: "boolean", default: false } }], responses: { "200": { description: "Active BOM lines by default; retired history when explicitly requested" } } }, post: { requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateBomLine" } } } }, responses: { "201": { description: "BOM line" } } } },
      "/bom-lines/{id}": { patch: { summary: "Update a BOM requirement, including legacy role repair", parameters: [{ name: "id", in: "path", required: true, schema: artifactIdSchema }, { name: "If-Match", in: "header", required: true, description: "Required expected BOM line version for optimistic concurrency.", schema: { type: "string", pattern: "^[1-9][0-9]*$" } }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateBomLine" } } } }, responses: { "200": { description: "Updated BOM line" }, "400": { description: "Invalid BOM line or malformed version precondition" }, "428": { description: "If-Match is missing; reload the BOM line and retry with its version" }, "409": { description: "Version, active-reservation, or compatibility conflict" } } }, delete: { parameters: [{ name: "If-Match", in: "header", required: true, schema: { type: "integer", minimum: 1 } }], responses: { "200": { description: "Retired BOM line" }, "400": { description: "Missing or invalid version precondition" }, "409": { description: "Version or active-reservation conflict" } } } },
      "/bom-lines/{id}/restore": { post: { parameters: [{ name: "If-Match", in: "header", required: true, schema: { type: "integer", minimum: 1 } }], responses: { "200": { description: "Restored BOM line" }, "400": { description: "Missing or invalid version precondition" }, "409": { description: "Version conflict" } } } },
      "/project-revisions/{id}/build-configurations": { get: { responses: { "200": { description: "Immutable build configuration snapshot page" } } }, post: { responses: { "201": { description: "Immutable build configuration snapshot" } } } },
      "/build-configurations/{id}": { get: { responses: { "200": { description: "Immutable build configuration snapshot" } } } },
      "/project-revisions/{id}/gaps": { get: { responses: { "200": { description: "Evidence-backed BOM gaps" } } } },
      "/project-revisions/{revisionId}/inspections": {
        get: {
          summary: "List the derived inspection queue",
          description: "Returns only current Check-gap inspection actions. The queue is recomputed from canonical BOM and inventory evidence and is never persisted.",
          parameters: [
            { name: "revisionId", in: "path", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
            { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 512 } },
          ],
          responses: { "200": { description: "Deterministically sorted inspection action page" }, "403": { description: "Revision scope denied" } },
        },
      },
      "/project-revisions/{revisionId}/inspections/{inspectionId}": {
        get: {
          summary: "Read one derived inspection action",
          responses: { "200": { description: "Current inspection action" }, "404": { description: "Action is unavailable or has resolved" } },
        },
      },
      "/project-revisions/{revisionId}/inspections/{inspectionId}/completion-preview": {
        post: {
          summary: "Preview an inspection completion",
          description: "Returns an actor-bound, expiring before/after projection and basis. Preview never mutates stock, BOM, evidence, or audit state.",
          parameters: [{ name: "revisionId", in: "path", required: true, schema: { type: "string" } }, { name: "inspectionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "201": { description: "Actor-bound completion preview requiring confirmation" }, "400": { description: "Invalid observation" }, "409": { description: "Current action or basis conflict" } },
        },
      },
      "/project-revisions/{revisionId}/inspections/{inspectionId}/completion-commit": {
        post: {
          summary: "Commit a confirmed inspection completion",
          description: "Requires confirmed=true and a separate Idempotency-Key. Rechecks preview actor, expiry, hash, action and line/item basis in one unit of work; appends evidence and applies only physical-count stock changes atomically.",
          parameters: [{ name: "revisionId", in: "path", required: true, schema: { type: "string" } }, { name: "inspectionId", in: "path", required: true, schema: { type: "string" } }, { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } }],
          responses: { "200": { description: "Evidence, resulting item when counted, gaps, and current queue" }, "400": { description: "Invalid or unconfirmed commit" }, "409": { description: "Stale preview, basis, or idempotency conflict; recover with list_inspections" } },
        },
      },
      "/project-revisions/{id}/reconciliation": {
        get: { summary: "Read the current post-project reconciliation draft", responses: { "200": { description: "Reconciliation draft, or null before the first save" } } },
        put: { summary: "Save a review-only post-project reconciliation draft", responses: { "200": { description: "Saved reconciliation draft mutation" }, "409": { description: "Version or basis conflict" } } }
      },
      "/project-revisions/{id}/reconciliation/commit": { post: { summary: "Commit a reviewed reconciliation atomically", responses: { "200": { description: "Committed reconciliation mutation" }, "409": { description: "Stale basis, version, or replay conflict" } } } },
      "/project-revisions/{id}/usage": { post: { responses: { "201": { description: "Recorded reviewed project usage" } } } },
      "/projects/{id}/artifacts": {
        get: {
          summary: "List artifacts by exact revision scope or all project artifacts",
          description: "Read-only listing. Supply projectRevisionId for one exact project revision, workItemId plus workItemRevisionId for one exact work-item revision, or neither for all project artifacts. A work-item ID without its revision and legacy revisionId are rejected.",
          parameters: [
            { name: "id", in: "path", required: true, schema: artifactIdSchema },
            { name: "projectRevisionId", in: "query", required: false, schema: artifactIdSchema },
            { name: "workItemId", in: "query", required: false, schema: artifactIdSchema },
            { name: "workItemRevisionId", in: "query", required: false, schema: artifactIdSchema },
            { name: "role", in: "query", required: false, schema: artifactRoleSchema }
          ],
          responses: { "200": { description: "Artifact list" }, "400": { description: "Invalid or ambiguous scope" }, "404": { description: "Revision scope not found in the project" } }
        }
      },
      "/artifacts/uploads": {
        post: {
          summary: "Begin a revision-scoped artifact upload",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/BeginUpload" } } } },
          responses: { "201": { description: "Upload session" }, "400": { description: "Invalid, ambiguous, legacy, or unrevisioned scope" }, "403": { description: "Project-scoped access denied" }, "404": { description: "Revision scope not found in the project" } }
        }
      },
      "/artifacts/uploads/{id}": {
        put: {
          summary: "Write the bytes for an existing artifact upload",
          description: "Requires write access. Project-scoped bearer tokens resolve the upload's durable project ancestry before writing. Send the exact declared bytes; maximum 100 MiB, subject to the configured server limit. Browser sessions require CSRF protection.",
          parameters: [{ name: "id", in: "path", required: true, schema: artifactIdSchema }],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
          responses: { "200": { description: "Bytes received", content: { "application/json": { schema: { type: "object", required: ["receivedBytes"], properties: { receivedBytes: { type: "integer", minimum: 0 } } } } } }, "403": { description: "Write access or upload project scope denied" }, "413": { description: "Configured byte limit exceeded" } }
        }
      },
      "/artifacts/uploads/{id}/finalize": {
        post: {
          summary: "Finalize and verify an existing artifact upload",
          description: "Requires write access and durable upload project allow-list membership. No body is required. The shared application service checks project state, byte length and SHA-256 before committing. The response is a mutation envelope with artifact metadata in data. After an ambiguous response inspect the revision before repeating an upload.",
          parameters: [{ name: "id", in: "path", required: true, schema: artifactIdSchema }],
          responses: { "200": { description: "Finalized artifact mutation", content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: { type: "object", description: "Artifact metadata including id, projectId, revisionId, optional workItemId, role, filename, byteSize and sha256" } } } } } }, "403": { description: "Write access or upload project scope denied" }, "409": { description: "Project state or integrity conflict" } }
        }
      },
      "/artifacts/{id}": {
        get: {
          summary: "Read artifact metadata without downloading bytes",
          description: "Requires read access and durable artifact project allow-list membership. revisionId is the stored revision identifier; workItemId distinguishes work-item scope from project-revision scope.",
          parameters: [{ name: "id", in: "path", required: true, schema: artifactIdSchema }],
          responses: { "200": { description: "Artifact metadata", content: { "application/json": { schema: { type: "object", required: ["id", "projectId", "role", "filename", "byteSize", "sha256"], properties: { id: artifactIdSchema, projectId: artifactIdSchema, revisionId: artifactIdSchema, workItemId: artifactIdSchema, role: artifactRoleSchema, filename: { type: "string" }, byteSize: { type: "integer", minimum: 0 }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" } } } } } }, "403": { description: "Read access or artifact project scope denied" }, "404": { description: "Artifact not found" } }
        }
      },
      "/artifacts/{id}/download": {
        get: {
          summary: "Download stored artifact bytes",
          description: "Requires read access and durable artifact project allow-list membership. Verify returned bytes against metadata byteSize and sha256. Content-Type is the stored media type; Content-Disposition includes an ASCII fallback and RFC5987 UTF-8 filename.",
          parameters: [{ name: "id", in: "path", required: true, schema: artifactIdSchema }],
          responses: { "200": { description: "Artifact bytes", headers: { "Content-Disposition": { schema: { type: "string" } } }, content: { "*/*": { schema: { type: "string", format: "binary" } } } }, "403": { description: "Read access or artifact project scope denied" }, "404": { description: "Artifact not found" } }
        }
      },
      "/transfers/uploads/{id}": { put: { security: [{ transferAuth: [] }], responses: { "200": { description: "Uploaded bytes" }, "403": { description: "Invalid or expired transfer capability" }, "410": { description: "Expired transfer capability" } } } },
      "/transfers/uploads/{id}/finalize": { post: { security: [{ transferAuth: [] }], responses: { "200": { description: "Finalized artifact" }, "403": { description: "Invalid or expired transfer capability" }, "410": { description: "Expired transfer capability" } } } },
      "/transfers/artifacts/{id}/download": { get: { security: [{ transferAuth: [] }], responses: { "200": { description: "Artifact bytes" }, "403": { description: "Invalid or expired transfer capability" }, "410": { description: "Expired transfer capability" } } } },
      "/mcp": { post: { security: [{ bearerAuth: [] }], responses: { "200": { description: "Authenticated MCP JSON-RPC response" } } } },
      "/events": { get: { responses: { "200": { description: "Server-sent state events" } } } }
    }
  };
}
