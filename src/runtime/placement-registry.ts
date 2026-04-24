import type { PlacementDeclaration, PlacementEntry } from "../bundles/types.ts";

/**
 * In-memory registry of UI placements.
 * Built at startup from manifest metadata, updated on install/uninstall.
 *
 * Placements are either ambient (no wsId — platform-provided entries like
 * Home, Conversations, Files; always shown) or workspace-scoped (has wsId —
 * installed bundles that render only for members of that workspace). Every
 * legitimate read in this product wants "ambient + scoped-for-this-workspace"
 * merged, so that is the single read method exposed. No `all()` or
 * slot-agnostic accessor — the shape of the API makes it impossible to
 * accidentally leak one workspace's nav to another (which was the original
 * Mario/HQ-tenant bug).
 */
export class PlacementRegistry {
  private entries: PlacementEntry[] = [];

  /**
   * Register placements from a bundle's manifest metadata.
   *
   * Scoped to (serverName, wsId): the idempotent cleanup before insertion only
   * removes entries for this server in this workspace. Omitting wsId means
   * ambient (platform/system sources) — scoped to entries whose wsId is also
   * undefined. Without this scoping, re-seeding the same bundle in a second
   * workspace would wipe out the first workspace's nav entries.
   */
  register(serverName: string, placements: PlacementDeclaration[], wsId?: string): void {
    this.unregister(serverName, wsId);

    for (const p of placements) {
      this.entries.push({
        ...p,
        serverName,
        priority: p.priority ?? 100,
        ...(wsId !== undefined ? { wsId } : {}),
      });
    }
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
