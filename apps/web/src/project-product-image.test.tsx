// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fetchArtifactDownload } from "./api";
import { ProductImage } from "./project-product-image";
import { projects } from "./mock-data";
import type { Project } from "./domain";
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), fetchArtifactDownload: vi.fn() }));
const cover = { id: "cover", name: "fixture.png", role: "Photo" as const, revision: "r01", hash: "a".repeat(64), size: "1 KB", updated: "2026-10-04", status: "candidate" as const, projectRevisionId: "current", mediaType: "image/png", byteSize: 100 };
const fixture = (): Project => ({ ...structuredClone(projects[0]!), id: "project", serverRevisionId: "current", artifacts: [cover], allArtifacts: [cover], presentation: { projectId: "project", projectRevisionId: "current", version: 1, coverArtifactId: cover.id, coverSha256: cover.hash, imageKind: "render", caption: "Synthetic bracket design", updatedAt: "2026-10-04T10:00:00Z", updatedBy: "synthetic", warnings: [] } });
beforeEach(() => {
  vi.mocked(fetchArtifactDownload).mockReset().mockResolvedValue(new Blob(["synthetic-image-bytes"], { type: "image/png" }));
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:synthetic-cover"), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("downloads the selected image with bounded hash verification, opens the project and releases its object URL", async () => {
  const onOpen = vi.fn(); const view = render(<ProductImage project={fixture()} onOpen={onOpen} />);
  fireEvent.click(await screen.findByRole("img", { name: "Synthetic bracket design" }));
  expect(onOpen).toHaveBeenCalledOnce();
  expect(fetchArtifactDownload).toHaveBeenCalledWith("cover", cover.hash, expect.objectContaining({ maxBytes: 20 * 1024 * 1024, signal: expect.any(AbortSignal) }));
  expect(screen.getByText("Design render")).toBeTruthy();
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-cover");
});
it("offers recovery after a failed or undecodable image, and never displays stale bytes for a new revision", async () => {
  vi.mocked(fetchArtifactDownload).mockRejectedValueOnce(new Error("Hash mismatch"));
  const view = render(<ProductImage project={fixture()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry image" }));
  const image = await screen.findByRole("img");
  fireEvent.error(image);
  expect(screen.getByText("Image unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry image" }));
  await screen.findByRole("img");
  view.rerender(<ProductImage project={{ ...fixture(), serverRevisionId: "next" }} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("Add a project image")).toBeTruthy();
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalled());
});
it("keeps missing-image selection accessible in the compact list", () => {
  const project = { ...fixture(), presentation: null }; const onChoose = vi.fn();
  render(<ProductImage project={project} compact onChoose={onChoose} />);
  fireEvent.click(screen.getByRole("button", { name: `Choose image for ${project.name}` }));
  expect(onChoose).toHaveBeenCalledOnce();
  expect(fetchArtifactDownload).not.toHaveBeenCalled();
});
