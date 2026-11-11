import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { encodeQr, qrSvgPath } from "./qr-code";
import { Icon } from "./icons";
import { Button } from "./components/ui/button";

/** Mobile-scannable payload; documented in docs/mobile-app.md (Scanning and labels). */
export const ITEM_LABEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export function itemLabelPayload(itemId: string): string {
  if (itemId.length > 160 || !ITEM_LABEL_ID_PATTERN.test(itemId)) throw new RangeError("This item ID cannot be printed as a label");
  return `benchledger://item/${itemId}`;
}

export interface ItemLabelDetails {
  readonly id: string;
  readonly name: string;
  readonly variant?: string | undefined;
  readonly location?: string | undefined;
}

/** The printable label: QR (error correction M, four-module quiet zone) plus readable text. */
export function ItemLabelCard({ item }: { item: ItemLabelDetails }) {
  const titleId = useId();
  const matrix = useMemo(() => encodeQr(itemLabelPayload(item.id)), [item.id]);
  const extent = matrix.size + 8;
  const location = item.location?.trim();
  return <figure className="item-label" aria-labelledby={titleId}>
    <svg className="item-label-qr" viewBox={`0 0 ${extent} ${extent}`} role="img" aria-label={`QR code for ${item.name}`} shapeRendering="crispEdges">
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={qrSvgPath(matrix)} fill="#000000" />
    </svg>
    <figcaption>
      <strong id={titleId}>{item.name}</strong>
      {item.variant && <span>{item.variant}</span>}
      {location && location !== "Unassigned" && <span>{location}</span>}
    </figcaption>
  </figure>;
}

/**
 * Drawer action: preview the label, then print it with the browser's print
 * dialog. Printing uses a portal plus print CSS (no new window, no inline
 * script), so it works under the application's Content-Security-Policy.
 */
export function PrintItemLabel({ item }: { item: ItemLabelDetails }) {
  const [open, setOpen] = useState(false);
  const [printing, setPrinting] = useState(false);
  const printable = item.id.length <= 160 && ITEM_LABEL_ID_PATTERN.test(item.id);

  useEffect(() => {
    if (!printing) return;
    document.body.classList.add("printing-label");
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    window.print();
    // Browsers without afterprint resolve print() synchronously.
    const timer = window.setTimeout(done, 1000);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", done);
      document.body.classList.remove("printing-label");
    };
  }, [printing]);

  if (!printable) return null;
  return <section className="drawer-label" aria-label="Item label">
    {!open ? <Button variant="outline" type="button" className="button button-secondary" onClick={() => setOpen(true)}><Icon name="tag" size={16} />Print label</Button> : <>
      <div className="drawer-label-preview"><ItemLabelCard item={item} /></div>
      <p className="drawer-section-copy">Scan with the BenchLedger app to open this item. The label holds only the item ID, not a server address or password.</p>
      <div className="drawer-form-actions"><Button variant="ghost" type="button" className="button button-quiet" onClick={() => setOpen(false)}>Close preview</Button><Button variant="default" type="button" className="button button-primary" onClick={() => setPrinting(true)} disabled={printing}>Print</Button></div>
    </>}
    {printing && createPortal(<div className="print-label-root"><ItemLabelCard item={item} /></div>, document.body)}
  </section>;
}
