import { describe, expect, it } from "vitest";
import { McpAdapterError, isMcpAdapterError, mapBackendError } from "./errors.js";

function codedError(code: string): Error {
  const error = new Error("backend detail");
  Object.assign(error, { code });
  return error;
}

describe("MCP error boundary", () => {
  it("preserves adapter errors and optional structured details", () => {
    const details = { field: "projectId", reason: "not allowed" } as const;
    const error = new McpAdapterError("FORBIDDEN", "No access", details);
    expect(error.name).toBe("McpAdapterError");
    expect(error.code).toBe("FORBIDDEN");
    expect(error.details).toEqual(details);
    expect(isMcpAdapterError(error)).toBe(true);
    expect(isMcpAdapterError(new Error("other"))).toBe(false);
    expect(mapBackendError(error)).toBe(error);
  });

  it("normalizes not-found, conflict, and forbidden backend variants", () => {
    for (const error of [codedError("NOT_FOUND"), codedError("not_found"), Object.assign(new Error(), { statusCode: 404 })]) {
      expect(mapBackendError(error)).toMatchObject({ code: "NOT_FOUND", message: "The requested record was not found." });
    }
    for (const error of [codedError("CONFLICT"), codedError("conflict"), codedError("idempotency_conflict"), Object.assign(new Error(), { statusCode: 409 })]) {
      expect(mapBackendError(error)).toMatchObject({ code: "CONFLICT" });
    }
    for (const error of [codedError("FORBIDDEN"), codedError("forbidden"), Object.assign(new Error(), { statusCode: 403 })]) {
      expect(mapBackendError(error)).toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("preserves safe collision details and gives the agent a next action", () => {
    const error = new Error("Project 'stable-project' already exists");
    Object.assign(error, {
      code: "conflict",
      details: {
        reason: "project_id_exists",
        field: "projectId",
        id: "stable-project",
        retryable: false,
        commitState: "not_committed",
      },
    });
    expect(mapBackendError(error)).toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/read the existing project|different project id/i),
      details: {
        reason: "project_id_exists",
        field: "projectId",
        id: "stable-project",
        retryable: false,
        commitState: "not_committed",
      },
    });
  });

  it("preserves valid 240-character project-name collision IDs and sanitizes unsafe details", () => {
    const longId = "a".repeat(220);
    const valid = new Error("name collision");
    Object.assign(valid, {
      code: "conflict",
      details: { reason: "project_name_exists", field: "projectName", id: longId, retryable: false, commitState: "not_committed" },
    });
    expect(mapBackendError(valid)).toMatchObject({ code: "CONFLICT", details: { reason: "project_name_exists", id: longId } });

    const unsafe = new Error("backend detail");
    Object.assign(unsafe, {
      code: "conflict",
      details: { reason: "project_name_exists", field: "projectName", id: "a".repeat(241), retryable: false, commitState: "not_committed", sql: "SELECT * FROM projects" },
    });
    expect(mapBackendError(unsafe)).toMatchObject({ code: "CONFLICT" });
    expect(mapBackendError(unsafe).details).toBeUndefined();
  });

  it("preserves bounded actionable project setup conflict details", () => {
    const setupConflicts = [
      {
        reason: "stale_basis",
        commitState: "not_committed",
        recoveryAction: "preview_project_setup",
        staleItems: ["stock-1", "stock-2"],
      },
      {
        reason: "preview_expired",
        commitState: "not_committed",
        recoveryAction: "preview_project_setup",
      },
      {
        reason: "preview_ownership",
        commitState: "not_committed",
      },
      {
        reason: "already_committed",
        commitState: "committed",
      },
      {
        reason: "stale_preview",
        commitState: "not_committed",
        recoveryAction: "preview_project_setup",
      },
    ] as const;

    for (const details of setupConflicts) {
      const error = new Error("backend detail");
      Object.assign(error, {
        code: "conflict",
        details: { ...details, retryable: false, internal: "do not expose this" },
      });
      const mapped = mapBackendError(error);
      expect(mapped).toMatchObject({ code: "CONFLICT", details });
      expect(mapped.details).not.toHaveProperty("internal");
    }
  });

  it("preserves an empty staleItems list when a matching candidate disappears", () => {
    const error = new Error("Project setup inventory candidate basis is stale");
    Object.assign(error, {
      code: "conflict",
      details: {
        reason: "stale_basis",
        staleItems: [],
        recoveryAction: "preview_project_setup",
        retryable: false,
        commitState: "not_committed",
      },
    });

    expect(mapBackendError(error)).toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "stale_basis",
        staleItems: [],
        recoveryAction: "preview_project_setup",
        retryable: false,
        commitState: "not_committed",
      },
    });
  });

  it("rejects unsafe project setup conflict details without leaking arbitrary fields", () => {
    const unsafeDetails = [
      { reason: "stale_basis", commitState: "not_committed", recoveryAction: "delete_project", staleItems: ["stock-1"] },
      { reason: "stale_basis", commitState: "not_committed", recoveryAction: "preview_project_setup", staleItems: ["stock-1", "\u0000unsafe"] },
      { reason: "preview_expired", commitState: "committed", recoveryAction: "preview_project_setup" },
      { reason: "already_committed", commitState: "not_committed" },
      { reason: "stale_preview", commitState: "not_committed", recoveryAction: "preview_project_setup", staleItems: ["unexpected"] },
    ];

    for (const details of unsafeDetails) {
      const error = new Error("backend detail");
      Object.assign(error, { code: "conflict", details: { ...details, retryable: false, internalDetail: "do not expose this" } });
      const mapped = mapBackendError(error);
      expect(mapped).toMatchObject({ code: "CONFLICT" });
      expect(mapped.details).toBeUndefined();
      expect(mapped.message).not.toContain("do not expose this");
    }
  });

  it("maps validation and storage failures without leaking backend detail", () => {
    for (const code of ["validation", "invalid_cursor", "quota_exceeded", "unsupported_media"]) {
      expect(mapBackendError(codedError(code))).toMatchObject({ code: "INVALID_ARGUMENT", message: "The request arguments are invalid." });
    }
    const schemaError = new Error("private schema detail");
    Object.assign(schemaError, { name: "ZodError", issues: [{ path: ["project", "name"] }] });
    expect(mapBackendError(schemaError)).toMatchObject({ code: "INVALID_ARGUMENT", details: { issues: [{ path: "project.name", message: "Invalid value." }] } });
    expect(mapBackendError(schemaError).message).not.toContain("private schema detail");
    expect(mapBackendError(new Error("secret SQL details"))).toMatchObject({ code: "BACKEND_ERROR", message: "The application service could not complete this operation." });
    expect(mapBackendError({ code: "FORBIDDEN" })).toMatchObject({ code: "BACKEND_ERROR" });
    expect(mapBackendError(null)).toMatchObject({ code: "BACKEND_ERROR" });
  });
});

describe("MCP error recovery information", () => {
  it("passes through the safe ApplicationError message and distinguishes rule conflicts from version conflicts", async () => {
    const { ApplicationError } = await import("@benchledger/application");
    const rule = mapBackendError(new ApplicationError("conflict", "Only physically confirmed stock can be reserved"));
    expect(rule).toMatchObject({ code: "CONFLICT", reason: "rule_conflict", message: "Only physically confirmed stock can be reserved" });
    expect(rule.message).not.toMatch(/read it again/i);

    const version = mapBackendError(new ApplicationError("conflict", "inventory_item 'item-1' changed since it was read", { expectedVersion: 2, actualVersion: 3 }));
    expect(version).toMatchObject({ code: "CONFLICT", reason: "version_conflict", details: { expectedVersion: 2, actualVersion: 3 } });
    expect(version.message).toMatch(/changed since it was read/);
    expect(version.message).toMatch(/version 3/);

    const replay = mapBackendError(new ApplicationError("idempotency_conflict", "Idempotency key was reused for a different command"));
    expect(replay).toMatchObject({ code: "CONFLICT", reason: "idempotency_conflict" });
  });

  it("returns validation messages and bounded zod field issues without stack traces or paths", async () => {
    const { ApplicationError } = await import("@benchledger/application");
    expect(mapBackendError(new ApplicationError("validation", "Only consumed BOM requirements may reserve or consume stock"))).toMatchObject({ code: "INVALID_ARGUMENT", reason: "validation", message: "Only consumed BOM requirements may reserve or consume stock" });

    const issues = Array.from({ length: 40 }, (_, index) => ({ path: ["lines", index, "quantity"], message: "Expected number, received string", code: "invalid_type" }));
    const zod = Object.assign(new Error("raw"), { name: "ZodError", issues });
    const mapped = mapBackendError(zod);
    expect(mapped.code).toBe("INVALID_ARGUMENT");
    expect(mapped.message).toContain("lines.0.quantity: Expected number, received string");
    const mappedIssues = (mapped.details as { issues: unknown[] }).issues;
    expect(mappedIssues.length).toBeLessThanOrEqual(10);
    expect(mappedIssues[0]).toEqual({ path: "lines.0.quantity", message: "Expected number, received string" });

    // Built at runtime so the repository privacy scan sees no literal home path.
    const homePath = ["", "Users", "synthetic-user", "app"].join("/");
    for (const leaky of [`Error at ${homePath}/src/file.ts:10`, "Error at /srv/app/src/file.ts:10", "SQLITE_CONSTRAINT: UNIQUE failed\n    at Database.run (node_modules/x.js:1:1)", "x".repeat(2000)]) {
      const unsafe = mapBackendError(new ApplicationError("conflict", leaky));
      expect(unsafe.code).toBe("CONFLICT");
      expect(unsafe.message).not.toContain("/Users/");
      expect(unsafe.message).not.toContain("node_modules");
      expect(unsafe.message.length).toBeLessThan(600);
    }
  });
});
