// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactPreview, artifactPreviewKind, MarkdownPreview } from "./artifact-preview";
import { fetchArtifactDownload } from "./api";
import type { Artifact } from "./domain";
vi.mock("./api", () => ({ fetchArtifactDownload: vi.fn() }));
const file: Artifact = { id: "synthetic-file", name: "README.md", hash: "a".repeat(64), role: "Notes", revision: "r01", size: "10 B", updated: "2026-09-09", status: "candidate" };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(fetchArtifactDownload).mockReset(); });
describe("project file previews", () => {
  it("offers previews only for supported file extensions", () => {
    for (const name of ["part.STL", "README.md", "notes.txt", "photo.PNG", "drawing.svg", "part.scad"]) expect(artifactPreviewKind(name)).toBeDefined();
    for (const name of ["part.step", "plate.3mf", "script.html", "file.pdf", "source.FCStd", "constructor", "image.png.exe", "__proto__"]) expect(artifactPreviewKind(name)).toBeUndefined();
  });
  it("renders Markdown formatting without active HTML, unsafe links or embedded network requests", () => {
    const html = renderToStaticMarkup(<MarkdownPreview text={'# Instructions\n\n**Bold**\n\n<script>alert(1)</script>\n\n![secret](https://example.org/tracker)\n\n[bad](javascript:alert%281%29)\n\n[good](https://example.org/docs)\n\n[local](/api/v1/logout)'} />);
    expect(html).toContain("<h1>Instructions</h1>"); expect(html).toContain("<strong>Bold</strong>");
    expect(html).not.toMatch(/<script|<img|javascript:|href="\/api/u);
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it("uses verified, bounded bytes and supports Escape", async () => {
    vi.mocked(fetchArtifactDownload).mockResolvedValue({ text: async () => "# Assembly\n\nRead this first." } as Blob);
    const close = vi.fn(); const view = render(<ArtifactPreview file={file} onClose={close} />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    await screen.findByRole("heading", { name: "Assembly" });
    const options = vi.mocked(fetchArtifactDownload).mock.calls[0]![2]!;
    expect(options.maxBytes).toBe(1024 * 1024);
    fireEvent.keyDown(document, { key: "Escape" }); expect(close).toHaveBeenCalledOnce();
    view.unmount(); expect(options.signal?.aborted).toBe(true);
  });
  it("shows errors and retries without rendering unverified content", async () => {
    vi.mocked(fetchArtifactDownload).mockRejectedValueOnce(new Error("Integrity failed")).mockResolvedValueOnce({ text: async () => "safe notes" } as Blob);
    render(<ArtifactPreview file={{ ...file, name: "notes.txt" }} onClose={() => undefined} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Integrity failed");
    fireEvent.click(screen.getByText("Retry preview")); await screen.findByText("safe notes");
  });
  it("revokes image URLs on close and reports invalid images", async () => {
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:synthetic-image"), revokeObjectURL: vi.fn() });
    vi.mocked(fetchArtifactDownload).mockResolvedValue(new Blob(["image"]));
    const view = render(<ArtifactPreview file={{ ...file, name: "photo.png" }} onClose={() => undefined} />);
    const img = await screen.findByRole("img"); expect(img.getAttribute("src")).toBe("blob:synthetic-image");
    fireEvent.error(img); expect(screen.getByRole("alert").textContent).toContain("could not be displayed");
    view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-image");
  });
  it("ignores late downloads after the preview is closed", async () => {
    let finish!: (value: Blob) => void;
    vi.mocked(fetchArtifactDownload).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const view = render(<ArtifactPreview file={{ ...file, name: "photo.png" }} onClose={() => undefined} />);
    view.unmount(); finish(new Blob(["image"]));
    await waitFor(() => expect(URL.createObjectURL).not.toHaveBeenCalled());
  });
});
