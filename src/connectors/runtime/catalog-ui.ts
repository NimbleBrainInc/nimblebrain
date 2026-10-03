/**
 * An installed connector's host UI (its placements) comes from the
 * operator catalog at boot, not from the copy its install stored.
 *
 * Install copies the catalog entry's `ui` onto the persisted `ConnectorRef`, and
 * nothing rewrote that copy, so a placement the catalog gained after install
 * never reached a workspace that already had the connector. A re-click is a
 * duplicate install and changes nothing; only an uninstall and reinstall did,
 * and for a connector whose uninstall releases vendor state that is not a remedy.
 * The catalog is the source of truth for host shape, and it only changes with a
 * deploy, so boot re-derives `ui` from the catalog entry each installed ref is,
 * by the rule every other catalog grant uses (`bindCatalogEntry`).
 *
 * A connector no catalog entry names keeps its stored `ui`: nothing better is
 * known, and a catalog read that failed must not strip every app from the shell.
 * A catalog entry that now declares no host UI clears it, because that is what
 * the catalog says. A connector that carries an entry's name and is another
 * server has its `ui` cleared: whatever it stored came from, or claims, that
 * entry, and that entry's grants are not its.
 *
 * Placements are re-sanitized where they register (`sanitizePlacements`), so a
 * value taken here is held to the same rules as one taken at install.
 */

import { bindCatalogEntry } from "../catalog/binding.ts";
import type { ConnectorCatalogEntry } from "../catalog/types.ts";
import { sanitizePlacements } from "./defaults.ts";
import { slugifyServerName } from "./paths.ts";
import type { ConnectorRef, ConnectorUiMeta, LocalConnectorMeta } from "./types.ts";

/**
 * Each catalog entry's display name (its core `title ?? name`, projected as
 * `ConnectorCatalogEntry.name`) by the server name its install uses. First
 * entry per slug wins, though the catalog read already refuses a colliding pair.
 * A connector no entry names has no title here; callers fall back to its server
 * name.
 */
export function catalogTitleByServerName(
  entries: readonly ConnectorCatalogEntry[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    const slug = slugifyServerName(e.id);
    if (!out.has(slug)) out.set(slug, e.name);
  }
  return out;
}

/**
 * The UI an installed connector shows, named for the system prompt: its
 * catalog title, else its server name, or null when it has no placement that
 * survives the check registration applies (so the shell renders nothing).
 */
export function namedUi(
  serverName: string,
  ui: ConnectorUiMeta | null | undefined,
  titles: ReadonlyMap<string, string>,
): { name: string } | null {
  if (sanitizePlacements(ui?.placements).length === 0) return null;
  return { name: titles.get(serverName) ?? serverName };
}

/**
 * The boot inventory with each catalog-named connector's `ui` replaced by the
 * catalog's. Both copies are replaced: the seeded instance reads `ref.ui` and
 * falls back to `meta.ui`, so leaving either stale would bring the old one back.
 * `catalog` is `null` when it could not be read, which leaves every row as
 * stored. `onMismatch` hears each row that carries an entry's name and is
 * another server.
 */
export function withCatalogUi<
  T extends {
    wsId: string;
    serverName: string;
    connector: ConnectorRef;
    meta?: LocalConnectorMeta | null;
  },
>(
  entries: readonly T[],
  catalog: readonly ConnectorCatalogEntry[] | null,
  onMismatch: (wsId: string, serverName: string, entry: ConnectorCatalogEntry) => void = () => {},
): T[] {
  if (catalog === null) return [...entries];
  return entries.map((entry) => {
    const binding = bindCatalogEntry(entry.connector, catalog);
    if (binding.kind === "uncatalogued") return entry;
    if (binding.kind === "mismatch") onMismatch(entry.wsId, entry.serverName, binding.entry);
    const ui = binding.kind === "bound" ? (binding.entry.ui ?? null) : null;
    return {
      ...entry,
      connector: { ...entry.connector, ui },
      ...(entry.meta ? { meta: { ...entry.meta, ui } } : {}),
    };
  });
}
