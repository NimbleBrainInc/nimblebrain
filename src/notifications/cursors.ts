import { hasQueuedWorkspaceWrite } from "../workspace/serialize.ts";
import type { Workspace } from "../workspace/types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { readNotificationsConfig, updateNotificationsConfig } from "./config.ts";

/**
 * Where the poller has read up to, per `(workspace, connector)`.
 *
 * The value is the emitting server's own opaque cursor. Nothing here parses,
 * orders or synthesizes one: the outbox library encodes a snapshot horizon and
 * an epoch inside it, and a runtime that derived a cursor from an event's
 * position would step over exactly the uncommitted rows that encoding exists to
 * hold. So the contract on this module is narrow — carry a string back to the
 * server that issued it, and only after the events it covers are durable.
 *
 * It is stored in the same `notifications` block on the workspace record that
 * the source ceilings and routes live in, and reaches it through that block's
 * own reader and writer rather than a second pair. `WorkspaceStore.update`
 * replaces a patched field whole, so a cursor writer that re-derived only its
 * own half would persist an empty `routes` over an admin's — the failure that
 * makes one home for the block worth more than a tidy separation.
 *
 * There is no cursor cache. A cursor is read once per poll, at most a few times
 * a minute per workspace, against a record the runtime keeps on local disk —
 * and a cached one that disagreed with the record would replay or skip events
 * with nothing to say which copy was right.
 */

/** How many cursor writes had to wait on another writer of the same record. */
let contendedWrites = 0;
/** How many cursor writes have been attempted, contended or not. */
let attemptedWrites = 0;

/**
 * Cursor-write contention on the workspace record, since process start.
 *
 * `contended` counts writes that arrived while another write of the same record
 * was queued or running — hook reconciles and the settings surface being the
 * other writers, that is how the three are observed competing for the record
 * they share. Read by the poller's periodic summary line; nothing branches on
 * it.
 */
export function cursorWriteContention(): { attempted: number; contended: number } {
  return { attempted: attemptedWrites, contended: contendedWrites };
}

/** Reset the contention counters. Tests only. */
export function resetCursorWriteContention(): void {
  contendedWrites = 0;
  attemptedWrites = 0;
}

/** The stored cursor for one connector, or `undefined` when it has never been read. */
export function readCursor(
  ws: Pick<Workspace, "notifications">,
  connector: string,
): string | undefined {
  return readNotificationsConfig(ws).cursors?.[connector];
}

/**
 * Advance one connector's cursor.
 *
 * Called only after every envelope the poll returned reached the inbox: a
 * cursor written ahead of the write it describes is an event nobody will ever
 * read again, and the inbox is the guarantee.
 */
export async function writeCursor(
  store: WorkspaceStore,
  wsId: string,
  connector: string,
  cursor: string,
): Promise<void> {
  await mutateCursors(store, wsId, (cursors) => {
    if (cursors[connector] === cursor) return null;
    cursors[connector] = cursor;
    return cursors;
  });
}

/**
 * Drop one connector's cursor, so the next read of its outbox bootstraps.
 *
 * Called on uninstall. A stale cursor is not merely useless after a reinstall —
 * the server's own encoding carries an epoch, so a cursor from before a reset
 * describes a position its outbox may refuse or, worse, answer from. Bootstrap
 * is the safe restart, and it costs only the events emitted while the connector
 * was not installed, which nobody was going to receive anyway.
 */
export async function clearCursor(
  store: WorkspaceStore,
  wsId: string,
  connector: string,
): Promise<boolean> {
  let removed = false;
  await mutateCursors(store, wsId, (cursors) => {
    if (!(connector in cursors)) return null;
    delete cursors[connector];
    removed = true;
    return cursors;
  });
  return removed;
}

/**
 * Apply a mutation to one workspace's cursor map and persist it.
 *
 * `mutate` returns `null` to leave the record untouched, so a re-read that
 * lands on the same cursor — the ordinary empty poll — costs no write and no
 * `updatedAt` churn.
 */
async function mutateCursors(
  store: WorkspaceStore,
  wsId: string,
  mutate: (cursors: Record<string, string>) => Record<string, string> | null,
): Promise<void> {
  attemptedWrites++;
  if (hasQueuedWorkspaceWrite(wsId)) contendedWrites++;
  await updateNotificationsConfig(store, wsId, (current) => {
    const next = mutate({ ...(current.cursors ?? {}) });
    if (next === null) return null;
    // The whole block is returned, so the operator's half rides through this
    // write unchanged rather than being replaced by a partial one.
    return { ...current, cursors: next };
  });
}
