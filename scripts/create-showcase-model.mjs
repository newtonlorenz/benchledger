// Synthetic display model only: not a validated mechanical or electrical design.
// Run from the repository root after npm ci; no private project files are used.
import { BoxGeometry, CylinderGeometry } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mkdir, writeFile } from "node:fs/promises";
const box = (x, y, z, px = 0, py = 0, pz = 0) => new BoxGeometry(x, y, z).translate(px, py, pz);
const cylinder = (radius, height, x, y, z) => new CylinderGeometry(radius, radius, height, 32).rotateX(Math.PI / 2).translate(x, y, z);
const parts = [
  { name: "Base enclosure", color: [0.73, 0.64, 0.46, 1], pieces: [box(100, 70, 3, 0, 0, 0), box(100, 3, 20, 0, -33.5, 11.5), box(100, 3, 20, 0, 33.5, 11.5), box(3, 64, 20, -48.5, 0, 11.5), box(3, 64, 20, 48.5, 0, 11.5)] },
  { name: "Board standoffs", color: [0.64, 0.67, 0.69, 1], pieces: [-25, 25].flatMap(x => [-16, 16].map(y => cylinder(3, 9, x, y, 6))) },
  { name: "Controller board", color: [0.035, 0.34, 0.23, 1], pieces: [box(64, 44, 1.6, 0, 0, 12)] },
  { name: "Processor and headers", color: [0.075, 0.095, 0.12, 1], pieces: [box(18, 18, 3, 0, 0, 14.3), box(40, 3, 4, 0, -18, 14.8), box(40, 3, 4, 0, 18, 14.8)] },
  { name: "USB connector", color: [0.62, 0.66, 0.69, 1], pieces: [box(10, 12, 5, -27, 0, 15.3)] },
  { name: "Vented cover", color: [0.85, 0.83, 0.74, 1], pieces: [box(100, 14, 3, 0, -28, 25), box(100, 14, 3, 0, 28, 25), box(30, 42, 3, -35, 0, 25), box(30, 42, 3, 35, 0, 25), ...[-18, -12, -6, 0, 6, 12, 18].map(y => box(40, 3, 3, 0, y, 25))] },
  { name: "Cover fasteners", color: [0.22, 0.27, 0.3, 1], pieces: [-42, 42].flatMap(x => [-27, 27].map(y => cylinder(2.5, 3, x, y, 28))) }
];
const json = { asset: { version: "2.0", generator: "BenchLedger synthetic showcase" }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [], materials: [], meshes: [], nodes: [], scenes: [{ nodes: [] }], scene: 0 };
const chunks = []; let offset = 0;
const bufferView = data => { const pad = Buffer.alloc((4 - data.length % 4) % 4); const id = json.bufferViews.length; json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length }); chunks.push(data, pad); offset += data.length + pad.length; return id; };
for (const part of parts) {
  const merged = mergeGeometries(part.pieces.map(g => g.toNonIndexed()));
  const array = merged.getAttribute("position").array;
  const bytes = Buffer.alloc(array.length * 4); array.forEach((v, i) => bytes.writeFloatLE(v / 1000, i * 4));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  array.forEach((v, i) => { min[i % 3] = Math.min(min[i % 3], v / 1000); max[i % 3] = Math.max(max[i % 3], v / 1000); });
  const accessor = json.accessors.length; json.accessors.push({ bufferView: bufferView(bytes), componentType: 5126, count: array.length / 3, type: "VEC3", min, max });
  const index = json.meshes.length; json.materials.push({ pbrMetallicRoughness: { baseColorFactor: part.color, metallicFactor: 0, roughnessFactor: 0.7 } });
  json.meshes.push({ primitives: [{ attributes: { POSITION: accessor }, material: index }] }); json.nodes.push({ name: part.name, mesh: index }); json.scenes[0].nodes.push(index);
  merged.dispose(); part.pieces.forEach(g => g.dispose());
}
json.buffers[0].byteLength = offset;
let text = JSON.stringify(json); text += " ".repeat((4 - Buffer.byteLength(text) % 4) % 4); const metadata = Buffer.from(text), binary = Buffer.concat(chunks);
const glb = Buffer.alloc(28 + metadata.length + binary.length); glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(metadata.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); metadata.copy(glb, 20); const start = 20 + metadata.length; glb.writeUInt32LE(binary.length, start); glb.writeUInt32LE(0x004e4942, start + 4); binary.copy(glb, start + 8);
await mkdir("docs/assets/showcase", { recursive: true });
await writeFile("docs/assets/showcase/synthetic-enclosure.glb", glb);
console.log(`Wrote ${parts.length} synthetic parts (${glb.length} bytes). Import with metre units and Z up.`);
