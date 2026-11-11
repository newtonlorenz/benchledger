import { afterEach, expect, it, vi } from "vitest";
import { readStockReservations, setAsideStock, releaseSetAsideStock } from "./stock-reservation-api";
const reservation = { id: "held", lineId: "line", itemId: "stock", quantity: 4, status: "active" as const, version: 1, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("uses the canonical read, create and versioned release endpoints", async () => {
  vi.stubGlobal("document", { cookie: "forge_csrf=synthetic" });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json([reservation])).mockResolvedValueOnce(json(null)).mockResolvedValueOnce(json({ data: reservation })).mockResolvedValueOnce(json({ data: { ...reservation, version: 2, status: "released" } }));
  expect(await readStockReservations("revision")).toEqual({ reservations: [reservation], closed: false });
  await setAsideStock("revision", { lineId: "line", itemId: "stock", quantity: 4 }, "reserve-key");
  await releaseSetAsideStock(reservation, "release-key");
  expect(fetch.mock.calls[2]?.[0]).toBe("/api/v1/project-revisions/revision/reservations");
  expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({ lineId: "line", itemId: "stock", quantity: 4 });
  expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).get("idempotency-key")).toBe("reserve-key");
  expect(fetch.mock.calls[3]?.[0]).toBe("/api/v1/reservations/held/release");
  const headers = new Headers(fetch.mock.calls[3]?.[1]?.headers);
  expect(headers.get("if-match")).toBe("1"); expect(headers.get("idempotency-key")).toBe("release-key"); expect(headers.get("x-csrf-token")).toBe("synthetic");
});
it("does not treat malformed or mismatched mutation receipts as success", async () => {
  vi.stubGlobal("document", { cookie: "forge_csrf=synthetic" });
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ data: { ...reservation, itemId: "different" } })).mockResolvedValueOnce(json({ data: reservation }));
  await expect(setAsideStock("revision", { lineId: "line", itemId: "stock", quantity: 4 }, "key")).rejects.toMatchObject({ kind: "server" });
  await expect(releaseSetAsideStock(reservation, "release")).rejects.toMatchObject({ kind: "server" });
});
it("fails closed on malformed reads and before release without a CSRF token", async () => {
  vi.stubGlobal("document", { cookie: "" });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ data: [] })).mockResolvedValueOnce(json(null));
  await expect(readStockReservations("revision")).rejects.toMatchObject({ kind: "server" });
  await expect(releaseSetAsideStock(reservation, "key")).rejects.toMatchObject({ kind: "csrf" });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("bounds a stalled release and reuses the caller's key on retry", async () => {
  vi.stubGlobal("document", { cookie: "forge_csrf=synthetic" });
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError")).mockResolvedValueOnce(json({ data: { ...reservation, version: 2, status: "released" } }));
  await expect(releaseSetAsideStock(reservation, "same-release-key")).rejects.toBeTruthy();
  await releaseSetAsideStock(reservation, "same-release-key");
  for (const [, init] of fetch.mock.calls) {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("same-release-key");
    expect(new Headers(init?.headers).get("if-match")).toBe("1");
  }
});
