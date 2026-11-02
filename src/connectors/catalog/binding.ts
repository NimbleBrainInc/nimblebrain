/**
 * Which operator catalog entry an installed connector IS.
 *
 * A catalog entry is the trust root for what a connector may declare. Its grants
 * are its host UI, the `hooks` that give it a public delivery URL, the host's
 * calls to its `lifecycle` handlers, and the outbox the poller reads. Those
 * belong to the server the entry names, so
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
 * remote connector. The entry's restrictions (`admin_tools`, host-only
 * lifecycle handlers) still apply to it by name, because they narrow and open
 * nothing.
 *
 * The lookup by name assumes one entry per name, which the catalog read
 * guarantees by refusing every entry whose name collides (`read.ts`).
 */

import { isMintedFleetSource, MINTED_PROVIDER } from "../../oauth/minted-credential-provider.ts";
import { isBrokeredAuthKind } from "../auth-kind.ts";
import { brokeredRef } from "../runtime/brokered.ts";
import { serverNameFromRef, slugifyServerName } from "../runtime/paths.ts";
import type { ConnectorRef, RemoteTransportConfig } from "../runtime/types.ts";
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
    : !isBrokeredAuthKind(entry.auth) && sameRemoteUrl(ref.url, entry.url);
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

/** Reads the operator catalog's entries. Throws when the catalog cannot be read. */
export type CatalogEntriesReader = () => Promise<readonly ConnectorCatalogEntry[]>;

/** Why a minted fleet connector has no credential to start with. */
export const MINTED_UNAVAILABLE_REASON = "not offered in this deployment's connector catalog";

export type MintedTransportResolution =
  | { kind: "ok"; transport: RemoteTransportConfig | undefined }
  | { kind: "unavailable"; reason: string };

/**
 * The transport an installed connector runs with, when it is a minted fleet
 * connector: its stored transport with `auth` taken from the catalog entry it
 * binds to. Any other connector's transport is returned unchanged.
 *
 * A minted connector's credential settings (the `providerAuth` audience and
 * scope the runtime mints with) are a catalog grant like its host UI, so they
 * are derived at every start rather than read from the copy the install
 * stored: a catalog edit then reaches every existing install, and an install
 * whose entry the catalog no longer offers has nothing to mint with. It does
 * not start. That includes a catalog that could not be read (`entries` null):
 * the stored copy is never a fallback, because using it is how a removed entry
 * would keep working.
 *
 * Only the `auth` block is replaced. The stored transport's other fields stay:
 * the URL matched the entry to bind at all, and outgoing headers name the
 * workspace's own secrets, which the install chose.
 */
export function resolveMintedTransport(
  ref: ConnectorRef,
  entries: readonly ConnectorCatalogEntry[] | null,
): MintedTransportResolution {
  if (!isMintedFleetSource(ref.transport)) return { kind: "ok", transport: ref.transport };
  if (entries === null) return { kind: "unavailable", reason: MINTED_UNAVAILABLE_REASON };
  const binding = bindCatalogEntry(ref, entries);
  if (binding.kind !== "bound") return { kind: "unavailable", reason: MINTED_UNAVAILABLE_REASON };
  const granted = binding.entry.providerAuth;
  if (binding.entry.auth !== "provider" || granted?.provider !== MINTED_PROVIDER) {
    return { kind: "unavailable", reason: MINTED_UNAVAILABLE_REASON };
  }
  return {
    kind: "ok",
    transport: {
      ...ref.transport,
      auth: { type: "provider", provider: granted.provider, config: { ...granted.config } },
    },
  };
}
