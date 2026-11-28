/**
 * Which listing entry names the server of a connection no plugin created, and
 * whether that entry's verified artifact serves it at the connection's
 * endpoint. Boot adoption (`src/tools/plugin-adopt.ts`) and the connector
 * list's read-only view of a plain connection (`plain-records.ts`) both ask
 * it, and must answer alike.
 */

import { brokeredRef } from "../connectors/runtime/brokered.ts";
import { slugifyServerName } from "../connectors/runtime/paths.ts";
import type { ConnectorRef } from "../connectors/runtime/types.ts";
import type { PluginServerRecord } from "../plugins/installed/artifact.ts";
import { SERVER_RECORD_TYPE } from "./listing.ts";
import type { CatalogSnapshot } from "./reader.ts";

export type ListedEntry = CatalogSnapshot["entries"][number];

/**
 * The registry name a catalog install recorded on `ref` (`com.notion/mcp`):
 * its `skillsLock`'s server, else the catalog id its broker stamped. Null when
 * it recorded neither.
 */
export function recordedRegistry(ref: ConnectorRef): string | null {
  const lock = ref.skillsLock?.find((e) => e.plugin && e.server);
  return lock?.server ?? brokeredRef(ref)?.connectorId ?? null;
}

/** The registry names `entry` lists: its extension's servers, or a bare connector's inline record. */
function namesListed(entry: ListedEntry): string[] {
  const names = Object.values(entry.servers).map((s) => s.name);
  const data = entry.data as { name?: unknown } | undefined;
  if (entry.type === SERVER_RECORD_TYPE && typeof data?.name === "string") names.push(data.name);
  return names;
}

/**
 * The registry name under which `entry` lists the server of connection
 * `serverName`, or null: `registry` when one was recorded, else a name that
 * slugifies to the connection.
 */
export function claimedName(
  entry: ListedEntry,
  serverName: string,
  registry: string | null,
): string | null {
  const names = namesListed(entry);
  if (registry) return names.includes(registry) ? registry : null;
  return names.find((n) => slugifyServerName(n) === serverName) ?? null;
}

/** Every entry that names `serverName`'s server, with the name it lists it under. */
export function claimsOf(
  entries: readonly ListedEntry[],
  serverName: string,
  registry: string | null,
): Array<{ entry: ListedEntry; name: string }> {
  return entries.flatMap((entry) => {
    const name = claimedName(entry, serverName, registry);
    return name ? [{ entry, name }] : [];
  });
}

/**
 * Whether `server`, from a verified artifact and listed under `name`, is the
 * one `ref` is connected to: its remote URL is the connection's, or, for a
 * brokered connection (whose URL is a per-install session), its broker stamped
 * that name. A same-name server at another endpoint is another server.
 */
export function servesAt(server: PluginServerRecord, name: string, ref: ConnectorRef): boolean {
  if (server.name !== name) return false;
  const brokered = brokeredRef(ref);
  if (brokered) return brokered.connectorId === server.name;
  return (server.detail.remotes ?? []).some((r) => r.url === ref.url);
}
