// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { InventoryDrawer } from "./App";
import { ApiError } from "./api";
import { inventory } from "./mock-data";
import type { InventoryItem } from "./domain";

afterEach(cleanup);
const item: InventoryItem = { ...inventory[0]!, id: "count-item", name: "Synthetic insert pack", quantity: 1, reserved: 0, unit: "each", evidence: "counted" };
const frame = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });

function renderDrawer(onCount: (id: string, quantity: number) => Promise<InventoryItem>) {
  render(<InventoryDrawer item={item} sampleMode categories={[]} categoriesLoading={false} expert={false} onClose={() => undefined} onCount={onCount} onCommission={async () => item} onUpdate={async () => item} />);
  return screen.getByRole("dialog", { name: /Synthetic insert pack/u });
}

describe("inline physical count review", () => {
  it("reviews the change inside the drawer instead of stacking another dialog", async () => {
    const onCount = vi.fn(async (_id: string, quantity: number) => ({ ...item, quantity, evidence: "counted" as const }));
    const drawer = renderDrawer(onCount);
    fireEvent.change(within(drawer).getByLabelText("Counted quantity"), { target: { value: "3" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Review physical count" }));
    await frame();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(drawer.getAttribute("aria-hidden")).toBeNull();
    const review = within(drawer).getByRole("group", { name: "Review physical count" });
    expect(review.textContent).toContain("Before");
    expect(review.textContent).toContain("1 piece");
    expect(review.textContent).toContain("After");
    expect(review.textContent).toContain("3 pieces");
    expect(within(drawer).getByLabelText("Counted quantity")).toHaveProperty("disabled", true);
    const confirm = within(review).getByRole("button", { name: "Confirm physical count" });
    expect(document.activeElement).toBe(confirm);
    expect(onCount).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await frame();
    expect(onCount).toHaveBeenCalledWith("count-item", 3);
    expect(within(drawer).queryByRole("group", { name: "Review physical count" })).toBeNull();
    expect(within(drawer).getByRole("status").textContent).toContain("Confirmed 3 pieces as the on-hand quantity.");
  });

  it("keeps the exact reviewed count for a retry after a failure", async () => {
    const onCount = vi.fn()
      .mockRejectedValueOnce(new ApiError("The service did not answer.", { kind: "offline", status: 0 }))
      .mockImplementation(async (_id: string, quantity: number) => ({ ...item, quantity }));
    const drawer = renderDrawer(onCount);
    fireEvent.change(within(drawer).getByLabelText("Counted quantity"), { target: { value: "4" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Review physical count" }));
    await frame();
    const review = within(drawer).getByRole("group", { name: "Review physical count" });
    fireEvent.click(within(review).getByRole("button", { name: "Confirm physical count" }));
    await frame();
    expect(within(review).getByRole("alert").textContent).toContain("did not answer");
    expect(within(drawer).getByLabelText("Counted quantity")).toHaveProperty("disabled", true);
    fireEvent.click(within(review).getByRole("button", { name: "Confirm physical count" }));
    await frame();
    expect(onCount).toHaveBeenNthCalledWith(1, "count-item", 4);
    expect(onCount).toHaveBeenNthCalledWith(2, "count-item", 4);
  });

  it("returns focus to the review button when the review is abandoned", async () => {
    const drawer = renderDrawer(vi.fn(async () => item));
    fireEvent.change(within(drawer).getByLabelText("Counted quantity"), { target: { value: "2" } });
    within(drawer).getByRole("button", { name: "Review physical count" }).focus();
    fireEvent.click(within(drawer).getByRole("button", { name: "Review physical count" }));
    await frame();
    fireEvent.keyDown(document, { key: "Escape" });
    await frame();
    expect(within(drawer).queryByRole("group", { name: "Review physical count" })).toBeNull();
    expect(screen.getByRole("dialog", { name: /Synthetic insert pack/u })).toBeTruthy();
    expect(document.activeElement).toBe(within(drawer).getByRole("button", { name: "Review physical count" }));
  });

  it("returns focus to the count field when the review started from it", async () => {
    const onCount = vi.fn(async () => item);
    const drawer = renderDrawer(onCount);
    const input = within(drawer).getByLabelText("Counted quantity");
    fireEvent.change(input, { target: { value: "2" } });
    input.focus();
    fireEvent.submit(input.closest("form")!);
    await frame();
    fireEvent.click(within(drawer).getByRole("button", { name: "Change count" }));
    await frame();
    expect(within(drawer).queryByRole("group", { name: "Review physical count" })).toBeNull();
    expect(input).toHaveProperty("disabled", false);
    expect(document.activeElement).toBe(input);
    expect(onCount).not.toHaveBeenCalled();
  });
});
