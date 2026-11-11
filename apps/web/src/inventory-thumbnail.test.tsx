// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InventoryThumbnail } from "./inventory-inspector";
import { workflowRequest } from "./api";
import { inventory } from "./mock-data";

vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), workflowRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(workflowRequest).mockReset(); });

it("shows the recorded item photo before references and gives failed images a neutral fallback", async () => {
  const item = inventory[0]!;
  vi.mocked(workflowRequest).mockResolvedValue({ itemId: item.id, version: 2, images: [
    { id: "reference", sourceKind: "reference", filename: "catalogue.png" },
    { id: "photo", sourceKind: "item_photo", filename: "item.png" },
  ] });
  const view = render(<InventoryThumbnail item={item} sampleMode={false} large />);
  await screen.findByText("Item photo");
  expect(workflowRequest).toHaveBeenCalledExactlyOnceWith(`/inventory/${encodeURIComponent(item.id)}/images`);
  const image = view.container.querySelector("img")!;
  expect(image.getAttribute("src")).toContain(`/inventory/${item.id}/images/photo/content`);
  fireEvent.error(image);
  expect(screen.getByText("Image unavailable")).toBeTruthy();
  expect(view.container.querySelector("img")).toBeNull();
});

it("keeps missing images usable and never loads private images in sample mode", async () => {
  const item = inventory[0]!;
  const view = render(<InventoryThumbnail item={item} sampleMode large />);
  expect(workflowRequest).not.toHaveBeenCalled();
  expect(screen.getByText("No image")).toBeTruthy();
  vi.mocked(workflowRequest).mockResolvedValue({ itemId: item.id, version: 0, images: [] });
  view.rerender(<InventoryThumbnail item={item} sampleMode={false} large />);
  await waitFor(() => expect(workflowRequest).toHaveBeenCalledOnce());
  expect(screen.getByText("No image")).toBeTruthy();
});
