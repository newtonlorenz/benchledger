// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StockReservationPlanning, reservationCandidates } from "./stock-reservation-ui";
import { readStockReservations, setAsideStock, releaseSetAsideStock } from "./stock-reservation-api";
import { ApiError } from "./api";
import { projects, inventory } from "./mock-data";
import type { Reservation } from "@benchledger/api-contract";
vi.mock("./stock-reservation-api", () => ({ readStockReservations: vi.fn(), setAsideStock: vi.fn(), releaseSetAsideStock: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const item = { ...inventory.find((entry) => entry.category === "Filament")!, quantity: 100, availableQuantity: 100, serverEvidence: "physically_counted" as const };
const line = { id: "line", label: "Filament", itemId: item.id, required: 40, unit: item.unit, version: 1, role: "consumed" as const };
const project = { ...projects[0]!, bom: [line], gapEvaluation: { lines: [{ lineId: line.id, status: "supplied" as const, decision: "ready" as const, suppliedQuantity: 40, inspectQuantity: 0, missingQuantity: 0, matchedItemIds: [item.id], reasons: [] }], totals: { requiredLines: 1, optionalLines: 0, readyLines: 1, checkLines: 0, decideLines: 0, sourceLines: 0, partialLines: 0, missingLines: 0 } } };
const held: Reservation = { id: "held", lineId: line.id, itemId: item.id, quantity: 20, status: "active", version: 1, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" };
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
async function review() {
  await waitFor(() => expect(screen.queryByText("Loading stock set aside…")).toBeNull());
  fireEvent.change(screen.getByLabelText("Requirement and confirmed stock"), { target: { value: `${line.id}:${item.id}` } });
  fireEvent.change(screen.getByLabelText(`Quantity to set aside (${item.unit})`), { target: { value: "20" } });
  click("Review stock to set aside");
}
it("reviews exact stock and requires confirmation before reserving, then refreshes", async () => {
  vi.mocked(readStockReservations).mockResolvedValue({ reservations: [], closed: false }); vi.mocked(setAsideStock).mockResolvedValue(held);
  const refresh = vi.fn(async () => true), useStock = vi.fn();
  render(<StockReservationPlanning project={project} items={[item]} onRefresh={refresh} onUsedStock={useStock} />);
  await review(); expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Set this stock aside?" })); expect(setAsideStock).not.toHaveBeenCalled(); click("Confirm set aside");
  await screen.findByText("Stock set aside. Record what was actually used after the build.");
  expect(setAsideStock).toHaveBeenCalledWith(project.serverRevisionId, { lineId: line.id, itemId: item.id, quantity: 20 }, expect.any(String));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce()); click("Record actual stock use"); expect(useStock).toHaveBeenCalledOnce();
});
it("keeps the unchanged command across ambiguous and definitive retry failures", async () => {
  vi.mocked(readStockReservations).mockResolvedValue({ reservations: [], closed: false });
  vi.mocked(setAsideStock).mockRejectedValueOnce(new ApiError("Lost", { kind: "offline" })).mockRejectedValueOnce(new ApiError("Denied", { kind: "forbidden", status: 403 })).mockResolvedValueOnce(held);
  render(<StockReservationPlanning project={project} items={[item]} onRefresh={async () => true} />);
  await review(); click("Confirm set aside"); click((await screen.findByRole("button", { name: "Retry unchanged stock change" })).textContent!);
  await waitFor(() => expect(setAsideStock).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Back to stock selection" })).toHaveProperty("disabled", true);
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry unchanged stock change" })).toBeTruthy()); click("Retry unchanged stock change");
  await screen.findByText("Stock set aside. Record what was actually used after the build.");
  expect(new Set(vi.mocked(setAsideStock).mock.calls.map((call) => call[2])).size).toBe(1);
});
it("reviews release and uses the observed reservation version", async () => {
  vi.mocked(readStockReservations).mockResolvedValue({ reservations: [held], closed: false }); vi.mocked(releaseSetAsideStock).mockResolvedValue({ ...held, status: "released", version: 2 });
  render(<StockReservationPlanning project={project} items={[item]} onRefresh={async () => true} />);
  await screen.findByRole("button", { name: "Release stock" }); click("Release stock"); expect(releaseSetAsideStock).not.toHaveBeenCalled(); click("Confirm release");
  await screen.findByText("Stock released. It is available for other projects; no stock was consumed."); expect(releaseSetAsideStock).toHaveBeenCalledWith(held, expect.any(String));
});
it("excludes reusable, unconfirmed, unmatched and already covered stock", () => {
  expect(reservationCandidates(project, [item], [held])[0]?.maximum).toBe(20);
  expect(reservationCandidates(project, [{ ...item, serverEvidence: "delivered_uncounted" }], [])).toEqual([]);
  expect(reservationCandidates({ ...project, bom: [{ ...line, role: "reusable" }] }, [item], [])).toEqual([]);
  expect(reservationCandidates({ ...project, bom: [{ ...line, itemId: "different" }] }, [item], [])).toEqual([]);
  expect(reservationCandidates(project, [item], [{ ...held, quantity: 40 }])).toEqual([]);
});
it("blocks changes on failed refresh or committed closeout", async () => {
  vi.mocked(readStockReservations).mockResolvedValue({ reservations: [], closed: true });
  render(<StockReservationPlanning project={project} items={[item]} onRefresh={async () => false} />);
  await screen.findByText(/stock review is complete/); expect(screen.queryByLabelText("Requirement and confirmed stock")).toBeNull();
  click("Refresh stock for this build"); await screen.findByRole("alert"); expect(setAsideStock).not.toHaveBeenCalled();
});

it("keeps recorded set conversions explicit and suggests only whole stock sets", () => {
  const stock = { ...item, unit: "set" as const, serverUnit: "set", availableQuantity: 2.5 };
  const converted = { ...line, unit: "each" as const, serverUnit: "each", required: 5, alternatives: [{ itemId: item.id, compatible: "confirmed" as const, quantityConversion: { inventory: { quantity: 1 as const, unit: "set" as const }, requirement: { quantity: 4, unit: "each" as const }, evidence: { basis: "physical_count" as const, observedAt: "2026-10-03T00:00:00.000Z" } } }] };
  const result = reservationCandidates({ ...project, bom: [converted] }, [stock], []);
  expect(result[0]).toMatchObject({ maximum: 2, coverage: 4, wholeSets: true });
  const withoutConversion = { ...converted, alternatives: [] };
  expect(reservationCandidates({ ...project, bom: [withoutConversion] }, [stock], [])).toEqual([]);
  expect(reservationCandidates({ ...project, bom: [converted] }, [stock], [{ ...held, quantity: 1 }])[0]?.maximum).toBe(1);
});
