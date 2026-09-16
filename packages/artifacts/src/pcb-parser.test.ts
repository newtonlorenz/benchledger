import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseAssemblyFile } from "./assembly-parser.js";
import { parsePcbFile } from "./pcb-parser.js";
const fixture = await readFile(new URL("../testfiles/synthetic-board.kicad_pcb", import.meta.url), "utf8");
const parse = (text: string) => parsePcbFile(new TextEncoder().encode(text));
const wrap = (body: string) => `(kicad_pcb (version 20240108) (general (thickness 1.6)) ${body})`;
const rect = '(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))';
const bounds = (p: number[]) => [0, 1, 2].map(i => { const axis = p.filter((_, k) => k % 3 === i); return [Math.min(...axis), Math.max(...axis)]; });
describe("native KiCad viewing geometry", () => {
  it("preserves thickness, holes, copper sides, footprint identity and global pad angles without resolving models", async () => {
    const result = await parseAssemblyFile(new TextEncoder().encode(fixture), "synthetic.kicad_pcb", "metre", "y");
    const board = result.meshes.find(m => m.pcb?.kind === "board")!;
    expect(bounds(board.positions)).toEqual([[0, 36], [-24, 0], [0, expect.closeTo(1.6)]]); expect(board.pcb?.holeCount).toBe(5);
    const bottom = result.meshes.find(m => m.nodeId === "pcb-copper-bottom")!; expect(bounds(bottom.positions)[2]![1]).toBeLessThan(0);
    const pads = result.meshes.find(m => m.nodeId === "pcb-pads-1-top")!;
    expect(pads.pcb).toMatchObject({ reference: "J1", value: "Power", footprint: "Synthetic:Connector", modelStatus: "external_ignored" });
    expect(bounds(pads.positions)[0]![0]).toBeCloseTo(25.4); expect(bounds(pads.positions)[0]![1]).toBeCloseTo(32.2);
    expect(result.warnings.join()).toMatch(/External component model references were ignored/); expect(result.warnings.join()).not.toContain("SYNTHETIC_MODELS");
    // A front-face triangle must never cover the centre of a source drill.
    const topTriangles = Array.from({ length: board.indices.length / 3 }, (_, i) => board.indices.slice(i * 3, i * 3 + 3).map(k => board.positions.slice(k * 3, k * 3 + 3))).filter(t => t.every(p => Math.abs(p[2]! - 1.6) < 1e-5));
    const inside = (t: number[][], p: number[]) => { const signs = t.map((a, i) => { const b = t[(i + 1) % 3]!; return (b[0]! - a[0]!) * (p[1]! - a[1]!) - (b[1]! - a[1]!) * (p[0]! - a[0]!); }); return signs.every(s => s >= 0) || signs.every(s => s <= 0); };
    expect(topTriangles.some(t => inside(t, [9, -9]))).toBe(false);
    for (const copper of result.meshes.filter(m => m.pcb?.kind === "copper")) {
      const faces = Array.from({length:copper.indices.length/3},(_,i)=>copper.indices.slice(i*3,i*3+3).map(k=>copper.positions.slice(k*3,k*3+3))).filter(t=>t.every(p=>Math.abs(p[2]!-t[0]![2]!)<1e-6));
      expect(faces.some(t => inside(t, [9,-9])), `${copper.name} covers a drill opening`).toBe(false);
    }
  });
  it("supports shuffled outline edges, arcs, circles and internal cutouts", () => {
    const shape = '(gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts")) (gr_arc (start 20 0) (mid 30 10) (end 20 20) (layer "Edge.Cuts")) (gr_line (start 0 20) (end 20 20) (layer "Edge.Cuts")) (gr_line (start 0 0) (end 0 20) (layer "Edge.Cuts")) (gr_circle (center 10 10) (end 12 10) (layer "Edge.Cuts"))';
    expect(bounds(parse(wrap(shape)).meshes[0]!.positions)[0]).toEqual([0, 30]);
  });
  it("reports omitted zones, inner tracks, custom pads and missing outlines without inventing their geometry", () => {
    const text = fixture.replace('(via (at 20 20)', '(zone (layer "F.Cu")) (segment (start 2 2) (end 3 3) (width 0.3) (layer "In1.Cu")) (footprint "Synthetic:Unknown" (layer "F.Cu") (at 22 5) (pad "1" smd custom (at 0 0) (size 2 2) (layers "F.Cu"))) (via (at 20 20)');
    expect(parse(text).warnings.join()).toMatch(/zones are omitted/); expect(parse(text).warnings.join()).toMatch(/Internal copper tracks/); expect(parse(text).warnings.join()).toMatch(/Unsupported custom/);
  });
  it.each([
    [wrap('(gr_poly (pts (xy 0 0) (xy 20 20) (xy 0 15) (xy 20 0)) (layer "Edge.Cuts"))'), /self-intersecting/],
    [wrap(rect + '(gr_rect (start 4 4) (end 10 10) (layer "Edge.Cuts")) (gr_rect (start 6 6) (end 8 8) (layer "Edge.Cuts"))'), /nested|overlapping/],
    [wrap(rect + '(gr_rect (start 4 4) (end 12 8) (layer "Edge.Cuts")) (gr_rect (start 8 2) (end 10 10) (layer "Edge.Cuts"))'), /intersecting/],
    [fixture.replace('(at 20 20)', '(at 9 9)'), /nested|overlapping/],
    [wrap('(gr_line (start 0 0) (end 10 0) (layer "Edge.Cuts"))'), /closed contours/],
    [wrap(rect + '(gr_rect (start 50 50) (end 60 60) (layer "Edge.Cuts"))'), /one board/],
    [wrap('(gr_curve (layer "Edge.Cuts"))'), /unsupported outline/],
    [fixture.replace('(drill 0.9)', '(drill 0.9 (offset 0.1 0))'), /offset drills/],
    [fixture.replace('(at 20 20)', '(at 0 0)'), /edge-intersecting/],
    [fixture.replace('(thickness 1.6)', '(thickness NaN)'), /numeric/],
    [fixture.replace('(thickness 1.6)', '(thickness 0)'), /thickness/],
    [fixture + '(evil "ignored")', /one complete/],
    [fixture.slice(0, -2), /unclosed/],
    [fixture.replace("(version 20240108)", "(version 20171130)"), /unsupported KiCad version/],
    [fixture.replace("(footprint", "(module"), /legacy module/],
    [wrap('('.repeat(50) + ')'.repeat(50)), /nesting/],
    [wrap('("' + 'x'.repeat(4100) + '")'), /oversized/]
  ])("rejects unsupported or ambiguous input %#", (text, message) => { expect(() => parse(text as string)).toThrow(message as RegExp); });
});
