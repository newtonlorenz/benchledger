import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
import { Label } from "./components/ui/label";
import { Button } from "./components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "./components/ui/popover";
import { useEffect, useState } from "react";
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
  return <Popover><PopoverTrigger asChild><Button variant="ghost" type="button" className="appearance-trigger" aria-label="Workspace appearance" title="Theme and row spacing"><Icon name="sliders" size={17} /><span>View</span></Button></PopoverTrigger><PopoverContent className="appearance-panel" align="end" sideOffset={8} aria-label="Workspace view">
    <div className="control-panel-heading"><strong>Workspace view</strong><span>Saved in this browser.</span></div>
    <fieldset><legend>Colour theme</legend><RadioGroup className="segmented-options" aria-label="Colour theme" value={value.colourMode} onValueChange={next => onChange({ colourMode: next as ColourMode })}>{(["light", "dark", "system"] as ColourMode[]).map((mode) => <Label key={mode}><RadioGroupItem value={mode} /><span>{mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"}</span></Label>)}</RadioGroup></fieldset>
    <fieldset><legend>Row spacing</legend><RadioGroup className="segmented-options" aria-label="Row spacing" value={value.density} onValueChange={next => onChange({ density: next as Density })}>{(["comfortable", "compact"] as Density[]).map((density) => <Label key={density}><RadioGroupItem value={density} /><span>{density === "comfortable" ? "Standard" : "Compact"}</span></Label>)}</RadioGroup></fieldset>
    <p>Compact rows apply to pointer devices. Touch controls keep their size.</p>
  </PopoverContent></Popover>;
}
