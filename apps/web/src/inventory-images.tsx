import { useEffect, useRef, useState } from "react";
import type { AddInventoryImage, InventoryImageGallery } from "@benchledger/api-contract";
import { ApiError, inventoryImageUrl, workflowCommandKey, workflowRequest } from "./api";
import { useUnsavedWork } from "./unsaved-work";
const labels = { item_photo: "Photo of this item", reference: "Reference image", generated: "AI-generated", unknown: "Source unknown" };
function encode(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read this file."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}
export function InventoryImages({ itemId, sampleMode = false }: { itemId: string; sampleMode?: boolean }) {
  const [gallery, setGallery] = useState<InventoryImageGallery>();
  const [file, setFile] = useState<File>();
  const [caption, setCaption] = useState("");
  const [sourceKind, setSource] = useState<AddInventoryImage["sourceKind"]>("unknown");
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ key: string; body: AddInventoryImage }>();
  const [reload, setReload] = useState(0);
  const input = useRef<HTMLInputElement>(null), alive = useRef(true);
  const path = `/inventory/${encodeURIComponent(itemId)}/images`;
  useUnsavedWork(Boolean(file) || Boolean(caption), "inventory image", busy || Boolean(pending));
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (sampleMode) return;
    let active = true;
    workflowRequest<InventoryImageGallery>(path).then(result => { if (active) { setGallery(result); setError(undefined); } }).catch(err => { if (active) setError(err instanceof Error ? err.message : "Could not load images."); });
    return () => { active = false; };
  }, [path, sampleMode, reload]);
  async function save() {
    if (busy || !gallery || !file) return;
    setBusy(true); setError(undefined);
    try {
      const command = pending ?? { key: workflowCommandKey("inventory-image"), body: { expectedVersion: gallery.version, filename: file.name, mediaType: file.type as AddInventoryImage["mediaType"], imageBase64: await encode(file), caption, sourceKind } };
      setPending(command);
      const result = await workflowRequest<{ data: InventoryImageGallery }>(path, "POST", command.body, command.key);
      if (!alive.current) return;
      setGallery(result.data); setSelected(result.data.images.at(-1)?.id); setFile(undefined); setCaption(""); setPending(undefined);
      if (input.current) input.current.value = "";
    } catch (err) {
      if (!alive.current) return;
      const definitive = err instanceof ApiError && err.status >= 400 && err.status < 500;
      if (definitive) { setPending(undefined); if (err.status === 409) setReload(value => value + 1); }
      setError(err instanceof Error ? err.message : "Could not add image.");
    } finally { if (alive.current) setBusy(false); }
  }
  const image = gallery?.images.find(entry => entry.id === selected) ?? gallery?.images[0];
  return <section className="inventory-images" aria-label="Item images">
    <h3>Images</h3>
    {sampleMode ? <p>Connect to your workspace to add item images.</p> : <>
      {!gallery && !error && <p role="status">Loading images…</p>}
      {gallery?.images.length === 0 && <p>No images yet. Add a photo or a reference image.</p>}
      {image && <figure><img className="inventory-image-main" src={inventoryImageUrl(itemId, image.id)} alt={image.caption || image.filename} /><figcaption><span>{labels[image.sourceKind]}</span>{image.caption && <p>{image.caption}</p>}</figcaption></figure>}
      {gallery && gallery.images.length > 1 && <div className="inventory-image-thumbnails">{gallery.images.map(entry => <button type="button" key={entry.id} aria-label={`View ${entry.caption || entry.filename}`} aria-pressed={entry.id === image?.id} onClick={() => setSelected(entry.id)}><img src={inventoryImageUrl(itemId, entry.id)} alt="" loading="lazy" /></button>)}</div>}
      {gallery && gallery.images.length < 12 && <details><summary>Add image</summary><form onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy || Boolean(pending)}>
          <label className="form-field"><span>Image file</span><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => {
            const candidate = event.target.files?.[0]; setError(undefined);
            if (candidate && (candidate.size > 2 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(candidate.type))) { setFile(undefined); event.target.value = ""; setError("Choose a PNG, JPEG or WebP image up to 2 MiB."); return; }
            setFile(candidate);
          }} /></label>
          <label className="form-field"><span>Image source</span><select value={sourceKind} onChange={event => setSource(event.target.value as AddInventoryImage["sourceKind"])}>{Object.entries(labels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="form-field"><span>Caption (optional)</span><input value={caption} maxLength={500} onChange={event => setCaption(event.target.value)} /></label>
        </fieldset>
        <p className="inventory-image-help">PNG, JPEG or WebP · up to 2 MiB. Images do not confirm stock, condition or compatibility.</p>
        <button type="submit" className="button button-secondary" disabled={!file || busy}>{busy ? "Adding image…" : pending ? "Retry image upload" : "Save image"}</button>
        {pending && !busy && <p role="status">The result is uncertain. Retry the same upload to confirm it without adding a duplicate.</p>}
      </form></details>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!gallery && error && <button type="button" className="button button-secondary" onClick={() => setReload(value => value + 1)}>Retry loading images</button>}
    </>}
  </section>;
}
