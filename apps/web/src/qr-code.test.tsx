// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { encodeQr, qrSvgPath, type QrMatrix } from "./qr-code";
import { ItemLabelCard, PrintItemLabel, itemLabelPayload } from "./item-label";

afterEach(cleanup);

// Reference matrices produced by an independent QR encoder (error correction M).
const HELLO_MASK_0 = ["#######..##...#######","#.....#.##....#.....#","#.###.#..#.##.#.###.#","#.###.#...##..#.###.#","#.###.#.##..#.#.###.#","#.....#.....#.#.....#","#######.#.#.#.#######","..........###........","#.#.#.#..#.#....#..#.","..#.##....#...#....##",".#.#..#.###.#...#####","##..#.........#....#.",".##.#.##..#.#.#.#....","........####.#.#..###","#######...##.###..###","#.....#...####.##....","#.###.#.#.##.###...##","#.###.#..#....##..##.","#.###.#.###.#...#.#.#","#.....#..#....#.#..#.","#######.###.#.##...##"];
const PRINTER_LABEL_MASK_2 = ["#######..#######.####.#######","#.....#......#####..#.#.....#","#.###.#.#.####.#..#...#.###.#","#.###.#.#..##.##.#.#..#.###.#","#.###.#.#.#.#..##..##.#.###.#","#.....#.#.............#.....#","#######.#.#.#.#.#.#.#.#######","........#####.#.#.##.........","#.#####...#.#...##..#.#####..","###.##..###..###..#####.#..##","..##.###.###.####.....#..##..","#.#......##.##.#......#..#.##",".###..##..#...##.#..##.#..#.#",".##.##.#.......##..####.#.###",".#..###...#......##.#.#......","#..#.#.#..###.#.#.###.#.##...","....#.##.##.....####...#..#..","#.##....##..####.###.########","#...####.#.#.####...#####....","#.####...##.##.#....#..###.##","#.#####.......##.#.######.##.","........#......####.#...##.##","#######...#.#.....###.#.##...","#.....#.#####.#.#.###...##.##","#.###.#.##..#....##.#####.#.#","#.###.#.###.#.##...#.....#...","#.###.#.##.##.##.###..###..#.","#.....#...##...##.#.#..#.#.#.","#######.##.#.#.#.#.#.#.##.#.."];

const rows = (matrix: QrMatrix) => matrix.modules.map((row) => row.map((dark) => dark ? "#" : ".").join(""));

/** Independent read-back: format bits, unmasking, zigzag order, RS syndromes, payload. */
function decode(matrix: QrMatrix): string {
  const size = matrix.size;
  const dark = (x: number, y: number) => matrix.modules[y]![x]!;
  let format = 0;
  for (let i = 0; i <= 5; i += 1) format |= (dark(8, i) ? 1 : 0) << i;
  format |= (dark(8, 7) ? 1 : 0) << 6; format |= (dark(8, 8) ? 1 : 0) << 7; format |= (dark(7, 8) ? 1 : 0) << 8;
  for (let i = 9; i < 15; i += 1) format |= (dark(14 - i, 8) ? 1 : 0) << i;
  const data = (format ^ 0x5412) >>> 10;
  expect(data >>> 3).toBe(0); // level M
  const mask = data & 7;
  expect(mask).toBe(matrix.mask);
  // Recompute the function-pattern map independently and read data modules.
  const isFunction = (x: number, y: number): boolean => {
    if ((x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8)) return true;
    if (x === 6 || y === 6) return true;
    if (matrix.version >= 7 && ((x >= size - 11 && x < size - 8 && y < 6) || (y >= size - 11 && y < size - 8 && x < 6))) return true;
    const positions = matrix.version === 1 ? [] : (() => { const n = Math.floor(matrix.version / 7) + 2; const step = Math.ceil((matrix.version * 4 + 4) / (n * 2 - 2)) * 2; const r = [6]; for (let p = matrix.version * 4 + 10; r.length < n; p -= step) r.splice(1, 0, p); return r; })();
    for (const ax of positions) for (const ay of positions) {
      const corner = (ax === 6 && ay === 6) || (ax === 6 && ay === positions.at(-1)) || (ax === positions.at(-1) && ay === 6);
      if (!corner && Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2) return true;
    }
    return false;
  };
  const masked = (x: number, y: number) => [ (x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, ((x * y) % 2) + ((x * y) % 3) === 0, (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0 ][mask]!;
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v += 1) for (let j = 0; j < 2; j += 1) {
      const x = right - j; const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
      if (!isFunction(x, y)) bits.push((dark(x, y) !== masked(x, y)) ? 1 : 0);
    }
  }
  // Single-block versions only (1-3): data codewords precede EC codewords.
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const mul = (a: number, b: number) => { let z = 0; for (let i = 7; i >= 0; i -= 1) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((b >>> i) & 1) * a; } return z & 0xff; };
  for (let k = 0, alpha = 1; k < 4; k += 1, alpha = mul(alpha, 2)) expect(bytes.reduce((s, c) => mul(s, alpha) ^ c, 0)).toBe(0);
  const stream = bytes.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >>> i) & 1));
  const read = (offset: number, length: number) => stream.slice(offset, offset + length).reduce((a, b) => (a << 1) | b, 0);
  expect(read(0, 4)).toBe(4);
  const length = read(4, 8);
  return new TextDecoder().decode(new Uint8Array(Array.from({ length }, (_, i) => read(12 + i * 8, 8))));
}

describe("QR encoder", () => {
  it("matches an independent encoder bit for bit", () => {
    expect(rows(encodeQr("hello", { mask: 0 }))).toEqual(HELLO_MASK_0);
    expect(rows(encodeQr("benchledger://item/printer-h2d", { mask: 2 }))).toEqual(PRINTER_LABEL_MASK_2);
  });

  it("round-trips through an independent read-back with valid Reed-Solomon codewords", () => {
    for (const text of ["hello", "benchledger://item/printer-h2d", "benchledger://item/board-esp32"]) {
      const matrix = encodeQr(text);
      expect(matrix.version).toBeLessThanOrEqual(3);
      expect(decode(matrix)).toBe(text);
    }
  });

  it("fits the longest documented item id and refuses longer payloads", () => {
    const longest = encodeQr(itemLabelPayload("a".repeat(160)));
    expect(longest.version).toBe(9);
    expect(longest.size).toBe(53);
    expect(() => encodeQr("x".repeat(400))).toThrow(/too long/u);
    expect(() => itemLabelPayload("bad id")).toThrow(RangeError);
    expect(qrSvgPath(encodeQr("hello"))).toMatch(/^M4 4h1v1h-1z/u);
  });
});

describe("item label", () => {
  it("renders the QR and readable details", () => {
    render(<ItemLabelCard item={{ id: "printer-h2d", name: "Bambu Lab H2D", variant: "H2D", location: "Bench" }} />);
    expect(screen.getByRole("img", { name: "QR code for Bambu Lab H2D" })).toBeTruthy();
    expect(screen.getByText("Bench")).toBeTruthy();
  });

  it("previews and prints through the browser print dialog", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    render(<PrintItemLabel item={{ id: "board-esp32", name: "ESP32 development board", location: "Unassigned" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Print label" }));
    expect(screen.getByText(/holds only the item ID/u)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Print" })); });
    expect(print).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains("printing-label")).toBe(true);
    expect(document.querySelector(".print-label-root svg")).not.toBeNull();
    await act(async () => { window.dispatchEvent(new Event("afterprint")); });
    expect(document.body.classList.contains("printing-label")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.getByRole("button", { name: "Print label" })).toBeTruthy();
    print.mockRestore();
  });

  it("does not offer a label for an id the scanner cannot accept", () => {
    const { container } = render(<PrintItemLabel item={{ id: "bad id", name: "Legacy" }} />);
    expect(container.innerHTML).toBe("");
  });
});
