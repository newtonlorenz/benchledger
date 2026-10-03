// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiError, workflowRequest } from "./api";
import { useWorkflowCommand } from "./workflow-ui";
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), workflowRequest: vi.fn() }));
it("keeps the unchanged command after an ambiguous save and rejected retry", async () => {
  vi.mocked(workflowRequest).mockRejectedValueOnce(new ApiError("Lost reply", { kind: "offline" })).mockRejectedValueOnce(new ApiError("Unavailable", { kind: "validation", status: 409 })).mockResolvedValueOnce({ id: "saved" });
  const { result } = renderHook(useWorkflowCommand);
  const execute = () => result.current.execute("/synthetic", "POST", { name: "Original" }, (value) => value);
  await act(async () => { await expect(execute()).rejects.toThrow("Lost reply"); });
  await act(async () => { await expect(execute()).rejects.toThrow("Unavailable"); });
  expect(result.current.uncertain).toBe(true);
  await act(async () => { await expect(result.current.execute("/synthetic", "POST", { name: "Changed" }, (value) => value)).rejects.toThrow("previous save was not confirmed"); });
  await act(async () => { await execute(); });
  expect(result.current.uncertain).toBe(false);
  const keys = vi.mocked(workflowRequest).mock.calls.map((call) => call[3]);
  expect(new Set(keys).size).toBe(1);
});
