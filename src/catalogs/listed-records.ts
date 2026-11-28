/**
 * The server records the configured listings carry inline: each bare
 * connector's `server.json` record (ADR-0077, "A bare connector"), verified
 * against its entry's digest and validated against the `ServerDetail` schema.
 *
 * These are the connector list's records for a connector no plugin record
 * supplies (`ConnectorCatalog`, source 2): a connector installed before records
 * existed, from a server a listing names on its own. An entry whose record
 * does not verify or is not a server record is left out and logged once. One
 * the safety scrub refuses (`validateServerDetailSafety`) is marked `refused`:
 * it reaches no listing or install, but its `adminTools` still restrict the
 * connector already installed from it, since a restriction only narrows.
 *
 * In configuration order, then listing order. Memoized per snapshot, since a
 * snapshot's entries never change.
 */

import { validateServerDetailSafety } from "../connectors/catalog/projection.ts";
import { type ServerDetail, validateServerDetail } from "../connectors/catalog/server-detail.ts";
import { log } from "../observability/log.ts";
import { ArtifactError, obtainArtifact } from "../plugins/installed/artifact.ts";
import { SERVER_RECORD_TYPE } from "./listing.ts";
import type { CatalogSnapshot } from "./reader.ts";

export interface ListedServerRecord {
  /** The entry's `name@catalog`. */
  address: string;
  detail: ServerDetail;
  /** The safety scrub refused it: kept only for the restriction its `adminTools` names. */
  refused?: true;
}

const memo = new WeakMap<CatalogSnapshot, Promise<ListedServerRecord[]>>();

/** Every bare connector's verified record across `snapshots`. Never throws. */
export async function listedServerRecords(
  snapshots: readonly CatalogSnapshot[],
): Promise<ListedServerRecord[]> {
  const per = await Promise.all(snapshots.map(recordsOf));
  return per.flat();
}

function recordsOf(snapshot: CatalogSnapshot): Promise<ListedServerRecord[]> {
  let pending = memo.get(snapshot);
  if (!pending) {
    pending = readRecords(snapshot);
    memo.set(snapshot, pending);
  }
  return pending;
}

async function readRecords(snapshot: CatalogSnapshot): Promise<ListedServerRecord[]> {
  const out: ListedServerRecord[] = [];
  for (const entry of snapshot.entries) {
    if (entry.type !== SERVER_RECORD_TYPE || entry.data === undefined) continue;
    const why = await unusable(entry);
    if (why) {
      log.warn(`[catalogs] ${entry.address}: its inline server record is not used: ${why}`);
      continue;
    }
    const detail = entry.data as ServerDetail;
    const unsafe = validateServerDetailSafety(detail);
    if (unsafe)
      log.warn(`[catalogs] ${entry.address}: its inline server record is refused: ${unsafe}`);
    out.push({ address: entry.address, detail, ...(unsafe ? { refused: true as const } : {}) });
  }
  return out;
}

/** Why an inline record cannot be used at all, or null: it must verify and be a server record. */
async function unusable(entry: CatalogSnapshot["entries"][number]): Promise<string | null> {
  try {
    // Inline data: verified over its canonical form, never fetched.
    await obtainArtifact(entry, { cacheDir: "" });
  } catch (err) {
    if (!(err instanceof ArtifactError)) throw err;
    return err.message;
  }
  const validation = validateServerDetail(entry.data);
  return validation.valid ? null : `not a server record: ${validation.errors.join("; ")}`;
}
