import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export const inventoryOptionalColumns = ["category", "location", "reserved", "sku"] as const;
export type InventoryOptionalColumn = typeof inventoryOptionalColumns[number];
export interface InventoryLayout {
  inspectorOpen: boolean;
  inspectorWidth: number;
  columns: InventoryOptionalColumn[];
}
export const defaultInventoryLayout: InventoryLayout = { inspectorOpen: true, inspectorWidth: 300, columns: ["location"] };
export const clampInspectorWidth = (width: number) => Math.min(480, Math.max(260, Math.round(width)));
export const inventoryLayoutKey = (sample: boolean) => `benchledger.inventory.layout.v1.${sample ? "sample" : "workspace"}`;
export function parseInventoryLayout(raw: string | null): InventoryLayout {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return { ...defaultInventoryLayout, columns: [...defaultInventoryLayout.columns] };
    const data = value as Record<string, unknown>;
    const columns = data.columns;
    return {
      inspectorOpen: typeof data.inspectorOpen === "boolean" ? data.inspectorOpen : true,
      inspectorWidth: typeof data.inspectorWidth === "number" && Number.isFinite(data.inspectorWidth) ? clampInspectorWidth(data.inspectorWidth) : 300,
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

/** Pointer capture keeps a resize active until the drag ends. */
export function InventorySplitter({ width, onChange }: { width: number; onChange(width: number, commit: boolean): void }) {
  const drag = useRef<{ pointerId: number; x: number; width: number; latest: number } | undefined>(undefined);
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const latest = drag.current.latest; drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onChange(latest, true);
  };
  return <div className="inventory-splitter" role="separator" tabIndex={0} aria-label="Resize item inspector" aria-orientation="vertical" aria-controls="inventory-item-inspector" aria-valuemin={260} aria-valuemax={480} aria-valuenow={width} aria-valuetext={`${width} pixels wide`} title="Drag to resize. Arrow keys adjust width; double-click resets." onDoubleClick={() => onChange(300, true)}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 40 : 10;
      const next = event.key === "ArrowLeft" ? width + step : event.key === "ArrowRight" ? width - step : event.key === "Home" ? 260 : event.key === "End" ? 480 : undefined;
      if (next !== undefined) { event.preventDefault(); onChange(clampInspectorWidth(next), true); }
    }}
    onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointerId: event.pointerId, x: event.clientX, width, latest: width }; }}
    onPointerMove={(event) => { if (!drag.current || drag.current.pointerId !== event.pointerId) return; const next = clampInspectorWidth(drag.current.width + drag.current.x - event.clientX); drag.current.latest = next; onChange(next, false); }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}><span /></div>;
}
