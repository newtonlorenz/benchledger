import sharp from "sharp";
/** Decode only bounded raster input, orient it, and discard all embedded metadata. */
export async function normalizeInventoryImage(bytes: Uint8Array, mediaType: string) {
  const input = Buffer.from(bytes);
  if (input.length === 0 || input.length > 2 * 1024 * 1024) throw new Error("Image must be at most 2 MiB.");
  const format = input.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png"
    : input[0] === 255 && input[1] === 216 && input[2] === 255 ? "jpeg"
    : input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WEBP" ? "webp" : undefined;
  if (!format || mediaType !== `image/${format}`) throw new Error("Choose a valid PNG, JPEG or WebP image matching its media type.");
  const image = sharp(input, { limitInputPixels: 16_000_000, failOn: "warning" });
  const metadata = await image.metadata();
  if ((metadata.pages ?? 1) !== 1) throw new Error("Choose a still image.");
  const output = await image.rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
  if (output.data.length > 512 * 1024) throw new Error("Image is too complex; resize it before uploading.");
  return { bytes: new Uint8Array(output.data), width: output.info.width, height: output.info.height };
}
