import { describe, expect, it } from "vitest";
import { formatModelSize, gridStep, readStlGeometry } from "./stl-preview";
const ascii = (vertex: string) => new TextEncoder().encode(`solid part\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex ${vertex}\nendloop\nendfacet\nendsolid part`).buffer;
describe("STL preview geometry", () => {
  it("reads an ASCII STL in its recorded units, centred on a Z-up build plane", () => {
    const geometry = readStlGeometry(ascii("0 1 2"));
    expect(geometry.getAttribute("position").count).toBe(3);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.x).toBe(0.5); expect(geometry.boundingBox!.min.x).toBe(-0.5);
    expect(geometry.boundingBox!.min.z).toBe(0); expect(geometry.boundingBox!.max.z).toBe(2);
    expect(geometry.userData.size).toEqual({ x: 1, y: 1, z: 2 });
    geometry.dispose();
  });
  it("formats model bounds and picks a readable grid step", () => {
    expect(formatModelSize({ x: 40, y: 30.25, z: 1500 })).toBe("40.0 × 30.3 × 1500 mm");
    expect([gridStep(6), gridStep(60), gridStep(250), gridStep(0)]).toEqual([1, 10, 50, 10]);
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
