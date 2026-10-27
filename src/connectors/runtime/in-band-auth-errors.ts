/**
 * The in-band access-token rejection text a connection's catalog entry declares
 * (`NimbleBrainConnectorMeta.inBandAuthErrors`), resolved when its `McpSource`
 * is built.
 *
 * Derived from the catalog each time rather than copied onto the ConnectorRef at
 * install, so an entry that gains the field reaches connections installed before
 * it, and a catalog edit cannot leave the two disagreeing. Only a ref that IS the
 * entry's server (`bindCatalogEntry`: name and URL, or a broker's stamp) gets it;
 * another server under the same name gets nothing.
 *
 * The three places that build a remote `McpSource` (`startup.ts`, and the two
 * interactive flows in `lifecycle.ts`) hold no catalog, so the reader is set once
 * in `Runtime.start`, the same shape as the credential store and the instance
 * OAuth clients. Unset (a minimal or test runtime), no connection gets the field.
 */

import { log } from "../../observability/log.ts";
import { bindCatalogEntry } from "../catalog/binding.ts";
import type { ConnectorCatalogEntry } from "../catalog/types.ts";
import type { ConnectorRef } from "./types.ts";

let readCatalogEntries: (() => Promise<readonly ConnectorCatalogEntry[]>) | null = null;

/** Wire the catalog the resolver binds against. Called once from `Runtime.start`. */
export function setInBandAuthErrorsCatalog(
  read: (() => Promise<readonly ConnectorCatalogEntry[]>) | null,
): void {
  readCatalogEntries = read;
}

/**
 * The rejection text for this ref's connection, or undefined when its entry
 * declares none, the ref is not that entry's server, or the catalog cannot be
 * read. A read failure is logged and leaves the connection on the transport's
 * 401 handling alone; it never fails the start.
 */
export async function inBandAuthErrorsFor(ref: ConnectorRef): Promise<string[] | undefined> {
  if (!readCatalogEntries) return undefined;
  let entries: readonly ConnectorCatalogEntry[];
  try {
    entries = await readCatalogEntries();
  } catch (err) {
    log.warn(
      `[connectors] could not read the catalog for in-band auth errors: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  const binding = bindCatalogEntry(ref, entries);
  return binding.kind === "bound" ? binding.entry.inBandAuthErrors : undefined;
}

/** {@link inBandAuthErrorsFor} as the remote `McpSource` option it fills: absent when none apply. */
export async function inBandAuthErrorsOption(
  ref: ConnectorRef,
): Promise<{ inBandAuthErrors?: readonly string[] }> {
  const inBandAuthErrors = await inBandAuthErrorsFor(ref);
  return inBandAuthErrors ? { inBandAuthErrors } : {};
}
