// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StockReceivingPolicySection, assumedStockLabel, stockReceivingImpactSummary, stockReceivingPolicyLabel } from "./stock-receiving-policy";
import type { StockReceivingImpact } from "./stock-receiving-policy";
import { mapInventoryItem } from "./api";

afterEach(cleanup);

const row = (itemId: string, evidenceState = "delivered_uncounted", allocatedQuantity = 0) => ({ itemId, name: `Item ${itemId}`, evidenceState, quantity: 2, unit: "each", allocatedQuantity });
const impact = (overrides: Partial<StockReceivingImpact> = {}): StockReceivingImpact => ({ from: "on_receipt", to: "on_delivery", version: 3, gained: [], lost: [], blockedBy: [], truncated: false, ...overrides });

describe("stock receiving policy copy", () => {
  it("summarises the impact in plain language", () => {
    expect(stockReceivingImpactSummary(impact({ gained: Array.from({ length: 12 }, (_, index) => row(`g${index}`)) }))).toEqual(["12 items will now count as in stock."]);
    expect(stockReceivingImpactSummary(impact({ lost: [row("a"), row("b"), row("c"), row("d"), row("e")] }))).toEqual(["5 items will no longer count as in stock."]);
    expect(stockReceivingImpactSummary(impact({ gained: [row("a")], truncated: true }))).toEqual(["1 item will now count as in stock.", "Only the first part of a large inventory was checked."]);
    expect(stockReceivingImpactSummary(impact())[0]).toMatch(/No current inventory changes/);
    expect(stockReceivingPolicyLabel("on_delivery")).toBe("When it's delivered");
  });

  it("keeps the recorded evidence visible for policy-assumed stock", () => {
    const base = { id: "i", name: "Inserts", kind: "fastener", quantity: 10, availableQuantity: 10, unit: "each", tags: [], links: [], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", version: 1 };
    const delivered = mapInventoryItem({ ...base, evidence: { state: "delivered_uncounted" }, availability: "assumed" });
    expect(delivered).toMatchObject({ state: "available", serverEvidence: "delivered_uncounted", policyAvailability: "assumed", reserved: 0 });
    expect(assumedStockLabel(delivered)).toBe("In stock · delivered, not counted");
    const ordered = mapInventoryItem({ ...base, availableQuantity: 6, evidence: { state: "ordered_unverified" }, availability: "assumed" });
    expect(ordered).toMatchObject({ state: "available", reserved: 4 });
    expect(assumedStockLabel(ordered)).toBe("In stock · ordered, not yet delivered");
    const pending = mapInventoryItem({ ...base, availableQuantity: 0, evidence: { state: "delivered_uncounted" }, availability: "inspect_first" });
    expect(pending.state).toBe("inspect-first");
    expect(assumedStockLabel(pending)).toBeUndefined();
    const withImage = mapInventoryItem({ ...base, evidence: { state: "physically_counted" }, primaryImage: { id: "image-1", url: "/api/v1/inventory/i/images/image-1/content", width: 40, height: 30 } });
    expect(withImage.primaryImage).toEqual({ id: "image-1", url: "/api/v1/inventory/i/images/image-1/content", width: 40, height: 30 });
    expect(mapInventoryItem({ ...base, evidence: { state: "physically_counted" }, primaryImage: { id: "image-1", url: "https://elsewhere.example/x.webp" } }).primaryImage).toBeUndefined();
    // Older services without availability keep the evidence-only rule.
    expect(mapInventoryItem({ ...base, availableQuantity: 0, evidence: { state: "ordered_unverified" } }).state).toBe("ordered-unverified");
  });
});

describe("StockReceivingPolicySection", () => {
  it("previews the impact before saving and reports the saved setting", async () => {
    const onPreview = vi.fn(async () => impact({ gained: [row("a"), row("b", "ordered_unverified")] }));
    const onSave = vi.fn(async () => ({ stockReceivingPolicy: "on_delivery" as const, version: 4 }));
    const onSaved = vi.fn();
    render(<StockReceivingPolicySection preferences={{ stockReceivingPolicy: "on_receipt", version: 3 }} canChange onPreview={onPreview} onSave={onSave} onSaved={onSaved} />);
    expect(screen.getByRole("heading", { name: "When does stock count as in stock?" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: /When I've received and checked it/u }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("button", { name: /Review change/u })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /When it's delivered/u }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Review change/u })); });
    expect(onPreview).toHaveBeenCalledWith("on_delivery");
    expect(screen.getByText("2 items will now count as in stock.")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save setting" })); });
    expect(onSave).toHaveBeenCalledWith("on_delivery", 3);
    expect(onSaved).toHaveBeenCalledWith({ stockReceivingPolicy: "on_delivery", version: 4 });
    expect(screen.getByRole("status").textContent).toMatch(/when it's delivered/u);
  });

  it("blocks a change that would strand reservations and explains save failures", async () => {
    const onPreview = vi.fn(async () => impact({ from: "on_purchase", to: "on_receipt", lost: [row("a", "delivered_uncounted", 2)], blockedBy: [row("a", "delivered_uncounted", 2)] }));
    const onSave = vi.fn(async () => { throw Object.assign(new Error("conflict"), { status: 409 }); });
    render(<StockReceivingPolicySection preferences={{ stockReceivingPolicy: "on_purchase", version: 1 }} canChange onPreview={onPreview} onSave={onSave} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /When I've received/u }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Review change/u })); });
    expect(screen.getByRole("alert").textContent).toMatch(/with project reservations would stop counting: Item a/u);
    expect((screen.getByRole("button", { name: "Save setting" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Save setting" })).toBeNull();
  });

  it("shows a save conflict and a preview failure without changing anything", async () => {
    const onPreview = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(impact());
    const onSave = vi.fn(async () => { throw Object.assign(new Error("conflict"), { status: 409 }); });
    render(<StockReceivingPolicySection preferences={{ stockReceivingPolicy: "on_receipt", version: 1 }} canChange onPreview={onPreview} onSave={onSave} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /When it's bought/u }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Review change/u })); });
    expect(screen.getByRole("alert").textContent).toBe("offline");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Review change/u })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save setting" })); });
    expect(screen.getByRole("alert").textContent).toMatch(/changed elsewhere/u);
  });

  it("is read-only for members who cannot change it", () => {
    render(<StockReceivingPolicySection preferences={{ stockReceivingPolicy: "on_delivery", version: 2 }} canChange={false} onPreview={vi.fn()} onSave={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /When it's bought/u }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("note").textContent).toMatch(/Only a workspace administrator/u);
    expect(screen.getByText(/Current: When it's delivered/u)).toBeTruthy();
  });
});
