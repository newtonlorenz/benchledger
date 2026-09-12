import { createRequire } from "node:module";
import { Color, Matrix4, Quaternion, Vector3 } from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import type { AssemblyMesh, AssemblySource } from "@benchledger/api-contract";
const LIMIT = 250_000;
const scaleFor = { millimetre: 1, centimetre: 10, metre: 1000, inch: 25.4 };
const name = (value: unknown, fallback: string) => (typeof value === "string" ? value.trim().slice(0, 160) : "") || fallback;
const meaningfulStepName = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && !/^(?:open\s*cascade(?:\s+step)?\s+(?:translator|processor)|unnamed|solid\s*\d*$)/iu.test(value.trim());
function fileLabel(filename: string): string {
  const label = filename.replace(/\.[^.]+$/u, "").replace(/^(?:[a-z]{1,8}_)?(?:r|rev)\d+_\d+_/iu, "").replace(/_single$/iu, "").replace(/[_-]+/gu, " ").trim();
  return (label.charAt(0).toUpperCase() + label.slice(1)).slice(0, 140) || "Part";
}
function fail(message: string): never { throw new Error(message); }
function validate(meshes: AssemblyMesh[]) {
  if (!meshes.length || meshes.length > 300) fail("Use a model with 1–300 separately identifiable parts.");
  let triangles = 0;
  for (const mesh of meshes) {
    triangles += mesh.indices.length / 3;
    if (!mesh.positions.length || mesh.positions.length % 3 || mesh.indices.length % 3 || !mesh.indices.length || triangles > LIMIT || mesh.positions.length > LIMIT * 9) fail("Model exceeds 250,000 triangles or has invalid geometry.");
    if (!mesh.positions.every(v => Number.isFinite(v) && Math.abs(v) <= 1e7) || !mesh.indices.every(v => Number.isInteger(v) && v >= 0 && v < mesh.positions.length / 3)) fail("Model has invalid coordinates or triangle indices.");
  }
  return meshes;
}
// Read only static triangle geometry. No external URLs, textures, scripts or CAD code are executed.
function glb(bytes: Uint8Array, factor: number): AssemblyMesh[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) fail("Use a valid binary glTF 2.0 (.glb) export.");
  let json: any, bin: Uint8Array | undefined;
  for (let at = 12; at < bytes.length;) {
    if (at + 8 > bytes.length) fail("Truncated GLB chunk.");
    const length = view.getUint32(at, true), kind = view.getUint32(at + 4, true); at += 8;
    if (length % 4 || at + length > bytes.length) fail("Invalid GLB chunk length.");
    const chunk = bytes.subarray(at, at + length); at += length;
    if (kind === 0x4e4f534a) { if (json || length > 2_000_000) fail("Invalid or oversized GLB metadata."); json = JSON.parse(new TextDecoder().decode(chunk)); }
    if (kind === 0x004e4942) { if (bin) fail("Multiple GLB binary chunks are not supported."); bin = chunk; }
  }
  if (!json || !bin || json.asset?.version !== "2.0" || json.buffers?.length !== 1 || json.buffers[0].uri || json.buffers[0].byteLength > bin.length) fail("Use a self-contained GLB with an embedded geometry buffer.");
  if (json.extensionsRequired?.length || json.skins?.length || json.animations?.length) fail("Export a static, uncompressed GLB without skins or required extensions.");
  const buffer = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  function accessor(index: number, dimensions: number): number[] {
    const a = json.accessors?.[index], b = json.bufferViews?.[a?.bufferView];
    if (!a || !b || b.buffer !== 0 || a.sparse || a.normalized || a.type !== (dimensions === 3 ? "VEC3" : "SCALAR") || !Number.isInteger(a.count) || a.count < 1 || a.count > LIMIT * 3) fail("Unsupported or oversized GLB geometry accessor.");
    const size = ({ 5121: 1, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[a.componentType];
    if (!size || dimensions === 3 && a.componentType !== 5126 || dimensions === 1 && a.componentType === 5126) fail("Unsupported GLB position/index encoding.");
    const start = (b.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = b.byteStride ?? size * dimensions;
    if (![start, stride, b.byteLength, b.byteOffset ?? 0, a.byteOffset ?? 0].every(v => Number.isSafeInteger(v) && v >= 0) || stride < size * dimensions || start + (a.count - 1) * stride + size * dimensions > Math.min(bin!.length, (b.byteOffset ?? 0) + b.byteLength)) fail("GLB accessor lies outside its buffer.");
    const result: number[] = [];
    for (let i = 0; i < a.count; i++) for (let k = 0; k < dimensions; k++) {
      const at = start + i * stride + k * size;
      result.push(a.componentType === 5126 ? buffer.getFloat32(at, true) : size === 1 ? buffer.getUint8(at) : size === 2 ? buffer.getUint16(at, true) : buffer.getUint32(at, true));
    }
    return result;
  }
  const meshes: AssemblyMesh[] = [], visited = new Set<number>();
  let triangleCount = 0;
  function visit(index: number, parent: Matrix4, path: string[], depth: number) {
    const node = json.nodes?.[index];
    if (!node || visited.has(index) || depth > 64 || visited.size > 5000) fail("Invalid, cyclic or oversized GLB hierarchy.");
    visited.add(index);
    const finiteArray = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(x => typeof x === "number" && Number.isFinite(x));
    if (node.matrix && !finiteArray(node.matrix, 16) || node.translation && !finiteArray(node.translation, 3) || node.rotation && !finiteArray(node.rotation, 4) || node.scale && !finiteArray(node.scale, 3)) fail("Invalid GLB node transform.");
    const matrix = new Matrix4();
    if (node.matrix) matrix.fromArray(node.matrix);
    else matrix.compose(new Vector3().fromArray(node.translation ?? [0, 0, 0]), new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]).normalize(), new Vector3().fromArray(node.scale ?? [1, 1, 1]));
    matrix.premultiply(parent);
    const title = name(node.name, `Part ${index + 1}`);
    if (node.mesh !== undefined) {
      const model = json.meshes?.[node.mesh];
      if (!Array.isArray(model?.primitives)) fail("Missing GLB mesh.");
      model.primitives.forEach((primitive: any, pi: number) => {
        if ((primitive.mode ?? 4) !== 4 || primitive.targets?.length || primitive.extensions) fail("Export static, uncompressed triangle meshes for this viewer.");
        const positions = accessor(primitive.attributes?.POSITION, 3), indices = primitive.indices === undefined ? Array.from({ length: positions.length / 3 }, (_, i) => i) : accessor(primitive.indices, 1);
        triangleCount += indices.length / 3;
        if (triangleCount > LIMIT || meshes.length >= 300) fail("Model exceeds 300 parts or 250,000 triangles.");
        const v = new Vector3();
        for (let i = 0; i < positions.length; i += 3) { v.fromArray(positions, i).applyMatrix4(matrix).multiplyScalar(factor); v.toArray(positions, i); }
        if (matrix.determinant() < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
        const rgb = json.materials?.[primitive.material]?.pbrMetallicRoughness?.baseColorFactor;
        meshes.push({ nodeId: `node-${index}-${pi}`, name: model.primitives.length > 1 ? `${title.slice(0, 140)} (${pi + 1})` : title, group: path.join(" / ").slice(0, 160), color: Array.isArray(rgb) && rgb.length >= 3 && rgb.slice(0, 3).every((x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1) ? `#${new Color(rgb[0], rgb[1], rgb[2]).getHexString()}` : "#b6aa91", positions, indices });
      });
    }
    for (const child of node.children ?? []) visit(child, matrix, [...path, title], depth + 1);
  }
  const roots = json.scenes?.[json.scene ?? 0]?.nodes;
  if (!Array.isArray(roots)) fail("GLB has no default assembly scene.");
  for (const root of roots) visit(root, new Matrix4(), [], 0);
  return meshes;
}
export async function parseAssemblyFile(bytes: Uint8Array, filename: string, unit: AssemblySource["unit"], upAxis: "y" | "z" = "z"): Promise<{ meshes: AssemblyMesh[]; warnings: string[] }> {
  if (bytes.length > 20 * 1024 * 1024 || bytes.length < 15) fail("Use a non-empty model file up to 20 MB.");
  const ext = filename.split(".").pop()?.toLowerCase(), factor = scaleFor[unit];
  let meshes: AssemblyMesh[];
  const warnings = ["Exploded positions illustrate relationships, not a verified removal path. Colours are illustrative; textures and physical fit are not validated."];
  if (ext === "glb") { meshes = glb(bytes, factor); warnings.push(`GLB coordinates interpreted as ${unit}; check the displayed dimensions. Only static triangle geometry is imported.`); }
  else if (ext === "stl") {
    if (bytes.length >= 84) { const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true); if (84 + count * 50 === bytes.length && count > LIMIT) fail("STL exceeds 250,000 triangles."); }
    const geometry = new STLLoader().parse(bytes.slice().buffer);
    try { const positions = Array.from(geometry.getAttribute("position").array, n => Number(n) * factor); meshes = [{ nodeId: "mesh-0", name: filename.replace(/\.stl$/iu, "").slice(0, 160), group: "", color: "#b6aa91", positions, indices: Array.from({ length: positions.length / 3 }, (_, i) => i) }]; }
    finally { geometry.dispose(); }
    warnings.push("STL has no assembly identity or declared units. Each STL is one part; adjust its position and rotation if exported for printing.");
  } else if (ext === "step" || ext === "stp") {
    const initialise = createRequire(import.meta.url)("occt-import-js");
    const occt = await initialise();
    const result = occt.ReadStepFile(bytes, { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.002, angularDeflection: 0.5 });
    if (!result.success || !Array.isArray(result.meshes)) fail("STEP could not be imported. Export an assembly containing separate solids.");
    const groups = new Map<number, string>();
    let count = 0;
    function visit(node: any, path: string[], depth: number) { if (!node || depth > 64 || ++count > 5000) fail("STEP hierarchy is too large."); const next = meaningfulStepName(node.name) && !/^assembly$/iu.test(node.name) ? [...path, name(node.name, "")] : path; for (const index of node.meshes ?? []) groups.set(index, path.join(" / ").slice(0, 160)); for (const child of node.children ?? []) visit(child, next, depth + 1); }
    visit(result.root, [], 0);
    const label = fileLabel(filename);
    meshes = result.meshes.map((mesh: any, index: number) => ({ nodeId: `mesh-${index}`, name: meaningfulStepName(mesh.name) ? name(mesh.name, label) : `${label}${result.meshes.length > 1 ? ` (${index + 1})` : ""}`, group: groups.get(index) || (result.meshes.length > 1 ? label : ""), color: Array.isArray(mesh.color) ? `#${new Color(...mesh.color as [number, number, number]).getHexString()}` : "#b6aa91", positions: mesh.attributes.position.array, indices: mesh.index.array }));
    warnings.push("STEP uses its declared units, converted to millimetres. Small CAD features may be simplified for viewing.");
  } else fail("Use STEP (.step/.stp), GLB or STL. Export other native CAD formats to STEP or GLB first.");
  if (upAxis === "y") for (const mesh of meshes) for (let i = 0; i < mesh.positions.length; i += 3) { const y = mesh.positions[i + 1]!; mesh.positions[i + 1] = -mesh.positions[i + 2]!; mesh.positions[i + 2] = y; }
  return { meshes: validate(meshes), warnings };
}
