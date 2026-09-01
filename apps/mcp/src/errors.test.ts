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

  it("maps validation and storage failures without leaking backend detail", () => {
    for (const code of ["validation", "invalid_cursor", "quota_exceeded", "unsupported_media"]) {
      expect(mapBackendError(codedError(code))).toMatchObject({ code: "INVALID_ARGUMENT", message: "The request arguments are invalid." });
    }
    expect(mapBackendError(new Error("secret SQL details"))).toMatchObject({ code: "BACKEND_ERROR", message: "The application service could not complete this operation." });
    expect(mapBackendError({ code: "FORBIDDEN" })).toMatchObject({ code: "BACKEND_ERROR" });
    expect(mapBackendError(null)).toMatchObject({ code: "BACKEND_ERROR" });
  });
});
