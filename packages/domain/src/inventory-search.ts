/** Search is discovery, not a stock, identity or compatibility assertion. */
export function matchesInventorySearch(values: readonly (string | undefined)[], query?: string): boolean {
  if (query === undefined || query.trim() === "") return true;
  const normalise = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const terms = normalise(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return false;
  const text = normalise(values.filter((value): value is string => value !== undefined).join(" "));
  return terms.every((term) => text.includes(term));
}
