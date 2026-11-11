// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryItem } from "@benchledger/api-contract";
import { ClientError } from "./connection";
import { useItemEditor, type EditorClient } from "./item-editor";

afterEach(cleanup);
const base = { id: "item-1", name: "Wire kit", location: "Drawer A", description: "", version: 3 } as InventoryItem;
const latest = { ...base, location: "Drawer B", version: 4 } as InventoryItem;
let keys = 0;
const keyFor = vi.fn(() => `key-${++keys}`);

function editor(client: EditorClient) { return renderHook(() => useItemEditor(client, "item-1", keyFor)); }

describe("item editor", () => {
  it("loads the current item instead of trusting a stale navigation copy", async () => {
    const client: EditorClient = { item: vi.fn(async () => latest), updateItem: vi.fn() };
    const { result } = editor(client);
    await waitFor(() => expect(result.current.input?.location).toBe("Drawer B"));
    expect(result.current.dirty).toBe(false);
  });
  it("on 409 refetches and lets the user keep their changes against the latest version", async () => {
    const updateItem = vi.fn<EditorClient["updateItem"]>()
      .mockRejectedValueOnce(new ClientError("conflict", 409, "http"))
      .mockImplementationOnce(async (item, input) => ({ ...item, ...input, version: item.version + 1 }));
    const item = vi.fn<EditorClient["item"]>().mockResolvedValueOnce(base).mockResolvedValueOnce(latest);
    const { result } = editor({ item, updateItem });
    await waitFor(() => expect(result.current.input).toBeTruthy());
    act(() => result.current.change({ name: "Wire kit (red)" }));
    await act(async () => result.current.save());
    expect(result.current.conflict?.version).toBe(4);
    expect(result.current.saved).toBe(false);
    expect(result.current.input?.name).toBe("Wire kit (red)");
    await act(async () => result.current.keepMine());
    expect(updateItem).toHaveBeenLastCalledWith(expect.objectContaining({ version: 4 }), expect.objectContaining({ name: "Wire kit (red)" }), expect.any(String));
    expect(result.current.saved).toBe(true);
  });
  it("on keep-mine sends only the fields the user changed, applied onto the latest record", async () => {
    const updateItem = vi.fn<EditorClient["updateItem"]>()
      .mockRejectedValueOnce(new ClientError("conflict", 409, "http"))
      .mockImplementationOnce(async (item, input) => ({ ...item, ...input, version: item.version + 1 }));
    // Someone else moved the item (Drawer A -> Drawer B) while this user renamed it.
    const item = vi.fn<EditorClient["item"]>().mockResolvedValueOnce(base).mockResolvedValueOnce(latest);
    const { result } = editor({ item, updateItem });
    await waitFor(() => expect(result.current.input).toBeTruthy());
    act(() => result.current.change({ name: "Wire kit (red)" }));
    await act(async () => result.current.save());
    expect(result.current.fieldConflicts).toEqual([]);
    await act(async () => result.current.keepMine());
    expect(updateItem).toHaveBeenLastCalledWith(expect.objectContaining({ version: 4 }), { name: "Wire kit (red)", location: "Drawer B", description: "" }, expect.any(String));
    expect(result.current.saved).toBe(true);
  });
  it("asks the user to pick when the same field changed on both sides", async () => {
    const updateItem = vi.fn<EditorClient["updateItem"]>()
      .mockRejectedValueOnce(new ClientError("conflict", 409, "http"))
      .mockImplementationOnce(async (item, input) => ({ ...item, ...input, version: item.version + 1 }));
    const item = vi.fn<EditorClient["item"]>().mockResolvedValueOnce(base).mockResolvedValueOnce(latest);
    const { result } = editor({ item, updateItem });
    await waitFor(() => expect(result.current.input).toBeTruthy());
    act(() => result.current.change({ location: "Shelf", description: "Mixed colours" }));
    await act(async () => result.current.save());
    expect(result.current.fieldConflicts).toEqual([{ field: "location", mine: "Shelf", theirs: "Drawer B" }]);
    await act(async () => result.current.keepMine());
    expect(updateItem).toHaveBeenCalledTimes(1);
    expect(result.current.error).toMatch(/Choose/u);
    act(() => result.current.choose("location", "theirs"));
    await act(async () => result.current.keepMine());
    expect(updateItem).toHaveBeenLastCalledWith(expect.objectContaining({ version: 4 }), { name: "Wire kit", location: "Drawer B", description: "Mixed colours" }, expect.any(String));
    expect(result.current.saved).toBe(true);
  });
  it("does not report a conflict when both sides made the same change", async () => {
    const item = vi.fn<EditorClient["item"]>().mockResolvedValueOnce(base).mockResolvedValueOnce(latest);
    const { result } = editor({ item, updateItem: vi.fn(async () => { throw new ClientError("conflict", 409, "http"); }) });
    await waitFor(() => expect(result.current.input).toBeTruthy());
    act(() => result.current.change({ location: "Drawer B" }));
    await act(async () => result.current.save());
    expect(result.current.fieldConflicts).toEqual([]);
  });
  it("on 409 can discard local edits and show the latest record", async () => {
    const item = vi.fn<EditorClient["item"]>().mockResolvedValueOnce(base).mockResolvedValueOnce(latest);
    const { result } = editor({ item, updateItem: vi.fn(async () => { throw new ClientError("conflict", 409, "http"); }) });
    await waitFor(() => expect(result.current.input).toBeTruthy());
    act(() => result.current.change({ location: "Shelf" }));
    await act(async () => result.current.save());
    act(() => result.current.discard());
    expect(result.current.input).toEqual({ name: "Wire kit", location: "Drawer B", description: "" });
    expect(result.current.conflict).toBeUndefined();
    expect(result.current.dirty).toBe(false);
  });
  it("reports other failures without claiming a conflict", async () => {
    const { result } = editor({ item: vi.fn(async () => base), updateItem: vi.fn(async () => { throw new ClientError("offline", 0, "unreachable"); }) });
    await waitFor(() => expect(result.current.input).toBeTruthy());
    act(() => result.current.change({ location: "Shelf" }));
    await act(async () => result.current.save());
    expect(result.current.error).toBe("offline"); expect(result.current.conflict).toBeUndefined();
  });
});
