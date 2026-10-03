// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { useState } from "react";
import { RequirementOwnedItems, type OwnedItemSearch } from "./requirement-owned-items";
import { inventory } from "./mock-data";
import type { InventoryPage } from "./api";
const stock = { ...inventory.find((item) => item.category !== "Printers")!, id: "remote-stock", name: "Remote sensor", unit: "each" as const, quantity: 4, availableQuantity: 4, evidence: "counted" as const, serverEvidence: "physically_counted" as const, tags: [] };
const base = { items: [], requirementName: "sensor", selectedId: "", onSelect: vi.fn(), unit: "each" as const, onUnitChange: vi.fn(), queryOverride: undefined, onQueryChange: vi.fn(), focusSearch: true };
afterEach(cleanup);

it("loads candidates beyond the workspace snapshot and truthfully scopes filtered server totals", async () => {
  const search = vi.fn<OwnedItemSearch>().mockResolvedValue({ items: [stock, { ...stock, id: "printer", category: "Printers", name: "Sensor printer" }], limit: 25, total: 40, nextCursor: "next" });
  render(<RequirementOwnedItems {...base} onSearch={search} />);
  expect(screen.getByText(/Searching your inventory/u)).toBeTruthy();
  expect(search).not.toHaveBeenCalled();
  expect(await screen.findByRole("button", { name: "Choose owned item Remote sensor" })).toBeTruthy();
  expect(search).toHaveBeenCalledWith("sensor", expect.any(AbortSignal));
  expect(screen.getByText(/1 selectable item shown from 40 inventory matches/u)).toBeTruthy();
  expect(screen.getByText(/Printers and retired items are excluded/u)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Sensor printer/u })).toBeNull();
});

it("aborts old searches and ignores responses arriving after the latest query", async () => {
  const calls: { query: string; signal: AbortSignal; resolve(page: InventoryPage): void }[] = [];
  const search: OwnedItemSearch = (query, signal) => new Promise((resolve) => calls.push({ query, signal, resolve }));
  const view = render(<RequirementOwnedItems {...base} onSearch={search} />);
  await waitFor(() => expect(calls).toHaveLength(1));
  view.rerender(<RequirementOwnedItems {...base} queryOverride="new" onSearch={search} />);
  expect(calls[0]!.signal.aborted).toBe(true);
  await waitFor(() => expect(calls).toHaveLength(2));
  await act(async () => calls[1]!.resolve({ items: [{ ...stock, id: "new", name: "New sensor" }], limit: 25, total: 1 }));
  expect(screen.getByRole("button", { name: "Choose owned item New sensor" })).toBeTruthy();
  await act(async () => calls[0]!.resolve({ items: [stock], limit: 25, total: 1 }));
  expect(screen.queryByRole("button", { name: "Choose owned item Remote sensor" })).toBeNull();
  view.unmount(); expect(calls[1]!.signal.aborted).toBe(true);
});

function SearchHarness({ search }: { search: OwnedItemSearch }) {
  const [selectedId, select] = useState(""); const [queryOverride, query] = useState<string>();
  return <RequirementOwnedItems {...base} selectedId={selectedId} onSelect={select} queryOverride={queryOverride} onQueryChange={query} onSearch={search} />;
}
it("keeps the explicit selection across search failure, retry and an unrelated results page", async () => {
  const search = vi.fn<OwnedItemSearch>()
    .mockResolvedValueOnce({ items: [stock], limit: 25, total: 1 })
    .mockRejectedValueOnce(new Error("Synthetic unavailable search"))
    .mockResolvedValueOnce({ items: [], limit: 25, total: 0 });
  render(<SearchHarness search={search} />);
  fireEvent.click(await screen.findByRole("button", { name: "Choose owned item Remote sensor" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search matching inventory" }), { target: { value: "unrelated" } });
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Choose owned item Remote sensor" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Retry inventory search" }));
  await screen.findByText(/0 selectable items shown from 0 inventory matches/u);
  expect(screen.getByRole("button", { name: "Choose owned item Remote sensor" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText(/Selection is a planning choice/u)).toBeTruthy();
});
