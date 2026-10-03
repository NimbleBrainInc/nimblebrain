/**
 * Which operator catalog entry an installed connector IS.
 *
 * A catalog entry is the trust root for what a connector may declare: its host
 * UI, the `hooks` that give it a public delivery URL, the `lifecycle` handlers
 * only the host may call, the `admin_tools` that narrow who may call it, and the
 * outbox the poller reads. Those grants belong to the server the entry names, so
 * a ref receives them only when it is that server, not merely when it carries
 * that server's name:
 *
 *   - **Native refs** (`dcr`, `static`, `provider`): the server name the entry's
 *     id slugifies to, AND the entry's remote URL. A catalog install copies
 *     `remote.url` onto the ref, so every such install matches.
 *   - **Brokered refs**: the server name, AND the provider and catalog id the
 *     broker stamped on the ref at install. Their URL is a per-install session
 *     URL the broker issued, which no catalog entry can name, so the broker's
 *     stamp is the identity — the same one `catalogEntryForRef` resolves
 *     display metadata by.
 *
 * A ref that carries an entry's name and fails the second test is a different
 * server under that name. It gets none of the entry's grants and runs as a plain
 * remote connector.
 *
 * The lookup by name assumes one entry per name, which the catalog read
 * guarantees by refusing every entry whose name collides (`read.ts`).
 */

import { brokeredRef } from "../runtime/brokered.ts";
import { serverNameFromRef, slugifyServerName } from "../runtime/paths.ts";
import type { ConnectorRef } from "../runtime/types.ts";
import type { ConnectorCatalogEntry } from "./types.ts";

/**
 * - `bound`: the ref is the entry's server; the entry's grants apply.
 * - `mismatch`: the ref carries the entry's server name but is another server.
 * - `uncatalogued`: no entry carries the ref's server name.
 */
export type CatalogBinding =
  | { kind: "bound"; entry: ConnectorCatalogEntry }
  | { kind: "mismatch"; entry: ConnectorCatalogEntry }
  | { kind: "uncatalogued" };

/** Bind an installed ref to the catalog entry it is, if any. */
export function bindCatalogEntry(
  ref: ConnectorRef,
  entries: readonly ConnectorCatalogEntry[],
): CatalogBinding {
  const serverName = serverNameFromRef(ref);
  if (serverName === null) return { kind: "uncatalogued" };
  const entry = entries.find((e) => slugifyServerName(e.id) === serverName);
  if (!entry) return { kind: "uncatalogued" };
  const brokered = brokeredRef(ref);
  const same = brokered
    ? brokered.provider === entry.auth && brokered.connectorId === entry.id
    : sameRemoteUrl(ref.url, entry.url);
  return { kind: same ? "bound" : "mismatch", entry };
}

/**
 * Whether two remote MCP URLs name the same endpoint: equal after the WHATWG
 * parse (which lowercases scheme and host and drops a default port) and with one
 * trailing slash on the path ignored. Anything unparseable matches nothing.
 */
export function sameRemoteUrl(a: string | undefined, b: string | undefined): boolean {
  const na = normalizeRemoteUrl(a);
  return na !== null && na === normalizeRemoteUrl(b);
}

function normalizeRemoteUrl(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const path = u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;
  return `${u.protocol}//${u.username}:${u.password}@${u.host}${path}${u.search}`;
}
