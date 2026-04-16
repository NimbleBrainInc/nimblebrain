import type { PlacementDeclaration, PlacementEntry } from "../bundles/types.ts";

/**
 * In-memory registry of UI placements.
 * Built at startup from manifest metadata, updated on install/uninstall.
 */
export class PlacementRegistry {
  private entries: PlacementEntry[] = [];

  /**
   * Register placements from a bundle's manifest metadata.
   *
   * Scoped to (serverName, wsId): the idempotent cleanup before insertion only
   * removes entries for this server in this workspace. Omitting wsId means a
   * global placement (platform/system sources) — scoped to entries whose wsId
   * is also undefined. Without this scoping, re-seeding the same bundle in a
   * second workspace would wipe out the first workspace's nav entries.
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
   * Remove placements for a server. If wsId is provided, only removes entries
   * matching that workspace; otherwise only removes global entries (wsId
   * undefined). Passing `"*"` removes every entry for the server across all
   * workspaces — used for full-bundle uninstalls.
   */
  unregister(serverName: string, wsId?: string | "*"): void {
    this.entries = this.entries.filter((e) => {
      if (e.serverName !== serverName) return true;
      if (wsId === "*") return false;
      return e.wsId !== wsId;
    });
  }

  /**
   * Get placements for a slot, sorted by priority (lower = first).
   * If slot is a parent (e.g., "sidebar"), also returns sub-slots (e.g., "sidebar.conversations").
   */
  forSlot(slot: string): PlacementEntry[] {
    return this.entries
      .filter((e) => e.slot === slot || e.slot.startsWith(`${slot}.`))
      .sort((a, b) => a.priority - b.priority);
  }

  /** Get all placements sorted by slot then priority. */
  all(): PlacementEntry[] {
    return [...this.entries].sort((a, b) => {
      const slotCmp = a.slot.localeCompare(b.slot);
      if (slotCmp !== 0) return slotCmp;
      return a.priority - b.priority;
    });
  }
}
