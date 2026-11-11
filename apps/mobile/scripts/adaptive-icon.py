#!/usr/bin/env python3
"""Derive the Android adaptive-icon foreground from the existing app icon.

The source icon (assets/icon.png, from assets/icon.svg) is white bars on the
brand orange #aa3e0d. Android draws the adaptive background colour itself and
masks the foreground to a circle, squircle or square, keeping only the central
66/108 safe zone. This script keys out the orange (recovering antialiased edge
alpha exactly), scales the bars into that safe zone and pads them onto a
transparent canvas. No new artwork is introduced. Standard library only.

    python3 apps/mobile/scripts/adaptive-icon.py apps/mobile/assets/icon.png apps/mobile/assets/adaptive-icon.png
"""
import struct
import sys
import zlib

BACKGROUND_G = 0x3E  # green channel of #aa3e0d; white bars are 255
SCALE = 0.72  # bar diagonal ~0.80 of the icon -> ~0.58, inside the 0.61 safe circle


def read_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("not a PNG")
    pos, idat, header = 8, b"", None
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    width, height, depth, colour, _, _, interlace = header
    if depth != 8 or colour not in (2, 6) or interlace:
        raise SystemExit("expected a non-interlaced 8-bit RGB/RGBA PNG")
    channels = 4 if colour == 6 else 3
    raw, stride = zlib.decompress(idat), width * channels
    rows, previous, offset = [], bytearray(stride), 0
    for _ in range(height):
        kind, line = raw[offset], bytearray(raw[offset + 1:offset + 1 + stride])
        offset += 1 + stride
        for i in range(stride):
            left = line[i - channels] if i >= channels else 0
            up, corner = previous[i], previous[i - channels] if i >= channels else 0
            if kind == 1:
                line[i] = (line[i] + left) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + up) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif kind == 4:
                p = left + up - corner
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - corner)
                line[i] = (line[i] + (left if pa <= pb and pa <= pc else up if pb <= pc else corner)) & 0xFF
        rows.append(line)
        previous = line
    return width, height, channels, rows


def write_png(path, width, height, pixels):
    raw = b"".join(b"\x00" + bytes(pixels[y * width * 4:(y + 1) * width * 4]) for y in range(height))
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)


def main(source, target):
    width, height, channels, rows = read_png(source)
    # Coverage of white over orange, from the green channel.
    alpha = [[max(0.0, min(1.0, (row[x * channels + 1] - BACKGROUND_G) / (255 - BACKGROUND_G))) for x in range(width)] for row in rows]
    out = bytearray(width * height * 4)
    cx, cy = (width - 1) / 2, (height - 1) / 2
    for y in range(height):
        sy = cy + (y - cy) / SCALE
        for x in range(width):
            sx = cx + (x - cx) / SCALE
            x0, y0 = int(sx), int(sy)
            if sx < 0 or sy < 0 or x0 >= width - 1 or y0 >= height - 1:
                continue
            fx, fy = sx - x0, sy - y0
            a = (alpha[y0][x0] * (1 - fx) * (1 - fy) + alpha[y0][x0 + 1] * fx * (1 - fy)
                 + alpha[y0 + 1][x0] * (1 - fx) * fy + alpha[y0 + 1][x0 + 1] * fx * fy)
            i = (y * width + x) * 4
            out[i:i + 4] = bytes((255, 255, 255, round(a * 255)))
    write_png(target, width, height, out)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
