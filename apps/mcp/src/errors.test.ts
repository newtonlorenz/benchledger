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
    expect(mapBackendError(schemaError)).toMatchObject({ code: "INVALID_ARGUMENT", message: "The request arguments are invalid." });
    expect(mapBackendError(new Error("secret SQL details"))).toMatchObject({ code: "BACKEND_ERROR", message: "The application service could not complete this operation." });
    expect(mapBackendError({ code: "FORBIDDEN" })).toMatchObject({ code: "BACKEND_ERROR" });
    expect(mapBackendError(null)).toMatchObject({ code: "BACKEND_ERROR" });
  });
});
