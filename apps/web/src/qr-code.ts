/**
 * Minimal QR Code encoder (ISO/IEC 18004) for item labels.
 *
 * Byte mode, error-correction level M, versions 1-10 (up to 213 bytes, which
 * covers `benchledger://item/<id>` for any 160-character id). The structure
 * follows the public-domain reference algorithm by Project Nayuki: data and
 * Reed-Solomon codewords are interleaved per block, function patterns are
 * drawn, codewords are placed in the standard zigzag, and the mask with the
 * lowest standard penalty is chosen. No dependency, no DOM, no inline script.
 */

const ECC_CODEWORDS_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26] as const;
const NUM_ERROR_CORRECTION_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] as const;
const MAX_VERSION = 10;
const FORMAT_ECL_BITS_M = 0;
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** Square module matrix; `modules[y][x]` is true for a dark module. */
export interface QrMatrix {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  readonly modules: readonly (readonly boolean[])[];
}

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version: number): number {
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK_M[version]! * NUM_ERROR_CORRECTION_BLOCKS_M[version]!;
}

function alignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let position = version * 4 + 10; result.length < numAlign; position -= step) result.splice(1, 0, position);
  return result;
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, index) => { result[index] = result[index]! ^ gfMultiply(coefficient, factor); });
  }
  return result;
}

function addEccAndInterleave(data: readonly number[], version: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[version]!;
  const blockEccLength = ECC_CODEWORDS_PER_BLOCK_M[version]!;
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLength = Math.floor(rawCodewords / numBlocks);
  const divisor = reedSolomonDivisor(blockEccLength);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const dat = data.slice(k, k + shortBlockLength - blockEccLength + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = reedSolomonRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLength - blockEccLength || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

function encodeData(bytes: Uint8Array): { version: number; codewords: number[] } {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const countBits = version <= 9 ? 8 : 16;
    const capacityBits = numDataCodewords(version) * 8;
    const usedBits = 4 + countBits + bytes.length * 8;
    if (usedBits > capacityBits) continue;
    const bits: number[] = [];
    const append = (value: number, length: number) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
    append(0x4, 4);
    append(bytes.length, countBits);
    for (const byte of bytes) append(byte, 8);
    append(0, Math.min(4, capacityBits - bits.length));
    append(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);
    const codewords: number[] = [];
    for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
    return { version, codewords: addEccAndInterleave(codewords, version) };
  }
  throw new RangeError("QR payload is too long for a label");
}

class Grid {
  readonly version: number;
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i += 1) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const positions = alignmentPatternPositions(this.version);
    const last = positions.length - 1;
    positions.forEach((x, i) => positions.forEach((y, j) => {
      if (!((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0))) this.drawAlignment(x, y);
    }));
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, distance !== 2 && distance !== 4);
      }
    }
  }

  drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  drawFormatBits(mask: number): void {
    const data = (FORMAT_ECL_BITS_M << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    for (let i = 0; i <= 5; i += 1) this.setFunction(8, i, getBit(bits, i));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i += 1) this.setFunction(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i += 1) this.setFunction(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i += 1) this.setFunction(8, this.size - 15 + i, getBit(bits, i));
    this.setFunction(8, this.size - 8, true);
  }

  drawVersion(): void {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const dark = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  drawCodewords(codewords: readonly number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (!this.isFunction[y]![x] && i < codewords.length * 8) {
            this.modules[y]![x] = getBit(codewords[i >>> 3]!, 7 - (i & 7));
            i += 1;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (!this.isFunction[y]![x] && invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  penalty(): number {
    let result = 0;
    const size = this.size;
    const lineScore = (get: (i: number) => boolean): number => {
      let score = 0;
      let runColor = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      const addHistory = (length: number) => {
        if (history[0] === 0) length += size;
        history.pop();
        history.unshift(length);
      };
      const countPatterns = (): number => {
        const n = history[1]!;
        const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
        return (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) + (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0);
      };
      for (let i = 0; i < size; i += 1) {
        if (get(i) === runColor) {
          runLength += 1;
          if (runLength === 5) score += PENALTY_N1;
          else if (runLength > 5) score += 1;
        } else {
          addHistory(runLength);
          if (!runColor) score += countPatterns() * PENALTY_N3;
          runColor = get(i);
          runLength = 1;
        }
      }
      // Terminate the run with light modules (the quiet zone).
      if (runColor) { addHistory(runLength); runLength = 0; }
      runLength += size;
      addHistory(runLength);
      score += countPatterns() * PENALTY_N3;
      return score;
    };
    for (let y = 0; y < size; y += 1) result += lineScore((x) => this.modules[y]![x]!);
    for (let x = 0; x < size; x += 1) result += lineScore((y) => this.modules[y]![x]!);
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = this.modules[y]![x];
        if (color === this.modules[y]![x + 1] && color === this.modules[y + 1]![x] && color === this.modules[y + 1]![x + 1]) result += PENALTY_N2;
      }
    }
    const dark = this.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }
}

/** Encode text (UTF-8) as a QR matrix with error-correction level M. */
export function encodeQr(text: string, options: { readonly mask?: number } = {}): QrMatrix {
  const { version, codewords } = encodeData(new TextEncoder().encode(text));
  const grid = new Grid(version);
  grid.drawFunctionPatterns();
  grid.drawCodewords(codewords);
  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    if (options.mask !== undefined && mask !== options.mask) continue;
    grid.applyMask(mask);
    grid.drawFormatBits(mask);
    const penalty = grid.penalty();
    if (penalty < bestPenalty) { bestMask = mask; bestPenalty = penalty; }
    grid.applyMask(mask);
  }
  grid.applyMask(bestMask);
  grid.drawFormatBits(bestMask);
  return { version, size: grid.size, mask: bestMask, modules: grid.modules.map((row) => [...row]) };
}

/**
 * SVG path data for the dark modules, offset by a quiet zone (default four
 * modules). Rendered as an <svg> element; no inline script or style needed.
 */
export function qrSvgPath(matrix: QrMatrix, quietZone = 4): string {
  const parts: string[] = [];
  matrix.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) parts.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`); }));
  return parts.join("");
}
