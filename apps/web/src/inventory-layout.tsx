import { useRef, useState, useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./components/ui/resizable";
import type { PanelImperativeHandle } from "react-resizable-panels";


export const inventoryOptionalColumns = ["category", "location", "reserved", "sku", "recorded", "status"] as const;
export type InventoryOptionalColumn = typeof inventoryOptionalColumns[number];
export interface InventoryLayout {
  inspectorOpen: boolean;
  inspectorWidth: number;
  columns: InventoryOptionalColumn[];
}
export const defaultInventoryLayout: InventoryLayout = { inspectorOpen: false, inspectorWidth: 420, columns: ["location"] };
export const clampInspectorWidth = (width: number) => Math.min(480, Math.max(260, Math.round(width)));
export const inventoryLayoutKey = (sample: boolean) => `benchledger.inventory.layout.v1.${sample ? "sample" : "workspace"}`;
export function parseInventoryLayout(raw: string | null): InventoryLayout {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return { ...defaultInventoryLayout, columns: [...defaultInventoryLayout.columns] };
    const data = value as Record<string, unknown>;
    const columns = data.columns;
    return {
      inspectorOpen: typeof data.inspectorOpen === "boolean" ? data.inspectorOpen : defaultInventoryLayout.inspectorOpen,
      inspectorWidth: typeof data.inspectorWidth === "number" && Number.isFinite(data.inspectorWidth) ? clampInspectorWidth(data.inspectorWidth) : defaultInventoryLayout.inspectorWidth,
      columns: Array.isArray(columns) ? inventoryOptionalColumns.filter((column) => columns.includes(column)) : [...defaultInventoryLayout.columns],
    };
  } catch { return { ...defaultInventoryLayout, columns: [...defaultInventoryLayout.columns] }; }
}
export function readInventoryLayout(sample: boolean): InventoryLayout {
  try { return parseInventoryLayout(localStorage.getItem(inventoryLayoutKey(sample))); } catch { return parseInventoryLayout(null); }
}
export function writeInventoryLayout(value: InventoryLayout, sample: boolean): boolean {
  try { localStorage.setItem(inventoryLayoutKey(sample), JSON.stringify(value)); return true; } catch { return false; }
}

/** Pixel preference is domain state; the shared resizable primitive owns drag and keyboard behaviour. */
export function InventoryPanels({ width, onChange, register, inspector }: { width: number; onChange(width: number): void; register: ReactNode; inspector: ReactNode }) {
 const [wide,setWide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width:1101px)").matches);
 const panel = useRef<PanelImperativeHandle>(null);
 const group = useRef<HTMLDivElement>(null);
 const [height, setHeight] = useState<number>();
 const showingInspector = Boolean(inspector);
 // A parent reflecting our drag result acknowledges it; it is not a new resize.
 // A fresh panel mount must still apply its preference, even at the same width.
 const emitted = useMemo<{ width: number | null; frame: number | null }>(() => ({ width: null, frame: null }), [wide, showingInspector]);
 // The library registers conditional panels after their first layout effect.
 // Apply a requested width only once its validated layout includes the panel.
 const requested = useMemo(() => ({ width, applied: emitted.width === width }), [width, emitted]);
 useEffect(() => () => { if (emitted.frame !== null) cancelAnimationFrame(emitted.frame); }, [emitted]);
 useEffect(() => { const media = window.matchMedia("(min-width:1101px)"); const update=()=>setWide(media.matches); media.addEventListener("change",update); return ()=>media.removeEventListener("change",update); },[]);
 useLayoutEffect(() => {
   if (!wide || !group.current) return;
   const element = group.current;
   const updateHeight = () => {
     // Include the actual toolbar/filter height. Page scrolling must not grow
     // the panel; very short windows retain a usable, scroll-reachable panel.
     const top = element.getBoundingClientRect().top + window.scrollY;
     setHeight(Math.max(240, Math.floor(window.innerHeight - top - 24)));
   };
   updateHeight();
   const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateHeight);
   const workspace = element.closest(".inventory-workspace") ?? element.parentElement;
   if (workspace) observer?.observe(workspace);
   window.addEventListener("resize", updateHeight);
   return () => { observer?.disconnect(); window.removeEventListener("resize", updateHeight); };
 }, [wide]);
 if (!wide) return <div className="inventory-work-area">{register}{inspector}</div>;
 return <ResizablePanelGroup elementRef={group} style={{ height: height ?? "min(72dvh, 56rem)" }} className="inventory-work-area inventory-panels" orientation="horizontal" onLayoutChanged={layout => {
   if (!showingInspector || !panel.current || layout["inventory-inspector-panel"] === undefined) return;
   if (emitted.frame !== null) cancelAnimationFrame(emitted.frame);
   emitted.frame = null;
   if (!requested.applied) {
     requested.applied = true;
     emitted.width = null;
     panel.current.resize(requested.width);
   } else {
     // Layout callbacks precede React's DOM update and ResizeObserver. Read the
     // settled panel on the next frame instead of persisting the previous size.
     emitted.frame = requestAnimationFrame(() => {
       emitted.frame = null;
       if (!panel.current) return;
       const measuredWidth = clampInspectorWidth(panel.current.getSize().inPixels);
       if (measuredWidth !== width) {
         emitted.width = measuredWidth;
         onChange(measuredWidth);
       }
     });
   }
 }}><ResizablePanel id="inventory-register" minSize={300}>{register}</ResizablePanel>{inspector && <><ResizableHandle className="inventory-splitter" aria-label="Resize item inspector" withHandle onDoubleClick={() => panel.current?.resize(defaultInventoryLayout.inspectorWidth)}/><ResizablePanel id="inventory-inspector-panel" panelRef={panel} defaultSize={width} minSize={260} maxSize={480} groupResizeBehavior="preserve-pixel-size">{inspector}</ResizablePanel></>}</ResizablePanelGroup>;
}
