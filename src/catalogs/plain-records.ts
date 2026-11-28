/**
 * The connector list's read-only view of a plain connection: one no plugin
 * created (no `installedBy`), whose server a plugin entry of the configured
 * listings names. Such a connection reads its server record (its display, its
 * OAuth client setup, its catalog declarations) from that entry's verified
 * artifact, as one listed by a bare connector reads the record inline
 * (`listed-records.ts`).
 *
 * A view only: it writes no record and no `installedBy`, takes no ownership,
 * and no uninstall ever removes the connection for it. The record is used only
 * when exactly one entry across the listings names the server, and that
 * entry's artifact serves it at the connection's own endpoint
 * (`claims.ts`, the same test adoption applies). An entry that is a bare
 * connector supplies its record inline already, so it is never fetched here.
 *
 * Lazy and bounded: an artifact is fetched only for an owner who has such a
 * connection, once per digest (the bytes cached on disk by digest, as install
 * caches them, and the contents memoized in process). A read that fails is
 * tried again after {@link RETRY_MS}. Never throws.
 */

import { join } from "node:path";
import type { ServerDetail } from "../connectors/catalog/server-detail.ts";
import { serverNameFromRef } from "../connectors/runtime/paths.ts";
import type { ConnectorRef } from "../connectors/runtime/types.ts";
import { log } from "../observability/log.ts";
import {
  ArtifactError,
  obtainArtifact,
  type PluginContents,
  readArtifact,
} from "../plugins/installed/artifact.ts";
import { claimsOf, type ListedEntry, recordedRegistry, servesAt } from "./claims.ts";
import { SERVER_RECORD_TYPE } from "./listing.ts";
import type { CatalogSnapshot } from "./reader.ts";

/** How long a failed artifact read is remembered before it is tried again. */
export const RETRY_MS = 60_000;

const reads = new Map<string, { at: number; read: Promise<PluginContents | null> }>();

export interface PlainRecordDeps {
  workDir: string;
  /** The owner's connections. */
  refs: () => Promise<ConnectorRef[]>;
  snapshots: () => Promise<CatalogSnapshot[]>;
  fetchImpl?: typeof fetch;
}

/** The server record each of the owner's plain connections reads, by the entry it came from. */
export async function plainConnectorRecords(
  deps: PlainRecordDeps,
): Promise<Array<{ address: string; detail: ServerDetail }>> {
  try {
    const plain = (await deps.refs()).filter((r) => !r.installedBy);
    if (plain.length === 0) return [];
    const entries = (await deps.snapshots()).flatMap((s) => s.entries);
    const out: Array<{ address: string; detail: ServerDetail }> = [];
    for (const ref of plain) {
      const serverName = serverNameFromRef(ref);
      if (!serverName) continue;
      const claims = claimsOf(entries, serverName, recordedRegistry(ref));
      const claim = claims[0];
      if (claims.length !== 1 || !claim || claim.entry.type === SERVER_RECORD_TYPE) continue;
      const contents = await contentsOf(claim.entry, deps);
      const server = contents?.servers.find((s) => servesAt(s, claim.name, ref));
      if (server) out.push({ address: claim.entry.address, detail: server.detail });
    }
    return out;
  } catch (err) {
    log.warn(`[catalogs] plain connections' records cannot be read: ${String(err)}`);
    return [];
  }
}

function contentsOf(entry: ListedEntry, deps: PlainRecordDeps): Promise<PluginContents | null> {
  const key = `${entry.address} ${entry.digest ?? ""}`;
  const known = reads.get(key);
  if (known) return known.read.then((c) => (c || Date.now() - known.at < RETRY_MS ? c : retry()));
  return retry();

  function retry(): Promise<PluginContents | null> {
    const read = obtainArtifact(entry, {
      cacheDir: join(deps.workDir, "cache", "plugins"),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    })
      .then(({ bytes }) => readArtifact(entry, bytes))
      .catch((err: unknown) => {
        const why = err instanceof ArtifactError ? err.message : String(err);
        log.warn(`[catalogs] ${entry.address}: its artifact cannot be read: ${why}`);
        return null;
      });
    reads.set(key, { at: Date.now(), read });
    return read;
  }
}
