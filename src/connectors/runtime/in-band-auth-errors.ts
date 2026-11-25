/**
 * The transport options a connection takes from its catalog entry, resolved
 * when its `McpSource` is built: the in-band access-token rejection text the
 * entry declares (`NimbleBrainConnectorMeta.inBandAuthErrors`), and whether the
 * connection is OAuth-only and so never sends a request without a token.
 *
 * Derived from the catalog each time rather than copied onto the ConnectorRef at
 * install, so an entry that gains a field reaches connections installed before
 * it, and a catalog edit cannot leave the two disagreeing. Only a ref that IS the
 * entry's server (`bindCatalogEntry`: name and URL, or a broker's stamp) gets it;
 * another server under the same name gets nothing.
 *
 * The three places that build a remote `McpSource` (`startup.ts`, and the two
 * interactive flows in `lifecycle.ts`) hold no catalog, so the reader is set once
 * in `Runtime.start`, the same shape as the credential store and the instance
 * OAuth clients. Unset (a minimal or test runtime), no connection takes anything
 * from an entry; a ref that names its own OAuth client is still OAuth-only.
 */

import { log } from "../../observability/log.ts";
import { bindCatalogEntry, type CatalogBinding } from "../catalog/binding.ts";
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
  const binding = await bindingFor(ref);
  return binding?.kind === "bound" ? binding.entry.inBandAuthErrors : undefined;
}

/** The remote `McpSource` options a ref's connection takes from its catalog entry. */
export interface CatalogTransportOptions {
  inBandAuthErrors?: readonly string[];
  requireCredential?: boolean;
}

/**
 * The remote `McpSource` options for this ref's connection, each absent when it
 * does not apply.
 *
 * `requireCredential`: the connection signs in with OAuth and nothing else, so
 * it never sends a request without a token. That holds when the ref carries no
 * static auth or headers and either names its own OAuth client, or is the
 * server of a catalog entry that declares `auth` as `static` or `dcr` and binds
 * no secret headers. An entry that omits `auth` reads as `dcr` by default, which
 * says nothing about whether the server needs sign-in, so it does not count,
 * and neither does a connector added by URL alone: such a server may serve
 * every call without a token.
 */
export async function catalogTransportOptions(ref: ConnectorRef): Promise<CatalogTransportOptions> {
  const binding = await bindingFor(ref);
  const entry = binding?.kind === "bound" ? binding.entry : undefined;
  const inBandAuthErrors = entry?.inBandAuthErrors;
  const requireCredential = requiresCredential(ref, entry);
  return {
    ...(inBandAuthErrors ? { inBandAuthErrors } : {}),
    ...(requireCredential ? { requireCredential } : {}),
  };
}

function requiresCredential(ref: ConnectorRef, entry: ConnectorCatalogEntry | undefined): boolean {
  if (ref.transport?.headers || ref.transport?.auth) return false;
  if (ref.oauthClient) return true;
  return (
    entry !== undefined &&
    entry.authDeclared === true &&
    (entry.auth === "static" || entry.auth === "dcr") &&
    !entry.secretHeaders
  );
}

/** The ref's catalog binding, or undefined when no catalog is wired or it cannot be read. */
async function bindingFor(ref: ConnectorRef): Promise<CatalogBinding | undefined> {
  if (!readCatalogEntries) return undefined;
  let entries: readonly ConnectorCatalogEntry[];
  try {
    entries = await readCatalogEntries();
  } catch (err) {
    log.warn(
      `[connectors] could not read the catalog for a connection's transport options: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  return bindCatalogEntry(ref, entries);
}
