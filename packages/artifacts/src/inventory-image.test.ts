import sharp from "sharp";
import { expect, it } from "vitest";
import { normalizeInventoryImage } from "./inventory-image.js";
it("orients, resizes and strips metadata from real rasters", async () => {
  const input = await sharp({ create: { width: 1800, height: 900, channels: 3, background: "red" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await normalizeInventoryImage(input, "image/jpeg");
  expect(result).toMatchObject({ width: 640, height: 1280 });
  const metadata = await sharp(result.bytes).metadata();
  expect(metadata.format).toBe("webp"); expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined(); expect(metadata.orientation).toBeUndefined();
  const webp = await normalizeInventoryImage(result.bytes, "image/webp"); expect(webp.width).toBe(640);
});
it("rejects active formats, spoofed MIME, corrupt data and byte/pixel bombs", async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } }).png().toBuffer();
  await expect(normalizeInventoryImage(png, "image/jpeg")).rejects.toThrow();
  await expect(normalizeInventoryImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/png")).rejects.toThrow();
  await expect(normalizeInventoryImage(png.subarray(0, 20), "image/png")).rejects.toThrow();
  await expect(normalizeInventoryImage(new Uint8Array(2 * 1024 * 1024 + 1), "image/png")).rejects.toThrow();
  const huge = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "blue" } }).png().toBuffer();
  await expect(normalizeInventoryImage(huge, "image/png")).rejects.toThrow();
});
