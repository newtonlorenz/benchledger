import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { parseAssemblyFile } from "./assembly-parser.js";
import { importAssemblyFile } from "@benchledger/artifacts";
function fixture(change?: (json: any) => void): Uint8Array {
  const bin = Buffer.alloc(44); [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((n, i) => bin.writeFloatLE(n, i * 4)); [0, 1, 2].forEach((n, i) => bin.writeUInt16LE(n, 36 + i * 2));
  const json = { asset: { version: "2.0" }, buffers: [{ byteLength: 44 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ name: "Enclosure", translation: [10, 0, 0], children: [1, 2] }, { name: "Base", mesh: 0 }, { name: "Lid", mesh: 0, translation: [0, 0, 2], scale: [-1, 1, 1] }], scenes: [{ nodes: [0] }], scene: 0 };
  change?.(json); let text = JSON.stringify(json); text += " ".repeat((4 - Buffer.byteLength(text) % 4) % 4); const content = Buffer.from(text);
  const output = Buffer.alloc(12 + 8 + content.length + 8 + bin.length); output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8); output.writeUInt32LE(content.length, 12); output.writeUInt32LE(0x4e4f534a, 16); content.copy(output, 20); const at = 20 + content.length; output.writeUInt32LE(bin.length, at); output.writeUInt32LE(0x004e4942, at + 4); bin.copy(output, at + 8); return output;
}
const stl = new TextEncoder().encode("solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle");
describe("bounded static assembly import", () => {
  it("preserves nested placements, repeated meshes and mirrored winding with explicit units", async () => {
    const result = await parseAssemblyFile(fixture(), "assembly.glb", "metre");
    expect(result.meshes.map(m => m.nodeId)).toEqual(["node-1-0", "node-2-0"]);
    expect(result.meshes[0]!.positions.slice(0, 6)).toEqual([10000, 0, 0, 11000, 0, 0]);
    expect(result.meshes[1]!.positions.slice(0, 6)).toEqual([10000, 0, 2000, 9000, 0, 2000]);
    expect(result.meshes[1]!.indices).toEqual([0, 2, 1]); expect(result.meshes[0]!.group).toBe("Enclosure");
  });
  it("does not fetch material images and honours author colour", async () => {
    const result = await parseAssemblyFile(fixture(j => { j.images = [{ uri: "https://example.invalid/private" }]; j.materials = [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }]; j.meshes[0].primitives[0].material = 0; }), "parts.glb", "millimetre");
    expect(result.meshes[0]!.color).toBe("#ff0000");
  });
  it("fails closed on external buffers, cycles, compression, animation and invalid bounds", async () => {
    for (const change of [
      (j: any) => { j.buffers[0].uri = "https://example.invalid/mesh"; }, (j: any) => { j.nodes[2].children = [0]; },
      (j: any) => { j.extensionsRequired = ["KHR_draco_mesh_compression"]; }, (j: any) => { j.animations = [{}]; },
      (j: any) => { j.accessors[0].count = 250001 * 3; }, (j: any) => { j.accessors[0].byteOffset = 4096; },
      (j: any) => { j.meshes[0].primitives[0].mode = 1; }, (j: any) => { j.nodes[1].translation = [1, 2]; },
      (j: any) => { j.accessors[0].sparse = {}; }, (j: any) => { j.scenes = []; },
    ]) await expect(parseAssemblyFile(fixture(change), "bad.glb", "millimetre")).rejects.toThrow();
    await expect(parseAssemblyFile(fixture().subarray(0, 24), "bad.glb", "millimetre")).rejects.toThrow();
    await expect(parseAssemblyFile(stl, "model.py", "millimetre")).rejects.toThrow(/Use STEP/);
    await expect(parseAssemblyFile(new Uint8Array(21 * 1024 * 1024), "large.stl", "millimetre")).rejects.toThrow(/20 MB/);
  });
  it("reads STL as a single part and normalises units", async () => {
    const result = await parseAssemblyFile(stl, "spacer.stl", "inch"); expect(result.meshes).toHaveLength(1); expect(result.meshes[0]!.positions[3]).toBe(25.4); expect(result.warnings.join()).toContain("one part");
    const binary = Buffer.alloc(134); binary.writeUInt32LE(1, 80); binary.writeFloatLE(NaN, 96);
    await expect(parseAssemblyFile(binary, "bad.stl", "millimetre")).rejects.toThrow(/invalid coordinates/);
  });
  it("imports a synthetic STEP assembly with source placements and ends its worker", async () => {
    const bytes = await readFile(new URL("../testfiles/synthetic-assembly.step", import.meta.url));
    const result = await importAssemblyFile(bytes, "synthetic-assembly.step", "metre");
    expect(result.meshes).toHaveLength(2); const coordinates = result.meshes.flatMap(m => m.positions.filter((_, i) => i % 3 === 2));
    expect(Math.min(...coordinates)).toBeCloseTo(-2); expect(Math.max(...coordinates)).toBeCloseTo(15);
    await expect(importAssemblyFile(stl, "unsupported.txt", "millimetre")).rejects.toThrow(/Use STEP/);
  });
});

it("replaces STEP exporter placeholders with readable filenames while preserving real CAD names", async () => {
  const bytes = await readFile(new URL("../testfiles/synthetic-assembly.step", import.meta.url));
  const original = await parseAssemblyFile(bytes, "DEMO_R03_01_cover_single.step", "millimetre");
  expect(original.meshes.map(mesh => mesh.name)).toEqual(["Base", "Lid"]);
  const generic = Buffer.from(bytes.toString().replaceAll("Synthetic enclosure", "Open CASCADE STEP translator 7.9").replaceAll("'Base'", "'Open CASCADE STEP translator 7.9 1'").replaceAll("'Lid'", "'Open CASCADE STEP translator 7.9 2'"));
  const result = await parseAssemblyFile(generic, "DEMO_R03_01_cover_single.step", "millimetre");
  expect(result.meshes.map(mesh => mesh.name)).toEqual(["Cover (1)", "Cover (2)"]);
  expect(result.meshes.map(mesh => mesh.group)).toEqual(["Cover", "Cover"]);
  expect(result.meshes.map(mesh => mesh.positions)).toEqual(original.meshes.map(mesh => mesh.positions));
});
