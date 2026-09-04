export const FABRICATION_ROUTES = ["printed", "ready_made", "none", "undecided"] as const;
export type FabricationRoute = (typeof FABRICATION_ROUTES)[number];

export function isFabricationRoute(value: unknown): value is FabricationRoute {
  return typeof value === "string" && (FABRICATION_ROUTES as readonly string[]).includes(value);
}
