export type ColourMode = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";
export interface Appearance { colourMode: ColourMode; density: Density; collapsed: boolean }
export const appearanceKey = "benchledger.appearance.v1";
export const defaultAppearance: Appearance = { colourMode: "system", density: "comfortable", collapsed: false };
export function parseAppearance(value: string | null): Appearance {
  try {
    const data: unknown = value ? JSON.parse(value) : null;
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ...defaultAppearance };
    const record = data as Record<string, unknown>;
    return { colourMode: ["system", "light", "dark"].includes(String(record.colourMode)) ? record.colourMode as ColourMode : "system", density: record.density === "compact" ? "compact" : "comfortable", collapsed: record.collapsed === true };
  } catch { return { ...defaultAppearance }; }
}
export function readAppearance(): Appearance {
  try { return parseAppearance(window.localStorage.getItem(appearanceKey)); }
  catch { return { ...defaultAppearance }; }
}
export function applyAppearance(value: Appearance): void {
  if (typeof document === "undefined") return;
  const dark = value.colourMode === "dark" || value.colourMode === "system" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.density = value.density;
  document.documentElement.dataset.nav = value.collapsed ? "rail" : "full";
}
export function storeAppearance(value: Appearance): void {
  try { window.localStorage.setItem(appearanceKey, JSON.stringify(value)); } catch { /* Browser preferences remain usable without storage. */ }
  applyAppearance(value);
}
