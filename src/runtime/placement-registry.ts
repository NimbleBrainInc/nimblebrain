import type { PlacementDeclaration, PlacementEntry } from "../connectors/runtime/types.ts";
import { log } from "../observability/log.ts";

/**
 * The form two placement routes are compared in: decoded, case-folded, with
 * repeated, leading and trailing slashes dropped. The shell's router matches
 * case-insensitively and on the decoded path, so routes that differ only in
 * those ways can open the same page; they count as one. The web shell keeps a
 * mirror of this (`web/src/lib/routable-placements.ts`).
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
 * In-memory registry of UI placements.
 * Built at startup from manifest metadata, updated on install/uninstall.
 *
 * Placements are either ambient (no wsId — platform-provided entries like
 * Home, Conversations, Files; always shown) or workspace-scoped (has wsId —
 * installed connectors that render only for members of that workspace). Every
 * legitimate read in this product wants "ambient + scoped-for-this-workspace"
 * merged, so that is the single read method exposed. No `all()` or
 * slot-agnostic accessor — the shape of the API makes it impossible to
 * accidentally leak one workspace's nav to another (which was the original
 * Mario/HQ-tenant bug).
 *
 * A route belongs to one server. A platform source's route is reserved: a
 * connector placement that names it is refused, and a platform source that
 * registers after a connector took its route evicts that placement. Between
 * connectors in one workspace, the one registered first keeps the route. Each
 * loser is dropped with a warning, never silently, so a reviewed catalog
 * mistake costs the offending connector its placement and nothing else.
 */
export class PlacementRegistry {
  private entries: PlacementEntry[] = [];

  /**
   * Register placements from a connector's manifest metadata.
   *
   * Scoped to (serverName, wsId): the idempotent cleanup before insertion only
   * removes entries for this server in this workspace. Omitting wsId means
   * ambient (platform/system sources) — scoped to entries whose wsId is also
   * undefined. Without this scoping, re-seeding the same connector in a second
   * workspace would wipe out the first workspace's nav entries.
   */
  register(serverName: string, placements: PlacementDeclaration[], wsId?: string): void {
    this.unregister(serverName, wsId);

    for (const p of placements) {
      const holder =
        p.route === undefined ? undefined : this.routeHolder(p.route, serverName, wsId);
      if (holder) {
        log.warn("[placements] route already held; placement dropped", {
          serverName,
          wsId,
          route: p.route,
          heldBy: holder.serverName,
        });
        continue;
      }
      this.entries.push({
        ...p,
        serverName,
        priority: p.priority ?? 100,
        ...(wsId !== undefined ? { wsId } : {}),
      });
    }

    if (wsId === undefined) this.evictShadowedRoutes(serverName);
  }

  /**
   * The entry, from another server, that already holds `route` where a
   * placement for `wsId` would mount: an ambient entry always does; a scoped
   * one only within the same workspace. Ambient placements answer to no one,
   * since platform sources are authored with the shell.
   */
  private routeHolder(
    route: string,
    serverName: string,
    wsId?: string,
  ): PlacementEntry | undefined {
    if (wsId === undefined) return undefined;
    const key = placementRouteKey(route);
    return this.entries.find(
      (e) =>
        e.serverName !== serverName &&
        e.route !== undefined &&
        (e.wsId === undefined || e.wsId === wsId) &&
        placementRouteKey(e.route) === key,
    );
  }

  /** Drop every connector placement on a route this platform source now holds. */
  private evictShadowedRoutes(serverName: string): void {
    const reserved = new Set(
      this.entries.flatMap((e) =>
        e.serverName === serverName && e.wsId === undefined && e.route !== undefined
          ? [placementRouteKey(e.route)]
          : [],
      ),
    );
    if (reserved.size === 0) return;
    this.entries = this.entries.filter((e) => {
      if (e.wsId === undefined || e.route === undefined) return true;
      if (!reserved.has(placementRouteKey(e.route))) return true;
      log.warn("[placements] route reserved by a platform source; placement dropped", {
        serverName: e.serverName,
        wsId: e.wsId,
        route: e.route,
        heldBy: serverName,
      });
      return false;
    });
  }

  /**
   * Remove placements for (serverName, wsId). Both undefined match: passing
   * no wsId removes only ambient entries, passing a wsId removes only that
   * workspace's entries. Entries for other workspaces are untouched — this
   * is what prevents a second workspace's install from wiping the first's
   * nav.
   */
  unregister(serverName: string, wsId?: string): void {
    this.entries = this.entries.filter((e) => {
      if (e.serverName !== serverName) return true;
      return e.wsId !== wsId;
    });
  }

  /**
   * Placements visible within a workspace: ambient (no wsId) plus entries
   * scoped to this wsId. Sorted by slot then priority (lower = first) so
   * callers can walk the list and render grouped-by-slot directly.
   *
   * This is the only read method on the registry. There is deliberately no
   * "return everything" accessor — in a multi-tenant system, no legitimate
   * caller wants placements unrelated to a workspace.
   */
  forWorkspace(wsId: string): PlacementEntry[] {
    return this.entries
      .filter((e) => e.wsId === undefined || e.wsId === wsId)
      .sort((a, b) => {
        const slotCmp = a.slot.localeCompare(b.slot);
        if (slotCmp !== 0) return slotCmp;
        return a.priority - b.priority;
      });
  }
}
