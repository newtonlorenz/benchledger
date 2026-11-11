import { describe, expect, it } from "vitest";
import { INVENTORY_IMAGE_MAX_BYTES } from "@benchledger/api-contract";
import { UPLOAD_ATTEMPTS, base64Bytes, fitsUpload, photoFilename, resizeFor } from "./image-plan";

describe("photo downscale decisions", () => {
  it("shrinks the long edge to the attempt's limit, keeping the aspect ratio", () => {
    expect(resizeFor(4032, 3024, 1600)).toEqual({ width: 1600 });
    expect(resizeFor(3024, 4032, 1600)).toEqual({ height: 1600 });
  });
  it("leaves images that already fit unscaled", () => {
    expect(resizeFor(1200, 900, 1600)).toBeUndefined();
    expect(resizeFor(1600, 1600, 1600)).toBeUndefined();
  });
  it("steps down size and quality on each retry and then gives up", () => {
    expect(UPLOAD_ATTEMPTS[0]).toEqual({ maxEdge: 1600, quality: 0.8 });
    for (let index = 1; index < UPLOAD_ATTEMPTS.length; index++) {
      expect(UPLOAD_ATTEMPTS[index]!.maxEdge).toBeLessThanOrEqual(UPLOAD_ATTEMPTS[index - 1]!.maxEdge);
      expect(UPLOAD_ATTEMPTS[index]!.quality).toBeLessThan(UPLOAD_ATTEMPTS[index - 1]!.quality);
    }
    // The largest attempt stays under the server's 16 megapixel limit.
    expect(UPLOAD_ATTEMPTS[0]!.maxEdge ** 2).toBeLessThan(16_000_000);
  });
  it("measures decoded bytes from base64 and checks the server limit", () => {
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("AA==")).toBe(1);
    const limit = "A".repeat(Math.floor(INVENTORY_IMAGE_MAX_BYTES / 3) * 4);
    expect(fitsUpload(limit)).toBe(true);
    expect(fitsUpload(`${limit}AAAA`)).toBe(false);
    expect(fitsUpload("not base64!")).toBe(false);
  });
  it("names photos without device or location details", () => {
    expect(photoFilename(new Date("2026-11-11T10:20:30.456Z"))).toBe("item-photo-2026-11-11T10-20-30Z.jpg");
  });
});
