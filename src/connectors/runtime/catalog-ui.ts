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
 * deploy, so boot re-derives `ui` from it, by the same slug rule the install used
 * and the `admin_tools` lookup uses (`slugifyServerName(entry.id) === serverName`).
 *
 * A connector no catalog entry names keeps its stored `ui`: nothing better is
 * known, and a catalog read that failed must not strip every app from the shell.
 * A catalog entry that now declares no host UI clears it, because that is what
 * the catalog says.
 *
 * Placements are re-sanitized where they register (`sanitizePlacements`), so a
 * value taken here is held to the same rules as one taken at install.
 */

import type { ConnectorCatalogEntry } from "../catalog/types.ts";
import { sanitizePlacements } from "./defaults.ts";
import { slugifyServerName } from "./paths.ts";
import type { ConnectorRef, ConnectorUiMeta, LocalConnectorMeta } from "./types.ts";

/** Each catalog entry's host UI by the server name its install uses. First entry per slug wins. */
export function catalogUiByServerName(
  entries: readonly ConnectorCatalogEntry[],
): Map<string, ConnectorUiMeta | null> {
  const out = new Map<string, ConnectorUiMeta | null>();
  for (const e of entries) {
    const slug = slugifyServerName(e.id);
    if (!out.has(slug)) out.set(slug, e.ui ?? null);
  }
  return out;
}

/**
 * Each catalog entry's display name (its core `title ?? name`, projected as
 * `ConnectorCatalogEntry.name`) by the server name its install uses. First
 * entry per slug wins. A connector no entry names has no title here; callers
 * fall back to its server name.
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
 */
export function withCatalogUi<
  T extends { serverName: string; connector: ConnectorRef; meta?: LocalConnectorMeta | null },
>(entries: readonly T[], catalogUi: ReadonlyMap<string, ConnectorUiMeta | null>): T[] {
  return entries.map((entry) => {
    if (!catalogUi.has(entry.serverName)) return entry;
    const ui = catalogUi.get(entry.serverName) ?? null;
    return {
      ...entry,
      connector: { ...entry.connector, ui },
      ...(entry.meta ? { meta: { ...entry.meta, ui } } : {}),
    };
  });
}
