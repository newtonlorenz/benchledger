import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionSheetIOS, Alert, Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { SaveFormat, manipulateAsync } from "expo-image-manipulator";
import * as Haptics from "expo-haptics";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import type { BenchLedgerClient, Gallery } from "./client";
import { ClientError, errorMessage } from "./connection";
import { UPLOAD_ATTEMPTS, fitsUpload, photoFilename, resizeFor } from "./image-plan";
import { rowThumbnail, type RowImage } from "./thumbnail";
import type { QueryCache } from "./query-cache";
import { useRemote } from "./use-remote";
import { Action, Notice, styles, useColours } from "./ui";

export const galleryKey = (itemId: string) => `gallery/${itemId}`;
const GALLERY_LIMIT = 12;

/** Picker and resize copies live in the app cache; remove them once read. */
function discard(uri: string) { try { const file = new File(uri); if (file.exists) file.delete(); } catch { /* already gone */ } }

/** Downscale and recompress until the photo fits the server's upload limit. */
async function prepare(asset: ImagePicker.ImagePickerAsset): Promise<string> {
  try {
    for (const attempt of UPLOAD_ATTEMPTS) {
      const resize = resizeFor(asset.width, asset.height, attempt.maxEdge);
      const result = await manipulateAsync(asset.uri, resize ? [{ resize }] : [], { compress: attempt.quality, format: SaveFormat.JPEG, base64: true });
      discard(result.uri);
      if (result.base64 && fitsUpload(result.base64)) return result.base64;
    }
    throw new ClientError("This photo is too large to upload, even after resizing.");
  } finally { discard(asset.uri); }
}

async function choose(source: "camera" | "library"): Promise<ImagePicker.ImagePickerAsset | undefined> {
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera access is off", "Allow camera access in Settings to photograph items, or choose an existing photo instead.",
        permission.canAskAgain ? [{ text: "OK" }] : [{ text: "Not now", style: "cancel" }, { text: "Open Settings", onPress: () => { void Linking.openSettings(); } }]);
      return undefined;
    }
  }
  // The system photo picker needs no library permission; exif stays off so location is not read.
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1, exif: false, allowsEditing: false };
  const result = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  return result.canceled ? undefined : result.assets[0];
}

function askSource(onPick: (source: "camera" | "library") => void) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions({ options: ["Take photo", "Choose from library", "Cancel"], cancelButtonIndex: 2, title: "Add a photo of this item" },
      (index) => { if (index === 0) onPick("camera"); else if (index === 1) onPick("library"); });
  } else {
    Alert.alert("Add a photo of this item", undefined, [
      { text: "Take photo", onPress: () => onPick("camera") }, { text: "Choose from library", onPress: () => onPick("library") }, { text: "Cancel", style: "cancel" }
    ]);
  }
}

/** Item photo gallery: cached thumbnails and, with write access, camera/library upload. */
export function ItemPhotos({ client, cache, itemId, canWrite }: { client: BenchLedgerClient; cache: QueryCache; itemId: string; canWrite: boolean }) {
  const c = useColours();
  const scope = useMemo(() => ({ cache, key: galleryKey(itemId) }), [cache, itemId]);
  const { data: gallery, error, refresh } = useRemote(useCallback(() => client.gallery(itemId), [client, itemId]), scope);
  const [status, setStatus] = useState<{ busy: boolean; error: string; done: string }>({ busy: false, error: "", done: "" });
  // One idempotency key per prepared photo and gallery version, reused on retry.
  const pending = useRef<{ base64: string; version: number; key: string } | undefined>(undefined);
  const lastPhoto = useRef<string | undefined>(undefined);

  async function upload(base64: string, current: Gallery) {
    if (pending.current?.base64 !== base64 || pending.current.version !== current.version) pending.current = { base64, version: current.version, key: Crypto.randomUUID() };
    setStatus({ busy: true, error: "", done: "" });
    try {
      const next = await client.addImage(itemId, { expectedVersion: current.version, imageBase64: base64, filename: photoFilename(new Date()), mediaType: "image/jpeg" }, pending.current.key);
      pending.current = undefined;
      cache.set(galleryKey(itemId), next);
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setStatus({ busy: false, error: "", done: "Photo added. Stock and verification are unchanged." });
    } catch (e) {
      const conflict = e instanceof ClientError && e.status === 409;
      if (conflict) await refresh();
      setStatus({ busy: false, done: "", error: conflict ? "The photos changed on the server. Try adding it again." : errorMessage(e) });
      lastPhoto.current = base64;
    }
  }
  function add() {
    askSource((source) => {
      void (async () => {
        try {
          const asset = await choose(source);
          if (!asset || !gallery) return;
          setStatus({ busy: true, error: "", done: "" });
          await upload(await prepare(asset), gallery);
        } catch (e) { setStatus({ busy: false, done: "", error: errorMessage(e) }); }
      })();
    });
  }
  // Galleries are unavailable on servers without inventory images or for scoped tokens.
  if (!gallery && error) return null;
  const images = gallery?.images ?? [];
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={[styles.heading, { color: c.text }]}>Photos</Text>
    {images.length > 0 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={photos.strip}>
      {images.map((image) => <Image key={image.id} accessibilityLabel={image.caption || "Item photo"} style={[photos.thumb, { backgroundColor: c.surface }]}
        source={client.imageSource(itemId, image.id, image.sha256)} cachePolicy="disk" recyclingKey={image.id} contentFit="cover" transition={0} />)}
    </ScrollView> : gallery && <Text style={[styles.small, { color: c.muted }]}>No photos yet.</Text>}
    {status.error ? <Notice error message={status.error} /> : null}
    {status.done ? <Notice message={status.done} /> : null}
    {canWrite && gallery && images.length < GALLERY_LIMIT && <Action quiet icon="camera-outline" label={status.busy ? "Uploading photo…" : "Add photo"} busy={status.busy} onPress={add} />}
    {canWrite && status.error && lastPhoto.current && gallery && <Action quiet icon="refresh" label="Try upload again" disabled={status.busy}
      onPress={() => { const photo = lastPhoto.current; if (photo) void upload(photo, gallery); }} />}
  </View>;
}

/**
 * A list-row thumbnail: the server's primary image when it sends one, else a
 * gallery already opened on this phone, else the item icon. Requests carry
 * the bearer header and are disk-cached; a failed load falls back to the icon.
 */
export function RowThumbnail({ client, cache, item, fallback }: { client: BenchLedgerClient; cache: QueryCache; item: { id: string; primaryImage?: { id: string; url: string } | undefined }; fallback: ReactNode }) {
  const image = rowThumbnail(item, cache.get<Gallery>(galleryKey(item.id))?.value);
  const [failed, setFailed] = useState<RowImage | undefined>(undefined);
  if (!image || (failed?.imageId === image.imageId && failed.sha256 === image.sha256)) return <>{fallback}</>;
  return <Image accessible={false} style={photos.row} source={client.imageSource(item.id, image.imageId, image.sha256)} cachePolicy="disk"
    recyclingKey={image.imageId} contentFit="cover" transition={0} onError={() => setFailed(image)} />;
}

const photos = StyleSheet.create({
  strip: { gap: 10, paddingHorizontal: 2 },
  thumb: { width: 104, height: 104, borderRadius: 16, borderCurve: "continuous" },
  row: { width: 48, height: 48, borderRadius: 14, borderCurve: "continuous" }
});
