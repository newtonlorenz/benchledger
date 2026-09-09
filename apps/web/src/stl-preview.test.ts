import { describe, expect, it } from "vitest";
import { readStlGeometry } from "./stl-preview";
const ascii = (vertex: string) => new TextEncoder().encode(`solid part\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex ${vertex}\nendloop\nendfacet\nendsolid part`).buffer;
describe("STL preview geometry", () => {
  it("reads and normalizes an ASCII STL", () => {
    const geometry = readStlGeometry(ascii("0 1 0"));
    expect(geometry.getAttribute("position").count).toBe(3);
    geometry.computeBoundingBox(); expect(geometry.boundingBox!.max.x).toBe(1); geometry.dispose();
  });
  it("reads a binary STL", () => {
    const bytes = new ArrayBuffer(134); const data = new DataView(bytes); data.setUint32(80, 1, true);
    data.setFloat32(108, 1, true); data.setFloat32(124, 1, true);
    const geometry = readStlGeometry(bytes); expect(geometry.getAttribute("position").count).toBe(3); geometry.dispose();
  });
  it("rejects forged binary counts before allocating geometry", () => {
    const bytes = new ArrayBuffer(84); new DataView(bytes).setUint32(80, 0xffffffff, true);
    expect(() => readStlGeometry(bytes)).toThrow("truncated or invalid");
  });
  it("rejects empty and non-finite meshes", () => {
    expect(() => readStlGeometry(new ArrayBuffer(0))).toThrow();
    expect(() => readStlGeometry(ascii("0 1e999 0"))).toThrow();
    expect(() => readStlGeometry(new TextEncoder().encode("solid empty\nendsolid empty").buffer)).toThrow();
  });
});
