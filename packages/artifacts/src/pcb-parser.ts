import polygonClipping from "polygon-clipping";
import { ExtrudeGeometry, Path, Shape, Vector2 } from "three";
import type { AssemblyMesh, PcbGeometryInfo } from "@benchledger/api-contract";

// A bounded reader, not a KiCad interpreter. No file/model paths are resolved.
type Node = (string | Node)[];
type Point = [number, number];
const fail = (message: string): never => { throw new Error(`PCB ${message}`); };
function read(text: string): Node {
  let at = 0, tokens = 0;
  const space = () => { while (/\s/u.test(text[at] ?? "") && at < text.length) at++; };
  function value(depth: number): string | Node {
    space(); if (++tokens > 250_000 || depth > 48) fail("source exceeds token or nesting limits.");
    if (text[at] === "(") {
      at++; const result: Node = [];
      while (true) { space(); if (at >= text.length) fail("source has an unclosed expression."); if (text[at] === ")") { at++; return result; } result.push(value(depth + 1)); }
    }
    if (text[at] === '"') {
      at++; let result = "", closed = false;
      while (at < text.length) { const c = text[at++]!; if (c === '"') { closed = true; break; } if (c === "\\") { if (at >= text.length) fail("source has an incomplete escape."); result += text[at++]!; } else result += c; if (result.length > 4096) fail("source contains an oversized string."); }
      if (!closed) fail("source has an unclosed string."); return result;
    }
    const start = at; while (at < text.length && !/[\s()]/u.test(text[at]!)) at++;
    if (at === start || at - start > 4096) fail("source contains an invalid token."); return text.slice(start, at);
  }
  const root = value(0); space();
  if (at !== text.length || !Array.isArray(root) || root[0] !== "kicad_pcb") fail("source must be one complete KiCad board expression.");
  return root as Node;
}
const nodes = (n: Node, key: string) => n.filter((v): v is Node => Array.isArray(v) && v[0] === key);
const child = (n: Node, key: string): Node => nodes(n, key)[0] ?? [];
const string = (v: string | Node | undefined, fallback = "") => typeof v === "string" ? v : fallback;
const label = (v: string | Node | undefined, fallback = "") => string(v, fallback).slice(0, 160);
function num(v: string | Node | undefined, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(v)) fail("source has an invalid numeric coordinate.");
  const n = Number(v); if (!Number.isFinite(n) || Math.abs(n) > 100_000) fail("coordinates exceed the viewing limit."); return n;
}
const point = (n: Node): Point => [num(n[1]), num(n[2])];
const layer = (n: Node) => string(child(n, "layer")[1]);
const equal = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.0001;
function circle(x: number, y: number, radius: number): Point[] {
  if (radius <= 0 || radius > 10_000) fail("circle size is invalid.");
  return Array.from({ length: 48 }, (_, i) => [x + radius * Math.cos(i * Math.PI / 24), y + radius * Math.sin(i * Math.PI / 24)]);
}
function arc(n: Node): Point[] {
  const [a, b, c] = [point(child(n, "start")), point(child(n, "mid")), point(child(n, "end"))];
  const d = 2 * (a![0] * (b![1] - c![1]) + b![0] * (c![1] - a![1]) + c![0] * (a![1] - b![1]));
  if (Math.abs(d) < 1e-8) fail("arc is degenerate or uses an unsupported legacy definition.");
  const square = (p: Point) => p[0] ** 2 + p[1] ** 2;
  const x = (square(a!) * (b![1] - c![1]) + square(b!) * (c![1] - a![1]) + square(c!) * (a![1] - b![1])) / d;
  const y = (square(a!) * (c![0] - b![0]) + square(b!) * (a![0] - c![0]) + square(c!) * (b![0] - a![0])) / d;
  const angle = (p: Point) => Math.atan2(p[1] - y, p[0] - x), tau = 2 * Math.PI;
  const start = angle(a!), middle = (angle(b!) - start + tau) % tau, end = (angle(c!) - start + tau) % tau;
  const sweep = middle < end ? end : end - tau, radius = Math.hypot(a![0] - x, a![1] - y);
  if (radius > 10_000) fail("arc radius exceeds the viewing limit.");
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 48)));
  return Array.from({ length: steps + 1 }, (_, i) => [x + radius * Math.cos(start + sweep * i / steps), y + radius * Math.sin(start + sweep * i / steps)]);
}
function graphic(n: Node): Point[] {
  const kind = string(n[0]).replace(/^(?:gr|fp)_/u, "");
  if (kind === "line") return [point(child(n, "start")), point(child(n, "end"))];
  if (kind === "arc") return arc(n);
  if (kind === "rect") { const a = point(child(n, "start")), b = point(child(n, "end")); return [a, [b[0], a[1]], b, [a[0], b[1]], a]; }
  if (kind === "circle") { const c = point(child(n, "center")), end = point(child(n, "end")), ring = circle(...c, Math.hypot(end[0] - c[0], end[1] - c[1])); return [...ring, ring[0]!]; }
  if (kind === "poly") { const pts = nodes(child(n, "pts"), "xy").map(point); if (pts.length < 3) fail("polygon needs at least three vertices."); return [...pts, pts[0]!]; }
  return fail("uses unsupported outline geometry. Export STEP or GLB from KiCad instead.");
}
function outlines(root: Node): Point[][] {
  const edges = root.filter((n): n is Node => Array.isArray(n) && layer(n) === "Edge.Cuts");
  if (!edges.length || edges.length > 1500) fail("needs a closed Edge.Cuts outline within 1,500 edges.");
  if (nodes(root, "footprint").some(f => f.some(n => Array.isArray(n) && layer(n) === "Edge.Cuts"))) fail("footprint-local Edge.Cuts are unsupported; export STEP or GLB.");
  const remaining = edges.map(graphic), loops: Point[][] = [];
  while (remaining.length) {
    const loop = remaining.shift()!;
    while (!equal(loop[0]!, loop.at(-1)!)) {
      const matches = remaining.map((e, i) => equal(e[0]!, loop.at(-1)!) || equal(e.at(-1)!, loop.at(-1)!) ? i : -1).filter(i => i >= 0);
      if (matches.length !== 1) fail("Edge.Cuts must form unambiguous closed contours; repair gaps or branches in KiCad.");
      const next = remaining.splice(matches[0]!, 1)[0]!; if (!equal(next[0]!, loop.at(-1)!)) next.reverse(); loop.push(...next.slice(1));
      if (loop.length > 5000) fail("outline exceeds 5,000 vertices.");
    }
    loop.pop(); if (loop.length < 3) fail("outline is degenerate."); loops.push(loop);
  }
  return loops;
}
const area = (p: Point[]) => Math.abs(p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]!; return sum + a[0] * b[1] - b[0] * a[1]; }, 0) / 2);
function contains(p: Point[], v: Point) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const a = p[i]!, b = p[j]!; if ((a[1] > v[1]) !== (b[1] > v[1]) && v[0] < (b[0] - a[0]) * (v[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; }
  return inside;
}
// Fail closed before triangulation: Earcut accepts some invalid polygons silently.
function validateContours(outer: Point[], cutouts: Point[][]) {
  let comparisons = 0;
  const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const between = (a: Point, b: Point, p: Point) => Math.abs(cross(a, b, p)) < 1e-8 && p[0] >= Math.min(a[0], b[0]) - 1e-8 && p[0] <= Math.max(a[0], b[0]) + 1e-8 && p[1] >= Math.min(a[1], b[1]) - 1e-8 && p[1] <= Math.max(a[1], b[1]) + 1e-8;
  const intersects = (a: Point, b: Point, c: Point, d: Point) => {
    if (++comparisons > 2_000_000) fail("contours exceed the intersection-check budget; simplify or export STEP/GLB.");
    return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0 || between(a, b, c) || between(a, b, d) || between(c, d, a) || between(c, d, b);
  };
  const contours = [outer, ...cutouts];
  for (const p of contours) {
    for (let i = 0; i < p.length; i++) {
      if (equal(p[i]!, p[(i + 1) % p.length]!)) fail("contour has a zero-length edge.");
      for (let j = i + 2; j < p.length; j++) { if (i === 0 && j === p.length - 1) continue; if (intersects(p[i]!, p[(i + 1) % p.length]!, p[j]!, p[(j + 1) % p.length]!)) fail("self-intersecting contours are unsupported; repair the source or export STEP/GLB."); }
    }
  }
  const bounds = contours.map(p => [Math.min(...p.map(v => v[0])), Math.min(...p.map(v => v[1])), Math.max(...p.map(v => v[0])), Math.max(...p.map(v => v[1]))]);
  for (let i = 0; i < contours.length; i++) for (let j = i + 1; j < contours.length; j++) {
    const a = contours[i]!, b = contours[j]!, ab = bounds[i]!, bb = bounds[j]!;
    if (ab[2]! < bb[0]! || bb[2]! < ab[0]! || ab[3]! < bb[1]! || bb[3]! < ab[1]!) continue;
    if (i > 0 && (contains(a, b[0]!) || contains(b, a[0]!))) fail("nested or overlapping cutouts/drills are unsupported; export STEP/GLB.");
    for (let ai = 0; ai < a.length; ai++) for (let bi = 0; bi < b.length; bi++) if (intersects(a[ai]!, a[(ai + 1) % a.length]!, b[bi]!, b[(bi + 1) % b.length]!)) fail("intersecting or touching contours are unsupported; export STEP/GLB.");
  }
}
function transform(p: Point, at: Point, angle: number): Point { const a = angle * Math.PI / 180; return [at[0] + p[0] * Math.cos(a) + p[1] * Math.sin(a), at[1] - p[0] * Math.sin(a) + p[1] * Math.cos(a)]; }
function rounded(width: number, height: number, radius: number): Point[] {
  if (width <= 0 || height <= 0 || radius < 0 || radius > Math.min(width, height) / 2 + 1e-8) fail("pad dimensions are invalid.");
  if (!radius) return [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]];
  const points: Point[] = [];
  for (let corner = 0; corner < 4; corner++) {
    const angle = corner * Math.PI / 2, x = (corner === 0 || corner === 3 ? 1 : -1) * (width / 2 - radius), y = (corner < 2 ? 1 : -1) * (height / 2 - radius);
    for (let i = 0; i <= 12; i++) points.push([x + radius * Math.cos(angle + i * Math.PI / 24), y + radius * Math.sin(angle + i * Math.PI / 24)]);
  }
  const unique = points.filter((p, i) => i === 0 || !equal(p, points[i - 1]!));
  if (unique.length > 1 && equal(unique[0]!, unique.at(-1)!)) unique.pop();
  return unique;
}
export function parsePcbFile(bytes: Uint8Array): { meshes: AssemblyMesh[]; warnings: string[] } {
  if (bytes.byteLength > 20 * 1024 * 1024) fail("source exceeds 20 MB.");
  const root = read(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const version = string(child(root, "version")[1]);
  if (!/^\d{8}$/u.test(version) || Number(version) < 20210101 || Number(version) > 20260206 || nodes(root, "module").length) fail("unsupported KiCad version or legacy module footprints; resave in KiCad 6–10 or export STEP/GLB.");
  const thickness = num(child(child(root, "general"), "thickness")[1]);
  if (thickness <= 0 || thickness > 20) fail("must declare a board thickness between 0 and 20 mm.");
  const warnings = new Set<string>(["KiCad dimensions are millimetres. Board X/Y map to viewer X/−Y, with front copper at +Z. Colours and thin surface offsets are illustrative.", "Component bodies and external 3D model paths are not loaded. Footprint outlines and pads are source geometry, not exact component bodies. Export a self-contained STEP or GLB from KiCad for detailed bodies.", "Silkscreen text, solder mask, paste and internal copper are not rendered. This read-only view does not run DRC or establish electrical or manufacturing safety."]);
  const loops = outlines(root).sort((a, b) => area(b) - area(a)), outer = loops[0]!, holes = loops.slice(1);
  validateContours(outer, holes);
  if (area(outer) < 0.01 || holes.some(h => h.some(p => !contains(outer, p)))) fail("supports one board outline with internal cutouts; use STEP or GLB for multiple boards.");
  const meshes: AssemblyMesh[] = []; let triangles = 0, features = 0;
  function mesh(id: string, name: string, color: string, pcb: PcbGeometryInfo): AssemblyMesh {
    if (meshes.length >= 300) fail("exceeds 300 identifiable parts.");
    const m: AssemblyMesh = { nodeId: id, name: name.slice(0, 160), group: pcb.kind === "board" ? "Board" : pcb.kind === "copper" ? "Copper" : "Footprints (outlines only)", color, positions: [], indices: [], pcb }; meshes.push(m); return m;
  }
  const pendingCopper: { mesh: AssemblyMesh; polygon: Point[]; z: number; depth: number }[] = [];
  function emitSolid(m: AssemblyMesh, polygon: Point[], z: number, depth = 0.025, cutouts: Point[][] = []) {
    if (++features > 10_000 || polygon.length > 5000 || cutouts.length > 1000) fail("exceeds the supported geometry budget.");
    const vectors = (p: Point[]) => p.map(([x, y]) => new Vector2(x, -y));
    const shape = new Shape(vectors(polygon)); shape.holes = cutouts.map(h => new Path(vectors(h)));
    const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: 12 });
    try {
      const pos = g.getAttribute("position"); triangles += pos.count / 3;
      if (triangles > 250_000) fail("exceeds 250,000 triangles; export a simpler board.");
      const offset = m.positions.length / 3;
      for (let i = 0; i < pos.count; i++) { m.positions.push(pos.getX(i), pos.getY(i), pos.getZ(i) + z); m.indices.push(offset + i); }
    } finally { g.dispose(); }
  }
  function solid(m: AssemblyMesh, polygon: Point[], z: number, depth = 0.025, cutouts: Point[][] = []) {
    if (m.pcb?.kind === "copper") { if (pendingCopper.length >= 10_000) fail("exceeds the supported copper budget."); pendingCopper.push({ mesh: m, polygon, z, depth }); }
    else emitSolid(m, polygon, z, depth, cutouts);
  }
  function stroke(m: AssemblyMesh, points: Point[], width: number, z: number) {
    if (width <= 0 || width > 100) fail("line width is invalid.");
    for (let i = 1; i < points.length; i++) { const a = points[i - 1]!, b = points[i]!, length = Math.hypot(b[0] - a[0], b[1] - a[1]); if (length < 1e-8) continue; const polygon = rounded(length + width, width, width / 2).map(p => transform(p, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], -Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI)); solid(m, polygon, z); }
  }
  const board = mesh("pcb-board", "Board substrate", "#247955", { kind: "board", side: "both", thicknessMm: thickness, holeCount: 0 });
  const copper = new Map<string, AssemblyMesh>();
  function copperLayer(side: "top" | "bottom") { let m = copper.get(side); if (!m) { m = mesh(`pcb-copper-${side}`, `${side === "top" ? "Front" : "Back"} copper tracks`, "#c89d50", { kind: "copper", side }); copper.set(side, m); } return m; }
  const zFor = (side: "top" | "bottom") => side === "top" ? thickness + 0.015 : -0.04;
  const drillHoles: Point[][] = [];
  function addHole(p: Point[]) { if (drillHoles.length >= 1000) fail("exceeds 1,000 drill openings."); if (p.some(v => !contains(outer, v)) || holes.some(h => p.some(v => contains(h, v)))) fail("edge-intersecting drills are unsupported; use a STEP or GLB export."); drillHoles.push(p); }
  const footprints = nodes(root, "footprint");
  for (let fi = 0; fi < footprints.length; fi++) {
    const f = footprints[fi]!, origin = point(child(f, "at")), angle = num(child(f, "at")[3], 0), side = layer(f) === "B.Cu" ? "bottom" : "top";
    const property = (key: string, legacy: string) => label(nodes(f, "property").find(p => p[1] === key)?.[2] ?? nodes(f, "fp_text").find(p => p[1] === legacy)?.[2]);
    const reference = property("Reference", "reference") || `Footprint ${fi + 1}`, value = property("Value", "value"), footprint = label(f[1]);
    const info = { reference, value, footprint, modelStatus: nodes(f, "model").length ? "external_ignored" as const : "missing" as const };
    if (nodes(f, "model").length) warnings.add("External component model references were ignored; no local paths, environment variables or URLs were resolved.");
    const drawing = f.filter((n): n is Node => Array.isArray(n) && /^fp_(line|rect|circle|arc|poly)$/u.test(string(n[0])) && /\.(Fab|CrtYd|SilkS)$/u.test(layer(n)));
    const preferred = drawing.some(n => layer(n).endsWith(".Fab")) ? drawing.filter(n => layer(n).endsWith(".Fab")) : drawing.some(n => layer(n).endsWith(".CrtYd")) ? drawing.filter(n => layer(n).endsWith(".CrtYd")) : drawing;
    if (preferred.length) {
      const m = mesh(`pcb-footprint-${fi}`, `${reference} · footprint outline`, "#e4dca8", { kind: "footprint", side, ...info });
      for (const n of preferred) stroke(m, graphic(n).map(p => transform(p, origin, angle)), num(child(child(n, "stroke"), "width")[1] ?? child(n, "width")[1], 0.15) || 0.15, side === "top" ? thickness + 0.06 : -0.085);
    } else warnings.add("Some footprints have no supported outline; only their supported pads can be selected.");
    const padMeshes = new Map<string, AssemblyMesh>();
    for (const p of nodes(f, "pad")) {
      const at = child(p, "at"), centre = transform(point(at), origin, angle), padAngle = num(at[3], 0);
      const size = point(child(p, "size")), kind = string(p[3]), drill = child(p, "drill");
      let opening: Point[] | undefined;
      if (drill.length) {
        const oval = drill[1] === "oval", w = num(drill[oval ? 2 : 1]), h = oval ? num(drill[3]) : w;
        const offset = child(drill, "offset"); if (offset.length && (num(offset[1]) !== 0 || num(offset[2]) !== 0)) fail("offset drills are unsupported; export STEP or GLB.");
        opening = rounded(w, h, Math.min(w, h) / 2).map(v => transform(v, centre, padAngle)); addHole(opening);
      }
      if (p[2] === "np_thru_hole") continue;
      if (child(p, "remove_unused_layers")[1] === "yes") warnings.add("Pad copper uses declared outer layers; removal of unconnected pad layers is not recalculated. Use a KiCad export for the final copper result.");
      if (!["circle", "rect", "oval", "roundrect"].includes(kind)) { warnings.add("Unsupported custom, trapezoid or chamfered pads are omitted. Export STEP or GLB to see their exact shape."); continue; }
      if (child(p, "chamfer_ratio").length) { warnings.add("Chamfered pad copper is omitted; drill openings are retained."); continue; }
      if (kind === "circle" && size[0] !== size[1]) fail("circular pad has unequal diameters.");
      const radius = kind === "circle" || kind === "oval" ? Math.min(...size) / 2 : kind === "roundrect" ? Math.min(...size) * num(child(p, "roundrect_rratio")[1]) : 0;
      const polygon = rounded(...size, radius).map(v => transform(v, centre, padAngle));
      if (opening && opening.some(v => !contains(polygon, v))) fail("drill is not contained by its copper pad; use STEP/GLB.");
      const layers = child(p, "layers").slice(1);
      for (const padSide of ["top", "bottom"] as const) if (layers.includes("*.Cu") || layers.includes(padSide === "top" ? "F.Cu" : "B.Cu")) {
        let m = padMeshes.get(padSide); if (!m) { m = mesh(`pcb-pads-${fi}-${padSide}`, `${reference} · ${padSide === "top" ? "front" : "back"} pads`, "#cfaa65", { kind: "copper", side: padSide, ...info }); padMeshes.set(padSide, m); }
        solid(m, polygon, zFor(padSide), 0.025, opening ? [opening] : []);
      }
    }
  }
  for (const n of [...nodes(root, "segment"), ...nodes(root, "arc")]) {
    const l = layer(n); if (l !== "F.Cu" && l !== "B.Cu") { warnings.add("Internal copper tracks are omitted."); continue; }
    const side = l === "F.Cu" ? "top" : "bottom";
    stroke(copperLayer(side), n[0] === "arc" ? arc(n) : [point(child(n, "start")), point(child(n, "end"))], num(child(n, "width")[1]), zFor(side));
  }
  for (const v of nodes(root, "via")) {
    if (v.includes("blind") || v.includes("micro")) { warnings.add("Blind and micro vias are omitted; export STEP or GLB for exact geometry."); continue; }
    const at = point(child(v, "at")), radius = num(child(v, "size")[1]) / 2, drillRadius = num(child(v, "drill")[1]) / 2;
    if (drillRadius >= radius) fail("via drill must fit inside its copper pad.");
    const drill = circle(...at, drillRadius); addHole(drill);
    for (const side of ["top", "bottom"] as const) solid(copperLayer(side), circle(...at, radius), zFor(side), 0.025, [drill]);
  }
  // Zone outlines are NOT filled copper: their unfilled shape can cross pads/clearances.
  if (nodes(root, "zone").length) warnings.add("Copper zones are omitted, including stored fills. Export STEP or GLB from KiCad to include authoritative filled zones.");
  if (root.some(n => Array.isArray(n) && /^gr_/u.test(string(n[0])) && /\.Cu$/u.test(layer(n)))) warnings.add("Copper graphical items are omitted; export STEP or GLB for complete copper.");
  validateContours(outer, [...holes, ...drillHoles]);
  const bbox = (p: Point[]) => [Math.min(...p.map(v => v[0])), Math.min(...p.map(v => v[1])), Math.max(...p.map(v => v[0])), Math.max(...p.map(v => v[1]))];
  const holeBounds = drillHoles.map(bbox);
  for (const pending of pendingCopper) {
    const b = bbox(pending.polygon), relevant = drillHoles.filter((_, i) => { const h = holeBounds[i]!; return b[0]! <= h[2]! && b[2]! >= h[0]! && b[1]! <= h[3]! && b[3]! >= h[1]!; });
    const clipped = polygonClipping.intersection([pending.polygon], [outer, ...holes]);
    const polygons = relevant.length ? polygonClipping.difference(clipped, ...relevant.map(h => [h])) : clipped;
    for (const polygon of polygons) emitSolid(pending.mesh, polygon[0]!.slice(0,-1), pending.z, pending.depth, polygon.slice(1).map(r => r.slice(0,-1)));
  }
  board.pcb!.holeCount = drillHoles.length;
  solid(board, outer, 0, thickness, [...holes, ...drillHoles]);
  return { meshes: meshes.filter(m => m.indices.length), warnings: [...warnings] };
}
