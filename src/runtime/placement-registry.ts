import type { PlacementDeclaration, PlacementEntry } from "../bundles/types.ts";

/**
 * In-memory registry of UI placements.
 * Built at startup from manifest metadata, updated on install/uninstall.
 */
export class PlacementRegistry {
  private entries: PlacementEntry[] = [];

  /** Register placements from a bundle's manifest metadata. */
  register(serverName: string, placements: PlacementDeclaration[], wsId?: string): void {
    // Remove any existing entries for this server first (idempotent)
    this.unregister(serverName);

    for (const p of placements) {
      this.entries.push({
        ...p,
        serverName,
        priority: p.priority ?? 100,
        ...(wsId !== undefined ? { wsId } : {}),
      });
    }
  }

  /** Remove all placements for a server. */
  unregister(serverName: string): void {
    this.entries = this.entries.filter((e) => e.serverName !== serverName);
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
