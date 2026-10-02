import type { PlacementEntry } from "../types";

/**
 * The form two placement routes are compared in: decoded, case-folded, with
 * repeated, leading and trailing slashes dropped, because the router can open
 * the same page for routes that differ only in those ways. Mirrors
 * `placementRouteKey` in `src/runtime/placement-registry.ts`, which refuses a
 * colliding connector placement before it reaches the shell.
 */
export function placementRouteKey(route: string): string {
  let decoded = route;
  try {
    decoded = decodeURIComponent(route);
  } catch {
    // Malformed escapes: compare the raw string.
  }
  return decoded
    .toLowerCase()
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * Platform placements (no `wsId`) ahead of connector ones, each group keeping
 * its order. A lookup that takes the first match then never lets a connector's
 * priority put it in front of a platform route.
 */
export function platformFirst(placements: PlacementEntry[]): PlacementEntry[] {
  return [
    ...placements.filter((p) => p.wsId === undefined),
    ...placements.filter((p) => p.wsId !== undefined),
  ];
}

/**
 * The routable placements the router registers, one per route: every sidebar
 * placement with a route except the `sidebar.bottom` tray, then every `main`
 * route. A platform placement always keeps its route; between connectors the
 * first in slot and priority order does. The server refuses such a collision
 * when it registers the placement, so this holds only if that check is bypassed.
 */
export function routablePlacements(
  sidebar: PlacementEntry[],
  main: PlacementEntry[],
): PlacementEntry[] {
  const sidebarRoutes = sidebar.filter((p) => p.route && !p.slot.startsWith("sidebar.bottom"));
  const seen = new Set<string>();
  const out: PlacementEntry[] = [];
  for (const p of platformFirst([...sidebarRoutes, ...main])) {
    if (!p.route) continue;
    const key = placementRouteKey(p.route);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
