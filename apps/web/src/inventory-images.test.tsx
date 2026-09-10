// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InventoryImages } from "./inventory-images";
import { workflowRequest, ApiError } from "./api";
vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), workflowRequest: vi.fn(), workflowCommandKey: () => "stable-image-command" }));
afterEach(() => { cleanup(); vi.mocked(workflowRequest).mockReset(); });
const gallery = { itemId: "printer", version: 0, images: [] };
it("never fetches or uploads sample inventory", () => { render(<InventoryImages itemId="sample" sampleMode />); expect(workflowRequest).not.toHaveBeenCalled(); expect(screen.getByText(/Connect to your workspace/)).toBeTruthy(); });
it("retains the exact upload on uncertain failure and reuses the key on retry", async () => {
  vi.mocked(workflowRequest).mockResolvedValueOnce(gallery).mockRejectedValueOnce(new ApiError("Connection lost", { kind: "offline" })).mockResolvedValueOnce({ data: { ...gallery, version: 1, images: [{ id: "photo", caption: "Fixture", filename: "photo.png", sourceKind: "reference" }] } });
  render(<InventoryImages itemId="printer" />);
  await screen.findByText("No images yet. Add a photo or a reference image.");
  fireEvent.click(screen.getByText("Add image"));
  fireEvent.change(screen.getByLabelText("Image file"), { target: { files: [new File(["synthetic"], "photo.png", { type: "image/png" })] } });
  fireEvent.change(screen.getByLabelText("Image source"), { target: { value: "reference" } });
  fireEvent.change(screen.getByLabelText("Caption (optional)"), { target: { value: "Fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Save image" }));
  await screen.findByRole("button", { name: "Retry image upload" });
  expect(screen.getByLabelText("Image file").closest("fieldset")!.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry image upload" }));
  await screen.findByRole("img", { name: "Fixture" });
  expect(vi.mocked(workflowRequest).mock.calls[1]).toEqual(vi.mocked(workflowRequest).mock.calls[2]);
  expect(screen.getByText("Reference image", { selector: "figcaption span" })).toBeTruthy();
});
it("rejects unsupported/oversized input without sending it and offers load retries", async () => {
  vi.mocked(workflowRequest).mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce(gallery);
  render(<InventoryImages itemId="printer" />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry loading images" }));
  await screen.findByText("Add image");
  fireEvent.change(screen.getByLabelText("Image file"), { target: { files: [new File(["<svg/>"], "photo.svg", { type: "image/svg+xml" })] } });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Choose a PNG"));
  expect(workflowRequest).toHaveBeenCalledTimes(2);
});
