import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { applyAppearance, appearanceKey, parseAppearance, readAppearance, storeAppearance } from "./appearance";
import type { Appearance, ColourMode, Density } from "./appearance";
export function useAppearance() {
  const [value, setValue] = useState<Appearance>(readAppearance);
  useEffect(() => { applyAppearance(value); const system = window.matchMedia("(prefers-color-scheme: dark)"); const update = () => applyAppearance(value); system.addEventListener("change", update); return () => system.removeEventListener("change", update); }, [value]);
  useEffect(() => { const sync = (event: StorageEvent) => { if (event.key === appearanceKey || event.key === null) setValue(parseAppearance(event.newValue)); }; window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync); }, []);
  return { value, change: (patch: Partial<Appearance>) => setValue((current) => { const next = { ...current, ...patch }; storeAppearance(next); return next; }) };
}
export function AppearanceControl({ value, onChange }: { value: Appearance; onChange(patch: Partial<Appearance>): void }) {
  const root = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) root.current?.removeAttribute("open"); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); root.current?.removeAttribute("open"); root.current?.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <details ref={root} className="appearance-control" onToggle={(event) => setOpen(event.currentTarget.open)}><summary aria-label="Workspace appearance" title="Theme and row spacing"><Icon name="sliders" size={17} /><span>View</span></summary><div className="appearance-panel">
    <div className="control-panel-heading"><strong>Workspace view</strong><span>Saved in this browser.</span></div>
    <fieldset><legend>Colour theme</legend><div className="segmented-options">{(["light", "dark", "system"] as ColourMode[]).map((mode) => <label key={mode}><input type="radio" name="workspace-colour" value={mode} checked={value.colourMode === mode} onChange={() => onChange({ colourMode: mode })} /><span>{mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"}</span></label>)}</div></fieldset>
    <fieldset><legend>Row spacing</legend><div className="segmented-options">{(["comfortable", "compact"] as Density[]).map((density) => <label key={density}><input type="radio" name="workspace-density" value={density} checked={value.density === density} onChange={() => onChange({ density })} /><span>{density === "comfortable" ? "Standard" : "Compact"}</span></label>)}</div></fieldset>
    <p>Compact rows apply to pointer devices. Touch controls keep their size.</p>
  </div></details>;
}
