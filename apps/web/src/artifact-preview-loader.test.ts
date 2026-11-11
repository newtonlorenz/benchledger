import { describe, expect, it } from "vitest";
import { artifactPreviewKind } from "./artifact-preview";
import { canPreviewArtifact } from "./artifact-preview-loader";

describe("lazy artifact preview", () => {
  it("offers previews for exactly the files the previewer supports", () => {
    const names = ["part.STL", "README.md", "a.markdown", "notes.txt", "x.csv", "x.tsv", "x.json", "x.yaml", "x.yml", "x.log", "x.gcode", "part.scad", "photo.PNG", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.avif", "a.bmp", "drawing.svg", "part.step", "plate.3mf", "script.html", "file.pdf", "constructor", "__proto__", "image.png.exe", "noext"];
    for (const name of names) expect(canPreviewArtifact(name), name).toBe(artifactPreviewKind(name) !== undefined);
  });
});
