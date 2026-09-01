import { describe, expect, it } from "vitest";
import { workspaceSecurityMutationSchema, workspaceSecurityStatusSchema } from "./schemas.js";

describe("workspace security API contract", () => {
  it("exposes a safe status and rejects credential hashes", () => {
    expect(workspaceSecurityStatusSchema.parse({ mode: "lan_open", passwordConfigured: false, version: 1 })).toEqual({ mode: "lan_open", passwordConfigured: false, version: 1 });
    expect(() => workspaceSecurityStatusSchema.parse({ mode: "password", passwordConfigured: true, version: 1, encodedPasswordHash: "secret" })).toThrow();
  });

  it("accepts only the canonical strict operation union at the public boundary", () => {
    expect(workspaceSecurityMutationSchema.parse({ operation: "enable", newPassword: "a-long-password", expectedVersion: 1 })).toEqual({ operation: "enable", newPassword: "a-long-password", expectedVersion: 1 });
    expect(workspaceSecurityMutationSchema.parse({ operation: "disable", currentPassword: "old-password", expectedVersion: 1 })).toEqual({ operation: "disable", currentPassword: "old-password", expectedVersion: 1 });
    expect(workspaceSecurityMutationSchema.parse({ operation: "change_password", currentPassword: "old-password", newPassword: "new-password", expectedVersion: 1 })).toEqual({ operation: "change_password", currentPassword: "old-password", newPassword: "new-password", expectedVersion: 1 });
    for (const value of [
      { operation: "disable", expectedVersion: 1 },
      { operation: "disable", currentPassword: "old-password", expectedVersion: 1, encodedPasswordHash: "scrypt$secret" },
      { operation: "enable", ["password"]: "a-long-password", expectedVersion: 1 },
      { operation: "change_password", currentPassword: "old-password", newPassword: "new-password" },
    ]) expect(() => workspaceSecurityMutationSchema.parse(value)).toThrow();
  });
});
