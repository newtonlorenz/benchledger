import { describe, expect, it } from "vitest";
import { rowThumbnail } from "./thumbnail";

const cover = { id: "img-cover", url: "/api/v1/inventory/item-1/images/img-cover/content", mediaType: "image/webp" as const, width: 640, height: 480 };
const sha = "a".repeat(64);
const gallery = { images: [{ id: "img-old", sha256: sha }] };

describe("inventory row thumbnails", () => {
  it("uses the server's primary image for the list row", () => {
    expect(rowThumbnail({ id: "item-1", primaryImage: cover })).toEqual({ imageId: "img-cover" });
  });
  it("reuses the gallery digest as cache key when the gallery on this phone has the same image", () => {
    expect(rowThumbnail({ id: "item-1", primaryImage: cover }, { images: [{ id: "img-cover", sha256: sha }] })).toEqual({ imageId: "img-cover", sha256: sha });
  });
  it("prefers the server's current cover over an older gallery cached on this phone", () => {
    expect(rowThumbnail({ id: "item-1", primaryImage: cover }, gallery)).toEqual({ imageId: "img-cover" });
  });
  it("falls back to a gallery opened on this phone when the server sends no primary image", () => {
    expect(rowThumbnail({ id: "item-1" }, gallery)).toEqual({ imageId: "img-old", sha256: sha });
    expect(rowThumbnail({ id: "item-1" }, { images: [] })).toBeUndefined();
    expect(rowThumbnail({ id: "item-1" })).toBeUndefined();
  });
  it("ignores a primary image whose address is not this item's own content route", () => {
    expect(rowThumbnail({ id: "item-2", primaryImage: cover })).toBeUndefined();
    expect(rowThumbnail({ id: "item-1", primaryImage: { ...cover, url: "/api/v1/inventory/item-1/images/img-other/content" } }, gallery)).toEqual({ imageId: "img-old", sha256: sha });
  });
});
