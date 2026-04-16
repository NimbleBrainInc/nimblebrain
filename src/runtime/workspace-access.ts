import type { PlacementEntry } from "../bundles/types.ts";
import type { Workspace } from "../workspace/types.ts";

/**
 * Filter placement entries to only those accessible within a workspace.
 *
 * Uses `entry.wsId` for matching: no wsId means protected (always included),
 * has wsId means must match the workspace.
 */
export function filterPlacementsForWorkspace(
  placements: PlacementEntry[],
  workspace: Workspace,
): PlacementEntry[] {
  return placements.filter((entry) => {
    // No wsId = protected placement, always included
    if (entry.wsId === undefined) return true;
    // Has wsId = must match the workspace
    return entry.wsId === workspace.id;
  });
}
