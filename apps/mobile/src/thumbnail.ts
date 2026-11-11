/**
 * Which image an inventory row shows. Current servers send the item's cover
 * as `primaryImage`; it is used only when its address is exactly this item's
 * authenticated content route (the request itself is rebuilt by
 * `BenchLedgerClient.imageSource`, so the URL is never fetched as given).
 * Otherwise, and on older servers, a gallery already opened on this phone
 * supplies the first photo. A gallery copy of the same image lends its digest
 * so both screens share one disk-cache entry.
 */
type RowItem = { id: string; primaryImage?: { id: string; url: string } | undefined };
type CachedGallery = { images: readonly { id: string; sha256: string }[] };
export type RowImage = { imageId: string; sha256?: string };

export function rowThumbnail(item: RowItem, gallery?: CachedGallery): RowImage | undefined {
  const primary = item.primaryImage;
  if (primary && primary.url === `/api/v1/inventory/${encodeURIComponent(item.id)}/images/${encodeURIComponent(primary.id)}/content`) {
    const known = gallery?.images.find((image) => image.id === primary.id);
    return known ? { imageId: primary.id, sha256: known.sha256 } : { imageId: primary.id };
  }
  const first = gallery?.images[0];
  return first ? { imageId: first.id, sha256: first.sha256 } : undefined;
}
