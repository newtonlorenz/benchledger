// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OwnedItemCombobox, ownedItemLabel, OwnedInventorySearchContext, type OwnedInventorySearch } from "./catalog-ui";
import { isUsableOwnedPrinter } from "./project-build-readiness";
import { inventory } from "./mock-data";
afterEach(cleanup);
const fixture = inventory.find(item => item.category === "Printers")!;
const printer = { ...fixture, productProfile: { ...fixture.productProfile!, inventoryItemId: "remote-printer" }, id: "remote-printer", name: "Synthetic remote printer", evidence: "counted" as const, serverEvidence: "physically_counted" as const, tags: [] };
it("discovers printers beyond loaded stock while preserving the caller's physical evidence filter", async () => {
  const search = vi.fn<OwnedInventorySearch>().mockResolvedValue({ items: [printer, { ...printer, id: "uncertain", name: "Uncounted printer", evidence: "delivered", serverEvidence: "delivered_uncounted" }], limit: 25, total: 37, nextCursor: "next" });
  const select = vi.fn();
  render(<OwnedInventorySearchContext.Provider value={search}><OwnedItemCombobox category="Printers" items={[]} candidateFilter={isUsableOwnedPrinter} label="Project printer" onSelect={select} showInitialChoices/></OwnedInventorySearchContext.Provider>);
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(ownedItemLabel(printer, [])) }));
  expect(select).toHaveBeenCalledWith(printer);
  expect(screen.queryByRole("button", { name: /Uncounted printer/u })).toBeNull();
  expect(screen.getByText(/1 selectable printers shown from 37 inventory matches/u)).toBeTruthy();
  expect(search).toHaveBeenCalledWith("Printers", "", expect.any(AbortSignal));
});
it("offers deliberate retry after remote lookup fails without clearing an existing choice", async () => {
  const search = vi.fn<OwnedInventorySearch>().mockRejectedValueOnce(new Error("Synthetic unavailable")).mockResolvedValueOnce({ items: [], total: 0, limit: 25 });
  const select = vi.fn();
  render(<OwnedInventorySearchContext.Provider value={search}><OwnedItemCombobox category="Printers" items={[]} value={printer} label="Project printer" onSelect={select}/></OwnedInventorySearchContext.Provider>);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry owned inventory search" }));
  await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  expect(screen.getByText(ownedItemLabel(printer, []), { selector: "strong" })).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
});
