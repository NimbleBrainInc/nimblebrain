import type { PlacementEntry } from "../types";

/**
 * The name the shell shows for an app, wherever it shows one: an installed
 * connector's catalog title, else the label of its first sidebar view (the
 * built-in apps, such as Files), else its server name. One rule, so an app's
 * notice reads the same from its page and from a chat, and matches the sidebar.
 *
 * Never a name the app sends: a notice's label says who raised it, so it comes
 * from the bundle's manifest and the catalog, not from the message.
 */
export function appDisplayName(
  serverName: string,
  installed: ReadonlyArray<{ serverName: string; displayName?: string }> | undefined,
  sidebarPlacements: ReadonlyArray<PlacementEntry>,
): string {
  const title = installed?.find((c) => c.serverName === serverName)?.displayName;
  if (title) return title;
  const label = sidebarPlacements.find((p) => p.serverName === serverName && p.label)?.label;
  return label ?? serverName;
}
