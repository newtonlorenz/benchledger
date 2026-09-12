type Vector = [number, number, number];
export interface AssemblyBounds { id: string; min: Vector; max: Vector }
/** Presentation only: radial spacing, with an axial fallback for concentric parts. */
export function suggestAssemblyExplosion(parts: readonly AssemblyBounds[]): Record<string, Vector> {
  if (!parts.length) return {};
  const lo = [0, 1, 2].map(axis => Math.min(...parts.map(p => p.min[axis]!)));
  const hi = [0, 1, 2].map(axis => Math.max(...parts.map(p => p.max[axis]!)));
  const centre = lo.map((value, axis) => (value + hi[axis]!) / 2);
  const distance = Math.max(...hi.map((value, axis) => value - lo[axis]!), 1) * 0.65;
  return Object.fromEntries(parts.map((part, index) => {
    const direction = centre.map((value, axis) => (part.min[axis]! + part.max[axis]!) / 2 - value);
    let length = Math.hypot(...direction);
    if (length < distance * 0.02) { direction.fill(0); direction[index % 3] = index % 2 ? -1 : 1; length = 1; }
    return [part.id, direction.map(value => parts.length === 1 ? 0 : Math.round(value / length * distance * 100) / 100) as Vector];
  }));
}
