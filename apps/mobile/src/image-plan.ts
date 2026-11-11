import { INVENTORY_IMAGE_MAX_BYTES } from "@benchledger/api-contract";

/**
 * Phone photos are often 12-48 megapixels and several megabytes. The server
 * accepts at most 2 MiB and 16 megapixels, then normalises to WebP, so the
 * app downscales and recompresses as JPEG before upload, trying smaller and
 * lower-quality versions until one fits. Re-encoding also drops EXIF/GPS data.
 */
export const UPLOAD_ATTEMPTS = [
  { maxEdge: 1600, quality: 0.8 },
  { maxEdge: 1280, quality: 0.7 },
  { maxEdge: 1024, quality: 0.6 },
  { maxEdge: 800, quality: 0.5 }
] as const;

/** The manipulator resize action, or undefined when the image already fits. */
export function resizeFor(width: number, height: number, maxEdge: number): { width: number } | { height: number } | undefined {
  if (Math.max(width, height) <= maxEdge) return undefined;
  return width >= height ? { width: maxEdge } : { height: maxEdge };
}
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}
export function fitsUpload(base64: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/u.test(base64) && base64.length % 4 === 0 && base64Bytes(base64) <= INVENTORY_IMAGE_MAX_BYTES;
}
export function photoFilename(at: Date): string {
  return `item-photo-${at.toISOString().slice(0, 19).replaceAll(":", "-")}Z.jpg`;
}
